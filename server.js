import 'dotenv/config';
import express from 'express';
import PQueue from 'p-queue';
import { chromium } from 'playwright';
import crypto from 'crypto';

// ---------- Global crash guards + alert ----------
// Prevent unhandled errors from killing the entire Node.js process. The whole server
// stays alive; only the individual job fails. When the guard catches something, send
// an alert through the existing FOLLOWUP_LOG_WEBHOOK_URL with `event: 'crash'` so the
// n8n workflow there can route crashes to Discord/Slack/etc.
const SERVER_NAME = process.env.SERVER_NAME || 'manychat-clicker';
const CRASH_NOTIFICATION_RATE_LIMIT_MS = Number(process.env.CRASH_NOTIFICATION_RATE_LIMIT_MS ?? 60_000);
let lastCrashNotificationAt = 0;
let suppressedCrashCount = 0;

function sendCrashNotification(kind, err, opts = {}) {
  const now = Date.now();
  if (!opts.force && now - lastCrashNotificationAt < CRASH_NOTIFICATION_RATE_LIMIT_MS) {
    suppressedCrashCount++;
    return;
  }
  // Build a single human-readable string with everything the operator needs in Slack.
  const errMsg = err?.message ?? String(err);
  const stack = err?.stack ? String(err.stack).split('\n').slice(0, 20).join('\n') : '';
  const suppressNote = suppressedCrashCount > 0
    ? `\n(${suppressedCrashCount} additional crashes suppressed since last alert)`
    : '';
  const message = `[CRASH on ${SERVER_NAME}] ${kind}\n${errMsg}${stack ? `\n\nStack:\n${stack}` : ''}${suppressNote}`;

  const payload = {
    event: 'crash', // n8n filters on this to route alerts differently from follow-up logs
    server: SERVER_NAME,
    message
  };
  lastCrashNotificationAt = now;
  suppressedCrashCount = 0;
  // Reuse the existing follow-up log poster. Function declaration (hoisted), reads
  // FOLLOWUP_LOG_WEBHOOK_URL at call time, fire-and-forget.
  try {
    sendFollowupLog(payload);
  } catch (e) {
    console.error('[crash-notify] sendFollowupLog threw (ignored):', e.message);
  }
}

process.on('uncaughtException', (err) => {
  console.error('⚠️ UNCAUGHT EXCEPTION (process kept alive):', err.message);
  console.error(err.stack);
  try { sendCrashNotification('uncaughtException', err); } catch (_) { /* swallow */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ UNHANDLED REJECTION (process kept alive):', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
  try { sendCrashNotification('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))); } catch (_) { /* swallow */ }
});

// ---------- Dedup-blocked alert ----------
// Send a Slack-bound message every time the dedup layer blocks a duplicate retry,
// so the operator can monitor that the feature is working. Rate-limited to avoid
// spam during retry bursts; suppressed counts roll into the next alert.
const DEDUP_NOTIFICATION_RATE_LIMIT_MS = Number(process.env.DEDUP_NOTIFICATION_RATE_LIMIT_MS ?? 5 * 60 * 1000); // 5 min
let lastDedupNotificationAt = 0;
let suppressedDedupCount = 0;

function sendDedupNotification(params, opts = {}) {
  const { type, chatId, pageId, message, automation_name, dedupKind, ageMs } = params || {};
  const now = Date.now();
  if (!opts.force && now - lastDedupNotificationAt < DEDUP_NOTIFICATION_RATE_LIMIT_MS) {
    suppressedDedupCount++;
    return;
  }
  const lines = [`[DEDUP on ${SERVER_NAME}] Blocked duplicate send`];
  lines.push(`type: ${type ?? '?'} | chatId: ${chatId ?? '?'} | pageId: ${pageId ?? '?'}`);
  if (type === 'automation' && automation_name) {
    lines.push(`Automation: ${automation_name}`);
  } else if (type === 'text' && message) {
    const preview = message.length > 80 ? message.slice(0, 80) + '…' : message;
    lines.push(`Message: ${preview}`);
  }
  if (dedupKind === 'cached') {
    const ageStr = ageMs != null ? `${Math.round(ageMs / 1000)}s` : 'recently';
    lines.push(`Reason: cached (original sent ${ageStr} ago)`);
  } else if (dedupKind === 'in-flight') {
    lines.push(`Reason: in-flight (original is still running)`);
  }
  if (suppressedDedupCount > 0) {
    lines.push(`(${suppressedDedupCount} additional duplicates suppressed since last alert)`);
  }
  const finalMessage = lines.join('\n');
  lastDedupNotificationAt = now;
  suppressedDedupCount = 0;
  try {
    sendFollowupLog({
      event: 'dedup-blocked',
      server: SERVER_NAME,
      message: finalMessage
    });
  } catch (e) {
    console.error('[dedup-notify] sendFollowupLog threw (ignored):', e.message);
  }
}

const app = express();
app.use(express.json({ limit: '50mb' })); // Increased for user-data upload
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const {
  AUTH_TOKEN,
  PORT = process.env.PORT || 3000
} = process.env;
// HEADLESS is `let` because /switch-headless reassigns it at runtime.
let HEADLESS = process.env.HEADLESS ?? 'true';

// Fix: Respect USER_DATA_DIR from environment, don't override it
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data/user-data' : './data/user-data');

const BASE = 'https://app.manychat.com';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 420_000);
// Max time to spend finding composer or automation UI; after this we treat as success and exit (avoid 7min hang)
const COMPOSER_SEARCH_TIMEOUT_MS = Number(process.env.COMPOSER_SEARCH_TIMEOUT_MS ?? 35_000);
const COMPOSER_CANDIDATE_WAIT_MS = Number(process.env.COMPOSER_CANDIDATE_WAIT_MS ?? 6000);
const AUTOMATION_SEARCH_TIMEOUT_MS = Number(process.env.AUTOMATION_SEARCH_TIMEOUT_MS ?? 45_000);

const FOLLOWUP_LOG_WEBHOOK_URL = process.env.FOLLOWUP_LOG_WEBHOOK_URL !== undefined ? process.env.FOLLOWUP_LOG_WEBHOOK_URL : 'https://n8n.setty.ai/webhook/FUs-logs';

// Single-context mode: one browser window, multiple tabs (recommended to avoid "suspicious activity" flagging)
const USE_SINGLE_CONTEXT = process.env.USE_SINGLE_CONTEXT !== 'false';
const SINGLE_CONTEXT_MAX_TABS = Number(process.env.SINGLE_CONTEXT_MAX_TABS ?? 4);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? (USE_SINGLE_CONTEXT ? SINGLE_CONTEXT_MAX_TABS : 6));
const queue = new PQueue({ concurrency: CONCURRENCY, timeout: JOB_TIMEOUT_MS });
queue.on('error', (err) => {
  console.error('⚠️ PQueue job error (contained):', err.message);
});

// ---------- Deduplication (idempotency) ----------
// Blocks identical retries from sending duplicate messages while still allowing
// genuine recovery retries to run when the original attempt didn't actually send.
const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS ?? 10 * 60 * 1000); // 10 min default
// Map: dedupKey -> { promise, result?, completedAt? }
//   - in-flight: { promise }
//   - completed (and cached because actually sent): { promise, result, completedAt }
const dedupMap = new Map();

function buildDedupKey({ type, chatId, pageId, message, automation_name, idempotencyKey }) {
  if (idempotencyKey) return `explicit:${idempotencyKey}`;
  const payload = `${type}|${chatId}|${pageId}|${message ?? ''}|${automation_name ?? ''}`;
  return 'auto:' + crypto.createHash('sha1').update(payload).digest('hex');
}

function dedupGet(key) {
  const entry = dedupMap.get(key);
  if (!entry) return null;
  // Lazy TTL eviction for completed entries
  if (entry.completedAt && Date.now() - entry.completedAt > DEDUP_WINDOW_MS) {
    dedupMap.delete(key);
    return null;
  }
  return entry;
}

function dedupSetInFlight(key, promise) {
  dedupMap.set(key, { promise });
}

function dedupMarkSent(key, result) {
  const existing = dedupMap.get(key);
  const promise = existing?.promise ?? Promise.resolve(result);
  dedupMap.set(key, { promise, result, completedAt: Date.now() });
}

function dedupClear(key) {
  dedupMap.delete(key);
}

// ---------- Cookie sync (multi-VPS) ----------
// In a multi-server deployment behind the router, one VPS is the "session master"
// (the one where /init-login was run). Other VPSs periodically pull fresh cookies
// from the master so they can serve any pageId without their own login flow.
//
// Set COOKIE_SYNC_MASTER_URL on workers (e.g. "http://session-master.internal:3000").
// Leave it empty on the master itself, or on a single-VPS deployment.
const COOKIE_SYNC_MASTER_URL = process.env.COOKIE_SYNC_MASTER_URL || '';
const COOKIE_SYNC_INTERVAL_MS = Number(process.env.COOKIE_SYNC_INTERVAL_MS ?? 30 * 60 * 1000); // 30 min
const COOKIE_SYNC_AUTH_TOKEN = process.env.COOKIE_SYNC_AUTH_TOKEN || process.env.AUTH_TOKEN || '';

// Human-like timing to reduce automation detection (softer defaults than before)
const DEFAULT_TYPING_BASE = Number(process.env.TYPING_BASE_MS ?? 100);
const DEFAULT_TYPING_VARIANCE = Number(process.env.TYPING_VARIANCE_MS ?? 60);
const STAGGER_DELAY_MS = Number(process.env.STAGGER_DELAY_MS ?? 2500);

// Login cache to avoid checking every request
let lastLoginCheck = 0;
const LOGIN_CACHE_TTL = 5 * 60 * 1000; // Cache login status for 5 minutes
let cachedLoginStatus = false;

// Browser pool configuration (used only when USE_SINGLE_CONTEXT=false)
const BROWSER_POOL_SIZE = Number(process.env.BROWSER_POOL_SIZE ?? 2);
const MAX_PAGES_PER_BROWSER = Number(process.env.MAX_PAGES_PER_BROWSER ?? 3);

// Master context for login/session persistence
let masterContext;

// Browser pool for handling requests
const browserPool = [];
let poolInitialized = false;
let currentBrowserIndex = 0; // For round-robin assignment

// ---------- Safe page load helper ----------
async function safeWaitForLoad(page, timeout = 10000) {
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch (e) {
    // networkidle timeout is OK - ManyChat has constant background requests
    console.log('Network idle timeout (expected for ManyChat) - continuing...');
  }
}

// ---------- Shared helpers ----------

// Get browser launch args
function getBrowserArgs() {
  const isCloudEnvironment = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER;
  const browserArgs = [
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor'
  ];
  
  if (isCloudEnvironment && HEADLESS === 'false') {
    browserArgs.push('--virtual-time-budget=5000');
    console.log('Cloud environment detected - using virtual display mode');
  }
  
  return browserArgs;
}

// Ensure master context exists (for login/session persistence)
async function ensureMasterContext() {
  if (!masterContext) {
    console.log('Creating master browser context...');
    masterContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS === 'true',
      viewport: { width: 1440, height: 900 },
      args: getBrowserArgs()
    });
    console.log('Master browser context created successfully');
  } else {
    // Check if context is still valid
    try {
      const pages = masterContext.pages();
      console.log('Reusing existing master browser context');
    } catch (error) {
      console.log('Master context is invalid, creating new one...');
      masterContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: HEADLESS === 'true',
        viewport: { width: 1440, height: 900 },
        args: getBrowserArgs()
      });
      console.log('New master browser context created successfully');
    }
  }
  return masterContext;
}

// Get cookies from master context. No need to open a page — context already holds the cookies.
async function getMasterCookies() {
  const ctx = await ensureMasterContext();
  return ctx.cookies();
}

// Create a new pool browser with cookies from master
async function createPoolBrowser(index) {
  console.log(`Creating pool browser ${index + 1}...`);
  
  const browser = await chromium.launch({
    headless: HEADLESS === 'true',
    args: getBrowserArgs()
  });
  
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  
  // Get cookies from master and add to this context
  try {
    const cookies = await getMasterCookies();
    if (cookies && cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`Pool browser ${index + 1}: Added ${cookies.length} cookies from master`);
    }
  } catch (e) {
    console.log(`Pool browser ${index + 1}: Could not copy cookies (master may not be logged in)`);
  }
  
  return {
    browser,
    context,
    index,
    activePages: 0,
    healthy: true
  };
}

// Initialize the browser pool
async function initBrowserPool() {
  if (poolInitialized) {
    console.log('Browser pool already initialized');
    return;
  }
  
  console.log(`Initializing browser pool with ${BROWSER_POOL_SIZE} browsers...`);
  
  for (let i = 0; i < BROWSER_POOL_SIZE; i++) {
    try {
      const poolBrowser = await createPoolBrowser(i);
      browserPool.push(poolBrowser);
      console.log(`Pool browser ${i + 1}/${BROWSER_POOL_SIZE} created`);
    } catch (e) {
      console.error(`Failed to create pool browser ${i + 1}:`, e.message);
    }
  }
  
  poolInitialized = true;
  console.log(`Browser pool initialized with ${browserPool.length} browsers`);
}

// Sync cookies from master to all pool browsers
async function syncCookiesToPool() {
  console.log('Syncing cookies from master to browser pool...');
  
  try {
    const cookies = await getMasterCookies();
    if (!cookies || cookies.length === 0) {
      console.log('No cookies to sync from master');
      return false;
    }
    
    for (const poolBrowser of browserPool) {
      try {
        await poolBrowser.context.addCookies(cookies);
        console.log(`Synced ${cookies.length} cookies to pool browser ${poolBrowser.index + 1}`);
      } catch (e) {
        console.log(`Failed to sync cookies to pool browser ${poolBrowser.index + 1}:`, e.message);
      }
    }
    
    console.log('Cookie sync complete');
    return true;
  } catch (e) {
    console.error('Error syncing cookies:', e.message);
    return false;
  }
}

// Pull cookies from the configured session master and apply them locally.
// Used in multi-VPS deployments so worker VPSs stay logged in without running their own OAuth flow.
async function syncCookiesFromMaster() {
  if (!COOKIE_SYNC_MASTER_URL) return false;
  try {
    const url = `${COOKIE_SYNC_MASTER_URL.replace(/\/$/, '')}/get-session`;
    console.log(`[cookie-sync] Fetching session from master: ${url}`);
    const res = await fetch(url, {
      headers: COOKIE_SYNC_AUTH_TOKEN ? { Authorization: `Bearer ${COOKIE_SYNC_AUTH_TOKEN}` } : {}
    });
    if (!res.ok) {
      console.error(`[cookie-sync] Master returned ${res.status} ${res.statusText}`);
      return false;
    }
    const data = await res.json();
    const cookies = data?.sessionData?.cookies;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      console.log('[cookie-sync] No cookies received from master');
      return false;
    }
    const ctx = await ensureMasterContext();
    await ctx.addCookies(cookies);
    console.log(`[cookie-sync] Applied ${cookies.length} cookies from master`);
    // Pool browsers (if any) get re-synced too
    if (!USE_SINGLE_CONTEXT && poolInitialized) {
      await syncCookiesToPool();
    }
    // Refresh login cache so the next /press doesn't immediately re-check
    updateLoginCache(true);
    return true;
  } catch (e) {
    console.error('[cookie-sync] Sync failed:', e.message);
    return false;
  }
}

// Get a browser from the pool (round-robin with load balancing)
async function getPoolBrowser() {
  // Initialize pool if not done yet
  if (!poolInitialized || browserPool.length === 0) {
    await initBrowserPool();
  }
  
  if (browserPool.length === 0) {
    throw new Error('No browsers available in pool');
  }
  
  // Find browser with least active pages (load balancing)
  let bestBrowser = null;
  let minPages = Infinity;
  
  for (const poolBrowser of browserPool) {
    if (poolBrowser.healthy && poolBrowser.activePages < MAX_PAGES_PER_BROWSER) {
      if (poolBrowser.activePages < minPages) {
        minPages = poolBrowser.activePages;
        bestBrowser = poolBrowser;
      }
    }
  }
  
  // If all browsers are at capacity, use round-robin
  if (!bestBrowser) {
    currentBrowserIndex = (currentBrowserIndex + 1) % browserPool.length;
    bestBrowser = browserPool[currentBrowserIndex];
    console.log(`All browsers at capacity, using round-robin: browser ${bestBrowser.index + 1}`);
  } else {
    console.log(`Selected pool browser ${bestBrowser.index + 1} (${bestBrowser.activePages} active pages)`);
  }
  
  return bestBrowser;
}

// Recover a crashed pool browser
async function recoverPoolBrowser(poolBrowser) {
  console.log(`Recovering pool browser ${poolBrowser.index + 1}...`);
  
  try {
    // Close old browser if possible
    try {
      await poolBrowser.browser.close();
    } catch (e) {
      // Ignore close errors
    }
    
    // Create new browser
    const newPoolBrowser = await createPoolBrowser(poolBrowser.index);
    
    // Replace in pool
    const idx = browserPool.findIndex(b => b.index === poolBrowser.index);
    if (idx !== -1) {
      browserPool[idx] = newPoolBrowser;
    }
    
    console.log(`Pool browser ${poolBrowser.index + 1} recovered successfully`);
    return newPoolBrowser;
  } catch (e) {
    console.error(`Failed to recover pool browser ${poolBrowser.index + 1}:`, e.message);
    poolBrowser.healthy = false;
    return null;
  }
}

// Legacy function for backwards compatibility
async function ensureContext() {
  return ensureMasterContext();
}

// Check if login is cached and still valid
function isLoginCached() {
  if (!cachedLoginStatus) return false;
  if (Date.now() - lastLoginCheck > LOGIN_CACHE_TTL) {
    console.log('Login cache expired');
    cachedLoginStatus = false;
    return false;
  }
  return true;
}

// Update login cache
function updateLoginCache(status) {
  cachedLoginStatus = status;
  lastLoginCheck = Date.now();
  console.log(`Login cache updated: ${status ? 'logged in' : 'not logged in'}`);
}

async function isLoggedIn(page) {
  try {
    console.log('Checking login status...');
    
    // First check: URL must be on ManyChat dashboard
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);
    
    if (!currentUrl.includes('app.manychat.com')) {
      console.log('Not on ManyChat domain');
      return false;
    }
    
    if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
      console.log('Still on login/auth/signin page');
      return false;
    }
    
    // Second check: Look for specific dashboard elements from the screenshot
    const dashboardIndicators = [
      // The personalized greeting "Hello, [Username]!" - most reliable indicator
      'h1:has-text("Hello,")',
      'h2:has-text("Hello,")',
      'div:has-text("Hello,")',
      
      // User-specific data that only appears when logged in
      'text="connected channel"',
      'text="contacts"',
      'text="See Insights"',
      
      // Dashboard-specific sections
      'text="Start Here"',
      'text="Hit Your Growth Goals"',
      'text="Automated Activity"',
      
      // Navigation elements specific to logged-in state
      'text="Home"',
      'text="Auto-DM links from comments"',
      'text="Generate leads with stories"',
      'text="Respond to all your DMs"'
    ];
    
    console.log('Checking for dashboard-specific elements...');
    for (const selector of dashboardIndicators) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible().catch(() => false)) {
          console.log(`Found dashboard indicator: ${selector}`);
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    // Third check: Look for the left navigation sidebar with specific elements
    const sidebarIndicators = [
      // ManyChat logo
      'text="M"',
      // PRO badge
      'text="PRO"',
      // Navigation icons (person, message, lightning, gear)
      '[class*="person"]',
      '[class*="message"]',
      '[class*="lightning"]',
      '[class*="gear"]',
      // Home section
      'text="Home"'
    ];
    
    console.log('Checking for sidebar elements...');
    for (const selector of sidebarIndicators) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible().catch(() => false)) {
          console.log(`Found sidebar indicator: ${selector}`);
          return true;
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    // Save a screenshot for debugging
    try {
      await page.screenshot({ path: './data/last-error.png', fullPage: true });
      console.log('Screenshot saved to ./data/last-error.png');
    } catch (e) {
      console.log('Could not save screenshot:', e.message);
    }
    
    console.log('No specific dashboard indicators found - not logged in');
    return false;
  } catch (error) {
    console.error('Login check error:', error);
    return false;
  }
}

async function manualLoginFlow(page) {
  console.log('Starting manual login flow...');
  
  try {
    // Navigate to ManyChat login page
    await page.goto('https://manychat.com/login', { waitUntil: 'domcontentloaded' });
    console.log('Navigated to login page');
    
    // Wait for page to fully load
    await safeWaitForLoad(page);
    
    console.log('==========================================');
    console.log('MANUAL LOGIN INSTRUCTIONS:');
    console.log('1. Complete the ManyChat login in the browser window');
    console.log('2. Wait until you see the dashboard with "Hello, [YourName]!"');
    console.log('3. Press ENTER in this terminal when you are fully logged in');
    console.log('==========================================');
    
    // Wait for user to complete login, poll for dashboard indicators
    console.log('Waiting for user to complete login...');
    for (let i = 0; i < 120; i++) { // Increased timeout to 4 minutes
      console.log(`Login check attempt ${i + 1}/120 (Press ENTER when logged in)`);
      
      if (await isLoggedIn(page)) {
        console.log('Login detected automatically!');
        return true;
      }
      
      // Check if we're still on login page
      const currentUrl = page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/auth') || currentUrl.includes('/signin')) {
        console.log('Still on login page, waiting...');
      } else {
        console.log('Moved away from login page, checking if logged in...');
      }
      
      await page.waitForTimeout(2000);
    }
    
    console.log('Login timeout - user did not complete login in time');
    return false;
  } catch (error) {
    console.error('Error during manual login flow:', error);
    return false;
  }
}

// Dismiss any pop-ups/modals (upgrade prompts, permission warnings, etc.)
// Tries clicking X/close buttons first, falls back to Escape key.
// Loops up to maxAttempts times to handle stacked modals.
async function dismissPopups(page, maxAttempts = 3) {
  console.log('Checking for pop-ups to dismiss...');
  let totalDismissed = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let dismissed = false;

    // Strategy 1: Click known close-button patterns from ManyChat's UI
    const closeButtonSelectors = [
      'button[class*="_closeWithoutHeaderButtons"]',
      'button[class*="_onlyIcon"][class*="_ghostLight"]',
      'button[aria-label="Close"]',
      'button[aria-label="close"]',
      '[role="dialog"] button[class*="_onlyIcon"]',
      '[class*="modal"] button[class*="_onlyIcon"]',
    ];

    for (const selector of closeButtonSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          console.log(`Found pop-up close button: ${selector}`);
          // Click may trigger a navigation (e.g. ManyChat redirect). Race the click
          // against a possible navigation so Playwright doesn't throw an unhandled timeout.
          await Promise.all([
            btn.click({ delay: 30, timeout: 2000 }).catch(() => {}),
            page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
          ]);
          await page.waitForTimeout(600);
          dismissed = true;
          totalDismissed++;
          console.log(`✅ Dismissed pop-up via close button (${selector})`);
          break;
        }
      } catch (_) {
        continue;
      }
    }

    // Strategy 2: If no close button found, check for modal content and press Escape
    if (!dismissed) {
      const modalIndicators = [
        '[role="dialog"]',
        'text="Get Advanced"',
        'text="Get Business"',
        'text="outgrown Pro"',
        'text="outgrown"',
        'text="campaigns are everywhere"',
        'text="Your team is maxed"',
        'text="Channel permissions lost"',
        'text="Instagram channel lost connection"',
        'text="Connection lost"',
        'text="grant channel permissions"',
        'text="Refresh Permissions"',
        'text="Everything just hit pause"',
      ];

      let hasModal = false;
      for (const indicator of modalIndicators) {
        try {
          if (await page.locator(indicator).first().isVisible({ timeout: 300 }).catch(() => false)) {
            hasModal = true;
            console.log(`Pop-up detected via indicator: ${indicator}`);
            break;
          }
        } catch (_) {
          continue;
        }
      }

      if (hasModal) {
        console.log('Pressing Escape to dismiss pop-up...');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
        totalDismissed++;
        dismissed = true;
        console.log('✅ Dismissed pop-up via Escape key');
      }
    }

    if (!dismissed) break;
  }

  if (totalDismissed > 0) {
    console.log(`Dismissed ${totalDismissed} pop-up(s) total`);
    await page.waitForTimeout(500);
  } else {
    console.log('No pop-ups detected');
  }

  return totalDismissed;
}

// Legacy aliases (kept for any external references)
async function detectBlockingModal(page) {
  return (await dismissPopups(page, 1)) > 0;
}
async function detectPermissionPopup(page) {
  return detectBlockingModal(page);
}

async function openChat(page, chatId, pageId) {
  console.log(`Opening chat: ${chatId} on page: ${pageId}`);
  const url = `${BASE}/${pageId}/chat/${chatId}`;
  console.log(`Navigating to: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await safeWaitForLoad(page);
    console.log('Page loaded successfully');

    await page.waitForTimeout(1500);

    // Dismiss any pop-ups (upgrade prompts, permission warnings, etc.) then continue
    await dismissPopups(page);

    // Try common composer targets with a time budget so we don't hang for 7 minutes
    const composerSearchStart = Date.now();
    const candidates = [
      // Most specific selectors first - avoid disabled buttons
      page.locator('[data-testid*="composer"]:not([disabled])'),
      page.locator('[data-testid*="message"]:not([disabled])'),
      page.locator('[data-testid*="input"]:not([disabled])'),
      page.locator('[placeholder*="message"]:not([disabled])'),
      page.locator('[placeholder*="type"]:not([disabled])'),
      page.locator('[placeholder*="Write"]:not([disabled])'),
      page.locator('[placeholder*="Send"]:not([disabled])'),
      // Generic selectors - text inputs only
      page.getByRole('textbox').first(),
      page.locator('input[type="text"]:not([disabled])'),
      page.locator('textarea:not([disabled])'),
      page.locator('[contenteditable="true"]:not([disabled])'),
      // ManyChat specific selectors
      page.locator('div[class*="composer"] input:not([disabled])'),
      page.locator('div[class*="composer"] textarea:not([disabled])'),
      page.locator('div[class*="message-input"] input:not([disabled])'),
      page.locator('div[class*="message-input"] textarea:not([disabled])'),
      page.locator('div[class*="chat-input"] input:not([disabled])'),
      page.locator('div[class*="chat-input"] textarea:not([disabled])'),
      page.locator('div[class*="input"] input:not([disabled])'),
      page.locator('div[class*="input"] textarea:not([disabled])')
    ];

    console.log(`Looking for message composer (max ${COMPOSER_SEARCH_TIMEOUT_MS / 1000}s total, ${COMPOSER_CANDIDATE_WAIT_MS}ms per candidate)...`);
    for (let i = 0; i < candidates.length; i++) {
      if (Date.now() - composerSearchStart > COMPOSER_SEARCH_TIMEOUT_MS) {
        console.log(`⏱️ Composer search time budget (${COMPOSER_SEARCH_TIMEOUT_MS}ms) exceeded — returning null to treat as success`);
        return null;
      }
      const candidate = candidates[i];
      try {
        const count = await candidate.count();
        console.log(`Trying selector ${i + 1}/${candidates.length}, found ${count} elements`);
        
        if (count > 0) {
          await candidate.waitFor({ timeout: COMPOSER_CANDIDATE_WAIT_MS });
          console.log(`Found message composer with selector ${i + 1}`);
          return candidate;
        }
      } catch (e) {
        console.log(`Selector ${i + 1} failed:`, e.message);
        continue;
      }
    }
    
    // Composer not found within budget — return null so handlePress returns success (no 7min hang)
    await page.screenshot({ path: './data/chat-page-error.png', fullPage: true }).catch(() => {});
    console.log('Screenshot saved to ./data/chat-page-error.png');
    console.log('⚠️ Message composer not found — returning null to treat as success and close job');
    return null;
  } catch (error) {
    console.error('Error opening chat:', error);
    throw error;
  }
}

async function slowType(locator, text, state = {}, baseDelay = DEFAULT_TYPING_BASE, variance = DEFAULT_TYPING_VARIANCE) {
  // `state` is a shared object the caller can inspect even if this function throws.
  // After a `\n` is typed (= Enter pressed = ManyChat sends the message), state.enterPressed = true.
  state.enterPressed = state.enterPressed ?? false;
  await locator.click({ delay: 20 }); // Aggressive: faster click
  for (const char of text) {
    const jitter = (Math.random() - 0.5) * 2 * variance;
    const delay = Math.max(10, Math.round(baseDelay + jitter)); // Aggressive: min 10ms instead of 15ms
    await locator.type(char, { delay });
    if (char === '\n') state.enterPressed = true;
  }
}

async function clickSendToInstagram(page) {
  console.log('Looking for "Send to Instagram" button...');
  
  // Try multiple selectors for the send button
  const buttonSelectors = [
    // Role-based selectors
    page.getByRole('button', { name: /send to instagram/i }),
    page.getByRole('button', { name: /send/i }),
    page.getByRole('button', { name: /instagram/i }),
    
    // Text-based selectors
    page.locator('button:has-text("Send to Instagram")'),
    page.locator('button:has-text("Send")'),
    page.locator('button:has-text("Instagram")'),
    
    // Button with span containing text
    page.locator('button:has(span:text("Send to Instagram"))'),
    page.locator('button:has(span:text("Send"))'),
    page.locator('button:has(span:text("Instagram"))'),
    
    // Data attribute selectors
    page.locator('[data-testid*="send"]'),
    page.locator('[data-testid*="instagram"]'),
    page.locator('[aria-label*="send"]'),
    page.locator('[aria-label*="instagram"]'),
    
    // Class-based selectors
    page.locator('button[class*="send"]'),
    page.locator('button[class*="instagram"]'),
    page.locator('button[class*="primary"]'),
    page.locator('button[class*="_primary_"]'),
    
    // Generic button selectors
    page.locator('button').filter({ hasText: /send/i }),
    page.locator('button').filter({ hasText: /instagram/i }),
    
    // ManyChat specific selectors
    page.locator('div[class*="send-button"]'),
    page.locator('div[class*="action-button"]'),
    page.locator('div[class*="submit"]')
  ];

  for (let i = 0; i < buttonSelectors.length; i++) {
    const selector = buttonSelectors[i];
    try {
      const count = await selector.count();
      console.log(`Trying send button selector ${i + 1}/${buttonSelectors.length}, found ${count} elements`);
      
      if (count > 0) {
        // Check if button is visible and enabled
        const button = selector.first();
        const isVisible = await button.isVisible().catch(() => false);
        const isEnabled = await button.isEnabled().catch(() => false);
        
        if (isVisible && isEnabled) {
          console.log(`Found and clicking send button with selector ${i + 1}`);
          await button.click({ delay: 50 });
          return true;
        } else {
          console.log(`Button found but not visible/enabled: visible=${isVisible}, enabled=${isEnabled}`);
        }
      }
    } catch (e) {
      console.log(`Send button selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  
  // Take a screenshot for debugging
  await page.screenshot({ path: './data/send-button-error.png', fullPage: true });
  console.log('Screenshot saved to ./data/send-button-error.png');
  // Don't throw - treat as success so caller won't retry and send duplicate message. UI may have changed.
  console.log('⚠️  "Send to Instagram" button not found - UI may have changed. Treating as success to avoid duplicate sends.');
  return false;
}

// Click "Show contact" icon to expand Contact UI (required before automation timer/resume in new ManyChat UI)
async function clickShowContactButton(page) {
  console.log('Looking for "Show contact" icon (chat-toggle-user-bar-btn)...');
  const selectors = [
    page.locator('[data-test-id="chat-toggle-user-bar-btn"]'),
    page.locator('[data-title="Show contact"]'),
    page.locator('div[data-test-id="chat-toggle-user-bar-btn"]'),
    page.locator('div[data-title="Show contact"]')
  ];
  for (let i = 0; i < selectors.length; i++) {
    try {
      const el = selectors[i].first();
      if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`Found "Show contact" icon with selector ${i + 1}, clicking...`);
        await el.click({ delay: 50 });
        await page.waitForTimeout(1000);
        console.log('✅ "Show contact" icon clicked, Contact UI expanded');
        return true;
      }
    } catch (e) {
      console.log(`Show contact selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  console.log('⚠️  "Show contact" icon not found (Contact UI may already be expanded)');
  return false;
}

async function clickAutomationButton(page) {
  console.log('Looking for "Automation" button...');
  
  // Try multiple selectors for the Automation button
  const buttonSelectors = [
    // Button with data-title="Automation" attribute
    page.locator('button[data-title="Automation"]'),
    page.locator('button:has(svg[data-title="Automation"])'),
    
    // Button containing SVG with data-title="Automation"
    page.locator('button:has(svg[data-title="Automation"])'),
    
    // Class-based selectors
    page.locator('button[class*="automation"]'),
    page.locator('button[class*="flowPicker"]'),
    page.locator('button[class*="wrapperFlowPicker"]'),
    
    // Button near "Reply" tab in message composer
    page.locator('button').filter({ hasText: /automation/i }),
    
    // Data attribute selectors
    page.locator('[data-test-id*="automation"]'),
    page.locator('[data-test-id*="flow"]'),
    page.locator('[aria-label*="automation"]'),
    page.locator('[aria-label*="flow"]'),
    
    // Generic button selectors
    page.locator('button').filter({ hasText: /automation/i }),
    
    // ManyChat specific selectors
    page.locator('div[class*="automation-button"]'),
    page.locator('div[class*="flow-picker"]')
  ];

  for (let i = 0; i < buttonSelectors.length; i++) {
    const selector = buttonSelectors[i];
    try {
      const count = await selector.count();
      console.log(`Trying automation button selector ${i + 1}/${buttonSelectors.length}, found ${count} elements`);
      
      if (count > 0) {
        // Check if button is visible and enabled
        const button = selector.first();
        const isVisible = await button.isVisible().catch(() => false);
        const isEnabled = await button.isEnabled().catch(() => false);
        
        if (isVisible && isEnabled) {
          console.log(`Found and clicking automation button with selector ${i + 1}`);
          await button.click({ delay: 30 }); // Aggressive: faster click
          
          // Wait for modal/dialog to appear
          await page.waitForTimeout(1500);
          
          // Check if modal appeared by looking for search input
          const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
          const modalVisible = await searchInput.isVisible({ timeout: 4000 }).catch(() => false);
          
          if (modalVisible) {
            console.log('Automation picker modal appeared');
            return true;
          } else {
            console.log('Modal may not have appeared, continuing anyway...');
            return true;
          }
        } else {
          console.log(`Button found but not visible/enabled: visible=${isVisible}, enabled=${isEnabled}`);
        }
      }
    } catch (e) {
      console.log(`Automation button selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  
  // Take a screenshot for debugging
  await page.screenshot({ path: './data/automation-button-error.png', fullPage: true });
  console.log('Screenshot saved to ./data/automation-button-error.png');
  console.log('⚠️  "Automation" button not found - UI may have changed. Treating as success to avoid duplicate sends.');
  return false;
}

async function searchAndSelectAutomation(page, automationName, options = {}) {
  const startTime = options.startTime ?? Date.now();
  console.log(`Searching for automation: "${automationName}"...`);
  
  const MAX_RETRIES = 3;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (Date.now() - startTime > AUTOMATION_SEARCH_TIMEOUT_MS) {
      console.log(`⏱️ Automation search time budget (${AUTOMATION_SEARCH_TIMEOUT_MS}ms) exceeded — treating as success`);
      return false;
    }
    console.log(`Attempt ${attempt}/${MAX_RETRIES} to find automation "${automationName}"...`);
    
    // Wait for search input field in the automation picker modal
    const searchInputSelectors = [
      page.locator('input[placeholder*="Search"]'),
      page.locator('input[placeholder*="search"]'),
      page.locator('input[placeholder*="Search all"]'),
      page.locator('input[type="text"]').filter({ has: page.locator('..') }),
      page.locator('input[class*="search"]'),
      page.locator('input').filter({ hasText: /search/i })
    ];
    
    let searchInput = null;
    for (let i = 0; i < searchInputSelectors.length; i++) {
      if (Date.now() - startTime > AUTOMATION_SEARCH_TIMEOUT_MS) {
        console.log(`⏱️ Automation search budget exceeded inside searchInput scan — bailing.`);
        return false;
      }
      const selector = searchInputSelectors[i];
      try {
        const count = await selector.count();
        if (count > 0) {
          const input = selector.first();
          const isVisible = await input.isVisible({ timeout: 1500 }).catch(() => false);
          if (isVisible) {
            searchInput = input;
            console.log(`Found search input with selector ${i + 1}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!searchInput) {
      if (attempt < MAX_RETRIES) {
        console.log('Could not find search input, retrying...');
        await page.waitForTimeout(800 * attempt);
        continue;
      }
      console.log('⚠️  Search input not found - UI may have changed. Treating as success to avoid duplicate sends.');
      return false;
    }
    
    // Click on search input to ensure focus (short timeout - if it fails, continue anyway)
    try {
      console.log('Clicking on search input to ensure focus...');
      await searchInput.click({ timeout: 2000 });
      await page.waitForTimeout(200);
    } catch (e) {
      console.log('Click on search input timed out, continuing anyway...');
    }
    
    // Clear any existing text
    try {
      console.log('Clearing search field...');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(300);
    } catch (e) {
      console.log('Could not clear search input:', e.message);
    }
    
    // Type automation name
    console.log(`Typing automation name: "${automationName}"...`);
    
    for (const char of automationName) {
      const jitter = (Math.random() - 0.5) * 2 * 20;
      const delay = Math.max(10, Math.round(40 + jitter));
      await page.keyboard.type(char, { delay });
    }
    
    console.log('Automation name typed');
    
    console.log('Waiting for search results to load...');
    await page.waitForTimeout(2000);
    
    // Find and click the automation card/row matching the exact name
    console.log('Looking for automation in search results...');
    
    // IMPROVED: Target clickable elements (buttons) first, then fall back to text elements
    const automationSelectors = [
      // Priority 1: Click the card's main action button that contains the automation name
      page.locator('[class*="card"]').filter({ hasText: automationName }).locator('button').first(),
      page.locator('[class*="card"]').filter({ hasText: automationName }).first(),
      
      // Priority 2: Article-based cards
      page.locator('article').filter({ hasText: automationName }).locator('button').first(),
      page.locator('article').filter({ hasText: automationName }).first(),
      
      // Priority 3: Direct text match (will use force:true if needed)
      page.locator(`text="${automationName}"`).first(),
      page.locator(`div:has-text("${automationName}")`).filter({ hasText: automationName }),
      
      // Priority 4: Table row with matching name
      page.locator('tr').filter({ hasText: automationName }),
      page.locator('div[class*="listView"]').locator(`text="${automationName}"`).first()
    ];
    
    let automationFound = false;
    for (let i = 0; i < automationSelectors.length; i++) {
      if (Date.now() - startTime > AUTOMATION_SEARCH_TIMEOUT_MS) {
        console.log(`⏱️ Automation search budget exceeded inside automation scan — bailing.`);
        return false;
      }
      const selector = automationSelectors[i];
      try {
        const count = await selector.count();
        console.log(`Trying automation selector ${i + 1}/${automationSelectors.length}, found ${count} elements`);

        if (count > 0) {
          const element = selector.first();
          const isVisible = await element.isVisible({ timeout: 1500 }).catch(() => false);
          
          if (isVisible) {
            // Verify the card/container contains the automation name
            const text = await element.textContent().catch(() => '');
            // For buttons inside cards, also check parent text
            const parentText = await element.locator('..').textContent().catch(() => text);
            
            if (text.includes(automationName) || parentText.includes(automationName)) {
              console.log(`Found automation "${automationName}" with selector ${i + 1}`);
              
              // Try normal click first, fall back to force:true if intercepted
              try {
                await element.click({ delay: 50, timeout: 5000 });
              } catch (clickError) {
                if (clickError.message && clickError.message.includes('intercepts pointer events')) {
                  console.log('Click intercepted, using force:true...');
                  await element.click({ delay: 50, force: true });
                } else {
                  throw clickError;
                }
              }
              
              automationFound = true;
              break;
            }
          }
        }
      } catch (e) {
        console.log(`Automation selector ${i + 1} failed:`, e.message);
        continue;
      }
    }
    
    if (automationFound) {
      console.log(`Automation "${automationName}" selected successfully on attempt ${attempt}`);
      await page.waitForTimeout(800);
      return true;
    }
    
    if (attempt < MAX_RETRIES) {
      const waitTime = 800 * attempt;
      console.log(`Automation not found on attempt ${attempt}, waiting ${waitTime}ms before retry...`);
      await page.screenshot({ path: `./data/automation-not-found-attempt-${attempt}.png`, fullPage: true });
      console.log(`Screenshot saved to ./data/automation-not-found-attempt-${attempt}.png`);
      await page.waitForTimeout(waitTime);
    }
  }
  
  // All retries exhausted
  await page.screenshot({ path: './data/automation-not-found-error.png', fullPage: true });
  console.log('Screenshot saved to ./data/automation-not-found-error.png');
  console.log(`⚠️  Automation "${automationName}" not found - UI may have changed. Treating as success to avoid duplicate sends.`);
  return false;
}

async function clickPickThisAutomationButton(page) {
  console.log('Looking for "Pick This Automation" button...');
  
  // Try multiple selectors for the "Pick This Automation" button
  const buttonSelectors = [
    // Exact text match
    page.getByRole('button', { name: /pick this automation/i }),
    page.locator('button:has-text("Pick This Automation")'),
    page.locator('button:has-text("Pick This")'),
    
    // Button with span containing text
    page.locator('button:has(span:text("Pick This Automation"))'),
    page.locator('button:has(span:text("Pick This"))'),
    
    // Class-based selectors
    page.locator('button[class*="pick"]'),
    page.locator('button[class*="select"]'),
    page.locator('button[class*="primary"]').filter({ hasText: /pick|select/i }),
    
    // Data attribute selectors
    page.locator('[data-test-id*="pick"]'),
    page.locator('[data-test-id*="select"]'),
    page.locator('[data-test-id="flow-picker-select-flow-button"]'),
    page.locator('[aria-label*="pick"]'),
    page.locator('[aria-label*="select"]'),
    
    // Button in preview section (right side of modal)
    page.locator('div[class*="preview"]').locator('button').filter({ hasText: /pick|select/i }),
    page.locator('div[class*="phoneContainer"]').locator('button').filter({ hasText: /pick|select/i })
  ];

  for (let i = 0; i < buttonSelectors.length; i++) {
    const selector = buttonSelectors[i];
    try {
      const count = await selector.count();
      console.log(`Trying "Pick This Automation" button selector ${i + 1}/${buttonSelectors.length}, found ${count} elements`);
      
      if (count > 0) {
        // Check if button is visible and enabled
        const button = selector.first();
        const isVisible = await button.isVisible().catch(() => false);
        const isEnabled = await button.isEnabled().catch(() => false);
        
        if (isVisible && isEnabled) {
          console.log(`Found and clicking "Pick This Automation" button with selector ${i + 1}`);
          await button.click({ delay: 30 });
          
          // Wait for modal to close/disappear
          await page.waitForTimeout(1200);
          
          // Check if modal closed by verifying search input is no longer visible
          const searchInput = page.locator('input[placeholder*="Search"]').first();
          const modalClosed = await searchInput.isVisible({ timeout: 1500 }).catch(() => false);
          
          if (!modalClosed) {
            console.log('Modal closed');
          } else {
            console.log('Modal may still be open, continuing anyway...');
          }
          
          return true;
        } else {
          console.log(`Button found but not visible/enabled: visible=${isVisible}, enabled=${isEnabled}`);
        }
      }
    } catch (e) {
      console.log(`"Pick This Automation" button selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  
  // Take a screenshot for debugging
  await page.screenshot({ path: './data/pick-automation-button-error.png', fullPage: true });
  console.log('Screenshot saved to ./data/pick-automation-button-error.png');
  console.log('⚠️  "Pick This Automation" button not found - UI may have changed. Treating as success to avoid duplicate sends.');
  return false;
}

async function clickAutomationTimerButton(page) {
  console.log('Looking for automation timer button (with orange pause icon)...');
  
  // Multiple selectors for the countdown timer button at the top
  const buttonSelectors = [
    // Data attribute selector from the code you provided
    page.locator('button[data-onboarding-id="pause-automation-section"]'),
    
    // Button containing time format (00:16:10, etc.)
    page.locator('button:has-text("00:")'),
    page.locator('button').filter({ hasText: /\d{2}:\d{2}:\d{2}/ }),
    
    // Button with Automations header nearby
    page.locator('button').filter({ hasText: /^\d{2}:\d{2}/ }),
    
    // Class-based selectors for the timer button
    page.locator('button[class*="btnV2"]').filter({ hasText: /\d{2}:/ }),
    
    // Generic button near "Automations" text
    page.locator('text=Automations').locator('..').locator('button').first()
  ];

  for (let i = 0; i < buttonSelectors.length; i++) {
    const selector = buttonSelectors[i];
    try {
      const count = await selector.count();
      console.log(`Trying automation timer button selector ${i + 1}/${buttonSelectors.length}, found ${count} elements`);
      
      if (count > 0) {
        const button = selector.first();
        const isVisible = await button.isVisible().catch(() => false);
        const isEnabled = await button.isEnabled().catch(() => false);
        
        if (isVisible && isEnabled) {
          const buttonText = await button.textContent().catch(() => 'unknown');
          console.log(`✅ Found automation timer button: "${buttonText}" with selector ${i + 1}`);
          try {
            await button.click({ delay: 50, timeout: 3000 });
          } catch (clickErr) {
            if (clickErr.message && clickErr.message.includes('intercepts pointer events')) {
              console.log('Click intercepted by overlay — using force click...');
              await button.click({ delay: 50, force: true });
            } else {
              throw clickErr;
            }
          }
          console.log('✅ Automation timer button clicked successfully');
          return true;
        }
      }
    } catch (e) {
      console.log(`Automation timer button selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  
  console.log('⚠️  Automation timer button not found (this may be normal if not visible)');
  return false;
}

async function clickResumeAutomationsButton(page) {
  console.log('Looking for "Resume automations" button in dropdown...');
  
  // Wait for dropdown to render
  await page.waitForTimeout(500);
  
  // Multiple strategies to find "Resume automations" in the dropdown
  // Based on HTML: <ul class="menu m-0"><li class="flex"><span class="d-flex"><svg...>Resume automations</span></li></ul>
  const buttonSelectors = [
    // Most specific: First li in ul.menu that contains "Resume automations" text
    page.locator('ul.menu li:first-child:has-text("Resume automations")'),
    page.locator('ul.menu li.flex:first-child:has-text("Resume automations")'),
    page.locator('ul[class*="menu"] li:first-child:has-text("Resume automations")'),
    
    // Click the span inside the first li
    page.locator('ul.menu li:first-child span:has-text("Resume automations")'),
    page.locator('ul.menu li.flex:first-child span.d-flex:has-text("Resume automations")'),
    
    // Generic first item in menu with Resume text
    page.locator('ul.menu li:first-child').filter({ hasText: /Resume automations/i }),
    page.locator('ul[class*="menu"] li:first-child').filter({ hasText: /Resume automations/i }),
    
    // Exact match for "Resume automations" text in menu
    page.getByRole('button', { name: 'Resume automations' }),
    page.getByRole('button', { name: /resume automations/i }),
    
    // Text-based selectors
    page.locator('li:has-text("Resume automations")').first(),
    page.locator('span:has-text("Resume automations")').first(),
    
    // Menu item selectors
    page.locator('[role="menu"] li:first-child:has-text("Resume")'),
    page.locator('[role="menuitem"]:has-text("Resume automations")').first()
  ];

  for (let i = 0; i < buttonSelectors.length; i++) {
    const selector = buttonSelectors[i];
    try {
      const count = await selector.count();
      console.log(`Trying "Resume automations" dropdown button selector ${i + 1}/${buttonSelectors.length}, found ${count} elements`);
      
      if (count > 0) {
        const button = selector.first();
        const isVisible = await button.isVisible().catch(() => false);
        const isEnabled = await button.isEnabled().catch(() => false);
        
        if (isVisible && isEnabled) {
          const buttonText = await button.textContent().catch(() => 'unknown');
          console.log(`✅ Found "Resume automations" button in dropdown: "${buttonText}" with selector ${i + 1}`);
          await button.click({ delay: 50 });
          console.log('✅ "Resume automations" button clicked successfully');
          return true;
        }
      }
    } catch (e) {
      console.log(`"Resume automations" button selector ${i + 1} failed:`, e.message);
      continue;
    }
  }
  
  console.log('⚠️  "Resume automations" button not found in dropdown (this may be normal if dropdown did not appear)');
  return false;
}

// Fire-and-forget: send follow-up outcome to log webhook (never blocks or throws)
function sendFollowupLog(payload) {
  if (!FOLLOWUP_LOG_WEBHOOK_URL) return;
  const body = {
    ...payload,
    timestamp: new Date().toISOString()
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  fetch(FOLLOWUP_LOG_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  }).then(() => clearTimeout(timeoutId)).catch((e) => {
    clearTimeout(timeoutId);
    console.log('Followup log webhook failed (non-fatal):', e.message);
  });
}

async function handlePress({ type, chatId, message, automation_name, pageId }) {
  console.log(`Starting handlePress for type: ${type}, chatId: ${chatId}, pageId: ${pageId}`);
  
  // Stagger requests with random delay to avoid overwhelming ManyChat
  if (STAGGER_DELAY_MS > 0) {
    const staggerDelay = Math.floor(Math.random() * STAGGER_DELAY_MS);
    console.log(`Staggering request by ${staggerDelay}ms...`);
    await new Promise(resolve => setTimeout(resolve, staggerDelay));
  }
  
  // Validate type-specific fields
  if (type === 'text') {
    if (!chatId || !message || !pageId) {
      throw new Error('For type "text", all fields required: "chatId", "message", and "pageId".');
    }
  } else if (type === 'automation') {
    if (!chatId || !automation_name || !pageId) {
      throw new Error('For type "automation", all fields required: "chatId", "automation_name", and "pageId".');
    }
    if (!automation_name.trim()) {
      throw new Error('automation_name cannot be empty');
    }
  } else {
    throw new Error(`Invalid type: "${type}". Must be either "text" or "automation".`);
  }

  // Get a page: single-context = one window with tabs (master only); else use browser pool
  let poolBrowser = null;
  let page;
  if (USE_SINGLE_CONTEXT) {
    const ctx = await ensureMasterContext();
    page = await ctx.newPage();
    const tabCount = ctx.pages().length;
    console.log(`Using master context (tab ${tabCount} of up to ${SINGLE_CONTEXT_MAX_TABS} concurrent)`);
  } else {
    poolBrowser = await getPoolBrowser();
    try {
      poolBrowser.activePages++;
      console.log(`Using pool browser ${poolBrowser.index + 1} (now ${poolBrowser.activePages} active pages)`);
      page = await poolBrowser.context.newPage();
    } catch (e) {
      console.log(`Pool browser ${poolBrowser.index + 1} failed, attempting recovery...`);
      poolBrowser.activePages--;
      poolBrowser = await recoverPoolBrowser(poolBrowser);
      if (!poolBrowser) {
        throw new Error('All browsers in pool are unavailable');
      }
      poolBrowser.activePages++;
      page = await poolBrowser.context.newPage();
    }
  }

  try {
    // Use cached login status to skip full check (aggressive optimization)
    if (isLoginCached()) {
      console.log('Using cached login status (skipping full check)');
    } else {
      console.log('Checking login status...');
      
      // Navigate to ManyChat to check login status
      await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
      await safeWaitForLoad(page);
      await page.waitForTimeout(1500);
      
      if (!(await isLoggedIn(page))) {
        if (HEADLESS === 'false') {
          console.log('⏳ Not logged in - waiting for manual login in browser...');
          console.log('👉 Please complete the ManyChat login in the browser window');
          console.log('⏱️  Waiting up to 5 minutes for you to login...');
          
          const loginSuccess = await manualLoginFlow(page);
          if (!loginSuccess) {
            throw new Error('Login timeout - please complete login and try again');
          }
          console.log('✅ Login completed!');
          updateLoginCache(true);
        } else {
          throw new Error('Not logged in. Run /init-login with HEADLESS=false first.');
        }
      } else {
        updateLoginCache(true);
      }
      console.log('Login check passed');
    }

    console.log('Opening chat...');
    const composer = await openChat(page, chatId, pageId);

    if (composer === null) {
      console.log('⚠️ Composer not found after dismissing pop-ups — returning early (not sent, retries allowed)');
      const result = { ok: true, sent: false, chatId, partialSuccess: true, message: 'Message composer not found (pop-ups were dismissed). Check ManyChat UI.' };
      sendFollowupLog({ type, chatId, pageId, automation_name: type === 'automation' ? automation_name : undefined, ...result });
      return result;
    }

    console.log('Chat opened successfully');

    // Branch based on type
    if (type === 'text') {
      // TEXT FOLLOWUP FLOW (existing behavior)
      console.log('=== Starting text followup flow ===');
      
      // Optional: clear any prefilled text
      try { 
        console.log('Clearing any existing text...');
        await composer.press('ControlOrMeta+a'); 
        await composer.press('Backspace'); 
        console.log('Text cleared');
      } catch (e) {
        console.log('No text to clear or clear failed:', e.message);
      }

      console.log('Typing message...');
      // typingState is shared with slowType so we can see if Enter was pressed (via \n) even if slowType throws
      const typingState = { enterPressed: false };
      try {
        await slowType(composer, message, typingState);
        console.log('Message typed successfully');
      } catch (typingError) {
        if (typingState.enterPressed) {
          // Enter was pressed via \n before the throw — message was sent (at least the part before \n)
          console.log(`⚠️  Typing failed mid-way but Enter was already pressed via \\n — treating as sent: ${typingError.message}`);
          const result = { ok: true, sent: true, chatId, partialSuccess: true, message: `Typing failed mid-way but message was sent via Enter (\\n): ${typingError.message}` };
          sendFollowupLog({ type, chatId, pageId, automation_name: undefined, ...result });
          return result;
        }
        // No Enter pressed — message wasn't sent, propagate as a real error
        throw typingError;
      }

      console.log('Clicking send button...');
      const sendClicked = await clickSendToInstagram(page);
      if (!sendClicked) {
        if (typingState.enterPressed) {
          // Send button not found, but Enter was already pressed during typing — message was sent
          console.log('⚠️  Send button not found but Enter (\\n) already sent the message — treating as sent.');
          const result = { ok: true, sent: true, chatId, partialSuccess: true, message: 'Message sent via Enter (\\n in message); send button click was not needed.' };
          sendFollowupLog({ type, chatId, pageId, automation_name: undefined, ...result });
          return result;
        }
        console.log('⚠️  Send button not found and no Enter pressed - not sent, retries allowed.');
        const result = { ok: true, sent: false, chatId, partialSuccess: true, message: 'Send button not found - UI may have changed. No duplicate send.' };
        sendFollowupLog({ type, chatId, pageId, automation_name: undefined, ...result });
        return result;
      }
      console.log('Send button clicked successfully');

      await page.waitForTimeout(1200);
      console.log('Message sent successfully');
      
      // Post-send steps (Timer, Resume) - check if contact panel is expanded, expand if needed
      try {
        console.log('\n=== Starting automation button sequence ===');
        await page.waitForTimeout(1000);
        
        // Check panel state: if "Show contact" button is visible, the panel is COLLAPSED
        const showContactBtn = page.locator('[data-test-id="chat-toggle-user-bar-btn"][data-title="Show contact"]');
        const panelCollapsed = await showContactBtn.isVisible({ timeout: 500 }).catch(() => false);
        
        if (panelCollapsed) {
          console.log('Contact panel is collapsed — expanding...');
          await clickShowContactButton(page);
          await page.waitForTimeout(1000);
        } else {
          console.log('Contact panel already expanded — proceeding directly');
        }
        
        const timerButtonClicked = await clickAutomationTimerButton(page);
        
        if (timerButtonClicked) {
          console.log('✅ Step 1 complete: Timer button clicked');
          await page.waitForTimeout(1500);
          
          console.log('Step 2: Looking for "Resume automations" in dropdown...');
          const resumeButtonClicked = await clickResumeAutomationsButton(page);
          if (resumeButtonClicked) {
            console.log('✅ Step 2 complete: "Resume automations" clicked');
            await page.waitForTimeout(800);
            console.log('=== Automation button sequence complete ===\n');
          } else {
            console.log('⚠️  Step 2: "Resume automations" button not found - UI may have changed');
          }
        } else {
          console.log('⚠️  Timer button not found even after expanding contact panel');
        }
      } catch (postSendError) {
        console.error('Error in post-send steps (treating as success to avoid duplicate sends):', postSendError.message);
      }
      
      const result = { ok: true, sent: true, chatId, message: 'Message sent and automation sequence completed' };
      sendFollowupLog({ type, chatId, pageId, automation_name: undefined, ...result });
      return result;

    } else if (type === 'automation') {
      // AUTOMATION FOLLOWUP FLOW (new behavior)
      console.log('=== Starting automation followup flow ===');
      const automationStartTime = Date.now();
      try {
        const step1 = await clickAutomationButton(page);
        if (!step1) {
          console.log('⚠️  Automation button not found - not triggered, retries allowed.');
          const result = { ok: true, sent: false, chatId, partialSuccess: true, message: 'Automation button not found - UI may have changed' };
          sendFollowupLog({ type, chatId, pageId, automation_name, ...result });
          return result;
        }
        console.log('✅ Step 1 complete: Automation button clicked');

        const step2 = await searchAndSelectAutomation(page, automation_name, { startTime: automationStartTime });
        if (!step2) {
          console.log('⚠️  Could not find/select automation - not triggered, retries allowed.');
          const result = { ok: true, sent: false, chatId, partialSuccess: true, message: `Automation "${automation_name}" not found - UI may have changed` };
          sendFollowupLog({ type, chatId, pageId, automation_name, ...result });
          return result;
        }
        console.log('✅ Step 2 complete: Automation selected');

        const step3 = await clickPickThisAutomationButton(page);
        if (!step3) {
          console.log('⚠️  Pick This Automation button not found - not triggered, retries allowed.');
          const result = { ok: true, sent: false, chatId, partialSuccess: true, message: 'Pick This Automation button not found - UI may have changed' };
          sendFollowupLog({ type, chatId, pageId, automation_name, ...result });
          return result;
        }
        console.log('✅ Step 3 complete: Automation picked successfully');

        console.log('=== Automation followup flow complete ===');
        const result = { ok: true, sent: true, chatId, message: `Automation '${automation_name}' selected and triggered successfully` };
        sendFollowupLog({ type, chatId, pageId, automation_name, ...result });
        return result;
      } catch (error) {
        console.error('Unexpected error in automation flow:', error.message);
        try {
          await page.screenshot({ path: './data/automation-flow-error.png', fullPage: true });
          console.log('Error screenshot saved to ./data/automation-flow-error.png');
        } catch (e) {
          // ignore
        }
        // We can't be sure whether "Pick This Automation" was clicked before the throw.
        // Conservative choice: mark as not-sent so retries are allowed. If the click did go through,
        // n8n's retry will hit the same selectors but the automation has already been triggered;
        // duplicate triggering is the cost of being correct in the more common case (failure before pick).
        const result = { ok: true, sent: false, chatId, partialSuccess: true, message: `Unexpected error in automation flow: ${error.message}` };
        sendFollowupLog({ type, chatId, pageId, automation_name, ...result });
        return result;
      }
    }
    
  } catch (error) {
    console.error('Error in handlePress:', error);
    
    sendFollowupLog({ type, chatId, pageId, automation_name: type === 'automation' ? automation_name : undefined, ok: false, error: error.message });
    
    // Take a screenshot for debugging
    try {
      await page.screenshot({ path: './data/handle-press-error.png', fullPage: true });
      console.log('Error screenshot saved to ./data/handle-press-error.png');
    } catch (e) {
      console.log('Could not save error screenshot:', e.message);
    }
    
    throw error;
  } finally {
    try {
      await page.close();
    } catch (e) {
      // Ignore close errors
    }
    if (!USE_SINGLE_CONTEXT && poolBrowser) {
      poolBrowser.activePages--;
      console.log(`Page closed. Pool browser ${poolBrowser.index + 1} now has ${poolBrowser.activePages} active pages`);
    } else if (USE_SINGLE_CONTEXT) {
      console.log('Tab closed (single-context mode)');
    }
  }
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.json({ 
  service: 'ManyChat Clicker', 
  status: 'running',
  version: '2.0.0',
  config: {
    singleContext: USE_SINGLE_CONTEXT,
    singleContextMaxTabs: USE_SINGLE_CONTEXT ? SINGLE_CONTEXT_MAX_TABS : undefined,
    browserPoolSize: USE_SINGLE_CONTEXT ? undefined : BROWSER_POOL_SIZE,
    maxPagesPerBrowser: USE_SINGLE_CONTEXT ? undefined : MAX_PAGES_PER_BROWSER,
    concurrency: CONCURRENCY,
    dedupWindowMs: DEDUP_WINDOW_MS
  },
  endpoints: {
    health: '/healthz',
    login: '/init-login',
    confirm: '/confirm-login',
    send: '/press',
    syncPool: '/sync-pool',
    reinitPool: '/reinit-pool',
    dedupStatus: '/dedup-status'
  }
}));

// Inspect current dedup state (for debugging)
app.get('/dedup-status', (_req, res) => {
  const now = Date.now();
  const entries = [];
  for (const [key, entry] of dedupMap.entries()) {
    entries.push({
      key,
      state: entry.completedAt ? 'cached' : 'in-flight',
      ageMs: entry.completedAt ? now - entry.completedAt : undefined,
      sent: entry.result?.sent ?? undefined
    });
  }
  res.json({ ok: true, windowMs: DEDUP_WINDOW_MS, count: entries.length, entries });
});

// Manually trigger a crash-notification webhook for testing (bypasses rate limit).
// Sends to the same FOLLOWUP_LOG_WEBHOOK_URL with event:'crash' so you can verify your
// n8n alerting wiring without waiting for a real crash.
app.post('/test-crash-notification', (req, res) => {
  if (!AUTH_TOKEN || req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!FOLLOWUP_LOG_WEBHOOK_URL) {
    return res.status(400).json({ ok: false, error: 'FOLLOWUP_LOG_WEBHOOK_URL not configured (set it to receive crash notifications)' });
  }
  sendCrashNotification('test', new Error('Manual test of crash-notification webhook'), { force: true });
  res.json({ ok: true, message: 'Test crash notification fired to FOLLOWUP_LOG_WEBHOOK_URL with event:"crash". Check your n8n workflow.' });
});

// Manually trigger a dedup-blocked notification for testing (bypasses rate limit).
app.post('/test-dedup-notification', (req, res) => {
  if (!AUTH_TOKEN || req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!FOLLOWUP_LOG_WEBHOOK_URL) {
    return res.status(400).json({ ok: false, error: 'FOLLOWUP_LOG_WEBHOOK_URL not configured' });
  }
  sendDedupNotification({
    type: 'text',
    chatId: 'TEST_CHAT_ID',
    pageId: 'TEST_PAGE_ID',
    message: 'Test dedup notification (manual trigger) — this is what a blocked duplicate looks like.',
    dedupKind: 'cached',
    ageMs: 30_000
  }, { force: true });
  res.json({ ok: true, message: 'Test dedup notification fired with event:"dedup-blocked". Check your n8n workflow.' });
});

app.get('/healthz', (_req, res) => {
  const poolStatus = browserPool.map(b => ({
    browser: b.index + 1,
    activePages: b.activePages,
    healthy: b.healthy
  }));
  
  res.json({ 
    ok: true,
    browserPool: {
      initialized: poolInitialized,
      size: browserPool.length,
      browsers: poolStatus
    }
  });
});

// Switch to headless mode endpoint
app.get('/switch-headless', (_req, res) => {
  if (HEADLESS === 'true') {
    return res.json({ ok: false, message: 'Already in headless mode' });
  }
  
  // Update the HEADLESS variable
  process.env.HEADLESS = 'true';
  HEADLESS = 'true';
  
  res.json({ ok: true, message: 'Switched to headless mode. Restart server to apply changes.' });
});

// Session transfer endpoint (for cloud deployment)
app.post('/transfer-session', async (req, res) => {
  console.log('Session transfer requested');
  
  try {
    const { cookies, localStorage, sessionStorage } = req.body;
    
    if (!cookies || !localStorage) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required session data (cookies, localStorage)' 
      });
    }
    
    const ctx = await ensureContext();
    const page = await ctx.newPage();
    
    // Navigate to ManyChat
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    
    // Set cookies
    if (cookies && Array.isArray(cookies)) {
      await page.context().addCookies(cookies);
    }
    
    // Set localStorage
    if (localStorage && typeof localStorage === 'object') {
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          localStorage.setItem(key, value);
        }
      }, localStorage);
    }
    
    // Set sessionStorage
    if (sessionStorage && typeof sessionStorage === 'object') {
      await page.evaluate((data) => {
        for (const [key, value] of Object.entries(data)) {
          sessionStorage.setItem(key, value);
        }
      }, sessionStorage);
    }
    
    // Refresh page to apply session data
    await page.reload({ waitUntil: 'domcontentloaded' });
    await safeWaitForLoad(page);
    await page.waitForTimeout(2000);
    
    // Check if login worked
    if (await isLoggedIn(page)) {
      await page.close();
      console.log('Session transfer successful!');
      
      // Sync to browser pool (only when not using single-context)
      if (!USE_SINGLE_CONTEXT) {
        if (!poolInitialized || browserPool.length === 0) {
          await initBrowserPool();
        }
        await syncCookiesToPool();
      }
      return res.json({ ok: true, message: USE_SINGLE_CONTEXT ? 'Session transferred successfully!' : 'Session transferred successfully! Browser pool synced.' });
    } else {
      await page.close();
      return res.status(400).json({ 
        ok: false, 
        error: 'Session transfer failed - login not detected' 
      });
    }
  } catch (e) {
    console.error('Error in session transfer:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Debug endpoint: Verify login detection with detailed results
app.post('/debug-verify-login', async (req, res) => {
  try {
    console.log('Debug verify login requested');
    
    const ctx = await ensureContext();
    const page = await ctx.newPage();

    const debugResult = {
      timestamp: new Date().toISOString(),
      userDataDir: USER_DATA_DIR,
      url: null,
      checks: {},
      isLoggedIn: false,
      screenshot: null
    };
    
    try {
      // Navigate to ManyChat
      console.log('Navigating to ManyChat...');
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000); // Wait for redirects
      
      debugResult.url = page.url();
      console.log(`Current URL: ${debugResult.url}`);
      
      // Run detailed checks
      debugResult.checks.onManyChatDomain = debugResult.url.includes('app.manychat.com');
      debugResult.checks.notOnLoginPage = !debugResult.url.includes('/login') && !debugResult.url.includes('/auth') && !debugResult.url.includes('/signin');
      
      // Check for dashboard elements
      const selectorChecks = {
        'h1:has-text("Hello,")': false,
        'text="connected channel"': false,
        'text="Home"': false,
        'div[class*="sidebar"]': false,
        'a[href*="/dashboard"]': false,
        '[data-testid*="dashboard"]': false
      };
      
      for (const selector of Object.keys(selectorChecks)) {
        try {
          const element = await page.locator(selector).first();
          const count = await element.count();
          selectorChecks[selector] = count > 0;
          if (count > 0) {
            console.log(`✓ Found: ${selector}`);
          }
        } catch (e) {
          // Selector not found
        }
      }
      
      debugResult.checks.selectors = selectorChecks;
      debugResult.checks.anyDashboardElement = Object.values(selectorChecks).some(v => v);
      
      // Overall login status
      debugResult.isLoggedIn = 
        debugResult.checks.onManyChatDomain && 
        debugResult.checks.notOnLoginPage && 
        debugResult.checks.anyDashboardElement;
      
      // Take screenshot
      const screenshotBuffer = await page.screenshot({ fullPage: false });
      debugResult.screenshot = screenshotBuffer.toString('base64');
      
      console.log(`Login check result: ${debugResult.isLoggedIn ? 'LOGGED IN' : 'NOT LOGGED IN'}`);
      
    } finally {
      await page.close();
    }
    
    res.json(debugResult);
  } catch (e) {
    console.error('Error in debug verify login:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Debug endpoint: Check session data on filesystem
app.get('/debug-session', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    
    const debugInfo = {
      userDataDir: USER_DATA_DIR,
      exists: fs.existsSync(USER_DATA_DIR),
      files: [],
      defaultFolder: {
        exists: false,
        path: path.join(USER_DATA_DIR, 'Default')
      },
      criticalFiles: {},
      browserContext: {
        initialized: !!masterContext,
        status: masterContext ? 'active' : 'not created'
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT,
        HEADLESS: HEADLESS
      }
    };
    
    if (debugInfo.exists) {
      try {
        const items = fs.readdirSync(USER_DATA_DIR);
        debugInfo.files = items.slice(0, 20); // First 20 items
        debugInfo.totalItems = items.length;
        
        // Check Default folder
        const defaultPath = path.join(USER_DATA_DIR, 'Default');
        debugInfo.defaultFolder.exists = fs.existsSync(defaultPath);
        
        if (debugInfo.defaultFolder.exists) {
          // Check critical session files
          const criticalFiles = {
            'Cookies': path.join(defaultPath, 'Network', 'Cookies'),
            'Local Storage': path.join(defaultPath, 'Local Storage'),
            'Preferences': path.join(defaultPath, 'Preferences'),
            'Sessions': path.join(defaultPath, 'Sessions'),
            'Network Persistent State': path.join(defaultPath, 'Network', 'Network Persistent State')
          };
          
          Object.entries(criticalFiles).forEach(([name, filePath]) => {
            if (fs.existsSync(filePath)) {
              const stats = fs.statSync(filePath);
              debugInfo.criticalFiles[name] = {
                exists: true,
                size: stats.size,
                isDirectory: stats.isDirectory()
              };
            } else {
              debugInfo.criticalFiles[name] = { exists: false };
            }
          });
        }
      } catch (e) {
        debugInfo.error = e.message;
      }
    }
    
    res.json(debugInfo);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Upload user-data endpoint (for deployment)
app.post('/upload-user-data', async (req, res) => {
  console.log('User data upload requested');
  
  try {
    // This endpoint receives base64 encoded zip file
    const { fileData, fileName } = req.body;
    
    if (!fileData) {
      return res.status(400).json({ ok: false, error: 'No file data provided' });
    }
    
    const fs = await import('fs');
    const path = await import('path');
    const AdmZip = (await import('adm-zip')).default;
    
    // Save the uploaded file
    const tempPath = '/tmp/user-data-upload.zip';
    const buffer = Buffer.from(fileData, 'base64');
    fs.writeFileSync(tempPath, buffer);
    
    console.log(`User data file saved: ${tempPath} (${buffer.length} bytes)`);
    
    // Smart extraction: Check if zip contains 'user-data/' folder
    const zip = new AdmZip(tempPath);
    const entries = zip.getEntries();
    
    // Check if zip has 'user-data/' as root folder
    const hasUserDataFolder = entries.some(entry => entry.entryName.startsWith('user-data/'));
    
    let extractPath;
    if (hasUserDataFolder) {
      // Zip contains 'user-data/' folder, extract to parent (/data)
      // This creates: /data/user-data/...
      extractPath = path.dirname(USER_DATA_DIR);
      console.log(`Zip contains 'user-data/' folder, extracting to: ${extractPath}`);
    } else {
      // Zip contains files directly, extract to USER_DATA_DIR
      extractPath = USER_DATA_DIR;
      console.log(`Zip contains files directly, extracting to: ${extractPath}`);
    }
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(extractPath)) {
      fs.mkdirSync(extractPath, { recursive: true });
    }
    
    // Extract zip file
    console.log(`Extracting ${entries.length} entries...`);
    zip.extractAllTo(extractPath, true);
    
    // Verify extraction
    if (fs.existsSync(USER_DATA_DIR)) {
      const files = fs.readdirSync(USER_DATA_DIR);
      console.log(`✅ Verified: ${USER_DATA_DIR} exists with ${files.length} items`);
      console.log(`First few items: ${files.slice(0, 5).join(', ')}`);
    } else {
      console.log(`⚠️ Warning: ${USER_DATA_DIR} not found after extraction`);
      // List what was actually created
      if (fs.existsSync(extractPath)) {
        const items = fs.readdirSync(extractPath);
        console.log(`Found in ${extractPath}: ${items.join(', ')}`);
      }
    }
    
    console.log(`User data extracted to: ${extractPath}`);
    
    // Clean up temp file
    fs.unlinkSync(tempPath);
    
    // Close existing browser contexts to force reload of new session data
    if (masterContext) {
      try {
        console.log('Closing master browser context to reload session data...');
        await masterContext.close();
        masterContext = null;
        console.log('Master browser context closed successfully');
      } catch (e) {
        console.log('Error closing master context (may already be closed):', e.message);
        masterContext = null;
      }
    }
    
    // Reinitialize browser pool with new session
    if (browserPool.length > 0) {
      console.log('Reinitializing browser pool with new session...');
      for (const poolBrowser of browserPool) {
        try {
          await poolBrowser.browser.close();
        } catch (e) {
          // Ignore close errors
        }
      }
      browserPool.length = 0;
      poolInitialized = false;
    }
    
    res.json({ 
      ok: true, 
      message: 'User data uploaded and extracted successfully. Browser pool will reinitialize on next request.',
      extractedTo: extractPath,
      userDataDir: USER_DATA_DIR
    });
  } catch (e) {
    console.error('Error uploading user data:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Get session data endpoint (used by workers in multi-VPS deployments to pull cookies from the master)
app.get('/get-session', async (req, res) => {
  // Require auth: contains live session cookies — must not be public
  if (!AUTH_TOKEN || req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    console.log('Unauthorized /get-session request');
    return res.status(401).json({ error: 'unauthorized' });
  }
  console.log('Session data requested');

  const ctx = await ensureContext();
  // Cookies live on the context — no page needed.
  const cookies = await ctx.cookies();

  // localStorage/sessionStorage require a page; wrap in try/finally so the page is always closed
  let page;
  try {
    page = await ctx.newPage();
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });

    const localStorage = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        data[key] = window.localStorage.getItem(key);
      }
      return data;
    });

    const sessionStorage = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        data[key] = window.sessionStorage.getItem(key);
      }
      return data;
    });

    res.json({
      ok: true,
      sessionData: { cookies, localStorage, sessionStorage }
    });
  } catch (e) {
    console.error('Error getting session data:', e);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: e.message || String(e) });
    }
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

// Manual login confirmation endpoint
app.get('/confirm-login', async (_req, res) => {
  console.log('Manual login confirmation requested');
  
  try {
    const ctx = await ensureMasterContext();
    const page = await ctx.newPage();

    // First navigate to the ManyChat dashboard to check login status
    console.log('Navigating to ManyChat dashboard...');
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    await safeWaitForLoad(page);
    
    // Wait a bit for the page to fully load
    await page.waitForTimeout(3000);

    if (await isLoggedIn(page)) {
      await page.close();
      console.log('Login confirmed successfully');
      
      // Initialize/sync browser pool (only when not using single-context)
      if (!USE_SINGLE_CONTEXT) {
        if (!poolInitialized || browserPool.length === 0) {
          console.log('Initializing browser pool...');
          await initBrowserPool();
        }
        await syncCookiesToPool();
      }
      return res.json({ ok: true, message: USE_SINGLE_CONTEXT ? 'Login confirmed!' : 'Login confirmed! Browser pool synced.' });
    } else {
      await page.close();
      console.log('Login confirmation failed - not logged in');
      return res.status(400).json({ 
        ok: false, 
        error: 'Not logged in. Please complete the login process first.' 
      });
    }
  } catch (e) {
    console.error('Error in confirm-login:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// One-time manual OAuth bootstrap
app.get('/init-login', async (_req, res) => {
  console.log(`Init-login called. USER_DATA_DIR: ${USER_DATA_DIR}`);
  
  try {
    const ctx = await ensureContext();
    const page = await ctx.newPage();

    console.log('Checking if already logged in...');
    if (await isLoggedIn(page)) {
      await page.close();
      console.log('Already logged in, returning success');
      return res.json({ ok: true, message: 'Already logged in. Session exists.' });
    }

    if (HEADLESS === 'true') {
      await page.close();
      console.log('HEADLESS=true, cannot complete manual login');
      return res.status(400).json({
        ok: false,
        error: 'HEADLESS=true. Set HEADLESS=false to complete manual OAuth, then retry.'
      });
    }

    console.log('Starting manual login flow...');
    const ok = await manualLoginFlow(page);
    await page.close();

    if (!ok) {
      console.log('Login failed or timed out');
      return res.status(500).json({ ok: false, error: 'Login not completed in time.' });
    }
    
    console.log('Login completed successfully');
    
    // Sync cookies to browser pool (only when not using single-context)
    if (!USE_SINGLE_CONTEXT && poolInitialized && browserPool.length > 0) {
      console.log('Syncing new login session to browser pool...');
      await syncCookiesToPool();
    }
    res.json({ ok: true, message: USE_SINGLE_CONTEXT ? 'Login completed. Session saved to USER_DATA_DIR.' : 'Login completed. Session saved to USER_DATA_DIR and synced to browser pool.' });
  } catch (e) {
    console.error('Error in init-login:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Main action: type slowly and click "Send to Instagram" or trigger automation
app.post('/press', async (req, res) => {
  console.log('POST /press endpoint called');
  
  try {
    // Check authentication
    if (!AUTH_TOKEN || req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      console.log('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    const { type, chatId, message, automation_name, pageId } = req.body || {};
    console.log(`Request body: type=${type}, chatId=${chatId}, message=${message}, automation_name=${automation_name}, pageId=${pageId}`);
    
    // Validate type field
    if (!type || (type !== 'text' && type !== 'automation')) {
      console.log('Invalid or missing type parameter');
      return res.status(400).json({ error: 'Field "type" is required and must be either "text" or "automation"' });
    }
    
    // Validate type-specific fields
    if (type === 'text') {
      if (!chatId || !message || !pageId) {
        console.log('Missing required parameters for text type');
        return res.status(400).json({ error: 'For type "text", all fields required: chatId, message, and pageId' });
      }
    } else if (type === 'automation') {
      if (!chatId || !automation_name || !pageId) {
        console.log('Missing required parameters for automation type');
        return res.status(400).json({ error: 'For type "automation", all fields required: chatId, automation_name, and pageId' });
      }
      if (!automation_name.trim()) {
        console.log('Automation name is empty');
        return res.status(400).json({ error: 'automation_name cannot be empty' });
      }
    }
    
    // ---------- Deduplication ----------
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
    const dedupKey = buildDedupKey({ type, chatId, pageId, message, automation_name, idempotencyKey });
    const existing = dedupGet(dedupKey);

    if (existing) {
      if (existing.result) {
        // Cached completed result (already actually sent within window) — block this duplicate
        console.log(`🔁 Dedup HIT (cached) for key ${dedupKey} — returning cached result without running.`);
        sendDedupNotification({
          type, chatId, pageId, message, automation_name,
          dedupKind: 'cached',
          ageMs: existing.completedAt ? Date.now() - existing.completedAt : null
        });
        return res.json({ ...existing.result, deduped: 'cached' });
      }
      // Otherwise an in-flight request is running — wait for it and return the same outcome
      console.log(`⏳ Dedup HIT (in-flight) for key ${dedupKey} — awaiting original request's result.`);
      sendDedupNotification({
        type, chatId, pageId, message, automation_name,
        dedupKind: 'in-flight'
      });
      try {
        const sharedResult = await existing.promise;
        return res.json({ ...sharedResult, deduped: 'in-flight' });
      } catch (sharedErr) {
        // The original request errored. Fall through and let this request run fresh
        // — except we don't, because the dedup map should already be cleared on error.
        // To be safe, propagate the same error so n8n's later retries see consistent behavior.
        console.error('In-flight original failed; returning same error to duplicate:', sharedErr.message);
        return res.status(500).json({ error: sharedErr.message || String(sharedErr), deduped: 'in-flight' });
      }
    }

    console.log(`🆕 Dedup MISS for key ${dedupKey} — running new job.`);
    const jobPromise = queue.add(async () => {
      try {
        return await handlePress({ type, chatId, message, automation_name, pageId });
      } catch (innerErr) {
        console.error('Error inside queued job (contained):', innerErr.message);
        throw innerErr;
      }
    });
    dedupSetInFlight(dedupKey, jobPromise);

    let result;
    try {
      result = await jobPromise;
    } catch (jobErr) {
      // Job threw — do NOT cache, allow future retries to run fresh
      dedupClear(dedupKey);
      console.error('Error in /press endpoint:', jobErr);
      return res.status(500).json({ error: jobErr.message || String(jobErr) });
    }

    // Cache only if the message/automation was actually delivered
    if (result?.sent === true) {
      dedupMarkSent(dedupKey, result);
      console.log(`✅ Cached result for key ${dedupKey} (sent=true).`);
    } else {
      dedupClear(dedupKey);
      console.log(`↪︎ Not caching result for key ${dedupKey} (sent!=true) — retries allowed.`);
    }

    console.log('Task completed:', result);
    res.json(result);
  } catch (err) {
    console.error('Error in /press endpoint:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Manual trigger for cookie sync from master (also runs automatically on a timer)
app.post('/sync-from-master', async (_req, res) => {
  if (!COOKIE_SYNC_MASTER_URL) {
    return res.json({ ok: false, message: 'COOKIE_SYNC_MASTER_URL not configured (this server is not a worker).' });
  }
  const ok = await syncCookiesFromMaster();
  res.json({ ok, master: COOKIE_SYNC_MASTER_URL });
});

// Endpoint to manually sync cookies to pool
app.post('/sync-pool', async (_req, res) => {
  try {
    if (USE_SINGLE_CONTEXT) {
      return res.json({ ok: true, message: 'Single-context mode: no browser pool to sync.' });
    }
    console.log('Manual pool sync requested');
    if (!poolInitialized || browserPool.length === 0) {
      await initBrowserPool();
    }
    const success = await syncCookiesToPool();
    
    if (success) {
      res.json({ ok: true, message: `Cookies synced to ${browserPool.length} browsers` });
    } else {
      res.status(400).json({ ok: false, error: 'Failed to sync cookies - is master logged in?' });
    }
  } catch (e) {
    console.error('Error in sync-pool:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Endpoint to reinitialize the browser pool
app.post('/reinit-pool', async (_req, res) => {
  try {
    if (USE_SINGLE_CONTEXT) {
      return res.json({ ok: true, message: 'Single-context mode: browser pool is disabled.' });
    }
    console.log('Pool reinitialization requested');
    // Close existing pool browsers
    for (const poolBrowser of browserPool) {
      try {
        await poolBrowser.browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    browserPool.length = 0;
    poolInitialized = false;
    
    // Reinitialize
    await initBrowserPool();
    await syncCookiesToPool();
    
    res.json({ 
      ok: true, 
      message: `Browser pool reinitialized with ${browserPool.length} browsers` 
    });
  } catch (e) {
    console.error('Error in reinit-pool:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Check login status on startup
async function checkInitialLoginStatus() {
  try {
    console.log('Checking initial login status...');
    const ctx = await ensureMasterContext();
    const page = await ctx.newPage();
    
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    await safeWaitForLoad(page);
    await page.waitForTimeout(2000);
    
    const isLoggedInStatus = await isLoggedIn(page);
    await page.close();
    
    if (isLoggedInStatus) {
      console.log('✅ Login session found - ready to send messages!');
      return true;
    } else {
      console.log('❌ No login session found - run /init-login first');
      return false;
    }
  } catch (error) {
    console.log('Could not check login status:', error.message);
    return false;
  }
}

// Initialize browser pool on startup
async function initializeOnStartup() {
  console.log(`Browser pool config: ${BROWSER_POOL_SIZE} browsers, ${MAX_PAGES_PER_BROWSER} pages each`);

  // If this is a worker VPS (not the session master), pull cookies before checking login
  if (COOKIE_SYNC_MASTER_URL) {
    console.log(`[cookie-sync] Worker mode: master=${COOKIE_SYNC_MASTER_URL}, interval=${COOKIE_SYNC_INTERVAL_MS}ms`);
    await syncCookiesFromMaster();
    setInterval(() => {
      syncCookiesFromMaster().catch(e => console.error('[cookie-sync] Periodic sync failed:', e.message));
    }, COOKIE_SYNC_INTERVAL_MS);
  } else {
    console.log('[cookie-sync] No COOKIE_SYNC_MASTER_URL set - running as session master / single-VPS.');
  }

  // Check if logged in first
  const loggedIn = await checkInitialLoginStatus();

  if (USE_SINGLE_CONTEXT) {
    if (loggedIn) {
      console.log('✅ Single-context mode: one window, up to ' + SINGLE_CONTEXT_MAX_TABS + ' concurrent tabs');
    } else {
      console.log('⏳ Single-context mode: login required on first request');
    }
  } else if (loggedIn) {
    console.log('Initializing browser pool...');
    await initBrowserPool();
    await syncCookiesToPool();
    console.log('✅ Browser pool ready!');
  } else {
    console.log('⏳ Browser pool will be initialized after login');
  }
}

app.listen(PORT, async () => {
  console.log(`manychat-clicker listening on :${PORT} (headless=${HEADLESS}, concurrency=${CONCURRENCY}, singleContext=${USE_SINGLE_CONTEXT}${USE_SINGLE_CONTEXT ? ` maxTabs=${SINGLE_CONTEXT_MAX_TABS}` : ''})`);
  console.log(`Request stagger delay: 0-${STAGGER_DELAY_MS}ms`);
  
  // Skip initialization in non-headless mode
  if (HEADLESS === 'true') {
    await initializeOnStartup();
  } else {
    console.log('⏳ Browser will open on first API request - login will be required');
  }
});

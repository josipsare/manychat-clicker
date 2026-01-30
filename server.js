import 'dotenv/config';
import express from 'express';
import PQueue from 'p-queue';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '50mb' })); // Increased for user-data upload
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const {
  AUTH_TOKEN,
  PORT = process.env.PORT || 3000,
  HEADLESS = 'true'
} = process.env;

// Fix: Respect USER_DATA_DIR from environment, don't override it
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data/user-data' : './data/user-data');

const BASE = 'https://app.manychat.com';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 420_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6); // Allow multiple simultaneous requests (2 browsers x 3 tabs)
const queue = new PQueue({ concurrency: CONCURRENCY, timeout: JOB_TIMEOUT_MS });
const DEFAULT_TYPING_BASE = Number(process.env.TYPING_BASE_MS ?? 60);  // Aggressive: faster typing
const DEFAULT_TYPING_VARIANCE = Number(process.env.TYPING_VARIANCE_MS ?? 30);  // Aggressive: less variance
const STAGGER_DELAY_MS = Number(process.env.STAGGER_DELAY_MS ?? 500); // Aggressive: minimal stagger

// Login cache to avoid checking every request
let lastLoginCheck = 0;
const LOGIN_CACHE_TTL = 5 * 60 * 1000; // Cache login status for 5 minutes
let cachedLoginStatus = false;

// Browser pool configuration
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

// Get cookies from master context
async function getMasterCookies() {
  const ctx = await ensureMasterContext();
  const page = await ctx.newPage();
  await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
  const cookies = await ctx.cookies();
  await page.close();
  return cookies;
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

async function openChat(page, chatId, pageId) {
  console.log(`Opening chat: ${chatId} on page: ${pageId}`);
  const url = `${BASE}/${pageId}/chat/${chatId}`;
  console.log(`Navigating to: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await safeWaitForLoad(page);
    console.log('Page loaded successfully');

    // Aggressive: reduced wait for dynamic content
    await page.waitForTimeout(800);

    // Try common composer targets with more specific selectors
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

    console.log('Looking for message composer...');
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const count = await candidate.count();
        console.log(`Trying selector ${i + 1}/${candidates.length}, found ${count} elements`);
        
        if (count > 0) {
          await candidate.waitFor({ timeout: 10000 });
          console.log(`Found message composer with selector ${i + 1}`);
          return candidate;
        }
      } catch (e) {
        console.log(`Selector ${i + 1} failed:`, e.message);
        continue;
      }
    }
    
    // Take a screenshot for debugging
    await page.screenshot({ path: './data/chat-page-error.png', fullPage: true });
    console.log('Screenshot saved to ./data/chat-page-error.png');
    
    throw new Error('Message composer not found. Check screenshot for debugging.');
  } catch (error) {
    console.error('Error opening chat:', error);
    throw error;
  }
}

async function slowType(locator, text, baseDelay = DEFAULT_TYPING_BASE, variance = DEFAULT_TYPING_VARIANCE) {
  await locator.click({ delay: 20 }); // Aggressive: faster click
  for (const char of text) {
    const jitter = (Math.random() - 0.5) * 2 * variance;
    const delay = Math.max(10, Math.round(baseDelay + jitter)); // Aggressive: min 10ms instead of 15ms
    await locator.type(char, { delay });
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
          return;
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
  
  throw new Error('Could not find "Send to Instagram" button. Check screenshot for debugging.');
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
          await page.waitForTimeout(800); // Aggressive: reduced from 2000ms
          
          // Check if modal appeared by looking for search input
          const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
          const modalVisible = await searchInput.isVisible({ timeout: 2000 }).catch(() => false); // Aggressive: reduced timeout
          
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
  
  throw new Error('Could not find "Automation" button. Check screenshot for debugging.');
}

async function searchAndSelectAutomation(page, automationName) {
  console.log(`Searching for automation: "${automationName}"...`);
  
  const MAX_RETRIES = 3;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
      const selector = searchInputSelectors[i];
      try {
        const count = await selector.count();
        if (count > 0) {
          const input = selector.first();
          const isVisible = await input.isVisible({ timeout: 500 }).catch(() => false);
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
        await page.waitForTimeout(300 * attempt);
        continue;
      }
      throw new Error('Could not find search input in automation picker modal');
    }
    
    // Click on search input to ensure focus
    try {
      console.log('Clicking on search input to ensure focus...');
      await searchInput.click();
      await page.waitForTimeout(50);
    } catch (e) {
      console.log('Could not click search input:', e.message);
    }
    
    // Clear any existing text
    try {
      console.log('Clearing search field...');
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(50);
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
    
    // Wait for search results to appear
    console.log('Waiting for search results to load...');
    await page.waitForTimeout(800); // Balanced: enough time for results but not too slow
    
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
      const selector = automationSelectors[i];
      try {
        const count = await selector.count();
        console.log(`Trying automation selector ${i + 1}/${automationSelectors.length}, found ${count} elements`);
        
        if (count > 0) {
          const element = selector.first();
          const isVisible = await element.isVisible({ timeout: 3000 }).catch(() => false);
          
          if (isVisible) {
            // Verify the card/container contains the automation name
            const text = await element.textContent().catch(() => '');
            // For buttons inside cards, also check parent text
            const parentText = await element.locator('..').textContent().catch(() => text);
            
            if (text.includes(automationName) || parentText.includes(automationName)) {
              console.log(`Found automation "${automationName}" with selector ${i + 1}`);
              
              // Try normal click first, fall back to force:true if intercepted
              try {
                await element.click({ delay: 50, timeout: 3000 });
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
      await page.waitForTimeout(400);
      return true;
    }
    
    // IMPROVEMENT #7: Retry logic with exponential backoff
    if (attempt < MAX_RETRIES) {
      const waitTime = 500 * attempt; // 500ms, 1000ms for subsequent retries
      console.log(`Automation not found on attempt ${attempt}, waiting ${waitTime}ms before retry...`);
      await page.screenshot({ path: `./data/automation-not-found-attempt-${attempt}.png`, fullPage: true });
      console.log(`Screenshot saved to ./data/automation-not-found-attempt-${attempt}.png`);
      await page.waitForTimeout(waitTime);
    }
  }
  
  // All retries exhausted
  await page.screenshot({ path: './data/automation-not-found-error.png', fullPage: true });
  console.log('Screenshot saved to ./data/automation-not-found-error.png');
  throw new Error(`Automation "${automationName}" not found in search results after ${MAX_RETRIES} attempts. Check screenshots for debugging.`);
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
          await button.click({ delay: 30 }); // Aggressive: faster click
          
          // Wait for modal to close/disappear
          await page.waitForTimeout(600); // Aggressive: reduced from 2000ms
          
          // Check if modal closed by verifying search input is no longer visible
          const searchInput = page.locator('input[placeholder*="Search"]').first();
          const modalClosed = await searchInput.isVisible({ timeout: 500 }).catch(() => false); // Aggressive: reduced timeout
          
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
  
  throw new Error('Could not find "Pick This Automation" button. Check screenshot for debugging.');
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
          await button.click({ delay: 50 });
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
  await page.waitForTimeout(200); // Aggressive: reduced from 500ms
  
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

  // Get a browser from the pool
  let poolBrowser = await getPoolBrowser();
  let page;
  
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

  try {
    // Use cached login status to skip full check (aggressive optimization)
    if (isLoginCached()) {
      console.log('Using cached login status (skipping full check)');
    } else {
      console.log('Checking login status...');
      
      // Navigate to ManyChat to check login status
      await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
      await safeWaitForLoad(page);
      await page.waitForTimeout(800); // Aggressive: reduced from 2000ms
      
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
      await slowType(composer, message);
      console.log('Message typed successfully');

      console.log('Clicking send button...');
      await clickSendToInstagram(page);
      console.log('Send button clicked successfully');

      await page.waitForTimeout(800); // Aggressive: reduced from 2000ms
      console.log('Message sent successfully');
      
      // Step 1 - Click the automation timer button (with orange pause icon)
      console.log('\n=== Starting automation button sequence ===');
      console.log('Step 1: Looking for automation timer button...');
      await page.waitForTimeout(600); // Aggressive: reduced from 2000ms
      
      const timerButtonClicked = await clickAutomationTimerButton(page);
      if (timerButtonClicked) {
        console.log('✅ Step 1 complete: Timer button clicked');
        await page.waitForTimeout(1000); // Aggressive: reduced from 3000ms
        
        // Step 2 - Click "Resume automations" in the dropdown
        console.log('Step 2: Looking for "Resume automations" in dropdown...');
        const resumeButtonClicked = await clickResumeAutomationsButton(page);
        if (resumeButtonClicked) {
          console.log('✅ Step 2 complete: "Resume automations" clicked');
          await page.waitForTimeout(500); // Aggressive: reduced from 2000ms
          console.log('=== Automation button sequence complete ===\n');
        } else {
          console.log('⚠️  Step 2 failed: "Resume automations" button not found in dropdown');
        }
      } else {
        console.log('⚠️  Step 1 failed: Timer button not found (skipping Step 2)');
      }
      
      return { ok: true, chatId, message: 'Message sent and automation sequence completed' };
      
    } else if (type === 'automation') {
      // AUTOMATION FOLLOWUP FLOW (new behavior)
      console.log('=== Starting automation followup flow ===');
      
      try {
        // Step 1: Click the Automation button
        console.log('Step 1: Clicking Automation button...');
        await clickAutomationButton(page);
        console.log('✅ Step 1 complete: Automation button clicked');
        
        // Step 2: Search and select automation by name
        console.log('Step 2: Searching and selecting automation...');
        await searchAndSelectAutomation(page, automation_name);
        console.log('✅ Step 2 complete: Automation selected');
        
        // Step 3: Click "Pick This Automation" button
        console.log('Step 3: Clicking "Pick This Automation" button...');
        await clickPickThisAutomationButton(page);
        console.log('✅ Step 3 complete: Automation picked successfully');
        
        console.log('=== Automation followup flow complete ===');
        return { ok: true, chatId, message: `Automation '${automation_name}' selected and triggered successfully` };
        
      } catch (error) {
        console.error('Error in automation followup flow:', error);
        
        // Take a screenshot for debugging
        try {
          await page.screenshot({ path: './data/automation-flow-error.png', fullPage: true });
          console.log('Error screenshot saved to ./data/automation-flow-error.png');
        } catch (e) {
          console.log('Could not save error screenshot:', e.message);
        }
        
        throw error;
      }
    }
    
  } catch (error) {
    console.error('Error in handlePress:', error);
    
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
    poolBrowser.activePages--;
    console.log(`Page closed. Pool browser ${poolBrowser.index + 1} now has ${poolBrowser.activePages} active pages`);
  }
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.json({ 
  service: 'ManyChat Clicker', 
  status: 'running',
  version: '2.0.0',
  config: {
    browserPoolSize: BROWSER_POOL_SIZE,
    maxPagesPerBrowser: MAX_PAGES_PER_BROWSER,
    concurrency: CONCURRENCY
  },
  endpoints: {
    health: '/healthz',
    login: '/init-login',
    confirm: '/confirm-login',
    send: '/press',
    syncPool: '/sync-pool',
    reinitPool: '/reinit-pool'
  }
}));

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
      
      // Sync to browser pool
      if (!poolInitialized || browserPool.length === 0) {
        await initBrowserPool();
      }
      await syncCookiesToPool();
      
      return res.json({ ok: true, message: 'Session transferred successfully! Browser pool synced.' });
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
    
    await ensureContext();
    const page = await context.newPage();
    
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
        initialized: !!context,
        status: context ? 'active' : 'not created'
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

// Get session data endpoint (for local extraction)
app.get('/get-session', async (_req, res) => {
  console.log('Session data requested');
  
  try {
    const ctx = await ensureContext();
    const page = await ctx.newPage();
    
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    
    // Get cookies
    const cookies = await page.context().cookies();
    
    // Get localStorage
    const localStorage = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        data[key] = window.localStorage.getItem(key);
      }
      return data;
    });
    
    // Get sessionStorage
    const sessionStorage = await page.evaluate(() => {
      const data = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        data[key] = window.sessionStorage.getItem(key);
      }
      return data;
    });
    
    await page.close();
    
    res.json({
      ok: true,
      sessionData: {
        cookies,
        localStorage,
        sessionStorage
      }
    });
  } catch (e) {
    console.error('Error getting session data:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
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
      
      // Initialize/sync browser pool
      if (!poolInitialized || browserPool.length === 0) {
        console.log('Initializing browser pool...');
        await initBrowserPool();
      }
      await syncCookiesToPool();
      
      return res.json({ ok: true, message: 'Login confirmed! Browser pool synced.' });
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
    
    // Sync cookies to browser pool
    if (poolInitialized && browserPool.length > 0) {
      console.log('Syncing new login session to browser pool...');
      await syncCookiesToPool();
    }
    
    res.json({ ok: true, message: 'Login completed. Session saved to USER_DATA_DIR and synced to browser pool.' });
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
    
    console.log('Adding task to queue...');
    const result = await queue.add(() => handlePress({ type, chatId, message, automation_name, pageId }));
    console.log('Task completed successfully:', result);
    res.json(result);
  } catch (err) {
    console.error('Error in /press endpoint:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Endpoint to manually sync cookies to pool
app.post('/sync-pool', async (_req, res) => {
  try {
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
  
  // Check if logged in first
  const loggedIn = await checkInitialLoginStatus();
  
  if (loggedIn) {
    // Initialize browser pool with session cookies
    console.log('Initializing browser pool...');
    await initBrowserPool();
    await syncCookiesToPool();
    console.log('✅ Browser pool ready!');
  } else {
    console.log('⏳ Browser pool will be initialized after login');
  }
}

app.listen(PORT, async () => {
  console.log(`manychat-clicker listening on :${PORT} (headless=${HEADLESS}, concurrency=${CONCURRENCY})`);
  console.log(`Request stagger delay: 0-${STAGGER_DELAY_MS}ms`);
  
  // Skip initialization in non-headless mode
  if (HEADLESS === 'true') {
    await initializeOnStartup();
  } else {
    console.log('⏳ Browser will open on first API request - login will be required');
  }
});

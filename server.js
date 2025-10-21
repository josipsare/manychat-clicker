import 'dotenv/config';
import express from 'express';
import PQueue from 'p-queue';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  AUTH_TOKEN,
  USER_DATA_DIR = process.env.NODE_ENV === 'production' ? '/tmp/user-data' : './data/user-data',
  MC_PAGE_ID = 'fb2860983',
  PORT = process.env.PORT || 3000,
  HEADLESS = 'true'
} = process.env;

const BASE = 'https://app.manychat.com';
const queue = new PQueue({ concurrency: 1, timeout: 180_000 });
let context;

// ---------- Shared helpers ----------
async function ensureContext() {
  if (!context) {
    console.log('Creating new browser context...');
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS === 'true',
      viewport: { width: 1440, height: 900 },
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });
    console.log('Browser context created successfully');
  } else {
    // Check if context is still valid
    try {
      const pages = context.pages();
      console.log('Reusing existing browser context');
    } catch (error) {
      console.log('Context is invalid, creating new one...');
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: HEADLESS === 'true',
        viewport: { width: 1440, height: 900 },
        args: ['--disable-dev-shm-usage', '--no-sandbox']
      });
      console.log('New browser context created successfully');
    }
  }
  return context;
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
    
    if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
      console.log('Still on login/auth page');
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
    await page.waitForLoadState('networkidle');
    
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
      if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
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

async function openChat(page, chatId) {
  console.log(`Opening chat: ${chatId}`);
  const url = `${BASE}/${MC_PAGE_ID}/chat/${chatId}`;
  console.log(`Navigating to: ${url}`);
  
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    console.log('Page loaded successfully');

    // Wait a bit for dynamic content to load
    await page.waitForTimeout(2000);

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

async function slowType(locator, text, delayMs = 500) {
  await locator.click({ delay: 50 });
  await locator.type(text, { delay: delayMs });
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

async function handlePress({ chatId, message }) {
  console.log(`Starting handlePress for chatId: ${chatId}, message: ${message}`);
  
  if (!chatId || !message) {
    throw new Error('Both "chatId" and "message" are required.');
  }

  const ctx = await ensureContext();
  const page = await ctx.newPage();

  try {
    console.log('Checking login status...');
    
    // First navigate to ManyChat to check login status
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Wait for page to fully load
    
    if (!(await isLoggedIn(page))) {
      throw new Error('Not logged in. Run /init-login with HEADLESS=false first.');
    }
    console.log('Login check passed');

    console.log('Opening chat...');
    const composer = await openChat(page, chatId);
    console.log('Chat opened successfully');

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
    await slowType(composer, message, 500);
    console.log('Message typed successfully');

    console.log('Clicking send button...');
    await clickSendToInstagram(page);
    console.log('Send button clicked successfully');

    await page.waitForTimeout(1200); // small settle
    console.log('Message sent successfully');
    return { ok: true, chatId, message: 'Message sent successfully' };
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
    await page.close();
    console.log('Page closed');
  }
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.json({ 
  service: 'ManyChat Clicker', 
  status: 'running',
  version: '1.0.0',
  endpoints: {
    health: '/healthz',
    login: '/init-login',
    confirm: '/confirm-login',
    send: '/press'
  }
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

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

// Manual login confirmation endpoint
app.get('/confirm-login', async (_req, res) => {
  console.log('Manual login confirmation requested');
  
  try {
    const ctx = await ensureContext();
    const page = await ctx.newPage();

    // First navigate to the ManyChat dashboard to check login status
    console.log('Navigating to ManyChat dashboard...');
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    
    // Wait a bit for the page to fully load
    await page.waitForTimeout(3000);

    if (await isLoggedIn(page)) {
      await page.close();
      console.log('Login confirmed successfully');
      return res.json({ ok: true, message: 'Login confirmed! You are now logged in.' });
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
    res.json({ ok: true, message: 'Login completed. Session saved to USER_DATA_DIR.' });
  } catch (e) {
    console.error('Error in init-login:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Main action: type slowly and click "Send to Instagram"
app.post('/press', async (req, res) => {
  console.log('POST /press endpoint called');
  
  try {
    // Check authentication
    if (!AUTH_TOKEN || req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      console.log('Unauthorized request - missing or invalid auth token');
      return res.status(401).json({ error: 'unauthorized' });
    }
    
    const { chatId, message } = req.body || {};
    console.log(`Request body: chatId=${chatId}, message=${message}`);
    
    if (!chatId || !message) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Both chatId and message are required' });
    }
    
    console.log('Adding task to queue...');
    const result = await queue.add(() => handlePress({ chatId, message }));
    console.log('Task completed successfully:', result);
    res.json(result);
  } catch (err) {
    console.error('Error in /press endpoint:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Check login status on startup (only in headless mode)
async function checkInitialLoginStatus() {
  if (HEADLESS === 'false') {
    console.log('Non-headless mode: Skipping initial login check');
    return;
  }
  
  try {
    console.log('Checking initial login status...');
    const ctx = await ensureContext();
    const page = await ctx.newPage();
    
    await page.goto('https://app.manychat.com', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    const isLoggedInStatus = await isLoggedIn(page);
    await page.close();
    
    if (isLoggedInStatus) {
      console.log('✅ Login session found - ready to send messages!');
    } else {
      console.log('❌ No login session found - run /init-login first');
    }
  } catch (error) {
    console.log('Could not check login status:', error.message);
  }
}

app.listen(PORT, async () => {
  console.log(`manychat-clicker listening on :${PORT} (headless=${HEADLESS})`);
  await checkInitialLoginStatus();
});

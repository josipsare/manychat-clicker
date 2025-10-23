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
const queue = new PQueue({ concurrency: 1, timeout: 180_000 });
let context;

// ---------- Shared helpers ----------
async function ensureContext() {
  if (!context) {
    console.log('Creating new browser context...');
    
    // Determine if we're in a cloud environment (no display)
    const isCloudEnvironment = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER;
    
    // Browser args for cloud environments
    const browserArgs = [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ];
    
    // Add virtual display args for cloud environments
    if (isCloudEnvironment && HEADLESS === 'false') {
      browserArgs.push('--virtual-time-budget=5000');
      console.log('Cloud environment detected - using virtual display mode');
    }
    
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS === 'true',
      viewport: { width: 1440, height: 900 },
      args: browserArgs
    });
    console.log('Browser context created successfully');
  } else {
    // Check if context is still valid
    try {
      const pages = context.pages();
      console.log('Reusing existing browser context');
    } catch (error) {
      console.log('Context is invalid, creating new one...');
      
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
      }
      
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: HEADLESS === 'true',
        viewport: { width: 1440, height: 900 },
        args: browserArgs
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
  
  // Wait a bit more for the dropdown menu to be fully rendered
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

async function handlePress({ chatId, message, pageId }) {
  console.log(`Starting handlePress for chatId: ${chatId}, message: ${message}, pageId: ${pageId}`);
  
  if (!chatId || !message || !pageId) {
    throw new Error('All fields required: "chatId", "message", and "pageId".');
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
      if (HEADLESS === 'false') {
        // In non-headless mode, wait for user to complete manual login
        console.log('⏳ Not logged in - waiting for manual login in browser...');
        console.log('👉 Please complete the ManyChat login in the browser window');
        console.log('⏱️  Waiting up to 5 minutes for you to login...');
        
        const loginSuccess = await manualLoginFlow(page);
        if (!loginSuccess) {
          throw new Error('Login timeout - please complete login and try again');
        }
        console.log('✅ Login completed!');
      } else {
        throw new Error('Not logged in. Run /init-login with HEADLESS=false first.');
      }
    }
    console.log('Login check passed');

    console.log('Opening chat...');
    const composer = await openChat(page, chatId, pageId);
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

    await page.waitForTimeout(2000); // Wait for message to fully send
    console.log('Message sent successfully');
    
    // NEW: Step 1 - Click the automation timer button (with orange pause icon)
    console.log('\n=== Starting automation button sequence ===');
    console.log('Step 1: Looking for automation timer button...');
    await page.waitForTimeout(2000); // Wait before looking for timer button
    
    const timerButtonClicked = await clickAutomationTimerButton(page);
    if (timerButtonClicked) {
      console.log('✅ Step 1 complete: Timer button clicked');
      console.log('⏳ Waiting 3 seconds for dropdown menu to appear...');
      await page.waitForTimeout(3000); // Longer wait for dropdown to appear
      
      // NEW: Step 2 - Click "Resume automations" in the dropdown
      console.log('Step 2: Looking for "Resume automations" in dropdown...');
      const resumeButtonClicked = await clickResumeAutomationsButton(page);
      if (resumeButtonClicked) {
        console.log('✅ Step 2 complete: "Resume automations" clicked');
        console.log('⏳ Waiting 2 seconds for automation to resume...');
        await page.waitForTimeout(2000); // Wait for automation to resume
        console.log('=== Automation button sequence complete ===\n');
      } else {
        console.log('⚠️  Step 2 failed: "Resume automations" button not found in dropdown');
      }
    } else {
      console.log('⚠️  Step 1 failed: Timer button not found (skipping Step 2)');
    }
    
    return { ok: true, chatId, message: 'Message sent and automation sequence completed' };
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
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // Check if login worked
    if (await isLoggedIn(page)) {
      await page.close();
      console.log('Session transfer successful!');
      return res.json({ ok: true, message: 'Session transferred successfully!' });
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
    
    // Close existing browser context to force reload of new session data
    if (context) {
      try {
        console.log('Closing existing browser context to reload session data...');
        await context.close();
        context = null;
        console.log('Browser context closed successfully');
      } catch (e) {
        console.log('Error closing context (may already be closed):', e.message);
        context = null;
      }
    }
    
    res.json({ 
      ok: true, 
      message: 'User data uploaded and extracted successfully. Browser context will reload on next request.',
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
    
    const { chatId, message, pageId } = req.body || {};
    console.log(`Request body: chatId=${chatId}, message=${message}, pageId=${pageId}`);
    
    if (!chatId || !message || !pageId) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'All fields required: chatId, message, and pageId' });
    }
    
    console.log('Adding task to queue...');
    const result = await queue.add(() => handlePress({ chatId, message, pageId }));
    console.log('Task completed successfully:', result);
    res.json(result);
  } catch (err) {
    console.error('Error in /press endpoint:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Check login status on startup
async function checkInitialLoginStatus() {
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
  // Skip initial login check in non-headless mode to keep browser open
  if (HEADLESS === 'true') {
    await checkInitialLoginStatus();
  } else {
    console.log('⏳ Browser will open on first API request - login will be required');
  }
});

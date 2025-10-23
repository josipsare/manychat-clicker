import { chromium } from 'playwright';
import readline from 'readline';

console.log('Opening browser for ManyChat login...');
console.log('Please complete the login, then come back here.');

const context = await chromium.launchPersistentContext('./data/user-data', {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    '--disable-dev-shm-usage',
    '--no-sandbox'
  ]
});

const page = await context.newPage();
await page.goto('https://app.manychat.com');

console.log('\n✅ Browser opened!');
console.log('📋 Instructions:');
console.log('  1. Complete the ManyChat login in the browser');
console.log('  2. Wait until you see your dashboard');
console.log('  3. Come back here and press ENTER to save and close');
console.log('');

// Wait for user confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

await new Promise((resolve) => {
  rl.question('Press ENTER when you are logged in and see the dashboard: ', () => {
    rl.close();
    resolve();
  });
});

console.log('\nClosing browser and saving session...');
await page.close();
await context.close();
console.log('✅ Session saved successfully!');
console.log('You can now start the server with: .\\start-server.ps1');



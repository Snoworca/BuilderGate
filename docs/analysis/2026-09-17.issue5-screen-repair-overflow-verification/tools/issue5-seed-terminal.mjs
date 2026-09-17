// Issue #5 lane seed: the wave2-screen-repair-resync spec requires an already
// present terminal in the default workspace. Create exactly one, own nothing else.
import { chromium } from '@playwright/test';

const base = 'https://localhost:2222';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
const page = await ctx.newPage();
await page.goto('/');
await page.waitForSelector('input[type="password"]', { timeout: 15000 });
await page.fill('input[type="password"]', process.env.BUILDERGATE_PASSWORD || '1234');
await page.click('button[type="submit"]');
await page.waitForSelector('.workspace-screen', { timeout: 15000 });
const add = page.getByRole('button', { name: '+ Add Terminal' });
if (await add.count()) {
  await add.first().click();
  console.log('clicked Add Terminal');
} else {
  console.log('terminal already present');
}
await page.waitForSelector('.xterm-screen:visible', { timeout: 20000 });
console.log('terminal visible');
await page.waitForTimeout(2000);
await browser.close();

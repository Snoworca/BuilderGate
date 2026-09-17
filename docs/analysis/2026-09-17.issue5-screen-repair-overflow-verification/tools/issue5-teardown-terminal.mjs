// Lane teardown: close every terminal tab in the default workspace. It belongs
// to the self-seeding experiment this lane withdrew (see the bundle README's
// "채택하지 않은 실험" section); the committed spec does not need it. Its only
// committed run is raw/teardown-before-selfseeded.log, against server PID
// 451255. Copy into frontend/ before running; it needs @playwright/test.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://localhost:2222' });
const page = await ctx.newPage();
await page.goto('/');
await page.waitForSelector('input[type="password"]', { timeout: 15000 });
await page.fill('input[type="password"]', process.env.BUILDERGATE_PASSWORD || '1234');
await page.click('button[type="submit"]');
await page.waitForSelector('.workspace-screen', { timeout: 15000 });
await page.waitForTimeout(3000);
for (let i = 0; i < 10; i += 1) {
  const tabs = page.locator('[role="tab"]');
  const n = await tabs.count();
  if (n === 0) break;
  const closers = tabs.first().locator('button, [aria-label*="close" i], [title*="close" i]');
  const c = await closers.count();
  console.log('tabs', n, 'closers on first tab', c);
  if (c === 0) { console.log('no close control found'); break; }
  await closers.last().click();
  await page.waitForTimeout(800);
  const overlay = page.locator('.modal-overlay');
  if (await overlay.count() > 0) {
    const buttons = overlay.locator('button');
    const labels = await buttons.allTextContents();
    console.log('modal buttons', JSON.stringify(labels));
    const idx = labels.findIndex((t) => /확인|삭제|닫기|close|ok|yes|종료/i.test(t.trim()));
    await buttons.nth(idx >= 0 ? idx : 0).click();
    await page.waitForTimeout(1500);
  }
}
const empty = await page.getByRole('button', { name: '+ Add Terminal' }).count();
console.log('empty state present:', empty > 0, 'tabs left:', await page.locator('[role="tab"]').count());
await browser.close();

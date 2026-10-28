// FR-UIDS-015 on 2222: a phone turned to landscape keeps the mobile layout, and a desktop browser
// window of the same size keeps the desktop one. The mobile layout has no sidebar (a drawer
// instead); the desktop layout always draws `aside.sidebar`.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';

import { test, expect } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

test.describe('landscape phone layout', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(90000);
    record = newOwnedFolder(`mobile-landscape/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-land', { 'a.txt': 'a\n' });
    await page.waitForSelector('.terminal-view:visible', { timeout: 30000 });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  test('a phone keeps the mobile layout when turned; a desktop window of that size stays desktop', async ({ page }, testInfo) => {
    const touch = testInfo.project.use.hasTouch === true;
    const sidebar = page.locator('aside.sidebar');
    const portrait = page.viewportSize()!;
    // AC-1 / AC-2: landscape at a phone's size (915 x 412).
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(sidebar).toHaveCount(touch ? 0 : 1);
    // AC-4: the workspace and its terminal are still there, no reload.
    await expect(page.locator('.terminal-view:visible').first()).toBeVisible();
    await page.screenshot({ path: `../.playwright-mcp/e2e-landscape-${touch ? 'phone' : 'desktop'}.png` });
    if (touch) {
      // Back to portrait: still mobile.
      await page.setViewportSize(portrait);
      await expect(sidebar).toHaveCount(0);
    }
  });
});

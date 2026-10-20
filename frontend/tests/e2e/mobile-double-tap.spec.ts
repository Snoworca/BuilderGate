// FR-UIDS-013 (#157), on 2222, phone only: two quick taps open the context menu where a long
// press does -- the status bar path, the terminal, a workspace tab and a file explorer row --
// and the second tap neither opens the file nor starts a rename.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';

import { test, expect, type Locator, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

// On a phone the menu is the bottom dialog (ContextMenu's MobileContextMenuDialog).
const menu = (page: Page) => page.locator('.context-menu-dialog').first();

async function doubleTap(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('target has no box');
  const x = box.x + Math.min(box.width / 2, 40);
  const y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
  await page.touchscreen.tap(x, y);
}

async function closeMenu(page: Page): Promise<void> {
  const sheet = await menu(page).boundingBox();
  await page.locator('.context-menu-dialog-backdrop').tap({ position: { x: Math.round(sheet!.x + sheet!.width / 2), y: Math.round(sheet!.y / 2) } });
  await expect(menu(page)).toHaveCount(0, { timeout: 3000 });
}

test.describe('double tap opens the context menu', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.use.isMobile !== true, 'touch only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`mobile-double-tap/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-dtap', { 'note.md': '# n\n' });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  test('status path, terminal, workspace tab and explorer row', async ({ page }) => {
    // Status bar path (its long press was the browser's own contextmenu).
    // The first tap copies; the second must still land on the path (the copied badge waits).
    await doubleTap(page, page.locator('.metadata-cwd-path:visible').first());
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    await closeMenu(page);

    // Terminal (tab mode): the middle of the stage, where the visible terminal is drawn (hidden
    // tabs' terminals are parked off screen and would match a plain locator).
    await doubleTap(page, page.locator('.terminal-workspace-stage').first());
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    await closeMenu(page);

    // Workspace tab: the menu, not a rename.
    const tab = page.locator('.workspace-tabbar [role="tab"]', { hasText: 'e2e-dtap-work' }).first();
    await doubleTap(page, tab);
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.workspace-tabbar input')).toHaveCount(0);
    await closeMenu(page);

    // File explorer row: the menu, and the file is not opened in the editor.
    await page.locator('button[aria-label="파일 탐색기"]').first().tap();
    const row = page.locator('.window-dialog [data-path$="note.md"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await doubleTap(page, row);
    await expect(menu(page)).toBeVisible({ timeout: 3000 });
    await expect(menu(page)).toContainText('편집기로 열기');
    await page.waitForTimeout(500);
    await expect(page.locator('.editor-window-host')).toHaveCount(0);
    await page.screenshot({ path: '../.playwright-mcp/e2e-double-tap-explorer.png' });
  });
});

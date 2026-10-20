// FR-FEX-028 (#152), FR-FEX-029 / FR-FOP-008 (#153), FR-FEX-030 (#154), end to end on 2222:
// the explorer fills the stage on a phone, makes a new file from its context menu, and moves or
// copies entries dropped onto a folder.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

const explorer = (page: Page) => page.locator('.window-dialog').filter({ has: page.locator('.fx-window-body') }).first();
const row = (page: Page, name: string) => explorer(page).locator(`[data-path$="${name}"]`).first();

async function openExplorer(page: Page, phone: boolean, firstName: string): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(row(page, firstName)).toBeVisible({ timeout: 15000 });
}

test.describe('file explorer: stage on a phone, new file, drag and drop', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`file-explorer-create-move/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-fxcm', {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'target/keep.txt': 'keep\n',
      'other/inner/deep.txt': 'deep\n',
    });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-FEX-028 AC-1, AC-3
  test('the window fills the stage on a phone and floats on a desktop', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    const win = await explorer(page).boundingBox();
    expect(stage, 'stage measured').not.toBeNull();
    expect(win, 'window measured').not.toBeNull();
    // Measured, not assumed: a floating window is the 760x520 default, far below any stage.
    const fillsStage = Math.abs(win!.x - stage!.x) <= 2 && Math.abs(win!.y - stage!.y) <= 2
      && Math.abs(win!.width - stage!.width) <= 2 && Math.abs(win!.height - stage!.height) <= 2;
    console.log(`stage=${JSON.stringify(stage)} window=${JSON.stringify(win)} phone=${phone}`);
    expect(fillsStage).toBe(phone);
    const maximize = explorer(page).locator('button[aria-label="최대화"]');
    await expect(maximize).toHaveCount(phone ? 0 : 1);
    await page.screenshot({ path: `../.playwright-mcp/e2e-fx-stage-${phone ? 'phone' : 'desktop'}.png` });
  });
});

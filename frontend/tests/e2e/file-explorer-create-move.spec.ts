// FR-FEX-028 (#152), FR-FEX-029 / FR-FOP-008 (#153), FR-FEX-030 (#154), end to end on 2222:
// the explorer fills the stage on a phone, makes a new file from its context menu, and moves or
// copies entries dropped onto a folder.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

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

  // FR-FEX-029 AC-1~AC-6, FR-FOP-008 AC-1/AC-2
  test('새 파일 makes an empty file and refuses a taken name', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    const dialog = explorer(page).locator('.fx-new-file-box');
    const input = dialog.locator('input');
    const create = dialog.locator('button', { hasText: '만들기' });
    const open = async () => {
      if (phone) {
        await explorer(page).locator('.fx-mobile-button', { hasText: '더보기' }).tap();
        const sheet = explorer(page).locator('.fx-sheet');
        const labels = (await sheet.locator('.fx-sheet-item .fx-sheet-label').allTextContents()).map(text => text.trim());
        expect(labels.indexOf('새 폴더'), `sheet: ${labels.join(', ')}`).toBe(labels.indexOf('새 파일') + 1);
        await sheet.locator('.fx-sheet-item', { hasText: '새 파일' }).tap();
      } else {
        // Empty space below the last row: the shown folder (a file row disables it, as for 새 폴더).
        const rows = explorer(page).locator('.fx-rows').first();
        const box = await rows.boundingBox();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 4, { button: 'right' });
        const labels = (await page.locator('.context-menu .context-menu-item').allTextContents()).map(text => text.trim());
        const at = labels.findIndex(text => text.startsWith('새 파일'));
        expect(at, `menu: ${labels.join(', ')}`).toBeGreaterThanOrEqual(0);
        expect(labels[at + 1]).toMatch(/^새 폴더/);
        await page.locator('.context-menu .context-menu-item', { hasText: '새 파일' }).click();
      }
      await expect(dialog).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('');
      await expect(create).toBeDisabled();
    };

    // AC-4: a name the folder already lists, file or folder.
    await open();
    await input.fill('a.txt');
    await expect(dialog.locator('.fx-new-file-message')).toHaveText("이 폴더에 이미 'a.txt' 파일이 있습니다.");
    await expect(create).toBeDisabled();
    await input.fill('target');
    await expect(dialog.locator('.fx-new-file-message')).toHaveText("이 폴더에 이미 'target' 폴더가 있습니다.");
    // AC-3
    await input.fill('x/y.txt');
    await expect(create).toBeDisabled();
    // AC-5: taken on disk since the listing; the server refuses and nothing is overwritten.
    writeFileSync(joinPath(record.folder!, 'race.txt'), 'race\n');
    await input.fill('race.txt');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(dialog.locator('.fx-new-file-message')).toContainText('그 사이에 같은 이름의 항목이 생겼습니다: race.txt');
    await expect(dialog).toBeVisible();
    expect(readFileSync(joinPath(record.folder!, 'race.txt'), 'utf8')).toBe('race\n');
    // AC-2: Escape cancels.
    await input.press('Escape');
    await expect(dialog).toBeHidden();

    // AC-6: Enter creates, the window closes, the file is selected.
    await open();
    await input.fill('new-note.md');
    if (phone) await create.tap(); else await input.press('Enter');
    await expect(dialog).toBeHidden();
    const made = joinPath(record.folder!, 'new-note.md');
    await expect.poll(() => existsSync(made)).toBe(true);
    expect(statSync(made).size).toBe(0);
    await expect(row(page, 'new-note.md')).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
    await expect(page.locator('.editor-window-host')).toHaveCount(0);
    await page.screenshot({ path: `../.playwright-mcp/e2e-fx-newfile-${phone ? 'phone' : 'desktop'}.png` });
  });
});

// FR-MDE-030 on 2222, desktop: the editor window follows its file on disk. A clean markdown tab
// shows a rewrite, a tab with unsaved edits asks, the HTML viewer renders the new page, a
// deleted file closes its tab (and the window with its last tab) with a notice, and the toggle
// turns all of it off.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
//
// Weak assertions avoided: "the content changed" is read as the new text itself, and the dirty
// case also checks the edit is still there before the user decides.
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

import { test, expect, type Locator, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const explorerRow = (page: Page, name: string) => page.locator(`.window-dialog [data-path$="${name}"]`).first();
const editorWindow = (page: Page) => page.locator('.window-dialog-surface.editor-window-surface:visible');
const panelFor = (page: Page, name: string) => editorWindow(page).locator(`.editor-document-panel[data-document-id$="${name}"]`);
const toggle = (page: Page) => editorWindow(page).locator('button.editor-auto-refresh');

async function openFiles(page: Page, names: string[]): Promise<void> {
  await page.locator('button[aria-label="파일 탐색기"]').first().click();
  await expect(explorerRow(page, names[0])).toBeVisible({ timeout: 15000 });
  const explorer = page.locator('.window-dialog-surface.fx-window:visible');
  for (const name of names) {
    // The editor window opens over the explorer; bring the explorer back to the front first.
    await explorer.locator('.window-dialog-title').first().click();
    await explorerRow(page, name).dblclick();
    await expect(panelFor(page, name)).toBeAttached({ timeout: 15000 });
  }
  await explorer.locator('button[aria-label="닫기"]').first().click();
  await expect(explorer).toHaveCount(0, { timeout: 10000 });
}

async function selectTab(page: Page, name: string): Promise<Locator> {
  await editorWindow(page).locator('.editor-tab-label', { hasText: name }).click();
  const panel = panelFor(page, name);
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('editor auto refresh', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.use.isMobile === true, 'desktop');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(150000);
    record = newOwnedFolder(`editor-auto-refresh/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-ar', {
      'notes.md': '# Notes\n\nfirst version\n',
      'page.html': '<!doctype html><html><body><p id="v">page v1</p></body></html>',
      'other.md': '# Other\n',
    });
    await page.waitForSelector('.terminal-view:visible', { timeout: 30000 });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  test('a rewrite reloads, unsaved edits ask, HTML re-renders, a deletion closes, off does nothing', async ({ page }) => {
    const folder = record.folder!;
    await openFiles(page, ['notes.md', 'page.html', 'other.md']);
    // AC-1: on by default.
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

    // AC-3: a clean markdown tab shows the rewrite.
    let notes = await selectTab(page, 'notes.md');
    await page.waitForTimeout(2500); // the first check takes the baseline
    writeFileSync(joinPath(folder, 'notes.md'), '# Notes\n\nsecond version from an agent\n');
    await expect(notes.locator('.cm-content')).toContainText('second version from an agent', { timeout: 10000 });

    // AC-4: with unsaved edits the file is not read; the bar asks.
    notes = panelFor(page, 'notes.md');
    await notes.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' my edit');
    writeFileSync(joinPath(folder, 'notes.md'), '# Notes\n\nthird version\n');
    const bar = editorWindow(page).locator('.editor-external-bar.is-changed');
    await expect(bar).toBeVisible({ timeout: 10000 });
    await expect(notes.locator('.cm-content')).toContainText('my edit');
    await page.screenshot({ path: '../.playwright-mcp/e2e-editor-auto-refresh-changed.png' });
    await bar.locator('button', { hasText: '다시 불러오기' }).click();
    await expect(panelFor(page, 'notes.md').locator('.cm-content')).toContainText('third version', { timeout: 10000 });
    await expect(panelFor(page, 'notes.md').locator('.cm-content')).not.toContainText('my edit');

    // AC-3: the HTML viewer renders the new page.
    const html = await selectTab(page, 'page.html');
    const frame = html.frameLocator('iframe.html-tab-frame');
    await expect(frame.locator('#v')).toHaveText('page v1', { timeout: 15000 });
    await page.waitForTimeout(2500);
    writeFileSync(joinPath(folder, 'page.html'), '<!doctype html><html><body><p id="v">page v2</p></body></html>');
    await expect(panelFor(page, 'page.html').frameLocator('iframe.html-tab-frame').locator('#v')).toHaveText('page v2', { timeout: 15000 });

    // AC-1: off, a rewrite is not read.
    await selectTab(page, 'other.md');
    await page.waitForTimeout(2500);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    writeFileSync(joinPath(folder, 'other.md'), '# Other\n\nchanged while off\n');
    await page.waitForTimeout(5000);
    await expect(panelFor(page, 'other.md').locator('.cm-content')).not.toContainText('changed while off');
    await toggle(page).click();
    await expect(panelFor(page, 'other.md').locator('.cm-content')).toContainText('changed while off', { timeout: 10000 });

    // AC-5: a deleted clean file closes its tab with a notice.
    rmSync(joinPath(folder, 'other.md'));
    await expect(editorWindow(page).locator('.editor-tab-label', { hasText: 'other.md' })).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.editor-notice')).toContainText('other.md 파일이 디스크에서 삭제되어 탭을 닫았습니다');

    // AC-5: the last tabs go, and the window with them.
    await selectTab(page, 'page.html');
    rmSync(joinPath(folder, 'page.html'));
    await expect(editorWindow(page).locator('.editor-tab-label', { hasText: 'page.html' })).toHaveCount(0, { timeout: 10000 });
    await selectTab(page, 'notes.md');
    rmSync(joinPath(folder, 'notes.md'));
    await expect(editorWindow(page)).toHaveCount(0, { timeout: 10000 });
    expect(existsSync(joinPath(folder, 'notes.md'))).toBe(false);
  });

  test('a deleted file with unsaved edits stays open and can be saved again', async ({ page }) => {
    const folder = record.folder!;
    await openFiles(page, ['notes.md']);
    const notes = await selectTab(page, 'notes.md');
    await page.waitForTimeout(2500);
    await notes.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' kept edit');
    rmSync(joinPath(folder, 'notes.md'));
    // AC-6
    const bar = editorWindow(page).locator('.editor-external-bar.is-deleted');
    await expect(bar).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: '../.playwright-mcp/e2e-editor-auto-refresh-deleted.png' });
    await bar.locator('button', { hasText: '다시 저장' }).click();
    await expect.poll(() => existsSync(joinPath(folder, 'notes.md')), { timeout: 10000 }).toBe(true);
    await expect(bar).toHaveCount(0);
    // The save is the new baseline: nothing more is asked or closed.
    await page.waitForTimeout(4500);
    await expect(editorWindow(page).locator('.editor-external-bar')).toHaveCount(0);
    await expect(panelFor(page, 'notes.md')).toBeVisible();
  });
});

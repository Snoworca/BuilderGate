// FR-MDE-029 (#158), on 2222: a selection within one line of the code editor is visible -- the
// selection layer draws a box there and the active line over it lets it through.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';

import { test, expect } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

test.describe('code editor single-line selection', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.use.isMobile === true, 'opened by double click on a desktop');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`editor-single-line-selection/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-sel', { 'sample.ts': 'const alpha = 1;\nconst beta = 2;\n' });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  test('a selection inside one line is drawn and not covered', async ({ page }) => {
    await page.locator('button[aria-label="파일 탐색기"]').first().click();
    const row = page.locator('.window-dialog [data-path$="sample.ts"]').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.dblclick();
    const line = page.locator('.cm-editor .cm-line', { hasText: 'const alpha' }).first();
    await expect(line).toBeVisible({ timeout: 15000 });
    // Put the cursor at the start of the line and select a word on the same line.
    await line.click({ position: { x: 2, y: 5 } });
    await page.keyboard.press('Home');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowRight');

    const selection = page.locator('.cm-editor .cm-selectionBackground').first();
    await expect(selection).toHaveCount(1);
    const box = await selection.boundingBox();
    expect(box?.width ?? 0, 'the selection box has a width').toBeGreaterThan(5);

    const background = await page.locator('.cm-editor .cm-activeLine').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log(`active line background: ${background}`);
    // Any alpha below 1 lets the selection layer behind it show through.
    const alpha = /rgba?\([^)]*,\s*([\d.]+)\)$/.exec(background)?.[1] ?? /\/\s*([\d.]+)\)$/.exec(background)?.[1] ?? '1';
    expect(Number(alpha), `active line ${background}`).toBeLessThan(1);
    await page.screenshot({ path: '../.playwright-mcp/e2e-editor-single-line-selection.png' });
  });
});

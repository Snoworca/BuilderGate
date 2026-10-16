// FR-FEX-021 (#130), end to end: a file downloads from the file explorer to the device, from the
// context menu on the desktop and from the mobile bar on a phone. The saved bytes and the file
// name are compared with the original.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
//
// Weak assertions avoided: "a download event fired" -- an error page saved as a file would pass.
// The saved bytes are compared with the fixture, and the suggested name with its Korean name.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

// Not .bin: the default config blocks .exe, .dll, .so and .bin, which the download refuses.
const FILE_NAME = '보고서 v2.dat';
// What the server's ASCII filename= fallback holds for FILE_NAME (non-ASCII characters as '_').
const ASCII_FALLBACK_NAME = FILE_NAME.replace(/[^\x20-\x7e]/g, '_');
const BYTES = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31 + 7) & 0xff));

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

async function openExplorer(page: Page, phone: boolean): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(page.locator(`.window-dialog [data-path$="${FILE_NAME}"]`).first()).toBeVisible({ timeout: 15000 });
}

test.describe('file download', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`file-download/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-dl', { [FILE_NAME]: BYTES, 'other.txt': 'other\n' });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-FEX-021 AC-1, AC-3, AC-4
  test('a file downloads byte for byte with its name', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone);
    const row = page.locator(`.window-dialog [data-path$="${FILE_NAME}"]`).first();

    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    if (phone) {
      await row.tap();
      const button = page.locator('.fx-mobile-button', { hasText: '다운로드' });
      await expect(button).toBeEnabled();
      await button.tap();
    } else {
      await row.click({ button: 'right' });
      const item = page.locator('.context-menu .context-menu-item', { hasText: '다운로드' });
      await expect(item).not.toHaveClass(/disabled/);
      await item.click();
    }
    const download = await downloadPromise;
    // The server names the file twice (RFC 6266): filename* in UTF-8 and an ASCII filename. Chromium
    // reads filename*; Playwright's Windows WebKit build reads only the ASCII one. Either is the
    // server's name for this file; anything else is not.
    expect([FILE_NAME, ASCII_FALLBACK_NAME]).toContain(download.suggestedFilename());
    const saved = await download.path();
    expect(saved, 'the browser saved the file').toBeTruthy();
    const bytes = readFileSync(saved!);
    expect(bytes.length).toBe(BYTES.length);
    expect(bytes.equals(BYTES), 'the saved bytes are the file\'s').toBe(true);

    // The token was spent: the same link answers 404.
    expect((await page.request.get(`${ORIGIN}${new URL(download.url()).pathname}`)).status()).toBe(404);
    await page.screenshot({ path: `../.playwright-mcp/e2e-file-download-${phone ? 'phone' : 'desktop'}.png` });
  });
});

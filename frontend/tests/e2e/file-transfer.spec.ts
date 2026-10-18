// #139, end to end: uploads into the file explorer (path bar picker, OS drop on a folder row,
// name clashes, refused extensions), a multi-item ZIP download, and the phone's bottom bar.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
// The spec runs on the server's host (ownedFolderFixture proves it), so what an upload wrote is
// read back from disk with node:fs.
//
// Weak assertions avoided: "a row appeared" -- a row of the right name holding other bytes would
// pass, so the bytes on disk are compared with the source; "a .zip downloaded" -- an error page
// would pass, so the central directory is parsed and one entry inflated and compared.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

const bytesOf = (seed: number, length: number) => Buffer.from(Array.from({ length }, (_, i) => (i * seed + 11) & 0xff));

const ANCHOR = 'anchor.txt';
const SUBDIR = 'inbox';
const PKG = 'pkg';
const EXISTING = { 'exist-a.txt': 'old a\n', 'exist-b.txt': 'old b\n' };
const PKG_FILE = bytesOf(13, 5000);
const FIXTURE: Record<string, Buffer | string> = {
  [ANCHOR]: 'anchor\n',
  [`${SUBDIR}/.keep`]: '',
  ...EXISTING,
  [`${PKG}/a.dat`]: PKG_FILE,
  [`${PKG}/node_modules/dep/index.js`]: 'module.exports = 1;\n',
  'top.txt': 'top\n',
};

function row(page: Page, name: string) {
  return page.locator(`.window-dialog [data-path$="${name}"]`).first();
}

async function openExplorer(page: Page, phone: boolean): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(row(page, ANCHOR)).toBeVisible({ timeout: 15000 });
}

/** Records every text the job status bar shows, so a job that finishes in a blink is still seen. */
async function recordJobTexts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __fxJobTexts: string[] }).__fxJobTexts = seen;
    const read = () => {
      for (const node of document.querySelectorAll('.fx-job-statusbar, .fx-job-item, .fx-upload-band')) {
        const text = node.textContent ?? '';
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      }
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const jobTexts = (page: Page) => page.evaluate(() => (window as unknown as { __fxJobTexts?: string[] }).__fxJobTexts ?? []);

async function pickFiles(page: Page, open: () => Promise<void>, files: { name: string; buffer: Buffer }[]): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  await open();
  const chooser = await chooserPromise;
  expect(chooser.isMultiple(), 'the picker takes several files').toBe(true);
  await chooser.setFiles(files.map(file => ({ name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer })));
}

async function expectOnDisk(path: string, bytes: Buffer): Promise<void> {
  await expect.poll(() => existsSync(path), { timeout: 15000, message: `${path} exists` }).toBe(true);
  await expect.poll(() => readFileSync(path).equals(bytes), { timeout: 10000, message: `${path} holds the uploaded bytes` }).toBe(true);
}

interface ZipEntry { name: string; method: number; compressedSize: number; localOffset: number }

/** The central directory of a (non-ZIP64) archive. */
function zipEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`no end-of-central-directory record in ${zip.length} bytes: ${zip.subarray(0, 64).toString('latin1')}`);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory header at ${at}`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      localOffset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipEntryBytes(zip: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localOffset;
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

test.describe('file transfer', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`file-transfer/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-tx', FIXTURE);
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-FEX-022 AC-1, FR-FEX-024 AC-1, AC-2
  test('desktop: the path bar picker uploads two files byte for byte', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop path bar');
    await openExplorer(page, false);
    await recordJobTexts(page);
    const one = { name: 'up-one.dat', buffer: bytesOf(7, 400_000) };
    const two = { name: '업로드 둘.txt', buffer: Buffer.from('두 번째 파일\n'.repeat(500), 'utf8') };
    await pickFiles(page, () => page.locator('.window-dialog button[aria-label="이 폴더에 업로드"]').first().click(), [one, two]);

    await expect(row(page, one.name)).toBeVisible({ timeout: 15000 });
    await expect(row(page, two.name)).toBeVisible();
    await expectOnDisk(joinPath(record.folder!, one.name), one.buffer);
    await expectOnDisk(joinPath(record.folder!, two.name), two.buffer);
    await expect.poll(() => jobTexts(page), { timeout: 10000, message: 'the job showed in the status bar' })
      .toEqual(expect.arrayContaining([expect.stringMatching(/업로드/)]));
    await expect(page.locator('.window-dialog .fx-toast')).toContainText('2개를');
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-upload-desktop.png' });
  });

  // FR-FEX-022 AC-4, AC-5
  test('desktop: an OS drop on a folder row uploads into that folder', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop drop');
    await openExplorer(page, false);
    const target = row(page, SUBDIR);
    await expect(target).toBeVisible();
    const name = 'dropped.txt';
    const content = 'dropped through a synthetic DataTransfer\n';

    await target.evaluate((element, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.content], file.name, { type: 'text/plain' }));
      (window as unknown as { __fxDrop: DataTransfer }).__fxDrop = transfer;
      const fire = (type: string) => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      fire('dragenter');
      fire('dragover');
    }, { name, content });
    const chip = page.locator('.window-dialog .fx-drop-chip');
    await expect(chip).toHaveClass(/is-shown/);
    await expect(chip).toContainText(`'${SUBDIR}' 폴더에 놓으면 업로드합니다`);
    await expect(target).toHaveClass(/fx-drop-target/);
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-drop-chip.png' });

    await target.evaluate((element) => {
      const transfer = (window as unknown as { __fxDrop: DataTransfer }).__fxDrop;
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(chip).not.toHaveClass(/is-shown/);
    await expectOnDisk(joinPath(record.folder!, SUBDIR, name), Buffer.from(content));
    expect(existsSync(joinPath(record.folder!, name)), 'nothing landed in the shown folder').toBe(false);
  });

  // FR-FOP-006 AC-1, FR-FEX-024
  test('desktop: name clashes ask once with 남은 n개, and 둘 다 유지 keeps both', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop conflict modal');
    await openExplorer(page, false);
    const newA = Buffer.from('new a\n');
    const newB = Buffer.from('new b\n');
    await pickFiles(page, () => page.locator('.window-dialog button[aria-label="이 폴더에 업로드"]').first().click(), [
      { name: 'exist-a.txt', buffer: newA }, { name: 'exist-b.txt', buffer: newB },
    ]);

    const modal = page.locator('.window-dialog .fx-window-modal-box');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('.fx-window-modal-title')).toContainText('이미 있는 항목');
    const buttons = modal.locator('.fx-window-modal-actions button');
    expect((await buttons.allTextContents()).sort()).toEqual(['건너뛰기', '덮어쓰기', '둘 다 유지'].sort());
    const check = modal.locator('.fx-window-modal-check');
    await expect(check).toHaveText('남은 1개에도 같은 선택 적용');
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-conflict.png' });
    await check.locator('input[type="checkbox"]').check();
    await buttons.filter({ hasText: '둘 다 유지' }).click();
    await expect(modal).toBeHidden();

    await expectOnDisk(joinPath(record.folder!, 'exist-a (2).txt'), newA);
    await expectOnDisk(joinPath(record.folder!, 'exist-b (2).txt'), newB);
    expect(readFileSync(joinPath(record.folder!, 'exist-a.txt'), 'utf8'), 'the original stays').toBe(EXISTING['exist-a.txt']);
    expect(readFileSync(joinPath(record.folder!, 'exist-b.txt'), 'utf8'), 'the original stays').toBe(EXISTING['exist-b.txt']);
    await expect(row(page, 'exist-a (2).txt')).toBeVisible({ timeout: 10000 });
  });

  // FR-FEX-024 AC-8
  test('desktop: a blocked extension is listed as refused and not created', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop refusal');
    await openExplorer(page, false);
    const ok = { name: 'fine.txt', buffer: Buffer.from('fine\n') };
    await pickFiles(page, () => page.locator('.window-dialog button[aria-label="이 폴더에 업로드"]').first().click(), [
      { name: 'tool.exe', buffer: Buffer.from('MZ not really\n') }, ok,
    ]);

    const modal = page.locator('.window-dialog .fx-window-modal-box');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('.fx-window-modal-title')).toContainText('처리하지 못한 항목');
    const items = modal.locator('.fx-window-modal-items li');
    await expect(items).toHaveCount(1);
    await expect(items.first().locator('.fx-item-name')).toHaveText('tool.exe');
    await expect(items.first().locator('.fx-item-reason')).not.toBeEmpty();
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-rejected.png' });
    await modal.locator('.fx-window-modal-actions button').first().click();
    await expect(modal).toBeHidden();

    await expectOnDisk(joinPath(record.folder!, ok.name), ok.buffer);
    expect(existsSync(joinPath(record.folder!, 'tool.exe')), 'the refused file is not on disk').toBe(false);
    await expect(row(page, 'tool.exe')).toHaveCount(0);
  });

  // FR-FEX-025 AC-1, AC-4
  test('desktop: a folder and a file download as one ZIP without node_modules', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    await row(page, PKG).click();
    await row(page, 'top.txt').click({ modifiers: ['Control'] });
    await row(page, 'top.txt').click({ button: 'right' });
    const item = page.locator('.context-menu .context-menu-item', { hasText: 'ZIP으로 다운로드 (2개)' });
    await expect(item).toBeVisible();
    await expect(item).not.toHaveClass(/disabled/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await item.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/i);
    const saved = await download.path();
    expect(saved, 'the browser saved the archive').toBeTruthy();
    const zip = readFileSync(saved!);
    const entries = zipEntries(zip);
    const names = entries.map(entry => entry.name);
    expect(names).toEqual(expect.arrayContaining([`${PKG}/a.dat`, 'top.txt']));
    expect(names.filter(name => name.includes('node_modules')), 'node_modules is left out').toEqual([]);
    const packed = entries.find(entry => entry.name === `${PKG}/a.dat`)!;
    expect(zipEntryBytes(zip, packed).equals(PKG_FILE), 'the packed file holds its bytes').toBe(true);
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-zip.png' });
  });

  // FR-FEX-026 AC-1, AC-2, AC-3, AC-5
  test('phone: the bottom bar, the 더보기 sheet, the selection band and an upload', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project), 'phone bar');
    await openExplorer(page, true);
    const bar = page.locator('.window-dialog .fx-mobile-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.fx-mobile-slot-label')).toHaveText(['업로드', '다운로드', '붙여넣기', '더보기']);

    await bar.locator('.fx-mobile-button', { hasText: '더보기' }).tap();
    const sheet = page.locator('.window-dialog .fx-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.fx-sheet-item').last()).toContainText('삭제');
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-phone-sheet.png' });
    await sheet.locator('.fx-sheet-close').tap();
    await expect(sheet).toBeHidden();

    await row(page, 'top.txt').tap();
    const band = page.locator('.window-dialog .fx-selection-band');
    await expect(band).toBeVisible();
    await expect(band.locator('.fx-mobile-band-text')).toHaveText('1개 선택됨');
    await band.locator('.fx-mobile-band-cancel').tap();
    await expect(band).toBeHidden();

    const file = { name: 'from-phone.dat', buffer: bytesOf(29, 200_000) };
    await pickFiles(page, () => bar.locator('.fx-mobile-button', { hasText: '업로드' }).tap(), [file]);
    await expectOnDisk(joinPath(record.folder!, file.name), file.buffer);
    await expect(row(page, file.name)).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-transfer-phone-upload.png' });
  });
});

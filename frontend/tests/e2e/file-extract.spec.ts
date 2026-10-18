// #140, end to end: extracting one archive from the file explorer (FR-FEX-027) through the server
// extract job (FR-FOP-007). The archives are built byte by byte here (a port of
// server/src/testing/archiveFixtures.ts without tar-stream), so they can carry what no
// well-behaved archiver writes: '../' names, a symlink, a CP949 name without the UTF-8 flag.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
// The spec runs on the server's host (ownedFolderFixture proves it), so what the job wrote is
// read back from disk with node:fs.
//
// Weak assertions avoided: "a folder appeared" -- a doubled proj/proj or an empty folder would
// pass, so each extracted file's bytes are compared and the doubled path is asserted absent;
// "the job was submitted" -- the request the page sends is read, so the absolute source plus
// destSessionId combination the server must accept is the one actually exercised.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

const bytesOf = (seed: number, length: number) => Buffer.from(Array.from({ length }, (_, i) => (i * seed + 3) & 0xff));

interface ZipEntry { name: string | Buffer; data?: Buffer; utf8Flag?: boolean; unixMode?: number }

/** A ZIP whose central directory says "made by Unix", so mode bits (a symlink) count. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const body = deflateRawSync(data);
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const flags = typeof entry.name === 'string' && entry.utf8Flag !== false ? 0x800 : 0;
    const crc = crc32(data);
    const date = ((2024 - 1980) << 9) | (5 << 5) | 6;
    const time = (7 << 11) | (8 << 5) | 5;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 30, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

/** A gzip-compressed ustar archive of regular files (names under 100 bytes). */
function buildTarGz(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write(`${Math.floor(Date.UTC(2024, 4, 6) / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header.write('0', 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const rest = entry.data.length % 512;
    parts.push(header, entry.data, Buffer.alloc(rest === 0 ? 0 : 512 - rest));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const PROJ_A = bytesOf(17, 70_000);
const PROJ_B = Buffer.from('nested b\n');
const BUNDLE_X = bytesOf(5, 9_000);
const BUNDLE_Z = Buffer.from('z in y\n');
const HERE_OLD = 'old content\n';
const HERE_NEW = Buffer.from('new content from the archive\n');
const HERE_FRESH = Buffer.from('fresh from the archive\n');
const SAFE = Buffer.from('safe\n');
const HANGUL = Buffer.from('한글 내용\n', 'utf8');
// '한글.txt' in CP949 (한 = C7 D1, 글 = B1 DB), written without the UTF-8 flag.
const HANGUL_CP949_NAME = Buffer.concat([Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('.txt', 'ascii')]);
const EVIL_NAME = 'evil-140-escape.txt';

const ANCHOR = 'anchor.txt';
const FIXTURE: Record<string, Buffer | string> = {
  [ANCHOR]: 'anchor\n',
  'plain.txt': 'not an archive\n',
  'proj.zip': buildZip([
    { name: 'proj/' },
    { name: 'proj/a.dat', data: PROJ_A },
    { name: 'proj/sub/b.txt', data: PROJ_B },
  ]),
  'bundle.tar.gz': buildTarGz([{ name: 'x.dat', data: BUNDLE_X }, { name: 'y/z.txt', data: BUNDLE_Z }]),
  // The folder 'bundle' already exists, so 압축 풀기 makes 'bundle (2)'.
  'bundle/keep.txt': 'existing bundle\n',
  'here.zip': buildZip([{ name: 'clash.txt', data: HERE_NEW }, { name: 'fresh.txt', data: HERE_FRESH }]),
  'clash.txt': HERE_OLD,
  'evil.zip': buildZip([
    { name: `../${EVIL_NAME}`, data: Buffer.from('escaped\n') },
    { name: `../../${EVIL_NAME}`, data: Buffer.from('escaped twice\n') },
    { name: 'link-out', data: Buffer.from('../../outside-target'), unixMode: 0o120777 },
    { name: 'safe.txt', data: SAFE },
  ]),
  'cp.zip': buildZip([{ name: HANGUL_CP949_NAME, data: HANGUL }]),
};

function row(page: Page, name: string) {
  return page.locator(`.window-dialog [data-path$="${name}"]`).first();
}

async function openExplorer(page: Page, phone: boolean): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(row(page, ANCHOR)).toBeVisible({ timeout: 15000 });
}

function menuItem(page: Page, label: string) {
  return page.locator('.context-menu .context-menu-item').filter({ hasText: new RegExp(`^\\s*${label}`) });
}

async function extractFromMenu(page: Page, archive: string, label: '압축 풀기' | '여기에 풀기'): Promise<Record<string, unknown>> {
  await row(page, archive).click({ button: 'right' });
  const item = menuItem(page, label);
  await expect(item).toHaveCount(1);
  await expect(item).not.toHaveClass(/disabled/);
  const requestPromise = page.waitForRequest(request =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/file-jobs', { timeout: 15000 });
  await item.click();
  return (await requestPromise).postDataJSON() as Record<string, unknown>;
}

async function expectOnDisk(path: string, bytes: Buffer): Promise<void> {
  await expect.poll(() => existsSync(path), { timeout: 20000, message: `${path} exists` }).toBe(true);
  await expect.poll(() => readFileSync(path).equals(bytes), { timeout: 10000, message: `${path} holds the archive's bytes` }).toBe(true);
}

const trimmed = (path: string) => path.replace(/[\\/]+$/, '');

test.describe('file extract', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`file-extract/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-ex', FIXTURE);
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-FEX-027 AC-2, AC-6, FR-FOP-007; contract §4.2 (absolute source + destSessionId)
  test('desktop: 압축 풀기 on a single-top-folder zip makes that folder without nesting', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    const body = await extractFromMenu(page, 'proj.zip', '압축 풀기');
    const folder = record.folder!;
    expect(body).toMatchObject({ operation: 'extract', mode: 'smart', sourceSessionId: record.workSessionId, destSessionId: record.workSessionId });
    expect(body.sources, 'one absolute source').toEqual([joinPath(folder, 'proj.zip')]);
    expect(trimmed(String(body.destPath)), 'the archive\'s folder, absolute').toBe(trimmed(folder));

    await expectOnDisk(joinPath(folder, 'proj', 'a.dat'), PROJ_A);
    await expectOnDisk(joinPath(folder, 'proj', 'sub', 'b.txt'), PROJ_B);
    expect(existsSync(joinPath(folder, 'proj', 'proj')), 'no doubled nesting').toBe(false);
    await expect(page.locator('.window-dialog .fx-toast')).toContainText('풀었습니다');
    await expect(row(page, 'proj')).toBeVisible();
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-extract-smart.png' });
  });

  // FR-FEX-027 AC-2
  test('desktop: 압축 풀기 on a loose tar.gz makes a named folder, (2) when the name is taken', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    await extractFromMenu(page, 'bundle.tar.gz', '압축 풀기');
    const folder = record.folder!;
    await expectOnDisk(joinPath(folder, 'bundle (2)', 'x.dat'), BUNDLE_X);
    await expectOnDisk(joinPath(folder, 'bundle (2)', 'y', 'z.txt'), BUNDLE_Z);
    expect(readFileSync(joinPath(folder, 'bundle', 'keep.txt'), 'utf8'), 'the existing folder is unchanged').toBe('existing bundle\n');
    expect(existsSync(joinPath(folder, 'bundle', 'x.dat')), 'nothing written into the existing folder').toBe(false);
    await expect(row(page, 'bundle (2)')).toBeVisible({ timeout: 10000 });
  });

  // FR-FEX-027 AC-3, FR-FOP-006
  test('desktop: 여기에 풀기 asks on a clash, and 건너뛰기 keeps the existing file', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    const body = await extractFromMenu(page, 'here.zip', '여기에 풀기');
    expect(body).toMatchObject({ operation: 'extract', mode: 'here', destSessionId: record.workSessionId });

    const modal = page.locator('.window-dialog .fx-window-modal-box');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(modal.locator('.fx-window-modal-title')).toContainText('이미 있는 항목');
    await expect(modal.locator('.fx-window-modal-message')).toContainText('clash.txt');
    const buttons = modal.locator('.fx-window-modal-actions button');
    expect((await buttons.allTextContents()).sort()).toEqual(['건너뛰기', '덮어쓰기', '둘 다 유지'].sort());
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-extract-here-conflict.png' });
    await buttons.filter({ hasText: '건너뛰기' }).click();
    await expect(modal).toBeHidden();

    const folder = record.folder!;
    await expectOnDisk(joinPath(folder, 'fresh.txt'), HERE_FRESH);
    expect(readFileSync(joinPath(folder, 'clash.txt'), 'utf8'), 'the skipped file keeps its content').toBe(HERE_OLD);
    expect(existsSync(joinPath(folder, 'clash (2).txt')), 'skip made no copy').toBe(false);
  });

  // FR-FOP-007 (entry path safety), FR-FEX-027 AC-6
  test('desktop: ../ and symlink entries are listed as not processed and nothing leaves the folder', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    const folder = record.folder!;
    const parent = folder.replace(/[\\/][^\\/]+[\\/]*$/, '');
    const grandparent = parent.replace(/[\\/][^\\/]+[\\/]*$/, '');
    const watched = [joinPath(folder, EVIL_NAME), joinPath(parent, EVIL_NAME), joinPath(grandparent, EVIL_NAME)];
    for (const path of watched) expect(existsSync(path), `${path} is absent before`).toBe(false);

    await openExplorer(page, false);
    await extractFromMenu(page, 'evil.zip', '압축 풀기');
    const modal = page.locator('.window-dialog .fx-window-modal-box');
    await expect(modal).toBeVisible({ timeout: 20000 });
    await expect(modal.locator('.fx-window-modal-title')).toContainText('처리하지 못한 항목');
    const names = await modal.locator('.fx-window-modal-items .fx-item-name').allTextContents();
    expect(names).toEqual(expect.arrayContaining([`../${EVIL_NAME}`, `../../${EVIL_NAME}`, 'link-out']));
    const reasons = await modal.locator('.fx-window-modal-items .fx-item-reason').allTextContents();
    expect(reasons.every(reason => reason.trim().length > 0), 'each refused entry has a reason').toBe(true);
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-extract-unsafe.png' });
    await modal.locator('.fx-window-modal-actions button').first().click();
    await expect(modal).toBeHidden();

    await expectOnDisk(joinPath(folder, 'evil', 'safe.txt'), SAFE);
    for (const path of watched) expect(existsSync(path), `${path} was not written`).toBe(false);
    expect(existsSync(joinPath(folder, 'evil', 'link-out')), 'the symlink entry was not made').toBe(false);
  });

  // FR-FOP-007 (entry name decoding)
  test('desktop: a CP949 name without the UTF-8 flag extracts as Hangul', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    await extractFromMenu(page, 'cp.zip', '압축 풀기');
    await expectOnDisk(joinPath(record.folder!, 'cp', '한글.txt'), HANGUL);
  });

  // FR-FEX-027 AC-1
  test('desktop: both entries are disabled on a file that is not an archive', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop context menu');
    await openExplorer(page, false);
    await row(page, 'plain.txt').click({ button: 'right' });
    for (const label of ['압축 풀기', '여기에 풀기']) {
      const item = menuItem(page, label);
      await expect(item).toHaveCount(1);
      await expect(item).toHaveClass(/disabled/);
    }
    await page.keyboard.press('Escape');
    await row(page, 'proj.zip').click({ button: 'right' });
    for (const label of ['압축 풀기', '여기에 풀기']) await expect(menuItem(page, label)).not.toHaveClass(/disabled/);
  });

  // FR-FEX-027 AC-1 (mobile 더보기 sheet)
  test('phone: the 더보기 sheet holds both entries, enabled for one selected zip', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project), 'phone sheet');
    await openExplorer(page, true);
    const bar = page.locator('.window-dialog .fx-mobile-bar');
    const sheet = page.locator('.window-dialog .fx-sheet');
    const sheetItem = (label: string) => sheet.locator('.fx-sheet-item').filter({ hasText: new RegExp(`^\\s*${label}`) });

    await bar.locator('.fx-mobile-button', { hasText: '더보기' }).tap();
    await expect(sheet).toBeVisible();
    const labels = (await sheet.locator('.fx-sheet-item .fx-sheet-label').allTextContents()).map(text => text.trim());
    const extractAt = labels.findIndex(text => text.startsWith('압축 풀기'));
    const hereAt = labels.findIndex(text => text.startsWith('여기에 풀기'));
    expect(extractAt, '압축 풀기 is in the sheet').toBeGreaterThanOrEqual(0);
    expect(hereAt, '여기에 풀기 follows 압축 풀기').toBe(extractAt + 1);
    await expect(sheetItem('압축 풀기')).toBeDisabled();
    await sheet.locator('.fx-sheet-close').tap();
    await expect(sheet).toBeHidden();

    await row(page, 'proj.zip').tap();
    await expect(page.locator('.window-dialog .fx-selection-band .fx-mobile-band-text')).toHaveText('1개 선택됨');
    await bar.locator('.fx-mobile-button', { hasText: '더보기' }).tap();
    await expect(sheet).toBeVisible();
    await expect(sheetItem('압축 풀기')).toBeEnabled();
    await expect(sheetItem('여기에 풀기')).toBeEnabled();
    await page.screenshot({ path: '../.playwright-mcp/e2e-file-extract-phone-sheet.png' });
    await expect(bar.locator('.fx-mobile-slot-label')).toHaveText(['업로드', '다운로드', '붙여넣기', '더보기']);
  });
});

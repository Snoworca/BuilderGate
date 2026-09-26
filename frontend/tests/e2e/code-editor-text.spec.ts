// Text and code editing in the editor window, end to end (T-PH008-01):
// line endings and BOM survive a one-character edit byte for byte, a non-UTF-8
// file opens read-only and is never written, a UTF-16 file is refused as
// binary, a code file gets the code editor (gutters, no markdown preview, a
// wrap toggle that outlives a reload), dirty/save/close behave as for markdown,
// JSON is linted and CSV columns are coloured, and an .exe row cannot be opened.
//
// Runs only against the verified external runtime on https://localhost:2222 and
// needs BUILDERGATE_PASSWORD. Before running: no other `playwright test` process
// may be alive on the host.
//
// Fixture shape, per test (the file-explorer specs' shape):
//   * one workspace created through createOwnedWorkspaceViaApi under an owner id
//     this spec makes, removed only through cleanupOwnedWorkspaces for that owner;
//   * a "base" tab whose session cwd is where the test folder is created;
//   * a test folder `bg-cet-e2e-<random>` made over the file API, filled with
//     raw bytes through node:fs (the file API only writes UTF-8 strings, and
//     these fixtures are about the bytes), and removed by its exact absolute
//     path through the base session;
//   * a "work" tab whose cwd is the test folder, so the explorer opens on it.
//   node:fs reaches the folder because Playwright runs on the same host as the
//   server; the path it uses is the one the server reported.
//
// Weak assertions avoided on purpose (what would satisfy them cheaply):
//   * "the saved file contains the typed character" -- a save that rewrote every
//     line ending to LF would pass. The byte cases compare the whole file with
//     the original plus exactly one inserted byte.
//   * "the label says CRLF" -- a label nailed to CRLF would pass. The label case
//     opens an LF file in the same window as the control.
//   * "no write after Ctrl+S" on the non-UTF-8 file -- a shortcut that never
//     reached the editor would pass. The body is also checked unchanged after
//     typing, the save button is pressed too, and the notice has to be on screen.
//   * "the wrap toggle flipped" -- a toggle that only changes its own label would
//     pass. The editor content's line-wrapping class is read alongside, and the
//     state is read again after a reload.
//   * "no close prompt after save" -- a close that never asks would pass. The
//     control half closes an unsaved document and requires the prompt.
//   * "an .exe double click opened nothing" -- a double click that never lands
//     would pass. An openable file is double-clicked after it as the control.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  test, expect, createOwnedWorkspaceViaApi,
  type APIRequestContext, type Locator, type Page,
} from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const TAB_NAME_PREFIX = 'e2e-cet';
const SCREENSHOT_DIR = '../.playwright-mcp';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** "한글" in CP949 -- not valid UTF-8. */
const CP949_HANGUL = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);

/** Every fixture file, as the raw bytes written to disk. No name is a suffix of
 * another: panels are found by the tail of their path. */
const FIXTURES: Record<string, Buffer> = {
  'crlf.txt': Buffer.from('alpha\r\nbeta\r\ngamma\r\n', 'utf-8'),
  'unix.txt': Buffer.from('alpha\nbeta\ngamma\n', 'utf-8'),
  'mixed.txt': Buffer.concat([BOM, Buffer.from('one\r\ntwo\r\nthree\nfour\r\nfive\r\n', 'utf-8')]),
  'legacy.txt': Buffer.concat([
    Buffer.from('abc\r\n', 'utf-8'), CP949_HANGUL, Buffer.from('\r\nend\r\n', 'utf-8'),
  ]),
  'wide.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello wide world\r\nsecond line\r\n', 'utf16le')]),
  'sample.ts': Buffer.from([
    '// # Not A Heading **not bold** [not a link](x)',
    'export function add(a: number, b: number): number {',
    '  const total = a + b;',
    '  return total;',
    '}',
    `export const long = '${'wrap me '.repeat(40)}';`,
    '',
  ].join('\n'), 'utf-8'),
  'app.ts': Buffer.from('export const value = 1;\n', 'utf-8'),
  'bad.json': Buffer.from('{\n  "a": 1,\n  "b": ,\n  "c": 3\n}\n', 'utf-8'),
  'data.csv': Buffer.from('name,age,city\nann,30,seoul\nbob,41,busan\n', 'utf-8'),
  'tool.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
  'notes.md': Buffer.from('# Notes\n\nplain paragraph\n', 'utf-8'),
};

interface ListingEntry { name: string; type: 'file' | 'directory' }
interface WorkspaceState {
  workspaces: Array<{ id: string; name: string; activeTabId: string | null }>;
  tabs: Array<{ id: string; workspaceId: string; sessionId: string; name: string }>;
}

interface FixtureRecord {
  token: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  baseSessionId: string | null;
  folder: string | null;
  sessionId: string | null;
  workTabName: string | null;
  root: string | null;
}

interface WriteRecord { path: string; content: string }

function registryOptions(): RegistryOptions {
  return {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '',
    baseUrl: ORIGIN,
  };
}

function separatorOf(path: string): string {
  return /^[A-Za-z]:/.test(path) || path.includes('\\') ? '\\' : '/';
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}${separatorOf(base)}${name}`;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readState(request: APIRequestContext, token: string): Promise<WorkspaceState> {
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  expect(response.status(), 'workspace list').toBe(200);
  return await response.json() as WorkspaceState;
}

async function addTab(
  request: APIRequestContext, token: string, workspaceId: string, name: string, cwd?: string,
): Promise<{ tabId: string; sessionId: string }> {
  const response = await request.post(`${ORIGIN}/api/workspaces/${workspaceId}/tabs`, {
    headers: authHeaders(token),
    data: cwd === undefined ? { name } : { name, cwd },
  });
  expect(response.status(), `tab create ${name}`).toBe(201);
  const tab = await response.json() as { id: string };
  const state = await readState(request, token);
  const found = state.tabs.find(item => item.id === tab.id);
  if (!found?.sessionId) throw new Error(`tab ${tab.id} has no session in the workspace list`);
  return { tabId: tab.id, sessionId: found.sessionId };
}

async function sessionCwd(request: APIRequestContext, token: string, sessionId: string): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/sessions/${sessionId}/cwd`, { headers: authHeaders(token) });
  expect(response.status(), 'session cwd').toBe(200);
  const body = await response.json() as { cwd: string };
  if (!body.cwd) throw new Error(`session ${sessionId} reported an empty cwd`);
  return body.cwd;
}

async function makeDirectory(
  request: APIRequestContext, token: string, sessionId: string, parent: string, name: string,
): Promise<void> {
  const response = await request.post(`${ORIGIN}/api/sessions/${sessionId}/files/mkdir`, {
    headers: authHeaders(token), data: { path: parent, name },
  });
  expect(response.status(), `mkdir ${name}`).toBe(200);
}

async function listDirectory(
  request: APIRequestContext, token: string, sessionId: string, path: string,
): Promise<ListingEntry[]> {
  const response = await request.get(
    `${ORIGIN}/api/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`,
    { headers: authHeaders(token) },
  );
  expect(response.status(), `list ${path}`).toBe(200);
  const body = await response.json() as { entries: ListingEntry[] };
  return body.entries.filter(entry => entry.name !== '..');
}

async function ensureTabMode(page: Page): Promise<void> {
  const toTabs = page.locator('button[title="탭 보기로 전환"]');
  if (await toTabs.count()) await toTabs.click();
  await expect(page.locator('button[title="그리드 보기로 전환"]')).toBeVisible({ timeout: 15000 });
}

async function selectWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar [role="option"]', { hasText: name }).first().click();
  await expect(page.locator('.sidebar [role="option"][aria-selected="true"]', { hasText: name }))
    .toBeVisible({ timeout: 15000 });
}

async function selectTab(page: Page, name: string): Promise<void> {
  const tab = page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Brings the page back to the fixture's work tab, after login or a reload. */
async function showWorkTab(page: Page, record: FixtureRecord): Promise<void> {
  await page.waitForSelector('.workspace-screen', { timeout: 15000 });
  await selectWorkspace(page, record.workspaceName!);
  await ensureTabMode(page);
  await selectTab(page, record.workTabName!);
  await waitForTerminal(page);
}

async function setUpFixture(
  page: Page, request: APIRequestContext, ownerId: string, record: FixtureRecord,
): Promise<void> {
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token in localStorage');
  record.token = token;

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `${TAB_NAME_PREFIX}-${suffix}`;
  const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
    headers: authHeaders(token), data: { name: workspaceName },
  });
  record.workspaceId = workspace.id;
  record.workspaceName = workspaceName;

  const base = await addTab(request, token, workspace.id, `${TAB_NAME_PREFIX}-base`);
  record.baseSessionId = base.sessionId;
  const baseCwd = await sessionCwd(request, token, base.sessionId);

  const folderName = `bg-cet-e2e-${suffix}`;
  await makeDirectory(request, token, base.sessionId, baseCwd, folderName);
  const folder = joinPath(baseCwd, folderName);
  record.folder = folder;

  for (const [name, bytes] of Object.entries(FIXTURES)) {
    writeFileSync(joinPath(folder, name), bytes);
  }
  // The server sees what node:fs wrote -- otherwise this spec is not running on
  // the server's host and every byte comparison below would be meaningless.
  const listed = (await listDirectory(request, token, base.sessionId, folder)).map(entry => entry.name).sort();
  expect(listed, 'fixture files are visible to the server').toEqual(Object.keys(FIXTURES).sort());

  const workTabName = `${TAB_NAME_PREFIX}-work`;
  const work = await addTab(request, token, workspace.id, workTabName, folder);
  record.sessionId = work.sessionId;
  record.workTabName = workTabName;
  record.root = await sessionCwd(request, token, work.sessionId);
  expect(record.root.replace(/[\\/]+$/, '').endsWith(folderName), 'work tab starts in the test folder').toBe(true);

  await page.reload();
  await showWorkTab(page, record);
}

async function tearDownFixture(
  request: APIRequestContext, ownerId: string, record: FixtureRecord, apiCreationStarted: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  // The work tab's shell sits in the test folder, and Windows refuses to remove
  // a directory a live process has as its cwd. Only this workspace's tabs.
  if (record.token && record.workspaceId && record.baseSessionId) {
    try {
      const state = await readState(request, record.token);
      const doomed = state.tabs.filter(tab =>
        tab.workspaceId === record.workspaceId && tab.sessionId !== record.baseSessionId);
      for (const tab of doomed) {
        const response = await request.delete(
          `${ORIGIN}/api/workspaces/${record.workspaceId}/tabs/${tab.id}`,
          { headers: authHeaders(record.token) },
        );
        if (response.status() !== 200) throw new Error(`owned tab ${tab.id} delete returned ${response.status()}`);
      }
    } catch (error) { failures.push(error); }
  }
  // Exact absolute path only, never a pattern; retried while the closed tab's
  // shell exits.
  if (record.token && record.baseSessionId && record.folder) {
    try {
      const statuses: number[] = [];
      const deadline = Date.now() + 20000;
      for (;;) {
        const response = await request.delete(
          `${ORIGIN}/api/sessions/${record.baseSessionId}/files?path=${encodeURIComponent(record.folder)}`,
          { headers: authHeaders(record.token) },
        );
        statuses.push(response.status());
        if (response.status() === 200) break;
        if (Date.now() > deadline) {
          throw new Error(`test folder delete of ${record.folder} kept failing: ${statuses.join(',')} ${await response.text()}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) { failures.push(error); }
  }
  if (apiCreationStarted) {
    try {
      const result = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (result.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(result.failed)}`);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'code editor text fixture teardown failed');
}

// ---------------------------------------------------------------------------
// Locators and actions
// ---------------------------------------------------------------------------

function recordWrites(page: Page): WriteRecord[] {
  const writes: WriteRecord[] = [];
  page.on('request', (request) => {
    if (!request.url().includes('/files/write')) return;
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { path?: string; content?: string };
      writes.push({ path: body.path ?? '', content: body.content ?? '' });
    } catch {
      writes.push({ path: '', content: '' });
    }
  });
  return writes;
}

function explorerWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.fx-window:visible');
}

function activePanel(page: Page): Locator {
  return explorerWindow(page).locator('.fx-tab-panel[role="tabpanel"]:not(.fx-inactive)');
}

function rowNamed(page: Page, name: string): Locator {
  return activePanel(page).locator(`.fx-row[data-name="${name}"]`);
}

function editorWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface:visible');
}

function panelFor(page: Page, fileName: string): Locator {
  return editorWindow(page).locator(`.editor-document-panel[data-document-id$="${fileName}"]`);
}

function contentOf(page: Page, fileName: string): Locator {
  return panelFor(page, fileName).locator('.cm-content');
}

async function openExplorer(page: Page, root: string): Promise<void> {
  if (await explorerWindow(page).count() === 0) {
    await page.locator('button.header-action-button[aria-label="파일 탐색기"]').click();
  }
  await expect(explorerWindow(page)).toHaveCount(1, { timeout: 15000 });
  await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', root, { timeout: 15000 });
  await expect(rowNamed(page, 'crlf.txt')).toBeVisible({ timeout: 15000 });
}

async function closeExplorer(page: Page): Promise<void> {
  if (await explorerWindow(page).count() === 0) return;
  await explorerWindow(page).locator('button[aria-label="닫기"]').first().click();
  await expect(explorerWindow(page)).toHaveCount(0, { timeout: 10000 });
}

/**
 * Opens a file by double-clicking its explorer row, then closes the explorer so
 * its window cannot sit over the editor and swallow the clicks that follow.
 */
async function openFile(page: Page, record: FixtureRecord, fileName: string): Promise<void> {
  await openExplorer(page, record.root!);
  await rowNamed(page, fileName).dblclick();
  await expect(panelFor(page, fileName)).toHaveCount(1, { timeout: 15000 });
  await expect(contentOf(page, fileName)).toBeVisible({ timeout: 15000 });
  await closeExplorer(page);
}

async function clickStartOf(page: Page, fileName: string): Promise<void> {
  await contentOf(page, fileName).click();
  await page.keyboard.press('Control+Home');
}

async function saveWithShortcut(page: Page, fileName: string): Promise<void> {
  await contentOf(page, fileName).click();
  await page.keyboard.press('Control+s');
}

function diskBytes(record: FixtureRecord, fileName: string): Buffer {
  return readFileSync(joinPath(record.folder!, fileName));
}

/** The bytes as a readable escape string, so a failing diff names the byte. */
function show(bytes: Buffer): string {
  return JSON.stringify(bytes.toString('latin1'));
}

async function computedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let current: Element | null = element;
    let opacity = 1;
    while (current) {
      opacity *= Number(getComputedStyle(current).opacity);
      current = current.parentElement;
    }
    return opacity;
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/code-editor-text-${name}.png` });
}

// ---------------------------------------------------------------------------

test.describe('code editor: text and code editing', () => {
  let record: FixtureRecord;
  let ownerId: string;
  let apiCreationStarted = false;
  let writes: WriteRecord[];

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(180000);
    record = {
      token: null, workspaceId: null, workspaceName: null, baseSessionId: null,
      folder: null, sessionId: null, workTabName: null, root: null,
    };
    ownerId = `code-editor-text/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    apiCreationStarted = true;
    await setUpFixture(page, request, ownerId, record);
    writes = recordWrites(page);
  });

  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await tearDownFixture(request, ownerId, record, apiCreationStarted);
    apiCreationStarted = false;
  });

  // TC-REQ-FR-MDE-015-AC1-81
  test('CRLF 파일 한 글자 수정·Ctrl+S 뒤 디스크 바이트 diff 가 그 글자뿐(소유 fixture 경로)', async ({ page }) => {
    const before = diskBytes(record, 'crlf.txt');
    await openFile(page, record, 'crlf.txt');
    await clickStartOf(page, 'crlf.txt');
    await page.keyboard.type('X');
    await expect(contentOf(page, 'crlf.txt')).toContainText('Xalpha');
    await saveWithShortcut(page, 'crlf.txt');

    await expect.poll(() => writes.length, { timeout: 10000 }).toBe(1);
    const expected = Buffer.concat([Buffer.from('X'), before]);
    await expect.poll(() => show(diskBytes(record, 'crlf.txt')), { timeout: 10000 }).toBe(show(expected));
    await screenshot(page, 'crlf-saved');
  });

  // TC-REQ-FR-MDE-015-AC3-82
  test('BOM + CRLF 다수·LF 소수 섞인 파일 한 글자 수정·저장 뒤 디스크 바이트가 BOM·소수 LF 를 포함해 그 글자 외 동일', async ({ page }) => {
    const before = diskBytes(record, 'mixed.txt');
    await openFile(page, record, 'mixed.txt');
    // The BOM is not part of the text: the document starts at "one".
    await expect(contentOf(page, 'mixed.txt').locator('.cm-line').first()).toHaveText('one');
    await clickStartOf(page, 'mixed.txt');
    await page.keyboard.type('X');
    await expect(contentOf(page, 'mixed.txt')).toContainText('Xone');
    await saveWithShortcut(page, 'mixed.txt');

    await expect.poll(() => writes.length, { timeout: 10000 }).toBe(1);
    const expected = Buffer.concat([BOM, Buffer.from('X'), before.subarray(BOM.length)]);
    await expect.poll(() => show(diskBytes(record, 'mixed.txt')), { timeout: 10000 }).toBe(show(expected));
    await expect(panelFor(page, 'mixed.txt').locator('.editor-document-status')).toHaveText('CRLF');
  });

  // TC-REQ-FR-MDE-015-AC6-81
  test('창에 CRLF/LF 표시가 보인다', async ({ page }) => {
    await openFile(page, record, 'crlf.txt');
    await expect(panelFor(page, 'crlf.txt').locator('.editor-document-status')).toHaveText('CRLF');
    await expect(panelFor(page, 'crlf.txt').locator('.editor-document-status')).toBeVisible();
    // Control: an LF file in the same window says LF, so the label is read from
    // the file and not fixed.
    await openFile(page, record, 'unix.txt');
    await expect(panelFor(page, 'unix.txt').locator('.editor-document-status')).toHaveText('LF');
    await expect(panelFor(page, 'unix.txt').locator('.editor-document-status')).toBeVisible();
    await screenshot(page, 'line-ending-label');
  });

  // TC-REQ-FR-MDE-016-AC1-81
  test('CP949 fixture: 입력해도 본문 불변, Ctrl+S·저장 버튼 뒤 write 요청 0, 읽기 전용 안내 표시', async ({ page }) => {
    const before = diskBytes(record, 'legacy.txt');
    await openFile(page, record, 'legacy.txt');
    const notice = panelFor(page, 'legacy.txt').locator('.editor-document-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('읽기 전용');

    const bodyBefore = await contentOf(page, 'legacy.txt').innerText();
    expect(bodyBefore).toContain('abc');
    await clickStartOf(page, 'legacy.txt');
    await page.keyboard.type('zzz');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Delete');
    await expect(contentOf(page, 'legacy.txt')).not.toContainText('zzz');
    expect(await contentOf(page, 'legacy.txt').innerText()).toBe(bodyBefore);

    await saveWithShortcut(page, 'legacy.txt');
    await editorWindow(page).locator('button[aria-label="저장"]').click();
    await page.waitForTimeout(1000);
    expect(writes, 'no write request for a non-UTF-8 file').toEqual([]);
    expect(show(diskBytes(record, 'legacy.txt'))).toBe(show(before));
    await screenshot(page, 'cp949-read-only');
  });

  // TC-REQ-FR-MDE-016-AC5-81
  test('UTF-16 fixture 더블클릭은 지금의 바이너리 거절 안내', async ({ page }) => {
    await openExplorer(page, record.root!);
    await rowNamed(page, 'wide.txt').dblclick();
    const message = page.locator('.message-box-message', { hasText: /binary/i });
    await expect(message).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('파일을 열지 못했습니다', { exact: true })).toBeVisible();
    await expect(page.locator('.editor-document-panel[data-document-id$="wide.txt"]')).toHaveCount(0);
    await screenshot(page, 'utf16-refused');
  });

  // TC-REQ-FR-MDE-014-AC1-81
  test('.ts 파일: 줄 번호·접기 gutter 보임, 마크다운 프리뷰 없음, 줄바꿈 토글이 새로고침 뒤 유지', async ({ page }) => {
    await openFile(page, record, 'sample.ts');
    const panel = panelFor(page, 'sample.ts');
    await expect(panel.locator('.editor-window-host')).toHaveAttribute('data-editor-mode', 'code');
    await expect(panel.locator('.cm-lineNumbers')).toBeVisible();
    await expect(panel.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^3$/ })).toBeVisible();
    await expect(panel.locator('.cm-foldGutter')).toBeVisible();
    // The comment carries heading, bold and link syntax; the markdown editor
    // would dress each of them in a cm-atomic-* decoration.
    await expect(contentOf(page, 'sample.ts')).toContainText('# Not A Heading **not bold**');
    expect(await panel.locator('[class*="cm-atomic-"]').count()).toBe(0);

    const toggle = panel.locator('.editor-code-wrap-toggle');
    const initial = await toggle.getAttribute('aria-pressed');
    expect(initial === 'true' || initial === 'false').toBe(true);
    const flipped = initial === 'true' ? 'false' : 'true';
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', flipped);
    const wrapping = contentOf(page, 'sample.ts');
    if (flipped === 'true') await expect(wrapping).toHaveClass(/cm-lineWrapping/);
    else await expect(wrapping).not.toHaveClass(/cm-lineWrapping/);
    await screenshot(page, 'ts-code-mode');

    await page.reload();
    await showWorkTab(page, record);
    if (await panelFor(page, 'sample.ts').count() === 0) await openFile(page, record, 'sample.ts');
    const toggleAfter = panelFor(page, 'sample.ts').locator('.editor-code-wrap-toggle');
    await expect(toggleAfter).toHaveAttribute('aria-pressed', flipped, { timeout: 15000 });
    if (flipped === 'true') await expect(contentOf(page, 'sample.ts')).toHaveClass(/cm-lineWrapping/);
    else await expect(contentOf(page, 'sample.ts')).not.toHaveClass(/cm-lineWrapping/);
  });

  // TC-REQ-FR-MDE-020-AC1-81
  test('코드 파일 도구줄: 경로·주간/야간·줄바꿈 아이콘, 전체 폭, 테마가 새로고침 뒤 유지, 경로 복사', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await openFile(page, record, 'sample.ts');
    const panel = panelFor(page, 'sample.ts');
    const toolbar = panel.locator('.editor-document-toolbar');
    const fullPath = await panel.getAttribute('data-document-id');
    expect(fullPath).toBeTruthy();

    // AC-6: the absolute path is on the left, whole or as ...<sep>name, with the full path as tooltip.
    const pathButton = toolbar.locator('.editor-document-path');
    await expect(pathButton).toHaveAttribute('title', fullPath!);
    const shown = (await pathButton.textContent()) ?? '';
    expect(shown === fullPath || /^\.\.\.[\\/]sample\.ts$/.test(shown)).toBe(true);

    // AC-2 / AC-3: icon toggles, theme left of wrap, no text label.
    const themeToggle = toolbar.locator('.editor-theme-toggle');
    const wrapToggle = toolbar.locator('.editor-code-wrap-toggle');
    await expect(themeToggle.locator('svg')).toHaveCount(1);
    await expect(wrapToggle.locator('svg')).toHaveCount(1);
    expect(((await wrapToggle.textContent()) ?? '').trim()).toBe('');
    // AC-8: theme, then the file tree toggle, then wrap at the right end.
    const treeToggle = toolbar.locator('.editor-tree-toggle');
    await expect(treeToggle.locator('svg')).toHaveCount(1);
    await expect(editorWindow(page).locator('.window-dialog-titlebar button[aria-label^="파일 트리"]')).toHaveCount(0);
    const themeBox = (await themeToggle.boundingBox())!;
    const treeBox = (await treeToggle.boundingBox())!;
    const wrapBox = (await wrapToggle.boundingBox())!;
    expect(themeBox.x).toBeLessThan(treeBox.x);
    expect(treeBox.x).toBeLessThan(wrapBox.x);

    // AC-1: code content spans the scroller instead of a centred column.
    const widths = await panel.evaluate((element) => {
      const scroller = element.querySelector('.cm-scroller') as HTMLElement;
      const content = element.querySelector('.cm-content') as HTMLElement;
      const gutters = element.querySelector('.cm-gutters') as HTMLElement | null;
      return { scroller: scroller.clientWidth, content: content.getBoundingClientRect().width, gutters: gutters?.getBoundingClientRect().width ?? 0 };
    });
    expect(widths.content).toBeGreaterThanOrEqual((widths.scroller - widths.gutters) * 0.97);

    // AC-3 / AC-4: toggling to dark flips the host theme and survives a reload.
    const startTheme = await themeToggle.getAttribute('data-theme-state');
    if (startTheme === 'dark') await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('data-theme-state', 'light');
    await expect(themeToggle.locator('svg[data-icon="moon"]')).toHaveCount(1);
    await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('data-theme-state', 'dark');
    await expect(themeToggle.locator('svg[data-icon="sun"]')).toHaveCount(1);
    await expect(panel.locator('.editor-window-host')).toHaveAttribute('data-theme', 'dark');
    // AC-9: the tab bar and the active tab turn dark too.
    const tabBarBg = await editorWindow(page).locator('.editor-tab-bar').evaluate(element => getComputedStyle(element).backgroundColor);
    const [r, g, b] = (tabBarBg.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
    expect(r + g + b, `tab bar ${tabBarBg} should be dark`).toBeLessThan(3 * 96);
    // AC-10: the Ctrl+F panel's buttons follow the dark surface.
    await contentOf(page, 'sample.ts').click();
    await page.keyboard.press('Control+f');
    const searchButton = panel.locator('.cm-panel.cm-search .cm-button').first();
    await expect(searchButton).toBeVisible();
    // The line-number gutter is sticky: when the search panel scrolls the
    // content sideways, the text must pass under an opaque gutter, not show through it.
    // With the wrap toggle off, the long line stays one line in dark mode too.
    await expect(wrapToggle).toHaveAttribute('aria-pressed', 'false');
    const lineHeights = await panel.evaluate((element) => {
      const lines = [...element.querySelectorAll('.cm-line')] as HTMLElement[];
      return { first: lines[0].getBoundingClientRect().height, long: lines[5].getBoundingClientRect().height };
    });
    expect(lineHeights.long).toBeLessThan(lineHeights.first * 1.5);
    const gutterBg = await panel.locator('.cm-gutters').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(gutterBg, 'the gutter must not be transparent').not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const buttonBg = await searchButton.evaluate(element => getComputedStyle(element).backgroundColor);
    const [br, bg, bb] = (buttonBg.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
    expect(br + bg + bb, `search button ${buttonBg} should be dark`).toBeLessThan(3 * 96);
    await screenshot(page, 'toolbar-dark');
    await page.keyboard.press('Escape');
    // AC-8 / AC-9: the toolbar's tree toggle opens the pane, and it is dark too.
    await treeToggle.click();
    const pane = editorWindow(page).locator('.editor-tree-pane');
    await expect(pane).toBeVisible({ timeout: 15000 });
    await expect(treeToggle).toHaveAttribute('aria-pressed', 'true');
    const paneBg = await pane.evaluate(element => getComputedStyle(element).backgroundColor);
    const [pr, pg, pb] = (paneBg.match(/\d+/g) ?? ['255', '255', '255']).map(Number);
    expect(pr + pg + pb, `tree pane ${paneBg} should be dark`).toBeLessThan(3 * 96);
    await screenshot(page, 'tree-dark');
    await treeToggle.click();
    await expect(pane).toBeHidden();

    await page.reload();
    await showWorkTab(page, record);
    if (await panelFor(page, 'sample.ts').count() === 0) await openFile(page, record, 'sample.ts');
    const after = panelFor(page, 'sample.ts');
    await expect(after.locator('.editor-window-host')).toHaveAttribute('data-theme', 'dark', { timeout: 15000 });
    await after.locator('.editor-theme-toggle').click();
    await expect(after.locator('.editor-window-host')).toHaveAttribute('data-theme', 'light');

    // AC-7: clicking the path copies the whole path and says so.
    // Like the session path at the bottom: the label reads '✓ 복사됨', then the path returns.
    await after.locator('.editor-document-path').click();
    await expect(after.locator('.editor-document-path')).toHaveText('✓ 복사됨');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fullPath);
    await expect(after.locator('.editor-document-path')).not.toHaveText('✓ 복사됨', { timeout: 5000 });
    await screenshot(page, 'toolbar-light');
  });

  // TC-REQ-FR-MDE-020-AC5-81
  test('마크다운 도구줄: 주간/야간 토글만, 줄바꿈 토글 없음; 좁으면 경로가 ...\\파일이름', async ({ page }) => {
    await openFile(page, record, 'notes.md');
    const panel = panelFor(page, 'notes.md');
    await expect(panel.locator('.editor-window-host')).toHaveAttribute('data-editor-mode', 'markdown');
    const toolbar = panel.locator('.editor-document-toolbar');
    await expect(toolbar.locator('.editor-theme-toggle')).toHaveCount(1);
    await expect(toolbar.locator('.editor-code-wrap-toggle')).toHaveCount(0);

    // AC-6: a path box too narrow for the path shows ...<sep>notes.md.
    await toolbar.locator('.editor-document-path').evaluate((button) => {
      (button.parentElement as HTMLElement).style.maxWidth = '90px';
    });
    await expect(toolbar.locator('.editor-document-path')).toHaveAttribute('data-truncated', 'true');
    await expect(toolbar.locator('.editor-document-path')).toHaveText(/^\.\.\.[\\/]notes\.md$/);
  });

  // TC-REQ-FR-MDE-021-AC1-81
  test('편집기 탭 오른쪽 버튼: 이 탭·다른 탭·모든 탭 닫기, 미저장이 있으면 한 번 묻는다', async ({ page }) => {
    for (const name of ['unix.txt', 'app.ts', 'sample.ts']) await openFile(page, record, name);
    const surface = editorWindow(page);
    // The label, not the title: a dirty tab's title gains a marker after the path.
    const tab = (name: string) => surface.locator('.editor-tab', { has: page.locator('.editor-tab-label', { hasText: name }) });
    const menu = page.locator('.context-menu[role="menu"]').first();
    const menuItem = (label: string) => menu.locator('.context-menu-item', { hasText: label });

    await tab('app.ts').click({ button: 'right' });
    await expect(menu.locator('.context-menu-label')).toHaveText(['이 탭 닫기', '다른 탭 닫기', '모든 탭 닫기']);
    await screenshot(page, 'tab-menu');
    // 이 탭 닫기: only that tab goes.
    await menuItem('이 탭 닫기').click();
    await expect(surface.locator('.editor-tab')).toHaveCount(2);
    await expect(tab('app.ts')).toHaveCount(0);

    // 다른 탭 닫기: the right-clicked tab stays and becomes active.
    await tab('unix.txt').click({ button: 'right' });
    await menuItem('다른 탭 닫기').click();
    await expect(surface.locator('.editor-tab')).toHaveCount(1);
    await expect(tab('unix.txt')).toHaveClass(/is-active/);

    // With one tab left, 다른 탭 닫기 is disabled.
    await tab('unix.txt').click({ button: 'right' });
    await expect(menuItem('다른 탭 닫기')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // 모든 탭 닫기 with an unsaved document asks once; cancel closes nothing.
    await openFile(page, record, 'app.ts');
    await clickStartOf(page, 'app.ts');
    await page.keyboard.type('// dirty ');
    await expect(tab('app.ts').locator('.editor-tab-label')).toContainText('*');
    await tab('unix.txt').click({ button: 'right' });
    await menuItem('모든 탭 닫기').click();
    const prompt = page.locator('.editor-bulk-close-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('1개');
    await prompt.getByRole('button', { name: '취소' }).click();
    await expect(surface.locator('.editor-tab')).toHaveCount(2);

    // 저장 안 함 closes them all, and the window with them; the file is untouched.
    const before = diskBytes(record, 'app.ts');
    await tab('unix.txt').click({ button: 'right' });
    await menuItem('모든 탭 닫기').click();
    await prompt.getByRole('button', { name: '저장 안 함' }).click();
    await expect(editorWindow(page)).toHaveCount(0);
    expect(show(diskBytes(record, 'app.ts'))).toBe(show(before));
  });

  // TC-REQ-FR-MDE-021-AC5-81
  test('모든 탭 닫기 → 모두 저장: 미저장 문서를 저장하고 모두 닫는다', async ({ page }) => {
    for (const name of ['unix.txt', 'app.ts']) await openFile(page, record, name);
    const surface = editorWindow(page);
    await clickStartOf(page, 'app.ts');
    await page.keyboard.type('// saved ');
    await surface.locator('.editor-tab').first().click({ button: 'right' });
    await page.locator('.context-menu[role="menu"] .context-menu-item', { hasText: '모든 탭 닫기' }).click();
    await page.locator('.editor-bulk-close-prompt').getByRole('button', { name: '모두 저장' }).click();
    await expect(editorWindow(page)).toHaveCount(0, { timeout: 15000 });
    expect(diskBytes(record, 'app.ts').toString('utf-8')).toBe('// saved export const value = 1;\n');
  });

  // TC-REQ-FR-MDE-022-AC1-81
  test('편집기 본문 오른쪽 버튼: 모두 선택·복사·잘라내기·붙여넣기', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await openFile(page, record, 'unix.txt');
    const content = contentOf(page, 'unix.txt');
    const menu = page.locator('.context-menu[role="menu"]').first();
    const menuItem = (label: string) => menu.locator('.context-menu-item', { hasText: label });

    await content.click({ button: 'right' });
    await expect(menu.locator('.context-menu-label')).toHaveText(['모두 선택', '복사', '잘라내기', '붙여넣기']);
    // Nothing selected yet: copy and cut are disabled.
    await expect(menuItem('복사')).toHaveAttribute('aria-disabled', 'true');
    await expect(menuItem('잘라내기')).toHaveAttribute('aria-disabled', 'true');
    await screenshot(page, 'edit-menu');
    await menuItem('모두 선택').click();

    await content.click({ button: 'right' });
    await menuItem('복사').click();
    // The Windows clipboard hands text back with CRLF, whatever was written.
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'))
      .toBe('alpha\nbeta\ngamma\n');

    await content.click({ button: 'right' });
    await menuItem('모두 선택').click();
    await content.click({ button: 'right' });
    await menuItem('잘라내기').click();
    await expect(content).not.toContainText('beta');

    await page.evaluate(() => navigator.clipboard.writeText('pasted'));
    await content.click({ button: 'right' });
    await menuItem('붙여넣기').click();
    await expect(content).toContainText('pasted');
  });

  // TC-REQ-FR-FEX-012-AC1-81
  test('파일 탐색기 탭 오른쪽 버튼: 다른 탭 닫기는 그 탭만 남기고, 모든 탭 닫기는 창을 닫는다', async ({ page }) => {
    await openExplorer(page, record.root!);
    const win = explorerWindow(page);
    await win.locator('.fx-tab-add').click();
    await win.locator('.fx-tab-add').click();
    await expect(win.locator('.fx-tab')).toHaveCount(3);
    const menu = page.locator('.context-menu[role="menu"]').first();
    const menuItem = (label: string) => menu.locator('.context-menu-item', { hasText: label });

    await win.locator('.fx-tab').nth(1).click({ button: 'right' });
    await expect(menu.locator('.context-menu-label')).toHaveText(['이 탭 닫기', '다른 탭 닫기', '모든 탭 닫기']);
    await menuItem('이 탭 닫기').click();
    await expect(win.locator('.fx-tab')).toHaveCount(2);

    await win.locator('.fx-tab').nth(1).click({ button: 'right' });
    await menuItem('다른 탭 닫기').click();
    await expect(win.locator('.fx-tab')).toHaveCount(1);
    await expect(win.locator('.fx-tab').first()).toHaveAttribute('aria-selected', 'true');

    await win.locator('.fx-tab').first().click({ button: 'right' });
    await menuItem('모든 탭 닫기').click();
    await expect(explorerWindow(page)).toHaveCount(0);
  });

  // TC-REQ-FR-MDE-023-AC1-81
  test('md 원문 보기 토글: 주간/야간 왼쪽, 원문은 코드 모드, 편집 내용과 dirty·저장이 이어진다', async ({ page }) => {
    await openFile(page, record, 'notes.md');
    const panel = panelFor(page, 'notes.md');
    const host = panel.locator('.editor-window-host');
    const toggle = panel.locator('.editor-markdown-view-toggle');
    const themeToggle = panel.locator('.editor-theme-toggle');
    await expect(host).toHaveAttribute('data-editor-mode', 'markdown');
    await expect(toggle.locator('svg[data-icon="source"]')).toHaveCount(1);
    expect((await toggle.boundingBox())!.x).toBeLessThan((await themeToggle.boundingBox())!.x);

    // Raw source: the code editor with line numbers, no live-preview decorations.
    await toggle.click();
    await expect(host).toHaveAttribute('data-editor-mode', 'code');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle.locator('svg[data-icon="markdown"]')).toHaveCount(1);
    await expect(panel.locator('.cm-lineNumbers')).toBeVisible();
    await expect(panel.locator('.cm-content')).toContainText('# Notes');
    expect(await panel.locator('[class*="cm-atomic-"]').count()).toBe(0);
    await screenshot(page, 'md-raw');

    // An edit made raw survives the switch back and stays unsaved until saved.
    await clickStartOf(page, 'notes.md');
    await page.keyboard.type('Intro line\n');
    await toggle.click();
    await expect(host).toHaveAttribute('data-editor-mode', 'markdown');
    await expect(panel.locator('.cm-content')).toContainText('Intro line');
    await expect(editorWindow(page)).toHaveAttribute('data-dirty', 'true');
    await saveWithShortcut(page, 'notes.md');
    await expect.poll(() => diskBytes(record, 'notes.md').toString('utf-8')).toBe('Intro line\n# Notes\n\nplain paragraph\n');
    await expect(editorWindow(page)).not.toHaveAttribute('data-dirty', 'true');
  });

  // TC-REQ-FR-MDE-014-AC6-81
  test('코드 파일 수정 → dirty 표시 → Ctrl+S 저장 → 닫기 확인 없음; 미저장 닫기는 확인', async ({ page }) => {
    await openFile(page, record, 'app.ts');
    const surface = editorWindow(page);
    await expect(surface).not.toHaveAttribute('data-dirty', 'true');
    await clickStartOf(page, 'app.ts');
    await page.keyboard.type('// saved\n');
    await expect(surface).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    await saveWithShortcut(page, 'app.ts');
    await expect.poll(() => writes.length, { timeout: 10000 }).toBe(1);
    await expect(surface).not.toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    expect(diskBytes(record, 'app.ts').toString('utf-8')).toBe('// saved\nexport const value = 1;\n');

    await surface.locator('.editor-tab-close[aria-label="app.ts 닫기"]').click();
    await expect(page.locator('.modal-overlay .modal-content')).toHaveCount(0);
    await expect(page.locator('.editor-document-panel[data-document-id$="app.ts"]')).toHaveCount(0, { timeout: 10000 });

    // Control: an unsaved document does ask.
    await openFile(page, record, 'app.ts');
    await clickStartOf(page, 'app.ts');
    await page.keyboard.type('// unsaved\n');
    await expect(editorWindow(page)).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    await editorWindow(page).locator('.editor-tab-close[aria-label="app.ts 닫기"]').click();
    const prompt = page.locator('.modal-overlay .modal-content');
    await expect(prompt).toBeVisible({ timeout: 10000 });
    await expect(prompt.locator('.modal-actions button')).toHaveCount(3);
    await screenshot(page, 'unsaved-close-prompt');
    await prompt.locator('.btn-destructive').click();
    await expect(page.locator('.editor-document-panel[data-document-id$="app.ts"]')).toHaveCount(0, { timeout: 10000 });
    expect(writes).toHaveLength(1);
    expect(diskBytes(record, 'app.ts').toString('utf-8')).toBe('// saved\nexport const value = 1;\n');
  });

  // TC-REQ-FR-MDE-017-AC1-81
  test('깨진 JSON 줄에 lint 표시가 뜨고 고치면 사라진다; CSV 열마다 다른 색 클래스', async ({ page }) => {
    await openFile(page, record, 'bad.json');
    const panel = panelFor(page, 'bad.json');
    await expect(panel.locator('.cm-lint-marker-error').first()).toBeVisible({ timeout: 15000 });
    // The marker sits on the broken line (line 3), not somewhere arbitrary.
    const markerTop = (await panel.locator('.cm-lint-marker-error').first().boundingBox())!.y;
    const lineTop = (await contentOf(page, 'bad.json').locator('.cm-line').nth(2).boundingBox())!.y;
    expect(Math.abs(markerTop - lineTop)).toBeLessThan(12);
    await screenshot(page, 'json-lint');

    await contentOf(page, 'bad.json').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('{\n  "a": 1,\n  "b": 2\n}\n');
    await expect(contentOf(page, 'bad.json')).toContainText('"b": 2');
    await expect(panel.locator('.cm-lint-marker-error')).toHaveCount(0, { timeout: 15000 });

    await openFile(page, record, 'data.csv');
    const csv = contentOf(page, 'data.csv');
    const firstLine = csv.locator('.cm-line').first();
    await expect(firstLine.locator('.cm-csv-col-0')).toHaveText('name');
    await expect(firstLine.locator('.cm-csv-col-1')).toHaveText('age');
    await expect(firstLine.locator('.cm-csv-col-2')).toHaveText('city');
    const colours = await Promise.all([0, 1, 2].map(index =>
      firstLine.locator(`.cm-csv-col-${index}`).evaluate(element => getComputedStyle(element).color)));
    expect(new Set(colours).size, `column colours ${colours.join(' | ')}`).toBe(3);
    await screenshot(page, 'csv-columns');
  });

  // TC-REQ-FR-MDE-013-AC6-81
  test('탐색기에서 .exe 행은 흐리고 더블클릭해도 창이 열리지 않는다', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/files/read')) reads.push(decodeURIComponent(request.url()));
    });
    await openExplorer(page, record.root!);
    const exe = rowNamed(page, 'tool.exe');
    const control = rowNamed(page, 'unix.txt');
    await expect(exe).toHaveClass(/(^|\s)unopenable(\s|$)/);
    await expect.poll(async () => computedOpacity(exe.locator('.fx-name'))).toBeLessThan(1);
    expect(await computedOpacity(control.locator('.fx-name')), 'an openable row').toBe(1);
    await screenshot(page, 'exe-dimmed');

    await exe.dblclick();
    // Control second: once the openable file's window is up, the .exe double
    // click had its chance to open first.
    await control.dblclick();
    await expect(page.locator('.editor-document-panel[data-document-id$="unix.txt"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.editor-document-panel[data-document-id$="tool.exe"]')).toHaveCount(0);
    expect(reads.some(url => url.endsWith('unix.txt'))).toBe(true);
    expect(reads.filter(url => url.endsWith('tool.exe'))).toEqual([]);
  });
});

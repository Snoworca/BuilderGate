// Image and SVG tabs in the editor window, end to end (T-PH008-02):
// an image opens as a view-only tab drawn from a blob: URL, fits the window
// first and zooms/pans, shows its size, sits on a checkerboard, never writes,
// reports a missing file inside the tab, comes back after a reload; an SVG
// switches to its XML source and back in the same tab; a scripted SVG runs
// nothing in the viewer or when its endpoint is opened as a document; and the
// read-image response and page CSP carry what IR-MDE-003 asks for.
//
// Runs only against the verified external runtime on https://localhost:2222 and
// needs BUILDERGATE_PASSWORD. Before running: no other `playwright test` process
// may be alive on the host.
//
// Fixture shape, per test (code-editor-text.spec.ts's shape):
//   * one workspace created through createOwnedWorkspaceViaApi under an owner id
//     this spec makes, removed only through cleanupOwnedWorkspaces for that owner;
//   * a "base" tab whose session cwd is where the test folder is created;
//   * a test folder `bg-cei-e2e-<random>` made over the file API, filled with
//     raw bytes through node:fs (PNG bytes are not a UTF-8 string), and removed
//     by its exact absolute path through the base session;
//   * a "work" tab whose cwd is the test folder, so the explorer opens on it.
//
// Weak assertions avoided on purpose (what would satisfy them cheaply):
//   * "an <img> is in the tab" -- an <img> whose src never loaded would pass.
//     The info line is only filled from the decoded natural size, and the exact
//     "W × H · size" string is compared.
//   * "the zoom label changed after the wheel" -- a label that moves while the
//     picture does not would pass. The image's on-screen box is measured too,
//     and the 100% box is compared with the file's pixel size.
//   * "the stage has the checkerboard class" -- a class with no CSS would pass.
//     The computed background-image is read.
//   * "no write after Ctrl+S" -- a shortcut that never reached the tab would
//     pass. The save button is pressed as well, and the dirty flag is read.
//   * "the missing image showed no create prompt" -- an open that never
//     happened would pass. The in-tab reason has to be on screen.
//   * "the scripted SVG set no flag" -- a detector that cannot see a script
//     would pass. A control page runs the same SVG inline and must trip it.
//   * "no CSP violation event" -- a listener that is never called would pass.
//     A control image from a disallowed origin must raise one.

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import {
  test, expect, createOwnedWorkspaceViaApi,
  type APIRequestContext, type Locator, type Page,
} from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const TAB_NAME_PREFIX = 'e2e-cei';
const SCREENSHOT_DIR = '../.playwright-mcp';
const PWNED_PATH = '/__bg_svg_pwned__';
const SVG_SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

// ---------------------------------------------------------------------------
// PNG bytes, built here so the fixture is exactly what the assertions assume.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGBA PNG whose pixel at (x, y) is `pixel(x, y)`. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg(width: number, height: number, fill: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
    + `  <rect width="${width}" height="${height}" fill="${fill}"/>\n</svg>\n`;
}

/** Every way an SVG can try to run script in a document that lets it. */
const EVIL_SVG = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="window.__bgSvgPwned='onload';fetch('${ORIGIN}${PWNED_PATH}?via=onload');alert('onload')">`,
  `  <script>window.__bgSvgPwned='script';fetch('${ORIGIN}${PWNED_PATH}?via=script');alert('script');</script>`,
  '  <rect width="120" height="80" fill="#c03"/>',
  '</svg>',
  '',
].join('\n');

/** No name is a suffix of another: panels are found by the tail of their path. */
const FIXTURES: Record<string, Buffer> = {
  // Larger than any editor window, so "fit" and "100%" differ.
  'photo.png': png(1600, 1200, (x, y) => [(x * 7) & 0xff, (y * 5) & 0xff, 0x80, 0xff]),
  // Left half fully transparent.
  'clear.png': png(64, 64, (x) => (x < 32 ? [0, 0, 0, 0] : [0x20, 0x90, 0xe0, 0xff])),
  'gone.png': png(16, 16, () => [0xff, 0, 0, 0xff]),
  'lost.png': png(16, 16, () => [0, 0xff, 0, 0xff]),
  'pic.svg': Buffer.from(svg(200, 100, 'red'), 'utf-8'),
  'evil.svg': Buffer.from(EVIL_SVG, 'utf-8'),
  'notes.txt': Buffer.from('plain text\n', 'utf-8'),
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
  const toTabs = page.locator('button[title="Switch to Tabs"]');
  if (await toTabs.count()) await toTabs.click();
  await expect(page.locator('button[title="Switch to Grid"]')).toBeVisible({ timeout: 15000 });
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

  const folderName = `bg-cei-e2e-${suffix}`;
  await makeDirectory(request, token, base.sessionId, baseCwd, folderName);
  const folder = joinPath(baseCwd, folderName);
  record.folder = folder;

  for (const [name, bytes] of Object.entries(FIXTURES)) {
    writeFileSync(joinPath(folder, name), bytes);
  }
  // The server sees what node:fs wrote -- otherwise this spec is not running on
  // the server's host and the byte and size comparisons below mean nothing.
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
  if (failures.length > 1) throw new AggregateError(failures, 'code editor image fixture teardown failed');
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
  return page.locator(`.editor-document-panel[data-document-id$="${fileName}"]`);
}

function viewerOf(page: Page, fileName: string): Locator {
  return panelFor(page, fileName).locator('.image-viewer');
}

function imageOf(page: Page, fileName: string): Locator {
  return viewerOf(page, fileName).locator('img.image-viewer-image');
}

async function openExplorer(page: Page, root: string): Promise<void> {
  if (await explorerWindow(page).count() === 0) {
    await page.locator('button.header-action-button[aria-label="파일 탐색기"]').click();
  }
  await expect(explorerWindow(page)).toHaveCount(1, { timeout: 15000 });
  await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', root, { timeout: 15000 });
  await expect(rowNamed(page, 'notes.txt')).toBeVisible({ timeout: 15000 });
}

async function closeExplorer(page: Page): Promise<void> {
  if (await explorerWindow(page).count() === 0) return;
  await explorerWindow(page).locator('button[aria-label="Close"]').first().click();
  await expect(explorerWindow(page)).toHaveCount(0, { timeout: 10000 });
}

function infoFor(width: number, height: number, bytes: number): string {
  const size = bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return `${width} × ${height} · ${size}`;
}

/** The image finished decoding: the info line is filled only from its natural size. */
async function expectDecoded(page: Page, fileName: string, width: number, height: number): Promise<void> {
  await expect(viewerOf(page, fileName).locator('.image-viewer-info'))
    .toHaveText(infoFor(width, height, FIXTURES[fileName].length), { timeout: 15000 });
  await expect(imageOf(page, fileName)).toHaveAttribute('src', /^blob:/);
}

/** Opens an image by double-clicking its explorer row, then closes the explorer. */
async function openImage(page: Page, record: FixtureRecord, fileName: string, width: number, height: number): Promise<void> {
  await openExplorer(page, record.root!);
  await rowNamed(page, fileName).dblclick();
  await expect(panelFor(page, fileName)).toHaveCount(1, { timeout: 15000 });
  await expect(panelFor(page, fileName).locator('.editor-window-host')).toHaveAttribute('data-editor-mode', 'image');
  await expectDecoded(page, fileName, width, height);
  await closeExplorer(page);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('element has no box');
  return found;
}

async function zoomPercent(page: Page, fileName: string): Promise<number> {
  const text = await viewerOf(page, fileName).locator('.image-viewer-zoom').innerText();
  return Number(text.replace('%', ''));
}

function diskBytes(record: FixtureRecord, fileName: string): Buffer {
  return readFileSync(joinPath(record.folder!, fileName));
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/code-editor-image-${name}.png` });
}

/** Watches a page for anything an SVG script could do. */
function watchForScript(page: Page): { dialogs: string[]; pings: string[] } {
  const seen = { dialogs: [] as string[], pings: [] as string[] };
  page.on('dialog', (dialog) => {
    seen.dialogs.push(dialog.message());
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('request', (request) => {
    if (request.url().includes(PWNED_PATH)) seen.pings.push(request.url());
  });
  return seen;
}

// ---------------------------------------------------------------------------

test.describe('code editor: image and SVG tabs', () => {
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
    ownerId = `code-editor-image/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    apiCreationStarted = true;
    await setUpFixture(page, request, ownerId, record);
    writes = recordWrites(page);
  });

  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await tearDownFixture(request, ownerId, record, apiCreationStarted);
    apiCreationStarted = false;
  });

  // TC-REQ-FR-MDE-018-AC1-81
  test('png 더블클릭 → 편집기 창 새 탭, img src 가 blob:, 트레이·닫기가 문서 탭과 같다', async ({ page }) => {
    const imageReads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/files/read')) imageReads.push(request.url());
    });
    await openImage(page, record, 'photo.png', 1600, 1200);
    const surface = editorWindow(page);
    await expect(surface.locator('.editor-tab .editor-tab-label', { hasText: 'photo.png' })).toBeVisible();
    // The bytes came from the image endpoint, not the text read.
    expect(imageReads.some(url => url.includes('/files/read-image?'))).toBe(true);
    expect(imageReads.filter(url => /\/files\/read\?/.test(url))).toEqual([]);
    await screenshot(page, 'png-tab');

    await surface.locator('button[aria-label="최소화"]').click();
    await expect(page.locator('.window-dialog-surface.editor-window-surface')).toBeHidden({ timeout: 10000 });
    await page.locator('button[aria-label="편집기 창"]').click();
    await page.locator('.context-menu-item').filter({ hasText: 'photo.png' }).first().click();
    await expect(editorWindow(page)).toBeVisible({ timeout: 10000 });
    await expectDecoded(page, 'photo.png', 1600, 1200);

    await editorWindow(page).locator('.editor-tab-close[aria-label="photo.png 닫기"]').click();
    await expect(page.locator('.modal-overlay .modal-content')).toHaveCount(0);
    await expect(panelFor(page, 'photo.png')).toHaveCount(0, { timeout: 10000 });
  });

  // TC-REQ-FR-MDE-018-AC3-81
  test('처음 창 맞춤, 100% 버튼, 휠 확대·끌기 이동, 해상도·크기 표시, 체커보드 배경', async ({ page }) => {
    await openImage(page, record, 'photo.png', 1600, 1200);
    const viewer = viewerOf(page, 'photo.png');
    const stage = viewer.locator('.image-viewer-stage');
    const image = imageOf(page, 'photo.png');
    const fitButton = viewer.locator('.image-viewer-fit');
    const actualButton = viewer.locator('.image-viewer-actual');

    // Fit first: the whole picture inside the stage, below 100%.
    await expect(fitButton).toHaveAttribute('aria-pressed', 'true');
    const stageBox = await box(stage);
    const fitBox = await box(image);
    expect(fitBox.width).toBeLessThanOrEqual(stageBox.width + 1);
    expect(fitBox.height).toBeLessThanOrEqual(stageBox.height + 1);
    // Touches the stage on at least one axis -- a tiny thumbnail is not "fit".
    expect(Math.max(fitBox.width / stageBox.width, fitBox.height / stageBox.height)).toBeGreaterThan(0.98);
    const fitZoom = await zoomPercent(page, 'photo.png');
    expect(fitZoom).toBeLessThan(100);

    await actualButton.click();
    await expect(actualButton).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer.locator('.image-viewer-zoom')).toHaveText('100%');
    const actualBox = await box(image);
    expect(Math.abs(actualBox.width - 1600)).toBeLessThan(2);
    expect(Math.abs(actualBox.height - 1200)).toBeLessThan(2);

    await fitButton.click();
    await expect(fitButton).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await box(image)).width).toBeCloseTo(fitBox.width, 0);

    // Wheel over the stage zooms in; the picture grows, not only the label.
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.wheel(0, -300);
    await expect.poll(() => zoomPercent(page, 'photo.png')).toBeGreaterThan(fitZoom);
    await expect(fitButton).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await box(image)).width).toBeGreaterThan(fitBox.width + 1);

    // Dragging moves it by the drag.
    const beforeDrag = await box(image);
    const startX = stageBox.x + stageBox.width / 2;
    const startY = stageBox.y + stageBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 30, startY + 20, { steps: 3 });
    await page.mouse.move(startX + 60, startY + 40, { steps: 3 });
    await page.mouse.up();
    const afterDrag = await box(image);
    expect(Math.abs(afterDrag.x - beforeDrag.x - 60)).toBeLessThan(3);
    expect(Math.abs(afterDrag.y - beforeDrag.y - 40)).toBeLessThan(3);
    await screenshot(page, 'png-zoomed');

    // Transparent pixels over the checkerboard.
    await openImage(page, record, 'clear.png', 64, 64);
    const clearStage = viewerOf(page, 'clear.png').locator('.image-viewer-stage');
    const background = await clearStage.evaluate(element => getComputedStyle(element).backgroundImage);
    expect(background, 'checkerboard background').toMatch(/linear-gradient/);
    expect((background.match(/linear-gradient/g) ?? []).length).toBe(4);
    await screenshot(page, 'transparent-checkerboard');
  });

  // TC-REQ-FR-MDE-018-AC7-81
  test('Ctrl+S·저장 버튼 뒤 write 요청 0; 없는 이미지는 탭 안 오류, 새 파일 확인 없음', async ({ page }) => {
    await openImage(page, record, 'photo.png', 1600, 1200);
    const surface = editorWindow(page);
    await viewerOf(page, 'photo.png').locator('.image-viewer-stage').click();
    await page.keyboard.press('Control+s');
    await surface.locator('button[aria-label="저장"]').click();
    await page.waitForTimeout(1000);
    expect(writes, 'an image tab writes nothing').toEqual([]);
    await expect(surface).not.toHaveAttribute('data-dirty', 'true');
    expect(diskBytes(record, 'photo.png').equals(FIXTURES['photo.png'])).toBe(true);

    // The explorer listed gone.png before it was deleted; opening the stale row
    // reads a file that is no longer there.
    await openExplorer(page, record.root!);
    await expect(rowNamed(page, 'gone.png')).toBeVisible();
    unlinkSync(joinPath(record.folder!, 'gone.png'));
    await rowNamed(page, 'gone.png').dblclick();
    const message = viewerOf(page, 'gone.png').locator('.image-viewer-message[role="alert"]');
    await expect(message).toHaveText('파일을 찾을 수 없습니다.', { timeout: 15000 });
    await closeExplorer(page);
    await expect(page.locator('.modal-overlay .modal-content')).toHaveCount(0);
    await expect(viewerOf(page, 'gone.png').locator('img')).toHaveCount(0);
    await screenshot(page, 'missing-image');

    // A reload whose restore meets a deleted image asks nothing either. The
    // text file restored beside it shows the restore did run.
    // One open per explorer visit: the editor window comes to the front on an
    // open and would cover the explorer's rows.
    await openImage(page, record, 'lost.png', 16, 16);
    await openExplorer(page, record.root!);
    await rowNamed(page, 'notes.txt').dblclick();
    await expect(panelFor(page, 'notes.txt').locator('.cm-content')).toBeVisible({ timeout: 15000 });
    await closeExplorer(page);
    unlinkSync(joinPath(record.folder!, 'lost.png'));
    await page.reload();
    await showWorkTab(page, record);
    // Restored, though not necessarily the active tab.
    await expect(panelFor(page, 'notes.txt')).toHaveCount(1, { timeout: 15000 });
    await expect(panelFor(page, 'photo.png')).toHaveCount(1);
    await page.waitForTimeout(1000);
    await expect(page.locator('.modal-overlay .modal-content')).toHaveCount(0);
    await expect(imageOf(page, 'lost.png')).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  // TC-REQ-FR-MDE-018-AC9-81
  test('새로고침 뒤 png·svg 탭이 뷰어로 복원', async ({ page }) => {
    const textReads: string[] = [];
    await openImage(page, record, 'photo.png', 1600, 1200);
    await openImage(page, record, 'pic.svg', 200, 100);

    page.on('request', (request) => {
      if (/\/files\/read\?/.test(request.url())) textReads.push(decodeURIComponent(request.url()));
    });
    await page.reload();
    await showWorkTab(page, record);

    await expect(panelFor(page, 'photo.png').locator('.editor-window-host'))
      .toHaveAttribute('data-editor-mode', 'image', { timeout: 15000 });
    await expect(panelFor(page, 'pic.svg').locator('.editor-window-host')).toHaveAttribute('data-editor-mode', 'image');
    await expect(panelFor(page, 'pic.svg').locator('.svg-file-tab')).toHaveAttribute('data-svg-view', 'preview');
    // Either tab may be the active one; select each and check it decoded.
    await editorWindow(page).locator('.editor-tab .editor-tab-label', { hasText: 'photo.png' }).click();
    await expectDecoded(page, 'photo.png', 1600, 1200);
    await editorWindow(page).locator('.editor-tab .editor-tab-label', { hasText: 'pic.svg' }).click();
    await expectDecoded(page, 'pic.svg', 200, 100);
    // Neither came back through the text read.
    expect(textReads.filter(url => url.endsWith('photo.png') || url.endsWith('pic.svg'))).toEqual([]);
    await screenshot(page, 'restored-image-tabs');
  });

  // TC-REQ-FR-MDE-019-AC1-81
  test('svg 뷰어 → 소스 편집 → 수정 → 미리보기에 반영 → 저장·미저장 닫기 확인', async ({ page }) => {
    const textReads: string[] = [];
    page.on('request', (request) => {
      if (/\/files\/read\?/.test(request.url())) textReads.push(decodeURIComponent(request.url()));
    });
    await openImage(page, record, 'pic.svg', 200, 100);
    const panel = panelFor(page, 'pic.svg');
    const tab = panel.locator('.svg-file-tab');
    await expect(tab).toHaveAttribute('data-svg-view', 'preview');

    await viewerOf(page, 'pic.svg').locator('.image-viewer-edit-source').click();
    await expect(tab).toHaveAttribute('data-svg-view', 'source');
    const content = panel.locator('.svg-file-tab-source .cm-content');
    await expect(content).toContainText('<rect width="200" height="100" fill="red"/>', { timeout: 15000 });
    expect(textReads.some(url => url.endsWith('pic.svg')), 'source body comes from the text read').toBe(true);
    await expect(editorWindow(page)).not.toHaveAttribute('data-dirty', 'true');

    const edited = svg(300, 50, 'blue');
    await content.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(edited);
    await expect(content).toContainText('fill="blue"');
    await expect(editorWindow(page)).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });

    // The preview draws the unsaved edit: the decoded size is the new one.
    await panel.locator('.svg-file-tab-preview').click();
    await expect(tab).toHaveAttribute('data-svg-view', 'preview');
    await expect(viewerOf(page, 'pic.svg').locator('.image-viewer-info')).toHaveText(/^300 × 50 · /, { timeout: 15000 });
    await expect(imageOf(page, 'pic.svg')).toHaveAttribute('src', /^blob:/);
    expect(writes).toEqual([]);
    await screenshot(page, 'svg-preview-of-edit');

    // Save from the source view writes exactly the edited text.
    await viewerOf(page, 'pic.svg').locator('.image-viewer-edit-source').click();
    await expect(tab).toHaveAttribute('data-svg-view', 'source');
    await expect(content).toContainText('fill="blue"');
    await content.click();
    await page.keyboard.press('Control+s');
    await expect.poll(() => writes.length, { timeout: 10000 }).toBe(1);
    await expect(editorWindow(page)).not.toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    await expect.poll(() => diskBytes(record, 'pic.svg').toString('utf-8'), { timeout: 10000 }).toBe(edited);

    // An unsaved edit makes the close ask.
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('<!-- unsaved -->');
    await expect(editorWindow(page)).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    await editorWindow(page).locator('.editor-tab-close[aria-label="pic.svg 닫기"]').click();
    const prompt = page.locator('.modal-overlay .modal-content');
    await expect(prompt).toBeVisible({ timeout: 10000 });
    await expect(prompt.locator('.modal-actions button')).toHaveCount(3);
    await screenshot(page, 'svg-unsaved-close-prompt');
    await prompt.locator('.btn-destructive').click();
    await expect(panelFor(page, 'pic.svg')).toHaveCount(0, { timeout: 10000 });
    expect(writes).toHaveLength(1);
    expect(diskBytes(record, 'pic.svg').toString('utf-8')).toBe(edited);
  });

  // TC-REQ-SEC-MDE-001-AC2-81
  test('script·onload svg 를 뷰어와 엔드포인트 직접 열기 둘 다에서 열어도 플래그 미설정·dialog 0', async ({ page }) => {
    // Control: the same SVG inline in a document that allows script trips the
    // detector, so a silent result below means the script did not run.
    const control = await page.context().newPage();
    const controlSeen = watchForScript(control);
    await control.setContent(`<!doctype html><html><body>${EVIL_SVG}</body></html>`);
    await expect.poll(() => controlSeen.dialogs.length + controlSeen.pings.length, { timeout: 10000 })
      .toBeGreaterThan(0);
    expect(await control.evaluate(() => (window as unknown as { __bgSvgPwned?: string }).__bgSvgPwned)).toBeTruthy();
    await control.close();

    const seen = watchForScript(page);
    await openImage(page, record, 'evil.svg', 120, 80);
    await page.waitForTimeout(1500);
    expect(seen.dialogs, 'no dialog from the viewer').toEqual([]);
    expect(seen.pings, 'no request from the viewer').toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __bgSvgPwned?: string }).__bgSvgPwned)).toBeUndefined();
    await screenshot(page, 'evil-svg-viewer');

    // The endpoint opened as a top-level document.
    const direct = await page.context().newPage();
    const directSeen = watchForScript(direct);
    await direct.setExtraHTTPHeaders(authHeaders(record.token!));
    const path = joinPath(record.root!, 'evil.svg');
    const response = await direct.goto(
      `${ORIGIN}/api/sessions/${record.sessionId}/files/read-image?path=${encodeURIComponent(path)}`,
    );
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toMatch(/^image\/svg\+xml/);
    expect(response?.headers()['content-security-policy']).toBe(SVG_SANDBOX_CSP);
    await direct.waitForTimeout(1500);
    expect(directSeen.dialogs, 'no dialog from the direct document').toEqual([]);
    expect(directSeen.pings, 'no request from the direct document').toEqual([]);
    await direct.screenshot({ path: `${SCREENSHOT_DIR}/code-editor-image-evil-svg-direct.png` });
    await direct.close();
  });

  // TC-REQ-IR-MDE-003-AC4-81
  test('read-image 응답 헤더 Content-Type·nosniff, 페이지 CSP img-src 에 blob: 이 있어 콘솔 CSP 위반 0', async ({ page, request }) => {
    const cspConsole: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) cspConsole.push(message.text());
    });
    await page.evaluate(() => {
      const holder = window as unknown as { __bgCspViolations: string[] };
      holder.__bgCspViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        holder.__bgCspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    const pageResponse = await request.get(`${ORIGIN}/`);
    const csp = pageResponse.headers()['content-security-policy'] ?? '';
    const imgSrc = csp.split(';').map(part => part.trim()).find(part => part.startsWith('img-src')) ?? '';
    expect(imgSrc.split(/\s+/), `page CSP img-src: ${imgSrc}`).toContain('blob:');

    const imageResponse = page.waitForResponse(response => response.url().includes('/files/read-image?')
      && response.url().includes('photo.png'));
    await openImage(page, record, 'photo.png', 1600, 1200);
    const headers = (await imageResponse).headers();
    expect(headers['content-type']).toMatch(/^image\/png/);
    expect(headers['x-content-type-options']).toBe('nosniff');

    const violations = await page.evaluate(() => (window as unknown as { __bgCspViolations: string[] }).__bgCspViolations);
    expect(violations, 'no CSP violation while the image loads').toEqual([]);
    expect(cspConsole).toEqual([]);

    // Control: an image from an origin img-src does not allow is reported.
    await page.evaluate(() => {
      const img = document.createElement('img');
      img.src = 'https://example.invalid/bg-csp-control.png';
      document.body.appendChild(img);
    });
    await expect.poll(async () => (await page.evaluate(() =>
      (window as unknown as { __bgCspViolations: string[] }).__bgCspViolations)).length, { timeout: 10000 })
      .toBeGreaterThan(0);
  });
});

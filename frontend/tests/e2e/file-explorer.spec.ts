// File explorer browser-only acceptance criteria (T-PH003-09).
//
// Authoring only: this spec has not been executed. It needs BUILDERGATE_PASSWORD
// and a verified external runtime on https://localhost:2222; it never starts a
// server and never reuses a webServer.
//
// Fixture shape, per test:
//   * one workspace created through createOwnedWorkspaceViaApi under an owner id
//     this spec makes, and removed only through cleanupOwnedWorkspaces for that
//     owner -- nothing the user owns is touched, nothing is deleted by prefix;
//   * a "base" tab whose session cwd is where the test folder is created;
//   * a test folder `bg-fx-e2e-<random>` under that cwd, filled over the file API,
//     and removed by its exact absolute path through the base session;
//   * a "work" tab whose cwd is the test folder, so the explorer opens on it.
//
// Weak assertions this spec avoids on purpose:
//   * "rows > 0" -- rendering only the rows on screen would pass it. The list
//     case compares the whole name set against the server's listing, over a
//     folder large enough to overflow the scroll area.
//   * "a window is visible" -- a second window or a stale one would pass it. The
//     entry-point case counts windows and reads which layer is on top after
//     another window was raised above the explorer.
//   * "paste is disabled" alone -- a paste that is always disabled would pass
//     it. The terminal Ctrl+C case has a control half where the same key in
//     the explorer enables paste.

import { randomUUID } from 'node:crypto';

import {
  test, expect, createOwnedWorkspaceViaApi,
  type APIRequestContext, type Locator, type Page,
} from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { expectTerminalScreenContains, login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const TAB_NAME_PREFIX = 'e2e-fx';
const BULK_COUNT = 80;
const SCREENSHOT_DIR = '../.playwright-mcp';

interface ListingEntry { name: string; type: 'file' | 'directory' }
interface WorkspaceState {
  workspaces: Array<{ id: string; name: string; activeTabId: string | null }>;
  tabs: Array<{ id: string; workspaceId: string; sessionId: string; name: string }>;
}

/** Everything cleanup needs, filled in as setup proceeds so a half-built fixture is still removed. */
interface FixtureRecord {
  token: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  baseSessionId: string | null;
  folder: string | null;
  sessionId: string | null;
  workTabName: string | null;
  /** The work session's cwd as the server reports it: the explorer's first root. */
  root: string | null;
}

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
  const separator = separatorOf(base);
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`;
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

async function writeFile(
  request: APIRequestContext, token: string, sessionId: string, path: string, content: string,
): Promise<void> {
  const response = await request.post(`${ORIGIN}/api/sessions/${sessionId}/files/write`, {
    headers: authHeaders(token), data: { path, content },
  });
  expect(response.status(), `write ${path}`).toBe(200);
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
  // '..' is window chrome, never a row the list draws as an entry.
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

/**
 * Builds the owned workspace, the test folder and the work tab, then brings the
 * page onto the work tab. `record` is written as each piece exists.
 */
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

  const folderName = `bg-fx-e2e-${suffix}`;
  await makeDirectory(request, token, base.sessionId, baseCwd, folderName);
  const folder = joinPath(baseCwd, folderName);
  record.folder = folder;

  for (const name of ['CLAUDE.md', 'alpha.md', 'beta.md']) {
    await writeFile(request, token, base.sessionId, joinPath(folder, name), `# ${name}\n`);
  }
  // No extension the editor knows: the row is dimmed and a double click does nothing.
  await writeFile(request, token, base.sessionId, joinPath(folder, 'blob.dat'), 'binary-ish\n');
  await makeDirectory(request, token, base.sessionId, folder, 'bulk');
  const bulk = joinPath(folder, 'bulk');
  for (let index = 0; index < BULK_COUNT; index += 1) {
    const name = `row-${String(index).padStart(3, '0')}.md`;
    await writeFile(request, token, base.sessionId, joinPath(bulk, name), `${index}\n`);
  }

  const workTabName = `${TAB_NAME_PREFIX}-work`;
  const work = await addTab(request, token, workspace.id, workTabName, folder);
  record.sessionId = work.sessionId;
  record.workTabName = workTabName;
  record.root = await sessionCwd(request, token, work.sessionId);
  expect(record.root.replace(/[\\/]+$/, '').endsWith(folderName), 'work tab starts in the test folder').toBe(true);

  // The workspace was created outside the page; reload so the page lists it.
  await page.reload();
  await page.waitForSelector('.workspace-screen', { timeout: 15000 });
  await selectWorkspace(page, workspaceName);
  await ensureTabMode(page);
  await selectTab(page, workTabName);
  await waitForTerminal(page);
}

async function tearDownFixture(
  request: APIRequestContext, ownerId: string, record: FixtureRecord, apiCreationStarted: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  // Every tab of the owned workspace except the base one goes first: the work
  // tab's shell has its cwd inside the test folder, and Windows refuses to
  // remove a directory a live process sits in. Only tabs of the workspace this
  // test created are touched.
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
  // Then the folder, through the base session, which the workspace deletion
  // ends. Exact absolute path only, never a pattern. The shell of a just-closed
  // tab can take a moment to exit, so the same exact delete is retried briefly.
  if (record.token && record.baseSessionId && record.folder) {
    try {
      const statuses: number[] = [];
      const deadline = Date.now() + 20000;
      for (;;) {
        const response = await request.delete(`${ORIGIN}/api/sessions/${record.baseSessionId}/files?path=${encodeURIComponent(record.folder)}`, { headers: authHeaders(record.token) });
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
  if (failures.length > 1) throw new AggregateError(failures, 'file explorer fixture teardown failed');
}

// ---------------------------------------------------------------------------
// Locators and actions on the explorer
// ---------------------------------------------------------------------------

function explorerWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.fx-window:visible');
}

function activePanel(page: Page): Locator {
  return explorerWindow(page).locator('.fx-tab-panel[role="tabpanel"]:not(.fx-inactive)');
}

function rowNamed(page: Page, name: string): Locator {
  return activePanel(page).locator(`.fx-row[data-name="${name}"]`);
}

function contextMenu(page: Page): Locator {
  return page.locator('.context-menu[role="menu"]:visible');
}

function menuItem(page: Page, label: string): Locator {
  return contextMenu(page).locator('.context-menu-item')
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function openExplorerFromHeader(page: Page, root: string): Promise<void> {
  await page.locator('button.header-action-button[aria-label="파일 탐색기"]').click();
  await expect(explorerWindow(page)).toHaveCount(1, { timeout: 15000 });
  await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', root, { timeout: 15000 });
  await expect(rowNamed(page, 'alpha.md')).toBeVisible({ timeout: 15000 });
}

async function ensureListMode(page: Page): Promise<void> {
  const toggle = activePanel(page).locator('button.fx-mode-toggle');
  if ((await toggle.getAttribute('aria-label')) === '목록으로 보기') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', '트리로 보기');
  await expect(activePanel(page).locator('.fx-list[role="grid"]')).toBeVisible();
}

/**
 * A right click delivered to `target` itself at a viewport point. Built in the
 * page as a real MouseEvent: Playwright's locator.dispatchEvent has no mapping
 * for 'contextmenu' and sends a bare Event, whose clientX/clientY are undefined,
 * so the menu got NaN coordinates and was drawn outside the viewport.
 */
async function dispatchContextMenu(target: Locator, clientX: number, clientY: number): Promise<void> {
  await target.evaluate((element, point) => {
    element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: point.x, clientY: point.y,
    }));
  }, { x: clientX, y: clientY });
}

async function closeContextMenu(page: Page): Promise<void> {
  // The menu takes focus one frame after it is drawn. A synthetic right click
  // never moves focus on its own, so an Escape pressed before that frame still
  // lands in the terminal, whose xterm stops the key before the menu sees it.
  await expect.poll(async () => page.evaluate(() =>
    document.activeElement?.closest('.context-menu') !== null), { timeout: 5000 }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(contextMenu(page)).toHaveCount(0);
}

/** Right click on the list's blank area; the rows container resolves it to 'empty'. */
async function openEmptySpaceMenu(page: Page): Promise<void> {
  const rows = activePanel(page).locator('.fx-rows');
  const box = await rows.boundingBox();
  if (!box) throw new Error('explorer rows container has no bounding box');
  await dispatchContextMenu(rows, box.x + box.width / 2, box.y + box.height - 2);
  await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
}

async function computedOpacity(locator: Locator): Promise<number> {
  return locator.evaluate(element => Number.parseFloat(getComputedStyle(element).opacity));
}

async function selectedRowNames(page: Page): Promise<string[]> {
  const names = await activePanel(page).locator('.fx-row[aria-selected="true"]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-name') ?? ''));
  return names.sort();
}

/**
 * A point on the visible terminal that no window covers. The explorer and the
 * editor float over the terminal, so a click at its centre would land on them.
 */
async function uncoveredTerminalPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const screen = Array.from(document.querySelectorAll<HTMLElement>('.xterm-screen'))
      .find(element => element.offsetParent !== null);
    const terminal = screen?.closest('.xterm');
    if (!screen || !terminal) return null;
    const rect = screen.getBoundingClientRect();
    for (const fy of [0.1, 0.5, 0.9]) {
      for (const fx of [0.05, 0.5, 0.95]) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && terminal.contains(hit)) return { x, y };
      }
    }
    return null;
  });
  if (!point) throw new Error('every probed point of the terminal is covered by a window');
  return point;
}

async function focusTerminalByClick(page: Page): Promise<void> {
  const { x, y } = await uncoveredTerminalPoint(page);
  await page.mouse.click(x, y);
  await expect.poll(async () => page.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea') ?? false), { timeout: 5000 }).toBe(true);
}

/**
 * Which window's layer is on top, and whether that top is unique. Only layers
 * whose window is shown count: every workspace's windows stay mounted.
 */
async function frontmostWindow(page: Page): Promise<{ surfaceClass: string | null; tie: boolean }> {
  return page.evaluate(() => {
    const layers = Array.from(document.querySelectorAll<HTMLElement>('.window-dialog-layer')).filter((layer) => {
      const frame = layer.querySelector<HTMLElement>('.window-dialog');
      const surface = layer.querySelector<HTMLElement>('.window-dialog-surface');
      return frame !== null && surface !== null
        && getComputedStyle(frame).display !== 'none' && getComputedStyle(surface).display !== 'none';
    });
    const scored = layers.map(layer => ({
      layer, z: Number.parseInt(getComputedStyle(layer).zIndex, 10) || 0,
    })).sort((a, b) => a.z - b.z);
    const top = scored[scored.length - 1];
    if (!top) return { surfaceClass: null, tie: false };
    const tie = scored.filter(item => item.z === top.z).length > 1;
    return { surfaceClass: top.layer.querySelector('.window-dialog-surface')?.className ?? null, tie };
  });
}

async function expectExplorerFrontmost(page: Page): Promise<void> {
  await expect.poll(async () => frontmostWindow(page), { timeout: 5000 })
    .toEqual({ surfaceClass: expect.stringContaining('fx-window'), tie: false });
}

async function expectEditorFrontmost(page: Page): Promise<void> {
  await expect.poll(async () => frontmostWindow(page), { timeout: 5000 })
    .toEqual({ surfaceClass: expect.stringContaining('editor-window-surface'), tie: false });
}

async function chooseFromSessionPathMenu(page: Page, label: string): Promise<void> {
  await page.locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  await expect(contextMenu(page)).toBeVisible({ timeout: 10000 });
  await menuItem(page, label).first().click();
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/file-explorer-${name}.png` });
}

// ---------------------------------------------------------------------------

test.describe('file explorer (browser-only acceptance criteria)', () => {
  let record: FixtureRecord;
  let ownerId: string;
  let apiCreationStarted = false;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only; the mobile case sets its own viewport');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(180000);
    record = {
      token: null, workspaceId: null, workspaceName: null, baseSessionId: null,
      folder: null, sessionId: null, workTabName: null, root: null,
    };
    ownerId = `file-explorer/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    apiCreationStarted = true;
    await setUpFixture(page, request, ownerId, record);
  });

  test.afterEach(async ({ page, request }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await tearDownFixture(request, ownerId, record, apiCreationStarted);
    apiCreationStarted = false;
  });

  // TC-REQ-FR-FEX-002-AC8-09
  test('목록 모드: listDirectory 항목 수 == DOM 행 수, 첫·끝 이름으로 행 조회', async ({ page, request }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    await activePanel(page).locator('.fx-list-row[data-name="bulk"]').dblclick();
    const pathLabel = activePanel(page).locator('.fx-path');
    await expect(pathLabel).toHaveAttribute('title', /[\\/]bulk$/, { timeout: 15000 });
    const bulkPath = (await pathLabel.getAttribute('title'))!;

    const entries = await listDirectory(request, record.token!, record.sessionId!, bulkPath);
    expect(entries, 'the fixture folder holds exactly what setup wrote').toHaveLength(BULK_COUNT);

    const rows = activePanel(page).locator('.fx-list-row');
    await expect(rows).toHaveCount(entries.length, { timeout: 15000 });
    const domNames = (await rows.evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-name') ?? ''))).sort();
    expect(domNames).toEqual(entries.map(entry => entry.name).sort());

    const first = entries[0].name;
    const last = entries[entries.length - 1].name;
    await expect(activePanel(page).locator(`.fx-list-row[data-name="${first}"]`)).toHaveCount(1);
    await expect(activePanel(page).locator(`.fx-list-row[data-name="${last}"]`)).toHaveCount(1);

    // The count only proves "every row is in the DOM" if some rows are off screen.
    const overflows = await activePanel(page).locator('.fx-scroll').evaluate((scroll) => {
      const bottom = scroll.getBoundingClientRect().bottom;
      const rowsBelow = Array.from(scroll.querySelectorAll('.fx-list-row'))
        .filter(row => row.getBoundingClientRect().top >= bottom);
      return rowsBelow.length;
    });
    expect(overflows, 'rows outside the scroll viewport').toBeGreaterThan(0);
    await screenshot(page, 'list-all-rows');
  });

  // TC-REQ-FR-FEX-002-AC1-09
  test('경로 막대 컨트롤이 ↑·경로·모드·새로 읽기·새 폴더 순으로 보인다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    const bar = activePanel(page).locator('.fx-pathbar');
    const controls = await bar.evaluate(element => Array.from(element.children).map(child =>
      (child.classList.contains('fx-path') ? 'path' : child.getAttribute('aria-label') ?? '?')));
    expect(controls).toHaveLength(5);
    expect(controls[0]).toBe('상위 폴더');
    expect(controls[1]).toBe('path');
    expect(['목록으로 보기', '트리로 보기']).toContain(controls[2]);
    expect(controls[3]).toBe('새로 읽기');
    expect(controls[4]).toBe('새 폴더');

    // DOM order is not screen order under flex `order` or `row-reverse`; read positions too.
    const children = bar.locator(':scope > *');
    const xs: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await expect(children.nth(index)).toBeVisible();
      const box = await children.nth(index).boundingBox();
      if (!box) throw new Error(`path bar control ${index} has no box`);
      xs.push(box.x);
    }
    for (let index = 1; index < xs.length; index += 1) {
      expect(xs[index], `control ${index} sits right of control ${index - 1}`).toBeGreaterThan(xs[index - 1]);
    }
    await expect(bar.locator('.fx-path')).toHaveText(record.root!);
  });

  // TC-REQ-FR-FEX-002-AC2-09
  test('목록 머리글이 이름·수정한 날짜·크기', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    await expect(activePanel(page).locator('.fx-list-header [role="columnheader"]'))
      .toHaveText(['이름', '수정한 날짜', '크기']);
  });

  // TC-REQ-FR-FEX-003-AC1-09
  test('헤더 버튼으로 연 창의 dialog id 가 file-explorer:{workspaceId}', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    const titleId = `file-explorer:${record.workspaceId!}-title`;
    await expect(page.locator(`[id="${titleId}"]`)).toHaveText('파일 탐색기');
    await expect(explorerWindow(page)).toHaveAttribute('aria-labelledby', titleId);
  });

  // TC-REQ-FR-FEX-003-AC2-09
  test('세 진입점을 연달아 눌러도 창은 하나이고 닫히지 않으며 앞으로 온다', async ({ page }) => {
    // 1) header button creates the window.
    await openExplorerFromHeader(page, record.root!);

    // Another window above it, so "comes to the front" has something to beat.
    await chooseFromSessionPathMenu(page, 'CLAUDE.md');
    await expect(page.locator('.editor-window-surface:visible')).toHaveCount(1, { timeout: 15000 });
    await expectEditorFrontmost(page);

    // 2) session path menu raises it.
    await chooseFromSessionPathMenu(page, '파일 탐색기');
    await expect(explorerWindow(page)).toHaveCount(1);
    await expectExplorerFrontmost(page);

    // 3) terminal menu raises it.
    await page.locator('.editor-window-surface:visible .window-dialog-titlebar').click();
    await expectEditorFrontmost(page);
    const { x, y } = await uncoveredTerminalPoint(page);
    await page.mouse.click(x, y, { button: 'right' });
    await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
    await menuItem(page, '파일 탐색기 열기').first().click();
    await expect(explorerWindow(page)).toHaveCount(1);
    await expectExplorerFrontmost(page);

    // The header button again is a raise, never a toggle.
    await page.locator('.editor-window-surface:visible .window-dialog-titlebar').click();
    await expectEditorFrontmost(page);
    await page.locator('button.header-action-button[aria-label="파일 탐색기"]').click();
    await expect(explorerWindow(page)).toHaveCount(1);
    await expectExplorerFrontmost(page);
    await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', record.root!);
    await screenshot(page, 'three-entry-points');
  });

  // TC-REQ-FR-FEX-010-AC5-09
  test('헤더 아이콘 버튼으로 열린다', async ({ page }) => {
    await expect(explorerWindow(page)).toHaveCount(0);
    await openExplorerFromHeader(page, record.root!);
    await expect(rowNamed(page, 'CLAUDE.md')).toBeVisible();
    await expect(rowNamed(page, 'blob.dat')).toBeVisible();
  });

  // TC-REQ-FR-FEX-006-AC2-09
  test('다중 선택 위 우클릭이 선택을 유지한다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    await rowNamed(page, 'alpha.md').click();
    await rowNamed(page, 'beta.md').click({ modifiers: ['Control'] });
    expect(await selectedRowNames(page)).toEqual(['alpha.md', 'beta.md']);

    await rowNamed(page, 'beta.md').click({ button: 'right' });
    await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
    expect(await selectedRowNames(page)).toEqual(['alpha.md', 'beta.md']);

    // Control: a right click on an unselected row does replace the selection, so
    // the half above is not passing because right clicks never touch it.
    await closeContextMenu(page);
    await rowNamed(page, 'CLAUDE.md').click({ button: 'right' });
    await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
    await expect.poll(async () => selectedRowNames(page)).toEqual(['CLAUDE.md']);
  });

  // TC-REQ-FR-FEX-006-AC3-09
  test('빈 곳 우클릭 메뉴가 붙여넣기·새 폴더·새로 읽기 셋', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    await openEmptySpaceMenu(page);
    await expect(contextMenu(page).locator('.context-menu-item .context-menu-label'))
      .toHaveText(['붙여넣기', '새 폴더', '새로 읽기']);

    // Control: a row's menu is the longer one, so the three above are a choice.
    await closeContextMenu(page);
    await rowNamed(page, 'alpha.md').click({ button: 'right' });
    await expect(menuItem(page, '복사')).toHaveCount(1);
  });

  // TC-REQ-FR-FEX-005-AC6-09
  test('터미널에 포커스가 있을 때 Ctrl+C 가 터미널로 가고 탐색기 클립보드가 비어 있다(붙여넣기 비활성)', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    // A selection exists, so a copy that leaked into the explorer would have content.
    await rowNamed(page, 'alpha.md').click();
    expect(await selectedRowNames(page)).toEqual(['alpha.md']);

    await focusTerminalByClick(page);
    await page.keyboard.press('Control+c');
    // Focus stayed in the terminal: the key was the terminal's.
    expect(await page.evaluate(() =>
      document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)).toBe(true);

    await openEmptySpaceMenu(page);
    await expect(menuItem(page, '붙여넣기')).toHaveAttribute('aria-disabled', 'true');

    // Control: the same key inside the explorer does fill its clipboard.
    await closeContextMenu(page);
    await rowNamed(page, 'alpha.md').click();
    await page.keyboard.press('Control+c');
    await openEmptySpaceMenu(page);
    await expect(menuItem(page, '붙여넣기')).toHaveAttribute('aria-disabled', 'false');
  });

  // TC-REQ-FR-FEX-005-AC2-09
  test('잘라내기한 행이 흐리게(opacity<1) 그려진다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    const cut = rowNamed(page, 'alpha.md');
    const untouched = rowNamed(page, 'beta.md');
    expect(await computedOpacity(cut), 'before cutting').toBe(1);

    await cut.click();
    await page.keyboard.press('Control+x');
    await expect(cut).toHaveClass(/(^|\s)cut(\s|$)/);
    await expect.poll(async () => computedOpacity(cut)).toBeLessThan(1);
    expect(await computedOpacity(untouched), 'a row not on the clipboard').toBe(1);
    await expect(untouched).not.toHaveClass(/(^|\s)cut(\s|$)/);
  });

  // TC-REQ-FR-FEX-005-AC8-09
  test('모바일 뷰포트에서 버튼 줄 여섯 개, 클립보드가 비면 붙여넣기 비활성', async ({ page }) => {
    // Workspace and tab were chosen at desktop width, where the sidebar is shown.
    await page.setViewportSize({ width: 390, height: 844 });
    await openExplorerFromHeader(page, record.root!);
    const bar = activePanel(page).locator('.fx-mobile-bar[role="toolbar"][aria-label="파일 작업"]');
    await expect(bar).toBeVisible();
    const buttons = bar.locator('button.fx-mobile-button');
    await expect(buttons).toHaveCount(6);
    await expect(buttons).toHaveText(['복사', '잘라내기', '붙여넣기', '삭제', '이름 바꾸기', '새 폴더']);
    const paste = buttons.filter({ hasText: '붙여넣기' });
    await expect(paste).toBeDisabled();

    // Control: once something is copied the same button is enabled.
    await rowNamed(page, 'alpha.md').click();
    await buttons.filter({ hasText: '복사' }).click();
    await expect(paste).toBeEnabled();
    await screenshot(page, 'mobile-bar');
  });

  // TC-REQ-FR-FEX-011-AC5-09
  test('열 수 없는 파일 행이 흐리고 더블클릭해도 편집기 창이 뜨지 않는다', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/files/read')) reads.push(decodeURIComponent(request.url()));
    });
    await openExplorerFromHeader(page, record.root!);
    const unopenable = rowNamed(page, 'blob.dat');
    const openable = rowNamed(page, 'alpha.md');
    await expect(unopenable).toHaveClass(/(^|\s)unopenable(\s|$)/);
    await expect.poll(async () => computedOpacity(unopenable.locator('.fx-name'))).toBeLessThan(1);
    expect(await computedOpacity(openable.locator('.fx-name')), 'an openable row').toBe(1);

    await unopenable.dblclick();
    // Control second: double clicks are handled in order, so once the openable
    // file's window is up, the unopenable one had its chance to open first.
    await openable.dblclick();
    await expect(page.locator('.editor-window-surface:visible')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.editor-window-surface:visible .editor-document-panel[data-document-id$="alpha.md"]'))
      .toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.editor-document-panel[data-document-id$="blob.dat"]')).toHaveCount(0);
    expect(reads.some(url => url.endsWith('alpha.md'))).toBe(true);
    expect(reads.filter(url => url.endsWith('blob.dat'))).toEqual([]);
  });

  // TC-REQ-FR-FEX-005-AC5-09
  test('DR-12: 창 안 삭제 확인 줄·결정 줄이 떠 있는 동안 터미널이 키 입력을 받는다', async ({ page, request }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureListMode(page);
    const namesBefore = (await listDirectory(request, record.token!, record.sessionId!, record.root!))
      .map(entry => entry.name).sort();

    // Delete confirmation row.
    await rowNamed(page, 'alpha.md').click();
    await page.keyboard.press('Delete');
    // Step 4 (FR-FEX-005 AC-5, FR-FEX-007) replaced the in-panel rows with a
    // window-scoped modal; the question is the same, only its box moved.
    const confirmRow = explorerWindow(page).locator('.fx-window-modal-box[role="alertdialog"][aria-label="삭제 확인"]');
    await expect(confirmRow).toBeVisible({ timeout: 5000 });
    await focusTerminalByClick(page);
    const deleteMarker = `fxdr12d${randomUUID().slice(0, 6)}`;
    await page.keyboard.type(deleteMarker);
    await expectTerminalScreenContains(page, deleteMarker);
    await expect(confirmRow).toBeVisible();
    await confirmRow.getByRole('button', { name: '취소', exact: true }).click();
    await expect(confirmRow).toHaveCount(0);

    // Decision row: an in-place paste is a conflict the server asks about.
    await rowNamed(page, 'alpha.md').click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    const decisionRow = explorerWindow(page).locator('.fx-window-modal-box[role="alertdialog"][aria-label="이미 있는 항목"]');
    await expect(decisionRow).toBeVisible({ timeout: 15000 });
    await focusTerminalByClick(page);
    const decisionMarker = `fxdr12j${randomUUID().slice(0, 6)}`;
    await page.keyboard.type(decisionMarker);
    await expectTerminalScreenContains(page, decisionMarker);
    await expect(decisionRow).toBeVisible();
    await screenshot(page, 'dr12-decision-row');
    // FR-FEX-007 AC-6: the name-conflict choices are 덮어쓰기·이름 바꾸기·복사하지 않기.
    await decisionRow.getByRole('button', { name: '복사하지 않기', exact: true }).click();
    await expect(decisionRow).toHaveCount(0, { timeout: 15000 });

    // Neither row acted on its own: nothing was deleted and nothing was copied.
    await expect.poll(async () => (await listDirectory(request, record.token!, record.sessionId!, record.root!))
      .map(entry => entry.name).sort()).toEqual(namesBefore);
  });

  // TC-REQ-SEC-FOP-001-AC5-09
  test('↑ 가 거부되면 경로 막대에 오류가 보이고 뿌리가 그대로다(거부 경로가 없는 환경이면 route 가로채기로 403 주입)', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    const root = record.root!;
    const trimmedRoot = root.replace(/[\\/]+$/, '');
    const up = activePanel(page).locator('button[aria-label="상위 폴더"]');
    await expect(up, 'the server listed a parent for the test folder').toBeEnabled();

    // Refuse any listing of an ancestor of the root on the work session.
    const intercepted: string[] = [];
    await page.route((url) => {
      if (url.pathname !== `/api/sessions/${record.sessionId!}/files`) return false;
      const target = url.searchParams.get('path');
      if (target === null) return false;
      const trimmedTarget = target.replace(/[\\/]+$/, '');
      return trimmedTarget !== trimmedRoot && trimmedRoot.startsWith(trimmedTarget);
    }, async (route) => {
      intercepted.push(route.request().url());
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'PATH_BLOCKED', message: 'e2e-injected-refusal' } }),
      });
    });

    await up.click();
    const alert = activePanel(page).locator('.fx-pathbar-error[role="alert"]');
    await expect(alert).toContainText('e2e-injected-refusal', { timeout: 10000 });
    expect(intercepted, 'exactly the one parent listing was refused').toHaveLength(1);
    await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', root);
    await expect(rowNamed(page, 'alpha.md')).toBeVisible();
    await screenshot(page, 'up-refused');
  });

  // FR-FEX-010 AC-7: one window per workspace, but each terminal opens its own directory.
  test('두 번째 터미널에서 열면 그 터미널의 cwd 탭이 생기고, 첫 터미널로 돌아와 열면 그 탭이 앞으로 온다', async ({ page, request }) => {
    const workRoot = record.root!;
    const baseRoot = await sessionCwd(request, record.token!, record.baseSessionId!);
    expect(baseRoot, 'the two terminals are in different directories').not.toBe(workRoot);
    const tabs = explorerWindow(page).locator('.fx-tab[role="tab"]');
    const pathLabel = activePanel(page).locator('.fx-path');
    const header = page.locator('button.header-action-button[aria-label="파일 탐색기"]');

    await openExplorerFromHeader(page, workRoot);
    await expect(tabs).toHaveCount(1);

    // The window sits over the workspace tab bar; minimize it to reach the other
    // terminal, as a user would. Opening again restores and raises it.
    const minimize = explorerWindow(page).locator('.fx-window-actions button[aria-label="최소화"]');
    await minimize.click();
    await expect(explorerWindow(page)).toHaveCount(0);

    // The other terminal: the open window must gain a tab rooted where it is.
    await selectTab(page, `${TAB_NAME_PREFIX}-base`);
    await header.click();
    await expect(tabs).toHaveCount(2, { timeout: 15000 });
    await expect(pathLabel).toHaveAttribute('title', baseRoot, { timeout: 15000 });
    await expect(explorerWindow(page).locator('.fx-tab[aria-selected="true"]')).toHaveAttribute('title', baseRoot);

    // Back to the first terminal: its tab comes forward, no duplicate.
    await minimize.click();
    await expect(explorerWindow(page)).toHaveCount(0);
    await selectTab(page, record.workTabName!);
    await header.click();
    await expect(pathLabel).toHaveAttribute('title', workRoot, { timeout: 15000 });
    await expect(tabs).toHaveCount(2);
    await expect(rowNamed(page, 'alpha.md')).toBeVisible();
    await screenshot(page, 'second-terminal-own-tab');
  });
});

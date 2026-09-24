// File explorer step 4 browser-only acceptance criteria (T-PH005-01): the
// window-scoped modal, minimize and the header tray, the job status bar and its
// popover, reviving a window that has a question waiting, and the editor
// window's left file-tree pane.
//
// Authoring only: this spec has not been executed. It needs BUILDERGATE_PASSWORD
// and a verified external runtime on https://localhost:2222; it never starts a
// server and never reuses a webServer (playwright.file-explorer.config.ts).
// Before running: `pgrep -af 'playwright test' | grep -v pgrep` must be empty.
//
// Fixture shape, per test (the same as file-explorer.spec.ts):
//   * one workspace created through createOwnedWorkspaceViaApi under an owner id
//     this spec makes, and removed only through cleanupOwnedWorkspaces for that
//     owner -- nothing the user owns is touched, nothing is deleted by prefix;
//   * a "base" tab whose session cwd is where the test folder is created;
//   * a test folder `bg-fx4-e2e-<random>` under that cwd, filled over the file
//     API, and removed by its exact absolute path through the base session;
//   * a "work" tab whose cwd is the test folder, so the explorer and the editor
//     pane open on it.
//
// Weak assertions this spec avoids on purpose (what would satisfy them cheaply):
//   * "the modal is visible" -- a modal drawn over the whole page would pass. The
//     AC-1 case compares its box with the explorer surface and probes a point
//     outside the surface.
//   * "focus is in the modal after one Tab" -- a modal that never moves focus
//     would pass. The AC-2 case walks Tab both ways and requires every control
//     to be visited.
//   * "the window is back" after minimize -- a minimize that never hid it would
//     pass. The AC-2 tray case asserts the hidden state first.
//   * "a status bar appeared" -- a spinner with no file name would pass. The
//     AC-4 case records every status bar state through a MutationObserver and
//     requires a bar whose text is one of the copied file names.
//   * "Delete in the document did not delete the file" alone -- a pane whose
//     Delete never works would pass. The control half shows Delete in the pane
//     does ask to delete.
//   * "the pane is narrower than before" after a drag -- any fixed width would
//     pass. The splitter case measures the width against half the window.

import { randomUUID } from 'node:crypto';

import {
  test, expect, createOwnedWorkspaceViaApi,
  type APIRequestContext, type Locator, type Page,
} from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { expectTerminalScreenContains, login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const TAB_NAME_PREFIX = 'e2e-fx4';
const BULK_COUNT = 20;
/** Enough bytes that a copy spans several progress events, so the bar is drawn. */
const BIG_COUNT = 300;
const BIG_FILE_BYTES = 64 * 1024;
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
  return body.entries.filter(entry => entry.name !== '..');
}

async function listedNames(
  request: APIRequestContext, record: FixtureRecord, path: string,
): Promise<string[]> {
  return (await listDirectory(request, record.token!, record.sessionId!, path)).map(entry => entry.name).sort();
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

  const folderName = `bg-fx4-e2e-${suffix}`;
  await makeDirectory(request, token, base.sessionId, baseCwd, folderName);
  const folder = joinPath(baseCwd, folderName);
  record.folder = folder;

  for (const name of ['CLAUDE.md', 'alpha.md', 'beta.md']) {
    await writeFile(request, token, base.sessionId, joinPath(folder, name), `# ${name}\n\nfixture body\n`);
  }
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
  if (failures.length > 1) throw new AggregateError(failures, 'file explorer step 4 fixture teardown failed');
}

// ---------------------------------------------------------------------------
// Locators and actions
// ---------------------------------------------------------------------------

/**
 * A drawn terminal is not a ready shell: keystrokes sent before the shell prints
 * its prompt are dropped, which showed up as typed markers never reaching the
 * screen when many sessions start back to back. The prompt names the work
 * folder, so seeing it means the shell is taking input. Only the cases that type
 * into the terminal need this.
 */
async function waitForShellPrompt(page: Page, folder: string): Promise<void> {
  const folderName = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
  await expect(page.locator('.xterm-screen:visible').first()).toContainText(folderName, { timeout: 60000 });
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

/** The explorer's window-scoped modal box, by the title the model gives it. */
function explorerModal(page: Page, title: string): Locator {
  return explorerWindow(page).locator(`.fx-window-modal-box[role="alertdialog"][aria-label="${title}"]`);
}

function contextMenu(page: Page): Locator {
  return page.locator('.context-menu[role="menu"]:visible');
}

function menuItem(page: Page, label: string): Locator {
  return contextMenu(page).locator('.context-menu-item')
    .filter({ has: page.getByText(label, { exact: true }) });
}

function statusBar(page: Page): Locator {
  return page.locator('.fx-job-statusbar[role="button"]');
}

function jobPopover(page: Page): Locator {
  return page.locator('.fx-job-popover[role="dialog"][aria-label="파일 작업"]');
}

function editorWindow(page: Page): Locator {
  return page.locator('.editor-window-surface:visible');
}

function treePane(page: Page): Locator {
  return editorWindow(page).locator('.editor-tree-pane');
}

function paneRow(page: Page, name: string): Locator {
  return treePane(page).locator(`.fx-row[data-name="${name}"]`);
}

function editorContent(page: Page): Locator {
  return editorWindow(page).locator('.editor-document-panel:visible .cm-content');
}

async function openExplorerFromHeader(page: Page, root: string): Promise<void> {
  await page.locator('button.header-action-button[aria-label="파일 탐색기"]').click();
  await expect(explorerWindow(page)).toHaveCount(1, { timeout: 15000 });
  await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', root, { timeout: 15000 });
  await expect(rowNamed(page, 'alpha.md')).toBeVisible({ timeout: 15000 });
}

async function ensureMode(page: Page, mode: 'list' | 'tree'): Promise<void> {
  const toggle = activePanel(page).locator('button.fx-mode-toggle');
  // The toggle is labelled with the mode it switches to.
  const labelWhenInMode = mode === 'list' ? '트리로 보기' : '목록으로 보기';
  if ((await toggle.getAttribute('aria-label')) !== labelWhenInMode) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', labelWhenInMode);
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

/** Right click on a rows container's blank area; the container resolves it to 'empty'. */
async function openEmptySpaceMenuOn(page: Page, rows: Locator): Promise<void> {
  const box = await rows.boundingBox();
  if (!box) throw new Error('rows container has no bounding box');
  await dispatchContextMenu(rows, box.x + box.width / 2, box.y + box.height - 2);
  await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
}

async function selectedRowNames(scope: Locator): Promise<string[]> {
  const names = await scope.locator('.fx-row[aria-selected="true"]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-name') ?? ''));
  return names.sort();
}

async function expandedRowNames(page: Page): Promise<string[]> {
  const names = await activePanel(page).locator('.fx-row[aria-expanded="true"]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-name') ?? ''));
  return names.sort();
}

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

async function chooseFromSessionPathMenu(page: Page, label: string): Promise<void> {
  await page.locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  await expect(contextMenu(page)).toBeVisible({ timeout: 10000 });
  await menuItem(page, label).first().click();
}

/** Copies alpha.md onto itself: the server stops the job and asks, and the job stays open. */
async function startInPlaceConflict(page: Page): Promise<Locator> {
  await ensureMode(page, 'list');
  await rowNamed(page, 'alpha.md').click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  const modal = explorerModal(page, '이미 있는 항목');
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(modal.locator('.fx-window-modal-message')).toContainText('alpha.md');
  return modal;
}

/** The header tray's rows for explorer windows, as their labels. */
async function openTrayAndReadExplorerRows(page: Page): Promise<string[]> {
  await page.locator('button.header-editor-tray-button[aria-label="편집기 창"]').click();
  await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
  const labels = await contextMenu(page).locator('.context-menu-item .context-menu-label').allTextContents();
  return labels.filter(label => label.startsWith('파일 탐색기 — '));
}

/** Opens the editor on CLAUDE.md and unfolds its file-tree pane through the window menu. */
async function openEditorWithPane(page: Page): Promise<void> {
  await chooseFromSessionPathMenu(page, 'CLAUDE.md');
  await expect(editorWindow(page)).toHaveCount(1, { timeout: 15000 });
  await expect(editorContent(page)).toContainText('fixture body', { timeout: 15000 });

  // The host's own blank space is 'tabbar-empty', where the window menu opens.
  const host = editorWindow(page).locator('.editor-tab-bar-host');
  const box = await host.boundingBox();
  if (!box) throw new Error('editor tab bar host has no bounding box');
  await dispatchContextMenu(host, box.x + box.width - 4, box.y + box.height / 2);
  await expect(contextMenu(page)).toBeVisible({ timeout: 5000 });
  await menuItem(page, '파일 트리').click();
  await expect(treePane(page)).toBeVisible({ timeout: 15000 });
  await expect(paneRow(page, 'alpha.md')).toBeVisible({ timeout: 15000 });
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no bounding box');
  return box.width;
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/file-explorer-step4-${name}.png` });
}

// ---------------------------------------------------------------------------

test.describe('file explorer step 4 (browser-only acceptance criteria)', () => {
  let record: FixtureRecord;
  let ownerId: string;
  let apiCreationStarted = false;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(240000);
    record = {
      token: null, workspaceId: null, workspaceName: null, baseSessionId: null,
      folder: null, sessionId: null, workTabName: null, root: null,
    };
    ownerId = `file-explorer-step4/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    apiCreationStarted = true;
    await setUpFixture(page, request, ownerId, record);
  });

  test.afterEach(async ({ page, request }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await tearDownFixture(request, ownerId, record, apiCreationStarted);
    apiCreationStarted = false;
  });

  // TC-REQ-FR-FEX-007-AC1-09
  test('결정 모달의 bounding box 가 탐색기 창 표면 안에 있다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureMode(page, 'list');
    await rowNamed(page, 'alpha.md').click();
    await page.keyboard.press('Delete');
    const box = explorerModal(page, '삭제 확인');
    await expect(box).toBeVisible({ timeout: 5000 });

    const surface = await explorerWindow(page).boundingBox();
    const body = await explorerWindow(page).locator('.fx-window-body').boundingBox();
    const modalBox = await box.boundingBox();
    const scrim = await explorerWindow(page).locator('.fx-window-modal-scrim').boundingBox();
    if (!surface || !body || !modalBox || !scrim) throw new Error('surface, body, modal or scrim has no box');
    const inside = (inner: { x: number; y: number; width: number; height: number }) =>
      inner.x >= surface.x - 1 && inner.y >= surface.y - 1
      && inner.x + inner.width <= surface.x + surface.width + 1
      && inner.y + inner.height <= surface.y + surface.height + 1;
    expect(modalBox.width * modalBox.height, 'the modal box is drawn').toBeGreaterThan(0);
    expect(inside(modalBox), 'the modal box lies inside the explorer surface').toBe(true);
    expect(inside(scrim), 'the scrim lies inside the explorer surface').toBe(true);
    // The scrim covers the window body, not a token corner of it.
    expect(Math.abs(scrim.width - body.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(scrim.height - body.height)).toBeLessThanOrEqual(1);

    // A point outside the surface still hits the page, not the modal.
    const { x, y } = await uncoveredTerminalPoint(page);
    const hitIsModal = await page.evaluate(({ px, py }) =>
      document.elementFromPoint(px, py)?.closest('.fx-window-modal') !== null, { px: x, py: y });
    expect(hitIsModal).toBe(false);
    await screenshot(page, 'modal-inside-window');
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
  });

  // TC-REQ-FR-FEX-007-AC2-09
  test('Tab 을 반복해도 포커스가 모달 컨트롤 안에서만 돈다', async ({ page, request }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureMode(page, 'list');
    const namesBefore = await listedNames(request, record, record.root!);
    await rowNamed(page, 'alpha.md').click();
    await page.keyboard.press('Delete');
    const box = explorerModal(page, '삭제 확인');
    await expect(box).toBeVisible({ timeout: 5000 });
    const controlLabels = (await box.locator('button, input').allTextContents()).map(text => text.trim()).sort();
    expect(controlLabels).toEqual(['삭제', '취소']);

    const focusedLabel = async (): Promise<string | null> => box.evaluate((element) => {
      const active = document.activeElement;
      return active !== null && element.contains(active) ? (active.textContent ?? '').trim() : null;
    });
    const visited = new Set<string>();
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      const label = await focusedLabel();
      expect(label, `focus after ${key} stays in the modal`).not.toBeNull();
      visited.add(label!);
    }
    // A trap that never moves focus would keep it on one control.
    expect([...visited].sort()).toEqual(controlLabels);

    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect(await listedNames(request, record, record.root!)).toEqual(namesBefore);
  });

  // TC-REQ-FR-FEX-007-AC4-09
  test('모달이 떠 있는 동안 터미널이 키 입력을 받는다', async ({ page, request }) => {
    await waitForShellPrompt(page, record.root!);
    await openExplorerFromHeader(page, record.root!);
    const namesBefore = await listedNames(request, record, record.root!);
    const modal = await startInPlaceConflict(page);

    await focusTerminalByClick(page);
    const marker = `fx4ac4${randomUUID().slice(0, 6)}`;
    await page.keyboard.type(marker);
    await expectTerminalScreenContains(page, marker);
    // Typing elsewhere did not answer or withdraw the question.
    await expect(modal).toBeVisible();
    // No global modal band either: no modal layer exists on the page.
    await expect(page.locator('.window-dialog-layer-modal')).toHaveCount(0);
    await screenshot(page, 'terminal-under-modal');

    await modal.getByRole('button', { name: '복사하지 않기', exact: true }).click();
    await expect(modal).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => listedNames(request, record, record.root!)).toEqual(namesBefore);
  });

  // TC-REQ-FR-FEX-004-AC2-09
  test('최소화 → 트레이 줄 → 되살리기 후 펼친 디렉터리와 선택이 그대로다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    await ensureMode(page, 'tree');
    await rowNamed(page, 'bulk').locator('.fx-expander').click();
    await expect(rowNamed(page, 'row-000.md')).toBeVisible({ timeout: 15000 });
    await rowNamed(page, 'beta.md').click();

    const before = {
      expanded: await expandedRowNames(page),
      selected: await selectedRowNames(activePanel(page)),
      mode: await activePanel(page).locator('button.fx-mode-toggle').getAttribute('aria-label'),
      root: await activePanel(page).locator('.fx-path').getAttribute('title'),
    };
    expect(before.expanded).toEqual(['bulk']);
    expect(before.selected).toEqual(['beta.md']);

    await explorerWindow(page).locator('.fx-window-actions button[aria-label="최소화"]').click();
    // Hidden first: a minimize that did nothing would make the rest pass.
    await expect(explorerWindow(page)).toHaveCount(0, { timeout: 5000 });

    const rows = await openTrayAndReadExplorerRows(page);
    expect(rows).toEqual([`파일 탐색기 — ${record.workspaceName!}`]);
    await menuItem(page, rows[0]).click();
    await expect(explorerWindow(page)).toHaveCount(1, { timeout: 5000 });

    await expect(rowNamed(page, 'row-000.md')).toBeVisible();
    expect({
      expanded: await expandedRowNames(page),
      selected: await selectedRowNames(activePanel(page)),
      mode: await activePanel(page).locator('button.fx-mode-toggle').getAttribute('aria-label'),
      root: await activePanel(page).locator('.fx-path').getAttribute('title'),
    }).toEqual(before);
    await screenshot(page, 'revived-from-tray');
  });

  // TC-REQ-FR-FEX-004-AC3-09
  test("트레이에 '파일 탐색기 — {워크스페이스}' 줄이 창당 하나", async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    // A second explorer tab and two terminal tabs: none of them may add a row.
    await explorerWindow(page).locator('button.fx-tab-add[aria-label="새 탭"]').click();
    await expect(explorerWindow(page).locator('.fx-tabs[role="tablist"] .fx-tab')).toHaveCount(2);
    await expect(page.locator('.workspace-tabbar [role="tab"]')).toHaveCount(2);

    const rows = await openTrayAndReadExplorerRows(page);
    expect(rows).toEqual([`파일 탐색기 — ${record.workspaceName!}`]);
    await closeContextMenu(page);

    // Still one row while the window is minimized: the tray is its way back.
    await explorerWindow(page).locator('.fx-window-actions button[aria-label="최소화"]').click();
    await expect(explorerWindow(page)).toHaveCount(0, { timeout: 5000 });
    expect(await openTrayAndReadExplorerRows(page)).toEqual([`파일 탐색기 — ${record.workspaceName!}`]);
  });

  // TC-REQ-FR-FEX-008-AC4-09
  test('큰 디렉터리 복사 중 하단 상태바에 막대와 파일 이름이 보이고 끝나면 자리를 비운다', async ({ page, request }) => {
    const token = record.token!;
    const baseSession = record.baseSessionId!;
    const folder = record.folder!;
    await makeDirectory(request, token, baseSession, folder, 'big');
    await makeDirectory(request, token, baseSession, folder, 'dest');
    const big = joinPath(folder, 'big');
    const payload = 'x'.repeat(BIG_FILE_BYTES);
    const bigNames: string[] = [];
    for (let index = 0; index < BIG_COUNT; index += 1) {
      const name = `big-${String(index).padStart(3, '0')}.dat`;
      bigNames.push(name);
      await writeFile(request, token, baseSession, joinPath(big, name), payload);
    }

    await openExplorerFromHeader(page, record.root!);
    await ensureMode(page, 'list');
    await expect(statusBar(page)).toHaveCount(0);

    // Every state the bar takes is recorded: a copy can finish between two polls.
    await page.evaluate(() => {
      const samples: Array<{ hasBar: boolean; hasSpinner: boolean; text: string }> = [];
      (window as unknown as { __fx4StatusSamples: typeof samples }).__fx4StatusSamples = samples;
      const sample = () => {
        const bar = document.querySelector('.fx-job-statusbar');
        if (bar === null) return;
        samples.push({
          hasBar: bar.querySelector('.fx-job-bar .fx-job-bar-fill') !== null,
          hasSpinner: bar.querySelector('.fx-job-spinner') !== null,
          text: (bar.querySelector('.fx-job-text')?.textContent ?? '').trim(),
        });
      };
      new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });

    await rowNamed(page, 'big').click();
    await page.keyboard.press('Control+c');
    await rowNamed(page, 'dest').dblclick();
    await expect(activePanel(page).locator('.fx-path')).toHaveAttribute('title', /[\\/]dest$/, { timeout: 15000 });
    await openEmptySpaceMenuOn(page, activePanel(page).locator('.fx-rows'));
    await menuItem(page, '붙여넣기').click();

    const copied = joinPath(joinPath(folder, 'dest'), 'big');
    await expect.poll(async () => {
      const names = await listDirectory(request, token, baseSession, copied).catch(() => [] as ListingEntry[]);
      return names.length;
    }, { timeout: 120000 }).toBe(BIG_COUNT);
    // It gives its row back once the job is done.
    await expect(statusBar(page)).toHaveCount(0, { timeout: 30000 });

    const samples = await page.evaluate(() =>
      (window as unknown as { __fx4StatusSamples: Array<{ hasBar: boolean; hasSpinner: boolean; text: string }> }).__fx4StatusSamples);
    const withBarAndName = samples.filter(sample => sample.hasBar && bigNames.includes(sample.text));
    expect(withBarAndName.length, `status bar samples: ${JSON.stringify(samples.slice(0, 20))}`).toBeGreaterThan(0);
  });

  // TC-REQ-FR-FEX-008-AC7-09
  test('상태바를 누르면 알림창이 열리고 바깥 클릭으로 닫히며 dialog stack 에 항목이 없다', async ({ page }) => {
    await openExplorerFromHeader(page, record.root!);
    // A job waiting on a question stays open, so the bar stays up for the test.
    const modal = await startInPlaceConflict(page);
    await expect(statusBar(page)).toBeVisible({ timeout: 15000 });
    const layersBefore = await page.locator('.window-dialog-layer').count();

    // The bar itself, left of everything in it: while the job waits on a question
    // no byte has moved, so the file-name span is empty (no height) and cannot
    // take a click, and the awaiting button would open the window instead.
    await statusBar(page).click({ position: { x: 3, y: 3 } });
    const popover = jobPopover(page);
    await expect(popover).toBeVisible({ timeout: 5000 });
    await expect(statusBar(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(popover.locator('.fx-job-item')).toHaveCount(1);

    // Not a window: no new dialog layer, not inside one, no resize handles.
    expect(await page.locator('.window-dialog-layer').count()).toBe(layersBefore);
    expect(await popover.evaluate(element => element.closest('.window-dialog-layer') === null)).toBe(true);
    const title = popover.locator('.fx-job-popover-title');
    const boxBefore = await popover.boundingBox();
    const titleBox = await title.boundingBox();
    if (!boxBefore || !titleBox) throw new Error('popover or its title has no box');
    await page.mouse.move(titleBox.x + 4, titleBox.y + titleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(titleBox.x - 120, titleBox.y - 80, { steps: 5 });
    await page.mouse.up();
    expect(await popover.boundingBox(), 'a drag on the title does not move it').toEqual(boxBefore);
    await screenshot(page, 'job-popover');

    // An outside press closes it.
    const { x, y } = await uncoveredTerminalPoint(page);
    await page.mouse.click(x, y);
    await expect(popover).toHaveCount(0, { timeout: 5000 });
    await expect(statusBar(page)).toHaveAttribute('aria-expanded', 'false');

    await modal.getByRole('button', { name: '복사하지 않기', exact: true }).click();
    await expect(modal).toHaveCount(0, { timeout: 15000 });
  });

  // TC-REQ-FR-FEX-009-AC2-09
  test("이름 충돌을 기다리는 중 창을 닫으면 상태바에 '응답 대기 중' 이 뜨고 누르면 창이 모달과 함께 열린다", async ({ page, request }) => {
    await openExplorerFromHeader(page, record.root!);
    const namesBefore = await listedNames(request, record, record.root!);
    await startInPlaceConflict(page);

    await explorerWindow(page).locator('.window-dialog-close[aria-label="Close"]').click();
    await expect(explorerWindow(page)).toHaveCount(0, { timeout: 5000 });
    const awaiting = statusBar(page).locator('button.fx-job-awaiting');
    await expect(awaiting).toHaveText('응답 대기 중', { timeout: 15000 });
    await screenshot(page, 'awaiting-after-close');

    await awaiting.click();
    await expect(explorerWindow(page)).toHaveCount(1, { timeout: 15000 });
    const modal = explorerModal(page, '이미 있는 항목');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(modal.locator('.fx-window-modal-message')).toContainText('alpha.md');
    // The popover is not what that press opened.
    await expect(jobPopover(page)).toHaveCount(0);

    await modal.getByRole('button', { name: '복사하지 않기', exact: true }).click();
    await expect(modal).toHaveCount(0, { timeout: 15000 });
    await expect(statusBar(page)).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => listedNames(request, record, record.root!)).toEqual(namesBefore);
  });

  // TC-REQ-FR-MDE-012-AC9-09
  test('CodeMirror 본문에서 누른 Delete 는 글자를 지우고 파일은 남는다', async ({ page, request }) => {
    await openEditorWithPane(page);
    // A selected file, so a Delete that leaked into the pane would have a target.
    await paneRow(page, 'alpha.md').click();
    expect(await selectedRowNames(treePane(page))).toEqual(['alpha.md']);

    const marker = `fx4del${randomUUID().slice(0, 6)}`;
    await editorContent(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(marker);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await expect(editorContent(page)).toContainText(marker.slice(0, -1));
    await expect(editorContent(page)).not.toContainText(marker);
    await expect(treePane(page).locator('[role="alertdialog"]')).toHaveCount(0);
    expect(await listedNames(request, record, record.root!)).toContain('alpha.md');
    expect(await selectedRowNames(treePane(page))).toEqual(['alpha.md']);

    // Control: the same key with focus in the pane does ask to delete.
    await paneRow(page, 'alpha.md').click();
    await page.keyboard.press('Delete');
    const confirm = treePane(page).locator('.fx-window-modal-box[role="alertdialog"][aria-label="삭제 확인"]');
    await expect(confirm).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(await listedNames(request, record, record.root!)).toContain('alpha.md');
  });

  // TC-REQ-FR-MDE-012-AC10-09
  test('스플리터를 창 폭 절반 너머로 끌면 절반에서 멈추고, 창을 줄였다 키우면 원래 폭으로 돌아온다', async ({ page }) => {
    await openEditorWithPane(page);
    const maximize = editorWindow(page).locator('.editor-window-actions button[aria-label="최대화"]');
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'true');
    const wide = await widthOf(editorWindow(page));

    const splitter = editorWindow(page).locator('.editor-tree-splitter[role="separator"]');
    const splitBox = await splitter.boundingBox();
    const windowBox = await editorWindow(page).boundingBox();
    if (!splitBox || !windowBox) throw new Error('splitter or window has no box');
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(windowBox.x + windowBox.width - 4, splitBox.y + splitBox.height / 2, { steps: 12 });
    await page.mouse.up();

    const dragged = await widthOf(treePane(page));
    // Far above the 212px default, so a pane that ignored the drag cannot pass.
    expect(wide / 2, 'the maximized window is wide enough to tell the cap from the default').toBeGreaterThan(300);
    expect(Math.abs(dragged - wide / 2), `pane ${dragged} vs half of ${wide}`).toBeLessThanOrEqual(2);
    await screenshot(page, 'pane-at-half');

    // Narrower: back to the floating rect.
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'false');
    const narrow = await widthOf(editorWindow(page));
    expect(narrow, 'the floating window is narrower than the maximized one').toBeLessThan(wide - 100);
    await expect.poll(async () => widthOf(treePane(page))).toBeLessThanOrEqual(narrow / 2 + 1);

    // Wider again: the width chosen by the drag comes back, not the clipped one.
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => Math.abs((await widthOf(treePane(page))) - dragged)).toBeLessThanOrEqual(2);
  });

  // TC-REQ-FR-FEX-005-AC7-09
  test('편집기 본문에서 Ctrl+C 는 텍스트를 복사하고 탐색기 클립보드는 비어 있다(패널 붙여넣기 비활성)', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await openEditorWithPane(page);
    // A selected file, so a copy that leaked into the pane would have content.
    await paneRow(page, 'alpha.md').click();

    await editorContent(page).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('# CLAUDE.md');

    const paneRows = treePane(page).locator('.fx-rows');
    await openEmptySpaceMenuOn(page, paneRows);
    await expect(menuItem(page, '붙여넣기')).toHaveAttribute('aria-disabled', 'true');

    // Control: the same key in the pane does fill the explorer clipboard.
    await closeContextMenu(page);
    await paneRow(page, 'alpha.md').click();
    await page.keyboard.press('Control+c');
    await openEmptySpaceMenuOn(page, paneRows);
    await expect(menuItem(page, '붙여넣기')).toHaveAttribute('aria-disabled', 'false');
  });
});

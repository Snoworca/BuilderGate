// FR-MDE-007 — the session path context menu is the only user action that opens
// an editor window, so every branch of it is judged here in a real browser.
//
// Each test runs against a directory this file creates, and a tab whose shell is
// started in it. That is what makes the 404 branch honest: `AGENTS.md` is absent
// on disk rather than absent because a route said so, and confirming the prompt
// really writes it. The one branch disk cannot produce -- a read that fails with
// something other than 404 -- is the only place a route is installed.
//
// The full cwd is read from the path bar's `title` attribute, never from its
// text: `truncatePath` collapses anything past 30 characters, so the text is a
// display string and the title is the value.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Locator, type Page } from '@playwright/test';

import { getActiveSessionId, login } from './helpers';

/** The three items the menu offers. AC-1 states the set, not an order. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] as const;

/** Names the spec gives the tabs it creates, so cleanup can find its own. */
const TAB_NAME_PREFIX = 'e2e-mde-entry';

/**
 * How long an absence claim waits before it is believed. A request that has not
 * been issued by now was not issued at all: every branch under test decides
 * synchronously once its dialog resolves, and no path here is debounced.
 */
const NO_REQUEST_SETTLE_MS = 700;

interface FileTraffic {
  reads: string[];
  writes: { url: string; body: string }[];
}

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A directory the shell can start in. `CLAUDE.md` and `CLAUDE.local.md` are
 * present so their reads succeed; `AGENTS.md` is deliberately absent, which is
 * how the 404 branch gets its 404 from the filesystem rather than from a stub.
 */
function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mde-'));
  writeFileSync(join(dir, 'CLAUDE.md'), '# from disk\n', 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.local.md'), '# local, from disk\n', 'utf-8');
  createdDirs.push(dir);
  return dir;
}

/**
 * The resolved absolute path as `resolveEditorFilePath` builds it: separators
 * unified to the one the cwd already uses, and no trailing separator.
 */
function resolveAgainst(cwd: string, fileName: string): string {
  const separator = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+/g, separator).replace(/[\\/]+$/, '');
  return `${base}${separator}${fileName}`;
}

/** Every read and write the page issues, from the moment this is installed. */
function recordFileTraffic(page: Page): FileTraffic {
  const traffic: FileTraffic = { reads: [], writes: [] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/files/read')) {
      traffic.reads.push(url);
      return;
    }
    if (url.includes('/files/write')) {
      traffic.writes.push({ url, body: request.postData() ?? '' });
    }
  });
  return traffic;
}

function pathOfRead(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
}

function readsFor(traffic: FileTraffic, filePath: string): string[] {
  return traffic.reads.filter(url => pathOfRead(url) === filePath);
}

function writesFor(traffic: FileTraffic, filePath: string): { url: string; body: string }[] {
  return traffic.writes.filter((write) => {
    try {
      return (JSON.parse(write.body) as { path?: string }).path === filePath;
    } catch {
      return false;
    }
  });
}

async function ensureTabMode(page: Page): Promise<void> {
  const toTabs = page.locator('button[title="Switch to Tabs"]');
  if (await toTabs.count()) {
    await toTabs.click();
  }
  await expect(page.locator('button[title="Switch to Grid"]')).toBeVisible({ timeout: 15000 });
}

async function ensureGridMode(page: Page): Promise<void> {
  const toGrid = page.locator('button[title="Switch to Grid"]');
  if (await toGrid.count()) {
    await toGrid.click();
  }
  await expect(page.locator('button[title="Switch to Tabs"]')).toBeVisible({ timeout: 15000 });
}

async function activeWorkspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const stored = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === stored)
      ?? state.workspaces[0];
    return workspace.id as string;
  });
}

async function readActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const stored = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === stored)
      ?? state.workspaces[0];
    return (workspace?.activeTabId as string | undefined) ?? null;
  });
}

/**
 * A tab whose shell starts in `cwd`. The cwd is handed to the PTY at creation
 * and reaches the tab record only when the shell reports it back, which is why
 * every caller then waits for the path bar rather than assuming.
 */
async function addTabAt(page: Page, workspaceId: string, cwd: string, name: string): Promise<string> {
  return page.evaluate(async ({ workspaceId, cwd, name }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
    const tab = await res.json();
    return tab.id as string;
  }, { workspaceId, cwd, name });
}

/**
 * Deletes the tabs this spec named, in the workspace it named them in. Scoped by
 * workspace as well as by prefix so the delete and the search agree on the same
 * set -- these specs share one live server with everything else in the run.
 */
async function removeOwnTabs(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, prefix }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/workspaces', { headers });
    if (!res.ok) return;
    const state = await res.json();
    const owned = state.tabs.filter((tab: { id: string; name?: string; workspaceId?: string }) =>
      typeof tab.name === 'string'
      && tab.name.startsWith(prefix)
      && (tab.workspaceId === undefined || tab.workspaceId === workspaceId));
    for (const tab of owned) {
      await fetch(`/api/workspaces/${workspaceId}/tabs/${tab.id}`, { method: 'DELETE', headers });
    }
  }, { workspaceId, prefix: TAB_NAME_PREFIX });
}

/** Select a tab by the name this spec gave it, in tab mode. */
async function selectTab(page: Page, name: string): Promise<void> {
  await page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first().click();
}

/**
 * The path bar of whichever tab is on screen, once its shell has reported a cwd.
 * Returns the full path, which is the value the menu resolves against.
 */
async function awaitReportedCwd(page: Page, expectedDir: string, scope?: Locator): Promise<string> {
  const pathBar = (scope ?? page).locator('.metadata-cwd-path:visible').first();
  await expect(pathBar).toHaveAttribute('title', new RegExp(escapeRegExp(expectedDir), 'i'), {
    timeout: 30000,
  });
  const cwd = await pathBar.getAttribute('title');
  if (!cwd) throw new Error('path bar reported an empty cwd');
  return cwd;
}

/** Right-click the path bar and wait for the menu it opens. */
async function openPathMenu(page: Page, scope?: Locator): Promise<Locator> {
  await (scope ?? page).locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  const menu = page.locator('.context-menu[role="menu"]').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  return menu;
}

async function chooseFile(page: Page, fileName: string, scope?: Locator): Promise<void> {
  const menu = await openPathMenu(page, scope);
  await menu.locator('.context-menu-item')
    .filter({ has: page.getByText(fileName, { exact: true }) })
    .first()
    .click();
}

/** Every editor window currently mounted, hidden ones included. */
function editorWindows(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface');
}

function editorWindowFor(page: Page, fileName: string): Locator {
  return editorWindows(page).filter({
    has: page.locator('.window-dialog-title').getByText(fileName, { exact: true }),
  });
}

/**
 * The stacking value the modeless layer paints with. `windowDialogModel` derives
 * it from the entry's index in its stack, so a raise is visible here as a change
 * in the order of two numbers -- which is what "raised to the front" means.
 */
async function layerZOf(page: Page, fileName: string): Promise<number> {
  const layer = page.locator('.window-dialog-layer-modeless').filter({
    has: page.locator('.editor-window-surface .window-dialog-title').getByText(fileName, { exact: true }),
  }).first();
  return layer.evaluate(element => Number.parseInt(getComputedStyle(element).zIndex, 10));
}

/**
 * How far `front` is in front of `back`, taken from one moment.
 *
 * Raising reindexes the whole stack, so both windows' z-index move together and
 * the highest value in a two-window stack is the same number before and after.
 * A comparison that read one side before the press would be waiting for the
 * other to exceed a value the stack no longer holds -- a wait nothing can end.
 */
async function zLead(page: Page, front: string, back: string): Promise<number> {
  return (await layerZOf(page, front)) - (await layerZOf(page, back));
}

test.describe('FR-MDE-007 session path context menu entry point', () => {
  let workspaceId: string | null = null;
  let traffic: FileTraffic;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only entry point coverage');
    await login(page);
    // No `waitForTerminal` here: a workspace can legitimately have no tabs at
    // all, and every test below creates the tab it needs with the cwd it needs.
    // Waiting for someone else's terminal would only couple this spec to
    // whatever the previous run happened to leave behind.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
    traffic = recordFileTraffic(page);
  });

  // Cleanup is not a test result: a teardown that cannot reach the server is a
  // missing convenience, and letting it throw would hand the next test both a
  // leaked tab and a failure that names the wrong cause. The project guard
  // matters because a skipped test never navigated the page at all.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await ensureTabMode(page);
      await removeOwnTabs(page, workspaceId);
    } catch {
      // Reported by the next test's own assertions if it actually mattered.
    }
  });

  test.afterAll(() => {
    for (const dir of createdDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temp directory the OS will reclaim anyway.
      }
    }
  });

  // TC-REQ-FR-MDE-007-AC1-03
  test('FR-MDE-007 tab mode right-click opens the three items and left click still copies', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac1`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);

    const menu = await openPathMenu(page);
    await expect(menu.locator('.context-menu-item')).toHaveCount(INSTRUCTION_FILES.length);
    // The AC states a set, so membership is what is asserted; the order the
    // builder happens to emit is not part of the contract.
    const labels = await menu.locator('.context-menu-label').allInnerTexts();
    expect([...labels].sort()).toEqual([...INSTRUCTION_FILES].sort());
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu[role="menu"]')).toHaveCount(0);

    // The copy handler is unchanged by the addition: a plain left click still
    // puts the full cwd on the clipboard and flips the label while it does.
    await page.locator('.metadata-cwd-path:visible').first().click();
    await expect(page.locator('.metadata-cwd-path:visible').first()).toHaveText('✓ Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cwd);
  });

  // TC-REQ-FR-MDE-007-AC2-01
  test('FR-MDE-007 grid mode right-click opens the same three items', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac2`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);

    await ensureGridMode(page);
    const tile = page.locator('.grid-cell')
      .filter({ has: page.getByTitle(cwd, { exact: true }) })
      .first();
    await expect(tile).toBeVisible({ timeout: 15000 });

    const menu = await openPathMenu(page, tile);
    await expect(menu.locator('.context-menu-item')).toHaveCount(INSTRUCTION_FILES.length);
    const labels = await menu.locator('.context-menu-label').allInnerTexts();
    expect([...labels].sort()).toEqual([...INSTRUCTION_FILES].sort());
    await page.keyboard.press('Escape');
  });

  // TC-REQ-FR-MDE-007-AC3-01
  test('FR-MDE-007 choosing an existing file opens a window that outlives the tab switch', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac3`;
    const otherName = `${TAB_NAME_PREFIX}-ac3-other`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await addTabAt(page, workspaceId!, makeWorkdir(), otherName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId).toBeTruthy();

    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindowFor(page, 'CLAUDE.md');
    await expect(surface).toBeVisible({ timeout: 15000 });

    // The read goes out on the bound tab's current session, for the path
    // resolved against the cwd the row displays.
    const expectedPath = resolveAgainst(cwd, 'CLAUDE.md');
    expect(readsFor(traffic, expectedPath).some(url =>
      url.includes(`/api/sessions/${sessionId}/files/read`))).toBe(true);

    // The window is placed inside the stage rather than against the viewport,
    // so the stage is what must contain it.
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    const box = await surface.boundingBox();
    expect(stage).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(stage!.x - 1);
    expect(box!.y).toBeGreaterThanOrEqual(stage!.y - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);

    // The window is bound to the workspace, not to the terminal tab it was
    // opened from. Switching terminal tabs leaves it on screen -- which is what
    // lets documents opened from several terminals sit in one window together --
    // and it is the same instance throughout, so nothing the user typed is lost
    // on the way.
    await selectTab(page, otherName);
    await expect(surface).toBeVisible({ timeout: 15000 });
    await expect(surface).toHaveCount(1);
    await selectTab(page, tabName);
    await expect(surface).toBeVisible({ timeout: 15000 });
    await expect(surface).toHaveCount(1);

    // The visibility that did survive is the workspace one, and asserting it
    // here is what stops the three checks above from passing against a window
    // that is simply always visible. Minimizing is the term the user controls.
    await surface.locator('button[aria-label="최소화"]').click();
    await expect(surface).toBeHidden({ timeout: 15000 });
    await expect(surface).toHaveCount(1);
  });

  // TC-REQ-FR-MDE-007-AC4-01
  test('FR-MDE-007 a missing file asks to create and honours cancel', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac4`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const expectedPath = resolveAgainst(cwd, 'AGENTS.md');

    // Cancel writes nothing and opens nothing.
    await chooseFile(page, 'AGENTS.md');
    const confirm = page.locator('.modal-overlay .modal-content');
    await expect(confirm).toBeVisible({ timeout: 15000 });
    await confirm.locator('.btn-cancel').click();
    await expect(confirm).toHaveCount(0);
    await page.waitForTimeout(NO_REQUEST_SETTLE_MS);
    expect(writesFor(traffic, expectedPath)).toHaveLength(0);
    await expect(editorWindows(page)).toHaveCount(0);

    // Confirming writes empty content and then opens the window.
    await chooseFile(page, 'AGENTS.md');
    await expect(confirm).toBeVisible({ timeout: 15000 });
    await confirm.locator('.btn-submit').click();

    await expect(editorWindowFor(page, 'AGENTS.md')).toBeVisible({ timeout: 15000 });
    const writes = writesFor(traffic, expectedPath);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].body)).toEqual({ path: expectedPath, content: '' });
  });

  // TC-REQ-FR-MDE-007-AC5-01
  test('FR-MDE-007 a non-404 read failure shows a MessageBox and opens no window', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac5`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // The only branch the filesystem cannot produce. 500 is what the server's
    // own error funnel returns for an unexpected fault, so the client sees the
    // shape it would really see.
    await page.route(
      url => url.pathname.includes('/files/read')
        && (url.searchParams.get('path') ?? '').endsWith('CLAUDE.md')
        && !(url.searchParams.get('path') ?? '').endsWith('CLAUDE.local.md'),
      route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'read failed' } }),
      }),
    );

    await chooseFile(page, 'CLAUDE.md');

    await expect(page.locator('.message-box-dialog')).toBeVisible({ timeout: 15000 });
    await expect(editorWindows(page)).toHaveCount(0);
  });

  // TC-REQ-FR-MDE-007-AC6-03
  test('FR-MDE-007 reopening the same file keeps exactly one window and raises it', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac6`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const reopened = resolveAgainst(cwd, 'CLAUDE.md');

    // Two windows, so that "raised to the front" has a front to be raised to.
    // The second one opened is on top until the first is chosen again.
    await chooseFile(page, 'CLAUDE.md');
    await expect(editorWindowFor(page, 'CLAUDE.md')).toBeVisible({ timeout: 15000 });
    await chooseFile(page, 'CLAUDE.local.md');
    await expect(editorWindowFor(page, 'CLAUDE.local.md')).toBeVisible({ timeout: 15000 });
    expect(await zLead(page, 'CLAUDE.local.md', 'CLAUDE.md')).toBeGreaterThan(0);

    const readsBefore = readsFor(traffic, reopened).length;
    const writesBefore = writesFor(traffic, reopened).length;

    await chooseFile(page, 'CLAUDE.md');

    // Still two windows in total and one for this path; the reopened one is now
    // in front; and the revival issued no I/O for it.
    await expect(editorWindows(page)).toHaveCount(2);
    await expect(editorWindowFor(page, 'CLAUDE.md')).toHaveCount(1);
    await expect.poll(async () => zLead(page, 'CLAUDE.md', 'CLAUDE.local.md'), { timeout: 10000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(NO_REQUEST_SETTLE_MS);
    expect(readsFor(traffic, reopened)).toHaveLength(readsBefore);
    expect(writesFor(traffic, reopened)).toHaveLength(writesBefore);
  });

  // TC-REQ-FR-MDE-007-AC7-03
  test('FR-MDE-007 two tabs sharing a cwd keep one window bound to the first tab', async ({ page }) => {
    const workdir = makeWorkdir();
    const firstName = `${TAB_NAME_PREFIX}-ac7-a`;
    const secondName = `${TAB_NAME_PREFIX}-ac7-b`;
    const firstTabId = await addTabAt(page, workspaceId!, workdir, firstName);
    await addTabAt(page, workspaceId!, workdir, secondName);

    await selectTab(page, firstName);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');
    await expect(editorWindowFor(page, 'CLAUDE.md')).toBeVisible({ timeout: 15000 });

    await selectTab(page, secondName);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    // One window for the path, and it stayed with the tab that opened it: the
    // revival brings that tab forward rather than rebinding the window.
    await expect(editorWindowFor(page, 'CLAUDE.md')).toHaveCount(1);
    await expect.poll(async () => readActiveTabId(page), { timeout: 15000 }).toBe(firstTabId);
  });
});

// Saving, and what happens to a window when the tab it is bound to changes
// underneath it.
//
// Two things here are easy to get wrong in a test and are done deliberately.
//
//   * Focus is moved by calling `focus()` on the element, never by clicking it.
//     A press would raise the window, and the criterion that separates "focused"
//     from "frontmost" needs those two to be different windows.
//
//   * A session is taken away from a live tab by deleting the session, not the
//     tab. The two look similar on screen and mean opposite things to a window:
//     a dead session keeps the binding, a closed tab ends it.
//
// The tray-revival criterion reads the terminal host registry through
// `__buildergateEditorWindowDebug`, the same read-only hook the placement and
// lifecycle specs declare.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Locator, type Page } from '@playwright/test';

// #53: `test` comes from the ownership fixture, not from @playwright/test. The fixture is
// auto-attached, so every POST /api/workspaces this spec makes -- including the ones made
// from inside the page -- is registered as owned, and deletion goes through the registry
// instead of a raw DELETE that no guard can see.
import { login } from './helpers';
import { test, expect, deleteOwnedWorkspaceForContext } from './workspaceOwnershipFixture';

declare global {
  interface Window {
    __buildergateEditorWindowDebug?: {
      readTerminalHost(tabId: string): {
        isVisible: boolean;
        rect: { left: number; top: number; width: number; height: number };
      } | undefined;
      readEditorProbe(filePath: string): {
        documentId: string;
        markdownSource: string;
        extensionsToken: number;
      } | undefined;
      setEditorReadOnly(filePath: string, readOnly: boolean): boolean;
    };
  }
}

const TAB_NAME_PREFIX = 'e2e-mde-save';
const FILE_BODY = '# save fixture\n\nalpha\n';

interface WriteRecord {
  sessionId: string;
  path: string;
  content: string;
}

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mds-'));
  writeFileSync(join(dir, 'CLAUDE.md'), FILE_BODY, 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.local.md'), FILE_BODY, 'utf-8');
  createdDirs.push(dir);
  return dir;
}

function resolveAgainst(cwd: string, fileName: string): string {
  const separator = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+/g, separator).replace(/[\\/]+$/, '');
  return `${base}${separator}${fileName}`;
}

/** Every write the page issues, decomposed into the three things a test asks of it. */
function recordWrites(page: Page): WriteRecord[] {
  const writes: WriteRecord[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/files/write')) return;
    const sessionId = url.match(/\/api\/sessions\/([^/]+)\/files\/write/)?.[1] ?? '';
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { path?: string; content?: string };
      writes.push({ sessionId, path: body.path ?? '', content: body.content ?? '' });
    } catch {
      writes.push({ sessionId, path: '', content: '' });
    }
  });
  return writes;
}

function writesFor(writes: readonly WriteRecord[], filePath: string): WriteRecord[] {
  return writes.filter(write => write.path === filePath);
}

async function ensureTabMode(page: Page): Promise<void> {
  const toTabs = page.locator('button[title="Switch to Tabs"]');
  if (await toTabs.count()) await toTabs.click();
  await expect(page.locator('button[title="Switch to Grid"]')).toBeVisible({ timeout: 15000 });
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

async function deleteTab(page: Page, workspaceId: string, tabId: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, tabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    await fetch(`/api/workspaces/${workspaceId}/tabs/${tabId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }, { workspaceId, tabId });
}

/** Ends the tab's session while leaving the tab itself in place. */
async function killSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (sessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    await fetch(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }, sessionId);
}

/**
 * A workspace of this spec's own, for the one scenario that has to empty a
 * workspace of tabs. Doing that to the shared one would destroy whatever
 * another spec left there, and nothing in this file could put it back. The run
 * teardown removes workspaces created during the run.
 */
async function createOwnWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
    const workspace = await res.json();
    return (workspace.id ?? workspace.workspace?.id) as string;
  }, name);
}

/**
 * Creates a workspace and answers with its id.
 *
 * Owned by this spec: only ids that came back from a successful create are
 * deleted afterwards, so a workspace the user made is never touched.
 */
async function createWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
    const workspace = await res.json();
    return workspace.id as string;
  }, name);
}

async function deleteWorkspace(page: Page, workspaceId: string): Promise<void> {
  await deleteOwnedWorkspaceForContext(page.context(), workspaceId);
}

async function workspaceNameOf(page: Page, workspaceId: string): Promise<string> {
  return page.evaluate(async (workspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const state = await res.json();
    const found = state.workspaces.find((item: { id: string }) => item.id === workspaceId);
    if (!found) throw new Error(`workspace ${workspaceId} is not listed`);
    return found.name as string;
  }, workspaceId);
}

async function selectWorkspace(page: Page, name: string): Promise<void> {
  await page.locator('.sidebar [role="option"]', { hasText: name }).first().click();
  await expect(page.locator('.sidebar [role="option"][aria-selected="true"]', { hasText: name }))
    .toBeVisible({ timeout: 15000 });
}

async function listTabIds(page: Page, workspaceId: string): Promise<string[]> {
  return page.evaluate(async (workspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return [];
    const state = await res.json();
    return state.tabs
      .filter((tab: { workspaceId?: string }) =>
        tab.workspaceId === undefined || tab.workspaceId === workspaceId)
      .map((tab: { id: string }) => tab.id) as string[];
  }, workspaceId);
}

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

async function sessionIdOf(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate(async (tabId) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const state = await res.json();
    const tab = state.tabs.find((item: { id: string }) => item.id === tabId);
    return (tab?.sessionId as string | undefined) ?? null;
  }, tabId);
}

async function restartTab(page: Page, workspaceId: string, tabId: string): Promise<string> {
  return page.evaluate(async ({ workspaceId, tabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs/${tabId}/restart`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`restart failed: ${res.status}`);
    const tab = await res.json();
    return (tab?.sessionId ?? tab?.tab?.sessionId) as string;
  }, { workspaceId, tabId });
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first().click();
}

async function awaitReportedCwd(page: Page, expectedDir: string): Promise<string> {
  const pathBar = page.locator('.metadata-cwd-path:visible').first();
  await expect(pathBar).toHaveAttribute('title', new RegExp(escapeRegExp(expectedDir), 'i'), {
    timeout: 30000,
  });
  const cwd = await pathBar.getAttribute('title');
  if (!cwd) throw new Error('path bar reported an empty cwd');
  return cwd;
}

async function chooseFile(page: Page, fileName: string): Promise<void> {
  await page.locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  const menu = page.locator('.context-menu[role="menu"]').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  await menu.locator('.context-menu-item')
    .filter({ has: page.getByText(fileName, { exact: true }) })
    .first()
    .click();
}

/**
 * Matched on the whole title, allowing only the dirty marker in front of it.
 * A substring match would be safe for today's two fixtures by accident, and
 * would silently resolve to the wrong window the first time one file name
 * contained another.
 */
/** The workspace's one editor window. */
function editorWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface');
}

/**
 * The panel holding one document, found by the path it carries.
 *
 * Not by the window title: one window holds every open document, and its title
 * names only the active tab -- a search through the window would match every
 * open editor at once. The match is on the path's tail so a caller can name a
 * file without spelling out the temporary directory it sits in.
 */
function editorPanelFor(page: Page, fileName: string): Locator {
  // Scoped to the window that is on screen. Every workspace holding a document
  // has its own window, all of them mounted, and two workspaces can hold files
  // of the same name -- which nearly all of them are.
  return page.locator('.editor-window-surface:visible')
    .locator(`.editor-document-panel[data-document-id$="${fileName}"]`);
}

/** The tab row of the one editor window. */
function editorTabs(page: Page): Locator {
  // Scoped to the window on screen, for the same reason the panel locator is:
  // every workspace with an open document has its own mounted window.
  return page.locator('.editor-window-surface:visible .editor-tab-label');
}

/** One tab of that row, by the file it holds. */
function editorTabFor(page: Page, fileName: string): Locator {
  return editorTabs(page).filter({ hasText: fileName }).first();
}

function contentOf(page: Page, fileName: string): Locator {
  return editorPanelFor(page, fileName).locator('.cm-content');
}

async function openWindow(page: Page, fileName: string): Promise<void> {
  await chooseFile(page, fileName);
  // The visible one. Every workspace with an open document has a window and all
  // of them are mounted, so a locator over the class alone matches more than
  // one as soon as a second workspace is in play.
  await expect(page.locator('.editor-window-surface:visible')).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(contentOf(page, fileName)).toBeAttached({ timeout: 15000 });
}

/**
 * Waits for the window title to settle on `expected`.
 *
 * Polled rather than read once. The dirty marker arrives after a round trip --
 * the panel reports its flag, the hook updates the document, and the window
 * reads it back -- so a single read lands before the title has changed and
 * reports the value from the near side of that trip.
 */
async function expectTitle(page: Page, fileName: string, expected: string): Promise<void> {
  // The window title names the active tab, so the document has to be that tab
  // for this to be about it. Reading the tab row instead would answer for a
  // document that is merely open.
  await expect(editorTabFor(page, fileName)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => editorWindow(page).locator('.window-dialog-title').first().innerText(),
      { timeout: 10000 })
    .toBe(expected);
}

/**
 * Moves DOM focus into a window without pressing it. A press would raise the
 * window, and the focus-versus-frontmost criteria need those to differ.
 */
async function focusEditorWithoutPressing(page: Page, fileName: string): Promise<void> {
  await contentOf(page, fileName).first().evaluate((element) => {
    (element as HTMLElement).focus();
  });
  await expect.poll(async () => page.evaluate(() =>
    document.activeElement?.closest('.cm-content') !== null), { timeout: 10000 }).toBe(true);
}

async function typeInto(page: Page, fileName: string, text: string): Promise<void> {
  // The document has to be the tab on screen before it can be typed into: a
  // panel behind another tab carries `display: none`, and a click on it would
  // wait for a target that never becomes visible.
  await editorTabFor(page, fileName).click();
  await expect(editorTabFor(page, fileName)).toHaveAttribute('aria-selected', 'true');
  await contentOf(page, fileName).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await expect(contentOf(page, fileName)).toContainText(text, { timeout: 10000 });
}

test.describe('markdown editor save flow and tab binding', () => {
  let workspaceId: string | null = null;
  // Workspaces this spec created. Only ids that came back from a successful
  // create go in, so nothing the user owns is ever deleted.
  let ownedWorkspaceIds: string[] = [];
  let writes: WriteRecord[];

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only save coverage');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
    writes = recordWrites(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await removeOwnTabs(page, workspaceId);
      for (const owned of ownedWorkspaceIds) {
        await deleteWorkspace(page, owned);
      }
      ownedWorkspaceIds = [];
    } catch (error) {
      console.warn(`[markdown-editor-save] teardown did not complete: ${String(error)}`);
    }
  });

  test.afterAll(() => {
    for (const dir of createdDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Reclaimed by the OS regardless.
      }
    }
  });

  // TC-REQ-FR-MDE-006-AC2-03
  test('FR-MDE-006 the shortcut writes the active tab and leaves the others alone', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-focus`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.local.md');

    // The press used to choose between windows by focus. There is one window
    // now, so what it chooses between is the documents inside it -- and the
    // rule is the active tab, because that is the one the user is looking at.
    //
    // Both documents are made dirty, so a press that picked the wrong one would
    // still write something and the assertion would have to name which.
    await typeInto(page, 'CLAUDE.local.md', 'INACTIVE-TAB');
    await editorTabFor(page, 'CLAUDE.md').click();
    await expect(editorTabFor(page, 'CLAUDE.md')).toHaveAttribute('aria-selected', 'true');
    await typeInto(page, 'CLAUDE.md', 'ACTIVE-TAB');

    await focusEditorWithoutPressing(page, 'CLAUDE.md');
    await page.keyboard.press('Control+s');

    const active = resolveAgainst(cwd, 'CLAUDE.md');
    const inactive = resolveAgainst(cwd, 'CLAUDE.local.md');
    await expect.poll(async () => writesFor(writes, active).length, { timeout: 10000 }).toBe(1);
    expect(writesFor(writes, inactive)).toHaveLength(0);
    expect(writes).toHaveLength(1);

    // And the choice follows the tab rather than being fixed: switching makes
    // the other document the one that is written. Without this half the case
    // above would pass against an implementation that always wrote the first
    // document it found.
    await editorTabFor(page, 'CLAUDE.local.md').click();
    await expect(editorTabFor(page, 'CLAUDE.local.md')).toHaveAttribute('aria-selected', 'true');
    await focusEditorWithoutPressing(page, 'CLAUDE.local.md');
    await page.keyboard.press('Control+s');

    await expect.poll(async () => writesFor(writes, inactive).length, { timeout: 10000 }).toBe(1);
    expect(writesFor(writes, active)).toHaveLength(1);
  });

  // TC-REQ-FR-MDE-006-AC3-03
  test('FR-MDE-006 no write is issued while focus sits outside every editor window', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-outside`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'OUTSIDE');

    // Focus the terminal, which is outside every window.
    const writesBefore = writes.length;
    await page.locator('.terminal-view:visible .xterm-helper-textarea').first().focus();
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(700);
    expect(writes).toHaveLength(writesBefore);

    // The same key inside a window does write, so the gate is the focus and not
    // a shortcut that never fires.
    await focusEditorWithoutPressing(page, 'CLAUDE.md');
    await page.keyboard.press('Control+s');
    await expect.poll(async () => writesFor(writes, resolveAgainst(cwd, 'CLAUDE.md')).length,
      { timeout: 10000 }).toBe(1);
  });

  // TC-REQ-FR-MDE-006-AC4-01
  test('FR-MDE-006 the shortcut calls preventDefault on the keyboard event', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-prevent`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'PREVENT');
    await focusEditorWithoutPressing(page, 'CLAUDE.md');

    // A listener at the very end of the bubble path sees the flag the handler
    // left on the event.
    await page.evaluate(() => {
      (window as unknown as { __mdeSavePrevented?: boolean }).__mdeSavePrevented = undefined;
      // Removed on the press it was waiting for, not on the first press of any
      // key. `press('Control+s')` sends a keydown for Control before the one
      // for s, so a listener registered with `{ once: true }` is spent on the
      // modifier and never sees the combination -- leaving the flag undefined,
      // which reads as a handler that did nothing rather than as an observer
      // that never ran.
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) {
          return;
        }
        window.removeEventListener('keydown', onKeyDown);
        (window as unknown as { __mdeSavePrevented?: boolean }).__mdeSavePrevented =
          event.defaultPrevented;
      };
      window.addEventListener('keydown', onKeyDown);
    });

    await page.keyboard.press('Control+s');

    await expect.poll(async () => page.evaluate(
      () => (window as unknown as { __mdeSavePrevented?: boolean }).__mdeSavePrevented,
    ), { timeout: 10000 }).toBe(true);
  });

  // TC-REQ-FR-MDE-006-AC6-01
  test('FR-MDE-006 a failed write keeps the asterisk and shows an in-window banner', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-failwrite`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');

    await page.route(
      url => url.pathname.includes('/files/write'),
      route => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'write failed' } }),
      }),
    );

    await typeInto(page, 'CLAUDE.md', 'WILL-FAIL');
    await expectTitle(page, 'CLAUDE.md', 'CLAUDE.md*');

    const surface = editorWindow(page);
    await surface.locator('button[aria-label="저장"]').click();

    // The failure is reported inside the window and the document stays dirty.
    await expect(surface.locator('.editor-window-error')).toBeVisible({ timeout: 10000 });
    await expectTitle(page, 'CLAUDE.md', 'CLAUDE.md*');
    await expect(page.locator('.message-box-dialog')).toHaveCount(0);
  });

  // TC-REQ-CON-MDE-002-AC1-01
  test('CON-MDE-002 a tab restart keeps the window and routes the next save to the new session', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-restart`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');
    await contentOf(page, 'CLAUDE.md').evaluate((element) => {
      element.setAttribute('data-e2e-editor-stamp', 'restart');
    });
    await typeInto(page, 'CLAUDE.md', 'ACROSS-RESTART');

    const oldSession = await sessionIdOf(page, tabId);
    const newSession = await restartTab(page, workspaceId!, tabId);
    expect(newSession).not.toBe(oldSession);
    await expect.poll(async () => sessionIdOf(page, tabId), { timeout: 30000 }).toBe(newSession);
    await expect(page.locator('.terminal-view:visible .xterm-screen')).toBeVisible({
      timeout: 30000,
    });

    // Same window, same editor, same unsaved body.
    await expect(editorWindow(page)).toBeVisible();
    expect(await contentOf(page, 'CLAUDE.md').first().getAttribute('data-e2e-editor-stamp'))
      .toBe('restart');
    await expect(contentOf(page, 'CLAUDE.md')).toContainText('ACROSS-RESTART');

    // And the next save goes out on the session that replaced the old one.
    await editorWindow(page).locator('button[aria-label="저장"]').click();
    await expect.poll(async () => writesFor(writes, filePath).length, { timeout: 15000 }).toBe(1);
    expect(writesFor(writes, filePath)[0].sessionId).toBe(newSession);
  });

  // TC-REQ-CON-MDE-002-AC3-01
  test('CON-MDE-002 a disconnected session keeps the placement and reports failure in the banner', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-dead`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'DEAD-SESSION');

    const surface = editorWindow(page);
    const before = await surface.boundingBox();
    expect(before).not.toBeNull();

    // The session dies; the tab does not. The binding therefore survives.
    const sessionId = await sessionIdOf(page, tabId);
    expect(sessionId).toBeTruthy();
    await killSession(page, sessionId!);

    // Not a closed tab: no badge, and the save control is still live.
    await expect(surface.locator('span', { hasText: '저장 불가' })).toHaveCount(0);
    const saveButton = surface.locator('button[aria-label="저장"]');
    await expect(saveButton).toBeEnabled();

    // A save is attempted and its failure is reported in this window only.
    await saveButton.click();
    await expect.poll(async () => writes.length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(surface.locator('.editor-window-error')).toBeVisible({ timeout: 15000 });
    await expectTitle(page, 'CLAUDE.md', 'CLAUDE.md*');

    // The placement did not drop. Containment inside the stage could not say
    // that on its own -- a window wrongly dropped to floating is clamped and
    // would sit inside it too -- so the rect is compared with the one it had
    // before the session died. A window that stayed where it was has not moved.
    const after = await surface.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
    expect(Math.round(after!.y)).toBe(Math.round(before!.y));
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
    expect(Math.round(after!.height)).toBe(Math.round(before!.height));
  });

  // The two AC-4 cases that stood here watched a window drop from `docked` to
  // `floating` when the terminal tab it covered went away. A window is not
  // placed over a terminal any more, so there is no placement for the loss of a
  // terminal to change -- what the criterion is really about, and what the two
  // cases below judge, is that the document survives it and says why it cannot
  // be saved.

  // TC-REQ-CON-MDE-002-AC4-01
  test('CON-MDE-002 deleting the bound terminal tab keeps the document and its unsaved body', async ({ page }) => {
    const workdir = makeWorkdir();
    const boundName = `${TAB_NAME_PREFIX}-apiclose-bound`;
    const siblingName = `${TAB_NAME_PREFIX}-apiclose-peer`;
    const boundTabId = await addTabAt(page, workspaceId!, workdir, boundName);
    await addTabAt(page, workspaceId!, makeWorkdir(), siblingName);
    await selectTab(page, boundName);
    await awaitReportedCwd(page, workdir);

    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'API-CLOSED');
    const body = await contentOf(page, 'CLAUDE.md').first().innerText();
    expect(body).toContain('API-CLOSED');

    await deleteTab(page, workspaceId!, boundTabId);

    // The window is still there and still holds what was typed into it. The
    // body is compared against what it was rather than merely being non-empty:
    // a panel that remounted would come back with the file as it is on disk,
    // which is also non-empty.
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
    await expect(editorPanelFor(page, 'CLAUDE.md')).toHaveCount(1);
    expect(await contentOf(page, 'CLAUDE.md').first().innerText()).toBe(body);

    // And it says it cannot be saved, rather than offering a control that would
    // fail silently.
    await expect(editorWindow(page).locator('span', { hasText: '저장 불가' }))
      .toBeVisible({ timeout: 15000 });
    await expect(editorWindow(page).locator('button[aria-label="저장"]')).toBeDisabled();
  });

  // TC-REQ-CON-MDE-002-AC4-02
  test('CON-MDE-002 closing the bound tab from the tab bar keeps every open document', async ({ page }) => {
    // The case above closes the tab through the API, which leaves the workspace
    // still pointing at the tab it deleted. Closing from the tab bar does not:
    // `closeTab` moves the active tab to a sibling. A window scoped to its own
    // terminal tab disappeared at that moment, taking a body nobody had saved;
    // this is the path a user actually takes, so it is taken here.
    const workdir = makeWorkdir();
    // Neither name contains the other: the tab locator matches on contained
    // text, so a sibling named after the bound tab would be found by a search
    // for the bound one and the assertions below would count two tabs where
    // they mean one.
    const boundName = `${TAB_NAME_PREFIX}-uiclose-bound`;
    const siblingName = `${TAB_NAME_PREFIX}-uiclose-peer`;
    await addTabAt(page, workspaceId!, workdir, boundName);
    await addTabAt(page, workspaceId!, makeWorkdir(), siblingName);
    await selectTab(page, boundName);
    await awaitReportedCwd(page, workdir);

    // Two documents, so the count below tells "both survived" from "one did".
    await openWindow(page, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.local.md');
    await typeInto(page, 'CLAUDE.local.md', 'UI-CLOSED');
    const body = await contentOf(page, 'CLAUDE.local.md').first().innerText();
    expect(body).toContain('UI-CLOSED');

    // The tab bar's own close control, on the terminal tab the documents were
    // opened from.
    const boundTab = page.locator('.workspace-tabbar [role="tab"]', { hasText: boundName }).first();
    await expect(boundTab).toBeVisible({ timeout: 10000 });
    await boundTab.locator('button').last().click();

    // The tab bar asks before it ends a session, and answering that is part of
    // the path a user takes.
    const confirmClose = page.locator('.modal-content .btn-submit');
    await expect(confirmClose).toBeVisible({ timeout: 10000 });
    await confirmClose.click();

    // The active terminal tab really did move, or this would be the API case
    // again under another name.
    await expect(page.locator('.workspace-tabbar [role="tab"]', { hasText: boundName }))
      .toHaveCount(0, { timeout: 15000 });

    // Both documents are still open, and the measured one still holds its body.
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
    await expect(editorTabs(page)).toHaveCount(2);
    expect(await contentOf(page, 'CLAUDE.local.md').first().innerText()).toBe(body);
    await expect(editorWindow(page).locator('span', { hasText: '저장 불가' }))
      .toBeVisible({ timeout: 15000 });
    await expect(editorWindow(page).locator('button[aria-label="저장"]')).toBeDisabled();
  });

  // TC-REQ-CON-MDE-002-AC5-01
  test('CON-MDE-002 closing a window whose tab is gone asks the cannot-save prompt', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-orphanclose`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'DISCARD-ME');

    await deleteTab(page, workspaceId!, tabId);
    const surface = editorWindow(page);
    await expect(surface.locator('span', { hasText: '저장 불가' })).toBeVisible({ timeout: 15000 });

    const writesBefore = writes.length;
    await surface.locator('button[aria-label="Close"]').click();

    // The cannot-save prompt offers two answers. The ordinary unsaved prompt
    // offers three, and offering three here would be offering to save. The
    // count alone would only say "some two-button prompt", so the message is
    // read as well.
    const prompt = page.locator('.modal-overlay .modal-content');
    await expect(prompt).toBeVisible({ timeout: 10000 });
    await expect(prompt.locator('.modal-actions button')).toHaveCount(2);
    await expect(prompt.locator('.confirm-message')).toContainText('저장할 수 없습니다');

    await prompt.locator('.btn-submit').click();
    // The only document goes, and the window goes with it: an empty window
    // shows nothing and carries no title.
    await expect(editorPanelFor(page, 'CLAUDE.md')).toHaveCount(0);
    await expect(editorWindow(page)).toHaveCount(0);
    await page.waitForTimeout(700);
    expect(writes).toHaveLength(writesBefore);
  });

  // TC-REQ-CON-MDE-002-AC7-01
  test('CON-MDE-002 documentId is the normalized absolute path and survives a restart', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-docid`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');
    await contentOf(page, 'CLAUDE.md').evaluate((element) => {
      element.setAttribute('data-e2e-editor-stamp', 'docid');
    });

    const before = await page.evaluate(
      path => window.__buildergateEditorWindowDebug?.readEditorProbe(path) ?? null, filePath);
    expect(before).not.toBeNull();
    expect(before!.documentId).toBe(filePath);
    expect(before!.documentId).not.toMatch(/[\\/]{2,}/);

    const oldSession = await sessionIdOf(page, tabId);
    const newSession = await restartTab(page, workspaceId!, tabId);
    await expect.poll(async () => sessionIdOf(page, tabId), { timeout: 30000 }).toBe(newSession);
    expect(newSession).not.toBe(oldSession);

    const after = await page.evaluate(
      path => window.__buildergateEditorWindowDebug?.readEditorProbe(path) ?? null, filePath);
    expect(after).not.toBeNull();
    expect(after!.documentId).toBe(filePath);
    expect(await contentOf(page, 'CLAUDE.md').first().getAttribute('data-e2e-editor-stamp'))
      .toBe('docid');
  });

  // TC-REQ-FR-MDE-008-AC4-03
  test('FR-MDE-008 the tray entry gains the asterisk when the document diverges and loses it on save', async ({ page }) => {
    // Read off the tray itself, which is the only place the produced value
    // shows. The unit suite hands `listEditorTrayEntries` a record with the
    // flag already set, so it judges what the model does with the value and
    // never that anything produces one -- a window whose flag is nailed to a
    // constant passes it either way.
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-traydirty`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');

    const trayLabels = async (): Promise<string[]> => {
      await page.locator('.header-editor-tray-button').click();
      const menu = page.locator('.context-menu[role="menu"]').first();
      await expect(menu).toBeVisible({ timeout: 10000 });
      const labels = await menu.locator('.context-menu-item').allInnerTexts();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0, { timeout: 10000 });
      return labels.map(label => label.trim());
    };

    // The row carries the file's path rather than its bare name, so the
    // assertions read the two parts that matter: the document it names, and
    // whether the dirty marker leads it. Which part of a long path gets elided
    // is the unit suite's to judge (editorTrayPresentation.test.ts).
    const trayLabel = async () => {
      const labels = await trayLabels();
      expect(labels).toHaveLength(1);
      return labels[0];
    };

    // A window opens on the body it just read, so it starts clean.
    expect(await trayLabel()).toMatch(/[\\/]CLAUDE\.md$/);

    await typeInto(page, 'CLAUDE.md', 'TRAY-DIRTY');
    expect(await trayLabel()).toMatch(/[\\/]CLAUDE\.md\*$/);

    // And the marker comes back off once the file matches again. The write is
    // let through to the server, so this is a real save rather than a stubbed
    // answer -- and the title bar is checked alongside, because the two draw
    // from the same value and disagreeing would mean one of them invented it.
    const writesBefore = writesFor(writes, resolveAgainst(cwd, 'CLAUDE.md')).length;
    await editorWindow(page).locator('button[aria-label="저장"]').click();
    await expect.poll(
      async () => writesFor(writes, resolveAgainst(cwd, 'CLAUDE.md')).length,
      { timeout: 10000 },
    ).toBe(writesBefore + 1);

    await expectTitle(page, 'CLAUDE.md', 'CLAUDE.md');
    expect(await trayLabel()).toMatch(/[\\/]CLAUDE\.md$/);
  });

  // TC-REQ-FR-MDE-008-AC3-01
  test('FR-MDE-008 the tray icon is the immediately preceding sibling of the view mode toggle', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-tray`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // No windows, no icon.
    await expect(page.locator('.header-editor-tray-button')).toHaveCount(0);

    await openWindow(page, 'CLAUDE.md');
    await expect(page.locator('.header-editor-tray-button')).toBeVisible({ timeout: 10000 });

    // The icon sits directly before the view mode toggle inside header-right.
    const adjacency = await page.evaluate(() => {
      const right = document.querySelector('.header-right');
      if (right === null) return { found: false, trayIndex: -1, toggleIndex: -1 };
      const children = Array.from(right.children);
      const trayIndex = children.findIndex(child =>
        child.classList.contains('header-editor-tray-button'));
      const toggleIndex = children.findIndex(child =>
        child.getAttribute('title') === 'Switch to Grid'
        || child.getAttribute('title') === 'Switch to Tabs');
      return { found: true, trayIndex, toggleIndex };
    });
    expect(adjacency.found).toBe(true);
    expect(adjacency.trayIndex).toBeGreaterThanOrEqual(0);
    expect(adjacency.toggleIndex).toBeGreaterThanOrEqual(0);
    expect(adjacency.toggleIndex - adjacency.trayIndex).toBe(1);
  });

  // TC-REQ-FR-MDE-008-AC5-02
  test('FR-MDE-008 choosing a tray entry brings a minimized window back to screen', async ({ page }) => {
    const workdir = makeWorkdir();
    const boundName = `${TAB_NAME_PREFIX}-revive`;
    const otherName = `${TAB_NAME_PREFIX}-revive-other`;
    await addTabAt(page, workspaceId!, workdir, boundName);
    await addTabAt(page, workspaceId!, makeWorkdir(), otherName);
    await selectTab(page, boundName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await surface.locator('button[aria-label="최소화"]').click();
    await expect(surface).toBeHidden({ timeout: 10000 });

    // Switching the terminal tab no longer hides the window, so the window is
    // hidden here for exactly one reason: it was minimized. That is what makes
    // the revival below a statement about the tray.
    await selectTab(page, otherName);
    await expect(surface).toBeHidden({ timeout: 10000 });

    await page.locator('.header-editor-tray-button').click();
    await page.locator('.context-menu-item').filter({ hasText: 'CLAUDE.md' }).first().click();
    await expect(surface).toBeVisible({ timeout: 15000 });

    // It comes back with an area rather than as a zero-size surface.
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  // TC-REQ-FR-MDE-008-AC9-01
  test('FR-MDE-008 the tray lists every workspace and choosing a row moves to it', async ({ page }) => {
    const homeName = await workspaceNameOf(page, workspaceId!);
    const homeDir = makeWorkdir();
    const homeTab = `${TAB_NAME_PREFIX}-tray-home`;
    await addTabAt(page, workspaceId!, homeDir, homeTab);
    await selectTab(page, homeTab);
    await awaitReportedCwd(page, homeDir);
    await openWindow(page, 'CLAUDE.md');

    // A document in a second workspace, which is what the list has to reach.
    const awayName = `${TAB_NAME_PREFIX}-tray-ws`;
    const awayWorkspaceId = await createWorkspace(page, awayName);
    // Owned by this case, so it is removed whatever the assertions do. A
    // workspace left behind would give the next run two rows of the same name
    // and a `.first()` that picks whichever came back first.
    ownedWorkspaceIds.push(awayWorkspaceId);
    const awayDir = makeWorkdir();
    const awayTab = `${TAB_NAME_PREFIX}-tray-away`;
    await addTabAt(page, awayWorkspaceId, awayDir, awayTab);
    await selectWorkspace(page, awayName);
    await selectTab(page, awayTab);
    await awaitReportedCwd(page, awayDir);
    await openWindow(page, 'CLAUDE.md');

    // Typed into, so the assertion after the move is about this instance rather
    // than about a document rebuilt from disk.
    await typeInto(page, 'CLAUDE.md', 'AWAY-UNSAVED');
    const awayBody = await contentOf(page, 'CLAUDE.md').first().innerText();
    expect(awayBody).toContain('AWAY-UNSAVED');

    // Back home. Each workspace has its own window and both are mounted, so the
    // visible one is what says which workspace is on screen.
    await selectWorkspace(page, homeName);
    await expect(page.locator('.editor-window-surface:visible')).toHaveCount(1, {
      timeout: 15000,
    });

    // The list carries both, each row naming its workspace and its tab.
    await page.locator('.header-editor-tray-button').click();
    const rows = page.locator('.context-menu-item');
    await expect(rows.filter({ hasText: homeTab })).toHaveCount(1);
    const awayRow = rows.filter({ hasText: awayTab });
    await expect(awayRow).toHaveCount(1);
    await expect(awayRow).toContainText(awayName);
    await expect(awayRow).toContainText('|');

    // Choosing the away row moves the app to that workspace and puts its
    // document on screen -- with the text that was typed into it, which is what
    // says the instance was never torn down and never re-read from disk.
    await awayRow.click();
    await expect(page.locator('.sidebar [role="option"][aria-selected="true"]', { hasText: awayName }))
      .toBeVisible({ timeout: 15000 });
    await expect(editorPanelFor(page, 'CLAUDE.md')).toBeVisible({ timeout: 15000 });
    expect(await contentOf(page, 'CLAUDE.md').first().innerText()).toBe(awayBody);
  });

});

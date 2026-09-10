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

import { test, expect, type Locator, type Page } from '@playwright/test';

import { login } from './helpers';

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
function editorWindowFor(page: Page, fileName: string): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface').filter({
    has: page.locator('.window-dialog-title')
      .filter({ hasText: new RegExp(`^${escapeRegExp(fileName)}\\*?$`) }),
  });
}

function contentOf(page: Page, fileName: string): Locator {
  return editorWindowFor(page, fileName).locator('.cm-content');
}

async function openWindow(page: Page, fileName: string): Promise<void> {
  await chooseFile(page, fileName);
  await expect(editorWindowFor(page, fileName)).toBeVisible({ timeout: 15000 });
  await expect(contentOf(page, fileName)).toBeAttached({ timeout: 15000 });
}

/** The title text as rendered, including whatever dirty marker it carries. */
async function titleOf(page: Page, fileName: string): Promise<string> {
  return editorWindowFor(page, fileName).locator('.window-dialog-title').first().innerText();
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
  await contentOf(page, fileName).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await expect(contentOf(page, fileName)).toContainText(text, { timeout: 10000 });
}

test.describe('markdown editor save flow and tab binding', () => {
  let workspaceId: string | null = null;
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
  test('FR-MDE-006 the shortcut writes the focused window while another is front-most', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-focus`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.local.md');

    // Each window is typed into while it is the one on screen.
    //
    // Both open into `stage`, so they fill the same rect exactly and the first
    // window's text is entirely under the second one's surface. Typing into it
    // would wait for a click that can never land.
    //
    // So the front one is typed into first, then minimized, then the back one,
    // then restored through the tray -- which also brings it back to the front
    // of the stack, which is the arrangement this criterion needs: the write
    // must follow focus rather than front-to-back order.
    await typeInto(page, 'CLAUDE.local.md', 'FRONTMOST');

    const front = editorWindowFor(page, 'CLAUDE.local.md');
    await front.locator('button[aria-label="최소화"]').click();
    await expect(front).toBeHidden({ timeout: 10000 });

    // The back window's text is reachable now that nothing is over it. Asked of
    // the point rather than computed from the layout: a bounding box answers
    // where an element is even while something else covers it, so a covered
    // point would make every assertion below hold on the wrong window.
    const backLine = await contentOf(page, 'CLAUDE.md').locator('.cm-line').first().boundingBox();
    expect(backLine).not.toBeNull();
    expect(await page.evaluate((box) => {
      const hit = document.elementFromPoint(box.x + 3, box.y + box.height / 2);
      const surface = hit === null ? null : hit.closest('.editor-window-surface');
      return {
        inContent: hit !== null && hit.closest('.cm-content') !== null,
        title: surface?.querySelector('.window-dialog-title')?.textContent ?? null,
      };
    }, backLine!)).toEqual({ inContent: true, title: 'CLAUDE.md' });

    // Both dirty, so a shortcut that picked the wrong one would still write.
    await typeInto(page, 'CLAUDE.md', 'FOCUSED');

    // The front window comes back, and the tray revival puts it at the front of
    // the modeless stack again.
    await page.locator('.header-editor-tray-button').click();
    await page.locator('.context-menu-item').filter({ hasText: 'CLAUDE.local.md' }).first().click();
    await expect(front).toBeVisible({ timeout: 10000 });

    // Focus goes to the covered window without a press, which would have raised
    // it. The front-most window stays the other one.
    await focusEditorWithoutPressing(page, 'CLAUDE.md');
    await page.keyboard.press('Control+s');

    const focused = resolveAgainst(cwd, 'CLAUDE.md');
    const frontmost = resolveAgainst(cwd, 'CLAUDE.local.md');
    await expect.poll(async () => writesFor(writes, focused).length, { timeout: 10000 }).toBe(1);
    expect(writesFor(writes, frontmost)).toHaveLength(0);
    expect(writes).toHaveLength(1);
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
    expect(await titleOf(page, 'CLAUDE.md')).toContain('*');

    const surface = editorWindowFor(page, 'CLAUDE.md');
    await surface.locator('button[aria-label="저장"]').click();

    // The failure is reported inside the window and the document stays dirty.
    await expect(surface.locator('.editor-window-error')).toBeVisible({ timeout: 10000 });
    expect(await titleOf(page, 'CLAUDE.md')).toContain('*');
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
    await expect(editorWindowFor(page, 'CLAUDE.md')).toBeVisible();
    expect(await contentOf(page, 'CLAUDE.md').first().getAttribute('data-e2e-editor-stamp'))
      .toBe('restart');
    await expect(contentOf(page, 'CLAUDE.md')).toContainText('ACROSS-RESTART');

    // And the next save goes out on the session that replaced the old one.
    await editorWindowFor(page, 'CLAUDE.md').locator('button[aria-label="저장"]').click();
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

    const surface = editorWindowFor(page, 'CLAUDE.md');
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
    expect(await titleOf(page, 'CLAUDE.md')).toContain('*');

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

  // TC-REQ-CON-MDE-002-AC4-01
  test('CON-MDE-002 closing the tab drops the window to floating with the clamp winning over the inherited rect', async ({ page }) => {
    // The bound tab has to be the only one, so this runs in a workspace of its
    // own rather than emptying the shared one.
    const ownWorkspaceName = `${TAB_NAME_PREFIX}-ws`;
    const ownWorkspaceId = await createOwnWorkspace(page, ownWorkspaceName);
    await selectWorkspace(page, ownWorkspaceName);
    for (const stray of await listTabIds(page, ownWorkspaceId)) {
      await deleteTab(page, ownWorkspaceId, stray);
    }

    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-lasttab`;
    const tabId = await addTabAt(page, ownWorkspaceId, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await typeInto(page, 'CLAUDE.md', 'ORPHANED');

    const surface = editorWindowFor(page, 'CLAUDE.md');
    const inherited = await surface.boundingBox();
    expect(inherited).not.toBeNull();

    const writesBefore = writes.length;
    await deleteTab(page, ownWorkspaceId, tabId);

    // The window survives the tab and says why it cannot be saved.
    await expect(surface).toBeVisible({ timeout: 15000 });
    await expect(surface.locator('span', { hasText: '저장 불가' })).toBeVisible({ timeout: 15000 });
    await expect(surface.locator('button[aria-label="저장"]')).toBeDisabled();

    // The shortcut is disabled with the button.
    await focusEditorWithoutPressing(page, 'CLAUDE.md');
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(700);
    expect(writes).toHaveLength(writesBefore);

    // The rect is the one it occupied, with the floating clamp applied to it.
    // The criterion splits here, so the assertion splits with it: an inherited
    // rect that already lies inside the post-close bounds must come through
    // untouched, and one that does not must be moved and end up contained.
    // Reporting which branch ran keeps a conditional assertion from quietly
    // becoming no assertion.
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    const settled = await surface.boundingBox();
    expect(stage).not.toBeNull();
    expect(settled).not.toBeNull();

    const fits = inherited!.x >= stage!.x - 1
      && inherited!.y >= stage!.y - 1
      && inherited!.x + inherited!.width <= stage!.x + stage!.width + 1
      && inherited!.y + inherited!.height <= stage!.y + stage!.height + 1;
    console.warn(`[markdown-editor-save] AC-4 branch: inherited ${fits ? 'fits' : 'does not fit'} the post-close stage`);

    if (fits) {
      expect(Math.round(settled!.x)).toBe(Math.round(inherited!.x));
      expect(Math.round(settled!.y)).toBe(Math.round(inherited!.y));
      expect(Math.round(settled!.width)).toBe(Math.round(inherited!.width));
      expect(Math.round(settled!.height)).toBe(Math.round(inherited!.height));
    } else {
      expect({ x: Math.round(settled!.x), y: Math.round(settled!.y) })
        .not.toEqual({ x: Math.round(inherited!.x), y: Math.round(inherited!.y) });
      expect(settled!.x).toBeGreaterThanOrEqual(stage!.x - 1);
      expect(settled!.y).toBeGreaterThanOrEqual(stage!.y - 1);
      expect(settled!.x + settled!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
      expect(settled!.y + settled!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
    }
  });

  // TC-REQ-CON-MDE-002-AC4-02
  test('CON-MDE-002 closing the bound tab from the tab bar keeps the orphaned window on screen', async ({ page }) => {
    // The sibling case above closes the tab through the API, which leaves the
    // workspace still pointing at the tab it deleted. Closing from the tab bar
    // does not: `closeTab` moves the active tab to a sibling, and a window
    // scoped to its own tab disappears at that moment -- taking a body nobody
    // has saved with it. That is the path a user actually takes, so it is taken
    // here, and it needs a sibling to move to.
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
    // Two windows on the bound tab, and the second one is what is measured.
    //
    // AC-4 names `floating`, not `stage`. Both placements fill the stage, so the
    // rect cannot tell them apart; the 최대화 toggle can, because it renders
    // `aria-pressed` from the placement itself. The second window is the one
    // measured so that the count assertion below distinguishes "both survived"
    // from "one did".
    await openWindow(page, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.local.md');
    await typeInto(page, 'CLAUDE.local.md', 'UI-CLOSED');

    const surface = editorWindowFor(page, 'CLAUDE.local.md');
    const body = await contentOf(page, 'CLAUDE.local.md').first().innerText();
    expect(body).toContain('UI-CLOSED');

    // The window is put into `stage` first, so that the drop to `floating`
    // afterwards is a change rather than the state it was already in -- a
    // window that opened floating and stayed there would satisfy every
    // assertion below without the orphan rule ever running.
    await surface.locator('button[aria-label="최대화"]').click();
    await expect(surface.locator('button[aria-label="최대화"]'))
      .toHaveAttribute('aria-pressed', 'true');

    // The rectangle it occupies immediately before the close.
    const inherited = await surface.boundingBox();
    expect(inherited).not.toBeNull();

    // The tab bar's own close control, on the tab the window is bound to.
    const boundTab = page.locator('.workspace-tabbar [role="tab"]', { hasText: boundName }).first();
    await expect(boundTab).toBeVisible({ timeout: 10000 });
    await boundTab.locator('button').last().click();

    // The tab bar asks before it ends a session, and answering that is part of
    // the path a user takes. The API case skips this dialog entirely, which is
    // the whole reason it also skips the active-tab move underneath it.
    const confirmClose = page.locator('.modal-content .btn-submit');
    await expect(confirmClose).toBeVisible({ timeout: 10000 });
    await confirmClose.click();

    // The active tab really did move, or this test would be the API case again
    // under another name.
    await expect(page.locator('.workspace-tabbar [role="tab"]', { hasText: boundName }))
      .toHaveCount(0, { timeout: 15000 });

    // Both windows are still on screen, and the measured one still holds the
    // body it was given.
    await expect(page.locator('.window-dialog-surface.editor-window-surface')).toHaveCount(2);
    await expect(surface).toBeVisible({ timeout: 15000 });
    expect(await contentOf(page, 'CLAUDE.local.md').first().innerText()).toBe(body);
    await expect(surface.locator('span', { hasText: '저장 불가' })).toBeVisible({ timeout: 15000 });
    await expect(surface.locator('button[aria-label="저장"]')).toBeDisabled();

    // The rect it settled on is the one it occupied, exactly. AC-4: closing a
    // tab never shrinks the stage, so the inherited rectangle is still inside
    // the post-close stage and the clamp does not participate.
    const settled = await surface.boundingBox();
    expect(settled).not.toBeNull();
    expect({
      x: Math.round(settled!.x), y: Math.round(settled!.y),
      width: Math.round(settled!.width), height: Math.round(settled!.height),
    }).toEqual({
      x: Math.round(inherited!.x), y: Math.round(inherited!.y),
      width: Math.round(inherited!.width), height: Math.round(inherited!.height),
    });

    // And it really is `floating` now rather than the `stage` it opened in. The
    // rect cannot say so -- the orphan inherits a rect that fills the stage and
    // the floating clamp holds it there -- but the 최대화 toggle renders the
    // placement directly, so it can.
    const maximize = surface.locator('button[aria-label="최대화"]');
    await expect(maximize).toHaveAttribute('aria-pressed', 'false', { timeout: 10000 });

    // And the record still moves. A window held in `floating` by something that
    // re-applied the drop on every commit would refuse this press, or answer it
    // and come straight back.
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'true', { timeout: 10000 });
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
    const surface = editorWindowFor(page, 'CLAUDE.md');
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
    await expect(editorWindowFor(page, 'CLAUDE.md')).toHaveCount(0);
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
    await editorWindowFor(page, 'CLAUDE.md').locator('button[aria-label="저장"]').click();
    await expect.poll(
      async () => writesFor(writes, resolveAgainst(cwd, 'CLAUDE.md')).length,
      { timeout: 10000 },
    ).toBe(writesBefore + 1);

    await expect.poll(async () => titleOf(page, 'CLAUDE.md'), { timeout: 10000 })
      .toBe('CLAUDE.md');
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

    const surface = editorWindowFor(page, 'CLAUDE.md');
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
});

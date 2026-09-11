// What only a mounted editor can answer: whether hiding a window preserves the
// component that owns the document, and whether the two mount-time contracts --
// `documentId` as identity and `markdownSource` as a read-once value -- actually
// hold once the app is driving them.
//
// Identity is judged two ways, and they check each other.
//
//   * The DOM the EditorView owns is stamped by the test with an attribute the
//     product knows nothing about. A remount builds a fresh `.cm-content`, so a
//     surviving stamp is the same object rather than a proxy for it. Nothing has
//     to be added to the product for this.
//
//   * The props themselves -- `documentId`, `markdownSource`, and the identity
//     of the `extensions` array -- are not in the DOM at all. They are read
//     through `__buildergateEditorWindowDebug`, the same read-only hook the
//     placement spec declares for the terminal host registry. `readEditorProbe`
//     returns the values a mounted window is passing; `extensionsToken` is one
//     number per array object, so equal tokens mean the same array.
//
// `setEditorReadOnly` is the one method here that changes anything. It drives
// the editor handle the window already holds, because FR-MDE-005 AC-4 asks for a
// `readOnly` toggle and the window never toggles it on its own.

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
      /** The props a mounted editor window is passing to the editor. */
      readEditorProbe(filePath: string): {
        documentId: string;
        markdownSource: string;
        /** One number per `extensions` array object. Equal means identical. */
        extensionsToken: number;
      } | undefined;
      /** Drives the editor handle the window holds. Returns false if unknown. */
      setEditorReadOnly(filePath: string, readOnly: boolean): boolean;
    };
  }
}

const TAB_NAME_PREFIX = 'e2e-mde-life';

/**
 * The two files carry byte-identical content on purpose. If the editor took its
 * identity from the opening body instead of from `documentId`, these two would
 * be indistinguishable to it -- which is the failure this pair is here to catch.
 */
const SHARED_BODY = '# same body\n\nalpha beta gamma\n';

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mdl-'));
  writeFileSync(join(dir, 'CLAUDE.md'), SHARED_BODY, 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.local.md'), SHARED_BODY, 'utf-8');
  createdDirs.push(dir);
  return dir;
}

function resolveAgainst(cwd: string, fileName: string): string {
  const separator = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+/g, separator).replace(/[\\/]+$/, '');
  return `${base}${separator}${fileName}`;
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

/** The session the tab is running right now, which a restart replaces. */
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

/**
 * Restarts the tab and returns the session id the server answered with. The
 * answer is used rather than "any value other than the old one", because a
 * restart assigns the new id before the save that could still roll it back.
 */
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

/** Reads a file back off disk through the same API the editor saves with. */
async function readFileViaApi(page: Page, tabId: string, filePath: string): Promise<string> {
  return page.evaluate(async ({ tabId, filePath }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const state = await (await fetch('/api/workspaces', { headers })).json();
    const tab = state.tabs.find((item: { id: string }) => item.id === tabId);
    const res = await fetch(
      `/api/sessions/${tab.sessionId}/files/read?path=${encodeURIComponent(filePath)}`,
      { headers },
    );
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const data = await res.json();
    return (data.content ?? '') as string;
  }, { tabId, filePath });
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
 * The title carries a trailing `*` as soon as the window is dirty, which
 * FR-MDE-006 AC-1 requires, so an exact match on the file name stops finding
 * the window the moment anything is typed into it. The marker is optional here
 * rather than ignored: the name still has to be the whole rest of the title.
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
  return page.locator(`.editor-document-panel[data-document-id$="${fileName}"]`);
}

/** The tab row of the one editor window. */
function editorTabs(page: Page): Locator {
  return page.locator('.editor-window-surface .editor-tab-label');
}

/** One tab of that row, by the file it holds. */
function editorTabFor(page: Page, fileName: string): Locator {
  return editorTabs(page).filter({ hasText: fileName }).first();
}


/**
 * The editor of one document, found by the panel that holds it.
 *
 * Not by the window title: one window holds every open document now, and its
 * title names only the active tab. A search through the window would match
 * every open editor at once.
 */
function contentOf(page: Page, fileName: string): Locator {
  return editorPanelFor(page, fileName).locator('.cm-content');
}

async function openWindow(page: Page, fileName: string): Promise<void> {
  await chooseFile(page, fileName);
  // The window, then the document's own panel inside it. The window is shared
  // by every open document, so its appearance does not say this one arrived.
  await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
  await expect(contentOf(page, fileName)).toBeAttached({ timeout: 15000 });
}

/**
 * Marks the DOM node the EditorView owns with a value the product never writes.
 * A remount replaces that node, so the mark surviving is the object surviving.
 */
async function stampEditor(page: Page, fileName: string, mark: string): Promise<void> {
  await contentOf(page, fileName).evaluate((element, mark) => {
    element.setAttribute('data-e2e-editor-stamp', mark);
  }, mark);
}

async function readStamp(page: Page, fileName: string): Promise<string | null> {
  const content = contentOf(page, fileName);
  if (await content.count() === 0) return null;
  return content.first().getAttribute('data-e2e-editor-stamp');
}

async function readProbe(page: Page, filePath: string) {
  return page.evaluate(
    path => window.__buildergateEditorWindowDebug?.readEditorProbe(path) ?? null,
    filePath,
  );
}

/**
 * Types into the window's editor, leaving the body diverged from the file. The
 * caret is driven to the end explicitly rather than left where the click landed,
 * so a change in window size cannot quietly turn this into an insert in the
 * middle while the containment assertion goes on passing.
 */
async function typeInto(page: Page, fileName: string, text: string): Promise<void> {
  await contentOf(page, fileName).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await expect(contentOf(page, fileName)).toContainText(text, { timeout: 10000 });
}

/** The editor's whole visible text, for comparisons that must be exact. */
async function bodyOf(page: Page, fileName: string): Promise<string> {
  return contentOf(page, fileName).first().innerText();
}

test.describe('markdown editor lifecycle and mount contracts', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only lifecycle coverage');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await ensureTabMode(page);
      await removeOwnTabs(page, workspaceId);
    } catch (error) {
      // A teardown that cannot reach the server is not a test result, but a
      // swallowed failure leaves a tab and its pty behind for the rest of the
      // run, so it says so rather than disappearing.
      console.warn(`[markdown-editor-lifecycle] teardown did not complete: ${String(error)}`);
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

  // TC-REQ-FR-MDE-002-AC1-01
  test('FR-MDE-002 minimize and restore keep the same instance and the unsaved body', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac1`;
    const otherName = `${TAB_NAME_PREFIX}-ac1-other`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await addTabAt(page, workspaceId!, makeWorkdir(), otherName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');

    await stampEditor(page, 'CLAUDE.md', 'ac1');
    await typeInto(page, 'CLAUDE.md', 'UNSAVED-AC1');
    // The criterion says the body differs from disk in exactly the same way
    // afterwards, so the whole body is what gets compared, not a substring.
    const diverged = await bodyOf(page, 'CLAUDE.md');
    expect(diverged).not.toBe(SHARED_BODY);

    const surface = editorWindow(page);
    await surface.locator('button[aria-label="최소화"]').click();
    await expect(surface).toBeHidden({ timeout: 10000 });

    // Restoring through the header tray is the shared revival path.
    await page.locator('button[aria-label="편집기 창"]').click();
    await page.locator('.context-menu-item').filter({ hasText: 'CLAUDE.md' }).first().click();
    await expect(surface).toBeVisible({ timeout: 10000 });

    expect(await readStamp(page, 'CLAUDE.md')).toBe('ac1');
    expect(await bodyOf(page, 'CLAUDE.md')).toBe(diverged);

    // Leaving the tab and coming back is the same obligation by another route,
    // except that the window no longer leaves the screen for it: it is bound to
    // the workspace rather than to the terminal tab it was opened from. What
    // still has to hold is that the instance -- and the body in it -- came
    // through the round trip.
    await selectTab(page, otherName);
    await expect(surface).toBeVisible({ timeout: 10000 });
    await expect(surface).toHaveCount(1);
    expect(await readStamp(page, 'CLAUDE.md')).toBe('ac1');
    await selectTab(page, tabName);
    await expect(surface).toBeVisible({ timeout: 10000 });
    expect(await readStamp(page, 'CLAUDE.md')).toBe('ac1');
    expect(await bodyOf(page, 'CLAUDE.md')).toBe(diverged);
  });

  // TC-REQ-FR-MDE-002-AC2-01
  test('FR-MDE-002 minimized surface carries display none with the editor still mounted', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac2`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await stampEditor(page, 'CLAUDE.md', 'ac2');

    const surface = editorWindow(page);
    await surface.locator('button[aria-label="최소화"]').click();

    // Hidden by style, not by being taken out of the tree.
    await expect(surface).toHaveCSS('display', 'none', { timeout: 10000 });
    await expect(surface).toHaveCount(1);
    await expect(contentOf(page, 'CLAUDE.md')).toBeAttached();
    expect(await readStamp(page, 'CLAUDE.md')).toBe('ac2');
  });

  // TC-REQ-FR-MDE-002-AC6-01
  test('FR-MDE-002 a tab restart leaves documentId and the EditorView untouched', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac6`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');
    await stampEditor(page, 'CLAUDE.md', 'ac6');
    await typeInto(page, 'CLAUDE.md', 'UNSAVED-AC6');

    const before = await sessionIdOf(page, tabId);
    const probeBefore = await readProbe(page, filePath);
    expect(before).toBeTruthy();
    expect(probeBefore).not.toBeNull();
    expect(probeBefore!.documentId).toBe(filePath);

    const restarted = await restartTab(page, workspaceId!, tabId);
    expect(restarted).toBeTruthy();
    expect(restarted).not.toBe(before);
    // Settled on the id the restart actually assigned, not merely on some other
    // value: the assignment precedes a save that could still put the old one
    // back, and "different" would accept that intermediate state.
    await expect.poll(async () => sessionIdOf(page, tabId), { timeout: 30000 })
      .toBe(restarted);
    // The page, not only the server, has moved on: a live terminal is back and
    // the disconnected overlay is not standing in for it.
    await expect(page.locator('.terminal-view:visible .xterm-screen')).toBeVisible({
      timeout: 30000,
    });

    // The session was replaced; the document was not.
    expect(await readStamp(page, 'CLAUDE.md')).toBe('ac6');
    await expect(contentOf(page, 'CLAUDE.md')).toContainText('UNSAVED-AC6');
    const probeAfter = await readProbe(page, filePath);
    expect(probeAfter).not.toBeNull();
    expect(probeAfter!.documentId).toBe(probeBefore!.documentId);
  });

  // TC-REQ-FR-MDE-002-AC7-01
  test('FR-MDE-002 markdownSource stays at its mount value while the body diverges', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac7`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');

    const atOpen = await readProbe(page, filePath);
    expect(atOpen).not.toBeNull();
    expect(atOpen!.markdownSource).toBe(SHARED_BODY);

    await typeInto(page, 'CLAUDE.md', 'DIVERGED-AC7');

    // The body moved; the prop did not. A prop driven as a controlled value
    // would have followed the body here.
    const afterTyping = await readProbe(page, filePath);
    expect(afterTyping).not.toBeNull();
    expect(afterTyping!.markdownSource).toBe(SHARED_BODY);
    await expect(contentOf(page, 'CLAUDE.md')).toContainText('DIVERGED-AC7');
  });

  // TC-REQ-FR-MDE-005-AC2-01
  test('FR-MDE-005 a markdownSource change keeps the EditorView while a documentId change recreates it', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-id`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindow(page, 'CLAUDE.md');
    await stampEditor(page, 'CLAUDE.md', 'first');

    // What this criterion guards is that the editor's identity is `documentId`
    // and not the opening body. The editor falls back to the body string when
    // `documentId` is absent, so the discriminating question is whether the
    // window passes one -- and what it passes.
    const first = await readProbe(page, resolveAgainst(cwd, 'CLAUDE.md'));
    expect(first).not.toBeNull();
    expect(first!.documentId).toBe(resolveAgainst(cwd, 'CLAUDE.md'));
    expect(first!.documentId).not.toBe(first!.markdownSource);

    // The body diverges from the string the editor was mounted with, and the
    // view is untouched.
    await typeInto(page, 'CLAUDE.md', 'DIVERGED');
    expect(await readStamp(page, 'CLAUDE.md')).toBe('first');

    // The second file holds byte-identical content, so the two documents are
    // distinguishable only by their ids. Both stay their own view.
    await openWindow(page, 'CLAUDE.local.md');
    await stampEditor(page, 'CLAUDE.local.md', 'second');
    expect(await readStamp(page, 'CLAUDE.local.md')).toBe('second');
    expect(await readStamp(page, 'CLAUDE.md')).toBe('first');

    const second = await readProbe(page, resolveAgainst(cwd, 'CLAUDE.local.md'));
    expect(second).not.toBeNull();
    expect(first!.markdownSource).toBe(second!.markdownSource);
    expect(first!.documentId).not.toBe(second!.documentId);

    // The criterion's other half -- the same mounted editor being handed a new
    // `markdownSource` under an unchanged `documentId`, and a changed
    // `documentId` under an unchanged mount -- has no path through this app.
    // The window reads the body once and the render site keys each window by
    // its file path, so a different document is always a different component
    // before the editor's own identity rule is ever consulted. That half is a
    // contract of the ported component, not of this application, and is
    // reported rather than simulated here.
  });

  // TC-REQ-FR-MDE-005-AC3-01
  test('FR-MDE-005 the change callback fires with markdownSource still at its mount value', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-cb`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).not.toHaveAttribute('data-dirty', 'true');

    await typeInto(page, 'CLAUDE.md', 'CALLBACK-T');

    // The host heard something: the window went dirty.
    await expect(surface).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });

    // But dirty flips on any call, so it cannot say what the call carried.
    // Saving does: the controller can only write text the callback handed it,
    // so reading the file back off disk is what shows the value arrived.
    await surface.locator('button[aria-label="저장"]').click();
    await expect.poll(async () => readFileViaApi(page, tabId, filePath), { timeout: 15000 })
      .toContain('CALLBACK-T');

    // And the prop never followed the body.
    const probe = await readProbe(page, filePath);
    expect(probe).not.toBeNull();
    expect(probe!.markdownSource).toBe(SHARED_BODY);
  });

  // TC-REQ-FR-MDE-005-AC4-01
  test('FR-MDE-005 the extensions array is reference identical across renders and readOnly toggles without remount', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ext`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');
    await stampEditor(page, 'CLAUDE.md', 'ext');

    const firstRender = await readProbe(page, filePath);
    expect(firstRender).not.toBeNull();

    // Minimizing and restoring re-renders the window with its inputs unchanged.
    const surface = editorWindow(page);
    await surface.locator('button[aria-label="최소화"]').click();
    await expect(surface).toBeHidden({ timeout: 10000 });
    await page.locator('button[aria-label="편집기 창"]').click();
    await page.locator('.context-menu-item').filter({ hasText: 'CLAUDE.md' }).first().click();
    await expect(surface).toBeVisible({ timeout: 10000 });

    const secondRender = await readProbe(page, filePath);
    expect(secondRender).not.toBeNull();
    expect(secondRender!.extensionsToken).toBe(firstRender!.extensionsToken);

    // Read-only is reconfigured, not remounted: the content element stays the
    // one it was, and the stamp with it.
    //
    // The toggle is driven through the editor handle the window already holds,
    // because the window never passes a `readOnly` prop -- there is no control
    // for it. That is the only mechanism this application has, so it is the one
    // judged; the prop's own effect is a contract of the ported component.
    await expect(contentOf(page, 'CLAUDE.md')).toHaveAttribute('contenteditable', 'true');
    expect(await page.evaluate(
      path => window.__buildergateEditorWindowDebug?.setEditorReadOnly(path, true) ?? false,
      filePath,
    )).toBe(true);
    await expect(contentOf(page, 'CLAUDE.md')).toHaveAttribute('contenteditable', 'false', {
      timeout: 10000,
    });
    expect(await readStamp(page, 'CLAUDE.md')).toBe('ext');
  });

  // TC-REQ-FR-MDE-005-AC5-01
  test('FR-MDE-005 documentId equals the normalized absolute path across a tab restart', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-norm`;
    const tabId = await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    await openWindow(page, 'CLAUDE.md');
    await stampEditor(page, 'CLAUDE.md', 'norm');

    const before = await readProbe(page, filePath);
    expect(before).not.toBeNull();
    // Normalized: one separator style throughout, and no trailing separator.
    expect(before!.documentId).toBe(filePath);
    expect(before!.documentId).not.toMatch(/[\\/]{2,}/);

    const sessionBefore = await sessionIdOf(page, tabId);
    const restarted = await restartTab(page, workspaceId!, tabId);
    expect(restarted).not.toBe(sessionBefore);
    await expect.poll(async () => sessionIdOf(page, tabId), { timeout: 30000 })
      .toBe(restarted);

    const after = await readProbe(page, filePath);
    expect(after).not.toBeNull();
    expect(after!.documentId).toBe(filePath);
    expect(await readStamp(page, 'CLAUDE.md')).toBe('norm');
  });
});

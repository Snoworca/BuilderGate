// The persistence criteria that only a real browser can settle.
//
// Three things here cannot be reached from the frontend unit suite, which has
// no DOM environment and no renderer:
//
//   * FR-MDE-009 AC-4 wants the terminal host registry entry an inactive tab
//     actually produces -- its `isVisible` flag and its measured size, not a
//     guess derived from a bounding box. The registry is a React context value,
//     so the page is read through `__buildergateEditorWindowDebug`, the hook
//     the window layer already installs. Nothing here writes into the registry:
//     a rect put there by hand would prove nothing about restoration.
//
//   * FR-MDE-009 AC-6 asks whether the editor is the *same instance* after a
//     workspace round trip. Identity is read from the editor probe's
//     `extensionsToken`, which numbers the `extensions` array object the window
//     builds once per mount -- so an equal token means the component was never
//     torn down. `documentId` cannot answer this: it is the file path, which a
//     remount reproduces exactly. The round trip is watched for reads of the
//     store's key at the same time.
//
//   * FR-MDE-009 AC-10 asks what one unreadable file does to the rest of a
//     restore. It needs a file that exists when the layout is saved and is gone
//     when it is restored, which is a filesystem fact rather than a stored one.

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Locator, type Page } from '@playwright/test';

// #53: `test` comes from the ownership fixture, not from @playwright/test -- see the note on
// removeOwnWorkspaces below.
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
    };
    /** Keys this page read from `localStorage` since the recorder was armed. */
    __persistenceSpecReads?: string[];
  }
}

const TAB_NAME_PREFIX = 'e2e-mde-persist';

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A working directory holding the three files the path menu offers, and only
 * those: `EDITOR_INSTRUCTION_FILES` is the whole menu, so a file outside it
 * cannot be opened through the flow these tests exercise. Their bodies differ
 * so that a window showing the wrong one is a failed assertion rather than a
 * coincidence.
 */
function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mdper-'));
  writeFileSync(join(dir, 'CLAUDE.md'), '# alpha alpha alpha alpha alpha alpha\n', 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.local.md'), '# beta beta beta beta beta beta\n', 'utf-8');
  writeFileSync(join(dir, 'AGENTS.md'), '# gamma gamma gamma gamma gamma gamma\n', 'utf-8');
  createdDirs.push(dir);
  return dir;
}

function windowStateKey(workspaceId: string): string {
  return `window_state_${workspaceId}`;
}

// The one key the window's position and size live under, spelled out rather
// than imported so a module that renamed it is caught rather than followed.
const GEOMETRY_CACHE_KEY = 'buildergate.editor-window.geometry';

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

// #53: every workspace this spec creates is recorded here, and teardown deletes exactly these.
// It used to sweep by NAME PREFIX, which CLAUDE.md forbids outright -- a prefix match cannot
// tell this run's workspace from a user's, and the boundary that rule protects is real user
// data.
const createdWorkspaceIds: string[] = [];

async function createWorkspace(page: Page, name: string): Promise<string> {
  const created = await page.evaluate(async (name) => {
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
  createdWorkspaceIds.push(created);
  return created;
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

async function removeOwnWorkspaces(page: Page): Promise<void> {
  // #53: deletes ONLY the ids this run created, through the ownership registry. The previous
  // form listed every workspace and deleted any whose NAME started with the test prefix -- a
  // user workspace that happened to share the prefix would have been destroyed, and the
  // registry could not have told the difference either.
  const ids = createdWorkspaceIds.splice(0);
  for (const workspaceId of ids) {
    await deleteOwnedWorkspaceForContext(page.context(), workspaceId);
  }
}


async function selectTab(page: Page, name: string): Promise<void> {
  // #81: the tabs this spec selects were created through the API, and the tab bar learns about
  // them asynchronously. Clicking straight away made the click's own 10s auto-wait the whole
  // budget, and a run that lost that race failed with `locator.click: Timeout` naming only the
  // selector -- the "first attempt fails, the retry passes" shape #81 records. Waiting for the
  // tab to be present first binds this to the transition and, when the tab genuinely never
  // arrives, says which tab and that it was never rendered rather than that a click timed out.
  const tab = page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first();
  await tab.waitFor({ state: 'visible', timeout: 30000 });
  await tab.click();
}

async function selectWorkspace(page: Page, name: string): Promise<void> {
  const option = page.locator('.sidebar [role="option"]', { hasText: name }).first();
  await option.click();
  await expect(option).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
}

/** The name the sidebar shows for a workspace, so no spec hardcodes one. */
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

async function awaitReportedCwd(page: Page, expectedDir: string, scope?: Locator): Promise<string> {
  const pathBar = (scope ?? page).locator('.metadata-cwd-path:visible').first();
  await expect(pathBar).toHaveAttribute('title', new RegExp(escapeRegExp(expectedDir), 'i'), {
    timeout: 30000,
  });
  const cwd = await pathBar.getAttribute('title');
  if (!cwd) throw new Error('path bar reported an empty cwd');
  return cwd;
}

async function chooseFile(page: Page, fileName: string, scope?: Locator): Promise<void> {
  await (scope ?? page).locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  const menu = page.locator('.context-menu[role="menu"]').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  await menu.locator('.context-menu-item')
    .filter({ has: page.getByText(fileName, { exact: true }) })
    .first()
    .click();
}

function editorWindows(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface');
}

/**
 * The window whose titlebar names `fileName`.
 *
 * The dirty marker is absorbed by the match rather than excluded from it: an
 * unsaved window is titled `CLAUDE.md*`, and a locator pinned to the bare name
 * finds nothing at all from the first keystroke onwards -- which `toBeHidden`
 * reports as a hidden window rather than as a missed one, so the assertion
 * would pass while measuring nothing. Anchored at both ends, so the name of one
 * file never matches the window of another.
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

async function openWindows(page: Page, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    await chooseFile(page, fileName);
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
  }
}

/** The stored records for a workspace, or null when nothing is stored. */
async function readStoredWindows(page: Page, workspaceId: string): Promise<
  { filePath: string; tabId: string }[] | null
> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { windows?: unknown };
    return Array.isArray(parsed.windows) ? parsed.windows as never : null;
  }, windowStateKey(workspaceId));
}

/**
 * Waits until the store holds an entry for every file named, so that a reload
 * that follows is reloading a layout that was actually written. The save runs
 * on a React effect, so the write lands a tick after the window appears.
 */
async function awaitStoredWindows(
  page: Page,
  workspaceId: string,
  fileNames: readonly string[],
): Promise<void> {
  await expect.poll(
    async () => {
      const stored = await readStoredWindows(page, workspaceId);
      return (stored ?? [])
        .map(entry => entry.filePath.split(/[\\/]/).pop())
        .filter((name): name is string => name !== undefined)
        .sort();
    },
    { timeout: 20000, message: `store did not record ${fileNames.join(', ')}` },
  ).toEqual([...fileNames].sort());
}

/** Records every `localStorage` key this page reads from now on. */
async function armStorageReadRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__persistenceSpecReads = [];
    const storage = window.localStorage;
    const original = storage.getItem.bind(storage);
    storage.getItem = (key: string) => {
      window.__persistenceSpecReads?.push(key);
      return original(key);
    };
  });
}

async function recordedReads(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__persistenceSpecReads ?? []);
}

async function readEditorProbe(page: Page, filePath: string): Promise<
  { documentId: string; markdownSource: string; extensionsToken: number } | undefined
> {
  return page.evaluate(
    (filePath) => window.__buildergateEditorWindowDebug?.readEditorProbe(filePath),
    filePath,
  );
}

/**
 * The size react-rnd has written onto the window's positioned root.
 *
 * Read from the inline style rather than measured, because the window is asked
 * about while it is hidden: `boundingBox()` measures layout and answers null
 * for a `display: none` element, which cannot tell a withheld rect apart from a
 * zero one. The computed value is the fallback for the render where react-rnd
 * has put the size in a stylesheet rule rather than inline.
 */
async function editorFrameSize(page: Page, fileName: string): Promise<
  { width: number; height: number } | null
> {
  return editorWindow(page).first().evaluate((surface) => {
    const frame = surface.closest<HTMLElement>('.window-dialog');
    if (frame === null) return null;

    const read = (inline: string, computed: string): number => (
      Number.parseFloat(inline !== '' ? inline : computed)
    );
    const style = getComputedStyle(frame);

    return {
      width: read(frame.style.width, style.width),
      height: read(frame.style.height, style.height),
    };
  });
}

/**
 * The text the editor is holding right now.
 *
 * Read from the document rather than from the probe: `markdownSource` reports
 * `bodyAtOpen`, which is what the window handed the editor at mount and never
 * moves again, so it cannot witness a keystroke. `textContent` rather than
 * `innerText` because the window is read while it is hidden as well as while it
 * is on screen, and `innerText` answers for the layout rather than the text.
 */
async function editorBodyText(page: Page, fileName: string): Promise<string> {
  const content = editorPanelFor(page, fileName).locator('.cm-content').first();
  return (await content.textContent()) ?? '';
}

/** Types into the window open on `fileName`, leaving the document unsaved. */
async function typeIntoEditor(page: Page, fileName: string, text: string): Promise<void> {
  const surface = editorWindow(page).first();
  await surface.locator('.cm-content').first().click();
  await page.keyboard.type(text);
}

test.describe('markdown editor persistence', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only persistence coverage');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
    await page.evaluate((key) => localStorage.removeItem(key), windowStateKey(workspaceId));
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await removeOwnTabs(page, workspaceId);
      await removeOwnWorkspaces(page);
      await page.evaluate((key) => localStorage.removeItem(key), windowStateKey(workspaceId));
    } catch {
      // A teardown that cannot reach the server is not a test result.
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

  // TC-REQ-FR-MDE-009-AC4-01
  test('FR-MDE-009 a restored window is placed and shown whatever tab is active', async ({ page }) => {
    // The rect a window opened at used to be derived from its own terminal's
    // registry entry, and restoration had to wait for that entry to report a
    // usable area. It is placed against the stage now, so there is nothing to
    // wait for -- and the window is no longer scoped to the tab it came from,
    // so it is on screen even while a different terminal tab is.
    const workdir = makeWorkdir();
    const hostTab = `${TAB_NAME_PREFIX}-ac4-host`;
    const otherTab = `${TAB_NAME_PREFIX}-ac4-other`;
    await addTabAt(page, workspaceId!, workdir, hostTab);
    await addTabAt(page, workspaceId!, workdir, otherTab);

    await selectTab(page, hostTab);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md']);
    await awaitStoredWindows(page, workspaceId!, ['CLAUDE.md']);

    // Leave the window's tab before reloading, so the restore lands while a
    // different tab is the active one.
    await selectTab(page, otherTab);
    await page.reload();
    await ensureTabMode(page);
    await selectTab(page, otherTab);
    await awaitReportedCwd(page, workdir);

    // Counted before it is judged visible: `toBeVisible` on a locator that
    // matches nothing fails, but reading the count first names which of the two
    // went wrong.
    const surface = editorWindow(page);
    await expect(surface).toHaveCount(1, { timeout: 20000 });
    await expect(surface).toBeVisible({ timeout: 15000 });

    // And it carries a real rect rather than the zero-size surface a withheld
    // placement would leave.
    const deferredSize = await editorFrameSize(page, 'CLAUDE.md');
    expect(deferredSize).not.toBeNull();
    expect(deferredSize!.width).toBeGreaterThan(0);
    expect(deferredSize!.height).toBeGreaterThan(0);

    // And it sits inside the stage rather than overhanging it, which is the
    // boundary a restored window is placed against.
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    const box = await surface.first().boundingBox();
    expect(stage).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(stage!.x - 1);
    expect(box!.y).toBeGreaterThanOrEqual(stage!.y - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);

    // Switching back to the tab it was opened from changes nothing, which is
    // what makes the visibility above a statement about the window rather than
    // about which tab happened to be active.
    await selectTab(page, hostTab);
    await awaitReportedCwd(page, workdir);
    await expect(surface).toBeVisible({ timeout: 20000 });
    await expect(surface).toHaveCount(1);
  });

  // TC-REQ-FR-MDE-009-AC6-01
  test('FR-MDE-009 a workspace round trip keeps the editor instance and reads no stored value', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac6`;
    const otherWorkspace = `${TAB_NAME_PREFIX}-ac6-ws`;
    const homeWorkspaceName = await workspaceNameOf(page, workspaceId!);
    await addTabAt(page, workspaceId!, workdir, tabName);
    const secondWorkspaceId = await createWorkspace(page, otherWorkspace);
    await addTabAt(page, secondWorkspaceId, workdir, `${TAB_NAME_PREFIX}-ac6-other`);
    await page.reload();
    await ensureTabMode(page);

    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md']);
    const filePath = `${cwd.replace(/[\\/]+$/, '')}${cwd.includes('\\') ? '\\' : '/'}CLAUDE.md`;

    const unsaved = 'AC6-UNSAVED-SENTINEL';
    await typeIntoEditor(page, 'CLAUDE.md', unsaved);
    await expect.poll(
      async () => editorBodyText(page, 'CLAUDE.md'),
      { timeout: 15000, message: 'the typed text never reached the editor' },
    ).toContain(unsaved);

    const before = await readEditorProbe(page, filePath);
    expect(before).toBeDefined();

    // Away and back. The recorder is armed for exactly this interval, so a read
    // of the store during it is attributable to the round trip and to nothing
    // else on the page.
    await armStorageReadRecorder(page);
    await selectWorkspace(page, otherWorkspace);
    // The window is off the screen but still in the tree, and so is the editor
    // inside it. Unmounting it to hide it would throw away the unsaved text the
    // probe below reads back.
    await expect(editorWindow(page)).toBeHidden({ timeout: 15000 });
    await expect(editorWindow(page)).toHaveCount(1);
    await expect(editorPanelFor(page, 'CLAUDE.md')).toHaveCount(1);
    await selectWorkspace(page, homeWorkspaceName);
    await expect(editorWindow(page)).toBeVisible({ timeout: 20000 });

    const reads = await recordedReads(page);
    expect(reads).not.toContain(windowStateKey(workspaceId!));

    const after = await readEditorProbe(page, filePath);
    expect(after).toBeDefined();
    // The same mount, not merely the same file: `extensions` is built once per
    // mount, so an equal token means nothing was torn down. The typed text is
    // asserted beside it because that is what a teardown would cost -- a
    // remount rebuilds the document from `bodyAtOpen`, which is the disk body.
    expect(after!.extensionsToken).toBe(before!.extensionsToken);
    expect(await editorBodyText(page, 'CLAUDE.md')).toContain(unsaved);

    // A reload is the other half: the document reopens and its body comes from
    // disk, so the unsaved text is gone by design. The disk body is asserted
    // as well, because an editor holding nothing at all would satisfy the
    // absence of the sentinel on its own.
    await page.reload();
    await ensureTabMode(page);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await expect(editorWindow(page)).toBeVisible({ timeout: 25000 });
    await expect.poll(
      async () => editorBodyText(page, 'CLAUDE.md'),
      { timeout: 15000, message: 'the restored window never reported a body' },
    ).toContain('alpha');
    expect(await editorBodyText(page, 'CLAUDE.md')).not.toContain(unsaved);
  });

  // TC-REQ-FR-MDE-009-AC10-01
  test('FR-MDE-009 a stored entry whose file is gone drops that window alone and restores the rest', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac10`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);
    await awaitStoredWindows(page, workspaceId!, ['CLAUDE.md', 'CLAUDE.local.md']);

    // One of the two files disappears between the save and the restore. The
    // stored value is untouched and well formed; what changed is the world it
    // points at, which is what separates this from AC-9.
    unlinkSync(join(workdir, 'CLAUDE.local.md'));

    await page.reload();
    await ensureTabMode(page);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // The surviving window is counted directly. Asserting only that no error
    // appeared would also pass an implementation that restored nothing at all.
    await expect(editorWindow(page)).toBeVisible({ timeout: 25000 });
    await expect.poll(
      async () => editorWindows(page).count(),
      { timeout: 20000, message: 'the restore did not settle on one window' },
    ).toBe(1);
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).toHaveCount(0);
    await expect(editorTabFor(page, 'CLAUDE.local.md')).toHaveCount(0);

    // And nothing was surfaced about the file that is gone.
    await expect(page.locator('.editor-window-error')).toHaveCount(0);
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
  });

  // TC-REQ-FR-MDE-009-AC11-01
  test('FR-MDE-009 a reload brings the window back where the user dragged it', async ({ page }) => {
    // The placement state is not stored -- a reload opens the window in its
    // default placement -- but where the window sits is, under one global key.
    // The two facts are easy to conflate, and conflating them produces a window
    // that comes back covering the stage after every reload while the cache
    // that was supposed to remember its position sits unread.
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac11`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // Nothing cached to begin with, so the rect below is this drag's and not
    // one an earlier test left behind.
    await page.evaluate(k => localStorage.removeItem(k), GEOMETRY_CACHE_KEY);
    await openWindows(page, ['CLAUDE.md']);
    await awaitStoredWindows(page, workspaceId!, ['CLAUDE.md']);

    const surface = editorWindow(page);
    const opened = await surface.boundingBox();
    expect(opened).not.toBeNull();

    await page.mouse.move(opened!.x + opened!.width / 2, opened!.y + 8);
    await page.mouse.down();
    await page.mouse.move(opened!.x + opened!.width / 2 - 130, opened!.y + 8 + 70, { steps: 10 });
    await page.mouse.up();

    const dragged = await surface.boundingBox();
    expect(dragged).not.toBeNull();
    // The drag really moved it, so the comparison after the reload is between
    // two different boxes rather than one box with itself.
    expect(Math.abs(dragged!.x - opened!.x)).toBeGreaterThan(20);

    // The cache took the drag. Asserted before the reload so a failure below
    // names which half broke: the write, or the read the reopen path does.
    await expect.poll(
      async () => page.evaluate(k => localStorage.getItem(k), GEOMETRY_CACHE_KEY),
      { timeout: 10000, message: 'the drag never reached the geometry cache' },
    ).not.toBeNull();

    await page.reload();
    await ensureTabMode(page);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await expect(editorWindow(page)).toHaveCount(1, { timeout: 20000 });
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });

    // Reopened at the dragged rect. Polled rather than read once: the reopen
    // runs on an effect, and the first paint can precede the placement.
    await expect.poll(
      async () => {
        const box = await editorWindow(page).boundingBox();
        return box === null ? null : {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      },
      { timeout: 15000, message: 'the reopened window never reached the cached rect' },
    ).toEqual({
      x: Math.round(dragged!.x),
      y: Math.round(dragged!.y),
      width: Math.round(dragged!.width),
      height: Math.round(dragged!.height),
    });
  });
});

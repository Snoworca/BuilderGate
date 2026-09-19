// The placement and stacking criteria that only a real browser can settle:
// what is measured rather than computed, what a pointer press reorders, and
// what a modal does to the windows already on screen.
//
// Three of these read something no assertion can reach through the DOM:
//
//   * FR-MDE-001 AC-9 wants the terminal host registry entry a hidden tab
//     actually produced -- its `isVisible` flag, not a guess derived from a
//     bounding box, and its absence after the slot unmounts. The registry is a
//     React context value, so the page must be given a read-only window hook.
//     This spec names that hook `__buildergateEditorWindowDebug`; installing it
//     belongs to the implementation, beside the layer that already holds the
//     registry. The shape is deliberately the smallest thing that answers the
//     criterion: one lookup, returning the entry or `undefined`.
//
//   * FR-MDE-003 AC-1 and AC-2 want front-to-back order. Every window surface
//     sits inside its own `position: fixed` layer, so the surface's own z-index
//     is the same number in every window; only the layer's differs. Ordering is
//     therefore read off `.window-dialog-layer-modeless`.
//
//   * FR-MDE-004 AC-8 wants the box that was rendered, not the rect that was
//     computed. The terminal host slot is measured at runtime and compared with
//     the window beside it, so the arithmetic of the mosaic split never enters
//     this file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Locator, type Page } from '@playwright/test';

import { login } from './helpers';

/**
 * The authoritative declaration of `window.__buildergateEditorWindowDebug` lives
 * beside the code that installs it, in src/components/editor/EditorWindowLayer.tsx,
 * and reaches this spec through the `"include": ["src"]` of tsconfig.test.json.
 *
 * Issue #115: this spec used to carry its own narrowed copy. Four specs each had
 * one, all different, and none of them was ever compiled next to another — the
 * specs were in no tsconfig at all. Registering them put the copies in one
 * program, where they are TS2717 conflicts. A narrowed copy of a global is the
 * same defect the tsconfig comment warns about: it type-checks against a shape
 * that is not the one production installs.
 */

const TAB_NAME_PREFIX = 'e2e-mde-place';

/** Labels this spec gives the command presets it creates, so cleanup finds them. */
const PRESET_LABEL_PREFIX = 'e2e-mde-toast';

/**
 * The single key the window's cached position lives under.
 *
 * Spelled out rather than imported: a module that renamed it would then be
 * caught here rather than followed into a test that still passes.
 */
const GEOMETRY_CACHE_KEY = 'buildergate.editor-window.geometry';

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mdp-'));
  writeFileSync(join(dir, 'CLAUDE.md'), '# alpha alpha alpha alpha alpha alpha\n', 'utf-8');
  writeFileSync(join(dir, 'CLAUDE.local.md'), '# beta beta beta beta beta beta\n', 'utf-8');
  createdDirs.push(dir);
  return dir;
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

async function removeOwnTabs(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, prefix }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
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

/**
 * Removes the command presets this spec creates. Left behind, a second run
 * would find two rows carrying the same label and the locator that opens the
 * toast would match both -- a failure this file caused itself.
 */
async function removeOwnPresets(page: Page): Promise<void> {
  await page.evaluate(async (prefix) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/command-presets', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const presets: { id: string; label?: string }[] = Array.isArray(data.presets) ? data.presets : [];
    for (const preset of presets) {
      if (typeof preset.label === 'string' && preset.label.startsWith(prefix)) {
        await fetch(`/api/command-presets/${preset.id}`, { method: 'DELETE', headers });
      }
    }
  }, PRESET_LABEL_PREFIX);
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first().click();
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

/** The layer whose z-index carries front-to-back order for one window. */
/**
 * The modeless layer the editor window paints in.
 *
 * Not selected by file name: one window holds every open document, so there is
 * no second editor layer for a name to choose between. Other modeless dialogs
 * do have their own layers, which is why this is still narrowed to the one
 * holding the editor surface.
 */
function editorModelessLayer(page: Page): Locator {
  return page.locator('.window-dialog-layer-modeless').filter({
    has: page.locator('.editor-window-surface'),
  }).first();
}

async function layerZOf(page: Page): Promise<number> {
  return editorModelessLayer(page)
    .evaluate(element => Number.parseInt(getComputedStyle(element).zIndex, 10));
}

/** Opens one window per file on the tab that is on screen. */
async function openWindows(page: Page, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    await chooseFile(page, fileName);
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
  }
}

test.describe('markdown editor placement and stacking', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only placement coverage');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await ensureTabMode(page);
      await removeOwnTabs(page, workspaceId);
      await removeOwnPresets(page);
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

  // TC-REQ-FR-MDE-001-AC3-01
  test('FR-MDE-001 the title bar carries four controls and no terminal fill', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac3`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md']);

    const surface = editorWindow(page);

    // The three controls that remain are located before the absent one is
    // asserted. A locator that quietly matched nothing would make the negative
    // assertion below pass on an empty page.
    await expect(surface.locator('button[aria-label="저장"]')).toBeVisible();
    await expect(surface.locator('button[aria-label="최대화"]')).toBeVisible();
    await expect(surface.locator('button[aria-label="최소화"]')).toBeVisible();
    await expect(surface.locator('button[aria-label="Close"]')).toBeVisible();

    // Four in total, so a fifth control added back would fail here even under a
    // label this test does not name.
    await expect(surface.locator('.window-dialog-titlebar button')).toHaveCount(4);

    // And the removed one by name, which is what the criterion is about.
    await expect(surface.locator('button[aria-label="터미널 채움"]')).toHaveCount(0);

    // 최대화 is the control that now carries the placement axis on its own, and
    // it reports which end the window is at. A window opens floating, so the
    // toggle starts unpressed and pressing it fills the stage.
    //
    // Both legs. The return leg was broken until the window dialog learned to
    // drop a drag report that moved nothing: `Rnd` raises one for a press on
    // its handle, the title bar is that handle, and the rect it carried read as
    // the user placing the window -- which sent the placement back to
    // `floating` the moment 최대화 had put it in `stage`.
    const maximize = surface.locator('button[aria-label="최대화"]');
    await expect(maximize).toHaveAttribute('aria-pressed', 'false');

    const floated = await surface.boundingBox();
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    expect(floated).not.toBeNull();
    expect(stage).not.toBeNull();
    expect(floated!.width).toBeLessThan(stage!.width - 2);

    // Centred in the stage, which is the box it is confined to. Asserted on the
    // rendered box rather than on the rule that produced it: the rule is judged
    // by `editorWindowInitialRect.test.ts`, and a rect that never survives to
    // the screen would leave that suite green and the window against an edge.
    // One pixel of slack for the rounding a half-pixel margin takes.
    const leftMargin = floated!.x - stage!.x;
    const rightMargin = (stage!.x + stage!.width) - (floated!.x + floated!.width);
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThanOrEqual(1);
    expect(leftMargin).toBeGreaterThan(1);

    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'true');

    // And the placement really moved rather than only the attribute.
    await expect.poll(async () => {
      const filled = await surface.boundingBox();
      return filled === null ? -1 : Math.abs(filled.width - stage!.width);
    }, { timeout: 10000 }).toBeLessThanOrEqual(2);

    // Back again, to the rect it had before. Asserted on the box as well as the
    // attribute: the attribute alone was true throughout the defect this
    // guards, because the placement flipped to `stage` and back within one
    // commit and the button never reported the return.
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => {
      const restored = await surface.boundingBox();
      return restored === null ? -1 : Math.round(restored.width);
    }, { timeout: 10000 }).toBe(Math.round(floated!.width));

    // And it toggles again, so the window is not left in a state that only
    // happens to look right once.
    await maximize.click();
    await expect(maximize).toHaveAttribute('aria-pressed', 'true');
  });

  // TC-REQ-FR-MDE-009-AC7-01
  test('FR-MDE-009 a dragged window reopens where it was left, from one global key', async ({ page }) => {
    // The window used to open at a computed placement every time and write
    // nothing. It caches what the user arranged now, under a single key that
    // names no workspace and no document.
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac8`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // Nothing cached to begin with, so the rect below is the one this drag
    // produced rather than one left by an earlier test.
    await page.evaluate(k => localStorage.removeItem(k), GEOMETRY_CACHE_KEY);
    await openWindows(page, ['CLAUDE.md']);

    const surface = editorWindow(page);
    const opened = await surface.boundingBox();
    expect(opened).not.toBeNull();

    // Drag it by the title bar, far enough that the move cannot be rounding.
    await page.mouse.move(opened!.x + opened!.width / 2, opened!.y + 8);
    await page.mouse.down();
    await page.mouse.move(opened!.x + opened!.width / 2 - 120, opened!.y + 8 + 90, { steps: 10 });
    await page.mouse.up();

    const dragged = await surface.boundingBox();
    expect(dragged).not.toBeNull();
    expect(Math.abs(dragged!.x - opened!.x)).toBeGreaterThan(20);

    // The cache took it, under the one key.
    const cached = await page.evaluate(k => localStorage.getItem(k), GEOMETRY_CACHE_KEY);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual({
      x: Math.round(dragged!.x),
      y: Math.round(dragged!.y),
      width: Math.round(dragged!.width),
      height: Math.round(dragged!.height),
    });

    // Close every document, which closes the window, and open one again. The
    // window comes back where it was dragged to rather than at its opening
    // placement -- which the first box above is, so the two are distinguishable.
    await surface.locator('button[aria-label="Close"]').click();
    await expect(editorWindow(page)).toHaveCount(0, { timeout: 10000 });

    await openWindows(page, ['CLAUDE.md']);
    const reopened = await editorWindow(page).boundingBox();
    expect(reopened).not.toBeNull();
    expect(Math.round(reopened!.x)).toBe(Math.round(dragged!.x));
    expect(Math.round(reopened!.y)).toBe(Math.round(dragged!.y));
    expect(Math.round(reopened!.width)).toBe(Math.round(dragged!.width));
    expect(Math.round(reopened!.height)).toBe(Math.round(dragged!.height));
  });

  // TC-REQ-FR-MDE-001-AC9-01
  test('FR-MDE-001 a window survives both hiding and deleting the tab it was opened from', async ({ page }) => {
    const workdir = makeWorkdir();
    const boundName = `${TAB_NAME_PREFIX}-ac9-bound`;
    const otherName = `${TAB_NAME_PREFIX}-ac9-other`;
    const boundTabId = await addTabAt(page, workspaceId!, workdir, boundName);
    await addTabAt(page, workspaceId!, makeWorkdir(), otherName);

    await selectTab(page, boundName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md']);

    // Hide the bound tab by making the other one active. Its slot stays mounted
    // and keeps reporting -- off screen, hence a rect that collapses to nothing.
    // The window used to be hidden along with it; it no longer is.
    await selectTab(page, otherName);
    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    // The tab switch has reached the registry before it is read. The window is
    // no longer what changes here, so waiting on the window would be waiting on
    // nothing -- the slot itself is what goes off screen.
    await expect(page.locator(`[data-terminal-host-slot="${boundTabId}"]`))
      .toBeHidden({ timeout: 15000 });

    // The registry really is reporting the tab as unusable, so the assertion
    // above is about the window ignoring that fact rather than about a tab that
    // never went away.
    const hidden = await page.evaluate(
      tabId => window.__buildergateEditorWindowDebug?.readTerminalHost(tabId) ?? null,
      boundTabId,
    );
    expect(hidden).not.toBeNull();
    expect(hidden!.isVisible).toBe(false);
    expect(hidden!.rect.width).toBe(0);
    expect(hidden!.rect.height).toBe(0);

    // Deleting the tab takes the registry entry away entirely, and the window --
    // which may be holding a body nobody has saved -- still has to be reachable.
    await deleteTab(page, workspaceId!, boundTabId);
    await expect.poll(async () => page.evaluate(
      tabId => window.__buildergateEditorWindowDebug?.readTerminalHost(tabId) ?? null,
      boundTabId,
    ), { timeout: 15000 }).toBeNull();
    await expect(surface).toBeVisible({ timeout: 15000 });

    // It reports itself unsaveable instead of disappearing, which is the branch
    // that makes the window's survival useful rather than merely visible.
    await expect(surface.locator('button[aria-label="저장"]')).toBeDisabled();
  });

  // The four raising cases that stood here pressed one editor window to bring
  // it in front of another. There is one editor window per workspace now, so
  // nothing of its own is behind it -- `FR-MDE-003` keeps only the band that
  // separates it from the modals above, and the cases below judge that.
  //
  // What replaces them is the operation that took over from raising: choosing
  // among the open documents. That is a tab switch, and what has to survive it
  // is the editor instance and the body in it.

  // TC-REQ-FR-MDE-010-AC1-01
  test('FR-MDE-010 switching tabs keeps every document mounted with its unsaved body', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-tabswitch`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    // One window, two tabs. Counted before anything is asserted about them, so
    // a row that rendered nothing fails here rather than making the assertions
    // below hold over an empty list.
    await expect(editorWindows(page)).toHaveCount(1);
    await expect(editorTabs(page)).toHaveCount(2);

    // The second one opened is the active tab, and the first is mounted behind
    // it rather than thrown away.
    await expect(editorTabFor(page, 'CLAUDE.local.md'))
      .toHaveAttribute('aria-selected', 'true');
    await expect(editorPanelFor(page, 'CLAUDE.md')).toHaveCount(1);
    await expect(editorPanelFor(page, 'CLAUDE.md')).toHaveCSS('display', 'none');
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).not.toHaveCSS('display', 'none');

    // Type into the hidden one through its own editor, then switch to it. The
    // body has to be there, which it can only be if the instance never went.
    const hiddenEditor = editorPanelFor(page, 'CLAUDE.md').locator('.cm-content');
    await expect(hiddenEditor).toBeAttached();
    await hiddenEditor.evaluate((element) => {
      element.setAttribute('data-e2e-editor-stamp', 'behind-a-tab');
    });

    await editorTabFor(page, 'CLAUDE.md').click();
    await expect(editorTabFor(page, 'CLAUDE.md')).toHaveAttribute('aria-selected', 'true');
    await expect(editorPanelFor(page, 'CLAUDE.md')).not.toHaveCSS('display', 'none');
    expect(await hiddenEditor.getAttribute('data-e2e-editor-stamp')).toBe('behind-a-tab');

    // And the one that was active is now the one behind, still mounted.
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).toHaveCount(1);
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).toHaveCSS('display', 'none');
  });

  // TC-REQ-FR-MDE-010-AC2-01
  test('FR-MDE-010 closing a tab leaves the others, and the last one closes the window', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-tabclose`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    await expect(editorTabs(page)).toHaveCount(2);

    // Closing the active tab leaves the other one, and that one becomes active
    // -- a window showing no document would have nothing to draw.
    await page.locator('.editor-tab-close').nth(1).click();
    await expect(editorTabs(page)).toHaveCount(1);
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).toHaveCount(0);
    await expect(editorTabFor(page, 'CLAUDE.md')).toHaveAttribute('aria-selected', 'true');
    await expect(editorWindows(page)).toHaveCount(1);

    // The last tab takes the window with it.
    await page.locator('.editor-tab-close').first().click();
    await expect(editorWindows(page)).toHaveCount(0, { timeout: 10000 });
  });

  // TC-REQ-FR-MDE-003-AC6-01
  test('FR-MDE-003 a modal keeps isTopmost with editor windows present', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-modaltop`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    await page.locator('button[title="Tools"]').click();
    await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
    const dialog = page.getByTestId('command-preset-dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // The criterion is conditioned on a raise happening while the modal is up,
    // so the raise has to happen. The window is inert by then, which is why the
    // press is dispatched at the node: a shared stack would answer this by
    // pushing the modeless entry past the modal, and that is the regression
    // being looked for. A test that never raised could not see it.
    //
    // The raise no longer reorders two editor windows -- there is one -- so what
    // is asked of it is only that it was attempted.
    await editorWindow(page).locator('.window-dialog-titlebar')
      .dispatchEvent('pointerdown');

    // The modal is still the topmost of its own band.
    const modalZ = await page.locator('.window-dialog-layer-modal').first()
      .evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    expect(modalZ).toBeGreaterThan(await layerZOf(page));

    // Tab containment is what isTopmost buys the modal. Ten presses is more
    // than the dialog has focusables, so a leak would have shown by then.
    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        document.activeElement?.closest('.window-dialog-layer-modal') !== null);
      expect(inside).toBe(true);
    }

    // And Escape is still ignored, which is what "behaves exactly as it does
    // with no editor window present" means for this modal: `WindowDialog`
    // swallows the key rather than closing, and `command-management-dialog`
    // pins that with no editor window in the picture. A window in front must
    // not change it either way -- neither taking the key nor making it close.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    // Both documents are still open. Counted as tabs rather than as windows:
    // they share one window, so a count of windows would say 1 whether the
    // second document survived the modal or not.
    await expect(editorWindows(page)).toHaveCount(1);
    await expect(editorTabs(page)).toHaveCount(2);

    // Closing through the control that does close it, so the modal does not
    // outlive the test and the documents are observed to survive it.
    await page.locator('.window-dialog-layer-modal button[aria-label="Close"]').first().click();
    await expect(dialog).toHaveCount(0);
    await expect(editorTabs(page)).toHaveCount(2);
  });

  // TC-REQ-CON-MDE-001-AC5-01
  test('CON-MDE-001 the command preset toast still renders above its dialog', async ({ page }) => {
    // Any leftover from an earlier run would give the copy button's label two
    // owners, so the slate is cleared before the row is created.
    await removeOwnPresets(page);
    await page.evaluate(async (label) => {
      const token = localStorage.getItem('cws_auth_token');
      await fetch('/api/command-presets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ kind: 'command', label, value: 'echo mde' }),
      });
    }, PRESET_LABEL_PREFIX);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.locator('button[title="Tools"]').click();
    await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
    await expect(page.getByTestId('command-preset-dialog')).toBeVisible({ timeout: 10000 });

    await page.locator(`.command-preset-icon-button[aria-label="${PRESET_LABEL_PREFIX} 복사"]`)
      .first().click();
    const toast = page.locator('.command-preset-toast');
    await expect(toast).toBeVisible({ timeout: 5000 });

    // The modal band was not raised, so the toast is still the thing on top.
    const toastZ = await toast.evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    const modalZ = await page.locator('.window-dialog-layer-modal').first()
      .evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    expect(toastZ).toBeGreaterThan(modalZ);

    // Two z-indexes are only about order where the boxes share screen space,
    // so the overlap is asserted rather than assumed. A hit test would answer
    // a different question: the modal marks every sibling of its own layer
    // `inert`, and the toast lives inside one of them, so it is deliberately
    // not pointer-reachable while the modal is up. Painting above is what the
    // criterion asks for, and it is what is checked here.
    const toastBox = await toast.boundingBox();
    const modalBox = await page.locator('.window-dialog-layer-modal').first().boundingBox();
    expect(toastBox).not.toBeNull();
    expect(modalBox).not.toBeNull();
    const overlaps = toastBox!.x < modalBox!.x + modalBox!.width
      && modalBox!.x < toastBox!.x + toastBox!.width
      && toastBox!.y < modalBox!.y + modalBox!.height
      && modalBox!.y < toastBox!.y + toastBox!.height;
    expect(overlaps).toBe(true);
  });

  // TC-REQ-CON-MDE-001-AC6-01
  test('CON-MDE-001 a modal renders above every editor window and makes them inert', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-inert`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    const topmostEditorZ = await layerZOf(page);

    await page.locator('button[title="Tools"]').click();
    await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
    const dialog = page.getByTestId('command-preset-dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const modalLayer = page.locator('.window-dialog-layer-modal').first();
    const modalZ = await modalLayer.evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    expect(modalZ).toBeGreaterThan(topmostEditorZ);

    // The editor window is withdrawn from focus and pointer input. Located
    // before the attributes are read, so a layer that stopped rendering would
    // fail here rather than making the assertions hold over nothing.
    const layer = editorModelessLayer(page);
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveAttribute('inert', '');
    await expect(layer).toHaveAttribute('aria-hidden', 'true');

    // Pressing a window's title bar cannot take focus out of the modal.
    await editorWindow(page).locator('.window-dialog-titlebar')
      .click({ force: true });
    expect(await page.evaluate(() =>
      document.activeElement?.closest('.window-dialog-layer-modal') !== null)).toBe(true);

    // Closing the modal gives them back. The close button rather than Escape:
    // this modal ignores Escape by design, and the criterion asks only what
    // happens once the modal closes, not how it was closed.
    await page.locator('.window-dialog-layer-modal button[aria-label="Close"]').first().click();
    await expect(dialog).toHaveCount(0);
    await expect(layer).not.toHaveAttribute('inert', '');
    await expect(layer).not.toHaveAttribute('aria-hidden', 'true');
  });
});

// The mobile layout, which the suite above skips.
//
// In its own describe because the setup differs in two ways that would each
// break a shared one: there is no grid/tab toggle to wait for, and the path
// context menu opens from a dispatched event rather than a right click -- the
// same way the terminal's own mobile menu tests open theirs.
test.describe('markdown editor placement on a mobile layout', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile-only placement coverage');
    await login(page);
    // The workspace has to be on screen before tabs are created against it:
    // a tab added while the page is still loading the workspace is not in the
    // list that load then installs.
    await expect(page.locator('.workspace-tabbar [role="tab"]').first())
      .toBeVisible({ timeout: 20000 });
    workspaceId = await activeWorkspaceId(page);
  });

  test.afterEach(async ({ page }) => {
    if (workspaceId !== null) await removeOwnTabs(page, workspaceId);
  });

  /** Opens the path menu the way a touch device does, and chooses one file. */
  async function chooseFileOnMobile(page: Page, fileName: string): Promise<void> {
    await page.locator('.metadata-cwd-path:visible').first()
      .dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });

    // The sheet, not the desktop menu. Located before anything is clicked, so a
    // menu that failed to open fails here rather than as a click timeout.
    const sheet = page.locator('.context-menu-dialog');
    await expect(sheet).toBeVisible({ timeout: 10000 });
    // The sheet gives its rows their own class rather than reusing the desktop
    // menu's, so the desktop selector matches nothing here.
    await sheet.locator('.context-menu-dialog-item')
      .filter({ has: page.getByText(fileName, { exact: true }) })
      .first()
      .click();
  }

  // TC-REQ-FR-MDE-001-AC10-01
  test('FR-MDE-001 a mobile window fills the stage and writes no cached position', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-mobile`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    // The tab is created through the API and reaches the tab bar on the next
    // workspace refresh. Waiting for it to appear keeps the click below from
    // timing out on an element the page has not been told about yet.
    await expect(page.locator('.workspace-tabbar [role="tab"]', { hasText: tabName }))
      .toBeVisible({ timeout: 20000 });
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    // A cached rect is planted first, so the assertions below distinguish
    // "ignored the cache" from "there was nothing to ignore". It is small
    // enough that a window opening at it could not be mistaken for one filling
    // the stage.
    const planted = JSON.stringify({ x: 7, y: 9, width: 321, height: 241 });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [GEOMETRY_CACHE_KEY, planted]);

    await chooseFileOnMobile(page, 'CLAUDE.md');
    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    // It fills the stage rather than opening at the planted rect.
    const stage = await page.locator('.terminal-workspace-stage').first().boundingBox();
    const box = await surface.boundingBox();
    expect(stage).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.width - stage!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.height - stage!.height)).toBeLessThanOrEqual(2);
    expect(Math.round(box!.width)).not.toBe(321);

    // A drag on the title bar moves nothing, and the cache is left as planted.
    // The cache matters more than the movement: it is shared with the desktop
    // layout, so a write here would open the next desktop window at phone size.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 8);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 80, box!.y + 60, { steps: 8 });
    await page.mouse.up();

    const afterDrag = await surface.boundingBox();
    expect(afterDrag).not.toBeNull();
    expect(Math.round(afterDrag!.x)).toBe(Math.round(box!.x));
    expect(Math.round(afterDrag!.y)).toBe(Math.round(box!.y));
    expect(await page.evaluate(k => localStorage.getItem(k), GEOMETRY_CACHE_KEY)).toBe(planted);
  });

  // TC-REQ-FR-MDE-010-AC3-01
  test('FR-MDE-010 a mobile window still carries its tab row', async ({ page }) => {
    // The tab row is what makes several documents reachable at all. A layout
    // that filled the screen and dropped the row would leave every document but
    // one unreachable, which the placement assertions above would not notice.
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-mobile-tabs`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await expect(page.locator('.workspace-tabbar [role="tab"]', { hasText: tabName }))
      .toBeVisible({ timeout: 20000 });
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);

    await chooseFileOnMobile(page, 'CLAUDE.md');
    await expect(editorWindow(page)).toBeVisible({ timeout: 15000 });
    await chooseFileOnMobile(page, 'CLAUDE.local.md');

    await expect(editorTabs(page)).toHaveCount(2, { timeout: 15000 });
    await expect(editorTabFor(page, 'CLAUDE.local.md'))
      .toHaveAttribute('aria-selected', 'true');

    // And the row selects. Tapping the other tab brings its document forward.
    await editorTabFor(page, 'CLAUDE.md').click();
    await expect(editorTabFor(page, 'CLAUDE.md')).toHaveAttribute('aria-selected', 'true');
    await expect(editorPanelFor(page, 'CLAUDE.md')).not.toHaveCSS('display', 'none');
    await expect(editorPanelFor(page, 'CLAUDE.local.md')).toHaveCSS('display', 'none');
  });
});

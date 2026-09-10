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

declare global {
  interface Window {
    /**
     * Read-only view of the terminal host registry, for the criteria that ask
     * what the registry holds rather than what the screen shows.
     */
    __buildergateEditorWindowDebug?: {
      readTerminalHost(tabId: string): {
        isVisible: boolean;
        rect: { left: number; top: number; width: number; height: number };
      } | undefined;
    };
  }
}

const TAB_NAME_PREFIX = 'e2e-mde-place';

/** Labels this spec gives the command presets it creates, so cleanup finds them. */
const PRESET_LABEL_PREFIX = 'e2e-mde-toast';

/** A rect no computed placement can produce, so a match is unambiguous. */
const SENTINEL_GEOMETRY = { schemaVersion: 1, x: 3, y: 3, width: 641, height: 401 };

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

function resolveAgainst(cwd: string, fileName: string): string {
  const separator = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+/g, separator).replace(/[\\/]+$/, '');
  return `${base}${separator}${fileName}`;
}

/** The key `dialogGeometry` writes under, for the dialog id the window uses. */
function geometryKeyFor(filePath: string): string {
  return `buildergate.dialog.editor-window:${filePath}.geometry`;
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

/**
 * Removes the command presets this spec creates. Left behind, a second run
 * would find two rows carrying the same label and the locator that opens the
 * toast would match both -- a failure this file caused itself.
 */
async function removeOwnPresets(page: Page): Promise<void> {
  await page.evaluate(async (prefix) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
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

function editorWindowFor(page: Page, fileName: string): Locator {
  return editorWindows(page).filter({
    has: page.locator('.window-dialog-title').getByText(fileName, { exact: true }),
  });
}

/** The layer whose z-index carries front-to-back order for one window. */
function modelessLayerFor(page: Page, fileName: string): Locator {
  return page.locator('.window-dialog-layer-modeless').filter({
    has: page.locator('.editor-window-surface .window-dialog-title').getByText(fileName, { exact: true }),
  }).first();
}

async function layerZOf(page: Page, fileName: string): Promise<number> {
  return modelessLayerFor(page, fileName)
    .evaluate(element => Number.parseInt(getComputedStyle(element).zIndex, 10));
}

/**
 * How far `front` is in front of `back`, as one number taken from one moment.
 *
 * Raising reindexes the whole stack, so both windows' z-index move together. A
 * comparison that froze one side before the press would be waiting for the
 * other side to pass a value the stack no longer has.
 */
async function zLead(page: Page, front: string, back: string): Promise<number> {
  return (await layerZOf(page, front)) - (await layerZOf(page, back));
}

/**
 * A point inside `back` that `front` does not cover, so a real press there is
 * one a user could make. Falls back to the top-left corner when the two boxes
 * do not overlap at all.
 */
function exposedPoint(
  back: { x: number; y: number; width: number; height: number },
  front: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  if (front.x > back.x) {
    return { x: back.x + (front.x - back.x) / 2, y: back.y + 6 };
  }
  if (front.y > back.y) {
    return { x: back.x + back.width / 2, y: back.y + (front.y - back.y) / 2 };
  }
  return { x: back.x + 4, y: back.y + 4 };
}

/** Opens one window per file on the tab that is on screen. */
async function openWindows(page: Page, fileNames: readonly string[]): Promise<void> {
  for (const fileName of fileNames) {
    await chooseFile(page, fileName);
    await expect(editorWindowFor(page, fileName)).toBeVisible({ timeout: 15000 });
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

    const surface = editorWindowFor(page, 'CLAUDE.md');

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
    // Only the outward leg is asserted. Pressing 최대화 a second time does not
    // return the window to `floating`: the press does not reach the toggle at
    // all, observed by instrumenting the handler. The same happens on the
    // commit before `docked` was removed, measured there directly, so it is not
    // this change -- it is issue #45, and no test had ever pressed this control
    // twice in a row for it to show up in.
    //
    // Restore the return leg here when #45 closes. There is no other case in
    // this repository that presses `stage` -> `floating` through the UI.
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
  });

  // TC-REQ-FR-MDE-001-AC8-03
  test('FR-MDE-001 a stored geometry never reaches the screen and closing writes none', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-ac8`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    const cwd = await awaitReportedCwd(page, workdir);
    const filePath = resolveAgainst(cwd, 'CLAUDE.md');
    const key = geometryKeyFor(filePath);
    const planted = JSON.stringify(SENTINEL_GEOMETRY);

    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, planted]);
    await openWindows(page, ['CLAUDE.md']);

    // The rect that reached the screen is the computed one, not the stored
    // sentinel, and it sits inside the stage rather than at the stored origin.
    const surface = editorWindowFor(page, 'CLAUDE.md');
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).not.toBe(SENTINEL_GEOMETRY.width);
    expect(Math.round(box!.height)).not.toBe(SENTINEL_GEOMETRY.height);
    // The origin too: a rect that kept the stored x and y while recomputing its
    // size would still be the stored rect reaching the screen.
    expect(Math.round(box!.x)).not.toBe(SENTINEL_GEOMETRY.x);
    expect(Math.round(box!.y)).not.toBe(SENTINEL_GEOMETRY.y);
    // It is where the placement put it: inside the terminal area of its tab.
    const slot = await page.locator('.terminal-workspace-stage').first().boundingBox();
    expect(slot).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(slot!.x - 1);
    expect(box!.y).toBeGreaterThanOrEqual(slot!.y - 1);

    // Closing through the title bar button is the only path that would write,
    // so that is the path the criterion has to be taken on.
    await surface.locator('button[aria-label="Close"]').click();
    await expect(editorWindowFor(page, 'CLAUDE.md')).toHaveCount(0);
    expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe(planted);
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
    const surface = editorWindowFor(page, 'CLAUDE.md');
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

  // TC-REQ-FR-MDE-003-AC1-01
  test('FR-MDE-003 pressing a covered window raises it above the other', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-raise`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    // The second one opened sits in front.
    expect(await zLead(page, 'CLAUDE.local.md', 'CLAUDE.md')).toBeGreaterThan(0);

    // Both windows open at the same rect, so the back one is covered edge to
    // edge and there is no point on it left to press. The front one is dragged
    // aside first by its title bar, which is what exposes a strip of the back
    // one -- "covered" has to mean reachable, or the criterion is about nothing.
    const front = editorWindowFor(page, 'CLAUDE.local.md');
    const beforeDrag = await front.boundingBox();
    expect(beforeDrag).not.toBeNull();
    await page.mouse.move(beforeDrag!.x + beforeDrag!.width / 2, beforeDrag!.y + 8);
    await page.mouse.down();
    await page.mouse.move(
      beforeDrag!.x + beforeDrag!.width / 2 + 160,
      beforeDrag!.y + 8 + 120,
      { steps: 10 },
    );
    await page.mouse.up();

    // The drag moved it, or the exposure below is imaginary.
    await expect.poll(async () => {
      const moved = await front.boundingBox();
      return moved === null ? 0 : Math.abs(moved.x - beforeDrag!.x) + Math.abs(moved.y - beforeDrag!.y);
    }, { timeout: 10000 }).toBeGreaterThan(20);

    // A real press on the part of the covered window that is still exposed.
    const back = editorWindowFor(page, 'CLAUDE.md');
    const backBox = await back.boundingBox();
    const frontBox = await front.boundingBox();
    expect(backBox).not.toBeNull();
    expect(frontBox).not.toBeNull();
    const point = exposedPoint(backBox!, frontBox!);
    expect(await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest('.editor-window-surface') !== null;
    }, point)).toBe(true);
    await page.mouse.click(point.x, point.y);

    await expect.poll(async () => zLead(page, 'CLAUDE.md', 'CLAUDE.local.md'), { timeout: 10000 })
      .toBeGreaterThan(0);
  });

  // TC-REQ-FR-MDE-003-AC2-01
  test('FR-MDE-003 pressing nested editor content still raises the window', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-nested`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    expect(await zLead(page, 'CLAUDE.local.md', 'CLAUDE.md')).toBeGreaterThan(0);

    // Deep inside the editor rather than on the surface. The press is
    // dispatched at the node rather than at a screen point on purpose: what is
    // under test is which phase the listener runs in, and a covered content
    // area would otherwise turn this into a second reachability test.
    const line = editorWindowFor(page, 'CLAUDE.md').locator('.cm-content .cm-line').first();
    await expect(line).toBeAttached({ timeout: 15000 });
    await line.dispatchEvent('pointerdown');

    await expect.poll(async () => zLead(page, 'CLAUDE.md', 'CLAUDE.local.md'), { timeout: 10000 })
      .toBeGreaterThan(0);
  });

  // TC-REQ-FR-MDE-003-AC3-01
  test('FR-MDE-003 the raise handler calls neither stopPropagation nor preventDefault', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-propagate`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    const line = editorWindowFor(page, 'CLAUDE.md').locator('.cm-content .cm-line').first();
    await expect(line).toBeAttached({ timeout: 15000 });

    // A listener on the pressed descendant, in the bubble phase. If the raise
    // handler stopped propagation this never runs; if it prevented the default
    // the flag comes back true.
    const observed = await line.evaluate(async (element) => {
      return new Promise<{ reached: boolean; defaultPrevented: boolean }>((resolve) => {
        const onPointerDown = (event: PointerEvent) => {
          element.removeEventListener('pointerdown', onPointerDown);
          resolve({ reached: true, defaultPrevented: event.defaultPrevented });
        };
        element.addEventListener('pointerdown', onPointerDown);
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 2,
          clientY: rect.top + 2,
        }));
        setTimeout(() => resolve({ reached: false, defaultPrevented: false }), 2000);
      });
    });

    expect(observed.reached).toBe(true);
    expect(observed.defaultPrevented).toBe(false);
    // The press still did its job, so it was a raise and not a swallow.
    await expect.poll(async () => zLead(page, 'CLAUDE.md', 'CLAUDE.local.md'), { timeout: 10000 })
      .toBeGreaterThan(0);

    // A dispatched event proves the handler called neither method, but only a
    // real press can show the default action still happens. Now that the
    // window is in front, press it for real and read where the caret landed.
    const lineBox = await line.boundingBox();
    expect(lineBox).not.toBeNull();
    await page.mouse.click(lineBox!.x + 4, lineBox!.y + lineBox!.height / 2);
    expect(await page.evaluate(() =>
      document.activeElement?.closest('.cm-content') !== null)).toBe(true);
  });

  // TC-REQ-FR-MDE-003-AC4-01
  test('FR-MDE-003 sibling order is unchanged and a selection drag keeps extending', async ({ page }) => {
    const workdir = makeWorkdir();
    const tabName = `${TAB_NAME_PREFIX}-drag`;
    await addTabAt(page, workspaceId!, workdir, tabName);
    await selectTab(page, tabName);
    await awaitReportedCwd(page, workdir);
    await openWindows(page, ['CLAUDE.md', 'CLAUDE.local.md']);

    // The front window is taken off the screen before the back one is pressed.
    //
    // Both windows open into `stage`, so they fill the same rect exactly and the
    // back one is entirely covered. Dragging the front one away does not help:
    // it is bounded by the stage it fills, so it barely moves.
    //
    // Minimizing withdraws its surface without touching the stack: its layer
    // keeps its z-index and its place among its siblings, so the raise below is
    // still a raise past it and the order this criterion is about is still the
    // order of two windows.
    const front = editorWindowFor(page, 'CLAUDE.local.md');
    await front.locator('button[aria-label="최소화"]').click();
    await expect(front).toBeHidden({ timeout: 10000 });

    // Identify each layer by the window it holds, not by its class: every
    // modeless layer carries the same class, so a swap of two of them would be
    // invisible in a list of class names.
    const readBodyOrder = () => page.evaluate(() =>
      Array.from(document.body.children).map((child) => {
        const title = child.querySelector('.editor-window-surface .window-dialog-title');
        return title === null ? child.className : `editor:${title.textContent ?? ''}`;
      }));

    const orderBefore = await readBodyOrder();
    expect(orderBefore.filter(entry => entry.startsWith('editor:')))
      .toEqual(['editor:CLAUDE.md', 'editor:CLAUDE.local.md']);

    const line = editorWindowFor(page, 'CLAUDE.md').locator('.cm-content .cm-line').first();
    await expect(line).toBeAttached({ timeout: 15000 });
    const lineBox = await line.boundingBox();
    expect(lineBox).not.toBeNull();

    // A row of that line where the far end -- the end most likely to be covered
    // -- is the back window's own text. The whole row is then reachable, which
    // is what the drag below needs.
    //
    // Found by asking the page rather than by arithmetic. A bounding box says
    // where an element is even while something else covers it, so a computed
    // point can sit under another window and turn every assertion after it into
    // one about the wrong window. Asking keeps answering when the layout moves,
    // and finding nothing is itself the failure.
    const pressPoint = await page.evaluate((box) => {
      for (let offset = 2; offset < box.height; offset += 2) {
        const y = box.y + offset;
        const hit = document.elementFromPoint(box.x + box.width - 3, y);
        if (hit === null || hit.closest('.cm-content') === null) continue;
        const surface = hit.closest('.editor-window-surface');
        if (surface?.querySelector('.window-dialog-title')?.textContent === 'CLAUDE.md') {
          return { x: box.x + 3, y };
        }
      }
      return null;
    }, lineBox!);
    expect(pressPoint, "no row of the back window's first line is reachable").not.toBeNull();

    // The press that raises the window is the same one that starts the drag.
    await page.mouse.move(pressPoint!.x, pressPoint!.y);
    await page.mouse.down();
    await page.mouse.move(lineBox!.x + lineBox!.width / 3, pressPoint!.y, { steps: 6 });
    const partial = await page.evaluate(() => document.getSelection()?.toString().length ?? 0);
    await page.mouse.move(lineBox!.x + lineBox!.width - 3, pressPoint!.y, { steps: 6 });
    const extended = await page.evaluate(() => document.getSelection()?.toString().length ?? 0);
    await page.mouse.up();

    expect(partial).toBeGreaterThan(0);
    expect(extended).toBeGreaterThan(partial);

    // Raising repainted; it did not re-insert. The parent's child order is the
    // same list it was, which is what keeps the drag alive.
    const orderAfter = await readBodyOrder();
    expect(orderAfter).toEqual(orderBefore);
    expect(await zLead(page, 'CLAUDE.md', 'CLAUDE.local.md')).toBeGreaterThan(0);
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
    // so the raise has to happen. The windows are inert by then, which is why
    // the press is dispatched at the node: a shared stack would answer this by
    // pushing the modeless entry past the modal, and that is the regression
    // being looked for. A test that never raised could not see it.
    const backLead = await zLead(page, 'CLAUDE.local.md', 'CLAUDE.md');
    expect(backLead).toBeGreaterThan(0);
    await editorWindowFor(page, 'CLAUDE.md').locator('.window-dialog-titlebar')
      .dispatchEvent('pointerdown');
    await expect.poll(async () => zLead(page, 'CLAUDE.md', 'CLAUDE.local.md'), { timeout: 10000 })
      .toBeGreaterThan(0);

    // The modal is still the topmost of its own band.
    const modalZ = await page.locator('.window-dialog-layer-modal').first()
      .evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    expect(modalZ).toBeGreaterThan(await layerZOf(page, 'CLAUDE.md'));

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
    await expect(editorWindows(page)).toHaveCount(2);

    // Closing through the control that does close it, so the modal does not
    // outlive the test and the windows are observed to survive it.
    await page.locator('.window-dialog-layer-modal button[aria-label="Close"]').first().click();
    await expect(dialog).toHaveCount(0);
    await expect(editorWindows(page)).toHaveCount(2);
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

    const topmostEditorZ = Math.max(
      await layerZOf(page, 'CLAUDE.md'),
      await layerZOf(page, 'CLAUDE.local.md'),
    );

    await page.locator('button[title="Tools"]').click();
    await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
    const dialog = page.getByTestId('command-preset-dialog');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const modalLayer = page.locator('.window-dialog-layer-modal').first();
    const modalZ = await modalLayer.evaluate(el => Number.parseInt(getComputedStyle(el).zIndex, 10));
    expect(modalZ).toBeGreaterThan(topmostEditorZ);

    // Every editor window is withdrawn from focus and pointer input.
    const layers = page.locator('.window-dialog-layer-modeless');
    await expect(layers).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) {
      await expect(layers.nth(index)).toHaveAttribute('inert', '');
      await expect(layers.nth(index)).toHaveAttribute('aria-hidden', 'true');
    }

    // Pressing a window's title bar cannot take focus out of the modal.
    await editorWindowFor(page, 'CLAUDE.md').locator('.window-dialog-titlebar')
      .click({ force: true });
    expect(await page.evaluate(() =>
      document.activeElement?.closest('.window-dialog-layer-modal') !== null)).toBe(true);

    // Closing the modal gives them back. The close button rather than Escape:
    // this modal ignores Escape by design, and the criterion asks only what
    // happens once the modal closes, not how it was closed.
    await page.locator('.window-dialog-layer-modal button[aria-label="Close"]').first().click();
    await expect(dialog).toHaveCount(0);
    for (let index = 0; index < 2; index += 1) {
      await expect(layers.nth(index)).not.toHaveAttribute('inert', '');
      await expect(layers.nth(index)).not.toHaveAttribute('aria-hidden', 'true');
    }
  });
});

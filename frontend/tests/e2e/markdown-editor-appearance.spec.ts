// What the editor window looks like, measured in a real browser.
//
// Every fact here is a computed style or a measured box, so none of it can be
// settled by the frontend unit suite, which has no DOM environment and no
// renderer. Colours and widths asserted from a stylesheet's text would only say
// what was written, not what the cascade produced -- and the cascade is exactly
// what is in question, because the palette comes from the vendored editor and
// this project overrides one value of it.
//
// The reading column is measured against its own containing block rather than
// against the window, so the assertion does not have to know how much padding
// sits between them.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Locator, type Page } from '@playwright/test';

import { login } from './helpers';

const TAB_NAME_PREFIX = 'e2e-mde-look';

/** The reading column never grows past this, whatever the window measures. */
const MAX_MEASURE_PX = 1200;
/** The share of its container the reading column takes below that cap. */
const MEASURE_RATIO = 0.95;
/** The share of the window body the editor host takes. */
const HOST_HEIGHT_RATIO = 0.95;
/**
 * Sub-pixel layout and a scrollbar that may or may not be reserved put the
 * measured share a little off the nominal one. Two percentage points is far
 * tighter than the difference between 95% and either 100% or 70ch, which are
 * the values this would have measured before the change.
 */
const RATIO_TOLERANCE = 0.02;

const createdDirs: string[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mdlook-'));
  // Long enough to wrap at any reading width, so the column's measured box is
  // the column's own and not the width of one short line.
  writeFileSync(
    join(dir, 'CLAUDE.md'),
    `# heading\n\n${'alpha beta gamma delta epsilon zeta eta theta '.repeat(40)}\n`,
    'utf-8',
  );
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

async function selectTab(page: Page, name: string): Promise<void> {
  await page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first().click();
}

async function awaitReportedCwd(page: Page, expectedDir: string): Promise<void> {
  const pathBar = page.locator('.metadata-cwd-path:visible').first();
  await expect(pathBar).toHaveAttribute('title', new RegExp(escapeRegExp(expectedDir), 'i'), {
    timeout: 30000,
  });
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

function editorWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface').first();
}

/** A box that must exist for the assertion to mean anything. */
async function boxOf(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element has no box');
  return { width: box.width, height: box.height };
}

/**
 * `rgb()` triplets as the browser reports them, so the assertion compares what
 * was painted rather than the spelling of the value in the sheet.
 */
const WHITE = 'rgb(255, 255, 255)';
const BLACK = 'rgb(0, 0, 0)';
/** The accent Windows paints a selection in. */
const SELECTION_BLUE = 'rgb(0, 120, 212)';
const PALE_TRACK = 'rgb(238, 238, 238)';

test.describe('markdown editor appearance', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only appearance coverage');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try {
      await removeOwnTabs(page, workspaceId);
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

  test('the document area is painted white with black text', async ({ page }) => {
    const workdir = makeWorkdir();
    await addTabAt(page, workspaceId!, workdir, `${TAB_NAME_PREFIX}-colour`);
    await selectTab(page, `${TAB_NAME_PREFIX}-colour`);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    const body = surface.locator('.window-dialog-body');
    await expect(body).toHaveCSS('background-color', WHITE);

    // The text colour comes from the vendored editor's own light palette, which
    // this project opts into rather than restating. Reading it off `.cm-content`
    // is what proves the opt-in reached the cascade.
    const content = surface.locator('.cm-content').first();
    await expect(content).toBeVisible({ timeout: 15000 });
    await expect(content).toHaveCSS('color', BLACK);
  });

  test('the reading column takes 95% of its container while that is under the cap', async ({ page }) => {
    const workdir = makeWorkdir();
    await addTabAt(page, workspaceId!, workdir, `${TAB_NAME_PREFIX}-width`);
    await selectTab(page, `${TAB_NAME_PREFIX}-width`);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    const content = surface.locator('.cm-content').first();
    await expect(content).toBeVisible({ timeout: 15000 });

    // The column's containing block, which is what the percentage resolves
    // against. Measuring against the window instead would fold this window's
    // padding into the ratio.
    const container = surface.locator('.cm-scroller').first();

    const containerBox = await boxOf(container);
    const contentBox = await boxOf(content);

    // The premise. Above the cap this test would be judging the cap instead,
    // which is the next test's job.
    expect(containerBox.width * MEASURE_RATIO).toBeLessThan(MAX_MEASURE_PX);

    expect(contentBox.width / containerBox.width).toBeGreaterThan(MEASURE_RATIO - RATIO_TOLERANCE);
    expect(contentBox.width / containerBox.width).toBeLessThan(MEASURE_RATIO + RATIO_TOLERANCE);
  });

  test('the reading column stops at 1200px however wide the window is', async ({ page }) => {
    // Wide enough that 95% of the maximized stage clears the cap; at the
    // default viewport it does not, and the assertion below would be vacuous.
    await page.setViewportSize({ width: 1800, height: 900 });

    const workdir = makeWorkdir();
    await addTabAt(page, workspaceId!, workdir, `${TAB_NAME_PREFIX}-cap`);
    await selectTab(page, `${TAB_NAME_PREFIX}-cap`);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });
    await surface.locator('button[aria-label="최대화"]').click();

    const content = surface.locator('.cm-content').first();
    await expect(content).toBeVisible({ timeout: 15000 });
    const container = surface.locator('.cm-scroller').first();

    await expect.poll(
      async () => (await boxOf(container)).width * MEASURE_RATIO,
      { timeout: 10000 },
    ).toBeGreaterThan(MAX_MEASURE_PX);

    const contentBox = await boxOf(content);
    expect(contentBox.width).toBeLessThanOrEqual(MAX_MEASURE_PX + 1);
    // And it actually reaches the cap rather than sitting well under it, which
    // a stale 70ch measure would also satisfy.
    expect(contentBox.width).toBeGreaterThan(MAX_MEASURE_PX - 2);
  });

  test('the document scrollbar is drawn in the selection blue on a pale track', async ({ page }) => {
    const workdir = makeWorkdir();
    await addTabAt(page, workspaceId!, workdir, `${TAB_NAME_PREFIX}-scroll`);
    await selectTab(page, `${TAB_NAME_PREFIX}-scroll`);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    const scroller = surface.locator('.cm-scroller').first();
    await expect(scroller).toBeVisible({ timeout: 15000 });

    // The pointer is still where the file was chosen, which leaves the window
    // hovered -- and the thumb has a hover colour of its own, so the read below
    // would return that one. This asserts the resting colour, so the pointer
    // goes somewhere else first.
    await page.mouse.move(0, 0);

    // Read through the element rather than through the stylesheet text: what is
    // in question is whether the rule reached this scroller at all, and a sheet
    // can hold a rule that no element matches. Chrome answers computed styles
    // for the scrollbar pseudo-elements, so the painted colours are readable.
    const painted = await scroller.evaluate((element) => ({
      thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
      track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
      width: getComputedStyle(element, '::-webkit-scrollbar').width,
    }));

    expect(painted.thumb).toBe(SELECTION_BLUE);
    expect(painted.track).toBe(PALE_TRACK);
    // A zero width would mean the scrollbar is not drawn at all, which is the
    // state this replaces -- the colours above would then be describing nothing.
    expect(Number.parseFloat(painted.width)).toBeGreaterThan(0);
  });

  test('the editor host takes 95% of its document panel height', async ({ page }) => {
    const workdir = makeWorkdir();
    await addTabAt(page, workspaceId!, workdir, `${TAB_NAME_PREFIX}-height`);
    await selectTab(page, `${TAB_NAME_PREFIX}-height`);
    await awaitReportedCwd(page, workdir);
    await chooseFile(page, 'CLAUDE.md');

    const surface = editorWindow(page);
    await expect(surface).toBeVisible({ timeout: 15000 });

    // Measured against the document panel rather than the window body. The body
    // also holds the tab row, and the 95% the requirement names is the reading
    // area inside one document -- a ratio taken against the body would shrink
    // every time a tab row grew.
    const body = surface.locator('.editor-document-panel');
    const host = surface.locator('.editor-window-host');
    await expect(host).toBeVisible({ timeout: 15000 });

    const bodyBox = await boxOf(body);
    const hostBox = await boxOf(host);

    // The tab row really is between them, so the change of basis above is not a
    // way of ignoring a regression in the body.
    await expect(surface.locator('.editor-tab-bar')).toBeVisible();

    expect(hostBox.height / bodyBox.height).toBeGreaterThan(HOST_HEIGHT_RATIO - RATIO_TOLERANCE);
    expect(hostBox.height / bodyBox.height).toBeLessThan(HOST_HEIGHT_RATIO + RATIO_TOLERANCE);
  });
});

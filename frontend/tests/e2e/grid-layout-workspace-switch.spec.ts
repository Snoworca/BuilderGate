import { expect, type Page } from '@playwright/test';
import { test } from './workspaceOwnershipFixture';
import { login } from './helpers';

// REL-BGSTAB-040 — switching between grid workspaces restores each workspace's own grid layout
// and mode.
//
// MosaicContainer was not remounted between two grid workspaces. In the first render after a
// switch it still held the previous workspace's tree with the new workspace's tabs, and its
// stale-leaf safeguard rebuilt the new workspace's tree from the previous workspace's mode.
// Measured on 2222: B saved in focus mode (824/275/275) came back as equal (458/458/458).

interface GridWorkspace {
  id: string;
  name: string;
}

async function createGridWorkspace(page: Page, label: string): Promise<GridWorkspace> {
  return page.evaluate(async (label) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('Missing auth token');
    const request = (path: string, method: string, body?: unknown) => fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const name = `E2E Grid Switch ${label} ${Date.now()}`;
    const created = await request('/api/workspaces', 'POST', { name });
    if (!created.ok) throw new Error(`create workspace ${created.status}`);
    const workspace = (await created.json()) as { id: string };
    const state = (await (await request('/api/workspaces', 'GET')).json()) as { tabs: Array<{ workspaceId: string }> };
    const existing = state.tabs.filter((tab) => tab.workspaceId === workspace.id).length;
    for (let i = existing; i < 3; i += 1) {
      const tab = await request(`/api/workspaces/${workspace.id}/tabs`, 'POST', { name: `${label}${i + 1}` });
      if (!tab.ok) throw new Error(`add tab ${tab.status}`);
    }
    const grid = await request(`/api/workspaces/${workspace.id}`, 'PATCH', { viewMode: 'grid' });
    if (!grid.ok) throw new Error(`grid mode ${grid.status}`);
    return { id: workspace.id, name };
  }, label);
}

async function openWorkspace(page: Page, workspace: GridWorkspace): Promise<void> {
  await page.locator('.workspace-item', { hasText: workspace.name }).first().click();
  await expect(page.locator('.mosaic-tile')).toHaveCount(3);
  await page.waitForTimeout(600);
}

async function tileWidths(page: Page): Promise<number[]> {
  return page.locator('.mosaic-tile').evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().width)));
}

async function storedMode(page: Page, workspace: GridWorkspace): Promise<string | null> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`mosaic_layout_${id}`);
    return raw ? (JSON.parse(raw) as { mode?: string }).mode ?? null : null;
  }, workspace.id);
}

async function chooseMode(page: Page, mode: 'focus' | 'equal' | 'auto'): Promise<void> {
  await page.locator('.mosaic-toolbar').first().hover();
  await page.locator(`[data-layout-mode-button="${mode}"]`).first().click();
}

test.describe('REL-BGSTAB-040 grid layout per workspace', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'grid mode is a desktop layout');
    await login(page);
  });

  test('AC-1/AC-2: a focus layout survives a round trip through another grid workspace', async ({ page }) => {
    const a = await createGridWorkspace(page, 'A');
    const b = await createGridWorkspace(page, 'B');
    await page.reload();
    await page.waitForSelector('.workspace-screen');

    await openWorkspace(page, a);
    const aWidths = await tileWidths(page);
    await openWorkspace(page, b);
    await chooseMode(page, 'focus');
    await page.waitForTimeout(2600);
    const focused = await tileWidths(page);
    expect(Math.max(...focused) - Math.min(...focused), `focus widens one tile: ${focused}`).toBeGreaterThan(200);

    for (let round = 0; round < 2; round += 1) {
      await openWorkspace(page, a);
      expect(await tileWidths(page), `A keeps its own layout (round ${round})`).toEqual(aWidths);
      await openWorkspace(page, b);
      const back = await tileWidths(page);
      console.log(`round ${round} B widths ${back} (focused ${focused})`);
      expect(back, `B comes back in focus mode (round ${round})`).toEqual(focused);
    }
    expect(await storedMode(page, b)).toBe('focus');
    expect(await storedMode(page, a)).toBe('equal');
  });

  test('AC-3: a mode chosen right before a switch is kept', async ({ page }) => {
    const a = await createGridWorkspace(page, 'A');
    const b = await createGridWorkspace(page, 'B');
    await page.reload();
    await page.waitForSelector('.workspace-screen');

    await openWorkspace(page, b);
    await chooseMode(page, 'focus');
    await page.waitForTimeout(300);
    const focused = await tileWidths(page);
    await openWorkspace(page, a);
    await openWorkspace(page, b);
    expect(await tileWidths(page)).toEqual(focused);
    expect(await storedMode(page, b)).toBe('focus');
  });
});

import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

async function fetchWorkspaceState(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!res.ok) {
      throw new Error(`workspace fetch failed: ${res.status}`);
    }

    return res.json();
  });
}

async function getActiveTab(page: Page) {
  const state = await fetchWorkspaceState(page);
  const activeWorkspaceId = await page.evaluate(() => localStorage.getItem('active_workspace_id'));
  const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0] ?? null;
  if (!workspace?.activeTabId) {
    return null;
  }

  return state.tabs.find((item: { id: string; workspaceId: string }) =>
    item.id === workspace.activeTabId && item.workspaceId === workspace.id,
  ) ?? null;
}

async function ensureTabMode(page: Page) {
  const switchToTabs = page.locator('button[title="Switch to Tabs"]');
  if (await switchToTabs.count()) {
    await switchToTabs.click();
  }

  await expect(page.locator('button[title="Add Terminal"]')).toBeVisible({ timeout: 15000 });
}

async function ensureAtLeastTwoTabs(page: Page) {
  const tabs = page.locator('[role="tab"]:visible');
  const addButton = page.locator('button[title="Add Terminal"]');

  if (await tabs.count() >= 2) return;

  await addButton.click();
  await expect.poll(async () => tabs.count()).toBeGreaterThanOrEqual(2);
}

async function collectDistinctVisibleTabCwds(page: Page) {
  const tabs = page.locator('[role="tab"]:visible');
  const metadataCwd = page.locator('.metadata-cwd-path:visible').first();
  const distinct: Array<{ index: number; cwd: string }> = [];
  const seen = new Set<string>();

  for (let index = 0; index < await tabs.count(); index++) {
    await tabs.nth(index).click();
    await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true');
    const cwd = await metadataCwd.getAttribute('title');
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    distinct.push({ index, cwd });
    if (distinct.length >= 2) break;
  }

  return distinct;
}

async function createDistinctCwdTab(page: Page, baseCwd: string) {
  const state = await fetchWorkspaceState(page);
  const activeWorkspaceId = await page.evaluate(() => localStorage.getItem('active_workspace_id'));
  const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
  const workspaceTabs = state.tabs
    .filter((item: { workspaceId: string }) => item.workspaceId === workspace?.id)
    .sort((a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder);
  const sourceTab = workspaceTabs.find((item: { lastCwd?: string }) => item.lastCwd === baseCwd)
    ?? workspaceTabs.find((item: { lastCwd?: string }) => item.lastCwd)
    ?? null;

  if (!workspace?.id || !sourceTab?.sessionId || !baseCwd) {
    return null;
  }

  const childDirectory = await page.evaluate(async ({ sessionId, cwd }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(cwd)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

    if (!res.ok) {
      throw new Error(`directory listing failed: ${res.status}`);
    }

    const listing = await res.json();
    return listing.entries.find((entry: { name: string; type: string }) => entry.type === 'directory' && entry.name !== '..') ?? null;
  }, {
    sessionId: sourceTab.sessionId,
    cwd: baseCwd,
  });

  if (!childDirectory?.name) {
    return null;
  }

  const separator = baseCwd.includes('\\') ? '\\' : '/';
  const nextCwd = `${baseCwd}${baseCwd.endsWith(separator) ? '' : separator}${childDirectory.name}`;

  await page.evaluate(async ({ workspaceId, shell, cwd }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ shell, cwd }),
    });

    if (!res.ok) {
      throw new Error(`tab create failed: ${res.status}`);
    }
  }, {
    workspaceId: workspace.id,
    shell: sourceTab.shellType,
    cwd: nextCwd,
  });

  return nextCwd;
}

async function ensureDistinctVisibleTabCwds(page: Page) {
  await ensureAtLeastTwoTabs(page);

  let distinct = await collectDistinctVisibleTabCwds(page);
  if (distinct.length >= 2) {
    return distinct;
  }

  const tabs = page.locator('[role="tab"]:visible');
  const beforeCount = await tabs.count();
  const baseCwd = distinct[0]?.cwd ?? await page.locator('.header-cwd-path').getAttribute('title');
  if (!baseCwd) {
    return distinct;
  }

  const createdCwd = await createDistinctCwdTab(page, baseCwd);
  if (!createdCwd) {
    return distinct;
  }

  await expect.poll(async () => tabs.count(), { timeout: 15000 }).toBe(beforeCount + 1);
  await expect.poll(async () => {
    const matches = await collectDistinctVisibleTabCwds(page);
    return matches.length;
  }, { timeout: 15000 }).toBeGreaterThanOrEqual(2);

  distinct = await collectDistinctVisibleTabCwds(page);
  return distinct;
}

test.describe('Header And Context Menu Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-7001: grid pane focus should update header cwd to the clicked terminal', async ({ page }) => {
    await ensureTabMode(page);

    const tabs = page.locator('[role="tab"]:visible');
    const headerCwd = page.locator('.header-cwd-path');
    const distinctTabs = await ensureDistinctVisibleTabCwds(page);
    test.skip(distinctTabs.length < 2, 'Need two tabs with distinct cwd values');

    const [firstTab, secondTab] = distinctTabs;

    await tabs.nth(firstTab.index).click();
    await expect(headerCwd).toHaveAttribute('title', firstTab.cwd);

    await tabs.nth(secondTab.index).click();
    await expect(headerCwd).toHaveAttribute('title', secondTab.cwd);

    const switchToGrid = page.locator('button[title="Switch to Grid"]');
    await switchToGrid.click();

    const gridCells = page.locator('.grid-cell');
    await expect.poll(async () => gridCells.count()).toBeGreaterThanOrEqual(2);

    const firstCell = gridCells.filter({
      has: page.getByTitle(firstTab.cwd, { exact: true }),
    }).first();
    const secondCell = gridCells.filter({
      has: page.getByTitle(secondTab.cwd, { exact: true }),
    }).first();

    await expect(firstCell).toBeVisible();
    await expect(secondCell).toBeVisible();

    await firstCell.locator('.xterm-screen').click();
    await expect(headerCwd).toHaveAttribute('title', firstTab.cwd, { timeout: 15000 });

    await secondCell.locator('.xterm-screen').click();
    await expect(headerCwd).toHaveAttribute('title', secondTab.cwd, { timeout: 15000 });
  });

  test('TC-7002: terminal context menu should preserve submenu separators', async ({ page }) => {
    const shellCount = await page.evaluate(async () => {
      const token = localStorage.getItem('cws_auth_token');
      const res = await fetch('/api/sessions/shells', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) return 0;
      const shells = await res.json();
      return Array.isArray(shells) ? shells.length : 0;
    });

    test.skip(shellCount <= 1, 'Submenu regression requires multiple configured shells');

    await page.locator('.xterm-screen:visible').first().click({ button: 'right' });

    const rootMenu = page.locator('.context-menu').first();
    await expect(rootMenu).toBeVisible();

    await rootMenu.locator('.context-menu-item').first().hover();

    const submenu = page.locator('.context-submenu');
    await expect(submenu).toBeVisible();
    await expect(submenu.locator('.context-menu-separator')).toHaveCount(1);

    const submenuItems = await submenu.locator('.context-menu-item').count();
    expect(submenuItems).toBeGreaterThanOrEqual(shellCount);
  });

  test('TC-7003: closing a tab should not resurrect its deleted terminal snapshot', async ({ page }) => {
    await ensureTabMode(page);
    const tabs = page.locator('[role="tab"]:visible');
    const addButton = page.locator('button[title="Add Terminal"]');
    const initialTabCount = await tabs.count();
    await addButton.click();
    await expect.poll(async () => tabs.count(), { timeout: 15000 }).toBe(initialTabCount + 1);

    const state = await fetchWorkspaceState(page);
    const activeWorkspaceId = await page.evaluate(() => localStorage.getItem('active_workspace_id'));
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
    const workspaceTabs = state.tabs
      .filter((item: { workspaceId: string }) => item.workspaceId === workspace.id)
      .sort((a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder);
    const activeTab = workspaceTabs[workspaceTabs.length - 1] ?? null;

    expect(activeTab).not.toBeNull();

    await page.evaluate(({ sessionId }) => {
      localStorage.setItem(
        `terminal_snapshot_${sessionId}`,
        JSON.stringify({
          schemaVersion: 1,
          sessionId,
          content: 'seed-snapshot',
          savedAt: new Date().toISOString(),
        }),
      );
    }, { sessionId: activeTab!.sessionId });

    await tabs.nth((await tabs.count()) - 1).locator('button').click();
    await page.locator('.btn-submit').click();

    await expect.poll(async () => {
      return page.evaluate(({ sessionId }) => ({
        snapshot: localStorage.getItem(`terminal_snapshot_${sessionId}`),
        removal: localStorage.getItem(`terminal_snapshot_remove_${sessionId}`),
      }), { sessionId: activeTab!.sessionId });
    }, { timeout: 15000 }).toEqual({ snapshot: null, removal: null });
  });

  test('TC-7004: reload should keep the active session visible and restore its snapshot without xterm runtime errors', async ({ page }) => {
    await ensureTabMode(page);

    const runtimeErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        runtimeErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      runtimeErrors.push(error.message);
    });

    const activeTab = await getActiveTab(page);
    expect(activeTab?.sessionId).toBeTruthy();

    const marker = `refresh-regression-${Date.now()}`;
    await page.locator('.xterm-screen:visible').first().click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      return page.evaluate(({ sessionId }) => {
        return localStorage.getItem(`terminal_snapshot_${sessionId}`) ?? '';
      }, { sessionId: activeTab!.sessionId });
    }, { timeout: 15000 }).toContain(marker);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return page.evaluate(({ sessionId }) => {
        return localStorage.getItem(`terminal_snapshot_${sessionId}`) ?? '';
      }, { sessionId: activeTab!.sessionId });
    }, { timeout: 15000 }).toContain(marker);

    const reloadedActiveTab = await getActiveTab(page);
    expect(reloadedActiveTab?.id).toBe(activeTab!.id);

    expect(
      runtimeErrors.filter((message) =>
        message.includes("reading 'dimensions'")
        || message.includes('[TerminalView] snapshot restore failed')
        || message.includes('[TerminalView] viewport sync failed'),
      ),
    ).toEqual([]);
  });
});

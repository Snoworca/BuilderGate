import { test, expect, type Locator, type Page } from '@playwright/test';
import { login, sendVisibleTerminalCommand, waitForTerminal } from './helpers';

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

async function readVisibleTerminalText(page: Page) {
  const text = await page.locator('.terminal-view:visible .xterm-rows').first().textContent();
  return text ?? '';
}


async function readTerminalSnapshotPayload(page: Page, sessionId: string): Promise<{
  schemaVersion?: number;
  payloadKind?: string;
  content?: string;
  cols?: number;
  rows?: number;
  bufferType?: string;
  byteLength: number;
  raw: string | null;
}> {
  return page.evaluate(({ sessionId }) => {
    const raw = localStorage.getItem(`terminal_snapshot_${sessionId}`);
    if (!raw) {
      return { byteLength: 0, raw };
    }
    try {
      const parsed = JSON.parse(raw) as {
        schemaVersion?: number;
        payloadKind?: string;
        content?: string;
        cols?: number;
        rows?: number;
        bufferType?: string;
      };
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      return {
        schemaVersion: parsed.schemaVersion,
        payloadKind: parsed.payloadKind,
        content,
        cols: parsed.cols,
        rows: parsed.rows,
        bufferType: parsed.bufferType,
        byteLength: new TextEncoder().encode(content).length,
        raw,
      };
    } catch {
      return { byteLength: 0, raw };
    }
  }, { sessionId });
}

async function waitForTerminalSnapshotPayload(page: Page, sessionId: string, marker: string) {
  await expect.poll(async () => {
    const payload = await readTerminalSnapshotPayload(page, sessionId);
    return payload.content ?? '';
  }, { timeout: 15000 }).toContain(marker);

  return readTerminalSnapshotPayload(page, sessionId);
}

async function installEmptyFallbackSnapshotShim(page: Page) {
  const install = () => {
    const win = window as typeof window & {
      __bgTestFallbackShimInstalled?: boolean;
      __bgTestOriginalWebSocket?: typeof WebSocket;
      __bgTestSockets?: WebSocket[];
    };
    if (win.__bgTestFallbackShimInstalled) {
      return;
    }
    win.__bgTestFallbackShimInstalled = true;
    win.__bgTestSockets = [];
    const OriginalWebSocket = WebSocket;
    win.__bgTestOriginalWebSocket = OriginalWebSocket;

    const PatchedWebSocket = function patchedWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      win.__bgTestSockets?.push(socket);
      socket.addEventListener('message', (event) => {
        const targetSessionId = localStorage.getItem('__bg_test_force_empty_fallback_session');
        if (!targetSessionId || typeof event.data !== 'string') {
          return;
        }
        try {
          const message = JSON.parse(event.data) as { type?: string; sessionId?: string };
          if (message.type !== 'screen-snapshot' || message.sessionId !== targetSessionId) {
            return;
          }
          localStorage.removeItem('__bg_test_force_empty_fallback_session');
          event.stopImmediatePropagation();
          const rewritten = {
            ...message,
            mode: 'fallback',
            data: '',
            truncated: false,
          };
          setTimeout(() => {
            socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(rewritten) }));
          }, 0);
        } catch {
          // Ignore non-JSON frames.
        }
      }, true);
      return socket;
    };

    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
  };

  await page.addInitScript(install);
  await page.evaluate(install).catch(() => undefined);
}

async function forceNextSnapshotToEmptyFallback(page: Page, sessionId: string) {
  await page.evaluate(({ sessionId }) => {
    localStorage.setItem('__bg_test_force_empty_fallback_session', sessionId);
  }, { sessionId });
}

async function dispatchEmptyFallbackSnapshot(page: Page, sessionId: string, cols: number, rows: number) {
  await page.evaluate(({ sessionId, cols, rows }) => {
    const win = window as typeof window & { __bgTestSockets?: WebSocket[] };
    const socket = [...(win.__bgTestSockets ?? [])].reverse().find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) {
      throw new Error('No open WebSocket available for fallback dispatch');
    }
    socket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'screen-snapshot',
        sessionId,
        replayToken: `test-fallback-${Date.now()}`,
        seq: Date.now(),
        cols,
        rows,
        mode: 'fallback',
        data: '',
        truncated: false,
        source: 'headless',
      }),
    }));
  }, { sessionId, cols, rows });
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

async function clickGridCellSurface(page: Page, cell: Locator) {
  const box = await cell.boundingBox();
  if (!box) {
    throw new Error('Grid cell has no bounding box');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
  const baseCwd = distinct[0]?.cwd ?? await page.locator('.header-center-subtitle').getAttribute('title');
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

const TC7004_OWNED_WORKSPACE_KEY = '__bg_tc7004_owned_workspace';
const TC7004_PREVIOUS_WORKSPACE_KEY = '__bg_tc7004_previous_workspace';

async function createOwnedTc7004Workspace(page: Page) {
  const ownerToken = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const workspaceName = `PW-TC7004-${ownerToken}`;
  return page.evaluate(async ({ ownedKey, previousKey, workspaceName, ownerToken }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const previousWorkspaceId = localStorage.getItem('active_workspace_id');
    const response = await fetch('/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: workspaceName }),
    });
    if (!response.ok) throw new Error(`owned workspace create failed: ${response.status}`);
    const workspace = await response.json();
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabResponse.ok) {
      await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE', headers });
      throw new Error(`owned tab create failed: ${tabResponse.status}`);
    }
    const tab = await tabResponse.json();
    localStorage.setItem(ownedKey, JSON.stringify({
      workspaceId: workspace.id,
      ownerToken,
      workspaceName,
    }));
    if (previousWorkspaceId) {
      localStorage.setItem(previousKey, previousWorkspaceId);
    } else {
      localStorage.removeItem(previousKey);
    }
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspaceId: workspace.id, tabId: tab.id, sessionId: tab.sessionId };
  }, {
    ownedKey: TC7004_OWNED_WORKSPACE_KEY,
    previousKey: TC7004_PREVIOUS_WORKSPACE_KEY,
    workspaceName,
    ownerToken,
  });
}

async function cleanupOwnedTc7004Workspace(page: Page) {
  const cleanup = await page.evaluate(async ({ ownedKey, previousKey }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const rawOwnership = localStorage.getItem(ownedKey);
    const ownership = rawOwnership ? (() => {
      try {
        return JSON.parse(rawOwnership) as {
          workspaceId?: unknown;
          ownerToken?: unknown;
          workspaceName?: unknown;
        };
      } catch {
        throw new Error('owned TC-7004 workspace record is invalid; deletion refused');
      }
    })() : null;
    if (ownership && (
      typeof ownership.workspaceId !== 'string'
      || typeof ownership.ownerToken !== 'string'
      || typeof ownership.workspaceName !== 'string'
      || !ownership.workspaceName.includes(ownership.ownerToken)
    )) {
      throw new Error('owned TC-7004 workspace record is incomplete; deletion refused');
    }
    const workspaceId = ownership?.workspaceId ?? null;
    const previousWorkspaceId = localStorage.getItem(previousKey);
    if (workspaceId) {
      const ownershipStateResponse = await fetch('/api/workspaces', { headers });
      if (!ownershipStateResponse.ok) {
        throw new Error(`ownership workspace fetch failed: ${ownershipStateResponse.status}`);
      }
      const ownershipState = await ownershipStateResponse.json();
      const exactWorkspace = ownershipState.workspaces.find(
        (workspace: { id: string }) => workspace.id === workspaceId,
      );
      if (
        !exactWorkspace
        || exactWorkspace.name !== ownership!.workspaceName
        || !exactWorkspace.name.includes(ownership!.ownerToken)
      ) {
        throw new Error('owned TC-7004 workspace ownership proof mismatch; deletion refused');
      }
      const response = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`owned TC-7004 workspace cleanup failed: ${response.status}`);
      }
    }
    const stateResponse = await fetch('/api/workspaces', { headers });
    if (!stateResponse.ok) {
      throw new Error(`post-cleanup workspace fetch failed: ${stateResponse.status}`);
    }
    const state = await stateResponse.json();
    if (workspaceId && state.workspaces.some((workspace: { id: string }) => workspace.id === workspaceId)) {
      throw new Error('owned TC-7004 workspace remained after cleanup');
    }
    const previousWorkspaceStillExists = previousWorkspaceId
      ? state.workspaces.some((workspace: { id: string }) => workspace.id === previousWorkspaceId)
      : false;
    if (previousWorkspaceStillExists) {
      localStorage.setItem('active_workspace_id', previousWorkspaceId!);
    } else {
      localStorage.removeItem('active_workspace_id');
    }
    localStorage.removeItem(ownedKey);
    localStorage.removeItem(previousKey);
    return {
      cleanedWorkspaceId: workspaceId,
      restoredWorkspaceId: previousWorkspaceStillExists ? previousWorkspaceId : null,
      activeWorkspaceBeforeReload: localStorage.getItem('active_workspace_id'),
    };
  }, {
    ownedKey: TC7004_OWNED_WORKSPACE_KEY,
    previousKey: TC7004_PREVIOUS_WORKSPACE_KEY,
  });
  if (cleanup.cleanedWorkspaceId) {
    expect(cleanup.activeWorkspaceBeforeReload).toBe(cleanup.restoredWorkspaceId);
    await page.reload();
    if (cleanup.restoredWorkspaceId) {
      await waitForTerminal(page);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('active_workspace_id')))
        .toBe(cleanup.restoredWorkspaceId);
    }
  }
}

test.describe('Header And Context Menu Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupOwnedTc7004Workspace(page);
  });

  test('TC-7001: grid pane focus should update header cwd to the clicked terminal', async ({ page }) => {
    await ensureTabMode(page);

    const tabs = page.locator('[role="tab"]:visible');
    const headerCwd = page.locator('.header-center-subtitle');
    const distinctTabs = await ensureDistinctVisibleTabCwds(page);
    test.skip(distinctTabs.length < 2, 'Need two tabs with distinct cwd values');

    const [firstTab, secondTab] = distinctTabs;

    await tabs.nth(firstTab.index).click();
    await expect(headerCwd).toHaveAttribute('title', firstTab.cwd);

    await tabs.nth(secondTab.index).click();
    await expect(headerCwd).toHaveAttribute('title', secondTab.cwd);

    const switchToGrid = page.locator('button[title="Switch to Grid"]');
    await switchToGrid.click();
    await expect(page.locator('button[title="Switch to Tabs"]')).toBeVisible({ timeout: 15000 });

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

    await clickGridCellSurface(page, firstCell);
    await expect(headerCwd).toHaveAttribute('title', firstTab.cwd, { timeout: 15000 });

    await clickGridCellSurface(page, secondCell);
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

  test('TC-7004: reload should keep the active session visible and restore its snapshot without xterm runtime errors', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await ensureTabMode(page);

    // Characterize a test-owned shell rather than whichever long-running AI
    // TUI happens to be active. afterEach deletes only this owned workspace
    // and restores the user's previously active workspace.
    const owned = await createOwnedTc7004Workspace(page);
    await page.reload();
    await waitForTerminal(page);
    await expect.poll(async () => (await getActiveTab(page))?.id, { timeout: 15000 })
      .toBe(owned.tabId);

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

    const stamp = Date.now();
    const oldMarker = `refresh-old-${stamp}`;
    const latestMarker = `refresh-latest-${stamp}`;
    await sendVisibleTerminalCommand(
      page,
      `node -e "for (let i=1;i<=700;i++) console.log(i===1?'${oldMarker}':i===700?'${latestMarker}':'refresh-fill-'+String(i).padStart(3,'0'))"`,
    );
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(latestMarker, { timeout: 30000 });

    const beforeReloadPayload = await waitForTerminalSnapshotPayload(page, activeTab!.sessionId, latestMarker);
    expect(beforeReloadPayload.schemaVersion).toBe(2);
    expect(beforeReloadPayload.payloadKind).toBe('viewport-only');
    expect(beforeReloadPayload.content ?? '').not.toContain(oldMarker);
    expect(beforeReloadPayload.byteLength).toBeLessThan(12000);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 15000 }).toContain(latestMarker);
    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 15000 }).not.toContain(oldMarker);

    const afterReloadPayload = await waitForTerminalSnapshotPayload(page, activeTab!.sessionId, latestMarker);
    expect(afterReloadPayload.schemaVersion).toBe(2);
    expect(afterReloadPayload.payloadKind).toBe('viewport-only');
    expect(afterReloadPayload.content ?? '').not.toContain(oldMarker);
    expect(afterReloadPayload.byteLength).toBeLessThan(12000);

    const reloadedActiveTab = await getActiveTab(page);
    expect(reloadedActiveTab?.id).toBe(activeTab!.id);

    const visibleAfterReload = await readVisibleTerminalText(page);
    const fatalRuntimeErrors = runtimeErrors.filter((message) =>
      message.includes("reading 'dimensions'")
      || message.includes('[TerminalView] snapshot restore failed')
      || message.includes('[TerminalView] viewport sync failed'));
    await testInfo.attach('tc7004-current-behavior', {
      body: Buffer.from(JSON.stringify({
        schemaVersion: '1.0.0',
        testId: 'TC-7004',
        executionKind: 'live_browser_refresh',
        workspaceIsolation: {
          workspaceId: owned.workspaceId,
          deletionScope: 'exact-created-workspace-id-only',
        },
        oldMarkerAfterReload: visibleAfterReload.includes(oldMarker) ? 'present' : 'absent',
        latestMarkerAfterReload: visibleAfterReload.includes(latestMarker) ? 'present' : 'absent',
        beforeReloadSnapshotUtf8Bytes: beforeReloadPayload.raw === null
          ? 0
          : Buffer.byteLength(beforeReloadPayload.raw, 'utf8'),
        afterReloadSnapshotUtf8Bytes: afterReloadPayload.raw === null
          ? 0
          : Buffer.byteLength(afterReloadPayload.raw, 'utf8'),
        runtimeErrorCount: runtimeErrors.length,
        fatalRuntimeErrorCount: fatalRuntimeErrors.length,
        rawTerminalTextOmitted: true,
      }), 'utf8'),
      contentType: 'application/json',
    });

    expect(fatalRuntimeErrors).toEqual([]);
  });

  test('TC-OWNERSHIP-7004 cleanup guard refuses an exact-ID name/token mismatch', async ({ page }) => {
    const owned = await createOwnedTc7004Workspace(page);
    const ownership = await page.evaluate((ownedKey) => {
      const raw = localStorage.getItem(ownedKey);
      if (!raw) throw new Error('owned workspace record is missing');
      return JSON.parse(raw) as {
        workspaceId: string;
        ownerToken: string;
        workspaceName: string;
      };
    }, TC7004_OWNED_WORKSPACE_KEY);
    expect(ownership).toEqual({
      workspaceId: owned.workspaceId,
      ownerToken: expect.any(String),
      workspaceName: expect.stringContaining(ownership.ownerToken),
    });

    await page.evaluate(({ ownedKey, tampered }) => {
      localStorage.setItem(ownedKey, JSON.stringify(tampered));
    }, {
      ownedKey: TC7004_OWNED_WORKSPACE_KEY,
      tampered: { ...ownership, workspaceName: `${ownership.workspaceName}-tampered` },
    });
    await expect(cleanupOwnedTc7004Workspace(page)).rejects.toThrow(
      /ownership proof mismatch; deletion refused/u,
    );
    const workspaceStillExists = await page.evaluate(async (workspaceId) => {
      const token = localStorage.getItem('cws_auth_token');
      const response = await fetch('/api/workspaces', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`workspace fetch failed: ${response.status}`);
      const state = await response.json();
      return state.workspaces.some((workspace: { id: string }) => workspace.id === workspaceId);
    }, owned.workspaceId);
    expect(workspaceStillExists).toBe(true);

    await page.evaluate(({ ownedKey, ownershipRecord }) => {
      localStorage.setItem(ownedKey, JSON.stringify(ownershipRecord));
    }, { ownedKey: TC7004_OWNED_WORKSPACE_KEY, ownershipRecord: ownership });
    await cleanupOwnedTc7004Workspace(page);
  });

  test('TC-7005: reload should prefer server history over a poisoned local snapshot', async ({ page }) => {
    await ensureTabMode(page);

    const activeTab = await getActiveTab(page);
    expect(activeTab?.sessionId).toBeTruthy();

    const marker = `server-history-${Date.now()}`;
    const poison = `poisoned-snapshot-${Date.now()}`;

    await sendVisibleTerminalCommand(page, `echo ${marker}`);
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(marker, { timeout: 15000 });

    await page.evaluate(({ sessionId, poison }) => {
      localStorage.setItem(
        `terminal_snapshot_${sessionId}`,
        JSON.stringify({
          schemaVersion: 1,
          sessionId,
          content: poison,
          savedAt: new Date().toISOString(),
        }),
      );
    }, { sessionId: activeTab!.sessionId, poison });

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return page.evaluate(({ sessionId }) => {
        return localStorage.getItem(`terminal_snapshot_${sessionId}`) ?? '';
      }, { sessionId: activeTab!.sessionId });
    }, { timeout: 15000 }).toContain(marker);

    await expect.poll(async () => {
      return page.evaluate(({ sessionId, poison }) => {
        const raw = localStorage.getItem(`terminal_snapshot_${sessionId}`) ?? '';
        return raw.includes(poison);
      }, { sessionId: activeTab!.sessionId, poison });
    }, { timeout: 15000 }).toBe(false);
  });

  test('TC-7006: empty fallback should restore only validated local viewport snapshots', async ({ page }) => {
    await ensureTabMode(page);
    await installEmptyFallbackSnapshotShim(page);

    const activeTab = await getActiveTab(page);
    expect(activeTab?.sessionId).toBeTruthy();

    const seedMarker = `fallback-seed-${Date.now()}`;
    await sendVisibleTerminalCommand(page, `echo ${seedMarker}`);
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(seedMarker, { timeout: 15000 });
    const baseline = await waitForTerminalSnapshotPayload(page, activeTab!.sessionId, seedMarker);
    expect(baseline.cols).toBeGreaterThan(0);
    expect(baseline.rows).toBeGreaterThan(0);

    const geometryPoison = `geometry-poison-${Date.now()}`;
    await page.evaluate(({ sessionId, poison }) => {
      localStorage.setItem(
        `terminal_snapshot_${sessionId}`,
        JSON.stringify({
          schemaVersion: 2,
          payloadKind: 'viewport-only',
          sessionId,
          content: poison,
          cols: 1,
          rows: 1,
          bufferType: 'normal',
          savedAt: new Date().toISOString(),
        }),
      );
    }, { sessionId: activeTab!.sessionId, poison: geometryPoison });

    await forceNextSnapshotToEmptyFallback(page, activeTab!.sessionId);
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);
    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 15000 }).not.toContain(geometryPoison);

    const fallbackTab = await getActiveTab(page);
    expect(fallbackTab?.sessionId).toBeTruthy();
    await expect.poll(async () => {
      const payload = await readTerminalSnapshotPayload(page, fallbackTab!.sessionId);
      return (
        payload.schemaVersion === 2
        && !payload.raw?.includes(geometryPoison)
        && (payload.cols ?? 0) > 1
        && (payload.rows ?? 0) > 1
      );
    }, { timeout: 15000 }).toBe(true);
    const currentGeometry = await readTerminalSnapshotPayload(page, fallbackTab!.sessionId);
    expect(currentGeometry.cols).toBeGreaterThan(0);
    expect(currentGeometry.rows).toBeGreaterThan(0);

    const altMarker = `alternate-fallback-${Date.now()}`;
    await page.evaluate(({ sessionId, marker, cols, rows }) => {
      localStorage.setItem(
        `terminal_snapshot_${sessionId}`,
        JSON.stringify({
          schemaVersion: 2,
          payloadKind: 'viewport-only',
          sessionId,
          content: `\x1b[?1049h${marker}`,
          cols,
          rows,
          bufferType: 'alternate',
          savedAt: new Date().toISOString(),
        }),
      );
    }, {
      sessionId: fallbackTab!.sessionId,
      marker: altMarker,
      cols: currentGeometry.cols,
      rows: currentGeometry.rows,
    });

    await dispatchEmptyFallbackSnapshot(
      page,
      fallbackTab!.sessionId,
      currentGeometry.cols!,
      currentGeometry.rows!,
    );

    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 15000 }).toContain(altMarker);
  });
});

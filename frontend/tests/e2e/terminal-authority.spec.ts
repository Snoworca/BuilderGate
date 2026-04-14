import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

async function fetchWorkspaceState(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    return res.json();
  });
}

async function fetchSessionTelemetry(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/sessions/telemetry', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`telemetry fetch failed: ${res.status}`);
    return res.json();
  });
}

async function getRuntimeRegistrySnapshot(page: Page) {
  return page.evaluate(() => {
    return (window as any).__buildergateTerminalRuntimeRegistry?.getSnapshot() ?? null;
  });
}

function countResizeRequestedEvents(telemetry: any, sessionId: string) {
  const events = Array.isArray(telemetry?.ws?.recentReplayEvents) ? telemetry.ws.recentReplayEvents : [];
  return events.filter((event: { kind?: string; sessionId?: string }) =>
    event.kind === 'resize_requested' && event.sessionId === sessionId,
  ).length;
}

async function createWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ name }) => {
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
    return res.json();
  }, { name });
}

async function updateWorkspace(page: Page, workspaceId: string, updates: Record<string, unknown>) {
  return page.evaluate(async ({ workspaceId, updates }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(`workspace update failed: ${res.status}`);
    return res.json();
  }, { workspaceId, updates });
}

async function deleteWorkspaceViaApi(page: Page, workspaceId: string) {
  return page.evaluate(async ({ workspaceId }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace delete failed: ${res.status}`);
    return res.json();
  }, { workspaceId });
}

async function getOrCreateHiddenWorkspace(page: Page, name: string) {
  try {
    return await createWorkspace(page, name);
  } catch {
    await page.evaluate(async () => {
      const token = localStorage.getItem('cws_auth_token');
      const activeWorkspaceId = localStorage.getItem('active_workspace_id');
      const res = await fetch('/api/workspaces', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
      const state = await res.json();
      const staleWorkspace = state.workspaces.find((item) =>
        item.id !== activeWorkspaceId && /^Hidden-|^SwitchTarget-/.test(item.name),
      ) ?? null;
      if (!staleWorkspace) {
        throw new Error('no stale workspace available for cleanup');
      }

      const deleteRes = await fetch(`/api/workspaces/${staleWorkspace.id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!deleteRes.ok) throw new Error(`workspace delete failed: ${deleteRes.status}`);
    });

    return createWorkspace(page, name);
  }
}

async function getOrCreateWorkspaceWithCleanup(page: Page, name: string, namePattern: RegExp) {
  try {
    return await createWorkspace(page, name);
  } catch {
    await page.evaluate(async ({ patternSource, patternFlags }) => {
      const token = localStorage.getItem('cws_auth_token');
      const activeWorkspaceId = localStorage.getItem('active_workspace_id');
      const pattern = new RegExp(patternSource, patternFlags);
      const res = await fetch('/api/workspaces', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
      const state = await res.json();
      const staleWorkspace = state.workspaces.find((item) =>
        item.id !== activeWorkspaceId && pattern.test(item.name),
      ) ?? state.workspaces.find((item) => item.id !== activeWorkspaceId) ?? null;
      if (!staleWorkspace) {
        throw new Error('no stale workspace available for cleanup');
      }

      const deleteRes = await fetch(`/api/workspaces/${staleWorkspace.id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!deleteRes.ok) throw new Error(`workspace delete failed: ${deleteRes.status}`);
    }, { patternSource: namePattern.source, patternFlags: namePattern.flags });

    return createWorkspace(page, name);
  }
}

async function createTab(page: Page, workspaceId: string, shell?: string, cwd?: string) {
  return page.evaluate(async ({ workspaceId, shell, cwd }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ shell, cwd }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
    return res.json();
  }, { workspaceId, shell, cwd });
}

async function restartActiveTab(page: Page, workspaceId: string, tabId: string) {
  return page.evaluate(async ({ workspaceId, tabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs/${tabId}/restart`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`tab restart failed: ${res.status}`);
    return res.json();
  }, { workspaceId, tabId });
}

async function findWorkspaceOption(page: Page, workspaceName: string) {
  return page.getByRole('option', { name: workspaceName }).first();
}

async function readVisibleTerminalText(page: Page) {
  const text = await page.locator('.terminal-view:visible .xterm-rows').first().textContent();
  return text ?? '';
}

async function sendVisibleTerminalCommand(page: Page, command: string) {
  const terminal = page.locator('.terminal-view:visible').first();
  await terminal.evaluate((node) => {
    (node as HTMLElement).click();
  });
  const input = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
  await input.evaluate((node) => {
    (node as HTMLTextAreaElement).focus();
  });
  await expect(input).toBeFocused({ timeout: 10000 });
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function sendSessionInputViaWebSocket(page: Page, sessionId: string, data: string) {
  await page.evaluate(async ({ sessionId, data }) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('missing auth token');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = window.setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('ws input timeout'));
      }, 10000);

      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('ws input socket error'));
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'input', sessionId, data }));
        ws.close();
      };

      ws.onclose = () => {
        window.clearTimeout(timer);
        resolve();
      };
    });
  }, { sessionId, data });
}

test.describe('Terminal Authority Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-7101: hidden workspace should recover through server snapshots after refresh', async ({ page }) => {
    const hiddenWorkspaceName = `Hidden-${Date.now()}`;
    const hiddenWorkspace = await getOrCreateHiddenWorkspace(page, hiddenWorkspaceName);
    const effectiveWorkspaceName = hiddenWorkspace.name;
    const hiddenTab = await createTab(page, hiddenWorkspace.id, 'auto');
    const marker = `hidden-authority-${Date.now()}`;
    const poison = `poison-hidden-${Date.now()}`;

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await page.evaluate(({ hiddenWorkspaceId, sessionId, poison }) => {
      localStorage.setItem('active_workspace_id', hiddenWorkspaceId);
      localStorage.setItem(
        `terminal_snapshot_${sessionId}`,
        JSON.stringify({
          schemaVersion: 1,
          sessionId,
          content: poison,
          savedAt: new Date().toISOString(),
        }),
      );
    }, {
      hiddenWorkspaceId: hiddenWorkspace.id,
      sessionId: hiddenTab.sessionId,
      poison,
    });

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);
    await sendSessionInputViaWebSocket(page, hiddenTab.sessionId, `echo ${marker}\r`);
    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain(marker);

    const stateAfterMarker = await fetchWorkspaceState(page);
    const activeWorkspace = stateAfterMarker.workspaces.find((item: { id: string }) => item.id === hiddenWorkspace.id);
    expect(activeWorkspace?.id).toBe(hiddenWorkspace.id);

    const firstWorkspace = stateAfterMarker.workspaces.find((item: { id: string }) => item.id !== hiddenWorkspace.id);
    test.skip(!firstWorkspace, 'Need another workspace to hide the target workspace');

    const firstWorkspaceOption = await findWorkspaceOption(page, firstWorkspace.name);
    await firstWorkspaceOption.click();
    await expect(firstWorkspaceOption).toHaveAttribute('aria-selected', 'true');

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const hiddenWorkspaceOption = await findWorkspaceOption(page, effectiveWorkspaceName);
    await hiddenWorkspaceOption.click();
    await expect(hiddenWorkspaceOption).toHaveAttribute('aria-selected', 'true');

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain(marker);

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).not.toContain(poison);
  });

  test('TC-7102: restart should invalidate old session snapshot lineage', async ({ page }) => {
    const state = await fetchWorkspaceState(page);
    const activeWorkspaceId = await page.evaluate(() => localStorage.getItem('active_workspace_id'));
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
    const activeTab = state.tabs.find((item: { id: string }) => item.id === workspace.activeTabId);

    test.skip(!workspace || !activeTab, 'Need an active tab');

    const poison = `restart-poison-${Date.now()}`;
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
    }, { sessionId: activeTab.sessionId, poison });

    const restarted = await restartActiveTab(page, workspace.id, activeTab.id);
    expect(restarted.sessionId).not.toBe(activeTab.sessionId);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).not.toContain(poison);
  });

  test('TC-7103: telemetry endpoint should expose replay lineage events for the active terminal baseline', async ({ page }) => {
    await expect.poll(async () => {
      const telemetry = await fetchSessionTelemetry(page);
      const events = telemetry?.ws?.recentReplayEvents;
      return Array.isArray(events) && events.some((event: { kind?: string; replayToken?: string }) =>
        event.kind === 'snapshot_sent' && typeof event.replayToken === 'string',
      );
    }, { timeout: 15000 }).toBe(true);

    const telemetry = await fetchSessionTelemetry(page);
    const snapshotEvent = telemetry.ws.recentReplayEvents.find((event: { kind?: string; replayToken?: string }) =>
      event.kind === 'snapshot_sent' && typeof event.replayToken === 'string',
    );

    expect(Array.isArray(telemetry.ws.recentReplayEvents)).toBe(true);
    expect(snapshotEvent?.sessionId).toBeTruthy();
    expect(typeof snapshotEvent?.replayToken).toBe('string');
    expect(typeof snapshotEvent?.snapshotSeq).toBe('number');
  });

  test('TC-7104: repeated workspace visibility toggles should not emit duplicate resize requests for unchanged geometry', async ({ page }) => {
    const state = await fetchWorkspaceState(page);
    const activeWorkspaceId = await page.evaluate(() => localStorage.getItem('active_workspace_id'));
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
    const activeTab = state.tabs.find((item: { id: string }) => item.id === workspace.activeTabId);

    test.skip(!workspace || !activeTab, 'Need an active tab');

    const switchWorkspace = await getOrCreateHiddenWorkspace(page, `SwitchTarget-${Date.now()}`);
    if (!state.tabs.some((item: { workspaceId: string }) => item.workspaceId === switchWorkspace.id)) {
      await createTab(page, switchWorkspace.id, 'auto');
    }
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const baselineTelemetry = await fetchSessionTelemetry(page);
    const baselineResizeCount = countResizeRequestedEvents(baselineTelemetry, activeTab.sessionId);

    const sourceOption = await findWorkspaceOption(page, workspace.name);
    const targetOption = await findWorkspaceOption(page, switchWorkspace.name);

    for (let iteration = 0; iteration < 3; iteration += 1) {
      await targetOption.click();
      await expect(targetOption).toHaveAttribute('aria-selected', 'true');
      await sourceOption.click();
      await expect(sourceOption).toHaveAttribute('aria-selected', 'true');
    }

    await page.waitForTimeout(300);

    const afterTelemetry = await fetchSessionTelemetry(page);
    const afterResizeCount = countResizeRequestedEvents(afterTelemetry, activeTab.sessionId);

    expect(afterResizeCount).toBeLessThanOrEqual(baselineResizeCount + 1);
  });

  test('TC-7105: grid mode should restore every current tab even if the saved mosaic layout is stale', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `GR-${Math.random().toString(36).slice(2, 8)}`,
      /^GR-/,
    );
    await createTab(page, workspace.id, 'auto');
    await createTab(page, workspace.id, 'auto');
    await createTab(page, workspace.id, 'auto');
    await updateWorkspace(page, workspace.id, { viewMode: 'grid' });

    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return page.locator('.grid-cell').count();
    }, { timeout: 15000 }).toBe(3);

    await expect.poll(async () => {
      return page.locator('.terminal-view').count();
    }, { timeout: 15000 }).toBe(3);
  });

  test('TC-7106: terminal runtime registry should keep one live consumer per session in tab mode', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `TR-${Math.random().toString(36).slice(2, 8)}`,
      /^TR-/,
    );
    const originalActiveTab = await createTab(page, workspace.id, 'auto');
    const extraTab = await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, { viewMode: 'tab', activeTabId: originalActiveTab.id });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const baselineSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(baselineSnapshot).not.toBeNull();
    expect(baselineSnapshot.runtimes.every((runtime: { activeConsumerCount: number }) => runtime.activeConsumerCount <= 1)).toBe(true);
    expect(
      baselineSnapshot.tabBindings.some((binding: { tabId: string; sessionId: string }) =>
        binding.tabId === extraTab.id && binding.sessionId === extraTab.sessionId,
      ),
    ).toBe(true);

    await page.getByRole('tab', { name: originalActiveTab.name }).first().click();

    await expect.poll(async () => {
      const snapshot = await getRuntimeRegistrySnapshot(page);
      const runtime = snapshot?.runtimes.find((item: { sessionId: string }) => item.sessionId === originalActiveTab.sessionId);
      return runtime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
        slot.slotKind === 'tab-active' && slot.visible,
      ) ?? false;
    }, { timeout: 10000 }).toBe(true);

    await page.getByRole('tab', { name: extraTab.name }).first().click();

    await expect.poll(async () => {
      const snapshot = await getRuntimeRegistrySnapshot(page);
      const runtime = snapshot?.runtimes.find((item: { sessionId: string }) => item.sessionId === extraTab.sessionId);
      return runtime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
        slot.slotKind === 'tab-active' && slot.visible,
      ) ?? false;
    }, { timeout: 10000 }).toBe(true);

    const finalSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(finalSnapshot.runtimes.every((runtime: { activeConsumerCount: number }) => runtime.activeConsumerCount <= 1)).toBe(true);
    const previousRuntime = finalSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === originalActiveTab.sessionId);
    expect(previousRuntime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
      slot.slotKind === 'tab-hidden' && !slot.visible,
    ) ?? false).toBe(true);
  });

  test('TC-7107: grid mode should attach active workspace runtimes through grid host slots', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `TG-${Math.random().toString(36).slice(2, 8)}`,
      /^TG-/,
    );
    const firstTab = await createTab(page, workspace.id, 'auto');
    const secondTab = await createTab(page, workspace.id, 'auto');
    const thirdTab = await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, {
      viewMode: 'grid',
      activeTabId: firstTab.id,
    });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return page.locator('.grid-cell').count();
    }, { timeout: 15000 }).toBe(3);

    const runtimeSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(runtimeSnapshot).not.toBeNull();
    expect(runtimeSnapshot.runtimes.every((runtime: { activeConsumerCount: number }) => runtime.activeConsumerCount <= 1)).toBe(true);

    for (const sessionId of [firstTab.sessionId, secondTab.sessionId, thirdTab.sessionId]) {
      const runtime = runtimeSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === sessionId);
      expect(runtime).toBeTruthy();
      expect(runtime.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
        slot.slotKind === 'grid-pane' && slot.visible,
      )).toBe(true);
    }
  });

  test('TC-7108: restart should replace runtime generation and remove the old session runtime entry', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `RG-${Math.random().toString(36).slice(2, 8)}`,
      /^RG-/,
    );
    const tab = await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, {
      viewMode: 'tab',
      activeTabId: tab.id,
    });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const beforeSnapshot = await getRuntimeRegistrySnapshot(page);
    const previousRuntime = beforeSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === tab.sessionId);
    expect(previousRuntime).toBeTruthy();

    const restarted = await restartActiveTab(page, workspace.id, tab.id);
    expect(restarted.sessionId).not.toBe(tab.sessionId);

    await expect.poll(async () => {
      const stateAfterRestart = await fetchWorkspaceState(page);
      const updatedTab = stateAfterRestart.tabs.find((item: { id: string }) => item.id === tab.id);
      return updatedTab?.sessionId ?? null;
    }, { timeout: 10000 }).toBe(restarted.sessionId);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const snapshotAfterRestart = await getRuntimeRegistrySnapshot(page);
    const oldRuntime = snapshotAfterRestart.runtimes.find((item: { sessionId: string }) => item.sessionId === tab.sessionId);
    const newRuntime = snapshotAfterRestart.runtimes.find((item: { sessionId: string }) => item.sessionId === restarted.sessionId);
    expect(oldRuntime).toBeFalsy();
    expect(newRuntime).toBeTruthy();
    expect(typeof newRuntime.runtimeGeneration).toBe('number');
    expect(newRuntime.runtimeGeneration).toBeGreaterThan(0);
  });

  test('TC-7109: deleting a workspace should clear runtime registry entries for removed sessions', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `DW-${Math.random().toString(36).slice(2, 8)}`,
      /^DW-/,
    );
    const firstTab = await createTab(page, workspace.id, 'auto');
    const secondTab = await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, {
      viewMode: 'tab',
      activeTabId: firstTab.id,
    });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const beforeSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(beforeSnapshot.runtimes.some((item: { sessionId: string }) => item.sessionId === firstTab.sessionId)).toBe(true);
    expect(beforeSnapshot.runtimes.some((item: { sessionId: string }) => item.sessionId === secondTab.sessionId)).toBe(true);

    await deleteWorkspaceViaApi(page, workspace.id);

    await expect.poll(async () => {
      const stateAfterDelete = await fetchWorkspaceState(page);
      return stateAfterDelete.tabs.some((item: { workspaceId: string }) => item.workspaceId === workspace.id);
    }, { timeout: 10000 }).toBe(false);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const snapshotAfterDelete = await getRuntimeRegistrySnapshot(page);
    expect(snapshotAfterDelete.runtimes.some((item: { sessionId: string }) =>
      item.sessionId === firstTab.sessionId || item.sessionId === secondTab.sessionId,
    )).toBe(false);
  });

  test('TC-7110: terminal focus should survive tab-grid-tab host reassignment', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `FG-${Math.random().toString(36).slice(2, 8)}`,
      /^FG-/,
    );
    const firstTab = await createTab(page, workspace.id, 'auto');
    await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, {
      viewMode: 'tab',
      activeTabId: firstTab.id,
    });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const focusVisibleTerminal = async () => {
      const terminal = page.locator('.terminal-view:visible').first();
      await terminal.evaluate((node) => {
        (node as HTMLElement).click();
      });
      await expect(terminal).toHaveClass(/terminal-focused/, { timeout: 10000 });
    };

    await focusVisibleTerminal();
    const initialTabSnapshot = await getRuntimeRegistrySnapshot(page);
    const initialRuntime = initialTabSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === firstTab.sessionId);
    expect(initialRuntime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
      slot.slotKind === 'tab-active' && slot.visible,
    ) ?? false).toBe(true);

    await updateWorkspace(page, workspace.id, { viewMode: 'grid' });
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await expect.poll(async () => page.locator('.grid-cell').count(), { timeout: 15000 }).toBe(2);
    await waitForTerminal(page);

    await focusVisibleTerminal();
    const gridSnapshot = await getRuntimeRegistrySnapshot(page);
    const gridRuntime = gridSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === firstTab.sessionId);
    expect(gridRuntime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
      slot.slotKind === 'grid-pane' && slot.visible,
    ) ?? false).toBe(true);

    await updateWorkspace(page, workspace.id, { viewMode: 'tab', activeTabId: firstTab.id });
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await focusVisibleTerminal();
    const finalTabSnapshot = await getRuntimeRegistrySnapshot(page);
    const finalRuntime = finalTabSnapshot.runtimes.find((item: { sessionId: string }) => item.sessionId === firstTab.sessionId);
    expect(finalRuntime?.hostSlots.some((slot: { slotKind: string; visible: boolean }) =>
      slot.slotKind === 'tab-active' && slot.visible,
    ) ?? false).toBe(true);
  });

  test('TC-7111: runtime registry snapshot should expose observability counters without mode-toggle recreation', async ({ page }) => {
    const workspace = await getOrCreateWorkspaceWithCleanup(
      page,
      `OB-${Math.random().toString(36).slice(2, 8)}`,
      /^OB-/,
    );
    const firstTab = await createTab(page, workspace.id, 'auto');
    await createTab(page, workspace.id, 'auto');

    await updateWorkspace(page, workspace.id, {
      viewMode: 'tab',
      activeTabId: firstTab.id,
    });
    await page.evaluate((workspaceId) => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, workspace.id);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const beforeSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(beforeSnapshot.stats.runtimeCreateCount).toBeGreaterThan(0);
    expect(beforeSnapshot.stats.hostAttachCount).toBeGreaterThan(0);
    expect(beforeSnapshot.stats.maxActiveConsumerCountObserved).toBeLessThanOrEqual(1);
    expect(beforeSnapshot.stats.orphanRuntimeCount).toBe(0);
    expect(beforeSnapshot.stats.unattachedRuntimeCount).toBe(0);

    await updateWorkspace(page, workspace.id, { viewMode: 'grid' });
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await expect.poll(async () => page.locator('.grid-cell').count(), { timeout: 15000 }).toBe(2);

    await updateWorkspace(page, workspace.id, { viewMode: 'tab', activeTabId: firstTab.id });
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const afterSnapshot = await getRuntimeRegistrySnapshot(page);
    expect(afterSnapshot.stats.runtimeCreateCount).toBe(beforeSnapshot.stats.runtimeCreateCount);
    expect(afterSnapshot.stats.hostAttachCount).toBeGreaterThanOrEqual(beforeSnapshot.stats.hostAttachCount);
    expect(afterSnapshot.stats.maxActiveConsumerCountObserved).toBeLessThanOrEqual(1);
    expect(afterSnapshot.stats.orphanRuntimeCount).toBe(0);
    expect(afterSnapshot.stats.unattachedRuntimeCount).toBe(0);
  });
});

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
  const input = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
  await input.fill(command);
  await input.press('Enter');
}

test.describe('Terminal Authority Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-7101: hidden workspace should recover through server snapshots after refresh', async ({ page }) => {
    const hiddenWorkspaceName = `Hidden-${Date.now()}`;
    const hiddenWorkspace = await createWorkspace(page, hiddenWorkspaceName);
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
    await sendVisibleTerminalCommand(page, `echo ${marker}`);

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

    const hiddenWorkspaceOption = await findWorkspaceOption(page, hiddenWorkspaceName);
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
});

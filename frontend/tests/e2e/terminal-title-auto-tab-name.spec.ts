import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

declare global {
  interface Window {
    __buildergateTabNameUpdates?: string[];
    __buildergateTabUpdateChanges?: Array<Record<string, unknown>>;
  }
}

async function createTitleWorkspace(page: Page, name: string): Promise<{ workspace: { id: string; name: string }, tab: { id: string; sessionId: string } }> {
  return page.evaluate(async ({ workspaceName }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const createWorkspace = async () => fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ name: workspaceName }),
    });

    let workspaceResponse = await createWorkspace();
    for (let attempt = 0; workspaceResponse.status === 409 && attempt < 20; attempt += 1) {
      const stateResponse = await fetch('/api/workspaces', { headers });
      if (!stateResponse.ok) {
        throw new Error(`workspace fetch failed: ${stateResponse.status}`);
      }
      const state = await stateResponse.json();
      const staleWorkspace = state.workspaces
        .filter((item: { name: string }) => item.name.startsWith('TitleAuto-'))
        .sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name))[0] ?? null;
      if (!staleWorkspace) {
        break;
      }
      const deleteResponse = await fetch(`/api/workspaces/${staleWorkspace.id}`, {
        method: 'DELETE',
        headers,
      });
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`workspace cleanup failed: ${deleteResponse.status}`);
      }
      workspaceResponse = await createWorkspace();
    }

    if (!workspaceResponse.ok) {
      throw new Error(`workspace create failed: ${workspaceResponse.status}`);
    }
    const workspace = await workspaceResponse.json();

    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabResponse.ok) {
      throw new Error(`tab create failed: ${tabResponse.status}`);
    }
    const tab = await tabResponse.json();
    return { workspace, tab };
  }, { workspaceName: name });
}

async function deleteWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (targetWorkspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    await fetch(`/api/workspaces/${targetWorkspaceId}`, {
      method: 'DELETE',
      headers,
    });
  }, workspaceId);
}

async function sendSessionInput(page: Page, sessionId: string, data: string): Promise<void> {
  await page.evaluate(async ({ targetSessionId, input }) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('missing auth token');
    }
    await new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      const timeout = window.setTimeout(() => {
        ws.close();
        reject(new Error('websocket input timeout'));
      }, 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'input', sessionId: targetSessionId, data: input }));
        window.setTimeout(() => {
          window.clearTimeout(timeout);
          ws.close();
          resolve();
        }, 100);
      };
      ws.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('websocket input failed'));
      };
    });
  }, { targetSessionId: sessionId, input: data });
}

async function sendPowerShellTitle(page: Page, sessionId: string, title: string): Promise<void> {
  const escapedTitle = title.replace(/'/g, "''");
  await sendSessionInput(page, sessionId, `[Console]::Out.Write([char]27 + ']0;${escapedTitle}' + [char]7); Start-Sleep -Seconds 30\r`);
}

async function sendPowerShellTitleOnce(page: Page, sessionId: string, title: string): Promise<void> {
  const escapedTitle = title.replace(/'/g, "''");
  await sendSessionInput(page, sessionId, `[Console]::Out.Write([char]27 + ']0;${escapedTitle}' + [char]7)\r`);
}

async function sendPowerShellTitleBurst(page: Page, sessionId: string): Promise<void> {
  await sendSessionInput(page, sessionId, "[Console]::Out.Write([char]27 + ']0;Burst 1' + [char]7 + [char]27 + ']0;Burst 2' + [char]7 + [char]27 + ']0;Burst Final' + [char]7); Start-Sleep -Seconds 30\r");
}

async function interruptPowerShellCommand(page: Page, sessionId: string): Promise<void> {
  await sendSessionInput(page, sessionId, '\x03');
  await page.waitForTimeout(500);
}

async function renameTabByApi(page: Page, workspaceId: string, tabId: string, name: string): Promise<void> {
  await page.evaluate(async ({ targetWorkspaceId, targetTabId, nextName }) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/workspaces/${targetWorkspaceId}/tabs/${targetTabId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name: nextName }),
    });
    if (!response.ok) {
      throw new Error(`tab rename failed: ${response.status}`);
    }
  }, { targetWorkspaceId: workspaceId, targetTabId: tabId, nextName: name });
}

async function fetchTab(page: Page, workspaceId: string, tabId: string): Promise<{ name: string; nameSource?: string; terminalTitle?: string }> {
  return page.evaluate(async ({ targetWorkspaceId, targetTabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`workspace fetch failed: ${response.status}`);
    }
    const state = await response.json();
    const tab = state.tabs.find((item: { id: string; workspaceId: string }) =>
      item.id === targetTabId && item.workspaceId === targetWorkspaceId,
    );
    if (!tab) {
      throw new Error(`tab not found: ${targetTabId}`);
    }
    return {
      name: tab.name,
      nameSource: tab.nameSource,
      terminalTitle: tab.terminalTitle,
    };
  }, { targetWorkspaceId: workspaceId, targetTabId: tabId });
}

async function fetchTabName(page: Page, workspaceId: string, tabId: string): Promise<string> {
  const tab = await fetchTab(page, workspaceId, tabId);
  return tab.name;
}

test.describe('Terminal Title Auto Tab Name', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await page.addInitScript(() => {
      window.__buildergateTabNameUpdates = [];
      window.__buildergateTabUpdateChanges = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class TrackingWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener('message', (event) => {
            try {
              const parsed = JSON.parse(String(event.data));
              if (parsed.type === 'tab:updated' && typeof parsed.data?.changes?.name === 'string') {
                window.__buildergateTabNameUpdates?.push(parsed.data.changes.name);
                window.__buildergateTabUpdateChanges?.push(parsed.data.changes);
              }
            } catch {
              // Non-JSON messages are not workspace events.
            }
          });
        }
      };
    });
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    if (workspaceId) {
      await deleteWorkspace(page, workspaceId);
      workspaceId = null;
    }
  });

  test('updates default tab name from terminal title and preserves manual rename lock', async ({ page }) => {
    const created = await createTitleWorkspace(page, `TitleAuto-${Date.now()}`);
    workspaceId = created.workspace.id;

    await page.evaluate((targetWorkspaceId) => {
      localStorage.setItem('active_workspace_id', targetWorkspaceId);
    }, workspaceId);
    await page.reload();
    await page.getByRole('option', { name: created.workspace.name }).click();
    await waitForTerminal(page);

    await expect.poll(async () => (await fetchTab(page, created.workspace.id, created.tab.id)).nameSource ?? 'default', {
      timeout: 5000,
    }).toMatch(/^(default|terminal-title)$/);

    const beforeAbsolutePathTitle = await fetchTab(page, created.workspace.id, created.tab.id);
    const blockedPathTitle = 'C:\\Work\\git\\_Snoworca\\ProjectMaster';
    await sendPowerShellTitleOnce(page, created.tab.sessionId, blockedPathTitle);
    await page.waitForTimeout(1000);

    const afterAbsolutePathTitle = await fetchTab(page, created.workspace.id, created.tab.id);
    expect(afterAbsolutePathTitle.name).toBe(beforeAbsolutePathTitle.name);
    expect(afterAbsolutePathTitle.nameSource).toBe(beforeAbsolutePathTitle.nameSource);
    expect(afterAbsolutePathTitle.terminalTitle).toBe(beforeAbsolutePathTitle.terminalTitle);
    const capturedAfterPathTitle = await page.evaluate(() => window.__buildergateTabNameUpdates ?? []);
    expect(capturedAfterPathTitle).not.toContain(blockedPathTitle.slice(0, 32));

    await sendPowerShellTitle(page, created.tab.sessionId, 'E2E Auto Title');

    await expect.poll(async () => await fetchTab(page, created.workspace.id, created.tab.id), {
      timeout: 10000,
    }).toMatchObject({
      name: 'E2E Auto Title',
      nameSource: 'terminal-title',
      terminalTitle: 'E2E Auto Title',
    });
    await expect(page.locator('.workspace-tabbar [role="tab"]').filter({ hasText: 'E2E Auto Title' })).toBeVisible();
    await interruptPowerShellCommand(page, created.tab.sessionId);

    await sendPowerShellTitleBurst(page, created.tab.sessionId);

    await expect.poll(async () => await fetchTabName(page, created.workspace.id, created.tab.id), {
      timeout: 10000,
    }).toBe('Burst Final');
    const capturedNames = await page.evaluate(() => window.__buildergateTabNameUpdates ?? []);
    expect(capturedNames).toContain('Burst Final');
    expect(capturedNames).not.toContain('Burst 1');
    expect(capturedNames).not.toContain('Burst 2');
    await interruptPowerShellCommand(page, created.tab.sessionId);

    await renameTabByApi(page, created.workspace.id, created.tab.id, 'Manual Lock');
    await expect.poll(async () => await fetchTab(page, created.workspace.id, created.tab.id), {
      timeout: 5000,
    }).toMatchObject({
      name: 'Manual Lock',
      nameSource: 'user',
      terminalTitle: undefined,
    });
    await expect.poll(async () => page.evaluate(() =>
      (window.__buildergateTabUpdateChanges ?? []).some((changes) =>
        changes.name === 'Manual Lock'
        && changes.nameSource === 'user'
        && changes.terminalTitle === null,
      ),
    ), { timeout: 5000 }).toBe(true);
    await expect(page.locator('.workspace-tabbar [role="tab"]').filter({ hasText: 'Manual Lock' })).toBeVisible();

    await sendPowerShellTitle(page, created.tab.sessionId, 'Ignored Auto Title');
    await expect.poll(async () => await fetchTabName(page, created.workspace.id, created.tab.id), {
      timeout: 3000,
    }).toBe('Manual Lock');
  });
});

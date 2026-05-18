import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

type CapturedWsMessage = {
  direction?: 'in' | 'out';
  type?: string;
  sessionId?: string;
  mode?: string;
  data?: string;
  replayToken?: string;
  seq?: number;
};

declare global {
  interface Window {
    __buildergateCapturedWsMessages?: CapturedWsMessage[];
    __buildergateCapturedWsSockets?: WebSocket[];
    __buildergateWsCaptureInstalled?: boolean;
    __buildergateOriginalWebSocket?: typeof WebSocket;
    __buildergateOriginalWsSend?: WebSocket['send'];
  }
}

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

const EVICTABLE_TEST_WORKSPACE_PATTERN = /^AuthoritySource-|^Hidden-|^SwitchTarget-|^PW-(?:IME|KEYS|MOBILE-SCROLL)-|^E2E Equal |^E2E Away |^REAL DND |^DBG Verify |^DBG Equal |^ROOTCAUSE /;
const TEST_WORKSPACE_TIMESTAMP_PATTERN = /(?:AuthoritySource-|Hidden-|SwitchTarget-|PW-(?:IME|KEYS|MOBILE-SCROLL)-|E2E Equal(?: Grid| Reorder)? |E2E Away |REAL DND |DBG Verify |DBG Equal |ROOTCAUSE )(\d+)/;

async function getOrCreateHiddenWorkspace(page: Page, name: string) {
  try {
    return await createWorkspace(page, name);
  } catch {
    await page.evaluate(async ({ evictablePatternSource, timestampPatternSource }) => {
      const token = localStorage.getItem('cws_auth_token');
      const activeWorkspaceId = localStorage.getItem('active_workspace_id');
      const res = await fetch('/api/workspaces', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
      const state = await res.json();
      const evictablePattern = new RegExp(evictablePatternSource);
      const timestampPattern = new RegExp(timestampPatternSource);
      const getTimestamp = (workspaceName: string) => {
        const match = workspaceName.match(timestampPattern);
        return match ? Number.parseInt(match[1], 10) : 0;
      };
      const staleWorkspace = state.workspaces
        .filter((item: { id: string; name: string }) =>
          item.id !== activeWorkspaceId && evictablePattern.test(item.name),
        )
        .sort((left: { name: string }, right: { name: string }) => getTimestamp(left.name) - getTimestamp(right.name))[0] ?? null;
      if (!staleWorkspace) {
        throw new Error('no stale workspace available for cleanup');
      }

      const deleteRes = await fetch(`/api/workspaces/${staleWorkspace.id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!deleteRes.ok) throw new Error(`workspace delete failed: ${deleteRes.status}`);
    }, {
      evictablePatternSource: EVICTABLE_TEST_WORKSPACE_PATTERN.source,
      timestampPatternSource: TEST_WORKSPACE_TIMESTAMP_PATTERN.source,
    });

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
  const input = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
  await input.fill(command);
  await input.press('Enter');
}

async function installWsMessageCapture(page: Page): Promise<void> {
  const install = () => {
    window.__buildergateCapturedWsMessages = [];
    window.__buildergateCapturedWsSockets = [];
    if (window.__buildergateWsCaptureInstalled) {
      return;
    }
    window.__buildergateWsCaptureInstalled = true;

    const captureFrame = (direction: 'in' | 'out', data: unknown) => {
      if (typeof data !== 'string') {
        return;
      }
      try {
        const message = JSON.parse(data) as CapturedWsMessage;
        window.__buildergateCapturedWsMessages?.push({ ...message, direction });
      } catch {
        // Ignore non-JSON frames.
      }
    };

    const OriginalWebSocket = WebSocket;
    window.__buildergateOriginalWebSocket = OriginalWebSocket;
    window.__buildergateOriginalWsSend = OriginalWebSocket.prototype.send;

    OriginalWebSocket.prototype.send = function patchedSend(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      captureFrame('out', data);
      return window.__buildergateOriginalWsSend!.call(this, data);
    };

    const CapturingWebSocket = function capturingWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      window.__buildergateCapturedWsSockets?.push(socket);
      socket.addEventListener('message', (event) => {
        captureFrame('in', event.data);
      });
      return socket;
    };
    CapturingWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(CapturingWebSocket, OriginalWebSocket);
    window.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
  };

  await page.addInitScript(install);
  await page.evaluate(install).catch(() => undefined);
}

async function clearWsMessageCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateCapturedWsMessages = [];
  });
}

async function readCapturedWsMessages(page: Page): Promise<CapturedWsMessage[]> {
  return page.evaluate(() => window.__buildergateCapturedWsMessages ?? []);
}

function findViewportSnapshot(
  messages: CapturedWsMessage[],
  sessionId: string,
): CapturedWsMessage | undefined {
  return messages.find((message) => (
    message.direction === 'in'
    && message.type === 'screen-snapshot'
    && message.sessionId === sessionId
    && typeof message.data === 'string'
  ));
}

function expectViewportOnlySnapshot(
  snapshot: CapturedWsMessage | undefined,
  sessionId: string,
  oldMarker: string,
  latestMarker: string,
) {
  expect(snapshot, `screen-snapshot for ${sessionId}`).toBeDefined();
  expect(snapshot?.data ?? '').toContain(latestMarker);
  expect(snapshot?.data ?? '').not.toContain(oldMarker);
}

async function closeCapturedWebSockets(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const socket of window.__buildergateCapturedWsSockets ?? []) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  });
}

async function sendCapturedWsMessage(page: Page, message: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ message }) => {
    const socket = [...(window.__buildergateCapturedWsSockets ?? [])].reverse()
      .find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) {
      throw new Error('No open captured WebSocket');
    }
    socket.send(JSON.stringify(message));
  }, { message });
}

async function waitForViewportOnlySnapshot(
  page: Page,
  sessionId: string,
  oldMarker: string,
  latestMarker: string,
): Promise<void> {
  await expect.poll(async () => {
    const snapshot = findViewportSnapshot(await readCapturedWsMessages(page), sessionId);
    return snapshot?.data ?? '';
  }, { timeout: 15000 }).toContain(latestMarker);

  expectViewportOnlySnapshot(
    findViewportSnapshot(await readCapturedWsMessages(page), sessionId),
    sessionId,
    oldMarker,
    latestMarker,
  );
}

test.describe('Terminal Authority Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-7101: hidden workspace should recover through server snapshots after refresh', async ({ page }) => {
    await installWsMessageCapture(page);
    const hiddenWorkspaceName = `Hidden-${Date.now()}`;
    const hiddenWorkspace = await getOrCreateHiddenWorkspace(page, hiddenWorkspaceName);
    const effectiveWorkspaceName = hiddenWorkspace.name;
    const hiddenTab = await createTab(page, hiddenWorkspace.id, 'auto');
    const stamp = Date.now();
    const oldMarker = `hidden-old-${stamp}`;
    const latestMarker = `hidden-latest-${stamp}`;
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
    await sendVisibleTerminalCommand(
      page,
      `node -e "for (let i=1;i<=700;i++) console.log(i===1?'${oldMarker}':i===700?'${latestMarker}':'hidden-fill-'+String(i).padStart(3,'0'))"`,
    );
    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 30000 }).toContain(latestMarker);

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
    await clearWsMessageCapture(page);

    const hiddenWorkspaceOption = await findWorkspaceOption(page, effectiveWorkspaceName);
    await hiddenWorkspaceOption.click();
    await expect(hiddenWorkspaceOption).toHaveAttribute('aria-selected', 'true');

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain(latestMarker);

    await clearWsMessageCapture(page);
    await sendCapturedWsMessage(page, { type: 'unsubscribe', sessionIds: [hiddenTab.sessionId] });
    await page.waitForTimeout(200);
    await sendCapturedWsMessage(page, { type: 'subscribe', sessionIds: [hiddenTab.sessionId] });
    await waitForViewportOnlySnapshot(page, hiddenTab.sessionId, oldMarker, latestMarker);

    await clearWsMessageCapture(page);
    await closeCapturedWebSockets(page);
    await waitForViewportOnlySnapshot(page, hiddenTab.sessionId, oldMarker, latestMarker);

    await clearWsMessageCapture(page);
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain(latestMarker);
    await waitForViewportOnlySnapshot(page, hiddenTab.sessionId, oldMarker, latestMarker);

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

  test('TC-7103: rapid workspace bounce should preserve output generated during handoff', async ({ page }) => {
    const sourceWorkspaceName = `AuthoritySource-${Date.now()}`;
    const sourceWorkspace = await getOrCreateHiddenWorkspace(page, sourceWorkspaceName);

    await page.evaluate((sourceWorkspaceId) => {
      localStorage.setItem('active_workspace_id', sourceWorkspaceId);
    }, sourceWorkspace.id);

    const switchTargetName = `SwitchTarget-${Date.now()}`;
    const switchTarget = await getOrCreateHiddenWorkspace(page, switchTargetName);
    await createTab(page, sourceWorkspace.id, 'auto');
    const marker = `BG-${Date.now()}`;

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const sourceWorkspaceOption = await findWorkspaceOption(page, sourceWorkspace.name);
    await sourceWorkspaceOption.click();
    await expect(sourceWorkspaceOption).toHaveAttribute('aria-selected', 'true');

    await sendVisibleTerminalCommand(
      page,
      `1..8 | ForEach-Object { Write-Output "${marker}-$_"; Start-Sleep -Milliseconds 120 }`,
    );

    await expect.poll(async () => {
      return readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain(`${marker}-2`);

    const switchTargetOption = await findWorkspaceOption(page, switchTarget.name);
    await switchTargetOption.click();
    await expect(switchTargetOption).toHaveAttribute('aria-selected', 'true');

    await page.waitForTimeout(180);

    await sourceWorkspaceOption.click();
    await expect(sourceWorkspaceOption).toHaveAttribute('aria-selected', 'true');

    await expect.poll(async () => {
      const text = await readVisibleTerminalText(page);
      return Array.from({ length: 8 }, (_, index) => `${marker}-${index + 1}`).every((line) => text.includes(line));
    }, { timeout: 15000 }).toBe(true);
  });
});

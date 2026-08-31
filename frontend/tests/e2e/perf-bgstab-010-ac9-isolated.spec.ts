import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';

import { getActiveSessionId, login, waitForTerminal } from './helpers';

type JsonFrame = Record<string, unknown> & {
  type?: string;
  channel?: string;
  wsTransportMode?: string;
  sessionId?: string;
  connectionEpoch?: string;
  deliverySeq?: number;
  replayToken?: string;
  seq?: number;
  snapshotSeq?: number;
};

type WebSocketChannel = 'control' | 'output';
type WsTransportMode = 'unified' | 'split-shadow' | 'split';

interface CapturedFrame {
  direction: 'page-to-server' | 'server-to-page';
  generation: number;
  message: JsonFrame | null;
}

class IsolatedWebSocketRelay {
  readonly frames: CapturedFrame[] = [];
  readonly blockedSyntheticAcks: CapturedFrame[] = [];

  private generation = 0;
  private syntheticAck: Pick<JsonFrame, 'sessionId' | 'connectionEpoch' | 'deliverySeq'> | null = null;
  private readonly connections = new Map<
    number,
    { page: WebSocketRoute; server: WebSocketRoute; url: string }
  >();

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws(?:\?|$)/, pageRoute => {
      const generation = ++this.generation;
      let serverRoute: WebSocketRoute | null = null;
      pageRoute.onMessage(raw => {
        const frame = { direction: 'page-to-server', generation, message: parseFrame(raw) } satisfies CapturedFrame;
        this.frames.push(frame);
        if (this.isSyntheticAck(frame.message)) {
          this.blockedSyntheticAcks.push(frame);
          return;
        }
        if (!serverRoute) throw new Error('isolated AC-9 relay server endpoint is unavailable');
        serverRoute.send(raw);
      });
      serverRoute = pageRoute.connectToServer();
      this.connections.set(generation, { page: pageRoute, server: serverRoute, url: pageRoute.url() });
      serverRoute.onMessage(raw => {
        this.frames.push({ direction: 'server-to-page', generation, message: parseFrame(raw) });
        pageRoute.send(raw);
      });
    });
  }

  blockSyntheticAck(input: Pick<JsonFrame, 'sessionId' | 'connectionEpoch' | 'deliverySeq'>): void {
    this.syntheticAck = input;
  }

  latestSnapshot(sessionId: string): { generation: number; frame: JsonFrame } | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (
        frame.direction === 'server-to-page'
        && frame.message?.type === 'screen-snapshot'
        && frame.message.sessionId === sessionId
      ) {
        return { generation: frame.generation, frame: frame.message };
      }
    }
    return null;
  }

  injectFromServer(generation: number, message: JsonFrame): void {
    const connection = this.connections.get(generation);
    if (!connection) throw new Error(`isolated AC-9 relay generation ${generation} is unavailable`);
    this.frames.push({ direction: 'server-to-page', generation, message });
    connection.page.send(JSON.stringify(message));
  }

  connectionUrl(generation: number): string | null {
    return this.connections.get(generation)?.url ?? null;
  }

  connectionChannel(generation: number): WebSocketChannel | null {
    for (const frame of this.frames) {
      if (
        frame.direction === 'server-to-page'
        && frame.generation === generation
        && frame.message?.type === 'connected'
        && (frame.message.channel === 'control' || frame.message.channel === 'output')
      ) {
        return frame.message.channel;
      }
    }
    return null;
  }

  connectionTransportMode(generation: number): WsTransportMode | null {
    for (const frame of this.frames) {
      if (
        frame.direction === 'server-to-page'
        && frame.generation === generation
        && frame.message?.type === 'connected'
        && (
          frame.message.wsTransportMode === 'unified'
          || frame.message.wsTransportMode === 'split-shadow'
          || frame.message.wsTransportMode === 'split'
        )
      ) {
        return frame.message.wsTransportMode;
      }
    }
    return null;
  }

  private isSyntheticAck(message: JsonFrame | null): boolean {
    return message?.type === 'terminal-delivery:ack'
      && message.sessionId === this.syntheticAck?.sessionId
      && message.connectionEpoch === this.syntheticAck?.connectionEpoch
      && message.deliverySeq === this.syntheticAck?.deliverySeq;
  }
}

function parseFrame(raw: string | Buffer): JsonFrame | null {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as JsonFrame : null;
  } catch {
    return null;
  }
}

interface ReusableWave3Workspace {
  workspaceId: string;
  sessionId: string;
  createdAt: string;
}

// Fixture precondition (SDS-AC-3): a test-owned idle W3-SOLE-WRITER workspace
// must already exist. This evidence test is read-only and fails closed otherwise.
async function listReusableWave3Workspaces(page: Page): Promise<ReusableWave3Workspace[]> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch('/api/workspaces', { headers });
    if (!response.ok) {
      throw new Error(`isolated AC-9 workspace read returned ${response.status}`);
    }
    const state = await response.json() as {
      workspaces: Array<{ id: string; name: string; activeTabId: string | null; createdAt: string }>;
      tabs: Array<{
        id: string;
        workspaceId: string;
        sessionId: string;
        shellType: string;
        lifecycleState?: string;
        recoverable?: boolean;
      }>;
    };
    return state.workspaces.flatMap(workspace => {
      const timestamp = /^W3-SOLE-WRITER-(\d{13})$/u.exec(workspace.name);
      const workspaceTabs = state.tabs.filter(tab => tab.workspaceId === workspace.id);
      const activeTab = workspaceTabs.find(tab => tab.id === workspace.activeTabId);
      if (
        !timestamp
        || workspaceTabs.length !== 1
        || !activeTab
        || activeTab.shellType !== 'powershell'
        || activeTab.lifecycleState !== 'active'
        || activeTab.recoverable === false
        || !activeTab.sessionId
        || Math.abs(Date.parse(workspace.createdAt) - Number(timestamp[1])) > 5 * 60_000
      ) {
        return [];
      }
      return [{ workspaceId: workspace.id, sessionId: activeTab.sessionId, createdAt: workspace.createdAt }];
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  });
}

async function selectReusableWave3Workspace(page: Page): Promise<ReusableWave3Workspace> {
  const candidates = await listReusableWave3Workspaces(page);
  for (const candidate of candidates) {
    if (await readSessionStatus(page, candidate.sessionId) === 'idle') {
      return candidate;
    }
  }
  throw new Error('isolated AC-9 reusable idle W3-SOLE-WRITER workspace is unavailable');
}

async function readWorkspaceTopology(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`isolated AC-9 topology read returned ${response.status}`);
    const state = await response.json() as {
      workspaces: Array<{ id: string; activeTabId: string | null; sortOrder: number }>;
      tabs: Array<{ id: string; workspaceId: string; sessionId: string; sortOrder: number }>;
    };
    return JSON.stringify({
      workspaces: [...state.workspaces]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(workspace => [workspace.id, workspace.activeTabId, workspace.sortOrder]),
      tabs: [...state.tabs]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(tab => [tab.id, tab.workspaceId, tab.sessionId, tab.sortOrder]),
    });
  });
}

async function installWorkspaceMutationGuard(page: Page): Promise<() => readonly string[]> {
  const blocked: string[] = [];
  await page.route(/\/api\/workspaces(?:\/|$)/, async route => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.continue();
      return;
    }
    blocked.push(`${method} ${new URL(route.request().url()).pathname}`);
    await route.abort();
  });
  return () => blocked;
}

async function readSessionStatus(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate(async id => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return null;
    const session = await response.json() as { status?: unknown };
    return typeof session.status === 'string' ? session.status : null;
  }, sessionId);
}

async function activeTerminal(page: Page, sessionId: string): Promise<Locator> {
  const terminal = page.locator(
    `[data-terminal-runtime-entry="true"][data-session-id=${JSON.stringify(sessionId)}]`,
  );
  await expect(terminal).toHaveCount(1, { timeout: 10_000 });
  await expect(terminal).toBeVisible({ timeout: 10_000 });
  return terminal;
}

test.describe('PERF-BGSTAB-010 AC-9 isolated browser evidence', () => {
  test.describe.configure({ retries: 0 });

  test('does not depend on a historical evidence writer', () => {
    const source = readFileSync(new URL('./perf-bgstab-010-ac9-isolated.spec.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/wave3-terminal-authority-fairness\.spec/u);
    expect(source).not.toMatch(/docs\/analysis\/kiwi-coder-2026-07-16\.projectmaster\.wave3-authority-fairness/u);
    expect(source).not.toMatch(/\bwriteFileSync\s*\(/u);
  });

  test('visible fair-delivery ACK preserves idle through the real HTTPS WebSocket', async ({ page }) => {
    test.setTimeout(60_000);
    const relay = new IsolatedWebSocketRelay();
    const blockedWorkspaceMutations = await installWorkspaceMutationGuard(page);
    await relay.install(page);
    await login(page);
    expect(new URL(page.url()).origin).toBe('https://localhost:2222');

    const topologyBefore = await readWorkspaceTopology(page);
    const reusable = await selectReusableWave3Workspace(page);
    await page.evaluate(workspaceId => {
      localStorage.setItem('active_workspace_id', workspaceId);
    }, reusable.workspaceId);
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'isolated AC-9 selected workspace did not activate its reusable session').toBe(reusable.sessionId);
    await expect.poll(() => readSessionStatus(page, reusable.sessionId), {
      message: 'isolated AC-9 reusable session did not settle idle before delivery injection',
      timeout: 15_000,
    }).toBe('idle');

    await expect.poll(() => relay.latestSnapshot(reusable.sessionId), {
      message: 'isolated AC-9 reusable session did not route an authoritative screen snapshot',
      timeout: 20_000,
    }).not.toBeNull();
    const snapshot = relay.latestSnapshot(reusable.sessionId);
    if (!snapshot) throw new Error('isolated AC-9 routed snapshot disappeared');
    const snapshotSeq = snapshot.frame.seq;
    if (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0) {
      throw new Error('isolated AC-9 snapshot sequence is invalid');
    }
    const replayToken = snapshot.frame.replayToken;
    if (typeof replayToken !== 'string' || replayToken.length === 0) {
      throw new Error('isolated AC-9 snapshot replay token is invalid');
    }
    const snapshotTransportMode = relay.connectionTransportMode(snapshot.generation);
    if (!snapshotTransportMode) throw new Error('isolated AC-9 snapshot transport mode is unavailable');
    const snapshotChannel = relay.connectionChannel(snapshot.generation);
    expect(
      snapshotChannel,
      'isolated AC-9 snapshot did not use the live unified control WebSocket',
    ).toBe('control');
    expect(
      snapshotTransportMode,
      'isolated AC-9 did not run against the live unified transport configuration',
    ).toBe('unified');
    const webSocketUrl = relay.connectionUrl(snapshot.generation);
    expect(webSocketUrl, 'isolated AC-9 routed WebSocket URL is unavailable').not.toBeNull();
    const parsedWebSocketUrl = new URL(webSocketUrl!);
    expect(parsedWebSocketUrl.protocol).toBe('wss:');
    expect(parsedWebSocketUrl.host).toBe('localhost:2222');
    expect(parsedWebSocketUrl.pathname).toBe('/ws');
    await expect.poll(() => relay.frames.some(frame => (
      frame.direction === 'page-to-server'
      && frame.generation === snapshot.generation
      && relay.connectionChannel(frame.generation) === 'control'
      && frame.message?.type === 'screen-snapshot:ready'
      && frame.message.sessionId === reusable.sessionId
      && frame.message.replayToken === replayToken
      && (frame.message.snapshotSeq === undefined || frame.message.snapshotSeq === snapshotSeq)
    )), {
      message: 'isolated AC-9 unified snapshot did not drain through its control WebSocket before output injection',
      timeout: 15_000,
    }).toBe(true);

    const connectionEpoch = `isolated-ac9-${Date.now()}`;
    relay.blockSyntheticAck({ sessionId: reusable.sessionId, connectionEpoch, deliverySeq: 1 });
    relay.injectFromServer(snapshot.generation, {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: true,
      connectionEpoch,
      supportsHiddenDataGapRecovery: true,
    });
    const marker = `PERF-BGSTAB-010-ISOLATED-ACK-${Date.now()}`;
    relay.injectFromServer(snapshot.generation, {
      type: 'output',
      sessionId: reusable.sessionId,
      data: `\r\n${marker}\r\n`,
      connectionEpoch,
      deliverySeq: 1,
    });

    const terminal = await activeTerminal(page, reusable.sessionId);
    await expect(terminal.locator('.xterm-rows')).toContainText(marker, { timeout: 15_000 });
    await expect.poll(() => relay.blockedSyntheticAcks.length, {
      message: 'isolated AC-9 delivery did not emit exactly one locally blocked matching ACK',
      timeout: 15_000,
    }).toBe(1);
    expect(relay.blockedSyntheticAcks).toHaveLength(1);
    await expect.poll(() => readSessionStatus(page, reusable.sessionId), {
      message: 'isolated AC-9 ACK inferred semantic execution or left the session running',
      timeout: 15_000,
    }).toBe('idle');
    expect(await readWorkspaceTopology(page)).toBe(topologyBefore);
    expect(blockedWorkspaceMutations()).toEqual([]);
  });
});

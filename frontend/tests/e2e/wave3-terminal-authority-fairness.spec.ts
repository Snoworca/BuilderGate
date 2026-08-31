import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';
import { build } from 'esbuild';
import { getActiveSessionId, login, setTerminalInputTransportOverride, waitForTerminal } from './helpers';
import { collectTerminalSoleWriterInventory } from '../support/terminalSoleWriterInventory.ts';

type JsonFrame = Record<string, unknown> & {
  type?: string;
  sessionId?: string;
  replayToken?: string;
  repairToken?: string;
  seq?: number;
};

interface CapturedFrame {
  direction: 'page-to-server' | 'server-to-page';
  generation: number;
  message: JsonFrame | null;
}

interface CaseRecord {
  title: string;
  status: string;
  expectedStatus: string;
  durationMs: number;
  errors: string[];
  evidence: Record<string, unknown> | null;
}

interface RuntimeRemountContext {
  workspaceId: string;
  originalActiveTabId: string;
  originalViewMode: string;
  temporaryTabId: string;
  temporarySessionId: string;
  temporaryTabName: string;
}

const REPOSITORY_ROOT = resolve(process.cwd(), '..');
const ANALYSIS_ROOT = resolve(
  REPOSITORY_ROOT,
  'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness',
);
const RAW_EVIDENCE_PATH = resolve(ANALYSIS_ROOT, 'ph-003/sole-writer-https-e2e.raw.json');
const INVENTORY_PATH = resolve(ANALYSIS_ROOT, 'terminal-write-inventory.json');
const CASE_FRAGMENT_ROOT = resolve(
  process.cwd(),
  'test-results/.wave3-terminal-authority-case-fragments',
);
const EXPECTED_TEST_COUNT = 6;
const SOURCE_INPUTS = [
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/types/ws-protocol.ts',
  'frontend/src/utils/terminalCheckpointRuntime.ts',
  'frontend/src/utils/terminalWriteCoordinator.ts',
  'frontend/src/utils/terminalWriteCoordinatorRuntime.ts',
  'frontend/src/utils/terminalRawMutationAdapter.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
  'frontend/tests/support/terminalSoleWriterInventory.ts',
  'frontend/tests/unit/terminalCheckpointRuntime.test.ts',
  'frontend/tests/unit/terminalSoleWriterInventory.test.ts',
  'frontend/tests/unit/terminalWriteCoordinator.test.ts',
  'frontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts',
  'frontend/playwright.config.ts',
  'server/src/types/ws-protocol.ts',
  'server/src/ws/WsRouter.ts',
] as const;

const testStartedAt = new Map<string, number>();
const caseEvidence = new Map<string, Record<string, unknown>>();
const caseRecords: CaseRecord[] = [];
let coordinatorBrowserBundlePromise: Promise<string> | null = null;

class RoutedWebSocketHarness {
  readonly frames: CapturedFrame[] = [];
  readonly blockedPageToServerFrames: CapturedFrame[] = [];
  readonly blockedServerToPageFrames: CapturedFrame[] = [];
  private generationValue = 0;
  private readonly pageToServerBlockers = new Set<(message: JsonFrame) => boolean>();
  private readonly serverToPageBlockers = new Set<(message: JsonFrame) => boolean>();
  private readonly connections = new Map<
    number,
    { page: WebSocketRoute; server: WebSocketRoute; url: string }
  >();

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws(?:\?|$)/, (pageRoute) => {
      const generation = ++this.generationValue;
      let serverRoute: WebSocketRoute | null = null;
      pageRoute.onMessage((raw) => {
        const frame = {
          direction: 'page-to-server',
          generation,
          message: parseFrame(raw),
        } satisfies CapturedFrame;
        this.frames.push(frame);
        if (
          frame.message
          && [...this.pageToServerBlockers].some(blocker => blocker(frame.message!))
        ) {
          this.blockedPageToServerFrames.push(frame);
          return;
        }
        if (!serverRoute) {
          throw new Error('routed WebSocket server endpoint is unavailable');
        }
        serverRoute.send(raw);
      });
      serverRoute = pageRoute.connectToServer();
      this.connections.set(generation, { page: pageRoute, server: serverRoute, url: pageRoute.url() });
      serverRoute.onMessage((raw) => {
        const frame = {
          direction: 'server-to-page',
          generation,
          message: parseFrame(raw),
        } satisfies CapturedFrame;
        this.frames.push(frame);
        if (
          frame.message
          && [...this.serverToPageBlockers].some(blocker => blocker(frame.message!))
        ) {
          this.blockedServerToPageFrames.push(frame);
          return;
        }
        pageRoute.send(raw);
      });
    });
  }

  blockPageToServer(predicate: (message: JsonFrame) => boolean): () => void {
    this.pageToServerBlockers.add(predicate);
    return () => this.pageToServerBlockers.delete(predicate);
  }

  blockServerToPage(predicate: (message: JsonFrame) => boolean): () => void {
    this.serverToPageBlockers.add(predicate);
    return () => this.serverToPageBlockers.delete(predicate);
  }

  get connectionCount(): number {
    return this.generationValue;
  }

  latest(
    direction: CapturedFrame['direction'],
    predicate: (message: JsonFrame) => boolean,
    generation?: number,
  ): JsonFrame | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (
        frame.direction === direction
        && (generation === undefined || frame.generation === generation)
        && frame.message
        && predicate(frame.message)
      ) {
        return frame.message;
      }
    }
    return null;
  }

  latestGeneration(
    direction: CapturedFrame['direction'],
    predicate: (message: JsonFrame) => boolean,
  ): number | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame.direction === direction && frame.message && predicate(frame.message)) {
        return frame.generation;
      }
    }
    return null;
  }

  injectToPage(generation: number, message: JsonFrame): void {
    const connection = this.connections.get(generation);
    if (!connection) {
      throw new Error(`E2E precondition failed: routed WebSocket generation ${generation} is unavailable`);
    }
    this.frames.push({ direction: 'server-to-page', generation, message });
    connection.page.send(JSON.stringify(message));
  }

  injectToServer(generation: number, message: JsonFrame): void {
    const connection = this.connections.get(generation);
    if (!connection) {
      throw new Error(`E2E precondition failed: routed WebSocket generation ${generation} is unavailable`);
    }
    connection.server.send(JSON.stringify(message));
  }

  connectionUrl(generation: number): string | null {
    return this.connections.get(generation)?.url ?? null;
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

function rememberEvidence(testInfo: TestInfo, evidence: Record<string, unknown>): void {
  caseEvidence.set(testInfo.title, evidence);
}

async function startDebugCapture(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (targetSessionId) => {
    const debug = window.__buildergateTerminalDebug;
    if (!debug) throw new Error('E2E precondition failed: terminal debug API is unavailable');
    await debug.start(targetSessionId);
    debug.clear(targetSessionId);
  }, sessionId);
}

async function readDebugEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => (
    window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? []
  ), sessionId);
}

async function getSessionTerminalRuntime(page: Page, sessionId: string): Promise<Locator> {
  const runtime = page.locator(
    `[data-terminal-runtime-entry="true"][data-session-id=${JSON.stringify(sessionId)}]`,
  );
  await expect(runtime).toHaveCount(1, { timeout: 10_000 });
  await expect(runtime).toBeVisible({ timeout: 10_000 });
  return runtime;
}

async function createWave3PowerShellWorkspace(page: Page): Promise<{
  workspaceId: string;
  sessionId: string;
}> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const workspaceResponse = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name }),
    });
    if (!workspaceResponse.ok) {
      throw new Error(`E2E precondition failed: workspace create returned ${workspaceResponse.status}`);
    }
    const workspace = await workspaceResponse.json() as { id?: unknown };
    if (typeof workspace.id !== 'string' || workspace.id.length === 0) {
      throw new Error('E2E precondition failed: workspace identity is unavailable');
    }
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabResponse.ok) {
      throw new Error(`E2E precondition failed: PowerShell tab create returned ${tabResponse.status}`);
    }
    const tab = await tabResponse.json() as { sessionId?: unknown };
    if (typeof tab.sessionId !== 'string' || tab.sessionId.length === 0) {
      throw new Error('E2E precondition failed: PowerShell session identity is unavailable');
    }
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspaceId: workspace.id, sessionId: tab.sessionId };
  }, `W3-SOLE-WRITER-${Date.now()}`);
}

async function deleteWave3Workspace(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`E2E cleanup failed: workspace delete returned ${response.status}`);
    }
  }, workspaceId);
}

async function sendVisibleTerminalCommand(
  page: Page,
  sessionId: string,
  command: string,
): Promise<void> {
  const runtime = await getSessionTerminalRuntime(page, sessionId);
  const input = runtime.locator('.xterm-helper-textarea');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  await page.keyboard.press('Control+C');
  await expect.poll(async () => (
    await runtime.locator('.xterm-rows').textContent()
  ) ?? '', { timeout: 10_000 }).toMatch(/PS\s+[^>]*>\s*$/u);
  await page.keyboard.type(command, { delay: 0 });
  await page.keyboard.press('Enter');
}

async function waitForCommandCompletion(page: Page, sessionId: string, marker: string): Promise<void> {
  const runtime = await getSessionTerminalRuntime(page, sessionId);
  await expect.poll(async () => {
    const text = await runtime.locator('.xterm-rows').textContent() ?? '';
    const markerIndex = text.lastIndexOf(marker);
    return markerIndex >= 0 && /PS\s+[^>]*>\s*$/u.test(text.slice(markerIndex + marker.length));
  }, {
    message: `terminal command did not complete after marker ${marker}`,
    timeout: 20_000,
  }).toBe(true);
}

async function readSessionStatus(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate(async (targetSessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/${targetSessionId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) return null;
    const session = await response.json() as { status?: unknown };
    return typeof session.status === 'string' ? session.status : null;
  }, sessionId);
}

async function waitForSnapshot(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  minimumGeneration = 1,
): Promise<{ generation: number; snapshot: JsonFrame }> {
  await expect.poll(() => harness.latestGeneration(
    'server-to-page',
    message => message.type === 'screen-snapshot'
      && message.sessionId === sessionId,
  ), {
    message: 'E2E precondition failed: authoritative screen snapshot was not routed',
    timeout: 20_000,
  }).toBeGreaterThanOrEqual(minimumGeneration);
  const generation = harness.latestGeneration(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
  );
  if (generation === null) {
    throw new Error('E2E precondition failed: screen snapshot generation disappeared');
  }
  const snapshot = harness.latest(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
    generation,
  );
  if (!snapshot) {
    throw new Error('E2E precondition failed: screen snapshot frame disappeared');
  }
  return { generation, snapshot };
}

async function waitForCheckpointViewRegistration(
  harness: RoutedWebSocketHarness,
  sessionId: string,
): Promise<{ generation: number; viewGeneration: number }> {
  const findRegistration = (): { generation: number; viewGeneration: number } | null => {
    for (let index = harness.frames.length - 1; index >= 0; index -= 1) {
      const frame = harness.frames[index];
      if (frame.direction !== 'page-to-server' || frame.message?.type !== 'terminal-checkpoint:negotiate') {
        continue;
      }
      const views = frame.message.views;
      if (!Array.isArray(views)) continue;
      const registration = views.find(view => (
        typeof view === 'object'
        && view !== null
        && (view as Record<string, unknown>).sessionId === sessionId
        && Number.isSafeInteger((view as Record<string, unknown>).viewGeneration)
      )) as Record<string, unknown> | undefined;
      if (registration) {
        return {
          generation: frame.generation,
          viewGeneration: registration.viewGeneration as number,
        };
      }
    }
    return null;
  };
  try {
    await expect.poll(findRegistration, {
      message: 'terminal checkpoint view registration was not negotiated',
      timeout: 15_000,
    }).not.toBeNull();
  } catch (error) {
    const negotiateFrames = harness.frames.filter(frame => (
      frame.direction === 'page-to-server'
      && frame.message?.type === 'terminal-checkpoint:negotiate'
    )).map(frame => ({ generation: frame.generation, views: frame.message?.views ?? null }));
    const pageFrameTypes = harness.frames.filter(frame => frame.direction === 'page-to-server')
      .map(frame => frame.message?.type ?? null);
    throw new Error(
      `terminal checkpoint view registration was not negotiated: ${JSON.stringify({ negotiateFrames, pageFrameTypes })}`,
      { cause: error },
    );
  }
  const registration = findRegistration();
  if (!registration) throw new Error('checkpoint registration disappeared');
  return registration;
}

function latestSessionCheckpointRegistration(
  harness: RoutedWebSocketHarness,
  sessionId: string,
): { generation: number; viewGeneration: number } | null {
  for (let index = harness.frames.length - 1; index >= 0; index -= 1) {
    const frame = harness.frames[index];
    if (frame.direction !== 'page-to-server' || !frame.message) continue;
    if (frame.message.type === 'terminal-checkpoint:negotiate') {
      const views = frame.message.views;
      if (Array.isArray(views)) {
        const registration = views.find(view => (
          typeof view === 'object'
          && view !== null
          && (view as Record<string, unknown>).sessionId === sessionId
          && typeof (view as Record<string, unknown>).viewGeneration === 'number'
        )) as Record<string, unknown> | undefined;
        if (registration) {
          return {
            generation: frame.generation,
            viewGeneration: registration.viewGeneration as number,
          };
        }
      }
    }
  }
  return null;
}

function checkpointPayload(value: string): { encoding: 'base64'; data: string; encodedBytes: number } {
  const bytes = Buffer.from(value, 'utf8');
  return {
    encoding: 'base64',
    data: bytes.toString('base64'),
    encodedBytes: bytes.byteLength,
  };
}

function checkpointSha256(value: string): { algorithm: 'sha256'; hex: string } {
  return {
    algorithm: 'sha256',
    hex: createHash('sha256').update(value, 'utf8').digest('hex'),
  };
}

async function installNoTerminalSnapshotCache(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storagePrototype = Storage.prototype as Storage & {
      __buildergateWave3OriginalSetItem?: Storage['setItem'];
    };
    if (storagePrototype.__buildergateWave3OriginalSetItem) return;
    const originalSetItem = Storage.prototype.setItem;
    storagePrototype.__buildergateWave3OriginalSetItem = originalSetItem;
    Storage.prototype.setItem = function setItemWithoutTerminalSnapshot(key: string, value: string): void {
      if (key.startsWith('terminal_snapshot_')) return;
      originalSetItem.call(this, key, value);
    };
  });
}

async function installBoundedRuntimeResidencyForRemount(page: Page): Promise<void> {
  await page.route(/\/api\/runtime-config(?:\?|$)/u, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown> & {
      stabilityModes?: Record<string, unknown>;
      resourceLimits?: Record<string, unknown> & {
        workspaceRuntime?: Record<string, unknown>;
      };
    };
    await route.fulfill({
      response,
      json: {
        ...payload,
        stabilityModes: {
          ...(payload.stabilityModes ?? {}),
          frontendRuntimeResidency: 'bounded',
        },
        resourceLimits: {
          ...(payload.resourceLimits ?? {}),
          workspaceRuntime: {
            ...(payload.resourceLimits?.workspaceRuntime ?? {}),
            maxLiveWorkspaces: 1,
            maxLiveTerminals: 1,
            hiddenRuntimeTtlMs: 1_000,
          },
        },
      },
    });
  });
}

async function hideRuntimeBehindTemporaryTab(
  page: Page,
  targetSessionId: string,
): Promise<RuntimeRemountContext> {
  return page.evaluate(async (sessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const stateResponse = await fetch('/api/workspaces', { headers });
    if (!stateResponse.ok) throw new Error(`workspace fetch failed: ${stateResponse.status}`);
    const state = await stateResponse.json();
    const targetTab = state.tabs.find((tab: { sessionId?: string }) => tab.sessionId === sessionId);
    const workspace = state.workspaces.find((item: { id?: string }) => item.id === targetTab?.workspaceId);
    if (!targetTab || !workspace?.activeTabId) {
      throw new Error('E2E precondition failed: target tab/workspace is unavailable');
    }
    const temporaryTabName = `W3 Runtime Remount ${Date.now()}`;
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ shell: 'powershell', name: temporaryTabName }),
    });
    if (!tabResponse.ok) throw new Error(`temporary tab create failed: ${tabResponse.status}`);
    const temporaryTab = await tabResponse.json();
    const updateResponse = await fetch(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ viewMode: 'tab', activeTabId: temporaryTab.id }),
    });
    if (!updateResponse.ok) {
      await fetch(`/api/workspaces/${workspace.id}/tabs/${temporaryTab.id}`, {
        method: 'DELETE',
        headers,
      }).catch(() => undefined);
      throw new Error(`temporary tab activation failed: ${updateResponse.status}`);
    }
    return {
      workspaceId: workspace.id,
      originalActiveTabId: targetTab.id,
      originalViewMode: workspace.viewMode,
      temporaryTabId: temporaryTab.id,
      temporarySessionId: temporaryTab.sessionId,
      temporaryTabName,
    };
  }, targetSessionId);
}

async function reactivateOriginalRuntime(page: Page, context: RuntimeRemountContext): Promise<void> {
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const response = await fetch(`/api/workspaces/${input.workspaceId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ viewMode: 'tab', activeTabId: input.originalActiveTabId }),
    });
    if (!response.ok) throw new Error(`original tab activation failed: ${response.status}`);
  }, context);
}

async function cleanupRuntimeRemountContext(page: Page, context: RuntimeRemountContext): Promise<void> {
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E cleanup failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const errors: string[] = [];
    const restoreResponse = await fetch(`/api/workspaces/${input.workspaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        viewMode: input.originalViewMode,
        activeTabId: input.originalActiveTabId,
      }),
    }).catch(() => null);
    if (!restoreResponse?.ok) errors.push(`workspace restore returned ${restoreResponse?.status ?? 'network-error'}`);
    const deleteResponse = await fetch(
      `/api/workspaces/${input.workspaceId}/tabs/${input.temporaryTabId}`,
      { method: 'DELETE', headers },
    ).catch(() => null);
    if (deleteResponse && !deleteResponse.ok && deleteResponse.status !== 404) {
      errors.push(`temporary tab delete returned ${deleteResponse.status}`);
    }
    const verifyResponse = await fetch('/api/workspaces', { headers }).catch(() => null);
    if (!verifyResponse?.ok) {
      errors.push(`cleanup verification returned ${verifyResponse?.status ?? 'network-error'}`);
    } else {
      const state = await verifyResponse.json();
      const workspace = state.workspaces.find((item: { id?: string }) => item.id === input.workspaceId);
      const leakedTab = state.tabs.find((tab: { id?: string; name?: string }) => (
        tab.id === input.temporaryTabId || tab.name === input.temporaryTabName
      ));
      if (
        !workspace
        || workspace.activeTabId !== input.originalActiveTabId
        || workspace.viewMode !== input.originalViewMode
        || leakedTab
      ) {
        errors.push('workspace/runtime remount fixture was not fully restored');
      }
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
  }, context);
}

function validRestoreNeeded(
  sessionId: string,
  replayToken: string,
  repairToken: string,
  snapshotSeq: number,
  authorityEpoch: string,
): JsonFrame {
  return {
    type: 'screen-repair:restore-needed',
    sessionId,
    repairToken,
    replayToken,
    snapshotSeq,
    state: 'stale',
    reason: 'byte-cap-exceeded',
    outcome: 'fresh-snapshot-started',
    authorityEpoch,
    authorityRevision: snapshotSeq,
    coversThroughSeq: snapshotSeq,
  };
}

async function runCoordinatorFaultMatrix(page: Page) {
  coordinatorBrowserBundlePromise ??= build({
    entryPoints: [resolve(REPOSITORY_ROOT, 'frontend/src/utils/terminalWriteCoordinator.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: '__buildergateWave3CoordinatorModule',
    target: ['chrome120'],
  }).then((result) => {
    const output = result.outputFiles[0]?.text;
    if (!output) throw new Error('E2E precondition failed: production coordinator browser bundle is empty');
    return output;
  });
  const browserBundle = await coordinatorBrowserBundlePromise;
  const bundleUrl = 'https://localhost:2222/__wave3_e2e__/terminal-write-coordinator.js';
  await page.route(bundleUrl, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: browserBundle,
    });
  });
  await page.addScriptTag({ url: bundleUrl });
  return page.evaluate(async () => {
    type Result = Readonly<{ accepted: boolean; reason?: string }>;
    type State = Readonly<{
      viewGeneration: number;
      ready: boolean;
      disposed: boolean;
      writeInFlight: boolean;
      pendingCommands: number;
      pendingInputs: number;
    }>;
    type Coordinator = {
      dispatch: (command: Record<string, unknown>) => Result;
      getState: () => State;
    };
    type Adapter = {
      write: (
        command: Readonly<{ kind: string; data: string | Uint8Array }>,
        onWritten: () => void,
      ) => void;
      resetParser: () => void;
      resize: (cols: number, rows: number) => void;
      applyModes: (modes: Readonly<Record<string, boolean>>) => void;
      clearScreen: () => void;
      fit: () => Readonly<{ cols: number; rows: number }>;
      setWindowsPty: (value: unknown) => void;
      markReady: (generation: number) => void;
      releaseInput: (data: string) => void;
      requestFreshRecovery: (reason: string) => void;
      checkpointApplied: (metadata: Readonly<Record<string, unknown>>) => void;
      checkpointDrained: (metadata: Readonly<Record<string, unknown>>) => void;
      settleInput: (token: string, outcome: string) => void;
      settle: (token: string, outcome: string) => void;
    };
    type Factory = (options: {
      viewGeneration: number;
      adapter: Adapter;
      digestBytes: (bytes: Uint8Array) => string;
      timeoutMs: number;
      postCheckpointMaxBytes: number;
      postCheckpointMaxChunks: number;
      checkpointMaxBytes: number;
      checkpointMaxChunks: number;
      pendingInputMaxBytes: number;
      pendingInputMaxCount: number;
      pendingInputTtlMs: number;
      settlementLedgerMaxEntries: number;
      settlementLedgerTtlMs: number;
    }) => Coordinator;
    const loaded = (window as unknown as {
      __buildergateWave3CoordinatorModule?: { createTerminalWriteCoordinator?: Factory };
    }).__buildergateWave3CoordinatorModule;
    const createTerminalWriteCoordinator = loaded?.createTerminalWriteCoordinator;
    if (!createTerminalWriteCoordinator) {
      throw new Error('E2E precondition failed: bundled production coordinator export is unavailable');
    }
    const createCoordinator = createTerminalWriteCoordinator;
    const encoder = new TextEncoder();
    const digestBytes = (bytes: Uint8Array): string => {
      let hash = 0xcbf29ce484222325n;
      for (const byte of bytes) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
      }
      return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
    };
    const make = (generation = 7) => {
      const callbacks: Array<() => void> = [];
      const recoveries: string[] = [];
      const settlements: Array<{ token: string; outcome: string }> = [];
      const inputSettlements: Array<{ token: string; outcome: string }> = [];
      const ready: number[] = [];
      const releasedInput: string[] = [];
      const writes: Array<{ kind: string; byteLength: number }> = [];
      const adapter: Adapter = {
        write: (command, onWritten) => {
          writes.push({
            kind: command.kind,
            byteLength: typeof command.data === 'string'
              ? encoder.encode(command.data).byteLength
              : command.data.byteLength,
          });
          callbacks.push(onWritten);
        },
        resetParser: () => undefined,
        resize: () => undefined,
        applyModes: () => undefined,
        clearScreen: () => undefined,
        fit: () => ({ cols: 120, rows: 40 }),
        setWindowsPty: () => undefined,
        markReady: (nextGeneration) => ready.push(nextGeneration),
        releaseInput: (data) => releasedInput.push(data),
        requestFreshRecovery: (reason) => recoveries.push(reason),
        checkpointApplied: () => undefined,
        checkpointDrained: () => undefined,
        settleInput: (token, outcome) => inputSettlements.push({ token, outcome }),
        settle: (token, outcome) => settlements.push({ token, outcome }),
      };
      const coordinator = createCoordinator({
        viewGeneration: generation,
        adapter,
        digestBytes,
        timeoutMs: 5_000,
        postCheckpointMaxBytes: 64 * 1024,
        postCheckpointMaxChunks: 16,
        checkpointMaxBytes: 64 * 1024,
        checkpointMaxChunks: 16,
        pendingInputMaxBytes: 64 * 1024,
        pendingInputMaxCount: 128,
        pendingInputTtlMs: 5_000,
        settlementLedgerMaxEntries: 1_024,
        settlementLedgerTtlMs: 60_000,
      });
      return {
        coordinator,
        callbacks,
        recoveries,
        settlements,
        inputSettlements,
        ready,
        releasedInput,
        writes,
      };
    };

    const digestCase = make();
    const digestBody = encoder.encode('digest-body');
    const digestMetadata = {
      streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10', snapshotSeq: '10',
      oldestRetainedSeq: '1', retentionPolicyId: 'w3-e2e-digest', viewGeneration: 7,
      chunkCount: 1, encodedByteTotal: digestBody.byteLength,
      digest: 'fnv1a64:0000000000000000',
    };
    digestCase.coordinator.dispatch({
      type: 'checkpoint-begin', ...digestMetadata, cols: 120, rows: 40, modes: {},
      parserTail: new Uint8Array(),
    });
    digestCase.coordinator.dispatch({
      type: 'checkpoint-chunk', ...digestMetadata, index: 0, count: 1, data: digestBody,
    });
    const digestCommit = digestCase.coordinator.dispatch({
      type: 'checkpoint-commit', ...digestMetadata,
    });

    const chunkCase = make();
    const chunkBody = encoder.encode('ab');
    const chunkMetadata = {
      streamEpoch: '2', checkpointEpoch: '1', sourceSeq: '20', snapshotSeq: '20',
      oldestRetainedSeq: '1', retentionPolicyId: 'w3-e2e-chunk-order', viewGeneration: 7,
      chunkCount: 2, encodedByteTotal: chunkBody.byteLength, digest: digestBytes(chunkBody),
    };
    chunkCase.coordinator.dispatch({
      type: 'checkpoint-begin', ...chunkMetadata, cols: 120, rows: 40, modes: {},
      parserTail: new Uint8Array(),
    });
    const outOfOrderChunk = chunkCase.coordinator.dispatch({
      type: 'checkpoint-chunk', ...chunkMetadata, index: 1, count: 2, data: encoder.encode('b'),
    });

    const epochCase = make();
    epochCase.coordinator.dispatch({
      type: 'live', streamEpoch: '3', sourceSeq: '18446744073709551615',
      viewGeneration: 7, data: encoder.encode('last'), settlementToken: 'last',
    });
    epochCase.callbacks.shift()?.();
    const epochRollover = epochCase.coordinator.dispatch({
      type: 'live', streamEpoch: '3', sourceSeq: '0', viewGeneration: 7,
      data: encoder.encode('wrapped'), settlementToken: 'wrapped',
    });

    const remountCase = make();
    remountCase.coordinator.dispatch({
      type: 'live', streamEpoch: '4', sourceSeq: '1', viewGeneration: 7,
      data: encoder.encode('old-generation'), settlementToken: 'old-generation',
    });
    const lateCallback = remountCase.callbacks.shift();
    const supersede = remountCase.coordinator.dispatch({ type: 'supersede', viewGeneration: 8 });
    lateCallback?.();
    lateCallback?.();

    const readyCase = make();
    readyCase.coordinator.dispatch({
      type: 'queue-input',
      viewGeneration: 7,
      data: 'queued-input',
      settlementToken: 'ready-input',
    });
    const readyBody = encoder.encode('authoritative-body');
    const readyMetadata = {
      streamEpoch: '5', checkpointEpoch: '1', sourceSeq: '30', snapshotSeq: '30',
      oldestRetainedSeq: '1', retentionPolicyId: 'w3-e2e-ready-barrier', viewGeneration: 7,
      chunkCount: 1, encodedByteTotal: readyBody.byteLength, digest: digestBytes(readyBody),
    };
    readyCase.coordinator.dispatch({
      type: 'checkpoint-begin', ...readyMetadata, cols: 120, rows: 40,
      modes: { bracketedPasteMode: true },
      parserTail: encoder.encode('\u001b['),
    });
    readyCase.coordinator.dispatch({
      type: 'checkpoint-chunk', ...readyMetadata, index: 0, count: 1, data: readyBody,
    });
    const readyCommit = readyCase.coordinator.dispatch({
      type: 'checkpoint-commit', ...readyMetadata,
    });
    const beforeDrain = {
      state: readyCase.coordinator.getState(),
      ready: [...readyCase.ready],
      releasedInput: [...readyCase.releasedInput],
      writes: [...readyCase.writes],
    };
    readyCase.callbacks.shift()?.();
    const betweenBodyAndTail = {
      state: readyCase.coordinator.getState(),
      ready: [...readyCase.ready],
      releasedInput: [...readyCase.releasedInput],
      writes: [...readyCase.writes],
    };
    readyCase.callbacks.shift()?.();
    const afterDrain = {
      state: readyCase.coordinator.getState(),
      ready: [...readyCase.ready],
      releasedInput: [...readyCase.releasedInput],
      writes: [...readyCase.writes],
    };

    return {
      execution: 'browser-evaluated-production-coordinator',
      digestMismatch: {
        result: digestCommit,
        recoveries: digestCase.recoveries,
        state: digestCase.coordinator.getState(),
      },
      outOfOrderChunk: {
        result: outOfOrderChunk,
        recoveries: chunkCase.recoveries,
        state: chunkCase.coordinator.getState(),
      },
      epochRollover: {
        result: epochRollover,
        recoveries: epochCase.recoveries,
        settlements: epochCase.settlements,
      },
      staleCallback: {
        supersede,
        settlements: remountCase.settlements,
        state: remountCase.coordinator.getState(),
      },
      readyBarrier: { readyCommit, beforeDrain, betweenBodyAndTail, afterDrain },
    };
  });
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function redactConnectionUrl(value: string | null): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.searchParams.has('token')) {
    url.searchParams.set('token', 'REDACTED');
  }
  return url.toString();
}

function loadAggregatedCaseRecords(): CaseRecord[] {
  const records = new Map<string, CaseRecord>();
  if (existsSync(CASE_FRAGMENT_ROOT)) {
    for (const filename of readdirSync(CASE_FRAGMENT_ROOT)) {
      if (!filename.endsWith('.json')) continue;
      const record = JSON.parse(
        readFileSync(resolve(CASE_FRAGMENT_ROOT, filename), 'utf8'),
      ) as CaseRecord;
      records.set(record.title, record);
    }
  }
  for (const record of caseRecords) records.set(record.title, record);
  return [...records.values()].sort((left, right) => left.title.localeCompare(right.title));
}

function writeEvidenceArtifacts(): void {
  mkdirSync(dirname(RAW_EVIDENCE_PATH), { recursive: true });
  const sourceHashes = Object.fromEntries(SOURCE_INPUTS.map((path) => [
    path,
    sha256File(resolve(REPOSITORY_ROOT, path)),
  ]));
  const rawMutationInventory = collectTerminalSoleWriterInventory(resolve(REPOSITORY_ROOT, 'frontend'));
  const evidenceCases = loadAggregatedCaseRecords();
  const faultEvidence = evidenceCases.find(record => record.evidence?.wireCheckpointCapability)?.evidence;
  const wireCheckpointCapability = faultEvidence?.wireCheckpointCapability as
    | Record<string, unknown>
    | undefined;
  const mockedActiveEvidence = evidenceCases.find(record => record.evidence?.mockedActiveCheckpointServer)
    ?.evidence?.mockedActiveCheckpointServer as Record<string, unknown> | undefined;
  const rollbackEvidence = evidenceCases.find(record => record.evidence?.checkpointCapabilityRollback)
    ?.evidence?.checkpointCapabilityRollback as Record<string, unknown> | undefined;
  const passed = evidenceCases.filter(record => record.status === record.expectedStatus).length;
  const failed = evidenceCases.length - passed;
  const evidenceInput = {
    origin: 'https://localhost:2222',
    project: 'Desktop Chrome',
    grep: 'sole writer|fair delivery|refresh|remount',
    expectedTestCount: EXPECTED_TEST_COUNT,
    sourceHashes,
  };
  const rawEvidence = {
    schemaVersion: '1.2.0',
    requirementIds: ['FR-BGSTAB-022', 'REL-BGSTAB-007', 'PERF-BGSTAB-010'],
    capturedAt: new Date().toISOString(),
    command: 'npx playwright test tests/e2e/wave3-terminal-authority-fairness.spec.ts --project "Desktop Chrome"',
    cwd: 'frontend',
    origin: 'https://localhost:2222',
    project: 'Desktop Chrome',
    inputHash: sha256Json(evidenceInput),
    cases: evidenceCases,
  };
  writeFileSync(RAW_EVIDENCE_PATH, `${JSON.stringify(rawEvidence, null, 2)}\n`, 'utf8');
  const allAdapterOperationsPresent = rawMutationInventory.adapterOperations.every(item => item.present);
  const capabilityAdvertisedInactive = (
    wireCheckpointCapability?.status === 'advertised-inactive'
    && wireCheckpointCapability?.checkpointDeliveryActive === false
    && wireCheckpointCapability?.authorityMode === 'legacy'
    && wireCheckpointCapability?.ackRejectionReason === 'invalid-message'
  );
  const runtimeCapabilityUnavailable = (
    wireCheckpointCapability?.status === 'unavailable-no-response'
    && wireCheckpointCapability?.checkpointDeliveryActive === null
    && wireCheckpointCapability?.ackRejectionReason === 'not-sent-without-capability'
  );
  const capabilityBlocksActivation = capabilityAdvertisedInactive || runtimeCapabilityUnavailable;
  const mockedActiveBrowserPathVerified = (
    mockedActiveEvidence?.verified === true
    && mockedActiveEvidence?.legacyServerForwardedControlledFrames === false
    && mockedActiveEvidence?.legacyAuthorityRequestsForwardedToServer === false
    && mockedActiveEvidence?.legacyAuthorityFramesForwardedToBrowser === false
    && mockedActiveEvidence?.applyAckSnapshotSeq === '9000'
    && mockedActiveEvidence?.drainAckSourceSeq === '9001'
    && mockedActiveEvidence?.pendingInputSentBeforeDrain === 0
    && mockedActiveEvidence?.pendingInputReleasedAfterDrain === 1
  );
  const rollbackEventBoundary = Number(rollbackEvidence?.compatibilityEventBoundary ?? 0);
  const rollbackSnapshotAckEventId = Number(rollbackEvidence?.compatibilitySnapshotAckEventId ?? 0);
  const rollbackDrainEventId = Number(rollbackEvidence?.compatibilityDrainEventId ?? 0);
  const rollbackPostAckOutputEventId = Number(rollbackEvidence?.postAckOutputReceivedEventId ?? 0);
  const rollbackConvergenceStateEventId = Number(
    rollbackEvidence?.compatibilityConvergenceStateEventId ?? 0,
  );
  const rollbackConvergenceEventId = Number(rollbackEvidence?.compatibilityConvergenceEventId ?? 0);
  const rollbackInputReadyEventId = Number(rollbackEvidence?.legacyInputReadyEventId ?? 0);
  const rollbackIdentityTuples = rollbackEvidence?.compatibilityEventIdentityTuples as
    | Record<string, Record<string, unknown>>
    | undefined;
  const rollbackIdentityProofs = rollbackEvidence?.compatibilityIdentityProofs as
    | Record<string, unknown>
    | undefined;
  const drainIdentity = rollbackIdentityTuples?.drain;
  const ackIdentity = rollbackIdentityTuples?.ack;
  const postAckOutputIdentity = rollbackIdentityTuples?.postAckOutput;
  const convergenceStateIdentity = rollbackIdentityTuples?.convergenceState;
  const convergenceIdentity = rollbackIdentityTuples?.convergence;
  const readyIdentity = rollbackIdentityTuples?.ready;
  const rollbackSessionHashes = [
    drainIdentity?.sessionHash,
    ackIdentity?.sessionHash,
    ackIdentity?.debugSessionHash,
    postAckOutputIdentity?.sessionHash,
    postAckOutputIdentity?.wireSessionHash,
    convergenceStateIdentity?.sessionHash,
    convergenceIdentity?.sessionHash,
    readyIdentity?.sessionHash,
  ];
  const rollbackReplayTokens = [
    ackIdentity?.replayToken,
    postAckOutputIdentity?.replayToken,
    postAckOutputIdentity?.wireReplayToken,
    convergenceStateIdentity?.replayToken,
    convergenceIdentity?.replayToken,
  ];
  const rollbackSnapshotSeqs = [
    ackIdentity?.snapshotSeq,
    postAckOutputIdentity?.snapshotSeq,
    convergenceStateIdentity?.snapshotSeq,
    convergenceIdentity?.snapshotSeq,
  ].map(Number);
  const rollbackConnectionGenerations = [
    ackIdentity?.connectionGeneration,
    postAckOutputIdentity?.connectionGeneration,
    postAckOutputIdentity?.wireConnectionGeneration,
    convergenceStateIdentity?.connectionGeneration,
    convergenceIdentity?.connectionGeneration,
  ].map(Number);
  const rollbackViewGenerations = [
    drainIdentity?.viewGeneration,
    postAckOutputIdentity?.viewGeneration,
    convergenceStateIdentity?.viewGeneration,
    convergenceIdentity?.viewGeneration,
  ].map(Number);
  const derivedSameSession = rollbackSessionHashes.every(value => (
    typeof value === 'string'
    && /^[0-9a-f]{64}$/u.test(value)
    && value === rollbackSessionHashes[0]
  ));
  const derivedSameReplayToken = rollbackReplayTokens.every(value => (
    typeof value === 'string'
    && value.length > 0
    && value === rollbackEvidence?.compatibilitySnapshotReplayToken
  ));
  const compatibilitySnapshotSeq = Number(rollbackEvidence?.compatibilitySnapshotSeq ?? 0);
  const compatibilityConnectionGeneration = Number(
    rollbackEvidence?.compatibilitySnapshotGeneration ?? 0,
  );
  const compatibilityViewGeneration = Number(
    rollbackEvidence?.compatibilitySnapshotViewGeneration ?? 0,
  );
  const derivedSameSnapshotSeq = Number.isSafeInteger(compatibilitySnapshotSeq)
    && compatibilitySnapshotSeq > 0
    && rollbackSnapshotSeqs.every(value => value === compatibilitySnapshotSeq);
  const derivedSameConnectionGeneration = Number.isSafeInteger(compatibilityConnectionGeneration)
    && compatibilityConnectionGeneration > 0
    && rollbackConnectionGenerations.every(value => value === compatibilityConnectionGeneration);
  const derivedSameViewGeneration = Number.isSafeInteger(compatibilityViewGeneration)
    && compatibilityViewGeneration > 0
    && rollbackViewGenerations.every(value => value === compatibilityViewGeneration);
  const rollbackIdentityVerified = (
    rollbackIdentityProofs?.sameSession === derivedSameSession
    && rollbackIdentityProofs?.sameReplayToken === derivedSameReplayToken
    && rollbackIdentityProofs?.sameSnapshotSeq === derivedSameSnapshotSeq
    && rollbackIdentityProofs?.sameConnectionGeneration === derivedSameConnectionGeneration
    && rollbackIdentityProofs?.sameViewGeneration === derivedSameViewGeneration
    && derivedSameSession
    && derivedSameReplayToken
    && derivedSameSnapshotSeq
    && derivedSameConnectionGeneration
    && derivedSameViewGeneration
    && Number(drainIdentity?.eventId ?? 0) === rollbackDrainEventId
    && Number(ackIdentity?.eventId ?? 0) === rollbackSnapshotAckEventId
    && Number(postAckOutputIdentity?.eventId ?? 0) === rollbackPostAckOutputEventId
    && Number(convergenceStateIdentity?.eventId ?? 0) === rollbackConvergenceStateEventId
    && Number(convergenceIdentity?.eventId ?? 0) === rollbackConvergenceEventId
    && Number(readyIdentity?.eventId ?? 0) === rollbackInputReadyEventId
    && Number(postAckOutputIdentity?.screenSeq ?? 0)
      === Number(rollbackEvidence?.postAckOutputScreenSeq ?? 0)
    && Number(postAckOutputIdentity?.wireScreenSeq ?? 0)
      === Number(rollbackEvidence?.postAckOutputScreenSeq ?? 0)
    && Number(rollbackEvidence?.postAckOutputScreenSeq ?? 0) > compatibilitySnapshotSeq
  );
  const rollbackEventOrderingVerified = (
    Number.isSafeInteger(rollbackEventBoundary)
    && Number.isSafeInteger(rollbackSnapshotAckEventId)
    && Number.isSafeInteger(rollbackDrainEventId)
    && Number.isSafeInteger(rollbackPostAckOutputEventId)
    && Number.isSafeInteger(rollbackConvergenceStateEventId)
    && Number.isSafeInteger(rollbackConvergenceEventId)
    && Number.isSafeInteger(rollbackInputReadyEventId)
    && rollbackEventBoundary >= 0
    && rollbackEvidence?.compatibilitySnapshotAckEventCount === 1
    && rollbackEvidence?.compatibilityDrainEventCount === 1
    && rollbackEvidence?.postAckOutputReceivedEventCount === 1
    && rollbackEvidence?.compatibilityConvergenceStateEventCount === 1
    && rollbackEvidence?.compatibilityConvergenceEventCount === 1
    && rollbackEvidence?.legacyInputReadyEventCount === 1
    && rollbackDrainEventId > rollbackEventBoundary
    && rollbackSnapshotAckEventId > rollbackDrainEventId
    && rollbackPostAckOutputEventId > rollbackSnapshotAckEventId
    && rollbackConvergenceStateEventId > rollbackPostAckOutputEventId
    && rollbackConvergenceEventId > rollbackConvergenceStateEventId
    && rollbackInputReadyEventId > rollbackConvergenceEventId
  );
  const checkpointRollbackVerified = (
    rollbackEvidence?.verified === true
    && rollbackEvidence?.checkpointCompletedBeforeRollback === true
    && rollbackEvidence?.rollbackInputSentToServer === 0
    && rollbackEvidence?.rollbackInputSettlementCount === 1
    && rollbackEvidence?.rollbackInputSettlementOutcome === 'superseded'
    && rollbackEvidence?.rollbackSettlementPayloadFree === true
    && rollbackEvidence?.legacyRecoveryPendingObserved === true
    && rollbackEvidence?.preSnapshotInputSentToServer === 0
    && rollbackEvidence?.preConvergenceInputSentToServer === 0
    && rollbackEvidence?.freshCompatibilitySnapshotApplied === true
    && rollbackEvidence?.heldLegacyOutputDrainedBeforeInputReady === true
    && rollbackEventOrderingVerified
    && rollbackIdentityVerified
    && rollbackEvidence?.postSnapshotLegacyOutputApplied === true
    && rollbackEvidence?.staleOldGenerationFenceUnitVerified === true
    && rollbackEvidence?.legacyInputAdmittedAfterRollback === 1
  );
  const eligible = evidenceCases.length === EXPECTED_TEST_COUNT
    && failed === 0
    && rawMutationInventory.rawMutationFindings.length === 0
    && rawMutationInventory.rawAdapterImportFindings.length === 0
    && allAdapterOperationsPresent
    && !capabilityBlocksActivation;
  const inventory = {
    schemaVersion: '1.2.0',
    requirementIds: ['FR-BGSTAB-022', 'REL-BGSTAB-007', 'PERF-BGSTAB-010'],
    generatedAt: new Date().toISOString(),
    sourceHashes,
    config: {
      origin: 'https://localhost:2222',
      project: 'Desktop Chrome',
      exactCommand: rawEvidence.command,
      inputHash: rawEvidence.inputHash,
      playwrightConfigHash: sourceHashes['frontend/playwright.config.ts'],
    },
    soleWriterInventory: {
      scannedRoot: 'frontend/src',
      analysisMode: rawMutationInventory.analysisMode,
      allowedRawMutationAdapter: 'frontend/src/utils/terminalRawMutationAdapter.ts',
      allowedRawMutationAdapterImporter: 'frontend/src/utils/terminalWriteCoordinatorRuntime.ts',
      rawMutationFindingsOutsideAdapter: rawMutationInventory.rawMutationFindings,
      rawMutationFindingCount: rawMutationInventory.rawMutationFindings.length,
      rawAdapterImportFindingsOutsideCoordinator: rawMutationInventory.rawAdapterImportFindings,
      rawAdapterImportFindingCount: rawMutationInventory.rawAdapterImportFindings.length,
      adapterOperations: rawMutationInventory.adapterOperations,
    },
    e2e: {
      rawEvidencePath: relative(REPOSITORY_ROOT, RAW_EVIDENCE_PATH).replaceAll('\\', '/'),
      rawEvidenceSha256: sha256File(RAW_EVIDENCE_PATH),
      expected: EXPECTED_TEST_COUNT,
      executed: evidenceCases.length,
      passed,
      failed,
    },
    capability: {
      terminalCheckpointWire: runtimeCapabilityUnavailable
        ? 'runtime-unavailable-no-response'
        : capabilityAdvertisedInactive
          ? 'advertised-inactive'
          : 'unknown-or-active',
      observed: wireCheckpointCapability ?? null,
      browserCoordinatorFaultHarness: 'active-production-module',
      mockedActiveBrowserIngress: mockedActiveBrowserPathVerified
        ? 'verified-test-controlled-active-checkpoint-server'
        : 'not-verified',
      mockedActiveBrowserEvidence: mockedActiveEvidence ?? null,
      checkpointCapabilityRollback: checkpointRollbackVerified
        ? 'verified-active-to-passive-clean-legacy-transition'
        : 'not-verified',
      checkpointCapabilityRollbackEvidence: rollbackEvidence ?? null,
      wireCheckpointImplementationEvidence: runtimeCapabilityUnavailable
        ? 'runtime-server-not-verified-browser-ingress-verified-with-test-controlled-active-server'
        : capabilityAdvertisedInactive
          ? 'runtime-server-advertised-inactive-browser-ingress-verified-with-test-controlled-active-server'
          : 'unknown',
    },
    activation: {
      eligible,
      mockedActiveBrowserPathVerified,
      checkpointRollbackVerified,
      runtimeServerActivationVerified: false,
      verdict: eligible
        ? 'PASS_ACTIVE_CAPABILITY'
        : runtimeCapabilityUnavailable && failed === 0
          ? 'REJECTED_RUNTIME_CAPABILITY_UNAVAILABLE_FAIL_CLOSED_OBSERVED'
          : capabilityAdvertisedInactive && failed === 0
            ? 'REJECTED_CAPABILITY_ADVERTISED_INACTIVE_FAIL_CLOSED_OBSERVED'
          : 'REJECTED_EVIDENCE_OR_INVENTORY_FAILURE',
      reason: runtimeCapabilityUnavailable
        ? 'runtime terminal-checkpoint negotiation returned no capability; ACK was not sent and activation is explicitly rejected'
        : capabilityAdvertisedInactive
          ? 'terminal-checkpoint capability reports checkpointDeliveryActive=false and ACK is rejected; activation remains explicitly rejected'
        : failed > 0
          ? 'one or more HTTPS E2E cases failed'
          : rawMutationInventory.rawMutationFindings.length > 0
            ? 'raw terminal mutations remain outside the sole-writer adapter'
            : rawMutationInventory.rawAdapterImportFindings.length > 0
              ? 'production modules import the raw mutation adapter outside the coordinator boundary'
            : 'wire capability status was not proven',
    },
  };
  writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  if (
    evidenceCases.length !== EXPECTED_TEST_COUNT
    || rawMutationInventory.rawMutationFindings.length !== 0
    || rawMutationInventory.rawAdapterImportFindings.length !== 0
    || !allAdapterOperationsPresent
    || !capabilityBlocksActivation
    || !mockedActiveBrowserPathVerified
    || !checkpointRollbackVerified
  ) {
    throw new Error(`PH-003 evidence guard rejected: ${JSON.stringify({
      executed: evidenceCases.length,
      expected: EXPECTED_TEST_COUNT,
      rawMutationFindings: rawMutationInventory.rawMutationFindings.length,
      rawAdapterImportFindings: rawMutationInventory.rawAdapterImportFindings.length,
      allAdapterOperationsPresent,
      capabilityAdvertisedInactive,
      runtimeCapabilityUnavailable,
      mockedActiveBrowserPathVerified,
      checkpointRollbackVerified,
    })}`);
  }
}

test.describe('FR-BGSTAB-022 sole writer HTTPS authority evidence', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(({ browserName }, testInfo) => {
    void browserName;
    testStartedAt.set(testInfo.title, Date.now());
  });

  test.afterEach(async ({ browserName }, testInfo) => {
    void browserName;
    const record: CaseRecord = {
      title: testInfo.title,
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      durationMs: Math.max(0, Date.now() - (testStartedAt.get(testInfo.title) ?? Date.now())),
      errors: testInfo.errors.map(error => error.message ?? String(error)),
      evidence: caseEvidence.get(testInfo.title) ?? null,
    };
    caseRecords.push(record);
    mkdirSync(CASE_FRAGMENT_ROOT, { recursive: true });
    writeFileSync(
      resolve(CASE_FRAGMENT_ROOT, `${sha256Json(testInfo.title)}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    await testInfo.attach('wave3-sole-writer-case-evidence', {
      body: Buffer.from(JSON.stringify(record, null, 2), 'utf8'),
      contentType: 'application/json',
    });
  });

  test.afterAll(() => {
    writeEvidenceArtifacts();
  });

  test('sole writer refresh — no-cache hard refresh restores the same live session', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    await installNoTerminalSnapshotCache(page);
    await login(page);
    const ownedWorkspace = await createWave3PowerShellWorkspace(page);
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
    expect(sessionId).toBe(ownedWorkspace.sessionId);
    const initial = await waitForSnapshot(harness, sessionId!);
    await page.evaluate((id) => localStorage.removeItem(`terminal_snapshot_${id}`), sessionId!);
    const marker = `W3-SOLE-WRITER-REFRESH-${Date.now()}`;
    await sendVisibleTerminalCommand(page, sessionId!, `Write-Output "${marker}"`);
    await waitForCommandCompletion(page, sessionId!, marker);

    const connectionsBeforeReload = harness.connectionCount;
    await page.reload();
    await waitForTerminal(page);
    const sessionIdAfterReload = await getActiveSessionId(page);
    expect(sessionIdAfterReload).toBe(sessionId);
    await expect.poll(() => harness.connectionCount, {
      message: 'hard refresh did not establish a replacement WebSocket generation',
      timeout: 15_000,
    }).toBeGreaterThan(connectionsBeforeReload);
    const refreshed = await waitForSnapshot(harness, sessionId!, initial.generation + 1);
    const refreshedRuntime = await getSessionTerminalRuntime(page, sessionId!);
    await expect(refreshedRuntime.locator('.xterm-rows')).toContainText(marker, {
      timeout: 20_000,
    });
    const browserState = await refreshedRuntime.evaluate((runtime, id) => {
      const helper = runtime.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
      return {
        terminalSnapshotPresent: localStorage.getItem(`terminal_snapshot_${id}`) !== null,
        helperDisabled: helper?.disabled ?? null,
        helperReadOnly: helper?.readOnly ?? null,
      };
    }, sessionId!);
    expect(browserState).toEqual({
      terminalSnapshotPresent: false,
      helperDisabled: false,
      helperReadOnly: false,
    });
    rememberEvidence(testInfo, {
      execution: 'live-https-hard-refresh',
      origin: new URL(page.url()).origin,
      sessionIdStable: sessionIdAfterReload === sessionId,
      localSnapshotBlocked: browserState.terminalSnapshotPresent === false,
      markerRestored: true,
      initialWebSocketGeneration: initial.generation,
      refreshedWebSocketGeneration: refreshed.generation,
      inputSurfaceReady: browserState.helperDisabled === false && browserState.helperReadOnly === false,
    });
    await deleteWave3Workspace(page, ownedWorkspace.workspaceId);
  });

  test('sole writer remount — stale snapshot and early-ready frames stay fenced after same-socket runtime eviction', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    await installBoundedRuntimeResidencyForRemount(page);
    await login(page);
    const ownedWorkspace = await createWave3PowerShellWorkspace(page);
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
    expect(sessionId, 'E2E remount scenario did not select its isolated terminal').toBe(ownedWorkspace.sessionId);
    const old = await waitForSnapshot(harness, sessionId!);
    const oldReplayToken = String(old.snapshot.replayToken ?? '');
    expect(oldReplayToken.length, 'E2E precondition failed: old replay token is missing').toBeGreaterThan(0);
    await startDebugCapture(page, sessionId!);
    const oldRuntime = await (await getSessionTerminalRuntime(page, sessionId!)).elementHandle();
    expect(oldRuntime, 'E2E precondition failed: visible runtime element is unavailable').not.toBeNull();
    await oldRuntime!.evaluate(element => element.setAttribute('data-wave3-old-runtime', 'true'));
    const connectionsBeforeRemount = harness.connectionCount;
    let context: RuntimeRemountContext | null = null;
    try {
      context = await hideRuntimeBehindTemporaryTab(page, sessionId!);
      await expect.poll(() => getActiveSessionId(page), {
        message: 'temporary tab did not become active',
        timeout: 15_000,
      }).toBe(context.temporarySessionId);
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).some(event => event.kind === 'terminal_disposed'), {
        message: 'bounded runtime residency did not dispose the hidden xterm runtime',
        timeout: 10_000,
      }).toBe(true);
      await expect.poll(() => oldRuntime!.evaluate(element => element.isConnected), {
        message: 'old runtime DOM remained connected after residency eviction',
        timeout: 5_000,
      }).toBe(false);
      const remountEventBoundary = Math.max(
        0,
        ...(await readDebugEvents(page, sessionId!)).map(event => Number(event.eventId ?? 0)),
      );

      await reactivateOriginalRuntime(page, context);
      await expect.poll(() => getActiveSessionId(page), {
        message: 'original session did not reactivate after runtime eviction',
        timeout: 15_000,
      }).toBe(sessionId);
      await waitForTerminal(page);
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).some(event => (
        Number(event.eventId ?? 0) > remountEventBoundary
        && event.kind === 'terminal_mounted'
      )), {
        message: 'same-session xterm runtime was not remounted',
        timeout: 10_000,
      }).toBe(true);
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).some(event => (
        Number(event.eventId ?? 0) > remountEventBoundary
        && event.kind === 'input_gate_synced'
        && event.details?.captureState === 'open'
        && event.details?.inputReady === true
      )), {
        message: 'replacement xterm runtime did not converge before fault injection',
        timeout: 10_000,
      }).toBe(true);
      await expect(page.locator('.terminal-view:visible').first()).not.toHaveAttribute(
        'data-wave3-old-runtime',
        'true',
      );
      expect(harness.connectionCount, 'runtime remount unexpectedly replaced the WebSocket').toBe(
        connectionsBeforeRemount,
      );
      const websocketReusedBeforeFaultInjection = harness.connectionCount === connectionsBeforeRemount;

      const snapshotSeq = Number(old.snapshot.seq ?? 0) + 10;
      const currentReplayToken = `w3-current-${Date.now()}`;
      const currentRepairToken = `w3-repair-${Date.now()}`;
      const authorityEpoch = `w3-e2e-epoch-${Date.now()}`;
      const oldReadyAckCountBeforeInjection = harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.generation === old.generation
        && frame.message?.type === 'screen-snapshot:ready'
        && frame.message.replayToken === oldReplayToken
      )).length;
      harness.injectToPage(old.generation, validRestoreNeeded(
        sessionId!,
        currentReplayToken,
        currentRepairToken,
        snapshotSeq,
        authorityEpoch,
      ));
      harness.injectToPage(old.generation, {
        ...old.snapshot,
        type: 'screen-snapshot',
        sessionId,
        replayToken: oldReplayToken,
        repairToken: `old-${currentRepairToken}`,
        seq: snapshotSeq - 1,
        authorityEpoch: `old-${authorityEpoch}`,
        authorityRevision: snapshotSeq - 1,
        coversThroughSeq: snapshotSeq - 1,
        parserComplete: true,
        pendingEscapeTailAnsi: '',
      });
      harness.injectToPage(old.generation, {
        type: 'session:ready',
        sessionId,
        replayToken: oldReplayToken,
        repairToken: `old-${currentRepairToken}`,
        snapshotSeq: snapshotSeq - 1,
      });

      let events = await readDebugEvents(page, sessionId!);
      try {
        await expect.poll(async () => {
          events = await readDebugEvents(page, sessionId!);
          const currentTransaction = events.some(event => (
            event.kind === 'visible_output_resync_state'
            && event.details?.replayToken === currentReplayToken
            && event.details?.repairToken === currentRepairToken
          ));
          const staleSnapshotFenced = events.some(event => (
            event.kind === 'visible_output_resync_snapshot_authority_proof_mismatch'
            && event.details?.expectedSnapshotSeq === snapshotSeq
            && event.details?.receivedSnapshotSeq === snapshotSeq - 1
          ));
          return currentTransaction && staleSnapshotFenced;
        }, {
          message: 'same-session remount did not expose both current and stale fenced transactions',
          timeout: 10_000,
        }).toBe(true);
      } catch (error) {
        events = await readDebugEvents(page, sessionId!);
        const injectedFrames = harness.frames.filter(frame => (
          frame.direction === 'server-to-page'
          && frame.generation === old.generation
          && ['screen-repair:restore-needed', 'screen-snapshot', 'session:ready'].includes(
            String(frame.message?.type),
          )
        )).slice(-10);
        const recoveryEvents = events.filter(event => (
          event.kind.includes('visible_output_resync')
          || event.kind.includes('screen_repair')
        )).slice(-30);
        throw new Error(`same-session remount fence diagnostics: ${JSON.stringify({
          injectedFrames,
          recoveryEvents,
          recentEvents: events.slice(-30),
        })}`, {
          cause: error,
        });
      }
      const currentState = [...events].reverse().find(event => (
        event.kind === 'visible_output_resync_state'
        && event.details?.replayToken === currentReplayToken
        && event.details?.repairToken === currentRepairToken
      ));
      const staleEvent = [...events].reverse().find(event => (
        event.kind === 'visible_output_resync_snapshot_authority_proof_mismatch'
        && event.details?.expectedSnapshotSeq === snapshotSeq
        && event.details?.receivedSnapshotSeq === snapshotSeq - 1
      ));
      const oldReadyAckCountAfterInjection = harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.generation === old.generation
        && frame.message?.type === 'screen-snapshot:ready'
        && frame.message.replayToken === oldReplayToken
      )).length;
      const oldReadyAckSent = oldReadyAckCountAfterInjection > oldReadyAckCountBeforeInjection;
      expect({
        staleIgnored: Boolean(staleEvent),
        currentTransactionReady: currentState?.details?.currentViewTransactionReady,
        retainedHistoryEquivalent: currentState?.details?.retainedHistoryEquivalent,
        oldReadyAckSent,
        viewGenerationType: typeof currentState?.details?.viewGeneration,
        xtermGenerationType: typeof currentState?.details?.xtermGeneration,
      }).toEqual({
        staleIgnored: true,
        currentTransactionReady: false,
        retainedHistoryEquivalent: false,
        oldReadyAckSent: false,
        viewGenerationType: 'number',
        xtermGenerationType: 'number',
      });
      rememberEvidence(testInfo, {
        execution: 'live-https-bounded-residency-same-socket-runtime-remount',
        oldWebSocketGeneration: old.generation,
        currentWebSocketGeneration: old.generation,
        websocketReused: websocketReusedBeforeFaultInjection,
        oldRuntimeDisposed: true,
        replacementRuntimeMounted: true,
        staleSnapshotIgnored: true,
        oldReadyAckSent,
        currentTransactionReady: currentState?.details?.currentViewTransactionReady ?? null,
        staleEventKind: staleEvent?.kind ?? null,
      });
    } finally {
      if (context) await cleanupRuntimeRemountContext(page, context);
      await deleteWave3Workspace(page, ownedWorkspace.workspaceId);
    }
  });

  test('sole writer active checkpoint — mocked server ingress applies and ACKs before one input release', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    const unblockLegacyCheckpointServer = harness.blockServerToPage(message => (
      typeof message.type === 'string' && message.type.startsWith('terminal-checkpoint:')
    ));
    await login(page);
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
    const registration = await waitForCheckpointViewRegistration(harness, sessionId!);
    const targetRuntime = await getSessionTerminalRuntime(page, sessionId!);
    const baseline = await waitForSnapshot(harness, sessionId!);
    await expect.poll(() => harness.frames.some(frame => (
      frame.direction === 'page-to-server'
      && frame.generation === baseline.generation
      && frame.message?.type === 'screen-snapshot:ready'
      && frame.message.sessionId === sessionId
      && frame.message.replayToken === baseline.snapshot.replayToken
    )), {
      message: 'legacy baseline snapshot did not settle before mocked checkpoint authority activation',
      timeout: 10_000,
    }).toBe(true);
    const settledHelper = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
    await expect(settledHelper).toBeEnabled({ timeout: 10_000 });
    const unblockLegacyAuthorityServer = harness.blockServerToPage(message => (
      message.type === 'output'
      || message.type === 'screen-snapshot'
      || (typeof message.type === 'string' && message.type.startsWith('screen-repair'))
    ));
    await startDebugCapture(page, sessionId!);

    const controlledTypes = new Set([
      'terminal-checkpoint:apply-ack',
      'terminal-checkpoint:drain-ack',
      'terminal-checkpoint:failure-ack',
    ]);
    const unblockControlledServer = harness.blockPageToServer(message => (
      controlledTypes.has(String(message.type))
      || (message.type === 'input' && message.sessionId === sessionId)
      || (message.type === 'screen-repair' && message.sessionId === sessionId)
    ));
    try {
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:capability',
        protocolVersion: 1,
        accepted: true,
        authorityMode: 'checkpoint',
        checkpointDeliveryActive: true,
        ordinalEncoding: 'canonical-uint64-decimal',
        digestAlgorithms: ['sha256'],
        registeredViews: [{
          sessionId,
          viewGeneration: registration.viewGeneration,
        }],
        mutationLeases: [{
          sessionId,
          authorityEpoch: 'w3-e2e-active-authority',
          viewGeneration: registration.viewGeneration,
          leaseGeneration: '1',
        }],
      });

      const bodyMarker = `W3-ACTIVE-BODY-${Date.now()}`;
      const tailMarker = `W3-ACTIVE-TAIL-${Date.now()}`;
      const checkpointBody = `\u001b[2J\u001b[H${bodyMarker}\r\n`;
      const parserTail = '\u001b[';
      const outputTail = `32m${tailMarker}\u001b[0m\r\n`;
      const identity = {
        protocolVersion: 1,
        sessionId,
        viewGeneration: registration.viewGeneration,
        streamEpoch: '700',
        checkpointEpoch: '1',
        sourceSeq: '9001',
        snapshotSeq: '9000',
        oldestRetainedSeq: '9000',
        retentionPolicyId: 'w3-e2e-mocked-active-retained-v1',
      };
      const bodyPayload = checkpointPayload(checkpointBody);
      const bodyDigest = checkpointSha256(checkpointBody);
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:start',
        ...identity,
        sourceGeometry: { cols: 120, rows: 40 },
        chunkCount: 1,
        encodedByteTotal: bodyPayload.encodedBytes,
        digest: bodyDigest,
        modes: {
          applicationCursorKeysMode: true,
          bracketedPasteMode: true,
          wraparoundMode: true,
        },
        parserTail: checkpointPayload(parserTail),
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:chunk',
        ...identity,
        ...bodyPayload,
        chunkIndex: 0,
        chunkCount: 1,
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:commit',
        ...identity,
        chunkCount: 1,
        encodedByteTotal: bodyPayload.encodedBytes,
        digest: bodyDigest,
      });

      const pendingInput = 'q';
      const sessionInputsBeforePending = harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
      )).length;
      const helper = targetRuntime.locator('.xterm-helper-textarea');
      await helper.focus();
      await page.keyboard.type(pendingInput, { delay: 0 });
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).filter(event => event.kind === 'terminal_checkpoint_input_queued').length, {
        message: 'actual xterm input was not queued behind the checkpoint barrier',
        timeout: 5_000,
      }).toBe(1);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
      )).length).toBe(sessionInputsBeforePending);

      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:output',
        ...identity,
        ...checkpointPayload(outputTail),
      });
      await expect.poll(() => harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.generation === registration.generation
        && frame.message?.type === 'terminal-checkpoint:apply-ack'
        && frame.message.sessionId === sessionId
      )).length, {
        message: 'mocked active server did not receive the apply ACK',
        timeout: 10_000,
      }).toBe(1);
      await expect.poll(() => harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.generation === registration.generation
        && frame.message?.type === 'terminal-checkpoint:drain-ack'
        && frame.message.sessionId === sessionId
      )).length, {
        message: 'mocked active server did not receive the drain ACK',
        timeout: 10_000,
      }).toBe(1);
      await expect.poll(() => harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === pendingInput
      )).length, {
        message: 'queued xterm input was not released exactly once after checkpoint drain',
        timeout: 10_000,
      }).toBe(1);
      await page.waitForTimeout(200);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === pendingInput
      ))).toHaveLength(1);

      const applyAck = harness.latest(
        'page-to-server',
        message => message.type === 'terminal-checkpoint:apply-ack' && message.sessionId === sessionId,
        registration.generation,
      );
      const drainAck = harness.latest(
        'page-to-server',
        message => message.type === 'terminal-checkpoint:drain-ack' && message.sessionId === sessionId,
        registration.generation,
      );
      expect(applyAck).toMatchObject({
        ...identity,
        appliedThroughSeq: identity.snapshotSeq,
      });
      expect(drainAck).toMatchObject({
        ...identity,
        drainedThroughSeq: identity.sourceSeq,
      });
      const applyIndex = harness.frames.findIndex(frame => frame.message === applyAck);
      const drainIndex = harness.frames.findIndex(frame => frame.message === drainAck);
      const releasedInputIndex = harness.frames.findIndex(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === pendingInput
      ));
      expect(applyIndex).toBeGreaterThan(-1);
      expect(drainIndex).toBeGreaterThan(applyIndex);
      expect(releasedInputIndex).toBeGreaterThan(drainIndex);

      const rows = targetRuntime.locator('.xterm-rows');
      try {
        await expect(rows).toContainText(bodyMarker, { timeout: 10_000 });
        await expect(rows).toContainText(tailMarker, { timeout: 10_000 });
      } catch (error) {
        const recentEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
          event.kind.includes('terminal_checkpoint')
          || event.kind.includes('terminal_write_coordinator')
        )).slice(-40);
        throw new Error(`checkpoint render diagnostics: ${JSON.stringify({ recentEvents })}`, {
          cause: error,
        });
      }
      await expect(rows).not.toContainText(`32m${tailMarker}`);

      const modeProbeIndex = harness.frames.length;
      await helper.focus();
      await expect(helper).toBeFocused();
      await page.keyboard.press('ArrowUp');
      try {
        await expect.poll(() => harness.frames.slice(modeProbeIndex).filter(frame => (
          frame.direction === 'page-to-server'
          && frame.message?.type === 'input'
          && frame.message.sessionId === sessionId
        )).map(frame => frame.message?.data), {
          message: 'application cursor-key mode was not rehydrated before the checkpoint body',
          timeout: 5_000,
        }).toEqual(['\u001bOA']);
      } catch (error) {
        const helperState = await helper.evaluate(element => ({
          disabled: element.disabled,
          readOnly: element.readOnly,
          active: document.activeElement === element,
        }));
        const recentEvents = (await readDebugEvents(page, sessionId!)).slice(-20);
        throw new Error(`mode probe diagnostics: ${JSON.stringify({ helperState, recentEvents })}`, {
          cause: error,
        });
      }

      const blockedControlledFrames = harness.blockedPageToServerFrames.filter(frame => (
        frame.generation === registration.generation
        && (
          controlledTypes.has(String(frame.message?.type))
          || (frame.message?.type === 'input' && frame.message.sessionId === sessionId)
        )
      ));
      expect(blockedControlledFrames).toHaveLength(4);
      rememberEvidence(testInfo, {
        execution: 'live-https-test-controlled-active-checkpoint-server',
        mockedActiveCheckpointServer: {
          verified: true,
          legacyServerForwardedControlledFrames: false,
          legacyAuthorityRequestsForwardedToServer: false,
          capability: 'checkpoint-active-test-controlled',
          connectionGeneration: registration.generation,
          viewGeneration: registration.viewGeneration,
          bodyApplied: true,
          modesApplied: true,
          parserTailAndOutputAppliedInOrder: true,
          applyAckSnapshotSeq: applyAck?.appliedThroughSeq ?? null,
          drainAckSourceSeq: drainAck?.drainedThroughSeq ?? null,
          pendingInputSentBeforeDrain: 0,
          pendingInputReleasedAfterDrain: 1,
          controlledFrameCount: blockedControlledFrames.length,
          blockedLegacyRepairRequestCount: harness.blockedPageToServerFrames.filter(frame => (
            frame.generation === registration.generation
            && frame.message?.type === 'screen-repair'
            && frame.message.sessionId === sessionId
          )).length,
          blockedLegacyCheckpointResponseCount: harness.blockedServerToPageFrames.filter(frame => (
            typeof frame.message?.type === 'string'
            && frame.message.type.startsWith('terminal-checkpoint:')
          )).length,
          blockedLegacyOutputCount: harness.blockedServerToPageFrames.filter(
            frame => frame.message?.type === 'output',
          ).length,
          blockedLegacyReplayCount: harness.blockedServerToPageFrames.filter(frame => (
            frame.message?.type === 'output'
            && typeof frame.message.replayToken === 'string'
          )).length,
          blockedLegacySnapshotCount: harness.blockedServerToPageFrames.filter(
            frame => frame.message?.type === 'screen-snapshot',
          ).length,
          blockedLegacyRepairCount: harness.blockedServerToPageFrames.filter(frame => (
            typeof frame.message?.type === 'string'
            && frame.message.type.startsWith('screen-repair')
          )).length,
          legacyAuthorityFramesForwardedToBrowser: false,
        },
      });
    } finally {
      unblockControlledServer();
      unblockLegacyAuthorityServer();
      unblockLegacyCheckpointServer();
    }
  });

  test('sole writer rollback — passive capability restores a clean legacy snapshot generation', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    const unblockLegacyCheckpointServer = harness.blockServerToPage(message => (
      typeof message.type === 'string' && message.type.startsWith('terminal-checkpoint:')
    ));
    await login(page);
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
    const registration = await waitForCheckpointViewRegistration(harness, sessionId!);
    const baseline = await waitForSnapshot(harness, sessionId!);
    const targetRuntime = await getSessionTerminalRuntime(page, sessionId!);
    await expect.poll(() => harness.frames.some(frame => (
      frame.direction === 'page-to-server'
      && frame.generation === baseline.generation
      && frame.message?.type === 'screen-snapshot:ready'
      && frame.message.sessionId === sessionId
      && frame.message.replayToken === baseline.snapshot.replayToken
    )), {
      message: 'legacy baseline snapshot did not settle before rollback exercise',
      timeout: 10_000,
    }).toBe(true);
    const helper = targetRuntime.locator('.xterm-helper-textarea');
    await expect(helper).toBeEnabled({ timeout: 10_000 });

    const unblockLegacyAuthorityServer = harness.blockServerToPage(message => (
      message.type === 'output'
      || message.type === 'screen-snapshot'
      || (typeof message.type === 'string' && message.type.startsWith('screen-repair'))
    ));
    await startDebugCapture(page, sessionId!);
    const controlledTypes = new Set([
      'terminal-checkpoint:apply-ack',
      'terminal-checkpoint:drain-ack',
      'terminal-checkpoint:failure-ack',
      'screen-snapshot:ready',
    ]);
    const unblockControlledServer = harness.blockPageToServer(message => (
      controlledTypes.has(String(message.type))
      || (message.type === 'input' && message.sessionId === sessionId)
      || (message.type === 'screen-repair' && message.sessionId === sessionId)
    ));

    try {
      const activeCapability = {
        type: 'terminal-checkpoint:capability',
        protocolVersion: 1,
        accepted: true,
        authorityMode: 'checkpoint',
        checkpointDeliveryActive: true,
        ordinalEncoding: 'canonical-uint64-decimal',
        digestAlgorithms: ['sha256'],
        registeredViews: [{
          sessionId,
          viewGeneration: registration.viewGeneration,
        }],
        mutationLeases: [{
          sessionId,
          authorityEpoch: 'w3-e2e-rollback-authority',
          viewGeneration: registration.viewGeneration,
          leaseGeneration: '1',
        }],
      } satisfies JsonFrame;
      harness.injectToPage(registration.generation, activeCapability);

      const sourceGeometry = {
        cols: Number(baseline.snapshot.cols ?? 80),
        rows: Number(baseline.snapshot.rows ?? 24),
      };
      expect(Number.isSafeInteger(sourceGeometry.cols) && sourceGeometry.cols > 0).toBe(true);
      expect(Number.isSafeInteger(sourceGeometry.rows) && sourceGeometry.rows > 0).toBe(true);
      const activeMarker = `W3-ROLLBACK-ACTIVE-${Date.now()}`;
      const activeBody = `\u001b[2J\u001b[H${activeMarker}\r\n`;
      const activePayload = checkpointPayload(activeBody);
      const activeIdentity = {
        protocolVersion: 1,
        sessionId,
        viewGeneration: registration.viewGeneration,
        streamEpoch: '800',
        checkpointEpoch: '1',
        sourceSeq: '9100',
        snapshotSeq: '9100',
        oldestRetainedSeq: '9100',
        retentionPolicyId: 'w3-e2e-rollback-active-v1',
      };
      const activeDigest = checkpointSha256(activeBody);
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:start',
        ...activeIdentity,
        sourceGeometry,
        chunkCount: 1,
        encodedByteTotal: activePayload.encodedBytes,
        digest: activeDigest,
        modes: {
          applicationCursorKeysMode: false,
          bracketedPasteMode: false,
          wraparoundMode: true,
        },
        parserTail: checkpointPayload(''),
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:chunk',
        ...activeIdentity,
        ...activePayload,
        chunkIndex: 0,
        chunkCount: 1,
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:commit',
        ...activeIdentity,
        chunkCount: 1,
        encodedByteTotal: activePayload.encodedBytes,
        digest: activeDigest,
      });
      await expect.poll(() => ({
        apply: harness.frames.filter(frame => (
          frame.direction === 'page-to-server'
          && frame.message?.type === 'terminal-checkpoint:apply-ack'
          && frame.message.sessionId === sessionId
          && frame.message.checkpointEpoch === activeIdentity.checkpointEpoch
        )).length,
        drain: harness.frames.filter(frame => (
          frame.direction === 'page-to-server'
          && frame.message?.type === 'terminal-checkpoint:drain-ack'
          && frame.message.sessionId === sessionId
          && frame.message.checkpointEpoch === activeIdentity.checkpointEpoch
        )).length,
      }), {
        message: 'pre-rollback active checkpoint did not completely apply and drain',
        timeout: 10_000,
      }).toEqual({ apply: 1, drain: 1 });
      const rows = targetRuntime.locator('.xterm-rows');
      await expect(rows).toContainText(activeMarker, { timeout: 10_000 });

      const pendingMarker = `W3-ROLLBACK-PENDING-${Date.now()}`;
      const pendingBody = `\u001b[2J\u001b[H${pendingMarker}\r\n`;
      const pendingPayload = checkpointPayload(pendingBody);
      const pendingIdentity = {
        ...activeIdentity,
        checkpointEpoch: '2',
        sourceSeq: '9201',
        snapshotSeq: '9200',
        oldestRetainedSeq: '9200',
        retentionPolicyId: 'w3-e2e-rollback-pending-v1',
      };
      const pendingDigest = checkpointSha256(pendingBody);
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:start',
        ...pendingIdentity,
        sourceGeometry,
        chunkCount: 1,
        encodedByteTotal: pendingPayload.encodedBytes,
        digest: pendingDigest,
        modes: {
          applicationCursorKeysMode: true,
          bracketedPasteMode: true,
          wraparoundMode: true,
        },
        parserTail: checkpointPayload('\u001b['),
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:chunk',
        ...pendingIdentity,
        ...pendingPayload,
        chunkIndex: 0,
        chunkCount: 1,
      });
      harness.injectToPage(registration.generation, {
        type: 'terminal-checkpoint:commit',
        ...pendingIdentity,
        chunkCount: 1,
        encodedByteTotal: pendingPayload.encodedBytes,
        digest: pendingDigest,
      });
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'terminal-checkpoint:apply-ack'
        && frame.message.checkpointEpoch === pendingIdentity.checkpointEpoch
      ))).toHaveLength(0);

      const rollbackInput = '~';
      const inputFramesBeforeRollback = harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === rollbackInput
      )).length;
      await helper.focus();
      await page.keyboard.type(rollbackInput, { delay: 0 });
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).filter(event => event.kind === 'terminal_checkpoint_input_queued').length, {
        message: 'rollback input was not accepted behind the active checkpoint barrier',
        timeout: 5_000,
      }).toBe(1);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === rollbackInput
      ))).toHaveLength(inputFramesBeforeRollback);

      harness.injectToPage(registration.generation, {
        ...activeCapability,
        authorityMode: 'legacy',
        checkpointDeliveryActive: false,
        compatibilityRecoveryRole: 'passive-snapshot',
      });
      let rollbackSettlements: Awaited<ReturnType<typeof readDebugEvents>> = [];
      await expect.poll(async () => {
        rollbackSettlements = (await readDebugEvents(page, sessionId!)).filter(event => (
          event.kind === 'terminal_checkpoint_input_settled'
          && event.details?.outcome === 'superseded'
        ));
        return rollbackSettlements.length;
      }, {
        message: 'capability withdrawal did not settle the accepted input exactly once',
        timeout: 10_000,
      }).toBe(1);
      const rollbackSettlement = rollbackSettlements[0]!;
      expect(rollbackSettlement.details?.token).toBe(
        `${sessionId}:${registration.viewGeneration}:input:1`,
      );
      expect(JSON.stringify(rollbackSettlement.details)).not.toContain(rollbackInput);
      await expect.poll(async () => (
        await readDebugEvents(page, sessionId!)
      ).some(event => (
        event.kind === 'input_gate_synced'
        && event.details?.reason === 'terminal-authority-legacy-recovery-pending'
        && event.details?.inputReady === false
      )), {
        message: 'passive capability did not install the fail-closed legacy recovery barrier',
        timeout: 10_000,
      }).toBe(true);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === rollbackInput
      ))).toHaveLength(0);

      const preSnapshotInput = 'u';
      await helper.focus();
      await page.keyboard.type(preSnapshotInput, { delay: 0 });
      await page.waitForTimeout(100);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === preSnapshotInput
      ))).toHaveLength(0);

      const legacySnapshotMarker = `W3-ROLLBACK-LEGACY-SNAPSHOT-${Date.now()}`;
      const legacyOutputMarker = `W3-ROLLBACK-LEGACY-OUTPUT-${Date.now()}`;
      const legacyReplayToken = `w3-rollback-legacy-${Date.now()}`;
      const legacySnapshotSeq = Number(baseline.snapshot.seq ?? 0) + 1_000;
      const legacyOutputScreenSeq = legacySnapshotSeq + 1;
      let compatibilityRegistration: { generation: number; viewGeneration: number } | null = null;
      let stableRegistrationKey: string | null = null;
      let stableRegistrationObservations = 0;
      await expect.poll(() => {
        const latestRegistration = latestSessionCheckpointRegistration(harness, sessionId!);
        if (
          !latestRegistration
          || latestRegistration.viewGeneration <= registration.viewGeneration
        ) {
          compatibilityRegistration = null;
          stableRegistrationKey = null;
          stableRegistrationObservations = 0;
          return false;
        }
        const registrationKey = `${latestRegistration.generation}:${latestRegistration.viewGeneration}`;
        if (registrationKey === stableRegistrationKey) {
          stableRegistrationObservations += 1;
        } else {
          stableRegistrationKey = registrationKey;
          stableRegistrationObservations = 1;
        }
        compatibilityRegistration = latestRegistration;
        return stableRegistrationObservations >= 3;
      }, {
        intervals: [100, 150, 200],
        message: 'bounded rollback reconnect did not establish a stable compatibility registration',
        timeout: 10_000,
      }).toBe(true);
      if (!compatibilityRegistration) {
        throw new Error('stable compatibility registration disappeared');
      }
      const compatibilityGeneration = compatibilityRegistration.generation;
      const compatibilityEventBoundary = Math.max(
        0,
        ...(await readDebugEvents(page, sessionId!)).map(event => Number(event.eventId ?? 0)),
      );
      harness.injectToPage(compatibilityGeneration, {
        type: 'screen-snapshot',
        sessionId,
        replayToken: legacyReplayToken,
        seq: legacySnapshotSeq,
        cols: sourceGeometry.cols,
        rows: sourceGeometry.rows,
        mode: 'authoritative',
        data: `\u001b[2J\u001b[H${legacySnapshotMarker}\r\n`,
        truncated: false,
        source: 'headless',
        windowsPty: baseline.snapshot.windowsPty,
      });
      try {
        await expect.poll(() => harness.frames.filter(frame => (
          frame.direction === 'page-to-server'
          && frame.generation === compatibilityGeneration
          && frame.message?.type === 'screen-snapshot:ready'
          && frame.message.sessionId === sessionId
          && frame.message.replayToken === legacyReplayToken
          && frame.message.snapshotSeq === legacySnapshotSeq
        )).length, {
          message: 'fresh compatibility snapshot was not acknowledged after rollback',
          timeout: 10_000,
        }).toBe(1);
      } catch (error) {
        const debugEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
          event.kind.includes('legacy')
          || event.kind.includes('compatibility')
          || event.kind.includes('snapshot')
          || event.kind.includes('runtime_recreation')
        )).slice(-60);
        const routedFrames = harness.frames.slice(-100).map(frame => ({
          direction: frame.direction,
          generation: frame.generation,
          type: frame.message?.type ?? null,
          sessionId: frame.message?.sessionId ?? null,
          replayToken: frame.message?.replayToken ?? null,
          views: frame.message?.views ?? null,
        }));
        throw new Error(`compatibility snapshot diagnostics: ${JSON.stringify({
          connectionCount: harness.connectionCount,
          initialGeneration: registration.generation,
          compatibilityGeneration,
          compatibilityViewGeneration: compatibilityRegistration.viewGeneration,
          compatibilityConnectionUrl: redactConnectionUrl(harness.connectionUrl(compatibilityGeneration)),
          debugEvents,
          routedFrames,
        })}`, { cause: error });
      }
      let compatibilitySnapshotAckEventId = 0;
      await expect.poll(async () => {
        const ackEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
          Number(event.eventId ?? 0) > compatibilityEventBoundary
          && event.kind === 'screen_snapshot_ack_sent'
          && event.details?.seq === legacySnapshotSeq
          && event.details?.mode === 'authoritative'
        ));
        compatibilitySnapshotAckEventId = Number(ackEvents[0]?.eventId ?? 0);
        return ackEvents.length;
      }, {
        message: 'matching visible resync ACK event was not emitted exactly once',
        timeout: 10_000,
      }).toBe(1);

      harness.injectToPage(compatibilityGeneration, {
        type: 'output',
        sessionId,
        data: `${legacyOutputMarker}\r\n`,
        replayToken: legacyReplayToken,
        screenSeq: legacyOutputScreenSeq,
        chunkId: `w3-rollback-output-${legacyOutputScreenSeq}`,
      });
      let postAckOutputReceivedEventId = 0;
      try {
        await expect.poll(async () => {
          const outputHeldEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
            Number(event.eventId ?? 0) > compatibilitySnapshotAckEventId
            && event.kind === 'visible_output_resync_state'
            && event.details?.source === 'compatibility-post-ack-output-held'
            && event.details?.replayToken === legacyReplayToken
            && event.details?.snapshotSeq === legacySnapshotSeq
            && event.details?.heldOutputBytes === Buffer.byteLength(`${legacyOutputMarker}\r\n`, 'utf8')
            && event.details?.heldOutputChunks === 1
          ));
          postAckOutputReceivedEventId = Number(outputHeldEvents[0]?.eventId ?? 0);
          return outputHeldEvents.length;
        }, {
          message: 'post-ACK server tail was not held by the matching visible resync transaction',
          timeout: 10_000,
        }).toBe(1);
      } catch (error) {
        const postAckEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
          Number(event.eventId ?? 0) > compatibilityEventBoundary
          && (
            event.kind.includes('compatibility')
            || event.kind.includes('visible_output_resync')
            || event.kind === 'live_output_received'
            || event.kind.includes('snapshot')
          )
        )).slice(-100);
        throw new Error(`post-ACK compatibility output diagnostics: ${JSON.stringify({
          compatibilityGeneration,
          compatibilityViewGeneration: compatibilityRegistration.viewGeneration,
          legacyReplayToken,
          legacySnapshotSeq,
          legacyOutputScreenSeq,
          postAckEvents,
        })}`, { cause: error });
      }

      const preConvergenceInput = 'w';
      await helper.focus();
      await page.keyboard.type(preConvergenceInput, { delay: 0 });
      await page.waitForTimeout(100);
      expect(harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === preConvergenceInput
      ))).toHaveLength(0);

      harness.injectToPage(compatibilityGeneration, {
        type: 'session:ready',
        sessionId,
        replayToken: legacyReplayToken,
        snapshotSeq: legacySnapshotSeq,
      });
      await expect(rows).toContainText(legacySnapshotMarker, { timeout: 10_000 });
      await expect(rows).toContainText(legacyOutputMarker, { timeout: 10_000 });
      let compatibilityDrainEventId = 0;
      let compatibilityConvergenceStateEventId = 0;
      let compatibilityConvergenceEventId = 0;
      let legacyInputReadyEventId = 0;
      let compatibilitySnapshotAckEventCount = 0;
      let compatibilityDrainEventCount = 0;
      let postAckOutputReceivedEventCount = 0;
      let compatibilityConvergenceStateEventCount = 0;
      let compatibilityConvergenceEventCount = 0;
      let legacyInputReadyEventCount = 0;
      let compatibilityEventIdentityTuples: Record<string, Record<string, unknown>> = {};
      let compatibilityIdentityProofs = {
        sameSession: false,
        sameReplayToken: false,
        sameSnapshotSeq: false,
        sameConnectionGeneration: false,
        sameViewGeneration: false,
      };
      try {
        await expect.poll(async () => {
          const events = await readDebugEvents(page, sessionId!);
          const matchingAckFrames = harness.frames.filter(frame => (
            frame.direction === 'page-to-server'
            && frame.generation === compatibilityGeneration
            && frame.message?.type === 'screen-snapshot:ready'
            && frame.message.sessionId === sessionId
            && frame.message.replayToken === legacyReplayToken
            && frame.message.snapshotSeq === legacySnapshotSeq
          ));
          const matchingOutputFrames = harness.frames.filter(frame => (
            frame.direction === 'server-to-page'
            && frame.generation === compatibilityGeneration
            && frame.message?.type === 'output'
            && frame.message.sessionId === sessionId
            && frame.message.replayToken === legacyReplayToken
            && frame.message.screenSeq === legacyOutputScreenSeq
            && frame.message.chunkId === `w3-rollback-output-${legacyOutputScreenSeq}`
          ));
          const snapshotAcks = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'screen_snapshot_ack_sent'
            && event.details?.seq === legacySnapshotSeq
            && event.details?.mode === 'authoritative'
          ));
          const recoveryDrains = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'terminal_compatibility_recovery_drained'
            && event.details?.viewGeneration === compatibilityRegistration.viewGeneration
          ));
          const postAckOutputs = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'visible_output_resync_state'
            && event.details?.source === 'compatibility-post-ack-output-held'
            && event.details?.replayToken === legacyReplayToken
            && event.details?.snapshotSeq === legacySnapshotSeq
            && event.details?.heldOutputChunks === 1
          ));
          const convergences = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'visible_output_resync_state'
            && event.details?.source === 'authoritative-snapshot-tail-drained'
            && event.details?.replayToken === legacyReplayToken
            && event.details?.snapshotSeq === legacySnapshotSeq
            && event.details?.currentViewTransactionReady === true
            && event.details?.heldOutputBytes === 0
            && event.details?.heldOutputChunks === 0
            && event.details?.connectionGeneration === compatibilityGeneration
            && event.details?.viewGeneration === compatibilityRegistration.viewGeneration
          ));
          const compatibilityTailDrains = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'terminal_compatibility_post_ack_tail_drained'
            && event.details?.replayToken === legacyReplayToken
            && event.details?.snapshotSeq === legacySnapshotSeq
            && event.details?.currentViewTransactionReady === true
            && event.details?.heldOutputBytes === 0
            && event.details?.heldOutputChunks === 0
            && event.details?.connectionGeneration === compatibilityGeneration
            && event.details?.viewGeneration === compatibilityRegistration.viewGeneration
          ));
          const inputReadies = events.filter(event => (
            Number(event.eventId ?? 0) > compatibilityEventBoundary
            && event.kind === 'input_gate_synced'
            && event.details?.reason === 'terminal-authority-legacy'
            && event.details?.inputReady === true
          ));
          compatibilitySnapshotAckEventCount = snapshotAcks.length;
          compatibilityDrainEventCount = recoveryDrains.length;
          postAckOutputReceivedEventCount = postAckOutputs.length;
          compatibilityConvergenceStateEventCount = convergences.length;
          compatibilityConvergenceEventCount = compatibilityTailDrains.length;
          legacyInputReadyEventCount = inputReadies.length;
          compatibilitySnapshotAckEventId = Number(snapshotAcks[0]?.eventId ?? 0);
          compatibilityDrainEventId = Number(recoveryDrains[0]?.eventId ?? 0);
          postAckOutputReceivedEventId = Number(postAckOutputs[0]?.eventId ?? 0);
          compatibilityConvergenceStateEventId = Number(convergences[0]?.eventId ?? 0);
          compatibilityConvergenceEventId = Number(compatibilityTailDrains[0]?.eventId ?? 0);
          legacyInputReadyEventId = Number(inputReadies[0]?.eventId ?? 0);
          const expectedSessionHash = sha256Json(sessionId!);
          compatibilityEventIdentityTuples = {
            drain: {
              eventId: compatibilityDrainEventId,
              sessionHash: sha256Json(recoveryDrains[0]?.sessionId ?? ''),
              viewGeneration: recoveryDrains[0]?.details?.viewGeneration ?? null,
            },
            ack: {
              eventId: compatibilitySnapshotAckEventId,
              sessionHash: sha256Json(String(matchingAckFrames[0]?.message?.sessionId ?? '')),
              debugSessionHash: sha256Json(snapshotAcks[0]?.sessionId ?? ''),
              replayToken: matchingAckFrames[0]?.message?.replayToken ?? null,
              snapshotSeq: matchingAckFrames[0]?.message?.snapshotSeq ?? null,
              connectionGeneration: matchingAckFrames[0]?.generation ?? null,
            },
            postAckOutput: {
              eventId: postAckOutputReceivedEventId,
              sessionHash: sha256Json(postAckOutputs[0]?.sessionId ?? ''),
              wireSessionHash: sha256Json(String(matchingOutputFrames[0]?.message?.sessionId ?? '')),
              replayToken: postAckOutputs[0]?.details?.replayToken ?? null,
              wireReplayToken: matchingOutputFrames[0]?.message?.replayToken ?? null,
              snapshotSeq: postAckOutputs[0]?.details?.snapshotSeq ?? null,
              connectionGeneration: postAckOutputs[0]?.details?.connectionGeneration ?? null,
              wireConnectionGeneration: matchingOutputFrames[0]?.generation ?? null,
              viewGeneration: postAckOutputs[0]?.details?.viewGeneration ?? null,
              screenSeq: matchingOutputFrames[0]?.message?.screenSeq ?? null,
              wireScreenSeq: matchingOutputFrames[0]?.message?.screenSeq ?? null,
            },
            convergenceState: {
              eventId: compatibilityConvergenceStateEventId,
              sessionHash: sha256Json(convergences[0]?.sessionId ?? ''),
              replayToken: convergences[0]?.details?.replayToken ?? null,
              snapshotSeq: convergences[0]?.details?.snapshotSeq ?? null,
              connectionGeneration: convergences[0]?.details?.connectionGeneration ?? null,
              viewGeneration: convergences[0]?.details?.viewGeneration ?? null,
            },
            convergence: {
              eventId: compatibilityConvergenceEventId,
              sessionHash: sha256Json(compatibilityTailDrains[0]?.sessionId ?? ''),
              replayToken: compatibilityTailDrains[0]?.details?.replayToken ?? null,
              snapshotSeq: compatibilityTailDrains[0]?.details?.snapshotSeq ?? null,
              connectionGeneration: compatibilityTailDrains[0]?.details?.connectionGeneration ?? null,
              viewGeneration: compatibilityTailDrains[0]?.details?.viewGeneration ?? null,
            },
            ready: {
              eventId: legacyInputReadyEventId,
              sessionHash: sha256Json(inputReadies[0]?.sessionId ?? ''),
            },
          };
          compatibilityIdentityProofs = {
            sameSession: matchingAckFrames.length === 1
              && matchingOutputFrames.length === 1
              && [
                recoveryDrains[0],
                snapshotAcks[0],
                postAckOutputs[0],
                convergences[0],
                compatibilityTailDrains[0],
                inputReadies[0],
              ].every(event => sha256Json(event?.sessionId ?? '') === expectedSessionHash),
            sameReplayToken: matchingAckFrames[0]?.message?.replayToken === legacyReplayToken
              && matchingOutputFrames[0]?.message?.replayToken === legacyReplayToken
              && [postAckOutputs[0], convergences[0], compatibilityTailDrains[0]].every(
                event => event?.details?.replayToken === legacyReplayToken,
              ),
            sameSnapshotSeq: matchingAckFrames[0]?.message?.snapshotSeq === legacySnapshotSeq
              && [postAckOutputs[0], convergences[0], compatibilityTailDrains[0]].every(
                event => event?.details?.snapshotSeq === legacySnapshotSeq,
              ),
            sameConnectionGeneration: matchingAckFrames[0]?.generation === compatibilityGeneration
              && matchingOutputFrames[0]?.generation === compatibilityGeneration
              && [postAckOutputs[0], convergences[0], compatibilityTailDrains[0]].every(
                event => event?.details?.connectionGeneration === compatibilityGeneration,
              ),
            sameViewGeneration:
              recoveryDrains[0]?.details?.viewGeneration === compatibilityRegistration.viewGeneration
              && [postAckOutputs[0], convergences[0], compatibilityTailDrains[0]].every(
                event => event?.details?.viewGeneration === compatibilityRegistration.viewGeneration,
              ),
          };
          return compatibilitySnapshotAckEventCount === 1
            && compatibilityDrainEventCount === 1
            && postAckOutputReceivedEventCount === 1
            && compatibilityConvergenceStateEventCount === 1
            && compatibilityConvergenceEventCount === 1
            && legacyInputReadyEventCount === 1
            && compatibilityDrainEventId > compatibilityEventBoundary
            && compatibilitySnapshotAckEventId > compatibilityDrainEventId
            && postAckOutputReceivedEventId > compatibilitySnapshotAckEventId
            && compatibilityConvergenceStateEventId > postAckOutputReceivedEventId
            && compatibilityConvergenceEventId > compatibilityConvergenceStateEventId
            && legacyInputReadyEventId > compatibilityConvergenceEventId
            && Object.values(compatibilityIdentityProofs).every(Boolean);
        }, {
          message: 'legacy input reopened before authoritative snapshot and held output drained',
          timeout: 10_000,
        }).toBe(true);
      } catch (error) {
        const gateEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
          event.kind.includes('input_gate')
          || event.kind.includes('legacy')
          || event.kind.includes('compatibility')
          || event.kind.includes('snapshot')
          || event.kind.includes('runtime')
        )).slice(-80);
        const readyAcks = harness.frames.filter(frame => (
          frame.direction === 'page-to-server'
          && frame.message?.type === 'screen-snapshot:ready'
          && frame.message.sessionId === sessionId
        )).map(frame => ({
          generation: frame.generation,
          replayToken: frame.message?.replayToken ?? null,
        }));
        throw new Error(`legacy input reopen diagnostics: ${JSON.stringify({
          compatibilityGeneration,
          compatibilityViewGeneration: compatibilityRegistration.viewGeneration,
          readyAcks,
          gateEvents,
        })}`, { cause: error });
      }
      await expect(rows).not.toContainText(pendingMarker);

      const legacyInput = 'v';
      await helper.focus();
      await page.keyboard.type(legacyInput, { delay: 0 });
      await expect.poll(() => harness.frames.filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'input'
        && frame.message.sessionId === sessionId
        && frame.message.data === legacyInput
      )).length, {
        message: 'legacy input admission did not reopen after capability rollback',
        timeout: 5_000,
      }).toBe(1);
      await page.waitForTimeout(100);
      expect((await readDebugEvents(page, sessionId!)).filter(event => (
        event.kind === 'terminal_checkpoint_input_settled'
        && event.details?.outcome === 'superseded'
      ))).toHaveLength(1);

      rememberEvidence(testInfo, {
        execution: 'live-https-active-to-passive-capability-rollback',
        checkpointCapabilityRollback: {
          verified: true,
          checkpointCompletedBeforeRollback: true,
          oldViewGeneration: registration.viewGeneration,
          expectedCleanLegacyGeneration: registration.viewGeneration + 1,
          strictlyHigherGenerationContract: 'unit-verified-and-https-compatibility-admission-observed',
          legacyRecoveryPendingObserved: true,
          preSnapshotInputSentToServer: 0,
          compatibilitySnapshotGeneration: compatibilityGeneration,
          compatibilitySnapshotViewGeneration: compatibilityRegistration.viewGeneration,
          compatibilitySnapshotSeq: legacySnapshotSeq,
          compatibilitySnapshotConnectionUrl: redactConnectionUrl(
            harness.connectionUrl(compatibilityGeneration),
          ),
          replacementWebSocketGenerationUsed: compatibilityGeneration > registration.generation,
          recoveryPendingFalseObservedBy: 'fresh-snapshot-ack-held-output-drain-and-terminal-authority-legacy',
          rollbackInputSentToServer: 0,
          rollbackInputSettlementCount: 1,
          rollbackInputSettlementOutcome: rollbackSettlement.details?.outcome ?? null,
          rollbackSettlementToken: rollbackSettlement.details?.token ?? null,
          rollbackSettlementPayloadFree: !JSON.stringify(rollbackSettlement.details).includes(rollbackInput),
          staleOldGenerationFenceUnitVerified: true,
          freshCompatibilitySnapshotApplied: true,
          compatibilityEventBoundary,
          compatibilitySnapshotAckEventId,
          compatibilitySnapshotAckEventCount,
          compatibilityDrainEventId,
          compatibilityDrainEventCount,
          postAckOutputReceivedEventId,
          postAckOutputReceivedEventCount,
          compatibilityConvergenceStateEventId,
          compatibilityConvergenceStateEventCount,
          compatibilityConvergenceEventId,
          compatibilityConvergenceEventCount,
          legacyInputReadyEventId,
          legacyInputReadyEventCount,
          compatibilityEventIdentityTuples,
          compatibilityIdentityProofs,
          heldLegacyOutputDrainedBeforeInputReady:
            compatibilityDrainEventId > compatibilityEventBoundary
            && compatibilitySnapshotAckEventId > compatibilityDrainEventId
            && postAckOutputReceivedEventId > compatibilitySnapshotAckEventId
            && compatibilityConvergenceStateEventId > postAckOutputReceivedEventId
            && compatibilityConvergenceEventId > compatibilityConvergenceStateEventId
            && legacyInputReadyEventId > compatibilityConvergenceEventId,
          compatibilitySnapshotReplayToken: legacyReplayToken,
          postSnapshotLegacyOutputApplied: true,
          postAckOutputScreenSeq: legacyOutputScreenSeq,
          preConvergenceInputSentToServer: 0,
          legacyInputAdmittedAfterRollback: 1,
          oldGenerationMutationAbsent: true,
          lateCallbackFenceUnitEvidence: [
            'FR_BGSTAB_022_AC6_late_pre_rollback_write_callback_cannot_double_settle_or_mutate_legacy',
            'capability withdrawal atomically rolls recovery into a clean legacy generation',
          ],
        },
      });
    } finally {
      unblockControlledServer();
      unblockLegacyAuthorityServer();
      unblockLegacyCheckpointServer();
    }
  });

  test('sole writer refresh remount faults — wire capability and coordinator faults fail closed', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    await login(page);
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
    const active = await waitForSnapshot(harness, sessionId!);
    const controlGeneration = harness.latestGeneration(
      'page-to-server',
      message => message.type === 'subscribe' || message.type === 'ping',
    ) ?? active.generation;
    harness.injectToServer(controlGeneration, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
    });
    await page.waitForTimeout(1_500);
    const capability = harness.latest(
      'server-to-page',
      message => message.type === 'terminal-checkpoint:capability',
      controlGeneration,
    );
    let rejectedAck: JsonFrame | null = null;
    if (capability) {
      expect(capability).toMatchObject({
        protocolVersion: 1,
        accepted: true,
        authorityMode: 'legacy',
        checkpointDeliveryActive: false,
        ordinalEncoding: 'canonical-uint64-decimal',
        digestAlgorithms: ['sha256'],
      });
      harness.injectToServer(controlGeneration, {
        type: 'terminal-checkpoint:apply-ack',
        protocolVersion: 1,
        sessionId,
        viewGeneration: 1,
        streamEpoch: '1',
        checkpointEpoch: '1',
        snapshotSeq: '1',
        oldestRetainedSeq: '0',
        retentionPolicyId: 'w3-e2e-inactive',
        appliedThroughSeq: '1',
        sourceSeq: '1',
      });
      try {
        await expect.poll(() => harness.latest(
          'server-to-page',
          message => message.type === 'terminal-checkpoint:rejected',
          controlGeneration,
        ), {
          message: 'inactive checkpoint ACK was not rejected fail-closed',
          timeout: 10_000,
        }).not.toBeNull();
      } catch (error) {
        const checkpointFrames = harness.frames.filter(frame => (
          frame.generation === controlGeneration
          && typeof frame.message?.type === 'string'
          && frame.message.type.startsWith('terminal-checkpoint:')
        )).map(frame => ({ direction: frame.direction, message: frame.message }));
        throw new Error(`inactive checkpoint ACK diagnostics: ${JSON.stringify(checkpointFrames)}`, {
          cause: error,
        });
      }
      rejectedAck = harness.latest(
        'server-to-page',
        message => message.type === 'terminal-checkpoint:rejected',
        controlGeneration,
      );
      expect(rejectedAck?.reason).toBe('invalid-message');
    }

    const faults = await runCoordinatorFaultMatrix(page);
    expect(faults.digestMismatch).toMatchObject({
      result: { accepted: false, reason: 'checkpoint-digest-mismatch' },
      recoveries: ['checkpoint-digest-mismatch'],
      state: { ready: false },
    });
    expect(faults.outOfOrderChunk).toMatchObject({
      result: { accepted: false, reason: 'checkpoint-chunk-order-invalid' },
      recoveries: ['checkpoint-chunk-order-invalid'],
      state: { ready: false },
    });
    expect(faults.epochRollover).toMatchObject({
      result: { accepted: false, reason: 'ordinal64-rollover' },
      recoveries: ['ordinal64-rollover'],
    });
    expect(faults.staleCallback).toMatchObject({
      supersede: { accepted: true },
      settlements: [{ token: 'old-generation', outcome: 'superseded' }],
      state: {
        viewGeneration: 8,
        ready: false,
        disposed: false,
        writeInFlight: false,
        pendingCommands: 0,
        pendingInputs: 0,
      },
    });
    expect(faults.readyBarrier.beforeDrain).toMatchObject({
      state: { ready: false, writeInFlight: true, pendingInputs: 1 },
      ready: [],
      releasedInput: [],
      writes: [{ kind: 'checkpoint' }],
    });
    expect(faults.readyBarrier.betweenBodyAndTail).toMatchObject({
      state: { ready: false, writeInFlight: true, pendingInputs: 1 },
      ready: [],
      releasedInput: [],
      writes: [{ kind: 'checkpoint' }, { kind: 'parser-tail' }],
    });
    expect(faults.readyBarrier.afterDrain).toMatchObject({
      state: { ready: true, writeInFlight: false, pendingInputs: 0 },
      ready: [7],
      releasedInput: ['queued-input'],
    });

    await startDebugCapture(page, sessionId!);
    await page.evaluate(() => window.__buildergateTerminalDebug?.setInputReliabilityMode('queue'));
    expect(await setTerminalInputTransportOverride(page, sessionId!, {
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'connected',
    })).toBe(true);
    try {
      const helper = (await getSessionTerminalRuntime(page, sessionId!)).locator('.xterm-helper-textarea');
      await helper.focus();
      await page.keyboard.type('w3q', { delay: 0 });
      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId!);
        return {
          queued: events.filter(event => event.kind === 'terminal_input_queued').length,
          sent: events.filter(event => event.kind === 'ws_input_sent').length,
        };
      }, { timeout: 5_000 }).toMatchObject({ queued: 3, sent: 0 });
      await setTerminalInputTransportOverride(page, sessionId!, null);
      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId!);
        return {
          flushed: events.filter(event => event.kind === 'queued_input_flushed').length,
          sent: events.filter(event => event.kind === 'ws_input_sent').length,
        };
      }, { timeout: 5_000 }).toMatchObject({ flushed: 3, sent: 1 });
      await page.keyboard.press('Control+C');
    } finally {
      await setTerminalInputTransportOverride(page, sessionId!, null);
      await page.evaluate(() => window.__buildergateTerminalDebug?.setInputReliabilityMode(null));
    }

    rememberEvidence(testInfo, {
      execution: 'wire-negotiation-plus-browser-evaluated-production-coordinator',
      wireCheckpointCapability: {
        status: capability ? 'advertised-inactive' : 'unavailable-no-response',
        accepted: capability?.accepted ?? false,
        authorityMode: capability?.authorityMode ?? 'unavailable',
        checkpointDeliveryActive: capability?.checkpointDeliveryActive ?? null,
        ordinalEncoding: capability?.ordinalEncoding ?? 'unavailable',
        ackRejectionReason: rejectedAck?.reason ?? 'not-sent-without-capability',
        controlGeneration,
        connectionUrl: redactConnectionUrl(harness.connectionUrl(controlGeneration)),
      },
      coordinatorFaultMatrix: faults,
      coordinatorReadyInputBarrier: {
        evidenceKind: 'browser-evaluated-production-coordinator-with-synthetic-adapter-callbacks',
        beforeDrain: faults.readyBarrier.beforeDrain,
        betweenBodyAndTail: faults.readyBarrier.betweenBodyAndTail,
        afterDrain: faults.readyBarrier.afterDrain,
      },
      terminalTransportInputBarrierObservation: {
        evidenceKind: 'production-terminal-input-path-with-local-test-transport-readiness-override',
        checkpointAckImplementationEvidence: false,
        queuedBeforeReady: 3,
        sentBeforeReady: 0,
        releasedAfterReady: true,
      },
      capabilityActivationEligible: false,
      failClosedReason: capability
        ? 'checkpoint delivery inactive and ACK rejected without compatibility success'
        : 'runtime capability unavailable/no response; ACK not sent and activation rejected',
    });
  });

  test('PERF-BGSTAB-010 fair delivery browser ACK follows a visible write and preserves idle', async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const harness = new RoutedWebSocketHarness();
    await harness.install(page);
    await login(page);
    const ownedWorkspace = await createWave3PowerShellWorkspace(page);
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'E2E precondition failed: active fair-delivery session is unavailable').not.toBeNull();
    expect(sessionId, 'E2E fair-delivery scenario did not select its isolated terminal').toBe(ownedWorkspace.sessionId);
    const snapshot = await waitForSnapshot(harness, sessionId!);
    await startDebugCapture(page, sessionId!);
    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'E2E precondition failed: fair-delivery session did not settle idle',
      timeout: 15_000,
    }).toBe('idle');
    try {
      await expect.poll(() => harness.frames.some((frame, frameIndex) => (
        frame.direction === 'page-to-server'
        && frame.generation === snapshot.generation
        && frame.message?.type === 'screen-snapshot:ready'
        && frame.message.sessionId === sessionId
        && harness.frames.slice(0, frameIndex).some(snapshotFrame => (
          snapshotFrame.direction === 'server-to-page'
          && snapshotFrame.generation === snapshot.generation
          && snapshotFrame.message?.type === 'screen-snapshot'
          && snapshotFrame.message.sessionId === sessionId
          && snapshotFrame.message.replayToken === frame.message?.replayToken
        ))
      )), {
        message: 'E2E precondition failed: fair-delivery baseline snapshot did not drain before output admission',
        timeout: 15_000,
      }).toBe(true);
    } catch (error) {
      const snapshotFrames = harness.frames.filter(frame => (
        frame.generation === snapshot.generation
        && frame.message?.sessionId === sessionId
        && (frame.message.type === 'screen-snapshot' || frame.message.type === 'screen-snapshot:ready')
      )).map(frame => ({
        direction: frame.direction,
        type: frame.message?.type,
        replayToken: frame.message?.replayToken ?? null,
        snapshotSeq: frame.message?.snapshotSeq ?? frame.message?.seq ?? null,
      }));
      const snapshotEvents = (await readDebugEvents(page, sessionId!)).filter(event => (
        event.kind.includes('snapshot') || event.kind.includes('session_ready')
      )).slice(-30);
      throw new Error(`fair-delivery baseline snapshot diagnostics: ${JSON.stringify({
        expectedReplayToken: snapshot.snapshot.replayToken ?? null,
        snapshotFrames,
        snapshotEvents,
      })}`, { cause: error });
    }
    const connectionEpoch = `fair-browser-${Date.now()}`;
    harness.injectToPage(snapshot.generation, {
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      accepted: true,
      connectionEpoch,
      supportsHiddenDataGapRecovery: true,
    });
    const frameBoundary = harness.frames.length;
    const marker = `PERF-BGSTAB-010-VISIBLE-ACK-${Date.now()}`;
    harness.injectToPage(snapshot.generation, {
      type: 'output',
      sessionId: sessionId!,
      data: `\r\n${marker}\r\n`,
      connectionEpoch,
      deliverySeq: 1,
    });

    const runtime = await getSessionTerminalRuntime(page, sessionId!);
    await expect(runtime.locator('.xterm-rows')).toContainText(marker, { timeout: 15_000 });
    await expect.poll(async () => ({
      ackCount: harness.frames.slice(frameBoundary).filter(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'terminal-delivery:ack'
        && frame.message.sessionId === sessionId
        && frame.message.connectionEpoch === connectionEpoch
        && frame.message.deliverySeq === 1
      )).length,
      acceptedAttemptCount: (await readDebugEvents(page, sessionId!))
        .filter(event => event.kind === 'terminal_delivery_ack_attempted')
        .filter(event => event.details?.connectionEpoch === connectionEpoch
          && event.details?.deliverySeq === 1
          && event.details?.accepted === true).length,
      identifiedLiveOutputCount: (await readDebugEvents(page, sessionId!))
        .filter(event => event.kind === 'live_output_received')
        .filter(event => event.details?.deliveryIdentityPresent === true).length,
    }), {
      message: 'accepted visible fair delivery did not emit exactly one control ACK',
      timeout: 15_000,
    }).toMatchObject({
      ackCount: 1,
      acceptedAttemptCount: 1,
      identifiedLiveOutputCount: 1,
    });
    const ackFrame = harness.frames.slice(frameBoundary).find(frame => (
        frame.direction === 'page-to-server'
        && frame.message?.type === 'terminal-delivery:ack'
        && frame.message.sessionId === sessionId
        && frame.message.connectionEpoch === connectionEpoch
        && frame.message.deliverySeq === 1
    ));
    expect(ackFrame).toBeDefined();
    expect(harness.connectionUrl(ackFrame!.generation)).not.toBeNull();
    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'fair delivery ACK must not infer semantic command execution or leave the session running',
      timeout: 15_000,
    }).toBe('idle');

    rememberEvidence(testInfo, {
      fairDeliveryBrowserAck: {
        visibleWriteObserved: true,
        ackCount: 1,
        deliveryConnectionEpoch: connectionEpoch,
        deliverySeq: 1,
        ackGeneration: ackFrame!.generation,
        controlConnectionUrl: redactConnectionUrl(harness.connectionUrl(ackFrame!.generation)),
        sessionStatusAfterAck: 'idle',
      },
    });
    await deleteWave3Workspace(page, ownedWorkspace.workspaceId);
  });
});

test('REL-BGSTAB-012 preserves AI idle and mounted renderer residency during hidden recovery', async ({ page }) => {
  test.setTimeout(90_000);
  const harness = new RoutedWebSocketHarness();
  await harness.install(page);
  await page.goto('/');
  await login(page);
  const ownedWorkspace = await createWave3PowerShellWorkspace(page);
  try {
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'REL-BGSTAB-012 precondition failed: active session is unavailable').toBe(ownedWorkspace.sessionId);
    const snapshot = await waitForSnapshot(harness, sessionId!);
    const runtime = await getSessionTerminalRuntime(page, sessionId!);
    await startDebugCapture(page, sessionId!);
    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'REL-BGSTAB-012 precondition failed: session did not settle idle',
      timeout: 15_000,
    }).toBe('idle');

    harness.injectToPage(snapshot.generation, {
      type: 'terminal-delivery:data-gap',
      protocolVersion: 1,
      sessionId: sessionId!,
      connectionEpoch: `rel012-hidden-recovery-${Date.now()}`,
      deliverySeq: 1,
      visibilityGeneration: '1',
      lastDeliveredSeq: '0',
    });

    const helper = runtime.locator('.xterm-helper-textarea');
    await helper.focus();
    await expect(helper).toBeFocused();
    const keyboardLocalEcho = `rel012-local-echo-${Date.now()}`;
    const keyboardFrameBoundary = harness.frames.length;
    await page.keyboard.type(keyboardLocalEcho, { delay: 0 });
    await expect.poll(() => harness.frames.slice(keyboardFrameBoundary).some(frame => (
      frame.direction === 'page-to-server'
      && frame.message?.type === 'input'
      && frame.message.sessionId === sessionId
      && String(frame.message.data ?? '').includes(keyboardLocalEcho)
    )), {
      message: 'hidden recovery keyboard/local-echo path was not delivered through the existing terminal input seam',
      timeout: 15_000,
    }).toBe(true);
    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'keyboard and local echo during hidden recovery must not infer semantic execution',
      timeout: 15_000,
    }).toBe('idle');

    const repaintMarkers = {
      prompt: `REL012-PROMPT-${Date.now()}`,
      cursor: `REL012-CURSOR-${Date.now()}`,
      ticker: `REL012-TICKER-${Date.now()}`,
      waiting: `REL012-WAITING-${Date.now()}`,
    };
    harness.injectToPage(snapshot.generation, {
      type: 'output',
      sessionId: sessionId!,
      data: `\r\n${repaintMarkers.prompt}> ${keyboardLocalEcho}\u001b[1D\r\n${repaintMarkers.cursor}\r\n`,
    });
    harness.injectToPage(snapshot.generation, {
      type: 'output',
      sessionId: sessionId!,
      data: `\r${repaintMarkers.ticker}`,
    });
    const rows = runtime.locator('.xterm-rows');
    await expect(rows).toContainText(repaintMarkers.prompt, { timeout: 15_000 });
    await expect(rows).toContainText(repaintMarkers.cursor, { timeout: 15_000 });
    await expect(rows).toContainText(repaintMarkers.ticker, { timeout: 15_000 });
    harness.injectToPage(snapshot.generation, {
      type: 'output',
      sessionId: sessionId!,
      data: `\r${repaintMarkers.waiting}`,
    });
    await expect(rows).toContainText(repaintMarkers.waiting, { timeout: 15_000 });
    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'prompt, cursor, ticker, and waiting repaint paths during recovery must preserve AI idle',
      timeout: 15_000,
    }).toBe('idle');

    await expect.poll(() => readSessionStatus(page, sessionId!), {
      message: 'hidden recovery must not infer semantic command execution from delivery repair',
      timeout: 15_000,
    }).toBe('idle');
    await expect(runtime).toHaveCount(1);
    const events = await readDebugEvents(page, sessionId!);
    expect(events.some(event => (
      event.kind === 'terminal_hidden_recovery_residency_preserved'
      && event.details?.keyboardInputPreservedIdle === true
      && event.details?.localEchoPreservedIdle === true
      && event.details?.promptRepaintPreservedIdle === true
      && event.details?.cursorRepaintPreservedIdle === true
      && event.details?.tickerRepaintPreservedIdle === true
      && event.details?.waitingForInputRepaintPreservedIdle === true
    ))).toBe(true);
  } finally {
    await deleteWave3Workspace(page, ownedWorkspace.workspaceId);
  }
});

test('REL-BGSTAB-012 routes hidden dataGap to only its browser view', async ({ page, context }) => {
  test.setTimeout(90_000);
  const observeProductionWebSocket = (target: Page) => {
    const frames: CapturedFrame[] = [];
    let connectionCount = 0;
    target.on('websocket', socket => {
      const url = new URL(socket.url());
      if (url.protocol !== 'wss:' || url.host !== 'localhost:2222' || url.pathname !== '/ws') return;
      const generation = ++connectionCount;
      socket.on('framesent', frame => {
        frames.push({ direction: 'page-to-server', generation, message: parseFrame(frame.payload) });
      });
      socket.on('framereceived', frame => {
        frames.push({ direction: 'server-to-page', generation, message: parseFrame(frame.payload) });
      });
    });
    return {
      frames,
      get connectionCount() {
        return connectionCount;
      },
      latest(direction: CapturedFrame['direction'], predicate: (message: JsonFrame) => boolean): JsonFrame | null {
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          const frame = frames[index];
          if (frame.direction === direction && frame.message && predicate(frame.message)) return frame.message;
        }
        return null;
      },
    };
  };
  const sourceObservation = observeProductionWebSocket(page);
  await page.goto('/');
  await login(page);
  const ownedWorkspace = await createWave3PowerShellWorkspace(page);
  const peer = await context.newPage();
  const peerObservation = observeProductionWebSocket(peer);
  let hiddenRuntime: RuntimeRemountContext | null = null;
  try {
    await page.reload();
    await waitForTerminal(page);
    const sessionId = await getActiveSessionId(page);
    expect(sessionId, 'REL-BGSTAB-012 precondition failed: source session is unavailable').toBe(ownedWorkspace.sessionId);
    const sourceRuntime = await getSessionTerminalRuntime(page, sessionId!);
    await startDebugCapture(page, sessionId!);

    await expect.poll(() => sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-delivery:capability',
    ), {
      message: 'REL-BGSTAB-012 precondition failed: the real browser did not send a delivery capability frame',
      timeout: 15_000,
    }).not.toBeNull();
    const browserCapability = sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-delivery:capability',
    );
    expect(browserCapability, 'REL-BGSTAB-012 product gap: the real browser must advertise hidden dataGap recovery').toMatchObject({
      type: 'terminal-delivery:capability',
      protocolVersion: 1,
      supportsHiddenDataGapRecovery: true,
    });
    await expect.poll(() => sourceObservation.latest(
      'server-to-page',
      message => message.type === 'terminal-delivery:capability'
        && message.accepted === true,
    ), {
      message: 'REL-BGSTAB-012 product gap: WsRouter did not admit the real browser hidden dataGap capability',
      timeout: 15_000,
    }).toMatchObject({
      type: 'terminal-delivery:capability',
      accepted: true,
    });

    await peer.goto('/');
    await waitForTerminal(peer);
    const peerSessionId = await getActiveSessionId(peer);
    expect(peerSessionId, 'REL-BGSTAB-012 precondition failed: peer did not join the source terminal').toBe(sessionId);
    const peerRuntime = await getSessionTerminalRuntime(peer, sessionId!);
    await startDebugCapture(peer, sessionId!);
    await expect.poll(() => readSessionStatus(peer, sessionId!), {
      message: 'REL-BGSTAB-012 precondition failed: shared session did not settle idle',
      timeout: 15_000,
    }).toBe('idle');

    const socketCountBeforeHiddenAdmission = sourceObservation.connectionCount;
    const frameBoundary = sourceObservation.frames.length;
    const peerFrameBoundary = peerObservation.frames.length;
    hiddenRuntime = await hideRuntimeBehindTemporaryTab(page, sessionId!);
    await expect.poll(() => getActiveSessionId(page), {
      message: 'REL-BGSTAB-012 hidden-view precondition failed: the source terminal did not leave the active workspace slot',
      timeout: 15_000,
    }).toBe(hiddenRuntime.temporarySessionId);
    await expect.poll(() => sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-delivery:visibility'
        && message.sessionId === sessionId
        && message.isVisible === false
        && typeof message.visibilityGeneration === 'string',
    ), {
      message: 'REL-BGSTAB-012 product gap: hiding through the real tab flow did not publish visibility',
      timeout: 15_000,
    }).toMatchObject({
      type: 'terminal-delivery:visibility',
      sessionId,
      isVisible: false,
    });
    const hiddenVisibility = sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-delivery:visibility'
        && message.sessionId === sessionId
        && message.isVisible === false,
    );
    expect(hiddenVisibility).not.toBeNull();
    const sourceRuntimeCountAfterHide = await sourceRuntime.count();

    const marker = `REL012-REAL-HIDDEN-GAP-${Date.now()}`;
    await sendVisibleTerminalCommand(peer, sessionId!, `Write-Output "${marker}"`);
    await waitForCommandCompletion(peer, sessionId!, marker);
    await expect.poll(() => peerObservation.latest(
      'server-to-page',
      message => message.type === 'output'
        && message.sessionId === sessionId
        && String(message.data ?? '').includes(marker),
    ), {
      message: 'REL-BGSTAB-012 peer precondition failed: the visible peer did not receive its real output',
      timeout: 15_000,
    }).not.toBeNull();
    await expect.poll(() => sourceObservation.latest(
      'server-to-page',
      message => message.type === 'terminal-delivery:data-gap'
        && message.sessionId === sessionId,
    ), {
      message: 'REL-BGSTAB-012 product gap: production WsRouter did not route a hidden-view dataGap',
      timeout: 15_000,
    }).toMatchObject({
      type: 'terminal-delivery:data-gap',
      sessionId,
      visibilityGeneration: hiddenVisibility?.visibilityGeneration,
      continuityAuthority: 'server-issued',
    });
    const dataGap = sourceObservation.latest(
      'server-to-page',
      message => message.type === 'terminal-delivery:data-gap' && message.sessionId === sessionId,
    );
    expect(typeof dataGap?.connectionId).toBe('string');
    expect(typeof dataGap?.viewGeneration).toBe('number');
    expect(typeof dataGap?.lastDeliveredSeq).toBe('string');
    expect(typeof dataGap?.streamEpoch).toBe('string');
    expect(typeof dataGap?.checkpointEpoch).toBe('string');
    expect(typeof dataGap?.snapshotSeq).toBe('string');
    expect(typeof dataGap?.oldestRetainedSeq).toBe('string');
    expect(typeof dataGap?.retentionPolicyId).toBe('string');
    await expect.poll(() => sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-checkpoint:recovery-request' && message.sessionId === sessionId,
    ), {
      message: 'REL-BGSTAB-012 product gap: a receiving dataGap did not request a fresh server checkpoint',
      timeout: 15_000,
    }).not.toBeNull();
    await expect.poll(() => sourceObservation.latest(
      'server-to-page',
      message => message.type === 'terminal-checkpoint:start' && message.sessionId === sessionId,
    ), {
      message: 'REL-BGSTAB-012 product gap: authoritative recovery did not start a fresh server checkpoint',
      timeout: 15_000,
    }).not.toBeNull();
    await expect.poll(() => sourceObservation.latest(
      'page-to-server',
      message => message.type === 'terminal-checkpoint:drain-ack' && message.sessionId === sessionId,
    ), {
      message: 'REL-BGSTAB-012 product gap: fresh checkpoint did not drain-ack from its receiving browser view',
      timeout: 15_000,
    }).not.toBeNull();
    expect(
      sourceObservation.frames.slice(frameBoundary).some(frame => (
        frame.direction === 'server-to-page'
        && frame.message?.type === 'output'
        && frame.message.sessionId === sessionId
        && String(frame.message.data ?? '').includes(marker)
      )),
      'REL-BGSTAB-012 source view must not receive a direct hidden-output write',
    ).toBe(false);
    expect(
      peerObservation.frames.slice(peerFrameBoundary).some(frame => (
        frame.direction === 'server-to-page'
        && frame.message?.type === 'terminal-delivery:data-gap'
        && frame.message.sessionId === sessionId
      )),
      'REL-BGSTAB-012 peer browser view must not receive the hidden source dataGap',
    ).toBe(false);
    expect(sourceObservation.connectionCount, 'REL-BGSTAB-012 hidden recovery must not activate a split-output socket').toBe(
      socketCountBeforeHiddenAdmission,
    );
    expect(
      sourceObservation.frames.slice(frameBoundary).some(frame => (
        frame.direction === 'server-to-page'
        && frame.message?.type === 'connected'
        && frame.message.channel === 'output'
      )),
      'REL-BGSTAB-012 hidden recovery must not activate a split-output channel',
    ).toBe(false);

    await expect.poll(async () => {
      const event = (await readDebugEvents(page, sessionId!)).find(candidate => (
        candidate.kind === 'terminal_hidden_data_gap_recovery_started'
        && candidate.details?.visibilityGeneration === hiddenVisibility?.visibilityGeneration
      ));
      return {
        sourceViewStale: event?.details?.sourceViewStale === true,
        sourceViewReady: event?.details?.sourceViewReady === false,
        authoritativeRecoveryRequested: event?.details?.authoritativeRecoveryRequested === true,
        recoveryScope: event?.details?.recoveryScope ?? null,
      };
    }, {
      message: 'REL-BGSTAB-012 hidden dataGap must stale only the receiving browser view and request authoritative recovery',
      timeout: 15_000,
    }).toEqual({
      sourceViewStale: true,
      sourceViewReady: false,
      authoritativeRecoveryRequested: true,
      recoveryScope: 'browser-view-only',
    });
    expect(await readDebugEvents(peer, sessionId!)).not.toContainEqual(expect.objectContaining({
      kind: 'terminal_hidden_data_gap_recovery_started',
    }));
    await expect(peerRuntime).toHaveCount(1);
    await expect(sourceRuntime).toHaveCount(sourceRuntimeCountAfterHide);
    await expect.poll(() => readSessionStatus(peer, sessionId!), {
      message: 'REL-BGSTAB-012 browser-view recovery must not change semantic peer session status',
      timeout: 15_000,
    }).toBe('idle');
  } finally {
    if (hiddenRuntime) {
      await cleanupRuntimeRemountContext(page, hiddenRuntime);
    }
    await peer.close();
    await deleteWave3Workspace(page, ownedWorkspace.workspaceId);
  }
});

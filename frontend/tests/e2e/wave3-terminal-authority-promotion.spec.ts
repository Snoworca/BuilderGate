import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import type { TerminalRetainedStateEvidence } from '../../src/utils/terminalRetainedState.ts';
import { getActiveSessionId, login, waitForTerminal } from './helpers';
import {
  formatConfiguredAuthorityFailureDiagnostic,
  runCleanupAttemptSequence,
} from '../support/terminalAuthorityDiagnostics.ts';

const AUTHORITY_WORKSPACE_PREFIX = `PH5A-${Date.now().toString(36)}-`;

type JsonFrame = Record<string, unknown> & {
  type?: string;
  sessionId?: string;
  data?: string;
  replayToken?: string;
  seq?: number;
  screenSeq?: number;
};

interface CapturedFrame {
  direction: 'page-to-server' | 'server-to-page';
  generation: number;
  origin: 'routed-page' | 'routed-server' | 'test-injection';
  message: JsonFrame | null;
}

interface LiveTerminal {
  sessionId: string;
  generation: number;
  snapshot: JsonFrame;
  viewGeneration: number;
}

const QUERY_DA1 = '\u001b[c';
const REPLY_DA1 = '\u001b[?1;2c';
const REPLY_DA1_CONPTY = '\u001b[?61;4c';
const BROWSER_NATIVE_QUERY_PARITY_CASES = Object.freeze([
  {
    label: 'osc4-16',
    query: '\u001b]4;16;?\u0007',
    reply: '\u001b]4;16;rgb:0000/0000/0000\u001b\\',
  },
  {
    label: 'osc4-196',
    query: '\u001b]4;196;?\u0007',
    reply: '\u001b]4;196;rgb:ffff/0000/0000\u001b\\',
  },
  {
    label: 'osc4-255',
    query: '\u001b]4;255;?\u0007',
    reply: '\u001b]4;255;rgb:eeee/eeee/eeee\u001b\\',
  },
  {
    label: 'osc10',
    query: '\u001b]10;?\u0007',
    reply: '\u001b]10;rgb:d4d4/d4d4/d4d4\u001b\\',
  },
  {
    label: 'osc11',
    query: '\u001b]11;?\u0007',
    reply: '\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\',
  },
  {
    label: 'osc12',
    query: '\u001b]12;?\u0007',
    reply: '\u001b]12;rgb:d4d4/d4d4/d4d4\u001b\\',
  },
] as const);
const SERVER_QUERY_EXTENSION_CASES = Object.freeze([{
  label: 'private-dsr-996',
  query: '\u001b[?996n',
  reply: '\u001b[?997;1n',
}] as const);
const VIEW_QUERY_CASES = Object.freeze([
  ...BROWSER_NATIVE_QUERY_PARITY_CASES,
  ...SERVER_QUERY_EXTENSION_CASES,
] as const);
const PH005_RETAINED_POLICY_LINES = 128;
const PH005_RETAINED_OVERFLOW_LINES = 64;
const PH005_PRODUCTION_CONFIG_FALLBACK_LINES = 1_000;
const PH005_MAX_POLICY_BOUNDARY_CONTRACT = 'unit-benchmark-only:max-50000-lines';
const PH005_CONFIGURED_TAIL_SUFFIX = '-PH005TAIL';
const E2E_APP_ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';

class RoutedWebSocketHarness {
  private static readonly MAX_ROUTED_FRAME_CAPTURE = 50_000;
  readonly frames: CapturedFrame[] = [];
  readonly blockedPageToServerFrames: CapturedFrame[] = [];
  private droppedRoutedFrameCount = 0;
  private readonly droppedRoutedFramesByType = new Map<string, number>();
  private generationValue = 0;
  private readonly pageOwners = new Map<number, Page>();
  private readonly pageToServerBlockers = new Set<(
    message: JsonFrame,
    generation: number,
  ) => boolean>();
  private readonly connections = new Map<number, {
    page: WebSocketRoute;
    server: WebSocketRoute;
    url: string;
  }>();

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws(?:\?|$)/, (pageRoute) => {
      const generation = ++this.generationValue;
      this.pageOwners.set(generation, page);
      let serverRoute: WebSocketRoute | null = null;
      pageRoute.onMessage((raw) => {
        const frame = {
          direction: 'page-to-server',
          generation,
          origin: 'routed-page',
          message: parseFrame(raw),
        } satisfies CapturedFrame;
        this.captureRoutedFrame(frame);
        if (
          frame.message
          && [...this.pageToServerBlockers].some(blocker => blocker(frame.message!, generation))
        ) {
          this.blockedPageToServerFrames.push(frame);
          return;
        }
        if (!serverRoute) {
          throw new Error('E2E precondition failed: routed WebSocket server endpoint is unavailable');
        }
        serverRoute.send(raw);
      });
      serverRoute = pageRoute.connectToServer();
      this.connections.set(generation, {
        page: pageRoute,
        server: serverRoute,
        url: pageRoute.url(),
      });
      serverRoute.onMessage((raw) => {
        const frame = {
          direction: 'server-to-page',
          generation,
          origin: 'routed-server',
          message: parseFrame(raw),
        } satisfies CapturedFrame;
        this.captureRoutedFrame(frame);
        pageRoute.send(raw);
      });
    });
  }

  private captureRoutedFrame(frame: CapturedFrame): void {
    if (this.frames.length < RoutedWebSocketHarness.MAX_ROUTED_FRAME_CAPTURE) {
      this.frames.push(frame);
      return;
    }
    this.droppedRoutedFrameCount += 1;
    const key = `${frame.direction}:${frame.message?.type ?? 'unparsed'}`;
    this.droppedRoutedFramesByType.set(key, (this.droppedRoutedFramesByType.get(key) ?? 0) + 1);
  }

  get routedFrameOverflowEvidence(): Readonly<{
    droppedFrameCount: number;
    byType: Readonly<Record<string, number>>;
  }> {
    return Object.freeze({
      droppedFrameCount: this.droppedRoutedFrameCount,
      byType: Object.freeze(Object.fromEntries(this.droppedRoutedFramesByType)),
    });
  }

  ownerForGeneration(generation: number): Page | null {
    return this.pageOwners.get(generation) ?? null;
  }

  urlForGeneration(generation: number): string | null {
    return this.connections.get(generation)?.url ?? null;
  }

  blockPageToServer(predicate: (message: JsonFrame, generation: number) => boolean): () => void {
    this.pageToServerBlockers.add(predicate);
    return () => this.pageToServerBlockers.delete(predicate);
  }

  injectToPage(generation: number, message: JsonFrame): void {
    const connection = this.connections.get(generation);
    if (!connection) {
      throw new Error(`E2E precondition failed: WebSocket generation ${generation} is unavailable`);
    }
    this.frames.push({ direction: 'server-to-page', generation, origin: 'test-injection', message });
    connection.page.send(JSON.stringify(message));
  }

  sendToServer(generation: number, message: JsonFrame): void {
    const connection = this.connections.get(generation);
    if (!connection) {
      throw new Error(`E2E precondition failed: WebSocket generation ${generation} is unavailable`);
    }
    this.frames.push({ direction: 'page-to-server', generation, origin: 'test-injection', message });
    connection.server.send(JSON.stringify(message));
  }

  async closeGeneration(generation: number): Promise<void> {
    const connection = this.connections.get(generation);
    if (!connection) {
      throw new Error(`E2E precondition failed: WebSocket generation ${generation} is unavailable`);
    }
    await connection.page.close({ code: 1000, reason: 'ph005-zero-attached-fixture' });
  }

  async closeAllPageConnections(): Promise<void> {
    const connections = [...this.connections.values()];
    await Promise.all(connections.map(async connection => {
      await connection.page.close({
        code: 1000,
        reason: 'ph005-zero-attached-fixture',
      });
    }));
  }

  releaseBlockedFrame(frame: CapturedFrame): number {
    const connection = this.connections.get(frame.generation);
    const blockedIndex = this.blockedPageToServerFrames.indexOf(frame);
    if (!connection || !frame.message || blockedIndex < 0) {
      throw new Error('E2E precondition failed: only a captured blocked browser frame can be released');
    }
    this.blockedPageToServerFrames.splice(blockedIndex, 1);
    const released = {
      direction: 'page-to-server',
      generation: frame.generation,
      origin: 'routed-page',
      message: frame.message,
    } satisfies CapturedFrame;
    this.frames.push(released);
    connection.server.send(JSON.stringify(frame.message));
    return this.frames.length - 1;
  }

  replayBlockedFrameOnLiveConnection(frame: CapturedFrame, liveGeneration: number): number {
    const connection = this.connections.get(liveGeneration);
    if (!connection || !frame.message || !this.blockedPageToServerFrames.includes(frame)) {
      throw new Error('E2E precondition failed: stale replay requires a captured blocked frame and live route');
    }
    const replayed = {
      direction: 'page-to-server',
      generation: liveGeneration,
      origin: 'routed-page',
      message: frame.message,
    } satisfies CapturedFrame;
    this.frames.push(replayed);
    connection.server.send(JSON.stringify(frame.message));
    return this.frames.length - 1;
  }

  latest(
    direction: CapturedFrame['direction'],
    predicate: (message: JsonFrame) => boolean,
    generation?: number,
  ): CapturedFrame | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (
        frame.direction === direction
        && (generation === undefined || frame.generation === generation)
        && frame.message
        && predicate(frame.message)
      ) {
        return frame;
      }
    }
    return null;
  }

  matching(
    direction: CapturedFrame['direction'],
    predicate: (message: JsonFrame) => boolean,
    options: { generation?: number; afterIndex?: number } = {},
  ): CapturedFrame[] {
    const afterIndex = options.afterIndex ?? -1;
    return this.frames.filter((frame, index) => (
      index > afterIndex
      && frame.direction === direction
      && (options.generation === undefined || frame.generation === options.generation)
      && frame.message !== null
      && predicate(frame.message)
    ));
  }

  get connectionCount(): number {
    return this.generationValue;
  }

  get connectionUrls(): readonly string[] {
    return [...this.connections.values()].map(connection => connection.url);
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

function resolveControlGeneration(
  harness: RoutedWebSocketHarness,
  deliveryGeneration: number,
): number {
  const deliveryHandshake = harness.latest(
    'server-to-page',
    message => message.type === 'connected',
    deliveryGeneration,
  )?.message;
  if (deliveryHandshake?.channel !== 'output') return deliveryGeneration;
  const clientGroupId = deliveryHandshake.clientGroupId;
  if (typeof clientGroupId !== 'string') {
    throw new Error('E2E precondition failed: output delivery handshake has no client group identity');
  }
  const controlHandshake = [...harness.frames].reverse().find(frame => (
    frame.direction === 'server-to-page'
    && frame.origin === 'routed-server'
    && frame.message?.type === 'connected'
    && frame.message.channel === 'control'
    && frame.message.clientGroupId === clientGroupId
  ));
  if (!controlHandshake) {
    throw new Error('E2E precondition failed: paired control WebSocket generation is unavailable');
  }
  return controlHandshake.generation;
}

const RESPONDER_IDENTITY_KEYS = [
  'sessionId',
  'connectionId',
  'viewGeneration',
  'transitionEpoch',
  'authorityEpoch',
  'streamEpoch',
  'boundarySourceSeq',
  'responderLeaseId',
] as const;

function sameResponderIdentity(actual: unknown, expected: unknown): boolean {
  if (!actual || typeof actual !== 'object' || !expected || typeof expected !== 'object') return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  return RESPONDER_IDENTITY_KEYS.every(key => actualRecord[key] === expectedRecord[key]);
}

async function waitForSnapshot(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  minimumGeneration = 1,
): Promise<{ generation: number; snapshot: JsonFrame }> {
  await expect.poll(() => harness.latest(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
  )?.generation ?? 0, {
    message: 'E2E precondition failed: live server screen snapshot was not observed',
    timeout: 20_000,
  }).toBeGreaterThanOrEqual(minimumGeneration);
  const frame = harness.latest(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
  );
  if (!frame?.message) {
    throw new Error('E2E precondition failed: live server screen snapshot disappeared');
  }
  return { generation: frame.generation, snapshot: frame.message };
}

async function waitForSessionReady(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  generation: number | undefined,
  replayToken?: unknown,
): Promise<void> {
  const hasSettledSnapshotLineage = (): boolean => {
    if (typeof replayToken !== 'string') {
      return harness.latest(
        'server-to-page',
        message => message.type === 'session:ready' && message.sessionId === sessionId,
        generation,
      ) !== null;
    }
    const acceptedTokens = new Set([replayToken]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const frame of harness.frames) {
        const message = frame.message;
        if ((generation !== undefined && frame.generation !== generation)
          || frame.direction !== 'server-to-page'
          || message?.type !== 'screen-snapshot'
          || message.sessionId !== sessionId
          || typeof message.replayToken !== 'string'
          || typeof message.supersedesReplayToken !== 'string'
          || !acceptedTokens.has(message.supersedesReplayToken)
          || acceptedTokens.has(message.replayToken)) {
          continue;
        }
        acceptedTokens.add(message.replayToken);
        changed = true;
      }
    }
    return harness.frames.some(frame => (
      (generation === undefined || frame.generation === generation)
      && frame.direction === 'server-to-page'
      && frame.message?.type === 'session:ready'
      && frame.message.sessionId === sessionId
      && typeof frame.message.replayToken === 'string'
      && acceptedTokens.has(frame.message.replayToken)
    ));
  };
  try {
    await expect.poll(hasSettledSnapshotLineage, {
      message: 'E2E precondition failed: snapshot replay did not reach session:ready',
      timeout: 20_000,
    }).toBe(true);
  } catch (cause) {
    const replayFrames = harness.frames.filter(frame => (
      (generation === undefined || frame.generation === generation)
      && frame.message?.sessionId === sessionId
      && (frame.message.type === 'screen-snapshot'
        || frame.message.type === 'screen-snapshot:ready'
        || frame.message.type === 'session:ready'
        || frame.message.type === 'replay-repair-required')
    )).map(frame => ({ direction: frame.direction, message: frame.message }));
    throw new Error(
      `E2E precondition failed: snapshot replay did not settle; replayFrames=${JSON.stringify(replayFrames)}`,
      { cause },
    );
  }
}

async function waitForViewGeneration(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  generation: number,
  afterFrameIndex = -1,
): Promise<number> {
  const readViewGeneration = (): number | null => {
    const negotiations = harness.matching(
      'page-to-server',
      message => message.type === 'terminal-checkpoint:negotiate',
      { generation, afterIndex: afterFrameIndex },
    );
    for (let index = negotiations.length - 1; index >= 0; index -= 1) {
      const views = negotiations[index].message?.views;
      if (!Array.isArray(views)) continue;
      const matchingViewGenerations = views.filter(candidate => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as Record<string, unknown>).sessionId === sessionId
        && Number.isSafeInteger((candidate as Record<string, unknown>).viewGeneration)
      )).map(candidate => (candidate as Record<string, unknown>).viewGeneration as number);
      if (matchingViewGenerations.length > 0) return Math.max(...matchingViewGenerations);
    }
    return null;
  };
  await expect.poll(readViewGeneration, {
    message: 'E2E precondition failed: checkpoint view registration was not observed',
    timeout: 15_000,
  }).not.toBeNull();
  const viewGeneration = readViewGeneration();
  if (viewGeneration === null) {
    throw new Error('E2E precondition failed: checkpoint view registration disappeared');
  }
  return viewGeneration;
}

interface TerminalViewRegistration {
  frameIndex: number;
  generation: number;
  viewGeneration: number;
}

function readLatestTerminalViewRegistration(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  afterFrameIndex = -1,
  owner?: Page,
  origin?: CapturedFrame['origin'],
): TerminalViewRegistration | null {
  for (let frameIndex = harness.frames.length - 1; frameIndex > afterFrameIndex; frameIndex -= 1) {
    const frame = harness.frames[frameIndex]!;
    if (frame.direction !== 'page-to-server'
      || frame.message?.type !== 'terminal-checkpoint:negotiate'
      || !Array.isArray(frame.message.views)
      || (owner && harness.ownerForGeneration(frame.generation) !== owner)
      || (origin && frame.origin !== origin)) {
      continue;
    }
    const viewGenerations = frame.message.views.filter(candidate => (
      typeof candidate === 'object'
      && candidate !== null
      && (candidate as Record<string, unknown>).sessionId === sessionId
      && Number.isSafeInteger((candidate as Record<string, unknown>).viewGeneration)
    )).map(candidate => Number((candidate as Record<string, unknown>).viewGeneration));
    if (viewGenerations.length === 0) continue;
    return {
      frameIndex,
      generation: frame.generation,
      viewGeneration: Math.max(...viewGenerations),
    };
  }
  return null;
}

async function waitForLatestTerminalViewRegistration(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  afterFrameIndex = -1,
  owner?: Page,
): Promise<TerminalViewRegistration> {
  await expect.poll(() => readLatestTerminalViewRegistration(harness, sessionId, afterFrameIndex, owner), {
    message: 'E2E precondition failed: latest checkpoint view registration was not observed',
    timeout: 15_000,
  }).not.toBeNull();
  const registration = readLatestTerminalViewRegistration(harness, sessionId, afterFrameIndex, owner);
  if (!registration) {
    throw new Error('E2E precondition failed: latest checkpoint view registration disappeared');
  }
  return registration;
}

function readLatestSettledSnapshot(
  harness: RoutedWebSocketHarness,
  page: Page,
  sessionId: string,
  afterFrameIndex: number,
): JsonFrame | null {
  for (let readyIndex = harness.frames.length - 1; readyIndex > afterFrameIndex; readyIndex -= 1) {
    const ready = harness.frames[readyIndex]!;
    if (ready.direction !== 'server-to-page'
      || ready.message?.type !== 'session:ready'
      || ready.message.sessionId !== sessionId
      || typeof ready.message.replayToken !== 'string'
      || harness.ownerForGeneration(ready.generation) !== page) {
      continue;
    }
    for (let snapshotIndex = readyIndex - 1; snapshotIndex > afterFrameIndex; snapshotIndex -= 1) {
      const snapshot = harness.frames[snapshotIndex]!;
      if (snapshot.direction === 'server-to-page'
        && snapshot.message?.type === 'screen-snapshot'
        && snapshot.message.sessionId === sessionId
        && snapshot.message.replayToken === ready.message.replayToken
        && harness.ownerForGeneration(snapshot.generation) === page) {
        return snapshot.message;
      }
    }
  }
  return null;
}

async function waitForLatestSettledSnapshot(
  harness: RoutedWebSocketHarness,
  page: Page,
  sessionId: string,
  afterFrameIndex: number,
): Promise<JsonFrame> {
  await expect.poll(() => readLatestSettledSnapshot(harness, page, sessionId, afterFrameIndex), {
    message: 'E2E precondition failed: page-owned snapshot replay did not settle',
    timeout: 20_000,
  }).not.toBeNull();
  const snapshot = readLatestSettledSnapshot(harness, page, sessionId, afterFrameIndex);
  if (!snapshot) {
    throw new Error('E2E precondition failed: page-owned settled snapshot disappeared');
  }
  return snapshot;
}

async function waitForAcceptedViewAttributes(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  generation: number,
  viewGeneration: number,
  requireDriverAcceptance = true,
  acceptanceTimeoutMs = 20_000,
  afterFrameIndex = -1,
): Promise<void> {
  // @req MIG-BGSTAB-002 AC-4 AC-3
  // A no-cache/reload view is not query-authoritative until its current
  // challenge and complete ordered palette are attested by the server.
  let requestFrameIndex = -1;
  try {
    const findRequestFrameIndex = (): boolean => {
      requestFrameIndex = harness.frames.findIndex((frame, index) => (
        index > afterFrameIndex
        && frame.direction === 'page-to-server'
        && frame.origin === 'routed-page'
        && frame.generation === generation
        && frame.message?.type === 'terminal-authority:view-attributes'
        && frame.message.sessionId === sessionId
        && frame.message.viewGeneration === viewGeneration
      ));
      return requestFrameIndex >= 0;
    };
    await expect.poll(findRequestFrameIndex, {
      message: 'E2E precondition failed: terminal query responder view attributes were not sent',
      timeout: 15_000,
    }).toBe(true);
    const request = harness.frames[requestFrameIndex]?.message;
    const requestAttributes = request?.attributes as Record<string, unknown> | undefined;
    const ansi = requestAttributes?.ansi;
    expect(Array.isArray(ansi) ? ansi.length : -1, 'browser must register the full xterm palette').toBe(256);
    expect([0, 15, 16, 17, 196, 232, 255].map(index => (
      Array.isArray(ansi) ? ansi[index] : null
    ))).toEqual([
      [0, 0, 0], [255, 255, 255], [0, 0, 0], [0, 0, 95],
      [255, 0, 0], [8, 8, 8], [238, 238, 238],
    ]);
    expect(typeof request?.viewAttributesChallengeId).toBe('string');
    const orderedAttributesBytes = Buffer.from(JSON.stringify(requestAttributes), 'utf8');
    const orderedAttributesSha256 = createHash('sha256').update(orderedAttributesBytes).digest('hex');
    const accepted = () => harness.frames.slice(requestFrameIndex + 1).some(frame => (
      frame.direction === 'server-to-page'
      && frame.generation === generation
      && frame.origin === 'routed-server'
      && frame.message?.type === 'terminal-authority:view-attributes-accepted'
      && frame.message.sessionId === sessionId
      && frame.message.viewGeneration === viewGeneration
      && frame.message.viewAttributesChallengeId === request?.viewAttributesChallengeId
      && frame.message.acceptedViewAttributesByteLength === orderedAttributesBytes.byteLength
      && frame.message.acceptedViewAttributesSha256 === orderedAttributesSha256
      && (!requireDriverAcceptance || frame.message.accepted === true)
    ));
    const acceptanceDeadline = Date.now() + acceptanceTimeoutMs;
    while (!accepted() && Date.now() < acceptanceDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!accepted()) {
      throw new Error(
        `E2E precondition failed: terminal query responder view attributes were not accepted`
        + `; expectedGeneration=${generation}; expectedViewGeneration=${viewGeneration}`,
      );
    }
  } catch (error) {
    const evidence = harness.frames.slice(Math.max(0, requestFrameIndex)).filter(frame => (
      (
        frame.message?.sessionId === sessionId
        || (frame.message?.type === 'terminal-checkpoint:negotiate'
          && Array.isArray(frame.message.views)
          && frame.message.views.some(view => (
            typeof view === 'object' && view !== null && view.sessionId === sessionId
          )))
      ) && (
        frame.message?.type === 'terminal-authority:view-attributes'
        || frame.message?.type === 'terminal-authority:view-attributes-accepted'
        || frame.message?.type === 'terminal-checkpoint:capability'
        || frame.message?.type === 'terminal-checkpoint:negotiate'
      )
    )).slice(-12);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}`
      + `; expectedGeneration=${generation}; expectedViewGeneration=${viewGeneration}`
      + `; evidence=${JSON.stringify(evidence)}`,
    );
  }
}

async function settleLiveTerminal(
  harness: RoutedWebSocketHarness,
  page: Page,
  sessionId: string,
  requireDriverAcceptance: boolean,
  afterFrameIndex = -1,
): Promise<LiveTerminal> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = await waitForLatestSettledSnapshot(harness, page, sessionId, afterFrameIndex);
    let attemptedRegistration: TerminalViewRegistration | null = null;
    try {
      const registration = await waitForLatestTerminalViewRegistration(
        harness,
        sessionId,
        afterFrameIndex,
        page,
      );
      attemptedRegistration = registration;
      await waitForAcceptedViewAttributes(
        harness,
        sessionId,
        registration.generation,
        registration.viewGeneration,
        requireDriverAcceptance,
        5_000,
        afterFrameIndex,
      );
      await page.evaluate(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      });
      if (readLatestTerminalViewRegistration(
        harness,
        sessionId,
        afterFrameIndex,
        page,
      )?.frameIndex !== registration.frameIndex) {
        continue;
      }
      return {
        sessionId,
        generation: registration.generation,
        snapshot,
        viewGeneration: registration.viewGeneration,
      };
    } catch (error) {
      lastError = error;
      const latestRegistration = readLatestTerminalViewRegistration(
        harness,
        sessionId,
        afterFrameIndex,
        page,
      );
      if (!attemptedRegistration
        || !latestRegistration
        || latestRegistration.frameIndex <= attemptedRegistration.frameIndex) {
        throw error;
      }
    }
  }
  throw new Error(
    `E2E precondition failed: terminal view generation did not settle for ${sessionId}`,
    { cause: lastError },
  );
}

function formatErrorForDiagnostic(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function stabilizeLiveTerminalRegistration(
  harness: RoutedWebSocketHarness,
  page: Page,
  live: LiveTerminal,
  requireDriverAcceptance = true,
): Promise<LiveTerminal> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const registration = readLatestTerminalViewRegistration(
      harness,
      live.sessionId,
      -1,
      page,
      'routed-page',
    );
    const negotiation = registration ? harness.frames[registration.frameIndex]?.message : null;
    if (!registration || negotiation?.type !== 'terminal-checkpoint:negotiate') {
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    const generation = resolveControlGeneration(harness, registration.generation);
    try {
      await expect.poll(() => harness.frames.slice(registration.frameIndex + 1).some(frame => (
        frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && frame.generation === generation
        && frame.message?.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.message.registeredViews)
        && frame.message.registeredViews.some(view => (
          view !== null
          && typeof view === 'object'
          && (view as Record<string, unknown>).sessionId === live.sessionId
          && (view as Record<string, unknown>).viewGeneration === registration.viewGeneration
        ))
      )), {
        message: 'terminal registration refresh did not produce a matching server capability',
        timeout: 5_000,
      }).toBe(true);
      await waitForAcceptedViewAttributes(
        harness,
        live.sessionId,
        generation,
        registration.viewGeneration,
        requireDriverAcceptance,
        5_000,
        -1,
      );
    } catch (error) {
      lastError = error;
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    const latest = readLatestTerminalViewRegistration(
      harness,
      live.sessionId,
      -1,
      page,
      'routed-page',
    );
    if (!latest
      || latest.generation !== registration.generation
      || latest.viewGeneration !== registration.viewGeneration) {
      continue;
    }
    return {
      ...live,
      generation,
      viewGeneration: registration.viewGeneration,
    };
  }
  const registrations = harness.frames.filter(frame => (
    frame.message?.type === 'terminal-checkpoint:negotiate'
    && Array.isArray(frame.message.views)
    && frame.message.views.some(view => (
      view !== null
      && typeof view === 'object'
      && (view as Record<string, unknown>).sessionId === live.sessionId
    ))
  )).slice(-30).map(frame => ({
    generation: frame.generation,
    origin: frame.origin,
    viewGenerations: (frame.message!.views as Array<Record<string, unknown>>)
      .filter(view => view.sessionId === live.sessionId)
      .map(view => view.viewGeneration),
  }));
  throw new Error(
    `E2E precondition failed: terminal registration did not stabilize for ${live.sessionId}; `
    + `registrations=${JSON.stringify(registrations)}; `
    + `lastError=${formatErrorForDiagnostic(lastError)}`,
  );
}

async function bootLiveTerminal(page: Page, harness: RoutedWebSocketHarness): Promise<LiveTerminal> {
  await harness.install(page);
  const bootFrameStart = harness.frames.length - 1;
  await login(page);
  await ensureOwnedAuthorityWorkspace(page);
  await waitForTerminal(page);
  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
  return settleLiveTerminal(harness, page, sessionId!, true, bootFrameStart);
}

async function bootAuthenticatedPeer(page: Page, harness: RoutedWebSocketHarness): Promise<LiveTerminal> {
  await harness.install(page);
  const bootFrameStart = harness.frames.length - 1;
  await page.goto('/');
  await page.waitForSelector('.workspace-screen', { timeout: 10_000 });
  await waitForTerminal(page);
  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'E2E precondition failed: peer terminal session is unavailable').not.toBeNull();
  return settleLiveTerminal(harness, page, sessionId!, false, bootFrameStart);
}

async function waitForReplacementLiveTerminal(
  page: Page,
  harness: RoutedWebSocketHarness,
  previous: LiveTerminal,
  attributeAcceptanceTimeoutMs = 20_000,
  allowPromotionSupersession = false,
): Promise<LiveTerminal> {
  const beforeReloadFrameIndex = harness.frames.length - 1;
  await page.reload();
  await waitForTerminal(page);
  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'hard reload changed the live session identity').toBe(previous.sessionId);
  const readLatestAcceptedResponder = (): { generation: number; viewGeneration: number } | null => {
    for (let requestIndex = harness.frames.length - 1; requestIndex > beforeReloadFrameIndex; requestIndex -= 1) {
      const request = harness.frames[requestIndex];
      if (request.direction !== 'page-to-server'
        || request.message?.type !== 'terminal-authority:view-attributes'
        || request.message.sessionId !== previous.sessionId
        || !Number.isSafeInteger(request.message.viewGeneration)) {
        continue;
      }
      const accepted = harness.frames.slice(requestIndex + 1).some(frame => (
        frame.direction === 'server-to-page'
        && frame.generation === request.generation
        && frame.origin === 'routed-server'
        && frame.message?.type === 'terminal-authority:view-attributes-accepted'
        && frame.message.sessionId === previous.sessionId
        && frame.message.viewGeneration === request.message?.viewGeneration
        && frame.message.accepted === true
      ));
      if (accepted) {
        return {
          generation: request.generation,
          viewGeneration: request.message.viewGeneration as number,
        };
      }
    }
    return null;
  };
  await expect.poll(readLatestAcceptedResponder, {
    message: 'E2E precondition failed: replacement terminal responder was not accepted',
    timeout: attributeAcceptanceTimeoutMs,
  }).not.toBeNull();
  const acceptedResponder = readLatestAcceptedResponder();
  if (!acceptedResponder) {
    throw new Error('E2E precondition failed: replacement terminal responder acceptance disappeared');
  }
  if (allowPromotionSupersession) {
    const readLatestSnapshot = (): JsonFrame | null => harness.latest(
      'server-to-page',
      message => message.type === 'screen-snapshot' && message.sessionId === previous.sessionId,
      acceptedResponder.generation,
    )?.message ?? null;
    await expect.poll(readLatestSnapshot, {
      message: 'E2E precondition failed: promotion responder has no matching server snapshot',
      timeout: 20_000,
    }).not.toBeNull();
    const latestSnapshot = readLatestSnapshot();
    if (!latestSnapshot) {
      throw new Error('E2E precondition failed: promotion responder snapshot disappeared');
    }
    return {
      sessionId: previous.sessionId,
      generation: acceptedResponder.generation,
      snapshot: latestSnapshot,
      viewGeneration: acceptedResponder.viewGeneration,
    };
  }
  const readSettledSnapshot = (): { generation: number; snapshot: JsonFrame } | null => {
    for (let readyIndex = harness.frames.length - 1; readyIndex > beforeReloadFrameIndex; readyIndex -= 1) {
      const readyFrame = harness.frames[readyIndex];
      if (readyFrame.direction !== 'server-to-page'
        || readyFrame.origin !== 'routed-server'
        || readyFrame.message?.type !== 'session:ready'
        || readyFrame.message.sessionId !== previous.sessionId
        || typeof readyFrame.message.replayToken !== 'string'
        || harness.ownerForGeneration(readyFrame.generation) !== page) {
        continue;
      }
      const snapshotFrame = harness.frames.slice(beforeReloadFrameIndex + 1, readyIndex + 1)
        .reverse()
        .find(frame => (
          frame.direction === 'server-to-page'
          && frame.origin === 'routed-server'
          && frame.generation === readyFrame.generation
          && frame.message?.type === 'screen-snapshot'
          && frame.message.sessionId === previous.sessionId
          && frame.message.replayToken === readyFrame.message?.replayToken
        ));
      if (snapshotFrame?.message) {
        return { generation: readyFrame.generation, snapshot: snapshotFrame.message };
      }
    }
    return null;
  };
  await expect.poll(readSettledSnapshot, {
    message: 'E2E precondition failed: accepted replacement responder has no settled snapshot/ready pair',
    timeout: 20_000,
  }).not.toBeNull();
  const settledSnapshot = readSettledSnapshot();
  if (!settledSnapshot) {
    throw new Error('E2E precondition failed: replacement snapshot/ready pair disappeared');
  }
  return {
    sessionId: previous.sessionId,
    generation: settledSnapshot.generation,
    snapshot: settledSnapshot.snapshot,
    viewGeneration: acceptedResponder.viewGeneration,
  };
}

async function waitForServerAuthorityReplacementLiveTerminal(
  page: Page,
  harness: RoutedWebSocketHarness,
  previous: LiveTerminal,
  timeoutMs = 20_000,
  navigateToApp = false,
): Promise<LiveTerminal> {
  const beforeReloadFrameIndex = harness.frames.length - 1;
  await page.addInitScript((sessionId) => {
    const enableDebug = () => {
      if (!window.__buildergateTerminalDebug) return false;
      window.__buildergateTerminalDebug.enable(sessionId);
      return true;
    };
    if (enableDebug()) return;
    const timer = window.setInterval(() => {
      if (enableDebug()) window.clearInterval(timer);
    }, 0);
  }, previous.sessionId);
  if (navigateToApp) {
    await page.goto('/');
  } else {
    await page.reload();
  }
  await waitForTerminal(page);
  await page.evaluate((requestedSessionId) => {
    window.__buildergateTerminalDebug?.enable(requestedSessionId);
  }, previous.sessionId);
  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'hard reload changed the server-authority session identity').toBe(previous.sessionId);
  const readSettledServerView = (): LiveTerminal | null => {
    for (let readyIndex = harness.frames.length - 1; readyIndex > beforeReloadFrameIndex; readyIndex -= 1) {
      const readyFrame = harness.frames[readyIndex];
      if (readyFrame.direction !== 'server-to-page'
        || readyFrame.message?.type !== 'session:ready'
        || readyFrame.message.sessionId !== previous.sessionId
        || typeof readyFrame.message.replayToken !== 'string') {
        continue;
      }
      const snapshotFrame = harness.frames.slice(beforeReloadFrameIndex + 1, readyIndex + 1)
        .reverse()
        .find(frame => (
          frame.direction === 'server-to-page'
          && frame.generation === readyFrame.generation
          && frame.message?.type === 'screen-snapshot'
          && frame.message.sessionId === previous.sessionId
          && frame.message.replayToken === readyFrame.message?.replayToken
        ));
      if (!snapshotFrame?.message) continue;
      const negotiations = harness.matching(
        'page-to-server',
        message => message.type === 'terminal-checkpoint:negotiate',
        { generation: readyFrame.generation, afterIndex: beforeReloadFrameIndex },
      );
      const viewGenerations = negotiations.flatMap(frame => (
        Array.isArray(frame.message?.views)
          ? frame.message.views.filter(candidate => (
              typeof candidate === 'object'
              && candidate !== null
              && (candidate as Record<string, unknown>).sessionId === previous.sessionId
              && Number.isSafeInteger((candidate as Record<string, unknown>).viewGeneration)
            )).map(candidate => (candidate as Record<string, unknown>).viewGeneration as number)
          : []
      ));
      if (viewGenerations.length === 0) continue;
      return {
        sessionId: previous.sessionId,
        generation: readyFrame.generation,
        snapshot: snapshotFrame.message,
        viewGeneration: Math.max(...viewGenerations),
      };
    }
    return null;
  };
  try {
    await expect.poll(readSettledServerView, {
      message: 'E2E precondition failed: server-authority replacement did not settle snapshot/ready/view lineage',
      timeout: timeoutMs,
    }).not.toBeNull();
  } catch (cause) {
    const replacementFrames = harness.frames.slice(beforeReloadFrameIndex + 1)
      .filter(frame => frame.message?.sessionId === previous.sessionId || frame.message?.type === 'connected')
      .slice(-80)
      .map(frame => ({
        direction: frame.direction,
        generation: frame.generation,
        origin: frame.origin,
        type: frame.message?.type,
        sessionId: frame.message?.sessionId,
        replayToken: frame.message?.replayToken,
        viewGeneration: frame.message?.viewGeneration,
        authorityMode: frame.message?.authorityMode,
        checkpointDeliveryPreparation: frame.message?.checkpointDeliveryPreparation,
      }));
    const clientEvents = await page.evaluate((sessionId) => (
      window.__buildergateTerminalDebug?.getEvents(sessionId).filter(event => (
        event.kind.includes('snapshot')
        || event.kind.includes('authority')
        || event.kind.includes('restore')
        || event.kind.includes('recovery')
      )).slice(-40) ?? []
    ), previous.sessionId);
    throw new Error(
      'E2E precondition failed: server-authority replacement did not settle snapshot/ready/view lineage; '
      + `replacementFrames=${JSON.stringify(replacementFrames)}; clientEvents=${JSON.stringify(clientEvents)}`,
      { cause },
    );
  }
  const settled = readSettledServerView();
  if (!settled) throw new Error('E2E precondition failed: settled server-authority replacement disappeared');
  return settled;
}

function outputSequence(snapshot: JsonFrame, increment = 1): number {
  return Number(snapshot.seq ?? snapshot.screenSeq ?? 0) + increment;
}

function injectOutput(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
  data: string,
  extra: Record<string, unknown> = {},
): number {
  const owner = harness.ownerForGeneration(live.generation);
  const registration = readLatestTerminalViewRegistration(
    harness,
    live.sessionId,
    -1,
    owner,
    'routed-page',
  );
  const generation = registration?.generation ?? live.generation;
  const snapshot = harness.latest(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === live.sessionId,
    generation,
  )?.message ?? live.snapshot;
  harness.injectToPage(generation, {
    type: 'output',
    sessionId: live.sessionId,
    data,
    replayToken: snapshot.replayToken,
    screenSeq: outputSequence(snapshot),
    chunkId: `ph005-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...extra,
  });
  return generation;
}

async function waitForInputFrame(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  data: string,
  options: { generation?: number; afterIndex?: number } = {},
): Promise<CapturedFrame> {
  const read = () => harness.matching(
    'page-to-server',
    message => message.type === 'input' && message.sessionId === sessionId && message.data === data,
    options,
  );
  await expect.poll(() => read().length, {
    message: `E2E precondition failed: xterm parser did not emit ${JSON.stringify(data)}`,
    timeout: 10_000,
  }).toBeGreaterThan(0);
  return read().at(-1)!;
}

function visibleSessionRuntime(page: Page, sessionId: string) {
  return page.locator(
    `[data-terminal-runtime-entry="true"][data-session-id="${sessionId}"]:visible`,
  ).first();
}

async function waitForVisibleTerminalInputReady(
  page: Page,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const diagnosticsArmed = await page.evaluate((targetSessionId) => {
    const debug = window.__buildergateTerminalDebug;
    if (!debug) return false;
    debug.enable(targetSessionId);
    return true;
  }, sessionId);
  expect(diagnosticsArmed).toBe(true);
  const readGate = () => page.evaluate((targetSessionId) => {
      const gate = window.__buildergateTerminalDebug?.readInputGateSnapshot(targetSessionId) ?? null;
      const runtimes = Array.from(document.querySelectorAll<HTMLElement>(
        `[data-terminal-runtime-entry="true"][data-session-id="${CSS.escape(targetSessionId)}"]`,
      ));
      const runtime = runtimes.find(candidate => candidate.getClientRects().length > 0) ?? null;
      const textarea = runtime?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null;
      textarea?.focus({ preventScroll: true });
      return {
        gate,
        helperReady: Boolean(
          textarea?.isConnected
          && !textarea.disabled
          && textarea === document.activeElement
        ),
      };
    }, sessionId);
  try {
    await expect.poll(async () => {
      const snapshot = await readGate();
    return {
      helperReady: snapshot.helperReady,
      currentMountOpen: snapshot.gate?.inputReady === true
        && snapshot.gate.captureState === 'open'
        && snapshot.gate.barrierReason === 'none',
      gate: snapshot.gate,
    };
  }, {
    message: 'visible terminal input gate and focused helper did not converge on the current mount',
    timeout: timeoutMs,
  }).toMatchObject({
    helperReady: true,
    currentMountOpen: true,
  });
  } catch (error) {
    const snapshot = await readGate();
    const events = await page.evaluate((targetSessionId) => (
      window.__buildergateTerminalDebug?.getEvents(targetSessionId).slice(-40).map(event => ({
        kind: event.kind,
        details: event.details,
      })) ?? []
    ), sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; `
      + `inputGate=${JSON.stringify(snapshot.gate)}; events=${JSON.stringify(events)}`,
    );
  }
}

async function sendVisibleTerminalCommand(
  page: Page,
  sessionId: string,
  command: string,
  options: { normalizeVisiblePrompt?: boolean } = {},
): Promise<void> {
  const runtime = visibleSessionRuntime(page, sessionId);
  const input = runtime.locator('.xterm-helper-textarea');
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  if (options.normalizeVisiblePrompt !== false) {
    await page.keyboard.press('Control+C');
    await expect.poll(async () => (
      await runtime.locator('.xterm-rows').textContent()
    ) ?? '', { timeout: 10_000 }).toMatch(/PS\s+[^>]*>\s*$/u);
  }
  await page.keyboard.type(command, { delay: 0 });
  await page.keyboard.press('Enter');
}

async function waitForCommandMarker(
  page: Page,
  sessionId: string,
  marker: string,
  timeoutMs = 20_000,
): Promise<void> {
  await expect.poll(async () => (
    await visibleSessionRuntime(page, sessionId).locator('.xterm-rows').textContent()
  ) ?? '', {
    message: `PTY command marker ${marker} did not render`,
    timeout: timeoutMs,
  }).toContain(marker);
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

async function ensureOwnedAuthorityWorkspace(page: Page): Promise<void> {
  const owned = await page.evaluate(async ({ workspacePrefix }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const existingId = localStorage.getItem('ph005_authority_workspace_id');
    const existingName = localStorage.getItem('ph005_authority_workspace_name');
    if (existingId && existingName) {
      const stateResponse = await fetch('/api/workspaces', { headers });
      if (stateResponse.ok) {
        const state = await stateResponse.json() as { workspaces?: Array<{ id?: unknown }> };
        if (state.workspaces?.some(workspace => workspace.id === existingId)) {
          return { id: existingId, name: existingName };
        }
      }
    }

    const stateResponse = await fetch('/api/workspaces', { headers });
    if (!stateResponse.ok) {
      throw new Error(`E2E precondition failed: authority workspace inventory returned ${stateResponse.status}`);
    }
    const state = await stateResponse.json() as {
      workspaces?: Array<{ id: string; name: string }>;
    };
    for (const stale of state.workspaces?.filter(
      workspace => workspace.name.startsWith(workspacePrefix),
    ) ?? []) {
      const deleteResponse = await fetch(`/api/workspaces/${stale.id}`, { method: 'DELETE', headers });
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`E2E precondition failed: stale authority workspace delete returned ${deleteResponse.status}`);
      }
    }

    const name = `${workspacePrefix}${Date.now()}`;
    const createWorkspace = () => fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name }),
    });
    let workspaceResponse = await createWorkspace();
    for (let attempt = 0; workspaceResponse.status === 409 && attempt < 20; attempt += 1) {
      const stateResponse = await fetch('/api/workspaces', { headers });
      if (!stateResponse.ok) break;
      const state = await stateResponse.json() as {
        workspaces?: Array<{ id: string; name: string }>;
      };
      const stale = state.workspaces?.find(workspace => workspace.name.startsWith(workspacePrefix));
      if (!stale) break;
      const deleteResponse = await fetch(`/api/workspaces/${stale.id}`, { method: 'DELETE', headers });
      if (!deleteResponse.ok && deleteResponse.status !== 404) break;
      workspaceResponse = await createWorkspace();
    }
    if (!workspaceResponse.ok) {
      const failureBody = await workspaceResponse.text();
      throw new Error(
        `E2E precondition failed: authority workspace create returned ${workspaceResponse.status}: ${failureBody}`,
      );
    }
    const workspace = await workspaceResponse.json() as { id?: unknown; name?: unknown };
    if (typeof workspace.id !== 'string' || typeof workspace.name !== 'string') {
      throw new Error('E2E precondition failed: authority workspace identity is unavailable');
    }
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabResponse.ok) {
      await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE', headers });
      throw new Error(`E2E precondition failed: authority workspace tab create returned ${tabResponse.status}`);
    }
    localStorage.setItem('ph005_authority_workspace_id', workspace.id);
    localStorage.setItem('ph005_authority_workspace_name', workspace.name);
    return { id: workspace.id, name: workspace.name };
  }, { workspacePrefix: AUTHORITY_WORKSPACE_PREFIX });
  await page.evaluate(({ id }) => localStorage.setItem('active_workspace_id', id), owned);
  await page.reload();
  await page.getByRole('option', { name: owned.name }).click();
  await page.waitForTimeout(250);
}

async function deleteOwnedAuthorityWorkspace(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspaceId = localStorage.getItem('ph005_authority_workspace_id');
    localStorage.removeItem('ph005_authority_workspace_id');
    localStorage.removeItem('ph005_authority_workspace_name');
    if (!workspaceId) return;
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/workspaces/${workspaceId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`E2E cleanup failed: authority workspace delete returned ${response.status}`);
    }
  });
}

async function createUnselectedSession(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name: `PH005-unselected-${Date.now()}`, shell: 'powershell' }),
    });
    if (!response.ok) {
      throw new Error(`E2E precondition failed: unselected peer session create returned ${response.status}`);
    }
    const session = await response.json() as { id?: unknown };
    if (typeof session.id !== 'string' || session.id.length === 0) {
      throw new Error('E2E precondition failed: unselected peer session identity is unavailable');
    }
    return session.id;
  });
}

async function deleteOwnedSession(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (ownedSessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/${ownedSessionId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`E2E cleanup failed: owned session delete returned ${response.status}`);
    }
  }, sessionId);
}

interface CleanupTask {
  name: string;
  run: () => void | Promise<unknown>;
}

async function runCleanupTasks(scope: string, tasks: CleanupTask[]): Promise<void> {
  const failures: Array<{ name: string; reason: unknown }> = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (reason) {
      failures.push({ name: task.name, reason });
    }
  }
  if (failures.length === 0) return;
  const details = failures.map(({ name, reason }) => (
    `${name}: ${reason instanceof Error ? reason.message : String(reason)}`
  ));
  throw new Error(`E2E cleanup failed (${scope}); all cleanup actions were attempted: ${details.join(' | ')}`);
}

function requestServerAuthorityCanary(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
): string {
  const requestId = `ph005-canary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  harness.sendToServer(resolveLatestControlGeneration(harness, live), {
    type: 'terminal-authority:canary-request',
    requestId,
    trigger: 'https-e2e-server-policy-evaluation',
  });
  return requestId;
}

function resolveLatestControlGeneration(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
): number {
  const owner = harness.ownerForGeneration(live.generation);
  const latestRegistration = readLatestTerminalViewRegistration(
    harness,
    live.sessionId,
    -1,
    owner,
    'routed-page',
  );
  return resolveControlGeneration(harness, latestRegistration?.generation ?? live.generation);
}

async function sendCommandThroughCurrentMutationLease(
  harness: RoutedWebSocketHarness,
  sessionId: string,
  command: string,
  owner: Page,
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const registration = readLatestTerminalViewRegistration(
      harness,
      sessionId,
      -1,
      owner,
      'routed-page',
    );
    const negotiation = registration ? harness.frames[registration.frameIndex]?.message : null;
    if (!registration || negotiation?.type !== 'terminal-checkpoint:negotiate') {
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    const generation = resolveControlGeneration(harness, registration.generation);
    const capabilityStart = harness.frames.length;
    harness.sendToServer(generation, negotiation);
    const capabilityDeadline = Date.now() + 2_000;
    let driverCapability: CapturedFrame | undefined;
    while (!driverCapability && Date.now() < capabilityDeadline) {
      driverCapability = harness.frames.slice(capabilityStart).find(frame => (
        frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && resolveControlGeneration(harness, frame.generation) === generation
        && frame.message?.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.message.mutationLeases)
        && frame.message.mutationLeases.some(lease => (
          lease !== null
          && typeof lease === 'object'
          && (lease as Record<string, unknown>).sessionId === sessionId
          && (lease as Record<string, unknown>).viewGeneration === registration.viewGeneration
        ))
      ));
      if (!driverCapability) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!driverCapability) continue;
    const latestRegistration = readLatestTerminalViewRegistration(
      harness,
      sessionId,
      -1,
      owner,
      'routed-page',
    );
    if (latestRegistration?.frameIndex !== registration.frameIndex) continue;
    harness.sendToServer(generation, {
      type: 'input',
      sessionId,
      data: `${command}\r`,
    });
    return generation;
  }
  throw new Error(`E2E precondition failed: no stable mutation lease exists for ${sessionId}`);
}

async function registerCapableUnselectedResponder(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
  unselectedSessionId: string,
): Promise<LiveTerminal> {
  const evidenceStart = harness.frames.length - 1;
  let current = live;
  const owner = harness.ownerForGeneration(live.generation);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latestRegistration = readLatestTerminalViewRegistration(harness, live.sessionId, -1, owner);
    if (latestRegistration) {
      current = {
        ...current,
        generation: latestRegistration.generation,
        viewGeneration: latestRegistration.viewGeneration,
      };
    }
    unsubscribeUnrelatedSessions(harness, current);
    const subscriptionFrameStart = harness.frames.length - 1;
    const capabilityFrameStart = harness.frames.length - 1;
    harness.sendToServer(current.generation, {
      type: 'subscribe',
      sessionIds: [current.sessionId, unselectedSessionId],
    });
    const snapshotDeadline = Date.now() + 5_000;
    let unselectedSnapshotFrame: CapturedFrame | undefined;
    while (!unselectedSnapshotFrame && Date.now() < snapshotDeadline) {
      unselectedSnapshotFrame = harness.matching(
        'server-to-page',
        message => message.type === 'screen-snapshot' && message.sessionId === unselectedSessionId,
        { afterIndex: subscriptionFrameStart },
      ).at(-1);
      if (!unselectedSnapshotFrame) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const unselectedSnapshot = unselectedSnapshotFrame?.message;
    if (!unselectedSnapshotFrame || !unselectedSnapshot) continue;
    harness.sendToServer(resolveControlGeneration(harness, unselectedSnapshotFrame.generation), {
      type: 'screen-snapshot:ready',
      sessionId: unselectedSessionId,
      replayToken: unselectedSnapshot.replayToken,
      snapshotSeq: unselectedSnapshot.seq,
    });
    const readyFrame = await waitForRoutedServerFrame(
      harness,
      message => message.type === 'session:ready'
        && message.sessionId === unselectedSessionId
        && message.replayToken === unselectedSnapshot.replayToken,
      5_000,
    );
    if (!readyFrame) continue;
    const settledRegistration = readLatestTerminalViewRegistration(harness, live.sessionId, -1, owner);
    if (settledRegistration) {
      current = {
        ...current,
        generation: settledRegistration.generation,
        viewGeneration: settledRegistration.viewGeneration,
      };
    }
    harness.sendToServer(current.generation, {
      type: 'terminal-checkpoint:negotiate',
      protocolVersion: 1,
      views: [
        {
          sessionId: current.sessionId,
          viewGeneration: current.viewGeneration,
          queryReplyCapability: 'terminal.query-reply-input.v1',
          parserResponderCapability: 'terminal.parser-responder-disable.v1',
        },
        {
          sessionId: unselectedSessionId,
          viewGeneration: 1,
          queryReplyCapability: 'terminal.query-reply-input.v1',
          parserResponderCapability: 'terminal.parser-responder-disable.v1',
        },
      ],
    });
    const capabilityDeadline = Date.now() + 5_000;
    let driverCapabilityFrame: CapturedFrame | undefined;
    while (!driverCapabilityFrame && Date.now() < capabilityDeadline) {
      driverCapabilityFrame = harness.frames.slice(capabilityFrameStart + 1).reverse().find(frame => (
        frame.direction === 'server-to-page'
        && frame.generation === current.generation
        && frame.message?.type === 'terminal-checkpoint:capability'
        && Array.isArray(frame.message.registeredViews)
        && frame.message.registeredViews.some(view => (
          view !== null
          && typeof view === 'object'
          && (view as Record<string, unknown>).sessionId === current.sessionId
        ))
        && Array.isArray(frame.message.mutationLeases)
        && frame.message.mutationLeases.some(lease => (
          lease !== null
          && typeof lease === 'object'
          && (lease as Record<string, unknown>).sessionId === current.sessionId
        ))
      ));
      if (!driverCapabilityFrame) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const driverRegistration = driverCapabilityFrame?.message?.registeredViews?.find(view => (
      view !== null
      && typeof view === 'object'
      && (view as Record<string, unknown>).sessionId === current.sessionId
    )) as Record<string, unknown> | undefined;
    const driverLease = driverCapabilityFrame?.message?.mutationLeases?.find(lease => (
      lease !== null
      && typeof lease === 'object'
      && (lease as Record<string, unknown>).sessionId === current.sessionId
      && (lease as Record<string, unknown>).viewGeneration === current.viewGeneration
    )) as Record<string, unknown> | undefined;
    if (
      driverCapabilityFrame
      && driverRegistration
      && Number.isSafeInteger(driverRegistration.viewGeneration)
      && driverRegistration.viewGeneration === current.viewGeneration
      && typeof driverRegistration.driverLeaseGeneration === 'string'
      && typeof driverRegistration.acceptedViewAttributesGeneration === 'string'
      && driverRegistration.viewAttributesChallengeId === undefined
      && driverLease
    ) {
      // The same connection/view has already completed the one-shot attribute
      // handshake. A missing challenge is the deliberate replay-safe success
      // state, not a reason to churn subscriptions and snapshots.
      return current;
    }
    const attributes = [...harness.frames].reverse().find(frame => (
      frame.direction === 'page-to-server'
      && frame.message?.type === 'terminal-authority:view-attributes'
      && frame.message.sessionId === current.sessionId
    ))?.message?.attributes;
    if (!driverCapabilityFrame
      || !driverRegistration
      || !Number.isSafeInteger(driverRegistration.viewGeneration)
      || typeof driverRegistration.driverLeaseGeneration !== 'string'
      || typeof driverRegistration.acceptedViewAttributesGeneration !== 'string'
      || typeof driverRegistration.viewAttributesChallengeId !== 'string'
      || !attributes) {
      continue;
    }
    const attributesFrameStart = harness.frames.length - 1;
    harness.sendToServer(resolveControlGeneration(harness, driverCapabilityFrame.generation), {
      type: 'terminal-authority:view-attributes',
      sessionId: current.sessionId,
      viewGeneration: driverRegistration.viewGeneration,
      driverLeaseGeneration: driverRegistration.driverLeaseGeneration,
      viewAttributesGeneration: driverRegistration.acceptedViewAttributesGeneration,
      viewAttributesChallengeId: driverRegistration.viewAttributesChallengeId,
      attributes,
    });
    const acceptedAttributesDeadline = Date.now() + 5_000;
    let acceptedAttributes: CapturedFrame | undefined;
    while (!acceptedAttributes && Date.now() < acceptedAttributesDeadline) {
      acceptedAttributes = harness.frames.slice(attributesFrameStart + 1).find(frame => (
        frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && frame.message?.type === 'terminal-authority:view-attributes-accepted'
        && frame.message.sessionId === current.sessionId
        && frame.message.viewGeneration === driverRegistration.viewGeneration
        && frame.message.accepted === true
      ));
      if (!acceptedAttributes) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!acceptedAttributes) continue;
    return current;
  }
  const replayEvidence = harness.frames.slice(evidenceStart + 1).filter(frame => (
    frame.message?.sessionId === unselectedSessionId
    || ['connected', 'subscribe', 'unsubscribe', 'subscribed'].includes(frame.message?.type ?? '')
  )).map(frame => ({
    direction: frame.direction,
    generation: frame.generation,
    origin: frame.origin,
    message: frame.message,
  }));
  throw new Error(
    `E2E precondition failed: unselected canary replay did not settle across reconnects; `
    + `unselectedSessionId=${unselectedSessionId}; replayEvidence=${JSON.stringify(replayEvidence)}`,
  );
}

function unsubscribeUnrelatedSessions(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
  preserveSessionIds: readonly string[] = [],
): void {
  const unrelatedSessionIds = new Set<string>();
  const preserved = new Set([live.sessionId, ...preserveSessionIds]);
  const owner = harness.ownerForGeneration(live.generation);
  for (const frame of harness.frames) {
    if (frame.direction !== 'page-to-server'
      || frame.message?.type !== 'subscribe'
      || harness.ownerForGeneration(frame.generation) !== owner) {
      continue;
    }
    const sessionIds = frame.message?.sessionIds;
    if (!Array.isArray(sessionIds)) continue;
    for (const sessionId of sessionIds) {
      if (typeof sessionId === 'string' && !preserved.has(sessionId)) {
        unrelatedSessionIds.add(sessionId);
      }
    }
  }
  if (unrelatedSessionIds.size > 0) {
    // The persisted workspace may contain restored user tabs. Keep the live
    // browser UI intact, but isolate this canary requester's server-derived
    // subscription set so the exact two-session contract is deterministic.
    harness.sendToServer(resolveLatestControlGeneration(harness, live), {
      type: 'unsubscribe',
      sessionIds: [...unrelatedSessionIds],
    });
  }
}

async function waitForRoutedServerFrame(
  harness: RoutedWebSocketHarness,
  predicate: (message: JsonFrame) => boolean,
  timeoutMs = 3_000,
): Promise<CapturedFrame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = harness.latest('server-to-page', predicate);
    if (frame?.origin === 'routed-server') return frame;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

async function captureRetainedState(
  page: Page,
  sessionId: string,
): Promise<TerminalRetainedStateEvidence> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const evidence = await page.evaluate((requestedSessionId) => {
      const debug = (window as unknown as {
        __buildergateTerminalDebug?: {
          captureRetainedState?: (id: string) => TerminalRetainedStateEvidence | null;
        };
      }).__buildergateTerminalDebug;
      return debug?.captureRetainedState?.(requestedSessionId) ?? null;
    }, sessionId);
    if (evidence) return evidence;
    await page.waitForTimeout(50);
  }
  throw new Error('E2E precondition failed: retained-state capture is unavailable');
}

async function captureStreamingRetainedState(
  page: Page,
  sessionId: string,
): Promise<StreamingRetainedCapture> {
  return page.evaluate(async (requestedSessionId) => {
    const debug = (window as unknown as {
      __buildergateTerminalDebug?: {
        captureRetainedStateStreaming?: (
          id: string,
          options: {
            hashContract: 'ph005-retained-stream-v1';
            compactCellRuns: true;
            maxBufferedLines: 1;
          },
        ) => StreamingRetainedStateEvidence | null | Promise<StreamingRetainedStateEvidence | null>;
      };
    }).__buildergateTerminalDebug;
    if (typeof debug?.captureRetainedStateStreaming !== 'function') {
      return { available: false, evidence: null };
    }
    const evidence = await debug.captureRetainedStateStreaming(requestedSessionId, {
      hashContract: 'ph005-retained-stream-v1',
      compactCellRuns: true,
      maxBufferedLines: 1,
    });
    return { available: evidence !== null, evidence };
  }, sessionId);
}

interface RawRetainedCorpusContract {
  request: Record<string, unknown>;
  rawData: string;
  payloadSha256: string;
  expectedRetainedLineCount: number;
  outputLineCount: number;
  oldestLabel: string;
  newestLabel: string;
  oldestLogicalLineHash: string;
  newestLogicalLineHash: string;
  inactiveAlternateMarker: string;
}

function fnv1a64ForContract(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function retainedLogicalLineHash(text: string): string {
  return fnv1a64ForContract(JSON.stringify({ isWrapped: false, text }));
}

function retainedCorpusLabel(index: number): string {
  return `R${String(index).padStart(5, '0')}`;
}

function buildRawRetainedCorpusContract(rows: number): RawRetainedCorpusContract {
  const expectedRetainedLineCount = PH005_RETAINED_POLICY_LINES + rows;
  const outputLineCount = expectedRetainedLineCount + PH005_RETAINED_OVERFLOW_LINES;
  const labels = Array.from({ length: outputLineCount }, (_, index) => retainedCorpusLabel(index));
  const inactiveAlternateMarker = 'PH005-INACTIVE-ALTERNATE-BUFFER';
  const rawData = [
    '\u001bc',
    '\u001b[?2004h\u001b[?7h',
    ...labels.map((label, index) => (
      `\u001b[1;3;4;38;5;45;48;5;17m${label}\u001b[0m${index + 1 < labels.length ? '\r\n' : ''}`
    )),
    `\u001b[?1049h\u001b[2;5H${inactiveAlternateMarker}\u001b[?1049l`,
  ].join('');
  const oldestLabel = labels[PH005_RETAINED_OVERFLOW_LINES]!;
  const newestLabel = labels.at(-1)!;
  const payload = Buffer.from(rawData, 'utf8');
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');
  return {
    rawData,
    payloadSha256,
    expectedRetainedLineCount,
    outputLineCount,
    oldestLabel,
    newestLabel,
    oldestLogicalLineHash: retainedLogicalLineHash(oldestLabel),
    newestLogicalLineHash: retainedLogicalLineHash(newestLabel),
    inactiveAlternateMarker,
    request: {
      contractVersion: 1,
      retainedPolicyOverride: {
        action: 'override-session-retained-policy',
        scope: 'session-generation-test-isolation',
        effectiveRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
        maximumConfiguredBoundaryEvidence: PH005_MAX_POLICY_BOUNDARY_CONTRACT,
      },
      retainedCorpusInjection: {
        action: 'inject-authoritative-raw-output-after-promotion',
        encoding: 'base64',
        data: payload.toString('base64'),
        decodedBytes: payload.byteLength,
        sha256: payloadSha256,
        reset: 'RIS',
        physicalLineCount: outputLineCount,
        expectedRetainedPhysicalLineCount: expectedRetainedLineCount,
        overflowPhysicalLineCount: PH005_RETAINED_OVERFLOW_LINES,
        expectedOldestLabel: oldestLabel,
        expectedNewestLabel: newestLabel,
        expectedInactiveAlternateMarker: inactiveAlternateMarker,
      },
    },
  };
}

interface PartialEscapeRecoveryContract {
  request: Record<string, unknown>;
  parserTailPrefix: string;
  visibleMarker: string;
  suffix: ProductionConfiguredCorpusContract['deterministicTail'];
}

function buildPartialEscapeRecoveryContract(visibleMarker: string): PartialEscapeRecoveryContract {
  const parserTailPrefix = '\u001b[38;5;';
  const rawData = `\u001bcPH005-PARSER-TAIL-BASE${parserTailPrefix}`;
  const rawBytes = Buffer.from(rawData, 'utf8');
  const suffixData = `196m${visibleMarker}\u001b[0m\r\n`;
  const suffixBytes = Buffer.from(suffixData, 'utf8');
  return {
    parserTailPrefix,
    visibleMarker,
    request: {
      contractVersion: 1,
      retainedCorpusInjection: {
        action: 'inject-authoritative-raw-output-after-promotion',
        encoding: 'base64',
        data: rawBytes.toString('base64'),
        decodedBytes: rawBytes.byteLength,
        sha256: createHash('sha256').update(rawBytes).digest('hex'),
      },
    },
    suffix: {
      data: suffixData,
      encodedData: suffixBytes.toString('base64'),
      decodedBytes: suffixBytes.byteLength,
      sha256: createHash('sha256').update(suffixBytes).digest('hex'),
    },
  };
}

function buildEchoSafeMarkerCommand(marker: string, prefixAnsi = '', suffixAnsi = ''): string {
  const output = `${prefixAnsi}${marker}${suffixAnsi}\r\n`;
  const encodedOutput = Buffer.from(output, 'utf8').toString('base64');
  const source = `process.stdout.write(Buffer.from('${encodedOutput}','base64'))`;
  const encodedSource = Buffer.from(source, 'utf8').toString('base64');
  return `node -e "eval(Buffer.from('${encodedSource}','base64').toString('utf8'))"`;
}

function buildEchoSafeZeroViewProducerCommand(input: {
  readyMarker: string;
  retainedMarker: string;
  triggerPath: string;
}): { command: string; retainedOutput: string } {
  const readyOutput = `${input.readyMarker}\r\n`;
  const retainedOutput = `${input.retainedMarker}\r\n`;
  const readyBase64 = Buffer.from(readyOutput, 'utf8').toString('base64');
  const retainedBase64 = Buffer.from(retainedOutput, 'utf8').toString('base64');
  const triggerPathBase64 = Buffer.from(input.triggerPath, 'utf8').toString('base64');
  const source = [
    "const fs=require('fs')",
    `const triggerPath=Buffer.from('${triggerPathBase64}','base64').toString('utf8')`,
    `process.stdout.write(Buffer.from('${readyBase64}','base64'))`,
    'const poll=setInterval(()=>{',
    'if(!fs.existsSync(triggerPath))return;',
    'clearInterval(poll);',
    `process.stdout.write(Buffer.from('${retainedBase64}','base64'));`,
    'setTimeout(()=>process.exit(0),30000)',
    '},25)',
  ].join(';');
  const encodedSource = Buffer.from(source, 'utf8').toString('base64');
  return {
    command: `node -e "eval(Buffer.from('${encodedSource}','base64').toString('utf8'))"`,
    retainedOutput,
  };
}

interface RetainedPolicyEvidence {
  valid: boolean;
  effectiveRetainedScrollbackLines: number;
  retentionPolicyId: string | null;
  source: string | null;
}

interface ProductionConfiguredPolicyEvidence {
  valid: boolean;
  productionConfiguredRetainedScrollbackLines: number;
  productionConfiguredRetainedScrollbackSource: string | null;
  productionConfiguredRetentionPolicyId: string | null;
  effectiveHeadlessRetainedScrollbackLines: number | null;
  effectiveMatchesProductionConfigured: boolean;
}

function retainedPolicyEvidence(preparation: Record<string, unknown>): RetainedPolicyEvidence {
  const candidate = preparation.retentionPolicy;
  const policy = candidate && typeof candidate === 'object'
    ? candidate as Record<string, unknown>
    : {};
  const effective = policy.effectiveRetainedScrollbackLines;
  const retentionPolicyId = typeof policy.retentionPolicyId === 'string'
    && policy.retentionPolicyId.trim().length > 0
    ? policy.retentionPolicyId
    : null;
  const source = policy.source === 'resourceLimits.terminal.scrollbackLines'
    || policy.source === 'pty.scrollbackLines'
    ? policy.source
    : null;
  const validEffective = typeof effective === 'number'
    && Number.isSafeInteger(effective)
    && effective >= 0
    && effective <= 50_000;
  return {
    valid: validEffective && retentionPolicyId !== null && source !== null,
    // RED must still reach its named contract failure when the route is absent.
    effectiveRetainedScrollbackLines: validEffective ? effective as number : PH005_RETAINED_POLICY_LINES,
    retentionPolicyId,
    source,
  };
}

function productionConfiguredPolicyEvidence(
  preparation: Record<string, unknown>,
): ProductionConfiguredPolicyEvidence {
  const configured = preparation.productionConfiguredRetainedScrollbackLines;
  const source = typeof preparation.productionConfiguredRetainedScrollbackSource === 'string'
    && preparation.productionConfiguredRetainedScrollbackSource.length > 0
    ? preparation.productionConfiguredRetainedScrollbackSource
    : null;
  const policyId = typeof preparation.productionConfiguredRetentionPolicyId === 'string'
    && preparation.productionConfiguredRetentionPolicyId.length > 0
    ? preparation.productionConfiguredRetentionPolicyId
    : null;
  const effective = preparation.effectiveHeadlessRetainedScrollbackLines;
  const configuredValid = Number.isSafeInteger(configured)
    && Number(configured) >= 0
    && Number(configured) <= 50_000;
  const effectiveValid = Number.isSafeInteger(effective)
    && Number(effective) >= 0
    && Number(effective) <= 50_000;
  return {
    valid: configuredValid && effectiveValid && source !== null && policyId !== null,
    productionConfiguredRetainedScrollbackLines: configuredValid
      ? Number(configured)
      : PH005_PRODUCTION_CONFIG_FALLBACK_LINES,
    productionConfiguredRetainedScrollbackSource: source,
    productionConfiguredRetentionPolicyId: policyId,
    effectiveHeadlessRetainedScrollbackLines: effectiveValid ? Number(effective) : null,
    effectiveMatchesProductionConfigured: configuredValid
      && effectiveValid
      && Number(effective) === Number(configured),
  };
}

interface ProductionConfiguredCorpusContract {
  request: Record<string, unknown>;
  configuredScrollbackLines: number;
  expectedRetainedLineCount: number;
  outputLineCount: number;
  oldestLabel: string;
  newestLabel: string;
  evictedPrefixLabel: string;
  independentOracle: StreamingRetainedStateEvidence;
  postTailIndependentOracle: StreamingRetainedStateEvidence;
  deterministicTail: {
    data: string;
    encodedData: string;
    decodedBytes: number;
    sha256: string;
  };
}

function buildDeterministicTailContract(
  data: string,
): ProductionConfiguredCorpusContract['deterministicTail'] {
  const bytes = Buffer.from(data, 'utf8');
  return {
    data,
    encodedData: bytes.toString('base64'),
    decodedBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

interface StreamingRetainedBoundaryEvidence {
  index: number;
  logicalLineSha256: string;
  cellAttributesSha256: string;
}

interface StreamingRetainedStateEvidence {
  schemaVersion: 1;
  hashContract: 'ph005-retained-stream-v1';
  lineCount: number;
  orderedLogicalLinesSha256: string;
  orderedCellAttributesSha256: string;
  orderedLineFingerprintSha256: string;
  fullStateSha256: string;
  activeBuffer: 'normal' | 'alternate';
  geometry: { rows: number; cols: number };
  cursor: { x: number; y: number; absoluteY: number };
  savedCursor: { available: boolean; x?: number; y?: number };
  modes: {
    applicationCursorKeysMode: boolean;
    applicationKeypadMode: boolean;
    bracketedPasteMode: boolean;
    insertMode: boolean;
    mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
    originMode: boolean;
    reverseWraparoundMode: boolean;
    sendFocusMode: boolean;
    synchronizedOutputMode: boolean;
    wraparoundMode: boolean;
  };
  firstLine: StreamingRetainedBoundaryEvidence;
  lastLine: StreamingRetainedBoundaryEvidence;
  overlap: {
    contract: 'ph005-retained-overlap-v1';
    maxShiftLines: 8;
    canonicalLineFingerprint: 'logical-line-and-cell-attributes-without-index';
    shifts: Array<{
      shiftLines: number;
      suffixSha256: string;
      prefixSha256: string;
    }>;
  };
  streaming: {
    fullCellObjectMaterializationCount: 0;
    maxBufferedLines: 1;
    compactCellRuns: true;
  };
}

interface StreamingRetainedCapture {
  available: boolean;
  evidence: StreamingRetainedStateEvidence | null;
}

function productionConfiguredCorpusLabel(index: number): string {
  return `P${String(index).padStart(6, '0')}`;
}

function updateLengthFramedSha256(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, 'utf8')), 'utf8');
  hash.update(':', 'utf8');
  hash.update(value, 'utf8');
}

function configuredCorpusCellRuns(label: string, cols: number): Array<Record<string, unknown>> {
  const defaultAttributes = {
    fgMode: 0,
    bgMode: 0,
    fg: -1,
    bg: -1,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
  const characterRuns = [...label].map((character, column) => ({
    startColumn: column,
    length: 1,
    chars: character,
    code: character.codePointAt(0)!,
    width: 1,
    ...defaultAttributes,
  }));
  if (cols > label.length) {
    characterRuns.push({
      startColumn: label.length,
      length: cols - label.length,
      chars: '',
      code: 0,
      width: 1,
      ...defaultAttributes,
    });
  }
  return characterRuns;
}

function buildIndependentConfiguredStreamingOracle(input: {
  configuredScrollbackLines: number;
  rows: number;
  cols: number;
  outputLineCount: number;
  tailSuffix?: string;
}): StreamingRetainedStateEvidence {
  const lineCount = input.configuredScrollbackLines + input.rows;
  const firstSourceIndex = input.outputLineCount - lineCount;
  const orderedLogical = createHash('sha256');
  const orderedCells = createHash('sha256');
  const orderedFingerprints = createHash('sha256');
  const overlapSuffixHashes = Array.from({ length: 8 }, () => createHash('sha256'));
  const overlapPrefixHashes = Array.from({ length: 8 }, () => createHash('sha256'));
  const recentCanonicalFingerprints: string[] = [];
  let firstLine: StreamingRetainedBoundaryEvidence | null = null;
  let lastLine: StreamingRetainedBoundaryEvidence | null = null;
  for (let retainedIndex = 0; retainedIndex < lineCount; retainedIndex += 1) {
    const sourceLabel = productionConfiguredCorpusLabel(firstSourceIndex + retainedIndex);
    const text = retainedIndex === lineCount - 1
      ? `${sourceLabel}${input.tailSuffix ?? ''}`
      : sourceLabel;
    const logicalPayload = JSON.stringify({ index: retainedIndex, isWrapped: false, text });
    const cellPayload = JSON.stringify({
      index: retainedIndex,
      compactCellRuns: configuredCorpusCellRuns(text, input.cols),
    });
    const logicalLineSha256 = createHash('sha256').update(logicalPayload, 'utf8').digest('hex');
    const cellAttributesSha256 = createHash('sha256').update(cellPayload, 'utf8').digest('hex');
    updateLengthFramedSha256(orderedLogical, logicalPayload);
    updateLengthFramedSha256(orderedCells, cellPayload);
    updateLengthFramedSha256(
      orderedFingerprints,
      JSON.stringify({ index: retainedIndex, logicalLineSha256, cellAttributesSha256 }),
    );
    const canonicalFingerprint = createHash('sha256').update(JSON.stringify({
      logicalLine: { isWrapped: false, text },
      cellAttributes: { compactCellRuns: configuredCorpusCellRuns(text, input.cols) },
    }), 'utf8').digest('hex');
    for (let shiftIndex = 0; shiftIndex < overlapSuffixHashes.length; shiftIndex += 1) {
      const shiftLines = shiftIndex + 1;
      if (retainedIndex >= shiftLines) {
        updateLengthFramedSha256(overlapSuffixHashes[shiftIndex]!, canonicalFingerprint);
        updateLengthFramedSha256(
          overlapPrefixHashes[shiftIndex]!,
          recentCanonicalFingerprints[recentCanonicalFingerprints.length - shiftLines]!,
        );
      }
    }
    recentCanonicalFingerprints.push(canonicalFingerprint);
    if (recentCanonicalFingerprints.length > overlapSuffixHashes.length) {
      recentCanonicalFingerprints.shift();
    }
    const boundary = { index: retainedIndex, logicalLineSha256, cellAttributesSha256 };
    firstLine ??= boundary;
    lastLine = boundary;
  }
  if (!firstLine || !lastLine) {
    throw new Error('E2E contract construction failed: configured retained range must contain viewport lines');
  }
  const orderedLogicalLinesSha256 = orderedLogical.digest('hex');
  const orderedCellAttributesSha256 = orderedCells.digest('hex');
  const orderedLineFingerprintSha256 = orderedFingerprints.digest('hex');
  const overlapShifts = overlapSuffixHashes
    .map((suffixHash, shiftIndex) => ({
      shiftLines: shiftIndex + 1,
      suffixSha256: suffixHash,
      prefixSha256: overlapPrefixHashes[shiftIndex]!,
    }))
    .filter(({ shiftLines }) => shiftLines < lineCount)
    .map(({ shiftLines, suffixSha256, prefixSha256 }) => ({
      shiftLines,
      suffixSha256: suffixSha256.digest('hex'),
      prefixSha256: prefixSha256.digest('hex'),
    }));
  const geometry = { rows: input.rows, cols: input.cols };
  const cursor = {
    x: 7 + (input.tailSuffix?.length ?? 0),
    y: input.rows - 1,
    absoluteY: lineCount - 1,
  };
  // xterm stores DECSC savedY in absolute normal-buffer coordinates. After
  // scrollback eviction the final cursor therefore points at the retained
  // range's last absolute row, not at viewport-relative rows - 1.
  const savedCursor = { available: true, x: 7, y: lineCount - 1 };
  const modes = {
    applicationCursorKeysMode: false,
    applicationKeypadMode: false,
    bracketedPasteMode: true,
    insertMode: false,
    mouseTrackingMode: 'none' as const,
    originMode: false,
    reverseWraparoundMode: false,
    sendFocusMode: false,
    synchronizedOutputMode: false,
    wraparoundMode: true,
  };
  const fullStateSha256 = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    activeBuffer: 'normal',
    geometry,
    cursor,
    savedCursor,
    modes,
    lineCount,
    orderedLogicalLinesSha256,
    orderedCellAttributesSha256,
    orderedLineFingerprintSha256,
  }), 'utf8').digest('hex');
  return {
    schemaVersion: 1,
    hashContract: 'ph005-retained-stream-v1',
    lineCount,
    orderedLogicalLinesSha256,
    orderedCellAttributesSha256,
    orderedLineFingerprintSha256,
    fullStateSha256,
    activeBuffer: 'normal',
    geometry,
    cursor,
    savedCursor,
    modes,
    firstLine,
    lastLine,
    overlap: {
      contract: 'ph005-retained-overlap-v1',
      maxShiftLines: 8,
      canonicalLineFingerprint: 'logical-line-and-cell-attributes-without-index',
      shifts: overlapShifts,
    },
    streaming: {
      fullCellObjectMaterializationCount: 0,
      maxBufferedLines: 1,
      compactCellRuns: true,
    },
  };
}

function buildProductionConfiguredCorpusContract(
  policy: ProductionConfiguredPolicyEvidence,
  geometry: { rows: number; cols: number },
): ProductionConfiguredCorpusContract {
  const configuredScrollbackLines = policy.productionConfiguredRetainedScrollbackLines;
  const expectedRetainedLineCount = configuredScrollbackLines + geometry.rows;
  const outputLineCount = expectedRetainedLineCount + PH005_RETAINED_OVERFLOW_LINES;
  const oldestLabel = productionConfiguredCorpusLabel(PH005_RETAINED_OVERFLOW_LINES);
  const newestLabel = productionConfiguredCorpusLabel(outputLineCount - 1);
  const independentOracle = buildIndependentConfiguredStreamingOracle({
    configuredScrollbackLines,
    rows: geometry.rows,
    cols: geometry.cols,
    outputLineCount,
  });
  const postTailIndependentOracle = buildIndependentConfiguredStreamingOracle({
    configuredScrollbackLines,
    rows: geometry.rows,
    cols: geometry.cols,
    outputLineCount,
    tailSuffix: PH005_CONFIGURED_TAIL_SUFFIX,
  });
  const deterministicTailBytes = Buffer.from(PH005_CONFIGURED_TAIL_SUFFIX, 'utf8');
  return {
    configuredScrollbackLines,
    expectedRetainedLineCount,
    outputLineCount,
    oldestLabel,
    newestLabel,
    evictedPrefixLabel: productionConfiguredCorpusLabel(0),
    independentOracle,
    postTailIndependentOracle,
    deterministicTail: {
      data: PH005_CONFIGURED_TAIL_SUFFIX,
      encodedData: deterministicTailBytes.toString('base64'),
      decodedBytes: deterministicTailBytes.byteLength,
      sha256: createHash('sha256').update(deterministicTailBytes).digest('hex'),
    },
    request: {
      contractVersion: 1,
      productionConfiguredRangeProbe: {
        action: 'generate-and-inject-production-configured-retained-corpus-stream',
        generator: 'ph005-fixed-width-counter-v1',
        configuredScrollbackLines,
        source: policy.productionConfiguredRetainedScrollbackSource,
        retentionPolicyId: policy.productionConfiguredRetentionPolicyId,
        viewportRows: geometry.rows,
        viewportCols: geometry.cols,
        overflowPhysicalLineCount: PH005_RETAINED_OVERFLOW_LINES,
        expectedRetainedPhysicalLineCount: expectedRetainedLineCount,
        physicalLineCount: outputLineCount,
        expectedOldestLabel: oldestLabel,
        expectedNewestLabel: newestLabel,
        materializationPolicy: 'bounded-generator-window-no-full-cell-array',
        verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
        generatorTerminalState: {
          reset: 'RIS',
          prefixModes: ['DECSET-7-wraparound', 'DECSET-2004-bracketed-paste'],
          linePattern: 'P{zero-padded-source-index-width-6}',
          lineSeparator: 'CRLF-except-final-line',
          finalAction: 'DECSC-save-cursor-after-final-label',
          activeBuffer: 'normal',
        },
      },
    },
  };
}

function configuredRangeTimeoutMs(configuredScrollbackLines: number): number {
  return Math.min(420_000, 90_000 + Math.ceil(configuredScrollbackLines / 1_000) * 6_000);
}

function retainedRangeEvidence(value: TerminalRetainedStateEvidence) {
  return {
    retainedLineCount: value.lineFingerprints.length,
    oldestBoundary: value.lineFingerprints[0] ?? null,
    newestBoundary: value.lineFingerprints.at(-1) ?? null,
    fullRangeHashes: {
      logicalLinesHash: value.logicalLinesHash,
      cellContentAttributeHash: value.cellContentAttributeHash,
      digest: value.digest,
    },
  };
}

type TerminalCacheScenario = 'valid-stale' | 'malformed' | 'tombstone' | 'absent';

interface TerminalCacheInventory {
  scenario: TerminalCacheScenario;
  actualSources: string[];
  defensiveSurfaces: string[];
  entries: Array<{ storage: string; key: string; valueHash: string }>;
  payloadContract: string;
  inventoryEvidence: {
    productionSourceSha256: string;
    discoveredKeyPrefixes: string[];
    discoveredStorageApis: string[];
    discoveredModuleSets: string[];
    snapshotKeyPrefix: string;
    tombstoneKeyPrefix: string;
    primaryProductionStorage: string;
    debugSurfaceKeys: string[];
  };
}

function terminalCacheProductionInventory() {
  const source = readFileSync(new URL('../../src/utils/terminalSnapshot.ts', import.meta.url), 'utf8');
  const keyPrefixBindings = [...source.matchAll(
    /const\s+([A-Z][A-Z0-9_]*KEY_PREFIX)\s*=\s*['"]([^'"]+)['"]/gu,
  )].map(match => ({ name: match[1]!, value: match[2]! }));
  const snapshotKeyPrefix = keyPrefixBindings.find(binding => binding.name === 'SNAPSHOT_KEY_PREFIX')?.value;
  const tombstoneKeyPrefix = keyPrefixBindings.find(
    binding => binding.name === 'SNAPSHOT_REMOVAL_KEY_PREFIX',
  )?.value;
  if (!snapshotKeyPrefix || !tombstoneKeyPrefix || snapshotKeyPrefix === tombstoneKeyPrefix) {
    throw new Error('E2E contract inventory failed: production snapshot/tombstone key prefixes are ambiguous');
  }
  const discoveredKeyPrefixes = keyPrefixBindings.map(binding => binding.value).sort();
  const discoveredStorageApis = [...new Set(
    [...source.matchAll(/\b(localStorage|sessionStorage)\b/gu)]
      .map(match => match[1]!),
  )].sort();
  const discoveredModuleSets = [...source.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Set(?:<[^>]+>)?\s*\(/gu,
  )].map(match => match[1]!).sort();
  if (discoveredStorageApis.length === 0) {
    throw new Error('E2E contract inventory failed: production terminal cache storage is unavailable');
  }
  return {
    productionSourceSha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    discoveredKeyPrefixes,
    discoveredStorageApis,
    discoveredModuleSets,
    snapshotKeyPrefix,
    tombstoneKeyPrefix,
    primaryProductionStorage: discoveredStorageApis[0]!,
  };
}

async function setAndInventoryTerminalCacheScenario(
  page: Page,
  sessionId: string,
  scenario: TerminalCacheScenario,
  poison: string,
  geometry: { cols: number; rows: number },
): Promise<TerminalCacheInventory> {
  const productionInventory = terminalCacheProductionInventory();
  return page.evaluate(({ id, requestedScenario, poisonValue, sourceGeometry, staticInventory }) => {
    const storageByName: Record<string, Storage> = { localStorage, sessionStorage };
    const snapshotKey = `${staticInventory.snapshotKeyPrefix}${id}`;
    const tombstoneKey = `${staticInventory.tombstoneKeyPrefix}${id}`;
    const inventoryStorageNames = Object.keys(storageByName);
    for (const storageName of inventoryStorageNames) {
      const storage = storageByName[storageName]!;
      storage.removeItem(snapshotKey);
      storage.removeItem(tombstoneKey);
    }
    const primaryStorage = storageByName[staticInventory.primaryProductionStorage];
    if (!primaryStorage) throw new Error('production terminal cache storage is not browser-addressable');
    let payloadContract = 'all-terminal-cache-surfaces-absent';
    if (requestedScenario === 'valid-stale') {
      primaryStorage.setItem(snapshotKey, JSON.stringify({
        schemaVersion: 2,
        payloadKind: 'viewport-only',
        sessionId: id,
        content: `\u001bc\u001b[31m${poisonValue}\u001b[0m`,
        cols: sourceGeometry.cols,
        rows: sourceGeometry.rows,
        bufferType: 'normal',
        savedAt: '2099-01-01T00:00:00.000Z',
      }));
      payloadContract = 'schema-v2-valid-stale-without-tombstone';
    } else if (requestedScenario === 'malformed') {
      primaryStorage.setItem(snapshotKey, `{"schemaVersion":2,"poison":${JSON.stringify(poisonValue)}`);
      payloadContract = 'malformed-snapshot-without-tombstone';
    } else if (requestedScenario === 'tombstone') {
      primaryStorage.setItem(tombstoneKey, JSON.stringify({
        schemaVersion: 1,
        sessionId: id,
        savedAt: new Date().toISOString(),
      }));
      payloadContract = 'valid-removal-tombstone-without-snapshot';
    }
    const hash = (value: string): string => {
      let current = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        current ^= value.charCodeAt(index);
        current = Math.imul(current, 16777619);
      }
      return `fnv1a32:${(current >>> 0).toString(16).padStart(8, '0')}`;
    };
    const entries = inventoryStorageNames.flatMap(storageName => [
      { storage: storageByName[storageName]!, storageName, key: snapshotKey },
      { storage: storageByName[storageName]!, storageName, key: tombstoneKey },
    ]);
    const debug = (window as unknown as { __buildergateTerminalDebug?: Record<string, unknown> })
      .__buildergateTerminalDebug;
    const debugSurfaceKeys = debug ? Object.keys(debug).sort() : [];
    const actualSources = staticInventory.discoveredStorageApis.flatMap(storageName => (
      staticInventory.discoveredKeyPrefixes.map(prefix => `${storageName}:${prefix}`)
    ));
    actualSources.push(...staticInventory.discoveredModuleSets.map(name => `module-memory:${name}`));
    const defensiveSurfaces = entries
      .filter(entry => !staticInventory.discoveredStorageApis.includes(entry.storageName))
      .map(entry => `${entry.storageName}:${entry.key.slice(0, entry.key.length - id.length)}`);
    return {
      scenario: requestedScenario,
      actualSources: [...new Set(actualSources)].sort(),
      defensiveSurfaces: [...new Set(defensiveSurfaces)].sort(),
      entries: entries.map(entry => {
        const value = entry.storage.getItem(entry.key);
        return {
          storage: entry.storageName,
          key: entry.key,
          valueHash: value === null ? 'absent' : hash(value),
        };
      }),
      payloadContract,
      inventoryEvidence: {
        ...staticInventory,
        debugSurfaceKeys,
      },
    };
  }, {
    id: sessionId,
    requestedScenario: scenario,
    poisonValue: poison,
    sourceGeometry: geometry,
    staticInventory: productionInventory,
  });
}

async function removeAllTerminalCaches(page: Page, sessionId: string): Promise<TerminalCacheInventory> {
  return setAndInventoryTerminalCacheScenario(
    page,
    sessionId,
    'absent',
    'unused-absent-poison',
    { cols: 1, rows: 1 },
  );
}

function isCanonicalOrdinal(value: unknown): boolean {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value);
}

const CHECKPOINT_IDENTITY_KEYS = [
  'protocolVersion',
  'sessionId',
  'viewGeneration',
  'streamEpoch',
  'checkpointEpoch',
  'sourceSeq',
  'snapshotSeq',
  'oldestRetainedSeq',
  'retentionPolicyId',
] as const;

type CheckpointIdentity = Record<(typeof CHECKPOINT_IDENTITY_KEYS)[number], unknown>;

interface CheckpointTransactionEvidence {
  start: CapturedFrame | null;
  chunks: CapturedFrame[];
  commit: CapturedFrame | null;
  applyAck: CapturedFrame | null;
  drainAck: CapturedFrame | null;
  identity: CheckpointIdentity | null;
  localCacheUsed: unknown;
  lifecycleFrameCounts: {
    start: number;
    commit: number;
    applyAck: number;
    drainAck: number;
  };
  validation: {
    identityCanonical: boolean;
    exactLifecycleFrameCounts: boolean;
    exactChunkCountAndIndices: boolean;
    encodedByteTotalValid: boolean;
    digestValid: boolean;
    parserTailEnvelopeValid: boolean;
    retainedStateDigestValid: boolean;
    exactFrameOrder: boolean;
    sameTerminalLane: boolean;
    terminalLaneTypeWhitelist: boolean;
    preCommitInterleavingCount: number;
    applyAckValid: boolean;
    drainAckValid: boolean;
    failureAckCount: number;
    settled: boolean;
  };
}

function checkpointIdentity(message: JsonFrame): CheckpointIdentity {
  return Object.fromEntries(CHECKPOINT_IDENTITY_KEYS.map(key => [key, message[key]])) as CheckpointIdentity;
}

function sameCheckpointIdentity(message: JsonFrame, identity: CheckpointIdentity): boolean {
  return CHECKPOINT_IDENTITY_KEYS.every(key => message[key] === identity[key]);
}

function decodedCheckpointPayload(message: JsonFrame): Buffer | null {
  if (message.encoding !== 'base64' || typeof message.data !== 'string') return null;
  const decoded = Buffer.from(message.data, 'base64');
  return decoded.toString('base64').replace(/=+$/u, '') === message.data.replace(/=+$/u, '')
    ? decoded
    : null;
}

const RETAINED_STATE_MODE_NAMES = [
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'wraparoundMode',
] as const;

function retainedStateDigestEvidence(
  startMessage: JsonFrame | undefined,
  commitMessage: JsonFrame | undefined,
): { parserTailEnvelopeValid: boolean; retainedStateDigestValid: boolean } {
  const parserTail = startMessage?.parserTail;
  const parserTailRecord = parserTail && typeof parserTail === 'object'
    ? parserTail as JsonFrame
    : null;
  const decodedParserTail = parserTailRecord ? decodedCheckpointPayload(parserTailRecord) : null;
  const parserTailEnvelopeValid = parserTailRecord?.encoding === 'base64'
    && typeof parserTailRecord.data === 'string'
    && Number.isSafeInteger(parserTailRecord.encodedBytes)
    && decodedParserTail !== null
    && decodedParserTail.byteLength === parserTailRecord.encodedBytes;
  const sourceGeometry = startMessage?.sourceGeometry;
  const geometry = sourceGeometry && typeof sourceGeometry === 'object'
    ? sourceGeometry as Record<string, unknown>
    : null;
  const modesCandidate = startMessage?.modes;
  const modesRecord = modesCandidate && typeof modesCandidate === 'object'
    ? modesCandidate as Record<string, unknown>
    : null;
  const modes = Object.fromEntries(RETAINED_STATE_MODE_NAMES.flatMap(name => (
    typeof modesRecord?.[name] === 'boolean' ? [[name, modesRecord[name]]] : []
  )));
  const savedCursorCandidate = startMessage?.retainedSavedCursor;
  const savedCursorRecord = savedCursorCandidate && typeof savedCursorCandidate === 'object'
    ? savedCursorCandidate as Record<string, unknown>
    : null;
  const savedCursor = savedCursorCandidate === null
    ? null
    : savedCursorRecord
      ? { x: savedCursorRecord.x, y: savedCursorRecord.y }
      : undefined;
  const cursorCandidate = startMessage?.retainedCursor;
  const cursorRecord = cursorCandidate && typeof cursorCandidate === 'object'
    ? cursorCandidate as Record<string, unknown>
    : null;
  const digestHex = typeof startMessage?.digest?.hex === 'string'
    ? startMessage.digest.hex
    : null;
  const contentDigestValid = digestHex !== null
    && startMessage?.contentDigest === `sha256:${digestHex}`;
  const completeEnvelope = parserTailEnvelopeValid
    && Number.isSafeInteger(geometry?.cols)
    && Number.isSafeInteger(geometry?.rows)
    && (startMessage?.retainedActiveBuffer === 'normal' || startMessage?.retainedActiveBuffer === 'alternate')
    && cursorRecord !== null
    && savedCursor !== undefined
    && typeof startMessage?.retainedStateDigest === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(startMessage.retainedStateDigest)
    && commitMessage?.retainedStateDigest === startMessage.retainedStateDigest
    && commitMessage?.contentDigest === startMessage.contentDigest
    && contentDigestValid;
  if (!completeEnvelope) return { parserTailEnvelopeValid, retainedStateDigestValid: false };
  const canonical = JSON.stringify({
    version: 1,
    dataDigest: startMessage.contentDigest,
    parserTail: parserTailRecord!.data,
    cols: geometry!.cols,
    rows: geometry!.rows,
    modes,
    activeBuffer: startMessage.retainedActiveBuffer,
    cursor: { x: cursorRecord.x, y: cursorRecord.y },
    savedCursor,
  });
  const recomputed = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  return {
    parserTailEnvelopeValid,
    retainedStateDigestValid: recomputed === startMessage.retainedStateDigest,
  };
}

function serverCheckpointEvidence(
  harness: RoutedWebSocketHarness,
  generation: number,
  sessionId: string,
  viewGeneration: number,
): CheckpointTransactionEvidence {
  const indexedFrames = harness.frames.map((frame, index) => ({ frame, index }));
  const startEntry = [...indexedFrames].reverse().find(({ frame }) => (
    frame.generation === generation
    && frame.direction === 'server-to-page'
    && frame.origin === 'routed-server'
    && frame.message?.sessionId === sessionId
    && frame.message.type === 'terminal-checkpoint:start'
    && frame.message.viewGeneration === viewGeneration
    && frame.message.authorityMode === 'server'
    && frame.message.source === 'server-retained-authority'
  )) ?? null;
  const start = startEntry?.frame ?? null;
  const identity = start?.message ? checkpointIdentity(start.message) : null;
  const transactionFrames = identity
    ? indexedFrames.filter(({ frame }) => (
        frame.generation === generation
        && frame.message !== null
        && sameCheckpointIdentity(frame.message, identity)
      ))
    : [];
  const chunks = transactionFrames
    .filter(({ frame }) => frame.direction === 'server-to-page' && frame.message?.type === 'terminal-checkpoint:chunk')
    .map(({ frame }) => frame);
  const commitEntry = transactionFrames.find(({ frame }) => (
    frame.direction === 'server-to-page' && frame.message?.type === 'terminal-checkpoint:commit'
  )) ?? null;
  const applyAckEntry = transactionFrames.find(({ frame }) => (
    frame.direction === 'page-to-server' && frame.message?.type === 'terminal-checkpoint:apply-ack'
  )) ?? null;
  const drainAckEntry = transactionFrames.find(({ frame }) => (
    frame.direction === 'page-to-server' && frame.message?.type === 'terminal-checkpoint:drain-ack'
  )) ?? null;
  const failureAckCount = transactionFrames.filter(({ frame }) => (
    frame.direction === 'page-to-server' && frame.message?.type === 'terminal-checkpoint:failure-ack'
  )).length;
  const lifecycleFrameCounts = {
    start: transactionFrames.filter(({ frame }) => (
      frame.direction === 'server-to-page' && frame.message?.type === 'terminal-checkpoint:start'
    )).length,
    commit: transactionFrames.filter(({ frame }) => (
      frame.direction === 'server-to-page' && frame.message?.type === 'terminal-checkpoint:commit'
    )).length,
    applyAck: transactionFrames.filter(({ frame }) => (
      frame.direction === 'page-to-server' && frame.message?.type === 'terminal-checkpoint:apply-ack'
    )).length,
    drainAck: transactionFrames.filter(({ frame }) => (
      frame.direction === 'page-to-server' && frame.message?.type === 'terminal-checkpoint:drain-ack'
    )).length,
  };
  const exactLifecycleFrameCounts = Object.values(lifecycleFrameCounts).every(count => count === 1);
  const startMessage = start?.message;
  const chunkCount = Number(startMessage?.chunkCount);
  const chunkMessages = chunks.map(frame => frame.message!);
  const exactChunkCountAndIndices = Number.isSafeInteger(chunkCount)
    && chunkCount > 0
    && chunkMessages.length === chunkCount
    && chunkMessages.every((message, index) => (
      message.chunkIndex === index && message.chunkCount === chunkCount
    ));
  const decodedChunks = chunkMessages.map(decodedCheckpointPayload);
  const decodedBytes = decodedChunks.reduce((total, chunk) => total + (chunk?.byteLength ?? 0), 0);
  const declaredChunkBytes = chunkMessages.reduce((total, message) => (
    total + (Number.isSafeInteger(message.encodedBytes) ? Number(message.encodedBytes) : -1)
  ), 0);
  const commitMessage = commitEntry?.frame.message;
  const encodedByteTotalValid = decodedChunks.every((chunk, index) => (
    chunk !== null && chunk.byteLength === chunkMessages[index]?.encodedBytes
  ))
    && decodedBytes === declaredChunkBytes
    && decodedBytes === startMessage?.encodedByteTotal
    && decodedBytes === commitMessage?.encodedByteTotal
    && commitMessage?.chunkCount === chunkCount;
  const payloadDigest = decodedChunks.every(chunk => chunk !== null)
    ? (decodedChunks as Buffer[]).reduce(
        (hash, chunk) => hash.update(chunk),
        createHash('sha256'),
      ).digest('hex')
    : null;
  const digestValid = startMessage?.digest?.algorithm === 'sha256'
    && commitMessage?.digest?.algorithm === 'sha256'
    && typeof startMessage.digest.hex === 'string'
    && startMessage.digest.hex === commitMessage.digest.hex
    && startMessage.digest.hex === payloadDigest;
  const {
    parserTailEnvelopeValid,
    retainedStateDigestValid,
  } = retainedStateDigestEvidence(startMessage, commitMessage);
  const identityCanonical = identity !== null
    && identity.protocolVersion === 1
    && identity.sessionId === sessionId
    && identity.viewGeneration === viewGeneration
    && ['streamEpoch', 'checkpointEpoch', 'sourceSeq', 'snapshotSeq', 'oldestRetainedSeq']
      .every(key => isCanonicalOrdinal(identity[key]))
    && typeof identity.retentionPolicyId === 'string'
    && identity.retentionPolicyId.length > 0;
  const startIndex = startEntry?.index ?? -1;
  const chunkIndices = transactionFrames
    .filter(({ frame }) => frame.direction === 'server-to-page' && frame.message?.type === 'terminal-checkpoint:chunk')
    .map(({ index }) => index);
  const commitIndex = commitEntry?.index ?? -1;
  const applyIndex = applyAckEntry?.index ?? -1;
  const drainIndex = drainAckEntry?.index ?? -1;
  const exactFrameOrder = startIndex >= 0
    && chunkIndices.length === chunkCount
    && chunkIndices.every((index, ordinal) => (
      index > (ordinal === 0 ? startIndex : chunkIndices[ordinal - 1]!)
    ))
    && commitIndex > (chunkIndices.at(-1) ?? startIndex)
    && applyIndex > commitIndex
    && drainIndex >= applyIndex;
  const preCommitLaneFrames = startIndex >= 0 && commitIndex >= startIndex
    ? indexedFrames.filter(({ frame, index }) => (
        index >= startIndex
        && index <= commitIndex
        && frame.generation === generation
        && frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && frame.message?.sessionId === sessionId
        && sameCheckpointIdentity(frame.message, identity!)
      ))
    : [];
  const checkpointLaneTypes = new Set([
    'terminal-checkpoint:start',
    'terminal-checkpoint:chunk',
    'terminal-checkpoint:commit',
  ]);
  const preCommitInterleavingCount = preCommitLaneFrames.filter(({ frame }) => (
    frame.message === null || !checkpointLaneTypes.has(frame.message.type ?? '')
  )).length;
  const sameTerminalLane = startIndex >= 0
    && commitIndex > startIndex
    && preCommitLaneFrames.every(({ frame }) => frame.generation === start?.generation);
  const exactLaneTypeSequence = [
    'terminal-checkpoint:start',
    ...Array.from({ length: Number.isSafeInteger(chunkCount) ? chunkCount : 0 }, () => (
      'terminal-checkpoint:chunk'
    )),
    'terminal-checkpoint:commit',
  ];
  const terminalLaneTypeWhitelist = sameTerminalLane
    && preCommitInterleavingCount === 0
    && JSON.stringify(preCommitLaneFrames.map(({ frame }) => frame.message?.type))
      === JSON.stringify(exactLaneTypeSequence);
  const applyAckValid = applyAckEntry?.frame.message?.appliedThroughSeq === identity?.snapshotSeq;
  const drainedThroughSeq = drainAckEntry?.frame.message?.drainedThroughSeq;
  const drainAckValid = isCanonicalOrdinal(drainedThroughSeq)
    && isCanonicalOrdinal(identity?.snapshotSeq)
    && BigInt(drainedThroughSeq as string) >= BigInt(identity?.snapshotSeq as string);
  const settled = identityCanonical
    && exactLifecycleFrameCounts
    && exactChunkCountAndIndices
    && encodedByteTotalValid
    && digestValid
    && parserTailEnvelopeValid
    && retainedStateDigestValid
    && exactFrameOrder
    && terminalLaneTypeWhitelist
    && applyAckValid
    && drainAckValid
    && failureAckCount === 0;
  return {
    start,
    chunks,
    commit: commitEntry?.frame ?? null,
    applyAck: applyAckEntry?.frame ?? null,
    drainAck: drainAckEntry?.frame ?? null,
    identity,
    localCacheUsed: start?.message?.localCacheUsed,
    lifecycleFrameCounts,
    validation: {
      identityCanonical,
      exactLifecycleFrameCounts,
      exactChunkCountAndIndices,
      encodedByteTotalValid,
      digestValid,
      parserTailEnvelopeValid,
      retainedStateDigestValid,
      exactFrameOrder,
      sameTerminalLane,
      terminalLaneTypeWhitelist,
      preCommitInterleavingCount,
      applyAckValid,
      drainAckValid,
      failureAckCount,
      settled,
    },
  };
}

function decodedCheckpointAnsi(evidence: CheckpointTransactionEvidence): string | null {
  const chunks = evidence.chunks.map(frame => frame.message && decodedCheckpointPayload(frame.message));
  if (chunks.length === 0 || chunks.some(chunk => chunk === null)) return null;
  return Buffer.concat(chunks as Buffer[]).toString('utf8');
}

function streamingCheckpointPayloadOracle(
  evidence: CheckpointTransactionEvidence,
  expected: { oldestLabel: string; newestLabel: string; evictedPrefixLabel: string },
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const rollingHash = createHash('sha256');
  const markerWindow = Math.max(
    expected.oldestLabel.length,
    expected.newestLabel.length,
    expected.evictedPrefixLabel.length,
  ) + 8;
  let carry = '';
  let decodedBytes = 0;
  let oldestFound = false;
  let newestFound = false;
  let evictedPrefixFound = false;
  let maxMaterializedTextChars = 0;
  let validEncoding = true;
  for (const frame of evidence.chunks) {
    const decoded = frame.message ? decodedCheckpointPayload(frame.message) : null;
    if (!decoded) {
      validEncoding = false;
      continue;
    }
    rollingHash.update(decoded);
    decodedBytes += decoded.byteLength;
    let text = '';
    try {
      text = decoder.decode(decoded, { stream: true });
    } catch {
      validEncoding = false;
    }
    const scanWindow = `${carry}${text}`;
    maxMaterializedTextChars = Math.max(maxMaterializedTextChars, scanWindow.length);
    oldestFound ||= scanWindow.includes(expected.oldestLabel);
    newestFound ||= scanWindow.includes(expected.newestLabel);
    evictedPrefixFound ||= scanWindow.includes(expected.evictedPrefixLabel);
    carry = scanWindow.slice(-markerWindow);
  }
  try {
    const finalText = decoder.decode();
    const finalWindow = `${carry}${finalText}`;
    oldestFound ||= finalWindow.includes(expected.oldestLabel);
    newestFound ||= finalWindow.includes(expected.newestLabel);
    evictedPrefixFound ||= finalWindow.includes(expected.evictedPrefixLabel);
    maxMaterializedTextChars = Math.max(maxMaterializedTextChars, finalWindow.length);
  } catch {
    validEncoding = false;
  }
  const digestHex = rollingHash.digest('hex');
  const startDigest = evidence.start?.message?.digest
    && typeof evidence.start.message.digest === 'object'
    ? evidence.start.message.digest as Record<string, unknown>
    : null;
  const commitDigest = evidence.commit?.message?.digest
    && typeof evidence.commit.message.digest === 'object'
    ? evidence.commit.message.digest as Record<string, unknown>
    : null;
  const maximumDecodedChunkBytes = Math.max(0, ...evidence.chunks.map(frame => (
    Number(frame.message?.encodedBytes ?? 0)
  )));
  return {
    validEncoding,
    decodedBytes,
    digest: { algorithm: 'sha256', hex: digestHex },
    rollingDigestMatchesCheckpoint: startDigest?.algorithm === 'sha256'
      && commitDigest?.algorithm === 'sha256'
      && startDigest.hex === digestHex
      && commitDigest.hex === digestHex,
    encodedByteTotalsMatch: evidence.start?.message?.encodedByteTotal === decodedBytes
      && evidence.commit?.message?.encodedByteTotal === decodedBytes,
    oldestBoundaryFound: oldestFound,
    newestBoundaryFound: newestFound,
    evictedPrefixAbsent: !evictedPrefixFound,
    maxMaterializedTextChars,
    maximumDecodedChunkBytes,
    boundedStreamingWindow: maxMaterializedTextChars <= maximumDecodedChunkBytes + markerWindow,
    fullPayloadConcatenations: 0,
  };
}

function independentCheckpointBufferOracle(
  evidence: CheckpointTransactionEvidence,
  expected: {
    activeBuffer: 'normal' | 'alternate';
    normalMarker: string;
    alternateMarker: string;
    savedCursorRequired: boolean;
    expectedSavedCursor?: { x: number; y: number; cell: string };
  },
) {
  const ansi = decodedCheckpointAnsi(evidence);
  const alternateEnterIndex = ansi?.lastIndexOf('\u001b[?1049h') ?? -1;
  const alternateExitIndex = ansi?.lastIndexOf('\u001b[?1049l') ?? -1;
  const finalAlternateActive = alternateEnterIndex >= 0 && alternateEnterIndex > alternateExitIndex;
  const normalRegion = alternateEnterIndex >= 0 ? ansi?.slice(0, alternateEnterIndex) ?? '' : ansi ?? '';
  const alternateRegion = alternateEnterIndex >= 0 ? ansi?.slice(alternateEnterIndex) ?? '' : '';
  const cursorRoundTrip = ansi === null || !expected.expectedSavedCursor
    ? null
    : simulateCheckpointCursorRoundTrip(ansi, expected.expectedSavedCursor);
  return {
    payloadDecoded: ansi !== null,
    normalMarkerPresent: normalRegion.includes(expected.normalMarker),
    alternateMarkerPresent: alternateRegion.includes(expected.alternateMarker),
    activeBuffer: finalAlternateActive ? 'alternate' : 'normal',
    activeBufferMatches: (finalAlternateActive ? 'alternate' : 'normal') === expected.activeBuffer,
    savedCursorRoundTripPresent: !expected.savedCursorRequired || cursorRoundTrip?.valid === true,
    cursorRoundTrip,
    metadataIndependent: true,
  };
}

function simulateCheckpointCursorRoundTrip(
  checkpointAnsi: string,
  expected: { x: number; y: number; cell: string },
) {
  type BufferName = 'normal' | 'alternate';
  const cursor: Record<BufferName, { x: number; y: number }> = {
    normal: { x: 0, y: 0 },
    alternate: { x: 0, y: 0 },
  };
  const cells: Record<BufferName, Map<string, string>> = {
    normal: new Map(),
    alternate: new Map(),
  };
  let active: BufferName = 'normal';
  let savedNormal: { x: number; y: number } | null = null;
  let saveCount = 0;
  let restoreCount = 0;
  const stream = `${checkpointAnsi}\u001b[?1049l\u001b8`;
  for (let index = 0; index < stream.length;) {
    const codePoint = stream.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x1b) {
      const next = stream[index + 1];
      if (next === '[') {
        let end = index + 2;
        while (end < stream.length && !/[\x40-\x7e]/u.test(stream[end]!)) end += 1;
        if (end >= stream.length) break;
        const paramsText = stream.slice(index + 2, end);
        const final = stream[end];
        const params = paramsText.replace(/^\?/u, '').split(';').map(value => Number(value || 0));
        if (final === 'H' || final === 'f') {
          cursor[active] = {
            x: Math.max(0, (params[1] || 1) - 1),
            y: Math.max(0, (params[0] || 1) - 1),
          };
        } else if (final === 'A') {
          cursor[active].y = Math.max(0, cursor[active].y - (params[0] || 1));
        } else if (final === 'B') {
          cursor[active].y += params[0] || 1;
        } else if (final === 'C') {
          cursor[active].x += params[0] || 1;
        } else if (final === 'D') {
          cursor[active].x = Math.max(0, cursor[active].x - (params[0] || 1));
        } else if (paramsText === '?1049' && final === 'h') {
          active = 'alternate';
        } else if (paramsText === '?1049' && final === 'l') {
          active = 'normal';
        }
        index = end + 1;
        continue;
      }
      if (next === '7') {
        if (active === 'normal') savedNormal = { ...cursor.normal };
        saveCount += 1;
        index += 2;
        continue;
      }
      if (next === '8') {
        if (active === 'normal' && savedNormal) cursor.normal = { ...savedNormal };
        restoreCount += 1;
        index += 2;
        continue;
      }
      if (next === 'c') {
        cursor.normal = { x: 0, y: 0 };
        cursor.alternate = { x: 0, y: 0 };
        cells.normal.clear();
        cells.alternate.clear();
        savedNormal = null;
        index += 2;
        continue;
      }
      index += 2;
      continue;
    }
    if (codePoint === 0x0d) {
      cursor[active].x = 0;
    } else if (codePoint === 0x0a) {
      cursor[active].y += 1;
    } else if (codePoint >= 0x20 && codePoint !== 0x7f) {
      cells[active].set(`${cursor[active].x}:${cursor[active].y}`, String.fromCodePoint(codePoint));
      cursor[active].x += 1;
    }
    index += width;
  }
  const restoredCell = cells.normal.get(`${cursor.normal.x}:${cursor.normal.y}`) ?? null;
  return {
    saveCount,
    restoreCount,
    restoredCursor: cursor.normal,
    restoredCell,
    expected,
    valid: saveCount > 0
      && restoreCount > 0
      && cursor.normal.x === expected.x
      && cursor.normal.y === expected.y
      && restoredCell === expected.cell,
  };
}

async function waitForAuthoritativeCheckpointSettlement(
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
  timeoutMs = 8_000,
): Promise<CheckpointTransactionEvidence> {
  const deadline = Date.now() + timeoutMs;
  let evidence = serverCheckpointEvidence(
    harness,
    live.generation,
    live.sessionId,
    live.viewGeneration,
  );
  while (!evidence.validation.settled && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    evidence = serverCheckpointEvidence(
      harness,
      live.generation,
      live.sessionId,
      live.viewGeneration,
    );
  }
  return serverCheckpointEvidence(
    harness,
    live.generation,
    live.sessionId,
    live.viewGeneration,
  );
}

const CHECKPOINT_BOUNDARY_IDENTITY_KEYS = CHECKPOINT_IDENTITY_KEYS.filter(key => key !== 'sourceSeq');

function sameCheckpointBoundary(message: JsonFrame, identity: CheckpointIdentity): boolean {
  return CHECKPOINT_BOUNDARY_IDENTITY_KEYS.every(key => message[key] === identity[key]);
}

function decodedTerminalOutput(message: JsonFrame): string {
  if (typeof message.data !== 'string') return '';
  return message.encoding === 'base64'
    ? Buffer.from(message.data, 'base64').toString('utf8')
    : message.data;
}

async function observeRenderedMarker(page: Page, marker: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.locator('.terminal-view:visible .xterm-rows').first().textContent() ?? '';
    if (text.includes(marker)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

async function observeRenderedSessionMarker(
  page: Page,
  sessionId: string,
  marker: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  const runtime = visibleSessionRuntime(page, sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await runtime.locator('.xterm-rows').textContent() ?? '';
    if (text.includes(marker)) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

async function captureStableRetainedState(
  page: Page,
  sessionId: string,
  timeoutMs = 8_000,
): Promise<TerminalRetainedStateEvidence> {
  const deadline = Date.now() + timeoutMs;
  let previous = await captureRetainedState(page, sessionId);
  let consecutiveMatches = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await captureRetainedState(page, sessionId);
    if (current.digest === previous.digest) {
      consecutiveMatches += 1;
      if (consecutiveMatches >= 2) return current;
    } else {
      consecutiveMatches = 0;
    }
    previous = current;
  }
  return previous;
}

/**
 * Debug corpus injection drains the synthetic write, but a shell prompt that
 * was already emitted by the real PTY can still arrive immediately after it.
 * Capture the pre-remount checkpoint only after that producer has been quiet
 * long enough for the same retained state to be authoritative on both sides.
 */
async function captureQuiescentRetainedState(
  page: Page,
  sessionId: string,
  quietWindowMs = 1_000,
  timeoutMs = 12_000,
): Promise<TerminalRetainedStateEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest = await captureRetainedState(page, sessionId);
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const current = await captureRetainedState(page, sessionId);
    if (current.digest !== latest.digest) {
      latest = current;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietWindowMs) return current;
  }
  return latest;
}

interface PostSnapshotTailEvidence {
  marker: string;
  commandEchoSafe: boolean;
  routedOutputObserved: boolean;
  rendered: boolean;
  promptSettled: boolean;
  settlementMode: 'shell-prompt' | 'dispatch-output-quiescence';
  deliverySettled: boolean;
  sourceSequences: string[];
  allSourceSequencesAfterSnapshot: boolean;
  checkpointDrainAckValid: boolean;
  quiescence: {
    captureMode: 'materialized' | 'streaming';
    stable: boolean;
    firstDigest: string | null;
    secondDigest: string | null;
  };
  state: TerminalRetainedStateEvidence | null;
  streamingState: StreamingRetainedCapture | null;
  dispatchEvidence: Record<string, unknown> | null;
}

async function sendPostSnapshotTailAndWait(
  page: Page,
  harness: RoutedWebSocketHarness,
  live: LiveTerminal,
  checkpoint: CheckpointTransactionEvidence,
  marker: string,
  options: {
    captureMode?: 'materialized' | 'streaming';
    timeoutMs?: number;
    dispatch?: () => Promise<Record<string, unknown>>;
  } = {},
): Promise<PostSnapshotTailEvidence> {
  const captureMode = options.captureMode ?? 'materialized';
  const timeoutMs = options.timeoutMs ?? 8_000;
  const command = buildEchoSafeMarkerCommand(marker);
  const commandEchoSafe = options.dispatch ? true : !command.includes(marker);
  const afterIndex = harness.frames.length - 1;
  let dispatchEvidence: Record<string, unknown> | null = null;
  if (options.dispatch) {
    dispatchEvidence = await options.dispatch();
  } else if (checkpoint.validation.settled) {
    await sendVisibleTerminalCommand(page, live.sessionId, command);
  }
  const deadline = Date.now() + timeoutMs;
  let outputFrames: CapturedFrame[] = [];
  while (checkpoint.validation.settled && Date.now() < deadline) {
    outputFrames = harness.matching(
      'server-to-page',
      message => message.type === 'terminal-checkpoint:output'
        && checkpoint.identity !== null
        && sameCheckpointBoundary(message, checkpoint.identity),
      { generation: live.generation, afterIndex },
    ).filter(frame => frame.origin === 'routed-server');
    if (outputFrames.map(frame => decodedTerminalOutput(frame.message!)).join('').includes(marker)) break;
    await page.waitForTimeout(25);
  }
  const routedOutputObserved = outputFrames
    .map(frame => decodedTerminalOutput(frame.message!))
    .join('')
    .includes(marker);
  const rendered = routedOutputObserved ? await observeRenderedMarker(page, marker) : false;
  let promptSettled = false;
  if (rendered && !options.dispatch) {
    const promptDeadline = Date.now() + timeoutMs;
    while (Date.now() < promptDeadline) {
      const text = await page.locator('.terminal-view:visible .xterm-rows').first().textContent() ?? '';
      if (/PS\s+[^>]*>\s*$/u.test(text)) {
        promptSettled = true;
        break;
      }
      await page.waitForTimeout(50);
    }
  }
  const sourceSequences = outputFrames
    .map(frame => frame.message?.sourceSeq)
    .filter((value): value is string => isCanonicalOrdinal(value));
  const snapshotSeq = checkpoint.identity?.snapshotSeq;
  const allSourceSequencesAfterSnapshot = routedOutputObserved
    && isCanonicalOrdinal(snapshotSeq)
    && sourceSequences.length > 0
    && sourceSequences.every(sourceSeq => BigInt(sourceSeq) > BigInt(snapshotSeq as string));
  let state: TerminalRetainedStateEvidence | null = null;
  let streamingState: StreamingRetainedCapture | null = null;
  let firstDigest: string | null = null;
  let secondDigest: string | null = null;
  let stable = false;
  if (captureMode === 'streaming') {
    const first = await captureStreamingRetainedState(page, live.sessionId);
    await page.waitForTimeout(100);
    streamingState = await captureStreamingRetainedState(page, live.sessionId);
    firstDigest = first.evidence?.fullStateSha256 ?? null;
    secondDigest = streamingState.evidence?.fullStateSha256 ?? null;
    stable = first.available
      && streamingState.available
      && firstDigest !== null
      && firstDigest === secondDigest;
  } else {
    state = await captureStableRetainedState(page, live.sessionId);
    await page.waitForTimeout(100);
    const second = await captureRetainedState(page, live.sessionId);
    firstDigest = state.digest;
    secondDigest = second.digest;
    stable = firstDigest === secondDigest;
    state = second;
  }
  const dispatchAccepted = options.dispatch
    ? dispatchEvidence?.httpStatus === 202 && dispatchEvidence.accepted === true
    : true;
  const deliverySettled = options.dispatch
    ? dispatchAccepted
      && routedOutputObserved
      && allSourceSequencesAfterSnapshot
      && checkpoint.validation.drainAckValid
      && rendered
      && stable
    : promptSettled && stable;
  return {
    marker,
    commandEchoSafe,
    routedOutputObserved,
    rendered,
    promptSettled,
    settlementMode: options.dispatch ? 'dispatch-output-quiescence' : 'shell-prompt',
    deliverySettled,
    sourceSequences,
    allSourceSequencesAfterSnapshot,
    checkpointDrainAckValid: checkpoint.validation.drainAckValid,
    quiescence: { captureMode, stable, firstDigest, secondDigest },
    state,
    streamingState,
    dispatchEvidence,
  };
}

function buildAlternateActiveFixtureContract(marker: string): Record<string, unknown> {
  const normalMarker = `${marker}-INACTIVE-NORMAL`;
  const savedCursorCell = '@';
  const rawData = [
    '\u001bc',
    `\u001b[4;7H\u001b[38;5;214m${normalMarker}\u001b[0m`,
    `\u001b[6;9H${savedCursorCell}\u001b[6;9H\u001b7`,
    `\u001b[?1049h\u001b[2;5H\u001b[1;38;5;81m${marker}\u001b[0m`,
  ].join('');
  const payload = Buffer.from(rawData, 'utf8');
  return {
    contractVersion: 1,
    retainedPolicyOverride: {
      action: 'preserve-session-retained-policy',
      scope: 'session-generation-test-isolation',
      effectiveRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
      maximumConfiguredBoundaryEvidence: PH005_MAX_POLICY_BOUNDARY_CONTRACT,
    },
    retainedCorpusInjection: {
      action: 'inject-authoritative-raw-output-preserving-server-authority',
      encoding: 'base64',
      data: payload.toString('base64'),
      decodedBytes: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
      activeBufferExpectation: 'alternate',
      savedCursorExpectation: 'present-normal-buffer',
      expectedNewestLabel: marker,
      expectedInactiveNormalMarker: normalMarker,
      expectedSavedCursor: { x: 8, y: 5, cell: savedCursorCell },
    },
  };
}

function alternateInactiveNormalMarker(marker: string): string {
  return `${marker}-INACTIVE-NORMAL`;
}

function alternateSavedCursorExpectation() {
  return { x: 8, y: 5, cell: '@' } as const;
}

function checkpointRetainedRange(evidence: ReturnType<typeof serverCheckpointEvidence>) {
  const metadata = evidence.start?.message;
  const oldestRetainedSeq = metadata?.oldestRetainedSeq;
  const newestRetainedSeq = metadata?.snapshotSeq;
  const canonical = isCanonicalOrdinal(oldestRetainedSeq) && isCanonicalOrdinal(newestRetainedSeq);
  return {
    retainedLineCount: metadata?.retainedLineCount,
    oldestRetainedSeq,
    newestRetainedSeq,
    canonical,
    ordered: canonical && BigInt(oldestRetainedSeq as string) <= BigInt(newestRetainedSeq as string),
  };
}

interface ServerDebugCaptureEvent {
  eventId: number;
  kind: string;
  details?: Record<string, unknown>;
}

interface ServerDebugCaptureSnapshot {
  enabled: boolean;
  server: ServerDebugCaptureEvent[];
}

async function enableServerDebugCapture(page: Page, sessionId: string): Promise<void> {
  const status = await page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}/enable`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return response.status;
  }, sessionId);
  if (status !== 204) {
    throw new Error(`E2E precondition failed: server debug capture enable returned ${status}`);
  }
}

async function readServerDebugCapture(page: Page, sessionId: string): Promise<ServerDebugCaptureSnapshot> {
  const result = await page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}?limit=500`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }, sessionId);
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') {
    throw new Error(`E2E precondition failed: server debug capture read returned ${result.status}`);
  }
  const candidate = result.body as { enabled?: unknown; server?: unknown };
  if (candidate.enabled !== true || !Array.isArray(candidate.server)) {
    throw new Error('E2E precondition failed: server debug capture response is not enabled event evidence');
  }
  const server = candidate.server.filter((event): event is ServerDebugCaptureEvent => (
    event !== null
    && typeof event === 'object'
    && Number.isSafeInteger((event as { eventId?: unknown }).eventId)
    && typeof (event as { kind?: unknown }).kind === 'string'
  ));
  if (server.length !== candidate.server.length) {
    throw new Error('E2E precondition failed: server debug capture contained malformed events');
  }
  return { enabled: true, server };
}

async function disableServerDebugCapture(page: Page, sessionId: string): Promise<void> {
  const status = await page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return response.status;
  }, sessionId);
  if (status !== 204) {
    throw new Error(`server debug capture disable/clear returned ${status}`);
  }
}

async function triggerServerAuthorityFault(
  page: Page,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}/terminal-authority-fault`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        faultPoint: 'legacy-disable-ack-immediate-send-failed',
        expectedAction: 'server-abort-rollback-without-pausing-pty',
      }),
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      httpStatus: response.status,
    };
  }, sessionId);
}

async function triggerServerAuthorityRollback(
  page: Page,
  sessionId: string,
  testContract?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ id, requestedTestContract }) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}/terminal-authority-rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        reason: 'https-e2e-multi-view-rollback-drill',
        expectedAffectedViewPolicy: 'freeze-all-current-responder-views',
        ...(requestedTestContract ? { testContract: requestedTestContract } : {}),
      }),
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      httpStatus: response.status,
    };
  }, { id: sessionId, requestedTestContract: testContract });
}

async function triggerServerHeadlessQueryProbe(
  page: Page,
  sessionId: string,
  preparation: Record<string, unknown>,
  checkpoint: CheckpointTransactionEvidence,
  query: string,
  expectedReply: string,
): Promise<Record<string, unknown>> {
  const queryBytes = Buffer.from(query, 'utf8');
  return page.evaluate(async ({ id, cleanupToken, isolationLeaseId, modelInstanceId, query }) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}/terminal-authority-test-isolation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        desiredMode: 'server',
        transitionPolicy: 'preserve-current-server-authority',
        testContract: {
          contractVersion: 1,
          cleanupToken,
          isolationLeaseId,
          queryResponderProbe: {
            action: 'inject-live-pty-output-into-authoritative-headless-model',
            authoritativeModelInstanceId: modelInstanceId,
            encoding: 'base64',
            data: query.data,
            decodedBytes: query.decodedBytes,
            sha256: query.sha256,
            duplicateProbeCount: 3,
            probeSources: ['seed', 'replay', 'live'],
            expectedReplyEncoding: 'base64',
            expectedReplyData: query.expectedReplyData,
          },
        },
      }),
    });
    const body = await response.json().catch(() => null);
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      httpStatus: response.status,
    };
  }, {
    id: sessionId,
    cleanupToken: preparation.cleanupToken ?? null,
    isolationLeaseId: preparation.isolationLeaseId ?? null,
    modelInstanceId: checkpoint.start?.message?.authoritativeModelInstanceId ?? null,
    query: {
      data: queryBytes.toString('base64'),
      decodedBytes: queryBytes.byteLength,
      sha256: createHash('sha256').update(queryBytes).digest('hex'),
      expectedReplyData: Buffer.from(expectedReply, 'utf8').toString('base64'),
    },
  });
}

async function triggerConfiguredPostSnapshotTail(
  page: Page,
  sessionId: string,
  preparation: Record<string, unknown>,
  checkpoint: CheckpointTransactionEvidence,
  tail: ProductionConfiguredCorpusContract['deterministicTail'],
): Promise<Record<string, unknown>> {
  return page.evaluate(async ({ id, cleanupToken, isolationLeaseId, checkpointIdentity, tailInput }) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${id}/terminal-authority-test-isolation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        desiredMode: 'server',
        transitionPolicy: 'preserve-current-server-authority',
        testContract: {
          contractVersion: 1,
          cleanupToken,
          isolationLeaseId,
          deterministicPostSnapshotTail: {
            action: 'inject-authoritative-output-after-checkpoint-drain',
            checkpointIdentity,
            encoding: 'base64',
            data: tailInput.encodedData,
            decodedBytes: tailInput.decodedBytes,
            sha256: tailInput.sha256,
            expectedLiteralMarker: tailInput.data,
            echoSource: 'server-test-isolation-no-shell-command',
          },
        },
      }),
    });
    const body = await response.json().catch(() => null);
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      httpStatus: response.status,
    };
  }, {
    id: sessionId,
    cleanupToken: preparation.cleanupToken ?? null,
    isolationLeaseId: preparation.isolationLeaseId ?? null,
    checkpointIdentity: checkpoint.identity,
    tailInput: tail,
  });
}

async function prepareServerAuthorityTestState(
  page: Page,
  sessionId: string,
  desiredMode: 'legacy' | 'server',
  testContract?: Record<string, unknown>,
  options: Readonly<{ retryTransient?: boolean }> = {},
): Promise<Record<string, unknown>> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  const requestTimeoutMs = testContract?.productionConfiguredRangeProbe !== undefined
    ? 180_000
    : 30_000;
  const request = async () => {
    const response = await page.request.post(
      `/api/sessions/debug-capture/${sessionId}/terminal-authority-test-isolation`,
      {
        timeout: requestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        data: {
          desiredMode,
          transitionPolicy: desiredMode === 'legacy'
            ? 'fresh-compatibility-rollback-and-all-view-drain'
            : 'capability-gated-limited-promotion-and-all-view-drain',
          ...(testContract ? { testContract } : {}),
        },
      },
    );
    const responseText = await response.text();
    let body: unknown = null;
    try { body = responseText.length > 0 ? JSON.parse(responseText) : null; } catch { body = null; }
    return {
      ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
      httpStatus: response.status(),
      ...(body === null && responseText.length > 0 ? { responseText } : {}),
    };
  };
  const deadline = Date.now() + 15_000;
  let result = await request();
  if (options.retryTransient === false) return result;
  while (result.httpStatus === 409 && Date.now() < deadline) {
    const error = result.error && typeof result.error === 'object'
      ? result.error as Record<string, unknown>
      : null;
    const reason = typeof error?.message === 'string' ? error.message : '';
    if (reason !== 'screen-repair-active'
      && reason !== 'server-recovery-ack-missing'
      && reason !== 'compatibility-view-unavailable'
      && reason !== 'compatibility-checkpoint-enqueue-failed'
      && reason !== 'promotion-boundary-invalidated'
      && reason !== 'rollback-transaction-invalidated'
      && reason !== 'terminal-authority-debug-cleanup-unsupported-mode-promoting'
      && !reason.endsWith('-gate-failed')) break;
    await page.waitForTimeout(100);
    result = await request();
  }
  return result;
}

async function cleanupServerAuthorityTestState(
  page: Page,
  sessionId: string,
  preparation: Record<string, unknown>,
  harness?: RoutedWebSocketHarness,
): Promise<Record<string, unknown>> {
  const cleanupToken = typeof preparation.cleanupToken === 'string' ? preparation.cleanupToken : null;
  const isolationLeaseId = typeof preparation.isolationLeaseId === 'string'
    ? preparation.isolationLeaseId
    : null;
  const cleanupContract = {
    contractVersion: 1,
    cleanup: {
      action: cleanupToken && isolationLeaseId
        ? 'restore-session-test-isolation-by-token-and-lease'
        : 'sentinel-best-effort-legacy-restore',
      cleanupToken,
      isolationLeaseId,
      restoreScopes: [
        'session-local-retained-policy',
        'retained-corpus',
        'alternate-buffer-fixture',
        'responder-mode',
        'listeners',
        'driver-and-responder-leases',
        'timers',
        'fault-state',
      ],
    },
  };
  let cleanup: Record<string, unknown> | null = null;
  let idempotentCleanup: Record<string, unknown> | null = null;
  let inventory: Record<string, unknown> | null = null;
  const attemptFailures: string[] = [];
  const cleanupSequence = await runCleanupAttemptSequence(() => prepareServerAuthorityTestState(
    page,
    sessionId,
    'legacy',
    cleanupContract,
    { retryTransient: false },
  ), {
    retryFirstResponse: response => {
      const error = response.error;
      return response.httpStatus === 503
        && error !== null
        && typeof error === 'object'
        && !Array.isArray(error)
        && (error as Record<string, unknown>).code === 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE'
        && (error as Record<string, unknown>).message === 'terminal-authority-debug-legacy-settle-timeout';
    },
    maxAttempts: 2,
  });
  cleanup = cleanupSequence.cleanup;
  idempotentCleanup = cleanupSequence.idempotentCleanup;
  const cleanupErrorFingerprint = (error: unknown): string => createHash('sha256')
    .update(error instanceof Error ? error.message : String(error), 'utf8')
    .digest('hex')
    .slice(0, 12);
  if (cleanupSequence.firstError) {
    attemptFailures.push(
      `first-cleanup-request-error-fingerprint:${cleanupErrorFingerprint(cleanupSequence.firstError)}`,
    );
  }
  if (cleanupSequence.idempotentError) {
    attemptFailures.push(
      `idempotent-cleanup-request-error-fingerprint:${cleanupErrorFingerprint(
        cleanupSequence.idempotentError,
      )}`,
    );
  }
  try {
    inventory = await inspectServerAuthorityTestResources(page, sessionId);
  } catch (error) {
    attemptFailures.push(
      `inventory-request-error-fingerprint:${cleanupErrorFingerprint(error)}`,
    );
  }
  const verifyAttempt = (label: string, assertion: () => void): void => {
    try {
      assertion();
    } catch (error) {
      attemptFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  verifyAttempt('first-cleanup-response', () => {
    if (!cleanupToken || !isolationLeaseId) {
      if (cleanup?.httpStatus === 404) return;
      if (cleanup?.httpStatus === 409 || cleanup?.httpStatus === 503) {
        const expectedTransientErrors = cleanup.httpStatus === 409
          ? [
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'terminal-authority-debug-production-cleanup-lease-mismatch',
              },
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'compatibility-view-unavailable',
              },
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'rollback-transaction-invalidated',
              },
            ]
          : [{
              code: 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
              message: 'terminal-authority-debug-session-runtime-unavailable',
            }];
        expect(
          expectedTransientErrors,
          'E2E cleanup failed: a recoverable sentinel race must remain explicit',
        ).toContainEqual(cleanup.error);
        return;
      }
      expect(cleanup, 'E2E cleanup failed: sentinel cleanup must confirm zero inventory').toMatchObject({
        httpStatus: 200,
        accepted: true,
        guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        cleanup: {
          accepted: true,
          resourceInventory: expectedZeroIsolationResourceInventory(),
        },
      });
      return;
    }
    expect(cleanup, 'E2E cleanup failed: first cleanup response must be successful').toMatchObject({
      httpStatus: 200,
      accepted: true,
      mode: 'legacy',
      source: 'server-test-isolation',
      allAffectedViewsDrained: true,
      guardEvidence: expectedTerminalAuthorityGuardEvidence(),
      cleanup: {
        accepted: true,
        cleanupToken,
        isolationLeaseId,
        isolationLeaseReleased: true,
        resourceInventory: expectedZeroIsolationResourceInventory(),
      },
    });
  });
  if (preparation.httpStatus === 200) {
    verifyAttempt('successful-preparation-restoration', () => {
      expect(cleanup, 'E2E cleanup failed: a successful authority preparation must restore every scope').toMatchObject({
        cleanup: {
          restored: {
            sessionLocalRetainedPolicy: true,
            retainedCorpus: true,
            alternateBufferFixture: true,
            responderMode: true,
            listeners: true,
            driverAndResponderLeases: true,
            timers: true,
            faultState: true,
          },
        },
      });
    });
  }
  verifyAttempt('idempotent-cleanup-response', () => {
    if (!cleanupToken || !isolationLeaseId) {
      if (idempotentCleanup?.httpStatus === 404) return;
      if (idempotentCleanup?.httpStatus === 409 || idempotentCleanup?.httpStatus === 503) {
        const expectedTransientErrors = idempotentCleanup.httpStatus === 409
          ? [
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'terminal-authority-debug-production-cleanup-lease-mismatch',
              },
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'compatibility-view-unavailable',
              },
              {
                code: 'TERMINAL_AUTHORITY_DEBUG_CONFLICT',
                message: 'rollback-transaction-invalidated',
              },
            ]
          : [{
              code: 'TERMINAL_AUTHORITY_DEBUG_EVIDENCE_UNAVAILABLE',
              message: 'terminal-authority-debug-session-runtime-unavailable',
            }];
        expect(
          expectedTransientErrors,
          'E2E cleanup failed: an idempotent sentinel race must remain explicit',
        ).toContainEqual(idempotentCleanup.error);
        return;
      }
      expect(
        idempotentCleanup,
        'E2E cleanup failed: sentinel cleanup must remain idempotently empty',
      ).toMatchObject({
        httpStatus: 200,
        accepted: true,
        guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        cleanup: {
          accepted: true,
          resourceInventory: expectedZeroIsolationResourceInventory(),
        },
      });
      return;
    }
    expect(
      idempotentCleanup,
      'E2E cleanup failed: cleanup must be idempotent with the same token and lease',
    ).toMatchObject({
      httpStatus: 200,
      accepted: true,
      mode: 'legacy',
      cleanup: {
        accepted: true,
        cleanupToken,
        isolationLeaseId,
        isolationLeaseReleased: true,
        resourceInventory: expectedZeroIsolationResourceInventory(),
      },
    });
  });
  verifyAttempt('zero-inventory-response', () => {
    if (!cleanupToken && !isolationLeaseId && inventory?.httpStatus === 404) return;
    expect(
      inventory,
      'E2E cleanup failed: cleanup completion must leave the session isolation inventory at zero',
    ).toMatchObject({
      httpStatus: 200,
      accepted: true,
      isolationLeaseAcquired: false,
      resourceInventory: expectedZeroIsolationResourceInventory(),
    });
  });
  if (attemptFailures.length > 0) {
    const rollbackFrames = harness?.frames.filter(frame => (
      frame.message?.sessionId === sessionId
      && (
        frame.message.type === 'terminal-authority:rollback-start'
        || frame.message.type === 'terminal-authority:compatibility-drained'
        || frame.message.type === 'terminal-authority:compatibility-drain-accepted'
        || frame.message.type === 'terminal-authority:legacy-responder-enabled'
        || frame.message.type === 'terminal-checkpoint:apply-ack'
        || frame.message.type === 'terminal-checkpoint:drain-ack'
        || frame.message.type === 'terminal-checkpoint:rejected'
      )
    )).slice(-120).map(frame => {
      const message = frame.message!;
      return {
        direction: frame.direction,
        generation: frame.generation,
        origin: frame.origin,
        message: {
          type: message.type,
          sessionId: message.sessionId,
          connectionId: message.connectionId,
          viewGeneration: message.viewGeneration,
          transitionEpoch: message.transitionEpoch,
          streamEpoch: message.streamEpoch,
          checkpointEpoch: message.checkpointEpoch,
          responderLeaseId: message.responderLeaseId,
          accepted: message.accepted,
          completed: message.completed,
          duplicate: message.duplicate,
          reason: message.reason,
          rejectedMessageType: message.rejectedMessageType,
          ackIdentity: message.ackIdentity,
          affectedViews: Array.isArray(message.affectedViews)
            ? message.affectedViews.map(view => ({
                connectionId: (view as Record<string, unknown>).connectionId,
                viewGeneration: (view as Record<string, unknown>).viewGeneration,
              }))
            : undefined,
        },
      };
    });
    throw new Error(
      `E2E cleanup failed; all cleanup and inventory attempts completed: ${attemptFailures.join(' | ')}; `
      + `responses=${JSON.stringify({ cleanup, idempotentCleanup, inventory })}; `
      + `rollbackFrames=${JSON.stringify(rollbackFrames ?? [])}`,
    );
  }
  return cleanup?.httpStatus === 200 ? cleanup : idempotentCleanup!;
}

function expectedZeroIsolationResourceInventory() {
  return {
    retainedPolicyOverrides: 0,
    cleanupTokens: 0,
    isolationLeases: 0,
    retainedCorpusFixtures: 0,
    alternateBufferFixtures: 0,
    responderOverrides: 0,
    listeners: 0,
    driverLeases: 0,
    responderLeases: 0,
    timers: 0,
    faultStates: 0,
    queryEffectLedgers: 0,
    heldOutputQueues: 0,
  };
}

async function inspectServerAuthorityTestResources(
  page: Page,
  sessionId: string,
  authToken?: string | null,
  requestTimeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  if (authToken === undefined) {
    return page.evaluate(async (id) => {
      const token = localStorage.getItem('cws_auth_token');
      const response = await fetch(`/api/sessions/debug-capture/${id}/terminal-authority-test-isolation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          desiredMode: 'legacy',
          transitionPolicy: 'read-only-fresh-session-baseline',
          testContract: {
            contractVersion: 1,
            inventory: { action: 'inspect-without-acquiring-isolation-lease' },
          },
        }),
      });
      const body = await response.json().catch(() => null);
      return {
        ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
        httpStatus: response.status,
      };
    }, sessionId);
  }
  const response = await page.request.post(
    `${E2E_APP_ORIGIN}/api/sessions/debug-capture/${sessionId}/terminal-authority-test-isolation`,
    {
      timeout: requestTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      data: {
        desiredMode: 'legacy',
        transitionPolicy: 'read-only-fresh-session-baseline',
        testContract: {
          contractVersion: 1,
          inventory: { action: 'inspect-without-acquiring-isolation-lease' },
        },
      },
    },
  );
  const body = await response.json().catch(() => null);
  return {
    ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
    httpStatus: response.status(),
  };
}

async function inspectDetachedServerAuthorityTestResources(
  sessionId: string,
  authToken: string | null | undefined,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify({
    desiredMode: 'legacy',
    transitionPolicy: 'read-only-fresh-session-baseline',
    testContract: {
      contractVersion: 1,
      inventory: { action: 'inspect-without-acquiring-isolation-lease' },
    },
  });
  const endpoint = new URL(
    `/api/sessions/debug-capture/${sessionId}/terminal-authority-test-isolation`,
    E2E_APP_ORIGIN,
  );
  return new Promise((resolve, reject) => {
    const request = httpsRequest(endpoint, {
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try { body = responseText.length > 0 ? JSON.parse(responseText) : null; } catch { body = null; }
        resolve({
          ...(body && typeof body === 'object' ? body as Record<string, unknown> : {}),
          httpStatus: response.statusCode ?? 0,
          ...(body === null && responseText.length > 0 ? { responseText } : {}),
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(
      `detached-server-authority-inventory-timeout:${timeoutMs}`,
    )));
    request.once('error', reject);
    request.end(payload);
  });
}

async function probeDetachedServerHealth(timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = httpsRequest(new URL('/health', E2E_APP_ORIGIN), {
      method: 'GET',
      rejectUnauthorized: false,
    }, response => {
      response.resume();
      response.on('end', () => resolve({
        httpStatus: response.statusCode ?? 0,
        elapsedMs: Date.now() - startedAt,
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(
      `detached-server-health-timeout:${timeoutMs}`,
    )));
    request.once('error', reject);
    request.end();
  });
}

function expectedTerminalAuthorityGuardEvidence() {
  return {
    authentication: 'authMiddleware',
    locality: 'requireLocalDebugCapture',
    session: 'ensureDebugCaptureSessionExists',
    registration: 'server-executable-route-contract',
  };
}

async function probeTerminalAuthorityDebugRouteGuards(
  page: Page,
  serverGuardEvidence: unknown,
): Promise<Record<string, unknown>> {
  const routeResponses = await page.evaluate(async () => {
    const parse = async (response: Response) => {
      const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
      return {
        httpStatus: response.status,
        errorCode: typeof body?.error?.code === 'string' ? body.error.code : null,
      };
    };
    const unauthenticated = await fetch(
      '/api/sessions/debug-capture/ph005-guard-probe/terminal-authority-rollback',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    const token = localStorage.getItem('cws_auth_token');
    const missingSession = await fetch(
      `/api/sessions/debug-capture/ph005-missing-${Date.now()}/terminal-authority-test-isolation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ desiredMode: 'legacy' }),
      },
    );
    return {
      unauthenticated: await parse(unauthenticated),
      missingSession: await parse(missingSession),
    };
  });
  return {
    ...routeResponses,
    serverExecutableRegistration: serverGuardEvidence,
  };
}

test.describe('PH005 authority promotion E2E exact six-case contract and fail-closed artifact writer', () => {
  test.describe.configure({ retries: 0 });
  test.afterEach(async ({ page }) => {
    await deleteOwnedAuthorityWorkspace(page);
  });

  test('positional all-view handoff', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    const harness = new RoutedWebSocketHarness();
    let first = await bootLiveTerminal(page, harness);
    const peer = await context.newPage();
    let second: LiveTerminal | null = null;
    let unselectedSessionId: string | null = null;
    const heldMarkerTriggerPath = join(
      tmpdir(),
      `buildergate-ph005-held-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.trigger`,
    );
    let unblockSecondAck = () => {};
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    let bodyFailure: unknown = null;
    let cleanupFailure: unknown = null;
    const positionalRetryEvidence: {
      schemaVersion: 'ph005-retry-evidence/v1';
      operation: 'canary-selection';
      maxAttempts: 8;
      attempts: Array<{
        attempt: number;
        outcome: 'success' | 'retry' | 'terminal-failure';
        failureReason?: string;
        requestId: string;
      }>;
    } = {
      schemaVersion: 'ph005-retry-evidence/v1',
      operation: 'canary-selection',
      maxAttempts: 8,
      attempts: [],
    };
    try {
      first = await stabilizeLiveTerminalRegistration(harness, page, first);
      const freshPreparationBoundary = harness.frames.length - 1;
      preparation = await prepareServerAuthorityTestState(page, first.sessionId, 'legacy');
      if (preparation.httpStatus !== 200 || preparation.accepted !== true) {
        throw new Error(`positional legacy preparation failed: ${JSON.stringify(preparation)}`);
      }
      expect(preparation, 'positional preparation must return its cleanup ownership').toMatchObject({
        cleanupToken: expect.any(String),
        isolationLeaseId: expect.any(String),
      });
      await expect.poll(() => harness.matching(
        'server-to-page',
        message => message.type === 'screen-snapshot' && message.sessionId === first.sessionId,
        { afterIndex: freshPreparationBoundary },
      ).length, {
        message: 'positional preparation did not publish a replacement snapshot lineage',
        timeout: 20_000,
      }).toBeGreaterThan(0);
      first = await settleLiveTerminal(
        harness,
        page,
        first.sessionId,
        true,
        freshPreparationBoundary,
      );
      const latestNegotiation = harness.latest(
        'page-to-server',
        message => message.type === 'terminal-checkpoint:negotiate',
        first.generation,
      );
      expect(latestNegotiation?.message, 'live terminal capability negotiation must exist').toBeTruthy();
      const leaseRefreshFrameStart = harness.frames.length;
      harness.sendToServer(first.generation, latestNegotiation!.message!);
      await expect.poll(() => harness.frames
        .slice(leaseRefreshFrameStart)
        .some(frame => (
          frame.origin === 'routed-server'
          && frame.direction === 'server-to-page'
          && frame.message?.type === 'terminal-checkpoint:capability'
          && Array.isArray(frame.message.mutationLeases)
          && frame.message.mutationLeases.some(lease => (
            lease
            && typeof lease === 'object'
            && (lease as { sessionId?: unknown }).sessionId === first.sessionId
          ))
        )), {
        message: 'legacy isolation must refresh the browser mutation lease before PTY input',
        timeout: 10_000,
      }).toBe(true);
      const debugRouteGuards = await probeTerminalAuthorityDebugRouteGuards(
        page,
        preparation.guardEvidence,
      );
      const priorMarker = `PH005-PRIOR-${Date.now()}`;
      const heldMarker = `PH005-HELD-${Date.now()}`;
      await sendCommandThroughCurrentMutationLease(
        harness,
        first.sessionId,
        `Write-Output "${priorMarker}"`,
        page,
      );
      try {
        await waitForCommandMarker(page, first.sessionId, priorMarker);
      } catch (error) {
        const inputDiagnostics = harness.frames
          .filter(frame => (
            (frame.message?.sessionId === first.sessionId
              && ['input', 'input:rejected', 'output'].includes(frame.message?.type ?? ''))
            || (frame.message?.type === 'terminal-checkpoint:capability'
              && Array.isArray(frame.message.registeredViews)
              && frame.message.registeredViews.some(view => (
                view !== null
                && typeof view === 'object'
                && (view as Record<string, unknown>).sessionId === first.sessionId
              )))
          ))
          .slice(-30)
          .map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            message: frame.message,
          }));
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; `
          + `inputDiagnostics=${JSON.stringify(inputDiagnostics)}`,
        );
      }
      second = await bootAuthenticatedPeer(peer, harness);
      expect(second.sessionId, 'two actual browser views must attach to the same live session').toBe(first.sessionId);
      second = await stabilizeLiveTerminalRegistration(harness, peer, second, false);
      await expect.poll(() => new Set(harness.frames
        .filter(frame => (
          frame.origin === 'routed-server'
          && frame.message?.type === 'terminal-checkpoint:capability'
          && Array.isArray(frame.message.registeredViews)
          && (frame.message.registeredViews as Array<Record<string, unknown>>)
            .some(view => view.sessionId === first.sessionId)
        ))
        .map(frame => frame.generation)).size >= 2, {
        message: 'both live browser views must be registered before the all-view freeze begins',
        timeout: 10_000,
      }).toBe(true);
      unblockSecondAck = harness.blockPageToServer((message, generation) => (
        harness.ownerForGeneration(generation) === peer
        && message.type === 'terminal-authority:responder-disabled'
        && message.sessionId === first.sessionId
      ));
      unselectedSessionId = await createUnselectedSession(page);
      first = await stabilizeLiveTerminalRegistration(harness, page, first);
      const currentMainRegistration = [...harness.frames].reverse().find(frame => (
        frame.direction === 'page-to-server'
        && frame.origin === 'routed-page'
        && frame.message?.type === 'terminal-checkpoint:negotiate'
        && Array.isArray(frame.message.views)
        && frame.message.views.some(view => (
          view !== null
          && typeof view === 'object'
          && (view as Record<string, unknown>).sessionId === first.sessionId
        ))
        && harness.ownerForGeneration(frame.generation) === page
      ));
      const currentMainView = Array.isArray(currentMainRegistration?.message?.views)
        ? currentMainRegistration.message.views.find(view => (
            view !== null
            && typeof view === 'object'
            && (view as Record<string, unknown>).sessionId === first.sessionId
          )) as Record<string, unknown> | undefined
        : undefined;
      if (!currentMainRegistration || !Number.isSafeInteger(currentMainView?.viewGeneration)) {
        throw new Error('positional current main responder registration is unavailable');
      }
      first = {
        ...first,
        generation: currentMainRegistration.generation,
        viewGeneration: Number(currentMainView.viewGeneration),
      };
      let decisionFrame: CapturedFrame | null = null;
      let requestId = '';
      let registrationRefreshRequired = true;
      first = {
        ...first,
        generation: await sendCommandThroughCurrentMutationLease(
          harness,
          first.sessionId,
          `while (-not (Test-Path -LiteralPath '${heldMarkerTriggerPath.replace(/'/gu, "''")}')) { `
            + `Start-Sleep -Milliseconds 25 }; Write-Output "${heldMarker}"`,
          page,
        ),
      };
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (registrationRefreshRequired) {
          first = await registerCapableUnselectedResponder(harness, first, unselectedSessionId);
          first = await stabilizeLiveTerminalRegistration(harness, page, first);
          second = await stabilizeLiveTerminalRegistration(harness, peer, second, false);
          unsubscribeUnrelatedSessions(harness, first, [unselectedSessionId]);
          registrationRefreshRequired = false;
        }
        requestId = requestServerAuthorityCanary(harness, first);
        const candidateDecisionFrame = await waitForRoutedServerFrame(
          harness,
          message => message.type === 'terminal-authority:canary-decision'
            && message.requestId === requestId,
          4_000,
        );
        if (!candidateDecisionFrame) {
          positionalRetryEvidence.attempts.push({
            attempt: attempt + 1,
            outcome: 'retry',
            failureReason: 'canary-decision-timeout',
            requestId,
          });
          registrationRefreshRequired = true;
          await page.waitForTimeout(100);
          continue;
        }
        decisionFrame = candidateDecisionFrame;
        if (candidateDecisionFrame.message?.selectedSessionId === first.sessionId) {
          positionalRetryEvidence.attempts.push({
            attempt: attempt + 1,
            outcome: 'success',
            requestId,
          });
          break;
        }
        const targetGate = Array.isArray(candidateDecisionFrame.message?.capabilityGateEvidence)
          ? candidateDecisionFrame.message.capabilityGateEvidence.find(candidate => (
              candidate !== null
              && typeof candidate === 'object'
              && (candidate as Record<string, unknown>).sessionId === first.sessionId
            )) as Record<string, unknown> | undefined
          : undefined;
        if (targetGate?.replayRepairIdle !== false) {
          positionalRetryEvidence.attempts.push({
            attempt: attempt + 1,
            outcome: 'terminal-failure',
            failureReason: String(candidateDecisionFrame.message?.reason ?? 'target-not-selected'),
            requestId,
          });
          break;
        }
        positionalRetryEvidence.attempts.push({
          attempt: attempt + 1,
          outcome: 'retry',
          failureReason: 'target-replay-repair-not-idle',
          requestId,
        });
        await page.waitForTimeout(250);
      }
      const decision = decisionFrame?.message ?? null;
      if (decision?.selectedSessionId !== first.sessionId) {
        const capabilityFrames = harness.frames
          .filter(frame => (
            (frame.message?.type === 'terminal-checkpoint:negotiate'
              && Array.isArray(frame.message.views)
              && frame.message.views.some(view => (
                view !== null
                && typeof view === 'object'
                && [first.sessionId, unselectedSessionId]
                  .includes((view as Record<string, unknown>).sessionId as string)
              )))
            || (frame.message?.type === 'terminal-checkpoint:capability'
              && Array.isArray(frame.message.registeredViews)
              && frame.message.registeredViews.some(view => (
                view !== null
                && typeof view === 'object'
                && [first.sessionId, unselectedSessionId]
                  .includes((view as Record<string, unknown>).sessionId as string)
              )))
          ))
          .slice(-20)
          .map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            message: frame.message,
          }));
        const viewAttributeFrames = harness.frames
          .filter(frame => (
            frame.message?.sessionId === first.sessionId
            && (
              frame.message.type === 'terminal-authority:view-attributes'
              || frame.message.type === 'terminal-authority:view-attributes-accepted'
            )
          ))
          .slice(-20)
          .map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            message: frame.message,
          }));
        throw new Error(
          `MIG-BGSTAB-002 canary precondition rejected: ${JSON.stringify({
            decision,
            capabilityFrames,
            viewAttributeFrames,
          })}`,
        );
      }
      const transitionEpoch = decision?.transitionEpoch;
      const authorityEpoch = decision?.authorityEpoch;
      const streamEpoch = decision?.streamEpoch;
      const boundarySourceSeq = decision?.boundarySourceSeq;
      const responderLeaseId = decision?.responderLeaseId;
      writeFileSync(heldMarkerTriggerPath, 'release', 'utf8');
      let lastHoldInventory: Record<string, unknown> | null = null;
      try {
        await expect.poll(async () => {
          lastHoldInventory = await inspectServerAuthorityTestResources(page, first.sessionId);
          const authorityState = lastHoldInventory.authorityState as Record<string, unknown> | undefined;
          return Number(authorityState?.heldPostBoundaryCount ?? 0);
        }, {
          message: 'post-boundary PTY output must enter the authority hold before disable quorum',
          timeout: 5_000,
        }).toBeGreaterThan(0);
      } catch (error) {
        const diagnosticKinds = [
          'terminal_mounted',
          'terminal_disposed',
          'terminal_runtime_recreation_required',
          'terminal_runtime_recreation_recovery_installed',
          'terminal_runtime_recreation_recovery_install_failed',
          'terminal_responder_promotion_aborted',
          'terminal_responder_disable_rejected',
          'terminal_write_coordinator_recovery_requested',
          'terminal_checkpoint_invalid_frame_rejected',
          'terminal_checkpoint_server_rejected',
          'terminal_authority_handoff_frame_rejected',
          'terminal_authority_view_frame_unmatched',
          'screen_repair_reconnect_required',
          'session_attached',
          'session_detached',
        ];
        const [mainClientEvents, peerClientEvents] = await Promise.all([
          page.evaluate(({ sessionId, kinds }) => (
            window.__buildergateTerminalDebug?.getEvents(sessionId)
              .filter(event => kinds.includes(event.kind))
              .slice(-20)
              .map(event => ({ kind: event.kind, details: event.details })) ?? []
          ), { sessionId: first.sessionId, kinds: diagnosticKinds }),
          peer.evaluate(({ sessionId, kinds }) => (
            window.__buildergateTerminalDebug?.getEvents(sessionId)
              .filter(event => kinds.includes(event.kind))
              .slice(-20)
              .map(event => ({ kind: event.kind, details: event.details })) ?? []
          ), { sessionId: first.sessionId, kinds: diagnosticKinds }),
        ]);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; holdDiagnostics=${JSON.stringify({
            decision,
            inventory: lastHoldInventory,
            blockedDisableAcks: harness.blockedPageToServerFrames.filter(frame => (
              frame.message?.type === 'terminal-authority:responder-disabled'
              && frame.message.sessionId === first.sessionId
            )).map(frame => ({ generation: frame.generation, message: frame.message })),
            heldMarkerOutput: harness.frames.filter(frame => (
              frame.message?.sessionId === first.sessionId
              && JSON.stringify(frame.message).includes(heldMarker)
            )).slice(-10).map(frame => ({
              direction: frame.direction,
              generation: frame.generation,
              origin: frame.origin,
              message: frame.message,
            })),
            mainClientEvents,
            peerClientEvents,
          })}`,
        );
      }
      if (harness.routedFrameOverflowEvidence.droppedFrameCount > 0) {
        throw new Error(
          `MIG-BGSTAB-002 routed frame capture overflow: ${JSON.stringify(
            harness.routedFrameOverflowEvidence,
          )}`,
        );
      }
      const boundaries = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:responder-disable-boundary'
          && message.sessionId === first.sessionId
          && message.transitionEpoch === transitionEpoch
          && message.authorityEpoch === authorityEpoch
          && message.streamEpoch === streamEpoch
          && message.boundarySourceSeq === boundarySourceSeq
          && message.responderLeaseId === responderLeaseId,
      ).filter(frame => frame.origin === 'routed-server');
      const requiredViews = [...new Map(boundaries.map(frame => [
        `${frame.message?.connectionId}\u0000${frame.message?.viewGeneration}`,
        {
          ...first,
          generation: frame.generation,
          viewGeneration: Number(frame.message?.viewGeneration),
        },
      ])).values()];
      const acknowledgements = harness.matching(
        'page-to-server',
        message => message.type === 'terminal-authority:responder-disabled'
          && message.sessionId === first.sessionId
          && message.transitionEpoch === transitionEpoch
          && message.authorityEpoch === authorityEpoch
          && message.streamEpoch === streamEpoch
          && message.responderLeaseId === responderLeaseId
          && message.boundarySourceSeq === boundarySourceSeq,
      );
      const heldTailBeforeAllAck = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-checkpoint:output'
          && message.sessionId === first.sessionId
          && decodedTerminalOutput(message).includes(heldMarker),
      ).filter(frame => frame.origin === 'routed-server');
      const blockedSecondAck = harness.blockedPageToServerFrames.find(frame => (
        harness.ownerForGeneration(frame.generation) === peer
        && frame.message?.type === 'terminal-authority:responder-disabled'
        && frame.message.sessionId === first.sessionId
      )) ?? null;
      const checkpointFramesWhileSecondAckBlocked = harness.matching(
        'server-to-page',
        message => ['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
          .includes(message.type ?? '')
          && message.sessionId === first.sessionId
          && message.authorityMode === 'server'
          && message.transitionEpoch === transitionEpoch,
      ).filter(frame => frame.origin === 'routed-server');
      const serverResponderEnableWhileSecondAckBlocked = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:server-responder-enabled'
          && message.sessionId === first.sessionId
          && message.transitionEpoch === transitionEpoch,
      ).filter(frame => frame.origin === 'routed-server');
      unblockSecondAck();
      let blockedSecondAckReleaseIndex = -1;
      if (blockedSecondAck?.message) {
        blockedSecondAckReleaseIndex = harness.releaseBlockedFrame(blockedSecondAck);
      }
      const acceptedSecondAck = await waitForRoutedServerFrame(
        harness,
        message => message.type === 'terminal-authority:responder-disable-accepted'
          && message.sessionId === first.sessionId
          && message.connectionId === blockedSecondAck?.message?.connectionId
          && message.viewGeneration === blockedSecondAck?.message?.viewGeneration
          && message.transitionEpoch === transitionEpoch
          && message.authorityEpoch === authorityEpoch
          && message.streamEpoch === streamEpoch
          && message.boundarySourceSeq === boundarySourceSeq
          && message.responderLeaseId === responderLeaseId
          && message.accepted === true
          && message.completed === true
          && message.acknowledgedViewCount === requiredViews.length,
        3_000,
      );
      if (!acceptedSecondAck) {
        if (harness.routedFrameOverflowEvidence.droppedFrameCount > 0) {
          throw new Error(
            `MIG-BGSTAB-002 routed frame capture overflow before disable ACK settlement: ${JSON.stringify(
              harness.routedFrameOverflowEvidence,
            )}`,
          );
        }
        const disableDiagnostics = harness.frames.filter(frame => (
          frame.message?.sessionId === first.sessionId
          && [
            'terminal-authority:responder-disable-boundary',
            'terminal-authority:responder-disabled',
            'terminal-authority:responder-disable-accepted',
            'terminal-authority:canary-decision',
            'terminal-checkpoint:capability',
          ].includes(frame.message.type ?? '')
          && (
            frame.message.transitionEpoch === transitionEpoch
            || frame.message.type === 'terminal-authority:canary-decision'
            || frame.message.type === 'terminal-checkpoint:capability'
          )
        )).slice(-50).map(frame => ({
          direction: frame.direction,
          generation: frame.generation,
          origin: frame.origin,
          message: frame.message,
        }));
        throw new Error(
          `MIG-BGSTAB-002 second disable ACK never completed: ${JSON.stringify(disableDiagnostics)}`,
        );
      }
      await page.waitForTimeout(250);
      const firstViewTerminalFrames = harness.frames.filter(frame => (
        frame.generation === first.generation
        && frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
      ));
      const priorIndex = firstViewTerminalFrames.findIndex(frame => (
        frame.message?.type === 'output'
        && typeof frame.message.data === 'string'
        && frame.message.data.includes(priorMarker)
      ));
      const boundaryIndex = firstViewTerminalFrames.findIndex(frame => (
        frame.message?.type === 'terminal-authority:responder-disable-boundary'
        && frame.message.boundarySourceSeq === boundarySourceSeq
      ));
      const checkpointIndex = firstViewTerminalFrames.findIndex((frame, index) => (
        index > boundaryIndex
        &&
        frame.message?.type === 'terminal-checkpoint:start'
        && frame.message.authorityMode === 'server'
        && frame.message.transitionEpoch === transitionEpoch
      ));
      const checkpointChunkIndex = firstViewTerminalFrames.findIndex((frame, index) => (
        index > checkpointIndex
        &&
        frame.message?.type === 'terminal-checkpoint:chunk'
        && frame.message.authorityMode === 'server'
        && frame.message.transitionEpoch === transitionEpoch
      ));
      const checkpointCommitIndex = firstViewTerminalFrames.findIndex((frame, index) => (
        index > checkpointChunkIndex
        &&
        frame.message?.type === 'terminal-checkpoint:commit'
        && frame.message.authorityMode === 'server'
        && frame.message.transitionEpoch === transitionEpoch
      ));
      const heldTailIndex = firstViewTerminalFrames.findIndex((frame, index) => (
        index > checkpointCommitIndex
        && frame.message?.type === 'terminal-checkpoint:output'
        && frame.message.sessionId === first.sessionId
      ));
      const acceptedSecondAckIndex = acceptedSecondAck ? harness.frames.indexOf(acceptedSecondAck) : -1;
      const frozenViews = requiredViews;
      const frozenLaneCheckpoints = await Promise.all(frozenViews.map(view => (
        waitForAuthoritativeCheckpointSettlement(harness, view, 3_000)
      )));
      const heldMarkerInCheckpoint = frozenLaneCheckpoints.every(checkpoint => (
        decodedCheckpointAnsi(checkpoint)?.includes(heldMarker) === true
      ));
      const checkpointLaneTypes = new Set([
        'terminal-checkpoint:start',
        'terminal-checkpoint:chunk',
        'terminal-checkpoint:commit',
      ]);
      const frozenLaneTransactions = frozenViews.map((view, viewIndex) => {
        const checkpoint = frozenLaneCheckpoints[viewIndex]!;
        const startIndex = checkpoint.start ? harness.frames.indexOf(checkpoint.start) : -1;
        const commitIndex = checkpoint.commit ? harness.frames.indexOf(checkpoint.commit) : -1;
        const startBeforeAllAckCount = harness.frames.filter((frame, index) => (
          index <= acceptedSecondAckIndex
          && frame.generation === view.generation
          && frame.direction === 'server-to-page'
          && frame.origin === 'routed-server'
          && frame.message?.type === 'terminal-checkpoint:start'
          && frame.message.sessionId === first.sessionId
          && frame.message.transitionEpoch === transitionEpoch
        )).length;
        const filteredAllAckToCheckpointSequence = harness.frames.filter(frame => (
          frame === acceptedSecondAck
          || (
            frame.generation === view.generation
            && frame.direction === 'server-to-page'
            && frame.origin === 'routed-server'
            && frame.message?.sessionId === first.sessionId
            && frame.message.transitionEpoch === transitionEpoch
            && checkpointLaneTypes.has(frame.message.type ?? '')
          )
        ));
        const allAckSequenceIndex = acceptedSecondAck
          ? filteredAllAckToCheckpointSequence.indexOf(acceptedSecondAck)
          : -1;
        const checkpointStartSequenceIndex = filteredAllAckToCheckpointSequence.findIndex(frame => (
          frame.generation === view.generation
          && frame.message?.type === 'terminal-checkpoint:start'
        ));
        const startDigest = checkpoint.start?.message?.digest as Record<string, unknown> | undefined;
        const commitDigest = checkpoint.commit?.message?.digest as Record<string, unknown> | undefined;
        return {
          generation: view.generation,
          viewGeneration: view.viewGeneration,
          startIndex,
          commitIndex,
          startBeforeAllAckCount,
          allAckSequenceIndex,
          checkpointStartSequenceIndex,
          exactStartAfterAllAck: acceptedSecondAckIndex >= 0
            && startIndex > acceptedSecondAckIndex
            && allAckSequenceIndex >= 0
            && checkpointStartSequenceIndex === allAckSequenceIndex + 1,
          identity: checkpoint.identity,
          declaredChunkCount: checkpoint.start?.message?.chunkCount,
          encodedByteTotal: checkpoint.start?.message?.encodedByteTotal,
          digest: startDigest,
          commitDigest,
          lifecycleFrameCounts: checkpoint.lifecycleFrameCounts,
          validation: checkpoint.validation,
          valid: checkpoint.validation.settled
            && startBeforeAllAckCount === 0
            && acceptedSecondAckIndex >= 0
            && startIndex > acceptedSecondAckIndex
            && allAckSequenceIndex >= 0
            && checkpointStartSequenceIndex === allAckSequenceIndex + 1,
        };
      });
      const sharedCheckpointIdentity = (identity: CheckpointIdentity | null) => (
        identity
          ? Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'viewGeneration'))
          : null
      );
      const frozenLaneCrossEquivalence = {
        sharedIdentity: frozenLaneTransactions.length === 2
          && JSON.stringify(sharedCheckpointIdentity(frozenLaneTransactions[0]!.identity))
            === JSON.stringify(sharedCheckpointIdentity(frozenLaneTransactions[1]!.identity)),
        payloadDigest: frozenLaneTransactions.length === 2
          && JSON.stringify(frozenLaneTransactions[0]!.digest)
            === JSON.stringify(frozenLaneTransactions[1]!.digest),
        encodedByteTotal: frozenLaneTransactions.length === 2
          && frozenLaneTransactions[0]!.encodedByteTotal === frozenLaneTransactions[1]!.encodedByteTotal,
      };
      const allFrozenLaneTransactionsValid = frozenLaneTransactions.length === 2
        && frozenLaneTransactions.every(transaction => transaction.valid)
        && Object.values(frozenLaneCrossEquivalence).every(Boolean);
      const compositeViewIdentity = (frame: CapturedFrame): string => [
        String(frame.message?.connectionId ?? ''),
        String(frame.message?.viewGeneration ?? ''),
      ].join('\u0000');
      const byCompositeViewIdentity = (left: CapturedFrame, right: CapturedFrame): number => (
        compositeViewIdentity(left).localeCompare(compositeViewIdentity(right))
      );
      const sortedBoundaries = [...boundaries].sort(byCompositeViewIdentity);
      const sortedAcknowledgements = [...acknowledgements].sort(byCompositeViewIdentity);
      const boundaryCompositeIdentities = sortedBoundaries.map(compositeViewIdentity);
      const acknowledgementCompositeIdentities = sortedAcknowledgements.map(compositeViewIdentity);
      const sortedRequiredViewGenerations = requiredViews
        .map(view => view.viewGeneration)
        .sort((left, right) => left - right);
      const liveTransportCoverage = {
        connectionCount: requiredViews.length,
        unifiedSocketCount: requiredViews.filter(view => {
          const url = harness.urlForGeneration(view.generation);
          return url !== null
            && new URL(url).searchParams.get('mode') !== 'split'
            && new URL(url).searchParams.get('channel') === null;
        }).length,
        splitQualifiedSocketCount: requiredViews.filter(view => {
          const url = harness.urlForGeneration(view.generation);
          return url !== null && (
            new URL(url).searchParams.get('mode') === 'split'
            || new URL(url).searchParams.get('channel') !== null
          );
        }).length,
      };
      const actualOutputSocketOrder = {
        priorIndex,
        boundaryIndex,
        checkpointIndex,
        checkpointChunkIndex,
        checkpointCommitIndex,
        heldTailIndex,
      };
      const actualOutputSocketOrderValid = boundaryIndex >= 0
        && (priorIndex === -1 || priorIndex < boundaryIndex)
        && boundaryIndex < checkpointIndex
        && checkpointIndex < checkpointChunkIndex
        && checkpointChunkIndex < checkpointCommitIndex
        && (heldTailIndex === -1 || checkpointCommitIndex < heldTailIndex);
      expect({
        authorityIsolation: preparation,
        debugRouteGuards,
        liveTransportCoverage,
        trustedServerDecisionOrigin: decisionFrame?.origin ?? null,
        trustedServerDecision: decision,
        authorityEpochOpaqueNonEmpty: typeof authorityEpoch === 'string' && authorityEpoch.length > 0,
        canonicalOrdinals: {
          transitionEpoch: isCanonicalOrdinal(transitionEpoch),
          streamEpoch: isCanonicalOrdinal(streamEpoch),
          boundarySourceSeq: isCanonicalOrdinal(boundarySourceSeq),
        },
        positionalBoundaryGenerations: boundaries.map(frame => frame.generation).sort((left, right) => left - right),
        boundaryIdentities: sortedBoundaries.map(frame => frame.message),
        registeredViewGenerations: sortedRequiredViewGenerations,
        acknowledgementIdentities: sortedAcknowledgements.map(frame => frame.message),
        compositeIdentityEvidence: {
          boundaryUniqueCount: new Set(boundaryCompositeIdentities).size,
          acknowledgementUniqueCount: new Set(acknowledgementCompositeIdentities).size,
          exactBoundaryAckMatch: JSON.stringify(boundaryCompositeIdentities)
            === JSON.stringify(acknowledgementCompositeIdentities),
        },
        blockedSecondAck: blockedSecondAck?.message ?? null,
        ackBarrierEvidence: {
          checkpointFrameCountWhileBlocked: checkpointFramesWhileSecondAckBlocked.length,
          serverResponderEnableCountWhileBlocked: serverResponderEnableWhileSecondAckBlocked.length,
          blockedSecondAckReleaseIndex,
          acceptedSecondAckOrigin: acceptedSecondAck?.origin ?? null,
          acceptedSecondAckIndex,
          allAckCompletionReceipt: acceptedSecondAck?.message ?? null,
          acceptedAfterBlockedRelease: acceptedSecondAckIndex > blockedSecondAckReleaseIndex,
          frozenLaneTransactions,
          frozenLaneCrossEquivalence,
          allFrozenLaneTransactionsValid,
        },
        heldTailBeforeAllAckCount: heldTailBeforeAllAck.length,
        heldMarkerInCheckpoint,
        actualOutputSocketOrder,
        actualOutputSocketOrderValid,
      }, 'MIG-BGSTAB-002 AC-2 positional all-view disable ACK contract is absent').toMatchObject({
        authorityIsolation: {
          httpStatus: 200,
          mode: 'legacy',
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        },
        debugRouteGuards: {
          unauthenticated: { httpStatus: 401, errorCode: 'MISSING_TOKEN' },
          missingSession: { httpStatus: 404, errorCode: 'SESSION_NOT_FOUND' },
          serverExecutableRegistration: expectedTerminalAuthorityGuardEvidence(),
        },
        liveTransportCoverage: {
          connectionCount: requiredViews.length,
          unifiedSocketCount: requiredViews.length,
          splitQualifiedSocketCount: 0,
        },
        trustedServerDecisionOrigin: 'routed-server',
        trustedServerDecision: {
          requestId,
          decisionSource: 'server-policy',
          selectedSessionId: first.sessionId,
          decisions: [
            {
              sessionId: first.sessionId,
              authorityMode: 'server',
              accepted: true,
            },
            {
              sessionId: unselectedSessionId,
              authorityMode: 'legacy',
              accepted: false,
              failClosed: true,
              reason: 'limited-session-not-selected',
            },
          ],
        },
        authorityEpochOpaqueNonEmpty: true,
        canonicalOrdinals: {
          transitionEpoch: true,
          streamEpoch: true,
          boundarySourceSeq: true,
        },
        positionalBoundaryGenerations: requiredViews.map(view => view.generation).sort((left, right) => left - right),
        boundaryIdentities: sortedBoundaries.map(frame => ({
          lane: 'terminal-output',
          sessionId: first.sessionId,
          connectionId: frame.message?.connectionId,
          viewGeneration: frame.message?.viewGeneration,
          transitionEpoch,
          authorityEpoch,
          streamEpoch,
          boundarySourceSeq,
          responderLeaseId,
          requiredResponderViewCount: requiredViews.length,
        })),
        acknowledgementIdentities: sortedBoundaries.map(frame => ({
            sessionId: first.sessionId,
            connectionId: frame.message?.connectionId,
            viewGeneration: frame.message?.viewGeneration,
            transitionEpoch,
            authorityEpoch,
            streamEpoch,
            boundarySourceSeq,
            responderLeaseId,
        })),
        compositeIdentityEvidence: {
          boundaryUniqueCount: requiredViews.length,
          acknowledgementUniqueCount: requiredViews.length,
          exactBoundaryAckMatch: true,
        },
        blockedSecondAck: {
          type: 'terminal-authority:responder-disabled',
          sessionId: first.sessionId,
          viewGeneration: blockedSecondAck?.message?.viewGeneration,
          transitionEpoch,
          authorityEpoch,
          streamEpoch,
          boundarySourceSeq,
          responderLeaseId,
        },
        heldTailBeforeAllAckCount: 0,
        heldMarkerInCheckpoint: true,
        ackBarrierEvidence: {
          checkpointFrameCountWhileBlocked: 0,
          serverResponderEnableCountWhileBlocked: 0,
          blockedSecondAckReleaseIndex: expect.any(Number),
          acceptedSecondAckOrigin: 'routed-server',
          acceptedSecondAckIndex: expect.any(Number),
          allAckCompletionReceipt: expect.objectContaining({
            type: 'terminal-authority:responder-disable-accepted',
            sessionId: first.sessionId,
            accepted: true,
            completed: true,
            acknowledgedViewCount: frozenViews.length,
          }),
          acceptedAfterBlockedRelease: true,
          frozenLaneTransactions: frozenViews.map(view => ({
            generation: view.generation,
            viewGeneration: view.viewGeneration,
            startIndex: expect.any(Number),
            commitIndex: expect.any(Number),
            startBeforeAllAckCount: 0,
            allAckSequenceIndex: expect.any(Number),
            checkpointStartSequenceIndex: expect.any(Number),
            exactStartAfterAllAck: true,
            identity: expect.objectContaining({
              protocolVersion: 1,
              sessionId: first.sessionId,
              viewGeneration: view.viewGeneration,
              streamEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              checkpointEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              sourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              snapshotSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              oldestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              retentionPolicyId: expect.stringMatching(/^.+$/u),
            }),
            declaredChunkCount: expect.any(Number),
            encodedByteTotal: expect.any(Number),
            digest: { algorithm: 'sha256', hex: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            commitDigest: { algorithm: 'sha256', hex: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            lifecycleFrameCounts: {
              start: 1,
              commit: 1,
              applyAck: 1,
              drainAck: 1,
            },
            validation: {
              identityCanonical: true,
              exactLifecycleFrameCounts: true,
              exactChunkCountAndIndices: true,
              encodedByteTotalValid: true,
              digestValid: true,
              parserTailEnvelopeValid: true,
              retainedStateDigestValid: true,
              exactFrameOrder: true,
              sameTerminalLane: true,
              terminalLaneTypeWhitelist: true,
              preCommitInterleavingCount: 0,
              applyAckValid: true,
              drainAckValid: true,
              failureAckCount: 0,
              settled: true,
            },
            valid: true,
          })),
          frozenLaneCrossEquivalence: {
            sharedIdentity: true,
            payloadDigest: true,
            encodedByteTotal: true,
          },
          allFrozenLaneTransactionsValid: true,
        },
        actualOutputSocketOrder: {
          priorIndex: expect.any(Number),
          boundaryIndex: expect.any(Number),
          checkpointIndex: expect.any(Number),
          checkpointChunkIndex: expect.any(Number),
          checkpointCommitIndex: expect.any(Number),
          heldTailIndex: expect.any(Number),
        },
        actualOutputSocketOrderValid: true,
      });
    } catch (error) {
      bodyFailure = error;
    } finally {
      try {
        await runCleanupTasks('positional all-view handoff', [
          {
            name: 'attach-positional-retry-evidence',
            run: () => testInfo.attach('ph005-positional-retry-evidence', {
              body: Buffer.from(JSON.stringify(positionalRetryEvidence), 'utf8'),
              contentType: 'application/json',
            }),
          },
          {
            name: 'release-second-ack-blocker',
            run: () => {
              unblockSecondAck();
              for (const frame of [...harness.blockedPageToServerFrames]) {
                if (frame.message?.type === 'terminal-authority:responder-disabled'
                  && frame.message.sessionId === first.sessionId) {
                  harness.releaseBlockedFrame(frame);
                }
              }
            },
          },
          {
            name: 'restore-authority-isolation',
            run: () => cleanupServerAuthorityTestState(page, first.sessionId, preparation, harness),
          },
          {
            name: 'delete-held-marker-trigger',
            run: () => {
              if (existsSync(heldMarkerTriggerPath)) unlinkSync(heldMarkerTriggerPath);
            },
          },
          { name: 'close-peer-page', run: () => peer.close() },
          ...(unselectedSessionId
            ? [{
                name: 'delete-unselected-session',
                run: () => deleteOwnedSession(page, unselectedSessionId!),
              }]
            : []),
        ]);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (bodyFailure && cleanupFailure) {
      throw new Error(
        `positional body failed: ${bodyFailure instanceof Error ? bodyFailure.message : String(bodyFailure)}; `
        + `cleanup also failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
        { cause: cleanupFailure },
      );
    }
    if (bodyFailure) throw bodyFailure;
    if (cleanupFailure) throw cleanupFailure;
  });

  test('query byte parity and seed silence', async ({ page }, testInfo) => {
    const harness = new RoutedWebSocketHarness();
    let live = await bootLiveTerminal(page, harness);
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    const parityEvidence: Record<string, unknown> = {};
    try {
      const legacyBrowserReplies: string[] = [];
      for (const parityCase of BROWSER_NATIVE_QUERY_PARITY_CASES) {
        const queryBoundary = harness.frames.length - 1;
        injectOutput(harness, live, parityCase.query, {
          source: `ph005-legacy-${parityCase.label}`,
        });
        const reply = await waitForInputFrame(harness, live.sessionId, parityCase.reply, {
          generation: live.generation,
          afterIndex: queryBoundary,
        });
        expect(reply.origin).toBe('routed-page');
        legacyBrowserReplies.push(String(reply.message?.data ?? ''));
      }
      const dsrExtension = SERVER_QUERY_EXTENSION_CASES[0];
      const legacyDsrBoundary = harness.frames.length - 1;
      injectOutput(harness, live, dsrExtension.query, { source: 'ph005-legacy-dsr996-silence' });
      const fifoBarrier = BROWSER_NATIVE_QUERY_PARITY_CASES.at(-1)!;
      injectOutput(harness, live, fifoBarrier.query, { source: 'ph005-legacy-dsr996-fifo-barrier' });
      await waitForInputFrame(harness, live.sessionId, fifoBarrier.reply, {
        generation: live.generation,
        afterIndex: legacyDsrBoundary,
      });
      const legacyDsr996ReplyCount = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === live.sessionId
          && typeof message.data === 'string'
          && /\u001b\[\?997(?:;[0-9]+)*n/u.test(message.data),
        { generation: live.generation, afterIndex: legacyDsrBoundary },
      ).filter(frame => frame.origin === 'routed-page').length;
      expect(legacyDsr996ReplyCount).toBe(0);
      preparation = await prepareServerAuthorityTestState(page, live.sessionId, 'server');
      const framesBeforeSeed = harness.frames.length - 1;
      const cacheInventory = terminalCacheProductionInventory();
      await page.evaluate(({ sessionId, cols, rows, query, cacheTarget }) => {
        const storageByName: Record<string, Storage> = { localStorage, sessionStorage };
        const storage = storageByName[cacheTarget.storageName];
        if (!storage) throw new Error('production terminal cache storage is not browser-addressable');
        storage.setItem(`${cacheTarget.snapshotKeyPrefix}${sessionId}`, JSON.stringify({
          schemaVersion: 2,
          payloadKind: 'viewport-only',
          sessionId,
          content: query,
          cols,
          rows,
          bufferType: 'normal',
          savedAt: new Date().toISOString(),
        }));
      }, {
        sessionId: live.sessionId,
        cols: Number(live.snapshot.cols ?? 80),
        rows: Number(live.snapshot.rows ?? 24),
        query: VIEW_QUERY_CASES.map(parityCase => parityCase.query).join(''),
        cacheTarget: {
          storageName: cacheInventory.primaryProductionStorage,
          snapshotKeyPrefix: cacheInventory.snapshotKeyPrefix,
        },
      });
      live = await waitForServerAuthorityReplacementLiveTerminal(page, harness, live);
      const checkpoint = await waitForAuthoritativeCheckpointSettlement(harness, live);
      const expectedViewReplies = new Set(VIEW_QUERY_CASES.map(parityCase => parityCase.reply));
      const containsExpectedViewReply = (data: unknown): boolean => (
        typeof data === 'string'
        && [...expectedViewReplies].some(expectedReply => data.includes(expectedReply))
      );
      const seedReplies = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === live.sessionId
          && containsExpectedViewReply(message.data),
        { generation: live.generation, afterIndex: framesBeforeSeed },
      );

      const liveBoundary = harness.frames.length - 1;
      const serverProbes: Array<Record<string, unknown>> = [];
      for (const parityCase of VIEW_QUERY_CASES) {
        const serverProbe = await triggerServerHeadlessQueryProbe(
          page,
          live.sessionId,
          preparation,
          checkpoint,
          parityCase.query,
          parityCase.reply,
        );
        if (serverProbe.httpStatus !== 202) {
          const inventory = await inspectServerAuthorityTestResources(page, live.sessionId);
          throw new Error(`query responder probe rejected: ${JSON.stringify({
            parityCase: parityCase.label,
            serverProbe,
            inventory,
          })}`);
        }
        serverProbes.push(serverProbe);
      }
      await page.waitForTimeout(250);
      const browserLiveReplies = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === live.sessionId
          && containsExpectedViewReply(message.data),
        { generation: live.generation, afterIndex: liveBoundary },
      ).filter(frame => frame.origin === 'routed-page');
      const queryProbes = serverProbes.map(serverProbe => (
        serverProbe.queryResponderProbe as Record<string, unknown> | undefined
      ));
      const serverAuthorityReplies = queryProbes.map(queryProbe => (
        Buffer.from(String(queryProbe?.replyData ?? ''), 'base64').toString('utf8')
      ));
      const serverNativeReplies = serverAuthorityReplies.slice(
        0,
        BROWSER_NATIVE_QUERY_PARITY_CASES.length,
      );
      const serverExtensionReplies = serverAuthorityReplies.slice(
        BROWSER_NATIVE_QUERY_PARITY_CASES.length,
      );
      const checkpointModelInstanceId = checkpoint.start?.message?.authoritativeModelInstanceId ?? null;
      const browserOrderedBytes = Buffer.from(legacyBrowserReplies.join(''), 'utf8');
      const serverOrderedBytes = Buffer.from(serverNativeReplies.join(''), 'utf8');
      const orderedBytesEqual = browserOrderedBytes.equals(serverOrderedBytes);
      Object.assign(parityEvidence, {
        nativeParityLabels: BROWSER_NATIVE_QUERY_PARITY_CASES.map(parityCase => parityCase.label),
        serverExtensionLabels: SERVER_QUERY_EXTENSION_CASES.map(parityCase => parityCase.label),
        nativeParityCaseCount: BROWSER_NATIVE_QUERY_PARITY_CASES.length,
        serverExtensionCaseCount: SERVER_QUERY_EXTENSION_CASES.length,
        legacyDsr996ReplyCount,
        legacyBrowserReplies,
        serverAuthorityReplies,
        serverNativeReplies,
        serverExtensionReplies,
        browserOrderedByteLength: browserOrderedBytes.byteLength,
        serverOrderedByteLength: serverOrderedBytes.byteLength,
        browserOrderedSha256: createHash('sha256').update(browserOrderedBytes).digest('hex'),
        serverOrderedSha256: createHash('sha256').update(serverOrderedBytes).digest('hex'),
        orderedBytesEqual,
        seedReplyCount: seedReplies.length,
        serverModeBrowserReplyCount: browserLiveReplies.length,
      });
      expect({
        authorityIsolation: preparation,
        seededParserReplies: seedReplies.length,
        checkpointSettled: checkpoint.validation.settled,
        checkpointModelInstanceId,
        browserLiveReplyCount: browserLiveReplies.length,
        parityEvidence,
        serverProbes,
        sameAuthoritativeModel: typeof checkpointModelInstanceId === 'string'
          && checkpointModelInstanceId.length > 0
          && queryProbes.every(queryProbe => (
            queryProbe?.authoritativeModelInstanceId === checkpointModelInstanceId
          )),
      }, 'MIG-BGSTAB-002 AC-3 query reply identity contract is absent').toMatchObject({
        authorityIsolation: {
          httpStatus: 200,
          mode: 'server',
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        },
        seededParserReplies: 0,
        checkpointSettled: true,
        checkpointModelInstanceId: expect.any(String),
        browserLiveReplyCount: 0,
        sameAuthoritativeModel: true,
        parityEvidence: {
          nativeParityCaseCount: BROWSER_NATIVE_QUERY_PARITY_CASES.length,
          serverExtensionCaseCount: SERVER_QUERY_EXTENSION_CASES.length,
          legacyDsr996ReplyCount: 0,
          legacyBrowserReplies: BROWSER_NATIVE_QUERY_PARITY_CASES.map(parityCase => parityCase.reply),
          serverAuthorityReplies: VIEW_QUERY_CASES.map(parityCase => parityCase.reply),
          serverNativeReplies: BROWSER_NATIVE_QUERY_PARITY_CASES.map(parityCase => parityCase.reply),
          serverExtensionReplies: SERVER_QUERY_EXTENSION_CASES.map(parityCase => parityCase.reply),
          browserOrderedByteLength: expect.any(Number),
          serverOrderedByteLength: expect.any(Number),
          browserOrderedSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          serverOrderedSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          orderedBytesEqual: true,
          seedReplyCount: 0,
          serverModeBrowserReplyCount: 0,
        },
        serverProbes: VIEW_QUERY_CASES.map((parityCase, index) => ({
          httpStatus: 202,
          accepted: true,
          source: 'server-headless-responder-test-isolation',
          queryResponderProbe: {
            action: 'inject-live-pty-output-into-authoritative-headless-model',
            authoritativeModelInstanceId: checkpointModelInstanceId,
            inputCopies: 3,
            browserReplyCount: 0,
            seedBrowserReplyCount: 0,
            seedPtyReplyCount: 0,
            replayBrowserReplyCount: 0,
            replayPtyReplyCount: 0,
            liveBrowserReplyCount: 0,
            livePtyReplyCount: 1,
            serverPtyReplyCount: 1,
            duplicatePtyReplyCount: 0,
            replyOrdinal: 0,
            replyEncoding: 'base64',
            replyData: Buffer.from(VIEW_QUERY_CASES[index]?.reply ?? '', 'utf8').toString('base64'),
            effectDisposition: 'committed-once',
          },
        })),
      });
    } finally {
      await runCleanupTasks('query byte parity and seed silence', [
        {
          name: 'attach-query-parity-evidence',
          run: () => testInfo.attach('ph005-query-palette-byte-parity', {
            body: Buffer.from(JSON.stringify(parityEvidence), 'utf8'),
            contentType: 'application/json',
          }),
        },
        {
          name: 'restore-authority-isolation',
          run: () => cleanupServerAuthorityTestState(page, live.sessionId, preparation),
        },
      ]);
    }
  });

  test('connection replacement retargets output policy without recreating xterm', async ({ page }) => {
    const harness = new RoutedWebSocketHarness();
    let live = await bootLiveTerminal(page, harness);
    const sessionId = live.sessionId;
    await expect(visibleSessionRuntime(page, sessionId).locator('.xterm')).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.evaluate((requestedSessionId) => {
      window.__buildergateTerminalDebug?.clear(requestedSessionId);
      window.__buildergateTerminalDebug?.enable(requestedSessionId);
    }, sessionId);
    const beforeXterm = await visibleSessionRuntime(page, sessionId).locator('.xterm').elementHandle();
    expect(beforeXterm, 'the committed xterm runtime must exist before connection replacement').not.toBeNull();
    const oldControlGeneration = resolveControlGeneration(harness, live.generation);
    const oldConnectionId = harness.latest(
      'server-to-page',
      message => message.type === 'connected' && message.channel === 'control',
      oldControlGeneration,
    )?.message?.connectionId;
    expect(typeof oldConnectionId).toBe('string');

    const replacementFrameStart = harness.frames.length - 1;
    await harness.closeGeneration(oldControlGeneration);
    live = await settleLiveTerminal(harness, page, sessionId, true, replacementFrameStart);
    const newControlGeneration = resolveControlGeneration(harness, live.generation);
    const newConnectionId = harness.latest(
      'server-to-page',
      message => message.type === 'connected' && message.channel === 'control',
      newControlGeneration,
    )?.message?.connectionId;
    expect(newControlGeneration).toBeGreaterThan(oldControlGeneration);
    expect(newConnectionId).not.toBe(oldConnectionId);

    const afterXterm = await visibleSessionRuntime(page, sessionId).locator('.xterm').elementHandle();
    expect(afterXterm, 'the committed xterm runtime must survive connection replacement').not.toBeNull();
    const sameXtermNode = await beforeXterm!.evaluate(
      (before, after) => before === after,
      afterXterm!,
    );
    expect(sameXtermNode, 'connection retargeting must preserve the existing xterm DOM identity').toBe(true);
    const lifecycleKinds = await page.evaluate((requestedSessionId) => (
      window.__buildergateTerminalDebug?.getEvents(requestedSessionId)
        .filter(event => event.kind === 'terminal_mounted' || event.kind === 'terminal_disposed')
        .map(event => event.kind) ?? []
    ), sessionId);
    expect(lifecycleKinds).toEqual([]);
  });

  test('poisoned no-cache reload', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const harness = new RoutedWebSocketHarness();
    let live = await bootLiveTerminal(page, harness);
    const sessionId = live.sessionId;
    await expect(visibleSessionRuntime(page, sessionId).locator('.xterm')).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.evaluate((requestedSessionId) => {
      window.__buildergateTerminalDebug?.clear(requestedSessionId);
      window.__buildergateTerminalDebug?.enable(requestedSessionId);
    }, sessionId);
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    let freshBaselineSessionId: string | null = null;
    let bodyFailure: unknown = null;
    let cleanupFailure: unknown = null;
    const zeroAttachedTriggerPath = join(
      tmpdir(),
      `buildergate-ph005-zero-attached-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.trigger`,
    );
    const zeroAttachedMarker = `PH005-ZERO-ATTACHED-${Date.now()}`;
    const zeroAttachedReadyMarker = `PH005-ZERO-READY-${Date.now()}`;
    const preparationOperationLedger: {
      schemaVersion: 'ph005-preparation-operation-ledger/v1';
      operations: Array<{
        name: string;
        attempt: 1;
        outcome: 'success' | 'failure';
        httpStatus: number;
      }>;
    } = {
      schemaVersion: 'ph005-preparation-operation-ledger/v1',
      operations: [],
    };
    const recordPreparationOperation = (
      name: string,
      result: Record<string, unknown>,
    ): Record<string, unknown> => {
      preparationOperationLedger.operations.push({
        name,
        attempt: 1,
        outcome: result.httpStatus === 200 ? 'success' : 'failure',
        httpStatus: Number(result.httpStatus),
      });
      return result;
    };
    try {
      const initialState = await captureStableRetainedState(page, live.sessionId);
      const corpus = buildRawRetainedCorpusContract(initialState.geometry.rows);
      const preparationFrameStart = harness.frames.length - 1;
      preparation = recordPreparationOperation(
        'cache-valid-stale',
        await prepareServerAuthorityTestState(
          page,
          sessionId,
          'server',
          corpus.request,
          { retryTransient: false },
        ),
      );
      if (preparation.httpStatus !== 200) {
        const preparationFrames = harness.frames.slice(preparationFrameStart + 1)
          .filter(frame => frame.message?.sessionId === sessionId)
          .filter(frame => [
            'screen-snapshot',
            'screen-snapshot:ready',
            'session:ready',
            'terminal-checkpoint:negotiate',
            'terminal-checkpoint:capability',
          ].includes(frame.message?.type ?? ''));
        throw new Error(
          `MIG-BGSTAB-002 retained corpus preparation failed: ${JSON.stringify(preparation)}; `
          + `frames=${JSON.stringify(preparationFrames)}`,
        );
      }
      const retentionPolicy = retainedPolicyEvidence(preparation);
      const productionConfiguredPolicy = productionConfiguredPolicyEvidence(preparation);
      const productionCorpus = buildProductionConfiguredCorpusContract(
        productionConfiguredPolicy,
        initialState.geometry,
      );
      const productionRangeTimeout = configuredRangeTimeoutMs(
        productionConfiguredPolicy.productionConfiguredRetainedScrollbackLines,
      );
      testInfo.setTimeout(Math.max(testInfo.timeout, productionRangeTimeout + 360_000));
      const poison = `PH005-POISON-${Date.now()}`;
      const canaryRequestId = requestServerAuthorityCanary(harness, live);
      const canaryDecision = await waitForRoutedServerFrame(
        harness,
        message => message.type === 'terminal-authority:canary-decision'
          && message.requestId === canaryRequestId,
        3_000,
      );
      const preparationContract = preparation.testContract as Record<string, unknown> | undefined;
      const preparedCorpus = preparationContract?.retainedCorpusInjection as Record<string, unknown> | undefined;
      const fixtureAccepted = preparation.httpStatus === 200
        && preparedCorpus?.accepted === true
        && preparedCorpus.sha256 === corpus.payloadSha256;
      const fixtureMarkerRendered = fixtureAccepted
        ? await observeRenderedMarker(page, corpus.newestLabel)
        : false;
      const beforeStage = await captureStableRetainedState(page, live.sessionId);
      const evictedPrefixHashes = Array.from(
        { length: PH005_RETAINED_OVERFLOW_LINES },
        (_, index) => retainedLogicalLineHash(retainedCorpusLabel(index)),
      );
      const retainedHashes = new Set(beforeStage.lineFingerprints.map(line => line.logicalLineHash));
      const independentBoundaryOracle = {
        geometryWideEnough: initialState.geometry.cols >= corpus.newestLabel.length,
        oldest: beforeStage.lineFingerprints[0] ?? null,
        newest: beforeStage.lineFingerprints.at(-1) ?? null,
        expectedOldestLogicalLineHash: corpus.oldestLogicalLineHash,
        expectedNewestLogicalLineHash: corpus.newestLogicalLineHash,
        evictedPrefixAbsent: evictedPrefixHashes.every(hash => !retainedHashes.has(hash)),
      };

      const comparable = (value: TerminalRetainedStateEvidence) => ({
        logicalLinesHash: value.logicalLinesHash,
        cellContentAttributeHash: value.cellContentAttributeHash,
        digest: value.digest,
        cursor: value.cursor,
        modes: value.modes,
        activeBuffer: value.activeBuffer,
        geometry: value.geometry,
        retainedRange: retainedRangeEvidence(value),
      });

      const normalStages: Array<{
        scenario: TerminalCacheScenario;
        preparation: Record<string, unknown>;
        cleanup: Record<string, unknown>;
        postCleanupInventory: Record<string, unknown>;
        inventory: TerminalCacheInventory;
        before: TerminalRetainedStateEvidence;
        after: TerminalRetainedStateEvidence;
        checkpoint: CheckpointTransactionEvidence;
        tail: PostSnapshotTailEvidence;
        independentBufferOracle: ReturnType<typeof independentCheckpointBufferOracle>;
      }> = [];
      for (const [scenarioIndex, scenario] of (
        ['valid-stale', 'malformed', 'tombstone', 'absent'] as const
      ).entries()) {
        let scenarioPreparation = preparation;
        if (scenarioIndex > 0) {
          live = await stabilizeLiveTerminalRegistration(harness, page, live);
          scenarioPreparation = recordPreparationOperation(
            `cache-${scenario}`,
            await prepareServerAuthorityTestState(
              page,
              sessionId,
              'server',
              corpus.request,
              { retryTransient: false },
            ),
          );
        }
        preparation = scenarioPreparation;
        if (scenarioPreparation.httpStatus !== 200) {
          const diagnosticRequestId = requestServerAuthorityCanary(harness, live);
          const diagnosticDecision = await waitForRoutedServerFrame(
            harness,
            message => message.type === 'terminal-authority:canary-decision'
              && message.requestId === diagnosticRequestId,
            3_000,
          );
          const responderEvents = await page.evaluate((requestedSessionId) => (
            window.__buildergateTerminalDebug?.getEvents(requestedSessionId).filter(event => (
              event.kind.includes('responder') || event.kind.includes('authority')
            )).slice(-30) ?? []
          ), sessionId);
          const compactIdentityMessage = (
            message: (typeof harness.frames)[number]['message'],
          ) => message
            ? {
                type: message.type,
                sessionId: message.sessionId,
                viewGeneration: message.viewGeneration,
                driverLeaseGeneration: message.driverLeaseGeneration,
                viewAttributesGeneration: message.viewAttributesGeneration,
                accepted: message.accepted,
                reason: message.reason,
                source: message.source,
                registeredViews: message.registeredViews,
                mutationLeases: message.mutationLeases,
              }
            : null;
          const identityFrames = harness.frames.filter(frame => (
            frame.message?.sessionId === sessionId
            && (
              frame.message.type === 'terminal-authority:view-attributes'
              || frame.message.type === 'terminal-authority:view-attributes-accepted'
              || frame.message.type === 'terminal-authority:legacy-responder-enabled'
              || frame.message.type === 'terminal-checkpoint:capability'
            )
          )).slice(-30).map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            message: compactIdentityMessage(frame.message),
          }));
          const capabilityFrames = harness.frames.filter(frame => (
            (frame.message?.type === 'terminal-authority:legacy-responder-enabled'
              && frame.message.sessionId === sessionId)
            || (frame.message?.type === 'terminal-checkpoint:capability'
              && Array.isArray(frame.message.registeredViews)
              && frame.message.registeredViews.some(view => (
                view !== null
                && typeof view === 'object'
                && (view as Record<string, unknown>).sessionId === sessionId
              )))
          )).slice(-12).map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            message: compactIdentityMessage(frame.message),
          }));
          const replayFrames = harness.frames.filter(frame => (
            frame.message?.sessionId === sessionId
            && (
              frame.message.type === 'screen-snapshot'
              || frame.message.type === 'screen-snapshot:ready'
              || frame.message.type === 'session:ready'
              || frame.message.type === 'repair-replay'
              || frame.message.type === 'screen-repair:restore-needed'
              || frame.message.type === 'screen-repair:reconnect-required'
            )
          )).slice(-30).map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            origin: frame.origin,
            message: frame.message ? {
              type: frame.message.type,
              sessionId: frame.message.sessionId,
              replayToken: frame.message.replayToken,
              supersedesReplayToken: frame.message.supersedesReplayToken,
              repairToken: frame.message.repairToken,
              snapshotSeq: frame.message.snapshotSeq,
              seq: frame.message.seq,
              reason: frame.message.reason,
              outcome: frame.message.outcome,
            } : null,
          }));
          const clientRecoveryEvents = await page.evaluate((requestedSessionId) => (
            window.__buildergateTerminalDebug?.getEvents(requestedSessionId).filter(event => (
              event.kind.includes('screen_snapshot')
              || event.kind.includes('snapshot_replacement')
              || event.kind.includes('visible_output')
              || event.kind.includes('ime_')
              || event.kind.includes('websocket')
              || event.kind.includes('terminal_authority')
            )).slice(-80) ?? []
          ), sessionId);
          throw new Error(
            `MIG-BGSTAB-002 ${scenario} preparation failed: ${JSON.stringify(scenarioPreparation)}; `
            + `previousStage=${JSON.stringify(normalStages.length > 0 ? {
              scenario: normalStages.at(-1)?.scenario,
              cleanup: normalStages.at(-1)?.cleanup,
              postCleanupInventory: normalStages.at(-1)?.postCleanupInventory,
            } : null)}; `
            + `responderEvents=${JSON.stringify(responderEvents)}; `
            + `diagnosticDecision=${JSON.stringify(diagnosticDecision?.message ?? null)}; `
            + `identityFrames=${JSON.stringify(identityFrames)}; `
            + `capabilityFrames=${JSON.stringify(capabilityFrames)}; `
            + `replayFrames=${JSON.stringify(replayFrames)}; `
            + `clientRecoveryEvents=${JSON.stringify(clientRecoveryEvents)}`,
          );
        }
        const before = scenarioIndex === 0
          ? beforeStage
          : await captureStableRetainedState(page, sessionId);
        const inventory = scenario === 'absent'
          ? await removeAllTerminalCaches(page, sessionId)
          : await setAndInventoryTerminalCacheScenario(
              page,
              sessionId,
              scenario,
              `${poison}-${scenario}`,
              before.geometry,
            );
        const previousLive = live;
        live = await waitForServerAuthorityReplacementLiveTerminal(page, harness, previousLive);
        const checkpoint = await waitForAuthoritativeCheckpointSettlement(harness, live);
        const after = await captureStableRetainedState(page, sessionId);
        const tailContract = buildDeterministicTailContract(
          `PH005-${scenario.toUpperCase()}-POST-TAIL-${Date.now()}`,
        );
        const tail = await sendPostSnapshotTailAndWait(
          page,
          harness,
          live,
          checkpoint,
          tailContract.data,
          {
            dispatch: () => triggerConfiguredPostSnapshotTail(
              page,
              sessionId,
              scenarioPreparation,
              checkpoint,
              tailContract,
            ),
          },
        );
        const independentBufferOracle = independentCheckpointBufferOracle(checkpoint, {
          activeBuffer: 'normal',
          normalMarker: corpus.newestLabel,
          alternateMarker: corpus.inactiveAlternateMarker,
          savedCursorRequired: false,
        });
        live = await stabilizeLiveTerminalRegistration(harness, page, live);
        const cleanup = await cleanupServerAuthorityTestState(
          page,
          sessionId,
          scenarioPreparation,
          harness,
        );
        const postCleanupInventory = await inspectServerAuthorityTestResources(page, sessionId);
        preparation = { httpStatus: 0 };
        live = await stabilizeLiveTerminalRegistration(harness, page, live);
        normalStages.push({
          scenario,
          preparation: scenarioPreparation,
          cleanup,
          postCleanupInventory,
          inventory,
          before,
          after,
          checkpoint,
          tail,
          independentBufferOracle,
        });
      }

      // The configured contract recreates the authoritative headless runtime.
      // Keep the same browser view attached and wait for its automatic fresh
      // capability/attributes exchange after the model instance changes.
      // Reloading during this preparation would mutate the responder topology
      // and invalidate the transaction;
      // the poisoned/no-cache hard reload remains the recovery action below.
      await page.evaluate((requestedSessionId) => {
        window.__buildergateTerminalDebug?.enable(requestedSessionId);
      }, sessionId);
      await page.evaluate((requestedSessionId) => {
        window.__buildergateTerminalDebug?.clear(requestedSessionId);
      }, sessionId);
      await enableServerDebugCapture(page, sessionId);
      const configuredFrameStart = harness.frames.length - 1;
      const configuredRuntimeBefore = await inspectServerAuthorityTestResources(page, sessionId);
      const configuredModelInstanceBefore = configuredRuntimeBefore.authoritativeModelInstanceId;
      if (typeof configuredModelInstanceBefore !== 'string') {
        throw new Error(
          `MIG-BGSTAB-002 configured retained-range runtime identity unavailable: `
          + JSON.stringify(configuredRuntimeBefore),
        );
      }
      const configuredPreparation = recordPreparationOperation(
        'configured-range',
        await prepareServerAuthorityTestState(
          page,
          sessionId,
          'server',
          productionCorpus.request,
          { retryTransient: false },
        ),
      );
      preparation = configuredPreparation;
      const configuredAttributesAccepted = () => {
        for (let requestIndex = configuredFrameStart + 1; requestIndex < harness.frames.length; requestIndex += 1) {
          const requestFrame = harness.frames[requestIndex];
          if (requestFrame.direction !== 'page-to-server'
            || requestFrame.origin !== 'routed-page'
            || requestFrame.message?.type !== 'terminal-authority:view-attributes'
            || requestFrame.message.sessionId !== sessionId
            || !Number.isSafeInteger(requestFrame.message.viewGeneration)) {
            continue;
          }
          const accepted = harness.frames.slice(requestIndex + 1).some(frame => (
            frame.direction === 'server-to-page'
            && frame.origin === 'routed-server'
            && frame.generation === requestFrame.generation
            && frame.message?.type === 'terminal-authority:view-attributes-accepted'
            && frame.message.sessionId === sessionId
            && frame.message.viewGeneration === requestFrame.message?.viewGeneration
            && frame.message.accepted === true
          ));
          if (accepted) return true;
        }
        return false;
      };
      if (configuredPreparation.httpStatus !== 200) {
        let configuredFailureInventory: Record<string, unknown>;
        try {
          configuredFailureInventory = await inspectServerAuthorityTestResources(page, sessionId);
        } catch (error) {
          configuredFailureInventory = {
            diagnosticReadError: error instanceof Error
              ? error.message.slice(0, 160)
              : String(error).slice(0, 160),
          };
        }
        const configuredClientEvents = await page.evaluate((requestedSessionId) => (
          window.__buildergateTerminalDebug?.getEvents(requestedSessionId) ?? []
        ), sessionId);
        throw new Error(
          'MIG-BGSTAB-002 configured retained-range preparation failed'
          + `; configuredAuthorityDiagnostics=${formatConfiguredAuthorityFailureDiagnostic({
            sessionId,
            preparation: configuredPreparation,
            frames: harness.frames.slice(configuredFrameStart + 1),
            clientEvents: configuredClientEvents,
            inventory: configuredFailureInventory,
          })}`,
        );
      }
      const configuredModelInstanceAfter = configuredPreparation.authoritativeModelInstanceId;
      if (typeof configuredModelInstanceAfter !== 'string'
        || configuredModelInstanceAfter === configuredModelInstanceBefore) {
        throw new Error(
          `MIG-BGSTAB-002 configured retained-range runtime was not recreated: `
          + JSON.stringify({ configuredRuntimeBefore, configuredPreparation }),
        );
      }
      await expect.poll(configuredAttributesAccepted, {
        message: 'configured retained-range browser attributes were not accepted by the recreated responder',
        timeout: 5_000,
      }).toBe(true);
      const configuredLifecycleEvents = await page.evaluate((requestedSessionId) => (
        window.__buildergateTerminalDebug?.getEvents(requestedSessionId)
          .filter(event => event.kind === 'terminal_mounted' || event.kind === 'terminal_disposed')
          .map(event => event.kind)
          ?? []
      ), sessionId);
      expect(
        configuredLifecycleEvents,
        'committed connection retargeting must not recreate the existing xterm runtime',
      ).toEqual([]);
      const configuredProductionPolicy = productionConfiguredPolicyEvidence(configuredPreparation);
      const configuredResponseContract = configuredPreparation.testContract as Record<string, unknown> | undefined;
      const configuredProbe = configuredResponseContract?.productionConfiguredRangeProbe as
        Record<string, unknown> | undefined;
      const configuredRangeFixtureAccepted = configuredPreparation.httpStatus === 200
        && configuredProbe?.accepted === true
        && configuredProbe.configuredScrollbackLines === productionCorpus.configuredScrollbackLines
        && configuredProbe.physicalLineCount === productionCorpus.outputLineCount;
      const configuredGeneratorBounded = Number.isSafeInteger(configuredProbe?.peakMaterializedPhysicalLines)
        && Number.isSafeInteger(configuredProbe?.generatorWindowPhysicalLines)
        && Number(configuredProbe?.peakMaterializedPhysicalLines)
          <= Number(configuredProbe?.generatorWindowPhysicalLines)
        && configuredProbe?.fullCellMaterializationCount === 0;
      const configuredFullE2eRequired = productionCorpus.configuredScrollbackLines <= 1_000;
      if (configuredRangeFixtureAccepted) {
        await observeRenderedMarker(page, productionCorpus.newestLabel, productionRangeTimeout);
      }
      const configuredBeforeStreaming = await captureStreamingRetainedState(page, sessionId);
      const configuredBeforeMaterialized = configuredFullE2eRequired
        ? await captureStableRetainedState(page, sessionId)
        : undefined;
      const configuredInventory = await removeAllTerminalCaches(page, sessionId);
      const configuredReplacementFrameStart = harness.frames.length - 1;
      const previousConfiguredLive = live;
      live = await waitForServerAuthorityReplacementLiveTerminal(
        page,
        harness,
        previousConfiguredLive,
        productionRangeTimeout,
      );
      const configuredCheckpoint = await waitForAuthoritativeCheckpointSettlement(
        harness,
        live,
        configuredPreparation.httpStatus === 200 ? productionRangeTimeout + 15_000 : 2_000,
      );
      if (!configuredCheckpoint.validation.settled) {
        const configuredReplacementFrames = harness.frames.slice(configuredReplacementFrameStart + 1);
        const checkpointFrameTypes = new Set([
          'terminal-checkpoint:start',
          'terminal-checkpoint:chunk',
          'terminal-checkpoint:commit',
          'terminal-checkpoint:apply-ack',
          'terminal-checkpoint:drain-ack',
          'terminal-checkpoint:failure-ack',
          'terminal-checkpoint:rejected',
        ]);
        const checkpointFrameDiagnostic = (frame: CapturedFrame) => ({
          direction: frame.direction,
          generation: frame.generation,
          origin: frame.origin,
          type: frame.message?.type,
          sessionId: frame.message?.sessionId,
          viewGeneration: frame.message?.viewGeneration,
          streamEpoch: frame.message?.streamEpoch,
          checkpointEpoch: frame.message?.checkpointEpoch,
          sourceSeq: frame.message?.sourceSeq,
          snapshotSeq: frame.message?.snapshotSeq,
          oldestRetainedSeq: frame.message?.oldestRetainedSeq,
          authorityMode: frame.message?.authorityMode,
          source: frame.message?.source,
          chunkIndex: frame.message?.chunkIndex,
          chunkCount: frame.message?.chunkCount,
          appliedThroughSeq: frame.message?.appliedThroughSeq,
          drainedThroughSeq: frame.message?.drainedThroughSeq,
          registeredViews: frame.message?.registeredViews,
          checkpointDeliveryPreparation: frame.message?.checkpointDeliveryPreparation,
          reason: frame.message?.reason,
        });
        const configuredCheckpointFrames = configuredReplacementFrames
          .filter(frame => frame.message?.sessionId === sessionId
            && checkpointFrameTypes.has(frame.message.type ?? ''))
          .slice(-100)
          .map(checkpointFrameDiagnostic);
        const configuredNegotiationFrames = configuredReplacementFrames
          .filter(frame => frame.direction === 'page-to-server'
            && frame.message?.type === 'terminal-checkpoint:negotiate'
            && Array.isArray(frame.message.views)
            && frame.message.views.some(candidate => (
              candidate !== null
              && typeof candidate === 'object'
              && (candidate as Record<string, unknown>).sessionId === sessionId
            )))
          .slice(-20)
          .map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            origin: frame.origin,
            views: (frame.message!.views as Array<Record<string, unknown>>)
              .filter(candidate => candidate.sessionId === sessionId),
          }));
        const configuredCapabilityFrames = configuredReplacementFrames
          .filter(frame => frame.direction === 'server-to-page'
            && frame.message?.type === 'terminal-checkpoint:capability'
            && Array.isArray(frame.message.registeredViews)
            && frame.message.registeredViews.some(candidate => (
              candidate !== null
              && typeof candidate === 'object'
              && (candidate as Record<string, unknown>).sessionId === sessionId
            )))
          .slice(-20)
          .map(checkpointFrameDiagnostic);
        const configuredReadyFrames = configuredReplacementFrames
          .filter(frame => frame.message?.type === 'terminal-checkpoint:ready'
            || frame.message?.type === 'terminal-checkpoint:rejected')
          .slice(-20)
          .map(checkpointFrameDiagnostic);
        const configuredClientEvents = await page.evaluate((requestedSessionId) => (
          window.__buildergateTerminalDebug?.getEvents(requestedSessionId).slice(-100) ?? []
        ), sessionId);
        let configuredServerDebugCapture: ServerDebugCaptureSnapshot | Record<string, unknown>;
        try {
          configuredServerDebugCapture = await readServerDebugCapture(page, sessionId);
        } catch (error) {
          configuredServerDebugCapture = {
            readError: error instanceof Error ? error.message : String(error),
          };
        }
        let configuredAuthorityInventory: Record<string, unknown>;
        try {
          configuredAuthorityInventory = await inspectServerAuthorityTestResources(page, sessionId);
        } catch (error) {
          configuredAuthorityInventory = {
            readError: error instanceof Error ? error.message : String(error),
          };
        }
        throw new Error(
          `MIG-BGSTAB-002 configured checkpoint settlement failed: ${JSON.stringify({
            live,
            previousConfiguredLive,
            configuredCheckpoint: {
              identity: configuredCheckpoint.identity,
              lifecycleFrameCounts: configuredCheckpoint.lifecycleFrameCounts,
              validation: configuredCheckpoint.validation,
              start: configuredCheckpoint.start && checkpointFrameDiagnostic(configuredCheckpoint.start),
            },
            configuredCheckpointFrames,
            configuredNegotiationFrames,
            configuredCapabilityFrames,
            configuredReadyFrames,
            configuredClientEvents,
            configuredServerDebugCapture,
            configuredAuthorityInventory,
            routedFrameOverflowEvidence: harness.routedFrameOverflowEvidence,
          })}`,
        );
      }
      const configuredStreamingOracle = streamingCheckpointPayloadOracle(configuredCheckpoint, {
        oldestLabel: productionCorpus.oldestLabel,
        newestLabel: productionCorpus.newestLabel,
        evictedPrefixLabel: productionCorpus.evictedPrefixLabel,
      });
      const configuredAfterStreaming = await captureStreamingRetainedState(page, sessionId);
      const configuredAfterMaterialized = configuredFullE2eRequired
        ? await captureStableRetainedState(page, sessionId)
        : undefined;
      const configuredMaterializedFullEquivalence = configuredFullE2eRequired
        ? {
            mode: 'full-materialized-default-range' as const,
            required: true,
            before: configuredBeforeMaterialized!,
            after: configuredAfterMaterialized!,
            exact: JSON.stringify(configuredBeforeMaterialized) === JSON.stringify(configuredAfterMaterialized),
          }
        : {
            mode: 'bounded-page-streaming-range' as const,
            required: false,
            fullCellObjectMaterializationCount: 0,
            exact: configuredBeforeStreaming.available
              && configuredAfterStreaming.available
              && JSON.stringify(configuredBeforeStreaming.evidence)
                === JSON.stringify(configuredAfterStreaming.evidence),
          };
      const configuredBrowserBoundaryOracle = {
        before: {
          first: configuredBeforeStreaming.evidence?.firstLine ?? undefined,
          last: configuredBeforeStreaming.evidence?.lastLine ?? undefined,
        },
        after: {
          first: configuredAfterStreaming.evidence?.firstLine ?? undefined,
          last: configuredAfterStreaming.evidence?.lastLine ?? undefined,
        },
        expected: {
          first: productionCorpus.independentOracle.firstLine,
          last: productionCorpus.independentOracle.lastLine,
        },
      };
      const configuredNewestMarkerRendered = configuredRangeFixtureAccepted
        ? await observeRenderedMarker(page, productionCorpus.newestLabel, productionRangeTimeout)
        : false;
      const configuredTail = await sendPostSnapshotTailAndWait(
        page,
        harness,
        live,
        configuredCheckpoint,
        productionCorpus.deterministicTail.data,
        {
          captureMode: 'streaming',
          timeoutMs: productionRangeTimeout,
          dispatch: () => triggerConfiguredPostSnapshotTail(
            page,
            sessionId,
            configuredPreparation,
            configuredCheckpoint,
            productionCorpus.deterministicTail,
          ),
        },
      );
      const configuredPostTailState = configuredTail.streamingState;
      if (configuredTail.dispatchEvidence?.httpStatus !== 202
        || configuredTail.dispatchEvidence.accepted !== true) {
        throw new Error(
          `MIG-BGSTAB-002 configured post-snapshot tail dispatch failed: ${JSON.stringify(configuredTail.dispatchEvidence)}`,
        );
      }
      const configuredTailTransition = {
        preTailMatchesIndependentExpected: configuredAfterStreaming.available
          && JSON.stringify(configuredAfterStreaming.evidence)
            === JSON.stringify(productionCorpus.independentOracle),
        postTailMatchesIndependentExpected: configuredPostTailState?.available === true
          && JSON.stringify(configuredPostTailState.evidence)
            === JSON.stringify(productionCorpus.postTailIndependentOracle),
        expectedStateChanged: productionCorpus.independentOracle.fullStateSha256
          !== productionCorpus.postTailIndependentOracle.fullStateSha256,
        actualStateChanged: configuredAfterStreaming.evidence?.fullStateSha256 !== undefined
          && configuredPostTailState?.evidence?.fullStateSha256 !== undefined
          && configuredAfterStreaming.evidence.fullStateSha256
            !== configuredPostTailState.evidence.fullStateSha256,
        orderedLogicalTransitionExact: configuredAfterStreaming.evidence?.orderedLogicalLinesSha256
            === productionCorpus.independentOracle.orderedLogicalLinesSha256
          && configuredPostTailState?.evidence?.orderedLogicalLinesSha256
            === productionCorpus.postTailIndependentOracle.orderedLogicalLinesSha256,
        orderedCellTransitionExact: configuredAfterStreaming.evidence?.orderedCellAttributesSha256
            === productionCorpus.independentOracle.orderedCellAttributesSha256
          && configuredPostTailState?.evidence?.orderedCellAttributesSha256
            === productionCorpus.postTailIndependentOracle.orderedCellAttributesSha256,
        cursorTransitionExact: JSON.stringify(configuredAfterStreaming.evidence?.cursor)
            === JSON.stringify(productionCorpus.independentOracle.cursor)
          && JSON.stringify(configuredPostTailState?.evidence?.cursor)
            === JSON.stringify(productionCorpus.postTailIndependentOracle.cursor),
        stableFieldsExact: ['geometry', 'savedCursor', 'modes', 'activeBuffer'].every(key => (
          JSON.stringify(configuredAfterStreaming.evidence?.[key as keyof StreamingRetainedStateEvidence])
              === JSON.stringify(productionCorpus.independentOracle[key as keyof StreamingRetainedStateEvidence])
            && JSON.stringify(configuredPostTailState?.evidence?.[key as keyof StreamingRetainedStateEvidence])
              === JSON.stringify(productionCorpus.postTailIndependentOracle[key as keyof StreamingRetainedStateEvidence])
        )),
      };
      const zeroAttachedProducer = buildEchoSafeZeroViewProducerCommand({
        readyMarker: zeroAttachedReadyMarker,
        retainedMarker: zeroAttachedMarker,
        triggerPath: zeroAttachedTriggerPath,
      });
      const zeroAttachedCommand = zeroAttachedProducer.command;
      expect(zeroAttachedCommand).not.toContain(zeroAttachedReadyMarker);
      expect(zeroAttachedCommand).not.toContain(zeroAttachedMarker);
      const zeroAttachedCommandFrameStart = harness.frames.length - 1;
      await waitForVisibleTerminalInputReady(page, sessionId);
      await sendVisibleTerminalCommand(page, sessionId, zeroAttachedCommand, {
        normalizeVisiblePrompt: false,
      });
      await expect.poll(() => harness.frames.slice(zeroAttachedCommandFrameStart + 1)
        .filter(frame => frame.direction === 'page-to-server' && frame.message?.type === 'input')
        .map(frame => String(frame.message?.data ?? ''))
        .join('')
        .includes(zeroAttachedCommand), {
        message: 'browser input sequencer did not send the zero-attached PTY producer command',
        timeout: 10_000,
      }).toBe(true);
      const zeroAttachedReadyRendered = await observeRenderedSessionMarker(
        page,
        sessionId,
        zeroAttachedReadyMarker,
        productionRangeTimeout,
      );
      const zeroAttachedPreTriggerText = await visibleSessionRuntime(page, sessionId)
        .locator('.xterm-rows')
        .textContent() ?? '';
      if (!zeroAttachedReadyRendered || zeroAttachedPreTriggerText.includes(zeroAttachedMarker)) {
        const zeroAttachedOutputFrames = harness.frames.slice(zeroAttachedCommandFrameStart + 1)
          .filter(frame => frame.direction === 'server-to-page'
            && frame.message?.sessionId === sessionId
            && (frame.message?.type === 'output' || frame.message?.type === 'terminal-checkpoint:output'))
          .map(frame => decodedTerminalOutput(frame.message!))
          .join('');
        const zeroAttachedInputEvents = await page.evaluate((targetSessionId) => (
          window.__buildergateTerminalDebug?.getEvents(targetSessionId)
            .filter(event => event.kind.includes('input'))
            .slice(-20)
            .map(event => ({ kind: event.kind, details: event.details })) ?? []
        ), sessionId);
        throw new Error(
          'zero-attached echo-safe producer did not settle at the READY boundary; '
          + `readyRendered=${zeroAttachedReadyRendered}; retainedBeforeTrigger=${zeroAttachedPreTriggerText.includes(zeroAttachedMarker)}; `
          + `targetText=${JSON.stringify(zeroAttachedPreTriggerText.slice(-500))}; `
          + `routedOutput=${JSON.stringify(zeroAttachedOutputFrames.slice(-500))}; `
          + `inputEvents=${JSON.stringify(zeroAttachedInputEvents)}`,
        );
      }
      const zeroAttachedPreDetachState = await captureStreamingRetainedState(page, sessionId);
      if (!zeroAttachedPreDetachState.available || !zeroAttachedPreDetachState.evidence) {
        throw new Error('zero-attached pre-detach retained boundary oracle is unavailable');
      }
      const zeroAttachedFrameStart = harness.frames.length - 1;
      const zeroAttachedAuthToken = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
      await page.goto('about:blank');
      await harness.closeAllPageConnections();
      let zeroAttachedHealth: Record<string, unknown> | null = null;
      let zeroAttachedHealthError: string | null = null;
      try {
        zeroAttachedHealth = await probeDetachedServerHealth();
      } catch (error) {
        zeroAttachedHealthError = formatErrorForDiagnostic(error);
      }
      let zeroAttachedInventory: Record<string, unknown> | null = null;
      let zeroAttachedInventoryError: string | null = null;
      try {
        await expect.poll(async () => {
          try {
            zeroAttachedInventory = await inspectDetachedServerAuthorityTestResources(
              sessionId,
              zeroAttachedAuthToken,
              5_000,
            );
          } catch (error) {
            zeroAttachedInventoryError = formatErrorForDiagnostic(error);
            return null;
          }
          return zeroAttachedInventory.attachedResponderViewCount;
        }, {
          message: 'server did not confirm that every browser responder view was detached',
          timeout: 30_000,
        }).toBe(0);
      } catch (error) {
        throw new Error(
          'server did not confirm that every browser responder view was detached; '
          + `health=${JSON.stringify(zeroAttachedHealth)}; `
          + `healthError=${zeroAttachedHealthError ?? 'none'}; `
          + `inventory=${JSON.stringify(zeroAttachedInventory)}; `
          + `inventoryError=${zeroAttachedInventoryError ?? 'none'}`,
          { cause: error },
        );
      }
      const zeroAttachedBaselineInventory = zeroAttachedInventory;
      const zeroAttachedBaselineModelInstanceId =
        zeroAttachedBaselineInventory?.authoritativeModelInstanceId;
      const zeroAttachedBaselineSourceSeq = zeroAttachedBaselineInventory?.authoritativeSourceSeq;
      const zeroAttachedAuditIdentity = (record: Record<string, unknown>): string => JSON.stringify([
        record.type ?? null,
        record.kind ?? null,
        record.sessionId ?? null,
        record.sourceSeq ?? null,
        record.connectionId ?? null,
        record.viewGeneration ?? null,
      ]);
      const zeroAttachedBaselineAuditIdentities = new Set(
        (Array.isArray(zeroAttachedBaselineInventory?.authorityAuditTrail)
          ? zeroAttachedBaselineInventory.authorityAuditTrail as Array<Record<string, unknown>>
          : []).map(zeroAttachedAuditIdentity),
      );
      if (typeof zeroAttachedBaselineModelInstanceId !== 'string'
        || typeof zeroAttachedBaselineSourceSeq !== 'string'
        || !isCanonicalOrdinal(zeroAttachedBaselineSourceSeq)) {
        throw new Error('zero-attached retained identity baseline is unavailable');
      }
      writeFileSync(zeroAttachedTriggerPath, '', 'utf8');
      const zeroAttachedExpectedOutputSha256 = createHash('sha256')
        .update(zeroAttachedProducer.retainedOutput, 'utf8')
        .digest('hex');
      const zeroAttachedExpectedOutputBytes = Buffer.byteLength(
        zeroAttachedProducer.retainedOutput,
        'utf8',
      );
      let zeroAttachedAuditRecord: Record<string, unknown> | null = null;
      let zeroAttachedCountRemainedZero = true;
      await expect.poll(async () => {
        zeroAttachedInventory = await inspectDetachedServerAuthorityTestResources(
          sessionId,
          zeroAttachedAuthToken,
          5_000,
        );
        if (zeroAttachedInventory.attachedResponderViewCount !== 0) {
          zeroAttachedCountRemainedZero = false;
          return false;
        }
        const audit = Array.isArray(zeroAttachedInventory.authorityAuditTrail)
          ? zeroAttachedInventory.authorityAuditTrail as Array<Record<string, unknown>>
          : [];
        zeroAttachedAuditRecord = audit.find(record => (
          record.type === 'server-output-retained-without-attached-view'
          && !zeroAttachedBaselineAuditIdentities.has(zeroAttachedAuditIdentity(record))
          && typeof record.sourceSeq === 'string'
          && isCanonicalOrdinal(record.sourceSeq)
          && BigInt(record.sourceSeq) > BigInt(zeroAttachedBaselineSourceSeq)
          && record.outputDataSha256 === zeroAttachedExpectedOutputSha256
          && record.outputByteLength === zeroAttachedExpectedOutputBytes
        )) ?? null;
        return zeroAttachedAuditRecord !== null
          && zeroAttachedInventory.authoritativeModelInstanceId
            === zeroAttachedBaselineModelInstanceId;
      }, {
        message: 'server did not prove PTY output retention while every browser view was detached',
        timeout: 30_000,
      }).toBe(true);
      const previousZeroAttachedLive = live;
      live = await waitForServerAuthorityReplacementLiveTerminal(
        page,
        harness,
        previousZeroAttachedLive,
        productionRangeTimeout,
        true,
      );
      const zeroAttachedReplacementCheckpoint = await waitForAuthoritativeCheckpointSettlement(
        harness,
        live,
        productionRangeTimeout,
      );
      const firstReplacementDigest = zeroAttachedReplacementCheckpoint.start?.message?.retainedStateDigest;
      const firstReplacementCommitDigest = zeroAttachedReplacementCheckpoint.commit?.message?.retainedStateDigest;
      const firstReplacementAnsi = decodedCheckpointAnsi(zeroAttachedReplacementCheckpoint);
      const firstReplacementMarkerRendered = await observeRenderedMarker(
        page,
        zeroAttachedMarker,
        productionRangeTimeout,
      );
      const zeroAttachedReplacementState = await captureStreamingRetainedState(page, sessionId);
      const firstReplacementLive = live;
      live = await waitForServerAuthorityReplacementLiveTerminal(
        page,
        harness,
        firstReplacementLive,
        productionRangeTimeout,
      );
      const zeroAttachedParityCheckpoint = await waitForAuthoritativeCheckpointSettlement(
        harness,
        live,
        productionRangeTimeout,
      );
      const zeroAttachedParityState = await captureStreamingRetainedState(page, sessionId);
      const secondReplacementDigest = zeroAttachedParityCheckpoint.start?.message?.retainedStateDigest;
      const secondReplacementCommitDigest = zeroAttachedParityCheckpoint.commit?.message?.retainedStateDigest;
      const secondReplacementAnsi = decodedCheckpointAnsi(zeroAttachedParityCheckpoint);
      const zeroAttachedOverlapMatches = zeroAttachedPreDetachState.evidence.overlap.shifts
        .filter(preDetachShift => zeroAttachedReplacementState.evidence?.overlap.shifts.some(
          postAttachShift => postAttachShift.shiftLines === preDetachShift.shiftLines
            && postAttachShift.prefixSha256 === preDetachShift.suffixSha256,
        ))
        .map(match => match.shiftLines);
      const zeroAttachedExactShift = zeroAttachedOverlapMatches.length === 1
        ? zeroAttachedOverlapMatches[0]!
        : null;
      const zeroAttachedOverlapContractValid = zeroAttachedPreDetachState.evidence.overlap.contract
          === 'ph005-retained-overlap-v1'
        && zeroAttachedReplacementState.evidence?.overlap.contract === 'ph005-retained-overlap-v1'
        && zeroAttachedPreDetachState.evidence.overlap.canonicalLineFingerprint
          === 'logical-line-and-cell-attributes-without-index'
        && zeroAttachedReplacementState.evidence?.overlap.canonicalLineFingerprint
          === 'logical-line-and-cell-attributes-without-index';
      const zeroAttachedRetainedLineCountStable = zeroAttachedReplacementState.evidence?.lineCount
        === zeroAttachedPreDetachState.evidence.lineCount;
      const zeroAttachedOldestBoundaryEvicted = zeroAttachedReplacementState.evidence?.firstLine.logicalLineSha256
        !== zeroAttachedPreDetachState.evidence.firstLine.logicalLineSha256;
      const zeroAttachedNewestBoundaryAppended = zeroAttachedReplacementState.evidence?.lastLine.logicalLineSha256
        !== zeroAttachedPreDetachState.evidence.lastLine.logicalLineSha256;
      const zeroAttachedFullStateChanged = zeroAttachedReplacementState.evidence?.fullStateSha256
        !== zeroAttachedPreDetachState.evidence.fullStateSha256;
      const zeroAttachedShiftedRangeContinuity = zeroAttachedOverlapContractValid
        && zeroAttachedOverlapMatches.length === 1
        && zeroAttachedRetainedLineCountStable;
      const zeroAttachedInPlaceRangeContinuity = zeroAttachedOverlapContractValid
        && zeroAttachedOverlapMatches.length === 0
        && zeroAttachedRetainedLineCountStable
        && !zeroAttachedOldestBoundaryEvicted
        && !zeroAttachedNewestBoundaryAppended
        && zeroAttachedFullStateChanged
        && firstReplacementAnsi?.includes(zeroAttachedMarker) === true;
      const zeroAttachedBoundaryContinuity = {
        preDetachFullStateSha256: zeroAttachedPreDetachState.evidence.fullStateSha256,
        postAttachFullStateSha256: zeroAttachedReplacementState.evidence?.fullStateSha256 ?? null,
        retainedLineCountStable: zeroAttachedRetainedLineCountStable,
        oldestBoundaryEvicted: zeroAttachedOldestBoundaryEvicted,
        newestBoundaryAppended: zeroAttachedNewestBoundaryAppended,
        fullStateChanged: zeroAttachedFullStateChanged,
        checkpointContainsDetachedPtyMarker: firstReplacementAnsi?.includes(zeroAttachedMarker) === true,
        sourceSeqAdvanced: typeof zeroAttachedAuditRecord?.sourceSeq === 'string'
          && BigInt(zeroAttachedAuditRecord.sourceSeq) > BigInt(zeroAttachedBaselineSourceSeq),
        overlapContract: 'ph005-retained-overlap-v1',
        overlapContractValid: zeroAttachedOverlapContractValid,
        preDetachOverlapShifts: zeroAttachedPreDetachState.evidence.overlap.shifts,
        postAttachOverlapShifts: zeroAttachedReplacementState.evidence?.overlap.shifts ?? [],
        matchingShiftLines: zeroAttachedOverlapMatches,
        exactOverlapMatchCount: zeroAttachedOverlapMatches.length,
        exactEvictedLineCount: zeroAttachedExactShift,
        exactAppendedLineCount: zeroAttachedExactShift === null
          || !zeroAttachedReplacementState.evidence
          ? null
          : zeroAttachedReplacementState.evidence.lineCount
            - (zeroAttachedPreDetachState.evidence.lineCount - zeroAttachedExactShift),
        continuityKind: zeroAttachedShiftedRangeContinuity
          ? 'shifted-retained-range'
          : zeroAttachedInPlaceRangeContinuity
            ? 'in-place-retained-range'
            : 'unproven',
        fullRetainedOverlapProven: zeroAttachedShiftedRangeContinuity
          || zeroAttachedInPlaceRangeContinuity,
      };
      const zeroAttachedFullRetainedStateParity = zeroAttachedReplacementState.available
        && zeroAttachedParityState.available
        && zeroAttachedReplacementState.evidence?.fullStateSha256 !== undefined
        && zeroAttachedReplacementState.evidence.fullStateSha256
          === zeroAttachedParityState.evidence?.fullStateSha256
        && typeof firstReplacementDigest === 'string'
        && firstReplacementDigest === firstReplacementCommitDigest
        && firstReplacementDigest === secondReplacementDigest
        && secondReplacementDigest === secondReplacementCommitDigest
        && firstReplacementAnsi?.includes(zeroAttachedMarker) === true
        && secondReplacementAnsi?.includes(zeroAttachedMarker) === true;
      const zeroAttachedRecovery = {
        marker: zeroAttachedMarker,
        zeroAttachedAuditObserved: true,
        baseline: {
          authoritativeModelInstanceId: zeroAttachedBaselineModelInstanceId,
          sourceSeq: zeroAttachedBaselineSourceSeq,
          attachedResponderViewCount: zeroAttachedBaselineInventory?.attachedResponderViewCount,
          auditIdentities: [...zeroAttachedBaselineAuditIdentities],
        },
        retainedAuditRecord: zeroAttachedAuditRecord,
        zeroAttachedOutputIdentityMatch:
          zeroAttachedAuditRecord?.outputDataSha256 === zeroAttachedExpectedOutputSha256
          && zeroAttachedAuditRecord?.outputByteLength === zeroAttachedExpectedOutputBytes,
        retainedDuringContinuousZeroView: zeroAttachedCountRemainedZero,
        sourceSeqAfterBaseline: typeof zeroAttachedAuditRecord?.sourceSeq === 'string'
          && BigInt(zeroAttachedAuditRecord.sourceSeq) > BigInt(zeroAttachedBaselineSourceSeq),
        boundaryContinuity: zeroAttachedBoundaryContinuity,
        frameStart: zeroAttachedFrameStart,
        firstReplacementMarkerRendered,
        zeroAttachedFullRetainedStateParity,
        firstReplacementFullStateSha256:
          zeroAttachedReplacementState.evidence?.fullStateSha256 ?? null,
        secondReplacementFullStateSha256: zeroAttachedParityState.evidence?.fullStateSha256 ?? null,
        zeroAttachedReplacementCheckpoint: {
          retainedStateDigest: firstReplacementDigest,
          transactionValidation: zeroAttachedReplacementCheckpoint.validation,
        },
        parityCheckpoint: {
          retainedStateDigest: secondReplacementDigest,
          transactionValidation: zeroAttachedParityCheckpoint.validation,
        },
      };
      const configuredCleanup = await cleanupServerAuthorityTestState(
        page,
        sessionId,
        configuredPreparation,
      );
      const configuredPostCleanupInventory = await inspectServerAuthorityTestResources(page, sessionId);
      preparation = { httpStatus: 0 };

      const partialEscapeContract = buildPartialEscapeRecoveryContract(
        `P5-PTR-${Date.now()}`,
      );
      const partialEscapePreparation = recordPreparationOperation(
        'partial-escape',
        await prepareServerAuthorityTestState(
          page,
          sessionId,
          'server',
          partialEscapeContract.request,
          { retryTransient: false },
        ),
      );
      preparation = partialEscapePreparation;
      const partialEscapeInventory = await removeAllTerminalCaches(page, sessionId);
      const previousPartialEscapeLive = live;
      live = await waitForServerAuthorityReplacementLiveTerminal(page, harness, previousPartialEscapeLive);
      const partialEscapeCheckpoint = await waitForAuthoritativeCheckpointSettlement(harness, live);
      const parserTailRecord = partialEscapeCheckpoint.start?.message?.parserTail;
      const decodedParserTail = parserTailRecord && typeof parserTailRecord === 'object'
        ? decodedCheckpointPayload(parserTailRecord as JsonFrame)
        : null;
      const exactNonEmptyParserTail = decodedParserTail !== null
        && decodedParserTail.byteLength > 0
        && decodedParserTail.toString('utf8') === partialEscapeContract.parserTailPrefix;
      const partialEscapeTail = await sendPostSnapshotTailAndWait(
        page,
        harness,
        live,
        partialEscapeCheckpoint,
        partialEscapeContract.visibleMarker,
        {
          dispatch: () => triggerConfiguredPostSnapshotTail(
            page,
            sessionId,
            partialEscapePreparation,
            partialEscapeCheckpoint,
            partialEscapeContract.suffix,
          ),
        },
      );
      const partialRoutedText = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-checkpoint:output'
          && partialEscapeCheckpoint.identity !== null
          && sameCheckpointBoundary(message, partialEscapeCheckpoint.identity),
        { generation: live.generation },
      ).filter(frame => frame.origin === 'routed-server')
        .map(frame => decodedTerminalOutput(frame.message!))
        .join('');
      const partialRenderedText = await page.locator('.terminal-view:visible .xterm-rows')
        .first()
        .textContent() ?? '';
      const expectedRecoveredLineHash = retainedLogicalLineHash(
        `PH005-PARSER-TAIL-BASE${partialEscapeContract.visibleMarker}`,
      );
      const unconsumedSuffixLineHash = retainedLogicalLineHash(
        `PH005-PARSER-TAIL-BASE196m${partialEscapeContract.visibleMarker}`,
      );
      const recoveredLineHashes = new Set(
        partialEscapeTail.state?.lineFingerprints.map(line => line.logicalLineHash) ?? [],
      );
      const parserTailRecovery = {
        exactNonEmptyParserTail,
        prefixSha256: decodedParserTail
          ? createHash('sha256').update(decodedParserTail).digest('hex')
          : null,
        expectedPrefixSha256: createHash('sha256')
          .update(Buffer.from(partialEscapeContract.parserTailPrefix, 'utf8'))
          .digest('hex'),
        routedMarkerCount: partialRoutedText.split(partialEscapeContract.visibleMarker).length - 1,
        renderedMarkerCount: partialRenderedText.split(partialEscapeContract.visibleMarker).length - 1,
        unconsumedSuffixLiteralVisible: partialRenderedText.includes(
          `196m${partialEscapeContract.visibleMarker}`,
        ),
        recoveredSemanticLinePresent: recoveredLineHashes.has(expectedRecoveredLineHash),
        unconsumedSuffixSemanticLineAbsent: !recoveredLineHashes.has(unconsumedSuffixLineHash),
        tail: partialEscapeTail,
      };
      const partialEscapeCleanup = await cleanupServerAuthorityTestState(
        page,
        sessionId,
        partialEscapePreparation,
      );
      const partialEscapePostCleanupInventory = await inspectServerAuthorityTestResources(page, sessionId);
      preparation = { httpStatus: 0 };

      const alternateMarker = `PH005-ALT-ACTIVE-${Date.now()}`;
      const alternateContractRequest = buildAlternateActiveFixtureContract(alternateMarker);
      const alternatePreparation = recordPreparationOperation(
        'alternate-buffer',
        await prepareServerAuthorityTestState(
          page,
          sessionId,
          'server',
          alternateContractRequest,
          { retryTransient: false },
        ),
      );
      preparation = alternatePreparation;
      const alternateResponseContract = alternatePreparation.testContract as Record<string, unknown> | undefined;
      const alternateInjection = alternateResponseContract?.retainedCorpusInjection as Record<string, unknown> | undefined;
      const alternateFixtureAccepted = alternatePreparation.httpStatus === 200
        && alternateInjection?.accepted === true
        && alternateInjection.activeBuffer === 'alternate'
        && alternateInjection.savedCursor === 'present-normal-buffer';
      const alternateMarkerRendered = alternateFixtureAccepted
        ? await observeRenderedMarker(page, alternateMarker)
        : false;
      const beforeAlternate = await captureQuiescentRetainedState(page, sessionId);
      const alternateInventory = await removeAllTerminalCaches(page, sessionId);
      const previousAlternateLive = live;
      live = await waitForServerAuthorityReplacementLiveTerminal(page, harness, previousAlternateLive);
      const alternateCheckpoint = await waitForAuthoritativeCheckpointSettlement(harness, live);
      const afterAlternate = await captureQuiescentRetainedState(page, sessionId);
      expect(
        comparable(afterAlternate),
        'MIG-BGSTAB-002 AC-4 poisoned no-cache alternate buffer checkpoint must preserve retained state before post-snapshot output',
      ).toEqual(comparable(beforeAlternate));
      const alternateTailContract = buildDeterministicTailContract(
        `PH005-ALT-POST-TAIL-${Date.now()}`,
      );
      const alternateTail = await sendPostSnapshotTailAndWait(
        page,
        harness,
        live,
        alternateCheckpoint,
        alternateTailContract.data,
        {
          dispatch: () => triggerConfiguredPostSnapshotTail(
            page,
            sessionId,
            alternatePreparation,
            alternateCheckpoint,
            alternateTailContract,
          ),
        },
      );
      const alternateIndependentBufferOracle = independentCheckpointBufferOracle(alternateCheckpoint, {
        activeBuffer: 'alternate',
        normalMarker: alternateInactiveNormalMarker(alternateMarker),
        alternateMarker,
        savedCursorRequired: true,
        expectedSavedCursor: alternateSavedCursorExpectation(),
      });
      const alternateCleanup = await cleanupServerAuthorityTestState(page, sessionId, alternatePreparation);
      const alternatePostCleanupInventory = await inspectServerAuthorityTestResources(page, sessionId);
      preparation = { httpStatus: 0 };
      freshBaselineSessionId = await createUnselectedSession(page);
      const freshSessionBaseline = await inspectServerAuthorityTestResources(page, freshBaselineSessionId);

      const expectedCacheEntries = (scenario: TerminalCacheScenario) => {
        const cacheSource = terminalCacheProductionInventory();
        const snapshotKey = `${cacheSource.snapshotKeyPrefix}${sessionId}`;
        const tombstoneKey = `${cacheSource.tombstoneKeyPrefix}${sessionId}`;
        const presentKey = scenario === 'valid-stale' || scenario === 'malformed'
          ? snapshotKey
          : scenario === 'tombstone'
            ? tombstoneKey
            : null;
        const productionEntries = [snapshotKey, tombstoneKey].map(key => ({
          storage: cacheSource.primaryProductionStorage,
          key,
          valueHash: key === presentKey ? expect.stringMatching(/^fnv1a32:/u) : 'absent',
        }));
        const defensiveStorageNames = ['localStorage', 'sessionStorage']
          .filter(storageName => !cacheSource.discoveredStorageApis.includes(storageName));
        return expect.arrayContaining([
          ...productionEntries,
          ...defensiveStorageNames.flatMap(storage => [snapshotKey, tombstoneKey].map(key => ({
            storage,
            key,
            valueHash: 'absent',
          }))),
        ]);
      };
      const staticCacheInventory = terminalCacheProductionInventory();
      const expectedActualCacheSources = [
        ...staticCacheInventory.discoveredStorageApis.flatMap(storageName => (
          staticCacheInventory.discoveredKeyPrefixes.map(prefix => `${storageName}:${prefix}`)
        )),
        ...staticCacheInventory.discoveredModuleSets.map(name => `module-memory:${name}`),
      ].sort();
      const expectedDefensiveCacheSurfaces = ['sessionStorage']
        .filter(storageName => !staticCacheInventory.discoveredStorageApis.includes(storageName))
        .flatMap(storageName => staticCacheInventory.discoveredKeyPrefixes.map(prefix => `${storageName}:${prefix}`))
        .sort();
      const expectedCleanup = (prepared: Record<string, unknown>) => expect.objectContaining({
        httpStatus: 200,
        mode: 'legacy',
        cleanup: expect.objectContaining({
          accepted: true,
          cleanupToken: prepared.cleanupToken,
          isolationLeaseId: prepared.isolationLeaseId,
          isolationLeaseReleased: true,
          resourceInventory: expectedZeroIsolationResourceInventory(),
        }),
      });
      const expectedPayloadContract = (scenario: TerminalCacheScenario) => ({
        'valid-stale': 'schema-v2-valid-stale-without-tombstone',
        malformed: 'malformed-snapshot-without-tombstone',
        tombstone: 'valid-removal-tombstone-without-snapshot',
        absent: 'all-terminal-cache-surfaces-absent',
      })[scenario];
      const checkpointSummary = (stage: {
        before: TerminalRetainedStateEvidence;
        checkpoint: CheckpointTransactionEvidence;
      }) => ({
        origin: stage.checkpoint.start?.origin ?? null,
        metadata: stage.checkpoint.start?.message ?? null,
        retainedRange: checkpointRetainedRange(stage.checkpoint),
        localCacheUsed: stage.checkpoint.localCacheUsed,
        transactionValidation: stage.checkpoint.validation,
      });
      const tailSummary = (tail: PostSnapshotTailEvidence) => ({
        marker: tail.marker,
        commandEchoSafe: tail.commandEchoSafe,
        routedOutputObserved: tail.routedOutputObserved,
        rendered: tail.rendered,
        promptSettled: tail.promptSettled,
        settlementMode: tail.settlementMode,
        deliverySettled: tail.deliverySettled,
        sourceSequences: tail.sourceSequences,
        allSourceSequencesAfterSnapshot: tail.allSourceSequencesAfterSnapshot,
      });
      const expectedCheckpoint = (
        _before: TerminalRetainedStateEvidence,
        activeBuffer: 'normal' | 'alternate',
        prepared: Record<string, unknown>,
      ) => {
        const expectedPolicy = retainedPolicyEvidence(prepared);
        return ({
        origin: 'routed-server',
        metadata: expect.objectContaining({
          type: 'terminal-checkpoint:start',
          authorityMode: 'server',
          source: 'server-retained-authority',
          localCacheUsed: false,
          retentionPolicyId: expectedPolicy.retentionPolicyId,
          retentionPolicySource: expectedPolicy.source,
          effectiveRetainedScrollbackLines: expectedPolicy.effectiveRetainedScrollbackLines,
          retainedLineCount: expect.any(Number),
          retainedActiveBuffer: activeBuffer,
          retainedActiveStateDigest: expect.stringMatching(/^fnv1a64:/u),
          retainedBuffers: expect.objectContaining({
            [activeBuffer]: expect.objectContaining({
              logicalLinesHash: expect.stringMatching(/^fnv1a64:/u),
              cellContentAttributeHash: expect.stringMatching(/^fnv1a64:/u),
            }),
            normal: expect.objectContaining({
              logicalLinesHash: expect.stringMatching(/^fnv1a64:/u),
              cellContentAttributeHash: expect.stringMatching(/^fnv1a64:/u),
              retainedLineCount: expect.any(Number),
            }),
            alternate: expect.objectContaining({
              logicalLinesHash: expect.stringMatching(/^fnv1a64:/u),
              cellContentAttributeHash: expect.stringMatching(/^fnv1a64:/u),
            }),
          }),
          retainedSavedCursor: activeBuffer === 'normal'
            ? null
            : expect.objectContaining({ buffer: 'normal', x: expect.any(Number), y: expect.any(Number) }),
          snapshotSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          oldestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
        }),
        retainedRange: {
          retainedLineCount: expect.any(Number),
          oldestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          newestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          canonical: true,
          ordered: true,
        },
        localCacheUsed: false,
        transactionValidation: {
          identityCanonical: true,
          exactLifecycleFrameCounts: true,
          exactChunkCountAndIndices: true,
          encodedByteTotalValid: true,
          digestValid: true,
          parserTailEnvelopeValid: true,
          retainedStateDigestValid: true,
          exactFrameOrder: true,
          sameTerminalLane: true,
          terminalLaneTypeWhitelist: true,
          preCommitInterleavingCount: 0,
          applyAckValid: true,
          drainAckValid: true,
          failureAckCount: 0,
          settled: true,
        },
        });
      };

      expect({
        authorityIsolation: normalStages[0]?.preparation ?? preparation,
        preparationOperationLedger,
        retentionPolicy,
        productionConfiguredPolicy,
        retainedCorpus: {
          fixtureAccepted,
          fixtureMarkerRendered,
          expectedRetainedLineCount: corpus.expectedRetainedLineCount,
          overflowLineCount: PH005_RETAINED_OVERFLOW_LINES,
          outputLineCount: corpus.outputLineCount,
          maximumConfiguredBoundaryEvidence: PH005_MAX_POLICY_BOUNDARY_CONTRACT,
        },
        independentBoundaryOracle,
        canaryDecisionOrigin: canaryDecision?.origin ?? null,
        normalStages: normalStages.map(stage => ({
          scenario: stage.scenario,
          preparation: stage.preparation,
          cleanup: stage.cleanup,
          postCleanupInventory: stage.postCleanupInventory,
          inventory: stage.inventory,
          retainedLineCounts: {
            before: stage.before.lineFingerprints.length,
            after: stage.after.lineFingerprints.length,
          },
          restore: { before: comparable(stage.before), after: comparable(stage.after) },
          checkpoint: checkpointSummary(stage),
          independentBufferOracle: stage.independentBufferOracle,
          tail: tailSummary(stage.tail),
        })),
        configuredRangeRound: {
          preparation: configuredPreparation,
          productionPolicy: configuredProductionPolicy,
          fixtureAccepted: configuredRangeFixtureAccepted,
          generatorBounded: configuredGeneratorBounded,
          inventory: configuredInventory,
          timeoutMs: productionRangeTimeout,
          fullE2eRequired: configuredFullE2eRequired,
          checkpoint: checkpointSummary({
            before: configuredAfterMaterialized ?? initialState,
            checkpoint: configuredCheckpoint,
          }),
          streamingOracle: configuredStreamingOracle,
          independentExpectedState: productionCorpus.independentOracle,
          browserStateBeforeReload: configuredBeforeStreaming,
          browserStateAfterReload: configuredAfterStreaming,
          materializedFullEquivalence: configuredMaterializedFullEquivalence,
          browserBoundaryOracle: configuredBrowserBoundaryOracle,
          newestMarkerRendered: configuredNewestMarkerRendered,
          tail: {
            marker: configuredTail.marker,
            deterministicInput: productionCorpus.deterministicTail,
            independentPostTailExpectedState: productionCorpus.postTailIndependentOracle,
            commandEchoSafe: configuredTail.commandEchoSafe,
            routedOutputObserved: configuredTail.routedOutputObserved,
            rendered: configuredTail.rendered,
            promptSettled: configuredTail.promptSettled,
            settlementMode: configuredTail.settlementMode,
            deliverySettled: configuredTail.deliverySettled,
            sourceSequences: configuredTail.sourceSequences,
            allSourceSequencesAfterSnapshot: configuredTail.allSourceSequencesAfterSnapshot,
            checkpointDrainAckValid: configuredTail.checkpointDrainAckValid,
            quiescence: configuredTail.quiescence,
            streamingState: configuredTail.streamingState,
            dispatchEvidence: configuredTail.dispatchEvidence,
            transition: configuredTailTransition,
          },
          zeroAttachedRecovery,
          cleanup: configuredCleanup,
          postCleanupInventory: configuredPostCleanupInventory,
        },
        partialEscapeRound: {
          preparation: partialEscapePreparation,
          inventory: partialEscapeInventory,
          checkpoint: checkpointSummary({ before: initialState, checkpoint: partialEscapeCheckpoint }),
          parserTailRecovery,
          cleanup: partialEscapeCleanup,
          postCleanupInventory: partialEscapePostCleanupInventory,
        },
        alternateRound: {
          preparation: alternatePreparation,
          fixtureAccepted: alternateFixtureAccepted,
          markerRendered: alternateMarkerRendered,
          inventory: alternateInventory,
          activeBuffers: { before: beforeAlternate.activeBuffer, after: afterAlternate.activeBuffer },
          restore: { before: comparable(beforeAlternate), after: comparable(afterAlternate) },
          checkpoint: checkpointSummary({ before: beforeAlternate, checkpoint: alternateCheckpoint }),
          independentBufferOracle: alternateIndependentBufferOracle,
          cleanup: alternateCleanup,
          postCleanupInventory: alternatePostCleanupInventory,
          tail: tailSummary(alternateTail),
        },
        freshSessionBaseline,
      }, 'MIG-BGSTAB-002 AC-4 authoritative no-cache checkpoint contract is absent').toEqual({
        authorityIsolation: expect.objectContaining({
          httpStatus: 200,
          mode: 'server',
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          guardEvidence: expectedTerminalAuthorityGuardEvidence(),
          productionConfiguredRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
          productionConfiguredRetainedScrollbackSource:
            productionConfiguredPolicy.productionConfiguredRetainedScrollbackSource,
          productionConfiguredRetentionPolicyId:
            productionConfiguredPolicy.productionConfiguredRetentionPolicyId,
          effectiveHeadlessRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
          retentionPolicy: {
            effectiveRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
            retentionPolicyId: retentionPolicy.retentionPolicyId,
            source: retentionPolicy.source,
          },
          testContract: expect.objectContaining({
            contractVersion: 1,
            retainedPolicyOverride: expect.objectContaining({
              accepted: true,
              scope: 'session-generation-test-isolation',
              effectiveRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
              maximumConfiguredBoundaryEvidence: PH005_MAX_POLICY_BOUNDARY_CONTRACT,
            }),
            retainedCorpusInjection: expect.objectContaining({
              accepted: true,
              action: 'inject-authoritative-raw-output-after-promotion',
              sha256: corpus.payloadSha256,
              physicalLineCount: corpus.outputLineCount,
              expectedRetainedPhysicalLineCount: corpus.expectedRetainedLineCount,
              overflowPhysicalLineCount: PH005_RETAINED_OVERFLOW_LINES,
            }),
          }),
        }),
        preparationOperationLedger: {
          schemaVersion: 'ph005-preparation-operation-ledger/v1',
          operations: [
            'cache-valid-stale',
            'cache-malformed',
            'cache-tombstone',
            'cache-absent',
            'configured-range',
            'partial-escape',
            'alternate-buffer',
          ].map(name => ({ name, attempt: 1, outcome: 'success', httpStatus: 200 })),
        },
        retentionPolicy: {
          valid: true,
          effectiveRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
          retentionPolicyId: expect.stringMatching(/^.+$/u),
          source: expect.stringMatching(/^(resourceLimits\.terminal\.scrollbackLines|pty\.scrollbackLines)$/u),
        },
        productionConfiguredPolicy: {
          valid: true,
          productionConfiguredRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
          productionConfiguredRetainedScrollbackSource: expect.stringMatching(
            /^(resourceLimits\.terminal\.scrollbackLines|pty\.scrollbackLines)$/u,
          ),
          productionConfiguredRetentionPolicyId: expect.stringMatching(/^.+$/u),
          effectiveHeadlessRetainedScrollbackLines: PH005_RETAINED_POLICY_LINES,
          effectiveMatchesProductionConfigured:
            productionCorpus.configuredScrollbackLines === PH005_RETAINED_POLICY_LINES,
        },
        retainedCorpus: {
          fixtureAccepted: true,
          fixtureMarkerRendered: true,
          expectedRetainedLineCount: corpus.expectedRetainedLineCount,
          overflowLineCount: PH005_RETAINED_OVERFLOW_LINES,
          outputLineCount: corpus.expectedRetainedLineCount + PH005_RETAINED_OVERFLOW_LINES,
          maximumConfiguredBoundaryEvidence: PH005_MAX_POLICY_BOUNDARY_CONTRACT,
        },
        independentBoundaryOracle: {
          geometryWideEnough: true,
          oldest: expect.objectContaining({ index: 0, logicalLineHash: corpus.oldestLogicalLineHash }),
          newest: expect.objectContaining({
            index: corpus.expectedRetainedLineCount - 1,
            logicalLineHash: corpus.newestLogicalLineHash,
          }),
          expectedOldestLogicalLineHash: corpus.oldestLogicalLineHash,
          expectedNewestLogicalLineHash: corpus.newestLogicalLineHash,
          evictedPrefixAbsent: true,
        },
        canaryDecisionOrigin: 'routed-server',
        normalStages: normalStages.map(stage => ({
          scenario: stage.scenario,
          preparation: expect.objectContaining({
            httpStatus: 200,
            mode: 'server',
            cleanupToken: expect.any(String),
            isolationLeaseId: expect.any(String),
          }),
          cleanup: expectedCleanup(stage.preparation),
          postCleanupInventory: expect.objectContaining({
            httpStatus: 200,
            mode: 'legacy',
            source: 'server-test-isolation-inventory',
            inspectedSessionId: sessionId,
            isolationLeaseAcquired: false,
            resourceInventory: expectedZeroIsolationResourceInventory(),
          }),
          inventory: {
            scenario: stage.scenario,
            actualSources: expectedActualCacheSources,
            defensiveSurfaces: expectedDefensiveCacheSurfaces,
            entries: expectedCacheEntries(stage.scenario),
            payloadContract: expectedPayloadContract(stage.scenario),
            inventoryEvidence: {
              ...staticCacheInventory,
              debugSurfaceKeys: expect.arrayContaining(['captureRetainedState']),
            },
          },
          retainedLineCounts: {
            before: corpus.expectedRetainedLineCount,
            after: corpus.expectedRetainedLineCount,
          },
          restore: { before: comparable(stage.before), after: comparable(stage.before) },
          checkpoint: expectedCheckpoint(stage.before, 'normal', stage.preparation),
          independentBufferOracle: {
            payloadDecoded: true,
            normalMarkerPresent: true,
            alternateMarkerPresent: false,
            activeBuffer: 'normal',
            activeBufferMatches: true,
            savedCursorRoundTripPresent: true,
            cursorRoundTrip: null,
            metadataIndependent: true,
          },
          tail: {
            marker: stage.tail.marker,
            commandEchoSafe: true,
            routedOutputObserved: true,
            rendered: true,
            promptSettled: false,
            settlementMode: 'dispatch-output-quiescence',
            deliverySettled: true,
            sourceSequences: expect.arrayContaining([expect.stringMatching(/^(0|[1-9]\d*)$/u)]),
            allSourceSequencesAfterSnapshot: true,
          },
        })),
        configuredRangeRound: {
          preparation: expect.objectContaining({
            httpStatus: 200,
            mode: 'server',
            source: 'server-test-isolation',
            productionConfiguredRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
            productionConfiguredRetainedScrollbackSource:
              productionConfiguredPolicy.productionConfiguredRetainedScrollbackSource,
            productionConfiguredRetentionPolicyId:
              productionConfiguredPolicy.productionConfiguredRetentionPolicyId,
            effectiveHeadlessRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
            testContract: expect.objectContaining({
              productionConfiguredRangeProbe: expect.objectContaining({
                accepted: true,
                action: 'generate-and-inject-production-configured-retained-corpus-stream',
                configuredScrollbackLines: productionCorpus.configuredScrollbackLines,
                physicalLineCount: productionCorpus.outputLineCount,
                expectedRetainedPhysicalLineCount: productionCorpus.expectedRetainedLineCount,
                expectedOldestLabel: productionCorpus.oldestLabel,
                expectedNewestLabel: productionCorpus.newestLabel,
                materializationPolicy: 'bounded-generator-window-no-full-cell-array',
                verificationPolicy: 'checkpoint-streaming-rolling-sha256-boundary-oracle',
                peakMaterializedPhysicalLines: expect.any(Number),
                generatorWindowPhysicalLines: expect.any(Number),
                fullCellMaterializationCount: 0,
              }),
            }),
          }),
          productionPolicy: {
            valid: true,
            productionConfiguredRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
            productionConfiguredRetainedScrollbackSource:
              productionConfiguredPolicy.productionConfiguredRetainedScrollbackSource,
            productionConfiguredRetentionPolicyId:
              productionConfiguredPolicy.productionConfiguredRetentionPolicyId,
            effectiveHeadlessRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
            effectiveMatchesProductionConfigured: true,
          },
          fixtureAccepted: true,
          generatorBounded: true,
          inventory: {
            scenario: 'absent',
            actualSources: expectedActualCacheSources,
            defensiveSurfaces: expectedDefensiveCacheSurfaces,
            entries: expectedCacheEntries('absent'),
            payloadContract: expectedPayloadContract('absent'),
            inventoryEvidence: {
              ...staticCacheInventory,
              debugSurfaceKeys: expect.arrayContaining([
                'captureRetainedState',
                'captureRetainedStateStreaming',
              ]),
            },
          },
          timeoutMs: configuredRangeTimeoutMs(productionCorpus.configuredScrollbackLines),
          fullE2eRequired: productionCorpus.configuredScrollbackLines <= 1_000,
          checkpoint: {
            origin: 'routed-server',
            metadata: expect.objectContaining({
              type: 'terminal-checkpoint:start',
              authorityMode: 'server',
              source: 'server-retained-authority',
              localCacheUsed: false,
              retentionPolicyId: productionConfiguredPolicy.productionConfiguredRetentionPolicyId,
              retentionPolicySource: productionConfiguredPolicy.productionConfiguredRetainedScrollbackSource,
              effectiveRetainedScrollbackLines: productionCorpus.configuredScrollbackLines,
              retainedLineCount: productionCorpus.expectedRetainedLineCount,
            }),
            retainedRange: {
              retainedLineCount: productionCorpus.expectedRetainedLineCount,
              oldestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              newestRetainedSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              canonical: true,
              ordered: true,
            },
            localCacheUsed: false,
            transactionValidation: {
              identityCanonical: true,
              exactLifecycleFrameCounts: true,
              exactChunkCountAndIndices: true,
              encodedByteTotalValid: true,
              digestValid: true,
              parserTailEnvelopeValid: true,
              retainedStateDigestValid: true,
              exactFrameOrder: true,
              sameTerminalLane: true,
              terminalLaneTypeWhitelist: true,
              preCommitInterleavingCount: 0,
              applyAckValid: true,
              drainAckValid: true,
              failureAckCount: 0,
              settled: true,
            },
          },
          streamingOracle: {
            validEncoding: true,
            decodedBytes: expect.any(Number),
            digest: { algorithm: 'sha256', hex: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            rollingDigestMatchesCheckpoint: true,
            encodedByteTotalsMatch: true,
            oldestBoundaryFound: true,
            newestBoundaryFound: true,
            evictedPrefixAbsent: true,
            maxMaterializedTextChars: expect.any(Number),
            maximumDecodedChunkBytes: expect.any(Number),
            boundedStreamingWindow: true,
            fullPayloadConcatenations: 0,
          },
          independentExpectedState: productionCorpus.independentOracle,
          browserStateBeforeReload: {
            available: true,
            evidence: productionCorpus.independentOracle,
          },
          browserStateAfterReload: {
            available: true,
            evidence: productionCorpus.independentOracle,
          },
          materializedFullEquivalence: configuredFullE2eRequired
            ? {
                mode: 'full-materialized-default-range',
                required: true,
                before: expect.objectContaining({
                  activeBuffer: productionCorpus.independentOracle.activeBuffer,
                  geometry: productionCorpus.independentOracle.geometry,
                  cursor: productionCorpus.independentOracle.cursor,
                  savedCursor: productionCorpus.independentOracle.savedCursor,
                  modes: productionCorpus.independentOracle.modes,
                  lineFingerprints: expect.any(Array),
                }),
                after: expect.objectContaining({
                  activeBuffer: productionCorpus.independentOracle.activeBuffer,
                  geometry: productionCorpus.independentOracle.geometry,
                  cursor: productionCorpus.independentOracle.cursor,
                  savedCursor: productionCorpus.independentOracle.savedCursor,
                  modes: productionCorpus.independentOracle.modes,
                  lineFingerprints: expect.any(Array),
                }),
                exact: true,
              }
            : {
                mode: 'bounded-page-streaming-range',
                required: false,
                fullCellObjectMaterializationCount: 0,
                exact: true,
              },
          browserBoundaryOracle: {
            before: {
              first: productionCorpus.independentOracle.firstLine,
              last: productionCorpus.independentOracle.lastLine,
            },
            after: {
              first: productionCorpus.independentOracle.firstLine,
              last: productionCorpus.independentOracle.lastLine,
            },
            expected: {
              first: productionCorpus.independentOracle.firstLine,
              last: productionCorpus.independentOracle.lastLine,
            },
          },
          newestMarkerRendered: true,
          tail: {
            marker: configuredTail.marker,
            deterministicInput: productionCorpus.deterministicTail,
            independentPostTailExpectedState: productionCorpus.postTailIndependentOracle,
            commandEchoSafe: true,
            routedOutputObserved: true,
            rendered: true,
            promptSettled: false,
            settlementMode: 'dispatch-output-quiescence',
            deliverySettled: true,
            sourceSequences: expect.arrayContaining([expect.stringMatching(/^(0|[1-9]\d*)$/u)]),
            allSourceSequencesAfterSnapshot: true,
            checkpointDrainAckValid: true,
            quiescence: {
              captureMode: 'streaming',
              stable: true,
              firstDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
              secondDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            },
            streamingState: {
              available: true,
              evidence: productionCorpus.postTailIndependentOracle,
            },
            dispatchEvidence: expect.objectContaining({
              httpStatus: 202,
              accepted: true,
              source: 'server-test-isolation',
              testContract: expect.objectContaining({
                deterministicPostSnapshotTail: expect.objectContaining({
                  accepted: true,
                  action: 'inject-authoritative-output-after-checkpoint-drain',
                  decodedBytes: productionCorpus.deterministicTail.decodedBytes,
                  sha256: productionCorpus.deterministicTail.sha256,
                  expectedLiteralMarker: productionCorpus.deterministicTail.data,
                  echoSource: 'server-test-isolation-no-shell-command',
                }),
              }),
            }),
            transition: {
              preTailMatchesIndependentExpected: true,
              postTailMatchesIndependentExpected: true,
              expectedStateChanged: true,
              actualStateChanged: true,
              orderedLogicalTransitionExact: true,
              orderedCellTransitionExact: true,
              cursorTransitionExact: true,
              stableFieldsExact: true,
            },
          },
          zeroAttachedRecovery: {
            marker: zeroAttachedMarker,
            zeroAttachedAuditObserved: true,
            baseline: {
              authoritativeModelInstanceId: expect.stringMatching(/^headless:/u),
              sourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              attachedResponderViewCount: 0,
              auditIdentities: expect.any(Array),
            },
            retainedAuditRecord: expect.objectContaining({
              type: 'server-output-retained-without-attached-view',
              sourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
              outputDataSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              outputByteLength: Buffer.byteLength(`${zeroAttachedMarker}\r\n`, 'utf8'),
            }),
            zeroAttachedOutputIdentityMatch: true,
            retainedDuringContinuousZeroView: true,
            sourceSeqAfterBaseline: true,
            boundaryContinuity: expect.objectContaining({
              preDetachFullStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              postAttachFullStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              retainedLineCountStable: true,
              oldestBoundaryEvicted: expect.any(Boolean),
              newestBoundaryAppended: expect.any(Boolean),
              fullStateChanged: true,
              checkpointContainsDetachedPtyMarker: true,
              sourceSeqAdvanced: true,
              overlapContract: 'ph005-retained-overlap-v1',
              overlapContractValid: true,
              preDetachOverlapShifts: expect.arrayContaining([
                expect.objectContaining({
                  shiftLines: expect.any(Number),
                  suffixSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                }),
              ]),
              postAttachOverlapShifts: expect.arrayContaining([
                expect.objectContaining({
                  shiftLines: expect.any(Number),
                  prefixSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                }),
              ]),
              matchingShiftLines: expect.any(Array),
              exactOverlapMatchCount: expect.any(Number),
              continuityKind: expect.stringMatching(/^(shifted|in-place)-retained-range$/u),
              fullRetainedOverlapProven: true,
            }),
            frameStart: expect.any(Number),
            firstReplacementMarkerRendered: true,
            zeroAttachedFullRetainedStateParity: true,
            firstReplacementFullStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            secondReplacementFullStateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            zeroAttachedReplacementCheckpoint: expect.objectContaining({
              transactionValidation: expect.objectContaining({
                retainedStateDigestValid: true,
                applyAckValid: true,
                drainAckValid: true,
                settled: true,
              }),
            }),
            parityCheckpoint: expect.objectContaining({
              transactionValidation: expect.objectContaining({
                retainedStateDigestValid: true,
                applyAckValid: true,
                drainAckValid: true,
                settled: true,
              }),
            }),
          },
          cleanup: expectedCleanup(configuredPreparation),
          postCleanupInventory: expect.objectContaining({
            httpStatus: 200,
            mode: 'legacy',
            source: 'server-test-isolation-inventory',
            inspectedSessionId: sessionId,
            isolationLeaseAcquired: false,
            resourceInventory: expectedZeroIsolationResourceInventory(),
          }),
        },
        partialEscapeRound: {
          preparation: expect.objectContaining({
            httpStatus: 200,
            mode: 'server',
            testContract: expect.objectContaining({
              retainedCorpusInjection: expect.objectContaining({
                accepted: true,
                action: 'inject-authoritative-raw-output-after-promotion',
              }),
            }),
          }),
          inventory: expect.objectContaining({ scenario: 'absent' }),
          checkpoint: expect.objectContaining({
            transactionValidation: expect.objectContaining({
              parserTailEnvelopeValid: true,
              retainedStateDigestValid: true,
              settled: true,
            }),
          }),
          parserTailRecovery: {
            exactNonEmptyParserTail: true,
            prefixSha256: createHash('sha256')
              .update(Buffer.from(partialEscapeContract.parserTailPrefix, 'utf8'))
              .digest('hex'),
            expectedPrefixSha256: createHash('sha256')
              .update(Buffer.from(partialEscapeContract.parserTailPrefix, 'utf8'))
              .digest('hex'),
            routedMarkerCount: 1,
            renderedMarkerCount: 1,
            unconsumedSuffixLiteralVisible: false,
            recoveredSemanticLinePresent: true,
            unconsumedSuffixSemanticLineAbsent: true,
            tail: expect.objectContaining({
              marker: partialEscapeContract.visibleMarker,
              commandEchoSafe: true,
              routedOutputObserved: true,
              rendered: true,
              promptSettled: false,
              settlementMode: 'dispatch-output-quiescence',
              deliverySettled: true,
              allSourceSequencesAfterSnapshot: true,
              checkpointDrainAckValid: true,
            }),
          },
          cleanup: expectedCleanup(partialEscapePreparation),
          postCleanupInventory: expect.objectContaining({
            httpStatus: 200,
            mode: 'legacy',
            source: 'server-test-isolation-inventory',
            isolationLeaseAcquired: false,
            resourceInventory: expectedZeroIsolationResourceInventory(),
          }),
        },
        alternateRound: {
          preparation: expect.objectContaining({
            httpStatus: 200,
            mode: 'server',
            testContract: expect.objectContaining({
              retainedCorpusInjection: expect.objectContaining({
                accepted: true,
                activeBuffer: 'alternate',
                savedCursor: 'present-normal-buffer',
              }),
            }),
          }),
          fixtureAccepted: true,
          markerRendered: true,
          inventory: {
            scenario: 'absent',
            actualSources: expectedActualCacheSources,
            defensiveSurfaces: expectedDefensiveCacheSurfaces,
            entries: expectedCacheEntries('absent'),
            payloadContract: expectedPayloadContract('absent'),
            inventoryEvidence: {
              ...staticCacheInventory,
              debugSurfaceKeys: expect.arrayContaining(['captureRetainedState']),
            },
          },
          activeBuffers: { before: 'alternate', after: 'alternate' },
          restore: { before: comparable(beforeAlternate), after: comparable(beforeAlternate) },
          checkpoint: expectedCheckpoint(beforeAlternate, 'alternate', alternatePreparation),
          independentBufferOracle: {
            payloadDecoded: true,
            normalMarkerPresent: true,
            alternateMarkerPresent: true,
            activeBuffer: 'alternate',
            activeBufferMatches: true,
            savedCursorRoundTripPresent: true,
            cursorRoundTrip: {
              saveCount: expect.any(Number),
              restoreCount: expect.any(Number),
              restoredCursor: {
                x: alternateSavedCursorExpectation().x,
                y: alternateSavedCursorExpectation().y,
              },
              restoredCell: alternateSavedCursorExpectation().cell,
              expected: alternateSavedCursorExpectation(),
              valid: true,
            },
            metadataIndependent: true,
          },
          cleanup: expectedCleanup(alternatePreparation),
          postCleanupInventory: expect.objectContaining({
            httpStatus: 200,
            mode: 'legacy',
            source: 'server-test-isolation-inventory',
            inspectedSessionId: sessionId,
            isolationLeaseAcquired: false,
            resourceInventory: expectedZeroIsolationResourceInventory(),
          }),
          tail: {
            marker: alternateTail.marker,
            commandEchoSafe: true,
            routedOutputObserved: true,
            rendered: true,
            promptSettled: false,
            settlementMode: 'dispatch-output-quiescence',
            deliverySettled: true,
            sourceSequences: expect.arrayContaining([expect.stringMatching(/^(0|[1-9]\d*)$/u)]),
            allSourceSequencesAfterSnapshot: true,
          },
        },
        freshSessionBaseline: expect.objectContaining({
          httpStatus: 200,
          mode: 'legacy',
          source: 'server-test-isolation-inventory',
          isolationLeaseAcquired: false,
          resourceInventory: expectedZeroIsolationResourceInventory(),
        }),
      });
    } catch (error) {
      bodyFailure = error;
    } finally {
      try {
        await runCleanupTasks('poisoned no-cache reload', [
          {
            name: 'attach-preparation-operation-ledger',
            run: () => testInfo.attach('ph005-preparation-operation-ledger', {
              body: Buffer.from(JSON.stringify(preparationOperationLedger), 'utf8'),
              contentType: 'application/json',
            }),
          },
          {
            name: 'restore-app-origin',
            run: async () => {
              if (page.url().startsWith('about:')) await page.goto('/');
            },
          },
          {
            name: 'restore-authority-isolation',
            run: () => cleanupServerAuthorityTestState(page, sessionId, preparation, harness),
          },
          {
            name: 'delete-zero-attached-trigger',
            run: () => {
              if (existsSync(zeroAttachedTriggerPath)) unlinkSync(zeroAttachedTriggerPath);
            },
          },
          ...(freshBaselineSessionId
            ? [{
                name: 'delete-fresh-baseline-session',
                run: () => deleteOwnedSession(page, freshBaselineSessionId!),
              }]
            : []),
        ]);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (bodyFailure && cleanupFailure) {
      throw new Error(
        `poisoned no-cache reload body failed: ${bodyFailure instanceof Error ? bodyFailure.message : String(bodyFailure)}; `
        + `cleanup also failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`,
        { cause: cleanupFailure },
      );
    }
    if (bodyFailure) throw bodyFailure;
    if (cleanupFailure) throw cleanupFailure;
  });

  test('compatibility-drain rollback', async ({ page, context }) => {
    const harness = new RoutedWebSocketHarness();
    const first = await bootLiveTerminal(page, harness);
    const peer = await context.newPage();
    let second: LiveTerminal | null = null;
    let unblockDrainAcks = () => {};
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    try {
      await page.evaluate(async (sessionId) => {
        await window.__buildergateTerminalDebug?.start(sessionId);
      }, first.sessionId);
      second = await bootAuthenticatedPeer(peer, harness);
      const peerLive = second;
      await peer.evaluate(async (sessionId) => {
        await window.__buildergateTerminalDebug?.start(sessionId);
      }, first.sessionId);
      expect(peerLive.sessionId, 'rollback requires two actual views of one session').toBe(first.sessionId);
      preparation = await prepareServerAuthorityTestState(page, first.sessionId, 'server');
      if (preparation.httpStatus !== 200
        || typeof preparation.cleanupToken !== 'string'
        || typeof preparation.isolationLeaseId !== 'string') {
        throw new Error(`compatibility rollback preparation failed: ${JSON.stringify(preparation)}`);
      }
      const committedBeforeBoundaryMarker = `PH005-ROLLBACK-COMMITTED-${Date.now()}`;
      const committedOutputBoundary = harness.frames.length - 1;
      await sendVisibleTerminalCommand(page, first.sessionId, buildEchoSafeMarkerCommand(committedBeforeBoundaryMarker));
      const committedDeadline = Date.now() + 8_000;
      let committedOutputFrames: CapturedFrame[] = [];
      while (Date.now() < committedDeadline) {
        committedOutputFrames = harness.matching(
          'server-to-page',
          message => message.type === 'terminal-checkpoint:output'
            && message.sessionId === first.sessionId,
          { generation: first.generation, afterIndex: committedOutputBoundary },
        ).filter(frame => frame.origin === 'routed-server');
        if (committedOutputFrames.map(frame => decodedTerminalOutput(frame.message!)).join('')
          .includes(committedBeforeBoundaryMarker)) break;
        await page.waitForTimeout(25);
      }
      const committedOutputText = committedOutputFrames
        .map(frame => decodedTerminalOutput(frame.message!))
        .join('');
      const committedOutputSourceSeqs = committedOutputFrames
        .map(frame => frame.message?.sourceSeq)
        .filter((value): value is string => isCanonicalOrdinal(value));
      const committedMarkerRendered = committedOutputText.includes(committedBeforeBoundaryMarker)
        && await observeRenderedMarker(page, committedBeforeBoundaryMarker);
      const committedMarkerFramesAllViews = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-checkpoint:output'
          && message.sessionId === first.sessionId
          && decodedTerminalOutput(message).includes(committedBeforeBoundaryMarker),
        { afterIndex: committedOutputBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const rollbackTailMarker = `PH005-ROLLBACK-HELD-TAIL-${Date.now()}`;
      const rollbackTailPayload = Buffer.from(`${rollbackTailMarker}\r\n`, 'utf8');
      const rollbackTailContract = {
        contractVersion: 1,
        postBoundaryOutputInjection: {
          action: 'inject-authoritative-raw-output-after-rollback-boundary',
          deliveryPhase: 'after-checkpoint-commit-before-compatibility-drain-ack',
          encoding: 'base64',
          data: rollbackTailPayload.toString('base64'),
          decodedBytes: rollbackTailPayload.byteLength,
          sha256: createHash('sha256').update(rollbackTailPayload).digest('hex'),
          expectedMarker: rollbackTailMarker,
        },
      };
      const rollbackGenerations = new Set([first.generation, peerLive.generation]);
      unblockDrainAcks = harness.blockPageToServer((message, generation) => (
        rollbackGenerations.has(generation)
        && message.type === 'terminal-authority:compatibility-drained'
        && message.sessionId === first.sessionId
      ));
      const rollbackFrameBoundary = harness.frames.length - 1;
      const trigger = await triggerServerAuthorityRollback(page, first.sessionId, rollbackTailContract);
      if (trigger.httpStatus !== 202 || trigger.accepted !== true) {
        throw new Error(`compatibility rollback trigger failed: ${JSON.stringify(trigger)}`);
      }
      const blockedDeadline = Date.now() + 2_000;
      while (Date.now() < blockedDeadline) {
        const blockedGenerations = new Set(harness.blockedPageToServerFrames
          .filter(frame => frame.message?.type === 'terminal-authority:compatibility-drained'
            && frame.message.sessionId === first.sessionId)
          .map(frame => frame.generation));
        if ([...rollbackGenerations].every(generation => blockedGenerations.has(generation))) break;
        await page.waitForTimeout(25);
      }
      let rollbackStarts = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:rollback-start'
          && message.sessionId === first.sessionId,
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => frame.origin === 'routed-server').sort((left, right) => (
        Number(left.message?.viewGeneration ?? -1) - Number(right.message?.viewGeneration ?? -1)
      ));
      let transitionEpoch = rollbackStarts[0]?.message?.transitionEpoch;
      let authorityEpoch = rollbackStarts[0]?.message?.authorityEpoch;
      let streamEpoch = rollbackStarts[0]?.message?.streamEpoch;
      let responderLeaseId = rollbackStarts[0]?.message?.responderLeaseId;
      let boundarySourceSeq = rollbackStarts[0]?.message?.boundarySourceSeq;
      let checkpointEpoch = rollbackStarts[0]?.message?.checkpointEpoch;
      let drainedThroughSourceSeq = rollbackStarts[0]?.message?.drainedThroughSourceSeq;
      const acceptedDrainAcksBeforeRelease = harness.matching(
        'page-to-server',
        message => message.type === 'terminal-authority:compatibility-drained'
          && message.sessionId === first.sessionId,
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => !harness.blockedPageToServerFrames.includes(frame));
      const blockedDrainAcks = [first.generation, peerLive.generation].map(generation => (
        harness.blockedPageToServerFrames.find(frame => (
        frame.generation === generation
        && frame.message?.type === 'terminal-authority:compatibility-drained'
        && frame.message.sessionId === first.sessionId
        )) ?? null
      ));
      const earlyEnable = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:legacy-responder-enabled'
          && message.sessionId === first.sessionId,
        { afterIndex: rollbackFrameBoundary },
      );
      const preReleaseBoundary = harness.frames.length - 1;
      injectOutput(harness, first, QUERY_DA1, { source: 'ph005-pre-all-view-drain-query' });
      await page.waitForTimeout(25);
      const prematureReplies = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === first.sessionId
          && message.data === REPLY_DA1,
        { afterIndex: preReleaseBoundary },
      );

      unblockDrainAcks();
      const releasedDrainAckIndices: number[] = [];
      for (const blockedAck of blockedDrainAcks) {
        if (blockedAck?.message) releasedDrainAckIndices.push(harness.releaseBlockedFrame(blockedAck));
      }
      try {
        await expect.poll(() => {
          const receipts = harness.matching(
            'server-to-page',
            message => message.type === 'terminal-authority:compatibility-drain-accepted'
              && message.sessionId === first.sessionId
              && message.accepted === true,
            { afterIndex: rollbackFrameBoundary },
          ).filter(frame => frame.origin === 'routed-server').length;
          const enables = harness.matching(
            'server-to-page',
            message => message.type === 'terminal-authority:legacy-responder-enabled'
              && message.sessionId === first.sessionId
              && message.source === 'server-controller',
            { afterIndex: rollbackFrameBoundary },
          ).filter(frame => frame.origin === 'routed-server').length;
          return receipts >= 1 && enables === 1;
        }, {
          message: 'released all-view drain ACKs did not settle receipts and selected legacy enable',
          timeout: 20_000,
        }).toBe(true);
      } catch (error) {
        const transactionFrames = harness.frames.slice(rollbackFrameBoundary + 1)
          .map((frame, offset) => ({ frame, index: rollbackFrameBoundary + 1 + offset }))
          .filter(({ frame }) => frame.message?.sessionId === first.sessionId
            && [
              'terminal-authority:rollback-start',
              'terminal-authority:compatibility-drained',
              'terminal-authority:compatibility-drain-accepted',
              'terminal-authority:legacy-responder-enabled',
            ].includes(frame.message.type ?? ''))
          .map(({ frame, index }) => ({
            index,
            direction: frame.direction,
            generation: frame.generation,
            origin: frame.origin,
            type: frame.message?.type,
            source: frame.message?.source,
            accepted: frame.message?.accepted,
            completed: frame.message?.completed,
            reason: frame.message?.reason,
            connectionId: frame.message?.connectionId,
            viewGeneration: frame.message?.viewGeneration,
            transitionEpoch: frame.message?.transitionEpoch,
            drainedThroughSourceSeq: frame.message?.drainedThroughSourceSeq,
          }));
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; `
          + `transactionFrames=${JSON.stringify(transactionFrames)}`,
        );
      }
      const finalLegacyEnables = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:legacy-responder-enabled'
          && message.sessionId === first.sessionId
          && message.source === 'server-controller',
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const settledEnable = finalLegacyEnables.at(-1);
      transitionEpoch = settledEnable?.message?.transitionEpoch;
      rollbackStarts = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:rollback-start'
          && message.sessionId === first.sessionId
          && message.transitionEpoch === transitionEpoch,
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const settledRollbackIdentity = rollbackStarts[0]?.message;
      authorityEpoch = settledRollbackIdentity?.authorityEpoch;
      streamEpoch = settledRollbackIdentity?.streamEpoch;
      responderLeaseId = settledRollbackIdentity?.responderLeaseId;
      boundarySourceSeq = settledRollbackIdentity?.boundarySourceSeq;
      checkpointEpoch = settledRollbackIdentity?.checkpointEpoch;
      drainedThroughSourceSeq = settledRollbackIdentity?.drainedThroughSourceSeq;
      if (!drainedThroughSourceSeq) {
        drainedThroughSourceSeq = settledEnable?.message?.drainedThroughSourceSeq;
      }
      const acceptedDrainReceipts = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:compatibility-drain-accepted'
          && message.sessionId === first.sessionId
          && message.accepted === true
          && message.transitionEpoch === transitionEpoch,
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const acceptedDrainAcks = harness.frames
        .map((frame, index) => ({ frame, index }))
        .filter(({ frame, index }) => (
          index > rollbackFrameBoundary
          &&
          frame.direction === 'page-to-server'
          && !harness.blockedPageToServerFrames.includes(frame)
          && frame.message?.type === 'terminal-authority:compatibility-drained'
          && frame.message.sessionId === first.sessionId
          && frame.message.transitionEpoch === transitionEpoch
        ));
      const lastAcceptedDrainAckIndex = Math.max(-1, ...acceptedDrainAcks.map(({ index }) => index));
      const settledRollbackGenerations = [...new Set(rollbackStarts.map(frame => frame.generation))];
      const selectedDriverGenerationValue = settledEnable?.generation ?? -1;
      const rollbackFrameOrder = settledRollbackGenerations.map((generation) => {
        const findIndex = (
          direction: CapturedFrame['direction'],
          type: string,
          afterIndex = -1,
        ): number => harness.frames.findIndex((frame, index) => (
          index > afterIndex
          && frame.generation === generation
          && frame.direction === direction
          && frame.message?.type === type
          && frame.message.sessionId === first.sessionId
          && frame.message.transitionEpoch === transitionEpoch
        ));
        const rollbackStartIndex = findIndex('server-to-page', 'terminal-authority:rollback-start');
        const checkpointStartIndex = findIndex('server-to-page', 'terminal-checkpoint:start', rollbackStartIndex);
        const checkpointCommitIndex = findIndex('server-to-page', 'terminal-checkpoint:commit', checkpointStartIndex);
        const checkpointChunkFrames = harness.frames.filter((frame, index) => (
          index > checkpointStartIndex
          && index < checkpointCommitIndex
          && frame.generation === generation
          && frame.direction === 'server-to-page'
          && frame.message?.type === 'terminal-checkpoint:chunk'
          && frame.message.sessionId === first.sessionId
        ));
        const rollbackStartMessage = harness.frames[rollbackStartIndex]?.message ?? null;
        const checkpointStartMessage = harness.frames[checkpointStartIndex]?.message ?? null;
        const checkpointCommitMessage = harness.frames[checkpointCommitIndex]?.message ?? null;
        const fullRollbackIdentityKeys = [
          'sessionId',
          'connectionId',
          'viewGeneration',
          'transitionEpoch',
          'authorityEpoch',
          'streamEpoch',
          'responderLeaseId',
          'boundarySourceSeq',
          'checkpointEpoch',
        ] as const;
        const fullRollbackIdentity = rollbackStartMessage
          ? Object.fromEntries(fullRollbackIdentityKeys.map(key => [key, rollbackStartMessage[key]]))
          : null;
        const hasFullRollbackIdentity = (message: JsonFrame | null): boolean => (
          message !== null
          && fullRollbackIdentity !== null
          && fullRollbackIdentityKeys.every(key => message[key] === fullRollbackIdentity[key])
        );
        const decodedCheckpointChunks = checkpointChunkFrames
          .map(frame => frame.message && decodedCheckpointPayload(frame.message));
        const checkpointPayloadBytes = decodedCheckpointChunks.every(chunk => chunk !== null)
          ? Buffer.concat(decodedCheckpointChunks as Buffer[])
          : null;
        const declaredDigest = checkpointStartMessage?.digest
          && typeof checkpointStartMessage.digest === 'object'
          ? (checkpointStartMessage.digest as Record<string, unknown>).hex
          : typeof checkpointStartMessage?.contentDigest === 'string'
            ? checkpointStartMessage.contentDigest.replace(/^sha256:/u, '')
            : null;
        const commitDigest = checkpointCommitMessage?.digest
          && typeof checkpointCommitMessage.digest === 'object'
          ? (checkpointCommitMessage.digest as Record<string, unknown>).hex
          : typeof checkpointCommitMessage?.contentDigest === 'string'
            ? checkpointCommitMessage.contentDigest.replace(/^sha256:/u, '')
            : null;
        const computedDigest = checkpointPayloadBytes
          ? createHash('sha256').update(checkpointPayloadBytes).digest('hex')
          : null;
        const checkpointChunkCount = Number(checkpointStartMessage?.chunkCount);
        const startDigestAlgorithm = checkpointStartMessage?.digest
          && typeof checkpointStartMessage.digest === 'object'
          ? (checkpointStartMessage.digest as Record<string, unknown>).algorithm
          : null;
        const commitDigestAlgorithm = checkpointCommitMessage?.digest
          && typeof checkpointCommitMessage.digest === 'object'
          ? (checkpointCommitMessage.digest as Record<string, unknown>).algorithm
          : null;
        const checkpointEncodedByteTotal = checkpointPayloadBytes?.byteLength ?? -1;
        const checkpointChunkByteMetadataExact = decodedCheckpointChunks.every((chunk, index) => (
          chunk !== null
          && Number.isSafeInteger(checkpointChunkFrames[index]?.message?.encodedBytes)
          && checkpointChunkFrames[index]?.message?.encodedBytes === chunk.byteLength
        ));
        const checkpointDigestAndChunksExact = Number.isSafeInteger(checkpointChunkCount)
          && checkpointChunkCount > 0
          && checkpointChunkFrames.length === checkpointChunkCount
          && checkpointChunkFrames.every((frame, index) => (
            frame.message?.chunkIndex === index
            && frame.message.chunkCount === checkpointChunkCount
            && hasFullRollbackIdentity(frame.message)
          ))
          && startDigestAlgorithm === 'sha256'
          && commitDigestAlgorithm === 'sha256'
          && checkpointChunkByteMetadataExact
          && checkpointStartMessage?.encodedByteTotal === checkpointEncodedByteTotal
          && checkpointCommitMessage?.encodedByteTotal === checkpointEncodedByteTotal
          && declaredDigest === computedDigest
          && commitDigest === computedDigest
          && checkpointCommitMessage?.chunkCount === checkpointChunkCount;
        const checkpointPayloadText = checkpointChunkFrames
          .map(frame => decodedTerminalOutput(frame.message!))
          .join('');
        const checkpointPayloadContainsRollbackTail = checkpointPayloadText.includes(rollbackTailMarker);
        const acceptedDrainAckIndex = acceptedDrainAcks.find(({ frame }) => frame.generation === generation)?.index ?? -1;
        const checkpointApplyAckIndex = findIndex('page-to-server', 'terminal-checkpoint:apply-ack', checkpointCommitIndex);
        const checkpointDrainAckIndex = findIndex('page-to-server', 'terminal-checkpoint:drain-ack', checkpointApplyAckIndex);
        const acceptedDrainReceiptIndex = findIndex(
          'server-to-page',
          'terminal-authority:compatibility-drain-accepted',
          acceptedDrainAckIndex,
        );
        const checkpointTailFrames = harness.frames
          .map((frame, index) => ({ frame, index }))
          .filter(({ frame, index }) => (
            index > checkpointCommitIndex
            && (acceptedDrainAckIndex < 0 || index < acceptedDrainAckIndex)
            && frame.generation === generation
            && frame.direction === 'server-to-page'
            && frame.message?.type === 'terminal-checkpoint:output'
            && frame.message.sessionId === first.sessionId
          ));
        const checkpointTailIndex = checkpointTailFrames[0]?.index ?? -1;
        const checkpointTailText = checkpointTailFrames.map(({ frame }) => {
          const data = typeof frame.message?.data === 'string' ? frame.message.data : '';
          return frame.message?.encoding === 'base64'
            ? Buffer.from(data, 'base64').toString('utf8')
            : data;
        }).join('');
        const checkpointTailSourceSeqs = checkpointTailFrames
          .map(({ frame }) => frame.message?.sourceSeq)
          .filter((value): value is string => isCanonicalOrdinal(value));
        const legacyEnableIndex = findIndex('server-to-page', 'terminal-authority:legacy-responder-enabled', checkpointTailIndex);
        const selectedDriverGeneration = generation === selectedDriverGenerationValue;
        const legacyEnableMessage = harness.frames[legacyEnableIndex]?.message ?? null;
        const checkpointLaneFrames = harness.frames.filter((frame, index) => (
          index >= checkpointStartIndex
          && index <= checkpointCommitIndex
          && frame.generation === generation
          && frame.direction === 'server-to-page'
          && frame.message?.sessionId === first.sessionId
        ));
        const checkpointLaneTypes = [
          'terminal-checkpoint:start',
          ...Array.from(
            { length: Number.isSafeInteger(checkpointChunkCount) ? checkpointChunkCount : 0 },
            () => 'terminal-checkpoint:chunk',
          ),
          'terminal-checkpoint:commit',
        ];
        const checkpointLaneInterleavings = checkpointLaneFrames.filter(frame => (
          frame.origin !== 'routed-server'
          || frame.message === null
          || frame.message.sessionId !== first.sessionId
          || !hasFullRollbackIdentity(frame.message)
          || !['terminal-checkpoint:start', 'terminal-checkpoint:chunk', 'terminal-checkpoint:commit']
            .includes(frame.message.type ?? '')
        )).length;
        const checkpointLaneExact = checkpointLaneInterleavings === 0
          && JSON.stringify(checkpointLaneFrames.map(frame => frame.message?.type))
            === JSON.stringify(checkpointLaneTypes);
        const transactionIdentityMessages = [
          harness.frames[checkpointStartIndex]?.message ?? null,
          ...checkpointChunkFrames.map(frame => frame.message),
          harness.frames[checkpointCommitIndex]?.message ?? null,
          harness.frames[checkpointApplyAckIndex]?.message ?? null,
          harness.frames[checkpointDrainAckIndex]?.message ?? null,
          harness.frames[acceptedDrainAckIndex]?.message ?? null,
          harness.frames[acceptedDrainReceiptIndex]?.message ?? null,
        ];
        if (selectedDriverGeneration) transactionIdentityMessages.push(legacyEnableMessage);
        const fullTransactionIdentityExact = transactionIdentityMessages
          .every(message => hasFullRollbackIdentity(message));
        const selectedDriverLeaseExact = !selectedDriverGeneration || (
          legacyEnableMessage !== null
          && typeof legacyEnableMessage.driverLeaseId === 'string'
          && legacyEnableMessage.driverLeaseId.length > 0
          && isCanonicalOrdinal(legacyEnableMessage.driverLeaseGeneration)
          && legacyEnableMessage.responderLeaseId === responderLeaseId
        );
        const enablePolicyExact = selectedDriverGeneration
          ? legacyEnableIndex > lastAcceptedDrainAckIndex
          : legacyEnableIndex === -1;
        return {
          generation,
          rollbackStartIndex,
          checkpointStartIndex,
          checkpointCommitIndex,
          checkpointApplyAckIndex,
          checkpointDrainAckIndex,
          checkpointPayloadContainsCommittedMarker: checkpointPayloadText.includes(committedBeforeBoundaryMarker),
          checkpointPayloadContainsRollbackTail,
          checkpointTailIndex,
          checkpointTailContainsMarker: checkpointTailText.includes(rollbackTailMarker),
          checkpointTailSourceSeqs,
          checkpointTailAfterBoundary: isCanonicalOrdinal(boundarySourceSeq)
            && checkpointTailSourceSeqs.length > 0
            && checkpointTailSourceSeqs.every(value => BigInt(value) > BigInt(boundarySourceSeq as string)),
          acceptedDrainAckIndex,
          acceptedDrainReceiptIndex,
          legacyEnableIndex,
          selectedDriverGeneration,
          fullRollbackIdentity,
          checkpointDigestAlgorithms: {
            start: startDigestAlgorithm,
            commit: commitDigestAlgorithm,
          },
          checkpointEncodedByteTotal,
          checkpointChunkByteMetadataExact,
          checkpointDigestAndChunksExact,
          checkpointLaneInterleavings,
          checkpointLaneExact,
          fullTransactionIdentityExact,
          selectedDriverLeaseExact,
          enablePolicyExact,
          valid: rollbackStartIndex >= 0
            && rollbackStartIndex < checkpointStartIndex
            && checkpointStartIndex < checkpointCommitIndex
            && checkpointDigestAndChunksExact
            && checkpointLaneExact
            && checkpointCommitIndex < checkpointApplyAckIndex
            && checkpointApplyAckIndex <= checkpointDrainAckIndex
            && checkpointPayloadText.includes(committedBeforeBoundaryMarker)
            && (checkpointPayloadContainsRollbackTail || (
              checkpointCommitIndex < checkpointTailIndex
              && checkpointTailText.includes(rollbackTailMarker)
              && isCanonicalOrdinal(boundarySourceSeq)
              && checkpointTailSourceSeqs.length > 0
              && checkpointTailSourceSeqs.every(value => BigInt(value) > BigInt(boundarySourceSeq as string))
              && checkpointTailIndex < acceptedDrainAckIndex
            ))
            && acceptedDrainAckIndex < acceptedDrainReceiptIndex
            && acceptedDrainAckIndex <= lastAcceptedDrainAckIndex
            && enablePolicyExact
            && fullTransactionIdentityExact
            && selectedDriverLeaseExact,
        };
      });
      const postReleaseBoundary = harness.frames.length - 1;
      const selectedQueryEnable = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:legacy-responder-enabled'
          && message.sessionId === first.sessionId,
        { afterIndex: rollbackFrameBoundary },
      ).filter(frame => frame.origin === 'routed-server').at(-1) ?? settledEnable;
      const selectedQueryGeneration = selectedQueryEnable?.generation ?? selectedDriverGenerationValue;
      const selectedQueryPage = harness.ownerForGeneration(selectedQueryGeneration);
      if (!selectedQueryPage) {
        throw new Error(`selected compatibility responder page missing for generation ${selectedQueryGeneration}`);
      }
      await waitForVisibleTerminalInputReady(selectedQueryPage, first.sessionId);
      await sendVisibleTerminalCommand(
        selectedQueryPage,
        first.sessionId,
        buildEchoSafeMarkerCommand('', QUERY_DA1),
        { normalizeVisiblePrompt: false },
      );
      await page.waitForTimeout(1_000);
      const selectedDriverReplies = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === first.sessionId
          && message.data === REPLY_DA1,
        { generation: selectedQueryGeneration, afterIndex: postReleaseBoundary },
      ).filter(frame => frame.origin === 'routed-page');
      const peerReplies = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === first.sessionId
          && message.data === REPLY_DA1,
        { afterIndex: postReleaseBoundary },
      ).filter(frame => frame.origin === 'routed-page' && frame.generation !== selectedQueryGeneration);
      const routedQueryBroadcastGenerations = [...new Set(harness.matching(
        'server-to-page',
        message => ['output', 'terminal-checkpoint:output'].includes(message.type ?? '')
          && message.sessionId === first.sessionId
          && decodedTerminalOutput(message).includes(QUERY_DA1),
        { afterIndex: postReleaseBoundary },
      ).filter(frame => frame.origin === 'routed-server').map(frame => frame.generation))].sort((a, b) => a - b);
      const selectedQueryAcceptances = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:query-reply-accepted'
          && message.sessionId === first.sessionId
          && sameResponderIdentity(
            message.responderIdentity,
            selectedDriverReplies[0]?.message?.responderIdentity,
          ),
        { afterIndex: postReleaseBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const peerQueryAcceptances = harness.matching(
        'server-to-page',
        message => message.type === 'terminal-authority:query-reply-accepted'
          && message.sessionId === first.sessionId
          && sameResponderIdentity(message.responderIdentity, peerReplies[0]?.message?.responderIdentity),
        { afterIndex: postReleaseBoundary },
      ).filter(frame => frame.origin === 'routed-server');
      const compositeIdentitySet = (frames: CapturedFrame[]): string[] => [...new Set(frames.map(frame => (
        `${String(frame.message?.connectionId ?? '')}\u0000${String(frame.message?.viewGeneration ?? '')}`
      )))].sort();
      const committedMarkerCompositeSet = compositeIdentitySet(committedMarkerFramesAllViews);
      const rollbackStartCompositeSet = compositeIdentitySet(rollbackStarts);
      const drainAckCompositeSet = compositeIdentitySet(
        acceptedDrainAcks.map(({ frame }) => frame),
      );
      const drainReceiptCompositeSet = compositeIdentitySet(acceptedDrainReceipts);
      const legacyEnableCompositeSet = compositeIdentitySet(finalLegacyEnables);
      const expectedCompositeSet = compositeIdentitySet(rollbackStarts);
      const selectedDriverCompositeSet = settledEnable
        ? [`${String(settledEnable.message?.connectionId ?? '')}\u0000${String(settledEnable.message?.viewGeneration ?? '')}`]
        : [];
      const compositeIdentitySetsValid = expectedCompositeSet.length >= 1
        && new Set(expectedCompositeSet).size === expectedCompositeSet.length
        && expectedCompositeSet.every(identity => !identity.startsWith('\u0000'))
        && [
          rollbackStartCompositeSet,
          drainAckCompositeSet,
          drainReceiptCompositeSet,
        ].every(actual => JSON.stringify(actual) === JSON.stringify(expectedCompositeSet))
        && JSON.stringify(legacyEnableCompositeSet) === JSON.stringify(selectedDriverCompositeSet);
      const serverPtyQueryEffectCount = selectedQueryAcceptances.reduce((total, frame) => (
        total + Number(frame.message?.ptyWriteCount ?? 0)
      ), 0);
      const invalidCheckpointOrder = rollbackFrameOrder.find(order => (
        !order.checkpointDigestAndChunksExact || !order.checkpointLaneExact
      ));
      if (invalidCheckpointOrder) {
        const checkpointFrames = harness.frames.slice(
          Math.max(0, invalidCheckpointOrder.checkpointStartIndex),
          Math.max(0, invalidCheckpointOrder.checkpointCommitIndex) + 1,
        ).filter(frame => frame.generation === invalidCheckpointOrder.generation).map(frame => ({
          type: frame.message?.type,
          sessionId: frame.message?.sessionId,
          connectionId: frame.message?.connectionId,
          viewGeneration: frame.message?.viewGeneration,
          transitionEpoch: frame.message?.transitionEpoch,
          authorityEpoch: frame.message?.authorityEpoch,
          streamEpoch: frame.message?.streamEpoch,
          responderLeaseId: frame.message?.responderLeaseId,
          boundarySourceSeq: frame.message?.boundarySourceSeq,
          checkpointEpoch: frame.message?.checkpointEpoch,
          chunkIndex: frame.message?.chunkIndex,
          chunkCount: frame.message?.chunkCount,
          encodedBytes: frame.message?.encodedBytes,
        }));
        throw new Error(
          `settled rollback checkpoint wire contract mismatch: ${JSON.stringify({ invalidCheckpointOrder, checkpointFrames })}`,
        );
      }

      expect({
        authorityIsolation: preparation,
        trigger,
        rollbackStartOrigins: rollbackStarts.map(frame => frame.origin),
        rollbackStartViewGenerations: rollbackStarts.map(frame => frame.message?.viewGeneration),
        sameLocalViewGenerationCollision: first.viewGeneration === peerLive.viewGeneration,
        compositeIdentitySets: {
          expected: expectedCompositeSet,
          committedMarker: committedMarkerCompositeSet,
          rollbackStart: rollbackStartCompositeSet,
          drainAck: drainAckCompositeSet,
          drainReceipt: drainReceiptCompositeSet,
          legacyEnable: legacyEnableCompositeSet,
        },
        compositeIdentitySetsValid,
        rollbackIdentity: {
          transitionEpoch,
          authorityEpoch,
          streamEpoch,
          responderLeaseId,
          boundarySourceSeq,
          checkpointEpoch,
          drainedThroughSourceSeq,
        },
        committedBeforeBoundary: {
          markerRendered: committedMarkerRendered,
          routedOutputContainsMarker: committedOutputText.includes(committedBeforeBoundaryMarker),
          sourceSequences: committedOutputSourceSeqs,
          allSourceSequencesAtOrBeforeBoundary: isCanonicalOrdinal(boundarySourceSeq)
            && committedOutputSourceSeqs.length > 0
            && committedOutputSourceSeqs.every(value => BigInt(value) <= BigInt(boundarySourceSeq as string)),
        },
        acceptedDrainAckGenerationsBeforeRelease: acceptedDrainAcksBeforeRelease.map(frame => frame.generation),
        blockedDrainAcks: blockedDrainAcks.map(frame => frame?.message ?? null),
        releasedDrainAckIndices,
        acceptedDrainReceipts: rollbackStarts.map(start => acceptedDrainReceipts.find(frame => (
          frame.message?.connectionId === start.message?.connectionId
          && frame.message?.viewGeneration === start.message?.viewGeneration
        ))?.message ?? null),
        earlyLegacyEnableCount: earlyEnable.length,
        preDrainReplyCount: prematureReplies.length,
        rollbackFrameOrder,
        finalLegacyEnables: finalLegacyEnables.map(frame => frame.message),
        postDrainQuery: {
          routedBroadcastGenerations: routedQueryBroadcastGenerations,
          selectedDriverReplyCount: selectedDriverReplies.length,
          peerReplyCount: peerReplies.length,
          selectedAcceptanceCount: selectedQueryAcceptances.length,
          peerAcceptanceCount: peerQueryAcceptances.length,
          serverPtyQueryEffectCount,
          selectedAcceptance: selectedQueryAcceptances[0]?.message ?? null,
        },
      }, 'MIG-BGSTAB-002 AC-5 compatibility-drain responder barrier is absent').toMatchObject({
        authorityIsolation: {
          httpStatus: 200,
          mode: 'server',
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        },
        trigger: {
          httpStatus: 202,
          accepted: true,
          source: 'server-controller',
          testContract: {
            contractVersion: 1,
            postBoundaryOutputInjection: expect.objectContaining({
              accepted: true,
              action: 'inject-authoritative-raw-output-after-rollback-boundary',
              deliveryPhase: 'after-checkpoint-commit-before-compatibility-drain-ack',
              sha256: rollbackTailContract.postBoundaryOutputInjection.sha256,
              expectedMarker: rollbackTailMarker,
            }),
          },
        },
        rollbackStartOrigins: rollbackStarts.map(() => 'routed-server'),
        rollbackStartViewGenerations: rollbackStarts.map(frame => frame.message?.viewGeneration),
        sameLocalViewGenerationCollision: true,
        compositeIdentitySets: {
          expected: expectedCompositeSet,
          committedMarker: committedMarkerCompositeSet,
          rollbackStart: expectedCompositeSet,
          drainAck: expectedCompositeSet,
          drainReceipt: expectedCompositeSet,
          legacyEnable: selectedDriverCompositeSet,
        },
        compositeIdentitySetsValid: true,
        rollbackIdentity: {
          transitionEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          authorityEpoch: expect.stringMatching(/^.+$/u),
          streamEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          responderLeaseId: expect.any(String),
          boundarySourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          checkpointEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          drainedThroughSourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
        },
        committedBeforeBoundary: {
          markerRendered: true,
          routedOutputContainsMarker: true,
          sourceSequences: expect.arrayContaining([expect.stringMatching(/^(0|[1-9]\d*)$/u)]),
          allSourceSequencesAtOrBeforeBoundary: true,
        },
        blockedDrainAcks: blockedDrainAcks.map(frame => frame?.message ?? null),
        releasedDrainAckIndices: releasedDrainAckIndices.map(() => expect.any(Number)),
        acceptedDrainReceipts: rollbackStarts.map(start => expect.objectContaining({
          type: 'terminal-authority:compatibility-drain-accepted',
          sessionId: first.sessionId,
          connectionId: start.message?.connectionId,
          viewGeneration: start.message?.viewGeneration,
          transitionEpoch,
          authorityEpoch,
          streamEpoch,
          responderLeaseId,
          boundarySourceSeq,
          checkpointEpoch,
          accepted: true,
        })),
        preDrainReplyCount: 0,
        rollbackFrameOrder: settledRollbackGenerations.map(generation => ({
          generation,
          rollbackStartIndex: expect.any(Number),
          checkpointStartIndex: expect.any(Number),
          checkpointCommitIndex: expect.any(Number),
          checkpointApplyAckIndex: expect.any(Number),
          checkpointDrainAckIndex: expect.any(Number),
          checkpointPayloadContainsCommittedMarker: true,
          checkpointPayloadContainsRollbackTail: true,
          acceptedDrainAckIndex: expect.any(Number),
          acceptedDrainReceiptIndex: expect.any(Number),
          legacyEnableIndex: generation === selectedDriverGenerationValue ? expect.any(Number) : -1,
          selectedDriverGeneration: generation === selectedDriverGenerationValue,
          fullRollbackIdentity: expect.objectContaining({
            sessionId: first.sessionId,
            connectionId: expect.stringMatching(/^.+$/u),
            viewGeneration: expect.any(Number),
            transitionEpoch,
            authorityEpoch,
            streamEpoch,
            responderLeaseId,
            boundarySourceSeq,
            checkpointEpoch,
          }),
          checkpointDigestAlgorithms: { start: 'sha256', commit: 'sha256' },
          checkpointEncodedByteTotal: expect.any(Number),
          checkpointChunkByteMetadataExact: true,
          checkpointDigestAndChunksExact: true,
          checkpointLaneInterleavings: 0,
          checkpointLaneExact: true,
          fullTransactionIdentityExact: true,
          selectedDriverLeaseExact: true,
          enablePolicyExact: true,
          valid: true,
        })),
        finalLegacyEnables: [expect.objectContaining({
          type: 'terminal-authority:legacy-responder-enabled',
          source: 'server-controller',
          sessionId: first.sessionId,
          connectionId: expect.stringMatching(/^.+$/u),
          viewGeneration: settledEnable?.message?.viewGeneration,
          transitionEpoch,
          authorityEpoch,
          streamEpoch,
          responderLeaseId,
          driverLeaseId: expect.stringMatching(/^.+$/u),
          driverLeaseGeneration: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          boundarySourceSeq,
          checkpointEpoch,
          checkpointApplied: true,
          postSnapshotTailDrained: true,
        })],
      });
    } finally {
      await runCleanupTasks('compatibility-drain rollback', [
        { name: 'release-drain-ack-blockers', run: unblockDrainAcks },
        {
          name: 'restore-authority-isolation',
          run: () => cleanupServerAuthorityTestState(page, first.sessionId, preparation),
        },
        { name: 'close-peer-page', run: () => peer.close() },
      ]);
    }
  });

  test('stale reconnect no-replay', async ({ page }) => {
    const harness = new RoutedWebSocketHarness();
    let live = await bootLiveTerminal(page, harness);
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    const unblock = harness.blockPageToServer(message => (
      message.type === 'input' && message.sessionId === live.sessionId && message.data === REPLY_DA1
    ));
    try {
      await page.evaluate(async (sessionId) => {
        await window.__buildergateTerminalDebug?.start(sessionId);
      }, live.sessionId);
      const freshPreparationBoundary = harness.frames.length - 1;
      preparation = await prepareServerAuthorityTestState(page, live.sessionId, 'legacy');
      if (preparation.httpStatus !== 200 || preparation.accepted !== true) {
        throw new Error(`fresh legacy preparation failed: ${JSON.stringify(preparation)}`);
      }
      await expect.poll(() => harness.matching(
        'server-to-page',
        message => message.type === 'screen-snapshot' && message.sessionId === live.sessionId,
        { afterIndex: freshPreparationBoundary },
      ).length, {
        timeout: 20_000,
        message: 'fresh compatibility rollback did not publish a replacement snapshot lineage',
      }).toBeGreaterThan(0);
      const settledSnapshotFrame = harness.matching(
        'server-to-page',
        message => message.type === 'screen-snapshot' && message.sessionId === live.sessionId,
        { afterIndex: freshPreparationBoundary },
      ).at(-1)!;
      const settledSnapshot = {
        generation: settledSnapshotFrame.generation,
        snapshot: settledSnapshotFrame.message!,
      };
      await waitForSessionReady(
        harness,
        live.sessionId,
        settledSnapshot.generation,
        settledSnapshot.snapshot.replayToken,
      );
      const settledViewGeneration = await waitForViewGeneration(
        harness,
        live.sessionId,
        settledSnapshot.generation,
        freshPreparationBoundary,
      );
      await waitForAcceptedViewAttributes(
        harness,
        live.sessionId,
        settledSnapshot.generation,
        settledViewGeneration,
        true,
        20_000,
        freshPreparationBoundary,
      );
      live = {
        sessionId: live.sessionId,
        generation: settledSnapshot.generation,
        snapshot: settledSnapshot.snapshot,
        viewGeneration: settledViewGeneration,
      };
      await expect.poll(() => harness.latest(
        'server-to-page',
        message => message.type === 'terminal-authority:legacy-responder-enabled'
          && message.sessionId === live.sessionId
          && message.viewGeneration === live.viewGeneration,
        live.generation,
      ) && harness.frames.findIndex((frame, index) => (
        index > freshPreparationBoundary
        && frame.generation === live.generation
        && frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && frame.message?.type === 'terminal-authority:legacy-responder-enabled'
        && frame.message.sessionId === live.sessionId
        && frame.message.viewGeneration === live.viewGeneration
      )) >= 0 ? 'routed-server' : null, {
        timeout: 10_000,
        message: 'fresh compatibility rollback must settle the selected browser responder lease',
      }).toBe('routed-server');
      const legacyResponderEnabled = harness.latest(
        'server-to-page',
        message => message.type === 'terminal-authority:legacy-responder-enabled'
          && message.sessionId === live.sessionId
          && message.viewGeneration === live.viewGeneration,
        live.generation,
      );
      expect(
        legacyResponderEnabled?.origin,
        'fresh compatibility rollback must settle the selected browser responder lease',
      ).toBe('routed-server');
      try {
        await expect.poll(() => page.evaluate((sessionId) => (
          window.__buildergateTerminalDebug?.getEvents(sessionId).some(event => (
            event.kind === 'terminal_legacy_responder_enabled'
          )) ?? false
        ), live.sessionId), {
          timeout: 10_000,
          message: 'replacement browser did not install the rebound legacy responder identity',
        }).toBe(true);
      } catch (error) {
        const responderEvents = await page.evaluate((sessionId) => (
          window.__buildergateTerminalDebug?.getEvents(sessionId).filter(event => (
            event.kind.includes('responder') || event.kind.includes('authority')
          )).slice(-30) ?? []
        ), live.sessionId);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; `
          + `legacyResponderEnabled=${JSON.stringify(legacyResponderEnabled?.message ?? null)}; `
          + `responderEvents=${JSON.stringify(responderEvents)}`,
        );
      }
      await page.waitForTimeout(250);
      try {
        await expect.poll(() => page.evaluate((sessionId) => {
          const events = window.__buildergateTerminalDebug?.getEvents(sessionId) ?? [];
          const latestGate = [...events].reverse().find(event => event.kind === 'input_gate_synced');
          const lastGridRepairStart = events.findLastIndex(event => event.kind === 'grid_layout_repair_started');
          const lastGridRepairSettlement = events.findLastIndex(event => (
            event.kind === 'screen_repair_applied' || event.kind === 'screen_repair_request_suppressed'
          ));
          return latestGate?.details.inputReady === true
            && latestGate.details.captureState === 'open'
            && latestGate.details.barrierReason === 'none'
            && (lastGridRepairStart < 0 || lastGridRepairSettlement > lastGridRepairStart);
        }, live.sessionId), {
          timeout: 10_000,
          message: 'replacement browser did not settle pending layout repair before stale-query injection',
        }).toBe(true);
      } catch (error) {
        const events = await page.evaluate((sessionId) => (
          window.__buildergateTerminalDebug?.getEvents(sessionId).slice(-40) ?? []
        ), live.sessionId);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}`,
        );
      }
      const oldBoundary = harness.frames.length - 1;
      const oldGeneration = injectOutput(
        harness,
        live,
        QUERY_DA1,
        { source: 'ph005-old-generation-query' },
      );
      let oldReply: CapturedFrame;
      try {
        oldReply = await waitForInputFrame(harness, live.sessionId, REPLY_DA1, {
          generation: oldGeneration,
          afterIndex: oldBoundary,
        });
      } catch (error) {
        const clientEvents = await page.evaluate((sessionId) => (
          window.__buildergateTerminalDebug?.getEvents(sessionId).slice(-40) ?? []
        ), live.sessionId);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; clientEvents=${JSON.stringify(clientEvents)}`,
        );
      }
      live = await waitForReplacementLiveTerminal(page, harness, { ...live, generation: oldGeneration });
      await page.waitForTimeout(750);
      const replayedOnReplacement = harness.matching(
        'page-to-server',
        message => message.type === 'input'
          && message.sessionId === live.sessionId
          && message.data === REPLY_DA1,
        { generation: live.generation },
      );
      const staleReplayFrameIndex = harness.replayBlockedFrameOnLiveConnection(oldReply, live.generation);
      const staleRejection = await waitForRoutedServerFrame(
        harness,
        message => message.type === 'terminal-authority:query-reply-rejected'
          && message.sessionId === live.sessionId,
        3_000,
      );
      const staleRejectionIndex = staleRejection ? harness.frames.indexOf(staleRejection) : -1;

      expect({
        authorityIsolation: preparation,
        oldGeneration,
        replacementGeneration: live.generation,
        oldReply: oldReply.message,
        replacementReplayCount: replayedOnReplacement.length,
        staleReplayFrameIndex,
        staleReplayOrigin: harness.frames[staleReplayFrameIndex]?.origin ?? null,
        staleRejection: staleRejection?.message ?? null,
        rejectionAfterActualServerSend: staleRejectionIndex > staleReplayFrameIndex,
      }, 'MIG-BGSTAB-002 AC-2 query replies lack stale responder identity and replay bypass').toMatchObject({
        authorityIsolation: {
          httpStatus: 200,
          mode: 'legacy',
          source: 'server-test-isolation',
          allAffectedViewsDrained: true,
          guardEvidence: expectedTerminalAuthorityGuardEvidence(),
        },
        oldReply: {
          inputKind: 'query-reply',
          responderIdentity: {
            sessionId: live.sessionId,
            connectionId: expect.any(String),
            viewGeneration: expect.any(Number),
            transitionEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
            authorityEpoch: expect.stringMatching(/^.+$/u),
            streamEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
            boundarySourceSeq: expect.stringMatching(/^(0|[1-9]\d*)$/u),
            responderLeaseId: expect.any(String),
          },
        },
        replacementReplayCount: 0,
        staleReplayFrameIndex: expect.any(Number),
        staleReplayOrigin: 'routed-page',
        staleRejection: {
          type: 'terminal-authority:query-reply-rejected',
          sessionId: live.sessionId,
          accepted: false,
          reason: 'stale-responder-identity',
          rejectedResponderIdentity: oldReply.message?.responderIdentity,
          currentConnectionId: expect.any(String),
          currentViewGeneration: live.viewGeneration,
          ptyWriteAttempted: false,
          ptyWriteCount: 0,
          effectCommitted: false,
        },
        rejectionAfterActualServerSend: true,
      });
    } finally {
      await runCleanupTasks('stale reconnect no-replay', [
        { name: 'release-query-reply-blocker', run: unblock },
        {
          name: 'restore-authority-isolation',
          run: async () => {
            try {
              return await cleanupServerAuthorityTestState(page, live.sessionId, preparation);
            } catch (error) {
              const events = await page.evaluate((sessionId) => (
                window.__buildergateTerminalDebug?.getEvents(sessionId).slice(-80) ?? []
              ), live.sessionId);
              throw new Error(
                `${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}`,
              );
            }
          },
        },
      ]);
    }
  });

  test('fault PTY/AI idle', async ({ page }) => {
    test.setTimeout(120_000);
    const harness = new RoutedWebSocketHarness();
    let live = await bootLiveTerminal(page, harness);
    let preparation: Record<string, unknown> = { httpStatus: 0 };
    let stopStatusMonitor: () => Promise<void> = async () => {};
    let serverDebugCaptureEnabled = false;
    try {
    await page.evaluate(async (sessionId) => {
      await window.__buildergateTerminalDebug?.start(sessionId);
    }, live.sessionId);
    await enableServerDebugCapture(page, live.sessionId);
    serverDebugCaptureEnabled = true;
    const freshPreparationBoundary = harness.frames.length - 1;
    preparation = await prepareServerAuthorityTestState(page, live.sessionId, 'legacy');
    if (preparation.httpStatus !== 200 || preparation.accepted !== true) {
      throw new Error(`fault legacy preparation failed: ${JSON.stringify(preparation)}`);
    }
    await expect.poll(() => harness.matching(
      'server-to-page',
      message => message.type === 'screen-snapshot' && message.sessionId === live.sessionId,
      { afterIndex: freshPreparationBoundary },
    ).length, {
      timeout: 20_000,
      message: 'fault preparation did not publish a replacement snapshot lineage',
    }).toBeGreaterThan(0);
    const settledSnapshotFrame = harness.matching(
      'server-to-page',
      message => message.type === 'screen-snapshot' && message.sessionId === live.sessionId,
      { afterIndex: freshPreparationBoundary },
    ).at(-1)!;
    await waitForSessionReady(
      harness,
      live.sessionId,
      settledSnapshotFrame.generation,
      settledSnapshotFrame.message!.replayToken,
    );
    const settledViewGeneration = await waitForViewGeneration(
      harness,
      live.sessionId,
      settledSnapshotFrame.generation,
      freshPreparationBoundary,
    );
    await waitForAcceptedViewAttributes(
      harness,
      live.sessionId,
      settledSnapshotFrame.generation,
      settledViewGeneration,
      true,
      20_000,
      freshPreparationBoundary,
    );
    live = {
      sessionId: live.sessionId,
      generation: settledSnapshotFrame.generation,
      snapshot: settledSnapshotFrame.message!,
      viewGeneration: settledViewGeneration,
    };
    await expect.poll(() => readSessionStatus(page, live.sessionId), {
      message: 'E2E precondition failed: live session did not settle idle',
      timeout: 15_000,
    }).toBe('idle');
    await expect.poll(async () => page.evaluate((sessionId) => {
      const events = window.__buildergateTerminalDebug?.getEvents(sessionId) ?? [];
      const latestGate = [...events].reverse().find(event => event.kind === 'input_gate_synced');
      return latestGate?.details.inputReady === true
        && latestGate.details.captureState === 'open'
        && latestGate.details.barrierReason === 'none';
    }, live.sessionId), {
      message: 'E2E precondition failed: fresh legacy recovery did not reopen terminal input',
      timeout: 20_000,
    }).toBe(true);
    await expect.poll(() => harness.matching(
      'server-to-page',
      message => message.type === 'terminal-authority:legacy-responder-enabled'
        && message.sessionId === live.sessionId
        && message.viewGeneration === live.viewGeneration,
      { generation: live.generation, afterIndex: freshPreparationBoundary },
    ).filter(frame => frame.origin === 'routed-server').length, {
      message: 'fault preparation did not settle the exact legacy responder identity',
      timeout: 10_000,
    }).toBeGreaterThan(0);
    unsubscribeUnrelatedSessions(harness, live);
    await page.waitForTimeout(100);
    const marker = `PH005-PTY-CONTINUES-${Date.now()}`;
    const canaryFrameBoundary = harness.frames.length;
    const canaryControlGeneration = resolveLatestControlGeneration(harness, live);
    const canaryRequestId = requestServerAuthorityCanary(harness, live);
    const canaryDecision = await waitForRoutedServerFrame(
      harness,
      message => message.type === 'terminal-authority:canary-decision'
        && message.requestId === canaryRequestId,
      10_000,
    );
    const canarySelectedTarget = canaryDecision?.message?.selectedSessionId === live.sessionId
      && Array.isArray(canaryDecision.message.decisions)
      && canaryDecision.message.decisions.some(decision => (
        decision !== null
        && typeof decision === 'object'
        && (decision as Record<string, unknown>).sessionId === live.sessionId
        && (decision as Record<string, unknown>).accepted === true
        && (decision as Record<string, unknown>).authorityMode === 'server'
      ));
    if (!canarySelectedTarget) {
      throw new Error(
        `fault canary did not promote the exact target session: ${JSON.stringify({
          decision: canaryDecision?.message ?? null,
          liveGeneration: live.generation,
          canaryControlGeneration,
          frames: harness.frames.slice(canaryFrameBoundary, canaryFrameBoundary + 40).map(frame => ({
            direction: frame.direction,
            generation: frame.generation,
            origin: frame.origin,
            message: frame.message,
          })),
        })}`,
      );
    }
    const activeInputBeforeFault = visibleSessionRuntime(page, live.sessionId)
      .locator('.xterm-helper-textarea');
    await activeInputBeforeFault.focus();
    await expect(activeInputBeforeFault).toBeFocused({ timeout: 5_000 });
    const statusHistory: Array<string | null> = [];
    let stopStatusMonitorRequested = false;
    const statusMonitor = (async () => {
      while (!stopStatusMonitorRequested) {
        statusHistory.push(await readSessionStatus(page, live.sessionId));
        await page.waitForTimeout(25);
      }
    })();
    stopStatusMonitor = async () => {
      stopStatusMonitorRequested = true;
      await statusMonitor;
    };
    try {
    const debugBeforeInteraction = await readServerDebugCapture(page, live.sessionId);
    const clientDebugBoundaryEventId = await page.evaluate((sessionId) => Math.max(
      0,
      ...(window.__buildergateTerminalDebug?.getEvents(sessionId).map(event => event.eventId) ?? []),
    ), live.sessionId);
    const debugInteractionBoundaryEventId = Math.max(
      0,
      ...debugBeforeInteraction.server.map(event => event.eventId),
    );
    const frameBoundary = harness.frames.length - 1;
    const faultTrigger = await triggerServerAuthorityFault(page, live.sessionId);
    const triggerId = faultTrigger.triggerId;
    const serverAbort = await waitForRoutedServerFrame(
      harness,
      message => message.type === 'terminal-authority:promotion-aborted'
        && message.sessionId === live.sessionId
        && message.triggerId === triggerId,
      3_000,
    );
    const serverRollback = await waitForRoutedServerFrame(
      harness,
      message => message.type === 'terminal-authority:rollback-start'
        && message.sessionId === live.sessionId
        && message.triggerId === triggerId,
      3_000,
    );
    await expect.poll(() => page.evaluate(({ sessionId, boundaryEventId }) => {
      const events = window.__buildergateTerminalDebug?.getEvents(sessionId) ?? [];
      const restored = events.some(event => (
        event.eventId > boundaryEventId
        && event.kind === 'focus_restored_after_gate'
      ));
      const latestGate = [...events].reverse().find(event => event.kind === 'input_gate_synced');
      return restored
        && latestGate?.details.inputReady === true
        && latestGate.details.captureState === 'open'
        && latestGate.details.barrierReason === 'none';
    }, { sessionId: live.sessionId, boundaryEventId: clientDebugBoundaryEventId }), {
      message: 'fault rollback did not settle replacement focus and input readiness',
      timeout: 20_000,
    }).toBe(true);
    const faultRuntime = visibleSessionRuntime(page, live.sessionId);
    const input = faultRuntime.locator('.xterm-helper-textarea');
    await expect.poll(async () => {
      await input.focus();
      return input.evaluate((textarea) => (
        textarea.isConnected
        && !textarea.disabled
        && textarea === document.activeElement
      ));
    }, {
      message: 'fault rollback did not restore focus to the replacement terminal input',
      timeout: 20_000,
    }).toBe(true);
    const inputStateBeforeType = await input.evaluate((textarea) => ({
      connected: textarea.isConnected,
      disabled: textarea.disabled,
      readOnly: textarea.readOnly,
      active: textarea === document.activeElement,
    }));
    await page.keyboard.type(marker, { delay: 0 });
    try {
      await waitForCommandMarker(page, live.sessionId, marker);
    } catch (error) {
      const terminalViews = await page.locator('.terminal-view:visible').evaluateAll((views) => (
        views.map((view, index) => {
          const textarea = view.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
          return {
            index,
            sessionId: view.getAttribute('data-session-id'),
            viewGeneration: view.getAttribute('data-view-generation'),
            connected: view.isConnected,
            textareaConnected: textarea?.isConnected ?? false,
            textareaDisabled: textarea?.disabled ?? null,
            textareaReadOnly: textarea?.readOnly ?? null,
            textareaActive: textarea === document.activeElement,
          };
        })
      ));
      const clientEvents = await page.evaluate(({ sessionId, boundaryEventId }) => (
        window.__buildergateTerminalDebug?.getEvents(sessionId).filter(event => (
          event.eventId > boundaryEventId
          && (
          event.kind.includes('input')
          || event.kind.includes('authority')
          || event.kind.includes('replay')
          || event.kind.includes('recovery')
          || event.kind.includes('focus')
          || event.kind.startsWith('helper_')
          )
        )).slice(-80).map(event => ({
          eventId: event.eventId,
          kind: event.kind,
          details: {
            reason: event.details.reason,
            source: event.details.source,
            inputReady: event.details.inputReady,
            barrierReason: event.details.barrierReason,
            captureState: event.details.captureState,
            activeElementIsHelper: event.details.activeElementIsHelper,
            helperDisabled: event.details.helperDisabled,
            eventKey: event.details.key,
          },
        })) ?? []
      ), { sessionId: live.sessionId, boundaryEventId: clientDebugBoundaryEventId });
      const serverEvents = await readServerDebugCapture(page, live.sessionId);
      const recentFrames = harness.frames.slice(frameBoundary + 1).filter(frame => (
        frame.message?.sessionId === live.sessionId
        && ['input', 'input:rejected', 'output', 'terminal-checkpoint:output',
          'terminal-authority:promotion-aborted', 'terminal-authority:rollback-start']
          .includes(frame.message.type ?? '')
      )).slice(-40).map(frame => ({
        direction: frame.direction,
        origin: frame.origin,
        generation: frame.generation,
        type: frame.message?.type,
        reason: frame.message?.reason,
        dataLength: typeof frame.message?.data === 'string' ? frame.message.data.length : 0,
        dataIncludesMarker: typeof frame.message?.data === 'string'
          ? frame.message.data.includes(marker)
          : false,
      }));
      const conciseServerEvents = serverEvents.server.slice(-40).map(event => ({
        kind: event.kind,
        details: {
          reason: event.details.reason,
          inputClass: event.details.inputClass,
          nextStatus: event.details.nextStatus,
          source: event.details.source,
          error: event.details.error,
        },
      }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; `
        + `clientEvents=${JSON.stringify(clientEvents)}; `
        + `serverEvents=${JSON.stringify(conciseServerEvents)}; `
        + `recentFrames=${JSON.stringify(recentFrames)}; `
        + `terminalViews=${JSON.stringify(terminalViews)}; `
        + `inputStateBeforeType=${JSON.stringify(inputStateBeforeType)}`,
      );
    }
    await expect.poll(() => readSessionStatus(page, live.sessionId), {
      message: 'user keyboard echo/prompt repaint did not preserve the idle invariant',
      timeout: 15_000,
    }).toBe('idle');
    const visibleText = await faultRuntime.locator('.xterm-rows').textContent() ?? '';
    const routedPtyOutput = harness.frames
      .slice(frameBoundary + 1)
      .filter(frame => (
        frame.direction === 'server-to-page'
        && frame.origin === 'routed-server'
        && frame.message?.type === 'output'
        && frame.message.sessionId === live.sessionId
      ))
      .map(frame => typeof frame.message?.data === 'string' ? frame.message.data : '')
      .join('');
    await page.keyboard.press('Control+C');
    await expect.poll(() => readSessionStatus(page, live.sessionId), {
      message: 'fault test cleanup did not leave the session idle',
      timeout: 10_000,
    }).toBe('idle');
    const debugAfterInteraction = await readServerDebugCapture(page, live.sessionId);
    const debugEventsAfterInteractionBoundary = debugAfterInteraction.server
      .filter(event => event.eventId > debugInteractionBoundaryEventId);
    const observedInputEvents = debugEventsAfterInteractionBoundary
      .filter(event => event.kind === 'input');
    const runningDerivedTransitions = debugEventsAfterInteractionBoundary.filter(event => (
      event.kind === 'derived_status_transition'
      && event.details?.nextStatus === 'running'
    ));
    const runningStatusFrames = harness.frames.slice(frameBoundary + 1).filter(frame => (
      frame.direction === 'server-to-page'
      && frame.origin === 'routed-server'
      && frame.message?.type === 'status'
      && frame.message.sessionId === live.sessionId
      && frame.message.status === 'running'
    ));
    const runningStatusFrameDetails = runningStatusFrames.map(frame => ({
      generation: frame.generation,
      status: frame.message?.status,
      reason: frame.message?.reason,
      source: frame.message?.source,
    }));
    const runningStatusCaptureEvents = debugEventsAfterInteractionBoundary
      .filter(event => event.details?.nextStatus === 'running')
      .map(event => ({ kind: event.kind, details: event.details }));
    const abortIndex = serverAbort ? harness.frames.indexOf(serverAbort) : -1;
    const rollbackIndex = serverRollback ? harness.frames.indexOf(serverRollback) : -1;
    const authorityEpoch = serverAbort?.message?.authorityEpoch;

    expect({
      authorityIsolation: preparation,
      canaryDecisionOrigin: canaryDecision?.origin ?? null,
      deterministicServerTrigger: faultTrigger,
      authorityEpochOpaqueNonEmpty: typeof authorityEpoch === 'string' && authorityEpoch.length > 0,
      serverAbort: {
        origin: serverAbort?.origin ?? null,
        message: serverAbort?.message ?? null,
      },
      serverRollback: {
        origin: serverRollback?.origin ?? null,
        message: serverRollback?.message ?? null,
      },
      abortBeforeRollback: abortIndex >= 0 && rollbackIndex > abortIndex,
      actualRoutedPtyOutputContainsMarker: routedPtyOutput.includes(marker),
      ptyMarkerRendered: visibleText.includes(marker),
      statusHistory,
      transientRunningObserved: statusHistory.includes('running'),
      losslessIdleInvariant: {
        captureEnabled: debugAfterInteraction.enabled,
        interactionBoundaryEventId: debugInteractionBoundaryEventId,
        observedInputEventCount: observedInputEvents.length,
        actualInputObserved: observedInputEvents.length > 0,
        runningDerivedTransitionCount: runningDerivedTransitions.length,
        runningStatusFrameCount: runningStatusFrames.length,
        runningStatusFrameDetails,
        runningStatusCaptureEvents,
      },
      finalSessionStatus: await readSessionStatus(page, live.sessionId),
    }, 'MIG-BGSTAB-002 AC-6 fault abort/PTY continuity/AI idle contract is absent').toMatchObject({
      authorityIsolation: {
        httpStatus: 200,
        mode: 'legacy',
        source: 'server-test-isolation',
        allAffectedViewsDrained: true,
        guardEvidence: expectedTerminalAuthorityGuardEvidence(),
      },
      canaryDecisionOrigin: 'routed-server',
      deterministicServerTrigger: {
        httpStatus: 202,
        accepted: true,
        triggerSource: 'server-deterministic-debug',
        triggerId: expect.any(String),
      },
      authorityEpochOpaqueNonEmpty: true,
      serverAbort: {
        origin: 'routed-server',
        message: {
          type: 'terminal-authority:promotion-aborted',
          triggerId,
          reason: 'legacy-disable-ack-immediate-send-failed',
          authorityEpoch,
          transitionEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          streamEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          ptyPaused: false,
          hiddenDeliveryLossy: false,
          sessionStatus: 'idle',
        },
      },
      serverRollback: {
        origin: 'routed-server',
        message: {
          type: 'terminal-authority:rollback-start',
          triggerId,
          authorityEpoch,
          transitionEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          streamEpoch: expect.stringMatching(/^(0|[1-9]\d*)$/u),
          requiredAction: 'fresh-compatibility-checkpoint',
          ptyPaused: false,
        },
      },
      abortBeforeRollback: true,
      actualRoutedPtyOutputContainsMarker: true,
      ptyMarkerRendered: true,
      transientRunningObserved: false,
      losslessIdleInvariant: {
        captureEnabled: true,
        interactionBoundaryEventId: expect.any(Number),
        observedInputEventCount: expect.any(Number),
        actualInputObserved: true,
        runningDerivedTransitionCount: 0,
        runningStatusFrameCount: 0,
        runningStatusFrameDetails: [],
        runningStatusCaptureEvents: [],
      },
      finalSessionStatus: 'idle',
    });
    } finally {
      await stopStatusMonitor();
    }
    } finally {
      await runCleanupTasks('fault PTY/AI idle', [
        { name: 'stop-status-monitor', run: stopStatusMonitor },
        {
          name: 'disable-and-clear-server-debug-capture',
          run: () => serverDebugCaptureEnabled
            ? disableServerDebugCapture(page, live.sessionId)
            : Promise.resolve(),
        },
        {
          name: 'restore-authority-isolation',
          run: async () => {
            try {
              return await cleanupServerAuthorityTestState(
                page,
                live.sessionId,
                preparation,
                harness,
              );
            } catch (error) {
              const clientEvents = await page.evaluate((sessionId) => (
                window.__buildergateTerminalDebug?.getEvents(sessionId)
                  .filter(event => event.kind.includes('reconnect') || event.kind.includes('recovery'))
                  .slice(-80) ?? []
              ), live.sessionId);
              throw new Error(
                `${error instanceof Error ? error.message : String(error)}; `
                + `faultClientRecoveryEvents=${JSON.stringify(clientEvents)}`,
              );
            }
          },
        },
      ]);
    }
  });
});

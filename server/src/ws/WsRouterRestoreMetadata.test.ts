import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { AuthService } from '../services/AuthService.js';
import { CryptoService } from '../services/CryptoService.js';
import { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from './WsRouter.js';

const SIGNATURE = 'expected normal replay repair output sequence and matching ready token metadata';

type JsonFrame = Record<string, unknown> & {
  type?: string;
  sessionId?: string;
  replayToken?: string;
  repairToken?: string;
  data?: string;
};

interface LocalWsHarness {
  endpoint: string;
  token: string;
  manager: SessionManager;
  router: WsRouter;
  auth: AuthService;
  server: Server;
}

function createLocalEndpoint(): string {
  const name = `buildergate-ws-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

async function startLocalWsHarness(): Promise<LocalWsHarness> {
  const endpoint = createLocalEndpoint();
  if (process.platform !== 'win32' && existsSync(endpoint)) unlinkSync(endpoint);

  const crypto = new CryptoService(`ws-restore-${randomUUID()}`);
  const auth = new AuthService({
    password: 'local-test-only',
    durationMs: 60_000,
    maxDurationMs: 60_000,
    jwtSecret: `restore-secret-${randomUUID()}`,
  }, crypto);
  const manager = new SessionManager();
  const router = new WsRouter(auth, manager);
  manager.setWsRouter(router);
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('upgrade', (request, socket, head) => {
    (socket as typeof socket & { unref?: () => void }).unref?.();
    router.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  return {
    endpoint,
    token: auth.issueToken().token,
    manager,
    router,
    auth,
    server,
  };
}

async function stopLocalWsHarness(harness: LocalWsHarness): Promise<void> {
  harness.router.destroy();
  harness.auth.destroy();
  harness.manager.stopAllCwdWatching();
  harness.server.closeAllConnections();
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      harness.server.close(error => error ? reject(error) : resolve());
    }),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Named-pipe HTTP server cleanup timed out')),
        2_000,
      );
      timer.unref();
    }),
  ]);
  if (process.platform !== 'win32' && existsSync(harness.endpoint)) unlinkSync(harness.endpoint);
}

class LiveWsClient {
  readonly frames: JsonFrame[] = [];
  private readonly waiters = new Set<{
    predicate: (frame: JsonFrame) => boolean;
    resolve: (frame: JsonFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      let frame: JsonFrame;
      try {
        frame = JSON.parse(raw.toString()) as JsonFrame;
      } catch {
        // `06 §S3` — dropping this silently made every waiter below time out
        // with no indication of why. Failing the pending waiters names the
        // cause instead, and will name it again the moment a binary frame
        // reaches a spec that still assumes JSON.
        const undecodable = new Error('undecodable-ws-frame');
        for (const waiter of [...this.waiters]) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.reject(undecodable);
        }
        return;
      }
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(frame)) continue;
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    });
    socket.once('close', () => {
      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('WebSocket closed before the expected frame arrived'));
      }
      this.waiters.clear();
    });
  }

  static connect(token: string, endpoint: string): Promise<LiveWsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://buildergate.test/ws?token=${encodeURIComponent(token)}`, {
        createConnection: () => connectSocket(endpoint),
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('WebSocket connection timed out'));
      }, 5_000);
      socket.once('open', () => {
        clearTimeout(timer);
        (socket as WebSocket & { _socket?: { unref?: () => void } })._socket?.unref?.();
        resolve(new LiveWsClient(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(frame: JsonFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(
    predicate: (frame: JsonFrame) => boolean,
    label: string,
    timeoutMs = 10_000,
    afterIndex = 0,
  ): Promise<JsonFrame> {
    const existing = [...this.frames.slice(afterIndex)].reverse().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${label}; frames=${JSON.stringify(this.frames.slice(-8))}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.socket.terminate();
      return;
    }
    const closed = new Promise<void>((resolve) => this.socket.once('close', () => resolve()));
    this.socket.close();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.socket.terminate();
  }
}

function isSessionFrame(frame: JsonFrame, type: string, sessionId: string): boolean {
  return frame.type === type && frame.sessionId === sessionId;
}

function hasMarker(frame: JsonFrame, sessionId: string, marker: string): boolean {
  return isSessionFrame(frame, 'output', sessionId)
    && typeof frame.data === 'string'
    && frame.data.includes(marker);
}

function markerCommand(marker: string): string {
  return process.platform === 'win32'
    ? `Write-Output '${marker}'\r`
    : `printf '%s\\n' '${marker}'\r`;
}

async function subscribeReady(client: LiveWsClient, sessionId: string): Promise<JsonFrame> {
  client.send({ type: 'subscribe', sessionIds: [sessionId] });
  const snapshot = await client.waitFor(
    frame => isSessionFrame(frame, 'screen-snapshot', sessionId),
    `snapshot for ${sessionId}`,
  );
  assert.equal(typeof snapshot.replayToken, 'string', 'integration precondition: snapshot replay token');
  const readyStart = client.frames.length;
  client.send({
    type: 'screen-snapshot:ready',
    sessionId,
    replayToken: snapshot.replayToken,
  });
  await client.waitFor(
    frame => isSessionFrame(frame, 'session:ready', sessionId),
    `ready for ${sessionId}`,
    10_000,
    readyStart,
  );
  return snapshot;
}

test('server RED — real output sequence and ready authority tokens', { timeout: 40_000 }, async () => {
  let sessionId: string | undefined;
  let replayClient: LiveWsClient | undefined;
  let producerClient: LiveWsClient | undefined;
  let harness: LocalWsHarness | undefined;
  try {
    harness = await startLocalWsHarness();
    const activeToken = harness.token;
    const created = harness.manager.createSession(
      `Wave2 restore metadata RED ${Date.now()}`,
      process.platform === 'win32' ? 'powershell' : 'bash',
    );
    const activeSessionId = created.id;
    sessionId = activeSessionId;

    replayClient = await LiveWsClient.connect(activeToken, harness.endpoint);
    producerClient = await LiveWsClient.connect(activeToken, harness.endpoint);

    replayClient.send({ type: 'subscribe', sessionIds: [sessionId] });
    const replaySnapshot = await replayClient.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!),
      'replay client snapshot',
    );
    assert.equal(typeof replaySnapshot.replayToken, 'string', 'integration precondition: replay token');
    assert.equal(typeof replaySnapshot.seq, 'number', 'integration precondition: snapshot sequence');
    assert.equal(typeof replaySnapshot.cols, 'number', 'integration precondition: snapshot columns');
    assert.equal(typeof replaySnapshot.rows, 'number', 'integration precondition: snapshot rows');
    assert.equal(typeof replaySnapshot.authorityEpoch, 'string', 'snapshot authority epoch');
    assert.equal(typeof replaySnapshot.authorityRevision, 'number', 'snapshot authority revision');
    assert.equal(replaySnapshot.coversThroughSeq, replaySnapshot.seq, 'snapshot coverage frontier');

    await subscribeReady(producerClient, activeSessionId);

    const replayMarker = `BG_REPLAY_${Date.now()}`;
    producerClient.send({ type: 'input', sessionId, data: markerCommand(replayMarker) });
    await producerClient.waitFor(
      frame => hasMarker(frame, sessionId!, replayMarker),
      'producer replay marker',
    );
    const replayReadyStart = replayClient.frames.length;
    replayClient.send({
      type: 'screen-snapshot:ready',
      sessionId,
      replayToken: replaySnapshot.replayToken,
    });
    const replayOutput = await replayClient.waitFor(
      frame => hasMarker(frame, sessionId!, replayMarker),
      'flushed replay marker',
    );
    const replayReady = await replayClient.waitFor(
      frame => isSessionFrame(frame, 'session:ready', sessionId!),
      'replay ready metadata',
      10_000,
      replayReadyStart,
    );
    const refreshedReplaySnapshot = await replayClient.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)
        && frame.supersedesReplayToken === replaySnapshot.replayToken,
      'post-replay refreshed snapshot',
    );
    assert.equal(typeof refreshedReplaySnapshot.replayToken, 'string',
      'post-replay refresh must issue a replacement replay token');
    const refreshedReadyStart = replayClient.frames.length;
    replayClient.send({
      type: 'screen-snapshot:ready',
      sessionId,
      replayToken: refreshedReplaySnapshot.replayToken,
    });
    await replayClient.waitFor(
      frame => isSessionFrame(frame, 'session:ready', sessionId!)
        && frame.replayToken === refreshedReplaySnapshot.replayToken,
      'post-replay refreshed ready metadata',
      10_000,
      refreshedReadyStart,
    );

    replayClient.send({
      type: 'screen-repair',
      sessionId,
      cols: replaySnapshot.cols,
      rows: replaySnapshot.rows,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = await replayClient.waitFor(
      frame => isSessionFrame(frame, 'screen-repair', sessionId!),
      'screen repair response',
    );
    assert.equal(typeof repair.repairToken, 'string', 'integration precondition: repair token');
    assert.equal(typeof repair.seq, 'number', 'integration precondition: repair sequence');

    const repairMarker = `BG_REPAIR_${Date.now()}`;
    producerClient.send({ type: 'input', sessionId, data: markerCommand(repairMarker) });
    await producerClient.waitFor(
      frame => hasMarker(frame, sessionId!, repairMarker),
      'producer repair marker',
    );
    const repairReadyStart = replayClient.frames.length;
    replayClient.send({ type: 'screen-repair:ready', sessionId, repairToken: repair.repairToken });
    const repairOutput = await replayClient.waitFor(
      frame => hasMarker(frame, sessionId!, repairMarker),
      'flushed repair marker',
    );
    const repairReady = await replayClient.waitFor(
      frame => isSessionFrame(frame, 'session:ready', sessionId!),
      'repair ready metadata',
      10_000,
      repairReadyStart,
    );

    const normalMarker = `BG_NORMAL_${Date.now()}`;
    producerClient.send({ type: 'input', sessionId, data: markerCommand(normalMarker) });
    const normalOutput = await replayClient.waitFor(
      frame => hasMarker(frame, sessionId!, normalMarker),
      'normal output marker',
    );

    assert.deepEqual({
      replay: {
        outputScreenSeqType: typeof replayOutput.screenSeq,
        outputReplayToken: replayOutput.replayToken,
        outputChunkIdType: typeof replayOutput.chunkId,
        readyReplayToken: replayReady.replayToken,
        readySnapshotSeq: replayReady.snapshotSeq,
      },
      repair: {
        outputScreenSeqType: typeof repairOutput.screenSeq,
        outputRepairToken: repairOutput.repairToken,
        outputChunkIdType: typeof repairOutput.chunkId,
        readyRepairToken: repairReady.repairToken,
        readySnapshotSeq: repairReady.snapshotSeq,
      },
      normal: {
        outputScreenSeqType: typeof normalOutput.screenSeq,
        outputChunkIdType: typeof normalOutput.chunkId,
        outputAuthorityEpoch: normalOutput.authorityEpoch,
        outputAuthorityRevisionType: typeof normalOutput.authorityRevision,
      },
    }, {
      replay: {
        outputScreenSeqType: 'number',
        outputReplayToken: replaySnapshot.replayToken,
        outputChunkIdType: 'string',
        readyReplayToken: replaySnapshot.replayToken,
        readySnapshotSeq: replaySnapshot.seq,
      },
      repair: {
        outputScreenSeqType: 'number',
        outputRepairToken: repair.repairToken,
        outputChunkIdType: 'string',
        readyRepairToken: repair.repairToken,
        readySnapshotSeq: repair.seq,
      },
      normal: {
        outputScreenSeqType: 'number',
        outputChunkIdType: 'string',
        outputAuthorityEpoch: replaySnapshot.authorityEpoch,
        outputAuthorityRevisionType: 'number',
      },
    }, SIGNATURE);

  } finally {
    await Promise.allSettled([
      replayClient?.close(),
      producerClient?.close(),
    ]);
    if (harness) {
      try {
        if (sessionId && harness.manager.getSession(sessionId)) {
          harness.manager.deleteSession(sessionId);
        }
      } finally {
        await stopLocalWsHarness(harness);
      }
    }
  }
});

test('server fresh replay request is token-fenced and supersedes the pending snapshot', { timeout: 20_000 }, async () => {
  let sessionId: string | undefined;
  let client: LiveWsClient | undefined;
  let harness: LocalWsHarness | undefined;
  try {
    harness = await startLocalWsHarness();
    const created = harness.manager.createSession(
      `Wave2 token-fenced refresh ${Date.now()}`,
      process.platform === 'win32' ? 'powershell' : 'bash',
    );
    sessionId = created.id;
    client = await LiveWsClient.connect(harness.token, harness.endpoint);
    client.send({ type: 'subscribe', sessionIds: [sessionId] });
    const firstSnapshot = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!),
      'first pending snapshot',
    );
    assert.equal(typeof firstSnapshot.replayToken, 'string');
    assert.equal(typeof firstSnapshot.authorityEpoch, 'string');
    assert.equal(typeof firstSnapshot.authorityRevision, 'number');
    assert.equal(firstSnapshot.coversThroughSeq, firstSnapshot.seq);

    const wrongTokenStart = client.frames.length;
    client.send({
      type: 'repair-replay',
      sessionId,
      supersedeReplayToken: 'stale-replay-token',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      client.frames.slice(wrongTokenStart).some(frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)),
      false,
    );

    const originalAtomicSnapshot = harness.manager.getAtomicRestoreSnapshot.bind(harness.manager);
    let failNextAtomicSnapshot = true;
    harness.manager.getAtomicRestoreSnapshot = (requestedSessionId: string) => {
      if (failNextAtomicSnapshot) {
        failNextAtomicSnapshot = false;
        return { ok: false, reason: 'generation-failed' };
      }
      return originalAtomicSnapshot(requestedSessionId);
    };

    const refreshStart = client.frames.length;
    client.send({
      type: 'repair-replay',
      sessionId,
      supersedeReplayToken: firstSnapshot.replayToken,
    });
    const refreshed = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)
        && frame.replayToken !== firstSnapshot.replayToken,
      'token-fenced refreshed snapshot',
      2_000,
      refreshStart,
    );
    assert.equal(typeof refreshed.replayToken, 'string');
    assert.equal(refreshed.authorityEpoch, firstSnapshot.authorityEpoch);
    assert.equal(typeof refreshed.authorityRevision, 'number');
    assert.equal(refreshed.coversThroughSeq, refreshed.seq);
    assert.equal(refreshed.supersedesReplayToken, firstSnapshot.replayToken);
    client.send({ type: 'screen-snapshot:ready', sessionId, replayToken: refreshed.replayToken });
    await client.waitFor(
      frame => isSessionFrame(frame, 'session:ready', sessionId!),
      'ready after token-fenced refresh',
      5_000,
      refreshStart,
    );
  } finally {
    await client?.close();
    if (harness) {
      try {
        if (sessionId && harness.manager.getSession(sessionId)) {
          harness.manager.deleteSession(sessionId);
        }
      } finally {
        await stopLocalWsHarness(harness);
      }
    }
  }
});

test('server recovery refresh requires both replay and repair ownership tokens', { timeout: 25_000 }, async () => {
  let sessionId: string | undefined;
  let client: LiveWsClient | undefined;
  let harness: LocalWsHarness | undefined;
  try {
    harness = await startLocalWsHarness();
    const created = harness.manager.createSession(
      `Wave2 repair-owned refresh ${Date.now()}`,
      process.platform === 'win32' ? 'powershell' : 'bash',
    );
    sessionId = created.id;
    client = await LiveWsClient.connect(harness.token, harness.endpoint);
    const initial = await subscribeReady(client, sessionId);

    const repairStart = client.frames.length;
    client.send({
      type: 'screen-repair',
      sessionId,
      cols: initial.cols,
      rows: initial.rows,
      reason: 'manual',
      clientAtBottom: true,
      clientBufferType: 'normal',
    });
    const repair = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-repair', sessionId!),
      'repair before owned refresh',
      5_000,
      repairStart,
    );
    assert.equal(typeof repair.repairToken, 'string');
    client.send({
      type: 'screen-repair:failed',
      sessionId,
      repairToken: repair.repairToken,
      reason: 'write-failed',
    });
    const restoreNeeded = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-repair:restore-needed', sessionId!),
      'restore-needed before owned refresh',
      5_000,
      repairStart,
    );
    const firstRecoverySnapshot = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)
        && frame.replayToken === restoreNeeded.replayToken,
      'first repair-owned snapshot',
      5_000,
      repairStart,
    );
    assert.equal(typeof restoreNeeded.authorityEpoch, 'string');
    assert.equal(typeof restoreNeeded.authorityRevision, 'number');
    assert.equal(restoreNeeded.coversThroughSeq, restoreNeeded.snapshotSeq);
    assert.equal(firstRecoverySnapshot.authorityEpoch, restoreNeeded.authorityEpoch);
    assert.equal(firstRecoverySnapshot.authorityRevision, restoreNeeded.authorityRevision);
    assert.equal(firstRecoverySnapshot.coversThroughSeq, restoreNeeded.coversThroughSeq);

    const wrongRepairStart = client.frames.length;
    client.send({
      type: 'repair-replay',
      sessionId,
      supersedeReplayToken: firstRecoverySnapshot.replayToken,
      repairToken: 'wrong-repair-owner',
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      client.frames.slice(wrongRepairStart).some(frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)),
      false,
    );

    const ownedRefreshStart = client.frames.length;
    client.send({
      type: 'repair-replay',
      sessionId,
      supersedeReplayToken: firstRecoverySnapshot.replayToken,
      repairToken: repair.repairToken,
    });
    const refreshedRestore = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-repair:restore-needed', sessionId!)
        && frame.replayToken !== firstRecoverySnapshot.replayToken,
      'owned refreshed restore-needed',
      5_000,
      ownedRefreshStart,
    );
    const refreshedSnapshot = await client.waitFor(
      frame => isSessionFrame(frame, 'screen-snapshot', sessionId!)
        && frame.replayToken === refreshedRestore.replayToken,
      'owned refreshed snapshot',
      5_000,
      ownedRefreshStart,
    );
    assert.equal(refreshedRestore.supersedesReplayToken, firstRecoverySnapshot.replayToken);
    assert.equal(refreshedSnapshot.supersedesReplayToken, firstRecoverySnapshot.replayToken);
    assert.equal(refreshedRestore.authorityEpoch, firstRecoverySnapshot.authorityEpoch);
    assert.equal(refreshedSnapshot.authorityEpoch, refreshedRestore.authorityEpoch);
    assert.equal(refreshedRestore.coversThroughSeq, refreshedRestore.snapshotSeq);
    assert.equal(refreshedSnapshot.coversThroughSeq, refreshedRestore.coversThroughSeq);
    client.send({
      type: 'screen-snapshot:ready',
      sessionId,
      replayToken: refreshedSnapshot.replayToken,
    });
    await client.waitFor(
      frame => isSessionFrame(frame, 'session:ready', sessionId!),
      'ready after repair-owned refresh',
      5_000,
      ownedRefreshStart,
    );
  } finally {
    await client?.close();
    if (harness) {
      try {
        if (sessionId && harness.manager.getSession(sessionId)) {
          harness.manager.deleteSession(sessionId);
        }
      } finally {
        await stopLocalWsHarness(harness);
      }
    }
  }
});

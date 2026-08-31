import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { getActiveSessionId, login, waitForTerminal } from './helpers';

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

const SIGNATURES = {
  remount: 'expected same-session remount stale async callbacks to be fenced',
  bounded: 'expected retries transactions timers and listeners to remain bounded',
} as const;

class RestoreRouteHarness {
  readonly frames: CapturedFrame[] = [];
  private generationValue = 0;
  private active: { page: WebSocketRoute; server: WebSocketRoute } | null = null;

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws(?:\?|$)/, (pageRoute) => {
      const serverRoute = pageRoute.connectToServer();
      const generation = ++this.generationValue;
      this.active = { page: pageRoute, server: serverRoute };
      pageRoute.onMessage((raw) => {
        this.frames.push({
          direction: 'page-to-server',
          generation,
          message: parseFrame(raw),
        });
        serverRoute.send(raw);
      });
      serverRoute.onMessage((raw) => {
        this.frames.push({
          direction: 'server-to-page',
          generation,
          message: parseFrame(raw),
        });
        pageRoute.send(raw);
      });
    });
  }

  get generation(): number {
    return this.generationValue;
  }

  inject(message: JsonFrame): void {
    if (!this.active) {
      throw new Error('E2E precondition failed: WebSocket route is not connected');
    }
    this.active.page.send(JSON.stringify(message));
  }

  latest(
    direction: CapturedFrame['direction'],
    predicate: (message: JsonFrame) => boolean,
    generation = this.generationValue,
  ): JsonFrame | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (
        frame.direction === direction
        && frame.generation === generation
        && frame.message
        && predicate(frame.message)
      ) {
        return frame.message;
      }
    }
    return null;
  }
}

function parseFrame(raw: string | Buffer): JsonFrame | null {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    return value && typeof value === 'object' ? value as JsonFrame : null;
  } catch {
    return null;
  }
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

async function establish(
  page: Page,
  harness: RestoreRouteHarness,
): Promise<{ sessionId: string; snapshot: JsonFrame }> {
  await harness.install(page);
  await login(page);
  await waitForTerminal(page);
  await expect.poll(() => harness.generation, {
    message: 'E2E precondition failed: routed WebSocket was not established',
    timeout: 10_000,
  }).toBeGreaterThan(0);
  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
  await startDebugCapture(page, sessionId!);
  await expect.poll(() => harness.latest(
    'server-to-page',
    message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
  ), {
    message: 'E2E precondition failed: initial screen snapshot was not observed',
    timeout: 15_000,
  }).not.toBeNull();
  return {
    sessionId: sessionId!,
    snapshot: harness.latest(
      'server-to-page',
      message => message.type === 'screen-snapshot' && message.sessionId === sessionId,
    )!,
  };
}

function restoreNeeded(
  sessionId: string,
  repairToken: string,
  replayToken: string,
  snapshotSeq: number,
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
  };
}

test.describe('REL-BGSTAB-009 remount adapter strict RED', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only restore contract');
  });

  test('Remount adapter RED — same-session remount fence', async ({ page }) => {
    test.setTimeout(45_000);
    const signature = SIGNATURES.remount;
    const harness = new RestoreRouteHarness();
    const { sessionId, snapshot } = await establish(page, harness);
    const oldReplayToken = `old-replay-${Date.now()}`;
    const oldRepairToken = `old-repair-${Date.now()}`;
    const snapshotSeq = Number(snapshot.seq ?? 0) + 1;
    harness.inject(restoreNeeded(sessionId, oldRepairToken, oldReplayToken, snapshotSeq));
    harness.inject({
      type: 'output',
      sessionId,
      replayToken: oldReplayToken,
      screenSeq: snapshotSeq + 1,
      chunkId: `${oldReplayToken}:tail`,
      data: 'old-held-tail',
    });

    const generationBeforeReload = harness.generation;
    await page.reload();
    await waitForTerminal(page);
    await expect.poll(() => harness.generation, {
      message: 'E2E precondition failed: reload did not establish a new connection generation',
      timeout: 15_000,
    }).toBeGreaterThan(generationBeforeReload);
    await startDebugCapture(page, sessionId);
    const currentReplayToken = `current-replay-${Date.now()}`;
    const currentRepairToken = `current-repair-${Date.now()}`;
    harness.inject(restoreNeeded(sessionId, currentRepairToken, currentReplayToken, snapshotSeq + 10));
    harness.inject({
      ...snapshot,
      type: 'screen-snapshot',
      sessionId,
      replayToken: oldReplayToken,
      repairToken: oldRepairToken,
      seq: snapshotSeq,
      authorityRevision: snapshotSeq,
      parserComplete: true,
      pendingEscapeTailAnsi: '',
    });
    harness.inject({
      type: 'session:ready',
      sessionId,
      replayToken: oldReplayToken,
      repairToken: oldRepairToken,
      snapshotSeq,
    });

    let events = await readDebugEvents(page, sessionId);
    await expect.poll(async () => {
      events = await readDebugEvents(page, sessionId);
      const currentStateObserved = events.some(event => (
        event.kind === 'visible_output_resync_state'
        && event.details?.replayToken === currentReplayToken
        && event.details?.repairToken === currentRepairToken
      ));
      const injectedStaleObserved = events.some(event => (
        event.kind === 'visible_output_resync_snapshot_stale_ignored'
        && event.details?.seq === snapshotSeq
        && event.details?.replayTokenMatches === false
      ));
      return currentStateObserved && injectedStaleObserved;
    }, {
      message: 'E2E precondition failed: current transaction or injected old snapshot was not observed',
      timeout: 10_000,
    }).toBe(true);
    const currentState = [...events].reverse().find(event => (
      event.kind === 'visible_output_resync_state'
      && event.details?.replayToken === currentReplayToken
      && event.details?.repairToken === currentRepairToken
    ));
    const staleEvent = [...events].reverse().find(event => (
      event.kind === 'visible_output_resync_snapshot_stale_ignored'
      && event.details?.seq === snapshotSeq
      && event.details?.replayTokenMatches === false
    ));
    const observed = {
      ignored: Boolean(staleEvent),
      viewGeneration: typeof staleEvent?.details?.viewGeneration,
      xtermGeneration: typeof staleEvent?.details?.xtermGeneration,
      receivedReplayToken: staleEvent?.details?.receivedReplayToken,
      activeReplayToken: staleEvent?.details?.activeReplayToken,
      activeRepairToken: staleEvent?.details?.activeRepairToken,
      currentGenerationPreserved: (
        staleEvent?.details?.connectionGeneration === currentState?.details?.connectionGeneration
        && staleEvent?.details?.sessionGeneration === currentState?.details?.sessionGeneration
      ),
      currentTransactionPreserved: currentState?.details?.currentViewTransactionReady === false,
      oldAckSent: harness.latest(
        'page-to-server',
        message => message.type === 'screen-snapshot:ready' && message.replayToken === oldReplayToken,
      ) !== null,
    };
    expect(observed, signature).toEqual({
      ignored: true,
      viewGeneration: 'number',
      xtermGeneration: 'number',
      receivedReplayToken: oldReplayToken,
      activeReplayToken: currentReplayToken,
      activeRepairToken: currentRepairToken,
      currentGenerationPreserved: true,
      currentTransactionPreserved: true,
      oldAckSent: false,
    });
  });

  test('Remount adapter RED — bounded retries and ownership', async ({ page }) => {
    test.setTimeout(50_000);
    const signature = SIGNATURES.bounded;
    const harness = new RestoreRouteHarness();
    const { sessionId, snapshot } = await establish(page, harness);

    for (let remount = 0; remount < 2; remount += 1) {
      const previousGeneration = harness.generation;
      await page.reload();
      await waitForTerminal(page);
      await expect.poll(() => harness.generation, {
        message: 'E2E precondition failed: repeated remount did not reconnect',
        timeout: 15_000,
      }).toBeGreaterThan(previousGeneration);
    }
    await startDebugCapture(page, sessionId);
    const replayToken = `bounded-replay-${Date.now()}`;
    const repairToken = `bounded-repair-${Date.now()}`;
    const snapshotSeq = Number(snapshot.seq ?? 0) + 20;
    harness.inject(restoreNeeded(sessionId, repairToken, replayToken, snapshotSeq));
    harness.inject({ type: 'session:ready', sessionId, replayToken, repairToken, snapshotSeq });
    harness.inject({
      type: 'output',
      sessionId,
      replayToken,
      screenSeq: snapshotSeq + 1,
      chunkId: `${replayToken}:held`,
      data: 'bounded-held-tail',
    });

    let state: Awaited<ReturnType<typeof readDebugEvents>>[number] | undefined;
    await expect.poll(async () => {
      const events = await readDebugEvents(page, sessionId);
      state = [...events].reverse().find(event => (
        event.kind === 'visible_output_resync_state'
        && event.details?.replayToken === replayToken
        && event.details?.repairToken === repairToken
      ));
      return Boolean(state);
    }, {
      message: 'E2E precondition failed: bounded remount transaction was not observed',
      timeout: 10_000,
    }).toBe(true);
    const stateDetails = state?.details;
    const observed = {
      stateObserved: Boolean(stateDetails),
      currentViewTransactionReady: stateDetails?.currentViewTransactionReady,
      retainedHistoryEquivalent: stateDetails?.retainedHistoryEquivalent,
      activeTimerCount: stateDetails?.activeTimerCount,
      activeListenerCount: stateDetails?.activeListenerCount,
      activeTransactionCount: stateDetails?.activeTransactionCount,
      viewGenerationType: typeof stateDetails?.viewGeneration,
      xtermGenerationType: typeof stateDetails?.xtermGeneration,
      earlyAckSent: harness.latest(
        'page-to-server',
        message => message.type === 'screen-snapshot:ready' && message.replayToken === replayToken,
      ) !== null,
    };
    expect(observed, signature).toEqual({
      stateObserved: true,
      currentViewTransactionReady: false,
      retainedHistoryEquivalent: false,
      activeTimerCount: 0,
      activeListenerCount: 1,
      activeTransactionCount: 1,
      viewGenerationType: 'number',
      xtermGenerationType: 'number',
      earlyAckSent: false,
    });
  });
});

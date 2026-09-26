import { expect } from '@playwright/test';
import { test } from './workspaceOwnershipFixture';
import { login, waitForTerminal } from './helpers';
import {
  activateSelectionWorkspace,
  cleanupSelectionWorkspace,
  sendCommandAndWaitForMarker,
} from './terminalSelectionFixture';

/**
 * Issue #113 probe v5 — what the slow restore is waiting for.
 *
 * WHAT IS ALREADY KNOWN, so this does not re-derive it:
 *   - The restore is bimodal: ~60-84ms or 6-9s, with no middle.
 *   - Payload generation is excluded by measurement, not argument: at
 *     production values the serializer returns 9692 bytes / 701 lines /
 *     truncated:false against a 2 MiB cap, on its first loop iteration.
 *   - The retry ladder is excluded: its backoffs sum to ~1024ms.
 *   - A fence hypothesis in markRestoreAuthorityPending was posted and
 *     RETRACTED; no reachable path was found. Do not re-raise it without one.
 *   - On slow runs the BROWSER ring shows neither session_subscribed nor
 *     screen_snapshot_received, and was not saturated (40-61 of 400).
 *
 * WHAT THIS ADDS: the SERVER side of the same window. The browser ring can only
 * say what the browser saw; "no session_subscribed" is consistent with the
 * subscribe never being sent, with it being sent and not answered, and with it
 * being answered on a socket the client had already discarded. Those are
 * different defects and the server ring separates them.
 *
 * SATURATION IS REPORTED BEFORE ANY ABSENCE IS READ. This repository has been
 * bitten twice on this exact measurement — the 400-entry browser ring and the
 * 256-entry server ring both answer "nothing happened" and "I could not record
 * it" with the same empty reading, and the second time the saturated reading
 * happened to match the hypothesis being tested. So this probe uses the
 * PER-SESSION capture (`enableDebugReplayCapture`), which is not the 256 ring,
 * and it still reports count against the requested limit and checks the
 * eventId run for gaps. An absence is only reported as an absence when the
 * capture demonstrably could have held it.
 *
 * THIS IS A DIAGNOSTIC, NOT A GATE. It asserts only that the instruments were
 * present and could have recorded, because a probe that fails on the thing it
 * is measuring stops producing the measurement. The latency itself is printed.
 *
 * Two sizes run in ONE execution against ONE build, because the 4-6x spread
 * across specs was measured across different specs, different producers and
 * different runs — which does not separate size from everything else that
 * differed. Here only the line count changes.
 *
 * ── WHAT THIS PROBE HAS ESTABLISHED, so nobody re-derives it ────────────────
 *
 * The restore is BIMODAL with no middle, and neither mode is size-dependent:
 *
 *   fast   77, 121, 139 ms
 *   slow   4170, 4215, 4219, 4228, 4246, 4407 ms
 *
 * Six slow observations spread over 237ms is a fixed wait, not variable work.
 * Whatever explains it is a timeout, and it must explain a CONSTANT — the
 * earlier reading that more output pushed the restore toward the slow mode was
 * the browser instrument's own cost, which does grow with the buffer.
 *
 * Excluded by measurement rather than argument:
 *   - payload generation: subscribe-begin to snapshot_sent is 1-4ms, every run;
 *   - client CPU: in slow runs the main-thread heartbeat's worst stall is
 *     72-126ms and there are no stalls at or above 250ms;
 *   - producer size: both sizes produce both modes;
 *   - the browser hashing instrument: the slow mode survives switching to the
 *     cheap probe;
 *   - THIS PROBE'S OWN server-side capture: serverCapture=true produced 139ms
 *     and serverCapture=false produced 4215ms, and then the reverse at the other
 *     size. Both arms produce both modes, in both directions. That one was worth
 *     checking — a probe that turns on a server-side recorder and then reports a
 *     delay is exactly the shape this issue has already been bitten by twice.
 *
 * What remains: in a slow run the socket is silent in BOTH directions from
 * +262ms to +4525ms, and then six screen-snapshot frames, the subscribed reply
 * and the terminal-delivery capability response all land within 11ms. The
 * downstream direction is held and flushes as a unit. The holder is NOT
 * identified, and this file does not name one.
 */

const SIZES = [300, 700] as const;
const REPLAY_LIMIT = 500;

interface ReplayEvent {
  eventId: number;
  recordedAt: string;
  kind: string;
  sessionId: string;
  snapshotSeq?: number;
  details?: Record<string, unknown>;
}

/**
 * Installs an UNBOUNDED sink for the browser's client-side debug events, before
 * any application script runs, and turns capture on for every session.
 *
 * Why not just read `__buildergateTerminalDebug.getEvents()`. That ring holds
 * MAX_CLIENT_DEBUG_EVENTS = 400 and keeps the LAST 400, so a 700-line producer
 * evicts exactly the mount-and-restore events this probe needs. The repository
 * has recorded that failure once already: eight dumps were all exactly 400
 * entries and all covered the final ~1.2s, and removing the cap turned them
 * into 857-982 entries in which the attach window was finally visible.
 *
 * So this tees every pushed event into an array nothing trims. The ring itself
 * still caps; `window.__bg113sink` does not. It is re-installed on every
 * navigation, which is what makes it cover the reload.
 *
 * `enabledAll` is set from the setter rather than by calling `enable()` after
 * load, because a call after load races the very events being measured.
 */
async function installUnboundedClientSink(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    // Main-thread heartbeat. The gap this probe is chasing shows up in the
    // client event log as 3.6 seconds with nothing in it, and an empty log is
    // the one reading this repository has repeatedly misread. Two very
    // different things produce it: the main thread being blocked, so no handler
    // ran and nothing could be recorded, or the frame simply not having arrived
    // while the page sat idle. A 50ms interval separates them, because a
    // blocked thread cannot service it either. Either answer is informative,
    // which is the point of adding it before running rather than after.
    const beats: number[] = [];
    (window as unknown as { __bg113beats: number[] }).__bg113beats = beats;
    setInterval(() => { beats.push(Date.now()); }, 50);

    const sink: unknown[] = [];
    (window as unknown as { __bg113sink: unknown[] }).__bg113sink = sink;
    let store: Record<string, unknown> | undefined;
    Object.defineProperty(window, '__buildergateTerminalDebug', {
      configurable: true,
      get: () => store,
      set: (value: Record<string, unknown> | undefined) => {
        store = value;
        if (!value) return;
        value.enabledAll = true;
        const events = value.events as unknown[] & { push: (...items: unknown[]) => number };
        const originalPush = events.push.bind(events);
        events.push = (...items: unknown[]): number => {
          sink.push(...items);
          return originalPush(...items);
        };
      },
    });
  });
}

interface ClientDebugEvent {
  eventId: number;
  recordedAt: string;
  kind: string;
  sessionId: string;
  details?: Record<string, unknown>;
}

interface CaptureResponse {
  sessionId: string;
  enabled: boolean;
  server: unknown[];
  replay: ReplayEvent[];
}

async function readServerCapture(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<CaptureResponse | null> {
  return page.evaluate(async ({ id, limit }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/sessions/debug-capture/${id}?limit=${limit}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  }, { id: sessionId, limit: REPLAY_LIMIT });
}

async function enableServerCapture(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<number> {
  return page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/sessions/debug-capture/${id}/enable`, { method: 'POST', headers });
    return res.status;
  }, sessionId);
}

async function readLineFingerprints(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<{ index: number; logicalLineHash: string }[]> {
  const evidence = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureRetainedState?.(id) ?? null,
    sessionId,
  );
  if (evidence === null) {
    throw new Error(
      'captureRetainedState is unavailable for this session — the instrument is absent, which is '
      + 'not the same as an empty retained range',
    );
  }
  return evidence.lineFingerprints.map(({ index, logicalLineHash }) => ({ index, logicalLineHash }));
}

/**
 * The CHEAP content-bearing wait. Polls one named line out of the normal buffer
 * via `captureTerminalScrollbackProbe`, which costs one `translateToString`.
 *
 * This exists because the expensive instrument turned out to be a material part
 * of what it was measuring: `captureRetainedState` hashes the whole retained
 * state with fnv1a64 over a canonical JSON serialisation, two BigInt operations
 * per byte, and a CPU profile of a 700-line reload put that hash and its
 * stringifier at the top of the page's self-time. The spec that produced this
 * issue's headline numbers called it every 200ms.
 */
async function waitForRestoredMarkerCheap(
  page: import('@playwright/test').Page,
  sessionId: string,
  marker: string,
  timeoutMs = 60_000,
): Promise<{ restored: boolean; elapsedMs: number; normalLength: number }> {
  const startedAt = Date.now();
  for (;;) {
    const probe = await page.evaluate(
      (id) => window.__buildergateTerminalDebug?.captureTerminalScrollbackProbe?.(
        id,
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      ) ?? null,
      sessionId,
    );
    if (probe === null) {
      throw new Error(
        'captureTerminalScrollbackProbe is unavailable — the instrument is absent, which is not '
        + 'the same as the line not being back',
      );
    }
    // Exact match on the trimmed line, not `includes`. `translateToString(true)`
    // trims the right side, so a marker written with a trailing space never
    // matches — measured, this probe reported restored=false after 60028ms on a
    // session whose oldest line was present the whole time, which is an
    // instrument failure wearing the costume of the defect being measured.
    // `includes('RETAINED-1')` is no good either: it matches RETAINED-10 and
    // RETAINED-100, neither of which is the oldest line.
    if (probe.lines.some(line => line.text.trim() === marker)) {
      return { restored: true, elapsedMs: Date.now() - startedAt, normalLength: probe.normalLength };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { restored: false, elapsedMs: Date.now() - startedAt, normalLength: probe.normalLength };
    }
    await page.waitForTimeout(100);
  }
}

/**
 * Waits for an observable end state — the oldest pre-reload line being back —
 * never for a reading to stop moving. A stability poll cannot tell "finished"
 * from "has not started", which is the instrument failure that produced the
 * number this issue exists to explain.
 *
 * THIS IS THE EXPENSIVE INSTRUMENT. It is kept so the two can be compared in
 * one execution; it is not the measurement of record any more.
 */
async function waitForRestoredLine(
  page: import('@playwright/test').Page,
  sessionId: string,
  oldestLogicalLineHash: string,
  timeoutMs = 60_000,
): Promise<{ restored: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    const fingerprints = await readLineFingerprints(page, sessionId);
    if (fingerprints.some(line => line.logicalLineHash === oldestLogicalLineHash)) {
      return { restored: true, elapsedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { restored: false, elapsedMs: Date.now() - startedAt };
    }
    await page.waitForTimeout(100);
  }
}

/**
 * `eventId` is `++this.replayEventCounter` on the router, one counter for every
 * session it serves (WsRouter.ts). So a per-session capture has gaps in its id
 * run BY CONSTRUCTION, and a gap says another session was served in between —
 * not that anything was dropped. The first version of this probe treated gaps
 * as truncation and printed a "capture truncated" banner on runs that were
 * nowhere near the limit. That banner is worse than no banner: it tells the
 * next reader they may not read an absence they in fact may read.
 *
 * Truncation of THIS capture has exactly one signal, `atLimit` — the endpoint
 * returns `events.slice(-limit)`. Gaps are reported as a diagnostic only.
 */
function describeSaturation(events: ReplayEvent[]): {
  count: number;
  limit: number;
  atLimit: boolean;
  firstEventId: number | null;
  lastEventId: number | null;
  idGapsFromOtherSessions: number;
} {
  const ids = events.map(event => event.eventId);
  let idGapsFromOtherSessions = 0;
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index] !== ids[index - 1] + 1) idGapsFromOtherSessions += 1;
  }
  return {
    count: events.length,
    limit: REPLAY_LIMIT,
    atLimit: events.length >= REPLAY_LIMIT,
    firstEventId: ids[0] ?? null,
    lastEventId: ids.at(-1) ?? null,
    idGapsFromOtherSessions,
  };
}

test.describe('issue #113 — restore latency probe v5 (server replay ring)', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop refresh path');
  });

  /**
   * Whether the SERVER-side per-session capture is enabled.
   *
   * It has to be a variable, not a constant. This probe turns it on to read the
   * server's replay timeline, and `retained-history-select-copy.spec.ts` — which
   * does not — reported 1330ms on the same build while this probe reported
   * 4170-4246ms. That is a 3x difference between two specs whose only visible
   * difference is this switch, and reading either number as the product's
   * without testing it would repeat, one level up, exactly the mistake this
   * probe just finished correcting in the browser instrument.
   */
  for (const lines of SIZES) {
    for (const serverCapture of [true, false]) {
    for (const useCheapProbe of [true, false]) {
    test(`probe v5: restore at ${lines} lines, ${useCheapProbe ? 'cheap' : 'hashing'} instrument, `
      + `serverCapture=${serverCapture}`, async ({ page }) => {
      test.setTimeout(300_000);
      await installUnboundedClientSink(page);
      await login(page);
      await waitForTerminal(page);
      const workspace = await activateSelectionWorkspace(page, 1);
      const [session] = workspace.sessionIds;
      try {
        if (serverCapture) {
          const enableStatus = await enableServerCapture(page, session);
          expect(
            enableStatus,
            'the server-side per-session replay capture could not be enabled, so every absence '
              + 'below would be an absence of recording rather than an absence of events',
          ).toBe(204);
        }

        await sendCommandAndWaitForMarker(
          page, session,
          `node -e "for(let i=1;i<=${lines};i++)console.log('RETAINED-'+i)"`,
          `RETAINED-${lines}`,
          { perAttemptTimeoutMs: 60_000 },
        );

        const before = await readLineFingerprints(page, session);
        const oldest = before[0];
        void oldest;
        expect(
          oldest,
          'no retained lines to fingerprint before the reload, so the restore below would have '
            + 'nothing to wait for and the latency reading would be meaningless',
        ).toBeTruthy();

        const preReload = await readServerCapture(page, session);
        const preMark = preReload?.replay.at(-1)?.eventId ?? 0;

        // Every WebSocket frame, per socket, with arrival times. The client log
        // shows nothing at all between +150ms and +4192ms while the main thread
        // is demonstrably idle, and the server recorded the snapshot as sent at
        // +4ms. Exactly one of two things is true — the socket carried nothing,
        // or it carried the frame and the page did not act on it — and no
        // instrument used so far can tell them apart. This one can, and it needs
        // no product change, so it cannot perturb what it measures the way the
        // hashing probe did.
        const wsFrames: { at: number; dir: 'in' | 'out'; url: string; head: string }[] = [];
        const wsOpened: { at: number; url: string }[] = [];
        page.on('websocket', (socket) => {
          wsOpened.push({ at: Date.now(), url: socket.url() });
          socket.on('framereceived', (frame) => {
            wsFrames.push({
              at: Date.now(),
              dir: 'in',
              url: socket.url(),
              head: String(frame.payload).slice(0, 90),
            });
          });
          socket.on('framesent', (frame) => {
            wsFrames.push({
              at: Date.now(),
              dir: 'out',
              url: socket.url(),
              head: String(frame.payload).slice(0, 90),
            });
          });
        });

        // A CPU profile over the reload window. The heartbeat says the main
        // thread stalls; it cannot say inside what. Reading the apply path and
        // guessing would be the same move this issue already retracted once.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');

        const reloadAt = Date.now();
        await page.reload();
        await waitForTerminal(page);
        const restore = useCheapProbe
          ? await waitForRestoredMarkerCheap(page, session, 'RETAINED-1')
          : await waitForRestoredLine(page, session, oldest.logicalLineHash);

        let profileTop: { fn: string; selfMs: number }[] = [];
        try {
          const { profile } = await cdp.send('Profiler.stop') as unknown as {
            profile: {
              nodes: {
                id: number;
                callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
              }[];
              samples?: number[];
              timeDeltas?: number[];
            };
          };
          const byNode = new Map<number, number>();
          const samples = profile.samples ?? [];
          const deltas = profile.timeDeltas ?? [];
          for (let index = 0; index < samples.length; index += 1) {
            byNode.set(samples[index], (byNode.get(samples[index]) ?? 0) + (deltas[index] ?? 0));
          }
          const nameOf = new Map(profile.nodes.map(node => [
            node.id,
            `${node.callFrame.functionName || '(anonymous)'} @ ${node.callFrame.url.split('/').pop()}`
              + `:${node.callFrame.lineNumber}:${node.callFrame.columnNumber}`,
          ]));
          profileTop = [...byNode.entries()]
            .map(([id, us]) => ({ fn: nameOf.get(id) ?? `node#${id}`, selfMs: Math.round(us / 1000) }))
            .sort((a, b) => b.selfMs - a.selfMs)
            .slice(0, 15);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.log(`[#113 v5] profiler unavailable: ${(error as Error).message}`);
        }
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] profile top self-time:\n${profileTop.map(row => `[#113 v5]   ${String(row.selfMs).padStart(6)}ms  ${row.fn}`).join('\n')}`);

        const post = await readServerCapture(page, session);

        // Report the instrument's own state BEFORE reading anything from it.
        // Only when there IS an instrument: the serverCapture=false arm exists
        // precisely to run without one, and asserting it is enabled there made
        // the control arm fail on its own premise — the control could not run,
        // which is the one outcome that carries no information either way.
        if (serverCapture) {
          expect(
            post,
            'the server capture endpoint returned nothing after the reload; this run measured '
              + 'nothing and must not be read as the server having recorded nothing',
          ).not.toBeNull();
          expect(
            post?.enabled,
            'the server capture was disabled across the reload, so the events below are an '
              + 'arbitrary suffix rather than the reload window',
          ).toBe(true);
        }

        const all = post?.replay ?? [];
        const saturation = describeSaturation(all);
        const window = all.filter(event => event.eventId > preMark);

        // The segment the first run of this probe could not see. Its event clock
        // started at the first post-reload event, which silently treated
        // "the subscribe reached the server late" and "the server answered late"
        // as the same reading. They are different defects.
        const firstEventAt = window[0] ? Date.parse(window[0].recordedAt) : null;
        const reloadToFirstEventMs = firstEventAt === null ? null : firstEventAt - reloadAt;

        // eslint-disable-next-line no-console
        console.log(`[#113 v5] lines=${lines} instrument=${useCheapProbe ? 'cheap' : 'hashing'}`
          + ` serverCapture=${serverCapture}`
          + ` restored=${restore.restored} after ${restore.elapsedMs}ms`
          + ` | reload->firstServerEvent=${reloadToFirstEventMs}ms`
          + ` | preReloadLines=${before.length}`
          + ` | capture ${JSON.stringify(saturation)}`
          + ` | eventsAfterReload=${window.length}`);

        if (saturation.atLimit) {
          // eslint-disable-next-line no-console
          console.log('[#113 v5] CAPTURE AT LIMIT — truncated, no absence may be read from this run');
        }

        const base = firstEventAt ?? reloadAt;
        for (const event of window) {
          // eslint-disable-next-line no-console
          console.log(`[#113 v5]   +${String(Date.parse(event.recordedAt) - base).padStart(6)}ms `
            + `${event.kind}`
            + (event.snapshotSeq === undefined ? '' : ` seq=${event.snapshotSeq}`)
            + (event.details ? ` ${JSON.stringify(event.details).slice(0, 300)}` : ''));
        }

        // The browser half of the same window. The server says the snapshot was
        // on the wire within 4ms of subscribe; this says what the browser did
        // with it, which is the only place the remaining seconds can be.
        const clientEvents = await page.evaluate(() => {
          const sink = (window as unknown as { __bg113sink?: unknown[] }).__bg113sink ?? [];
          return sink as ClientDebugEvent[];
        });
        const forSession = clientEvents.filter(event => event.sessionId === session);
        const clientBase = forSession[0] ? Date.parse(forSession[0].recordedAt) : reloadAt;
        // NO KIND FILTER. A filter here would decide in advance what may be
        // in the gap, and the gap is the whole question. The first version of
        // this dump filtered on snapshot|subscribe|mount|... and printed seven
        // lines out of sixty-two, which showed the gap without showing anything
        // inside it.
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] client sink total=${clientEvents.length} forSession=${forSession.length}`
          + ' (unbounded; the 400-entry ring is NOT the source here)');
        const clientKinds = new Map<string, number>();
        for (const event of forSession) clientKinds.set(event.kind, (clientKinds.get(event.kind) ?? 0) + 1);
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] clientKinds=${JSON.stringify([...clientKinds.entries()].sort((a, b) => b[1] - a[1]))}`);
        for (const event of forSession.slice(0, 80)) {
          // eslint-disable-next-line no-console
          console.log(`[#113 v5]   client +${String(Date.parse(event.recordedAt) - clientBase).padStart(6)}ms ${event.kind}`
            + (event.details ? ` ${JSON.stringify(event.details).slice(0, 220)}` : ''));
        }

        const framesAfterReload = wsFrames.filter(frame => frame.at >= reloadAt);
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] sockets opened after reload: ${JSON.stringify(
          wsOpened.filter(entry => entry.at >= reloadAt).map(entry => ({
            atMs: entry.at - reloadAt,
            url: entry.url.replace(/^.*\/\//, ''),
          })),
        )}`);
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] ws frames after reload: ${framesAfterReload.length}`);
        for (const frame of framesAfterReload.slice(0, 45)) {
          // eslint-disable-next-line no-console
          console.log(`[#113 v5]   ws +${String(frame.at - reloadAt).padStart(6)}ms ${frame.dir} `
            + `${frame.url.slice(-28)} ${frame.head.replace(/\s+/g, ' ')}`);
        }

        const beats = await page.evaluate(
          () => (window as unknown as { __bg113beats?: number[] }).__bg113beats ?? [],
        );
        let worstStallMs = 0;
        let worstStallAt = 0;
        for (let index = 1; index < beats.length; index += 1) {
          const delta = beats[index] - beats[index - 1];
          if (delta > worstStallMs) {
            worstStallMs = delta;
            worstStallAt = beats[index - 1];
          }
        }
        const stalls = [];
        for (let index = 1; index < beats.length; index += 1) {
          const delta = beats[index] - beats[index - 1];
          if (delta >= 250) stalls.push({ atMsAfterReload: beats[index - 1] - reloadAt, stallMs: delta });
        }
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] heartbeat beats=${beats.length} worstStall=${worstStallMs}ms`
          + ` at +${worstStallAt - reloadAt}ms after reload`
          + ` | stalls>=250ms ${JSON.stringify(stalls.slice(0, 12))}`);

        const kinds = new Map<string, number>();
        for (const event of window) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
        // eslint-disable-next-line no-console
        console.log(`[#113 v5] kinds=${JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1]))}`);

        // The only gate: the restore must eventually land, because a probe that
        // measured a session which never restored is measuring a different
        // defect from the one this issue names.
        expect(
          restore.restored,
          `the retained range never came back within 60s at ${lines} lines, which is a different `
            + 'and worse defect than the latency this probe exists to time',
        ).toBe(true);
      } finally {
        await cleanupSelectionWorkspace(page.context(), workspace);
      }
    });
    }
    }
  }
});

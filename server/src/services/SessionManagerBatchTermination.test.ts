import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';
import type { ProcessTreeTerminator } from '../utils/processTreeTerminator.js';

/**
 * PERF-BGSTAB-015 AC-1 — deleting a workspace does not wait once per tab.
 *
 * On Windows a verified tree termination costs about two seconds per session
 * (a PowerShell identity read, a PowerShell tree kill, a settle read), and the
 * batch used to run them one after another, so a workspace with four terminals
 * held the delete for eight seconds. The terminations share nothing, so the
 * batch runs them side by side up to a fixed limit.
 *
 * Concurrency is read from the terminator itself (how many calls are in flight
 * at once) rather than from a stopwatch, so a slow machine cannot make a
 * sequential batch look parallel or the other way round.
 */

/** maxTabsPerWorkspace's default: a whole default workspace goes at once. */
const WHOLE_WORKSPACE = 8;

function createManager(terminator: ProcessTreeTerminator): SessionManager {
  let nextPid = 5000;
  const deps: any = {
    platform: 'linux',
    processTreeTerminator: terminator,
    spawnPty: ((spawnShell: string, _args: string[], options: { cols?: number; rows?: number }) => ({
      pid: nextPid++,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      process: spawnShell,
      handleFlowControl: false,
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    })) as any,
  };
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024,
      shell: 'bash',
    },
    session: {
      idleDelayMs: 40,
      runningDelayMs: 40,
      processCleanup: { mode: 'enforce', gracefulWaitMs: 750, forceWaitMs: 1500, descendantSampleLimit: 64 },
    },
  } as any, deps);
  (manager as any).isCommandAvailable = (cmd: string) => ['bash', 'sh'].includes(cmd.toLowerCase());
  return manager;
}

/**
 * A terminator that holds each call for `delayFor(rootPid)` ms and records the
 * most calls it ever had in flight at once. Every tree is reported as leaving
 * its root behind plus one unverified pid, so the descendant totals have
 * something to add up.
 */
function countingTerminator(delayFor: (rootPid: number | null) => number) {
  let inFlight = 0;
  let maxInFlight = 0;
  const finished: Array<number | null> = [];
  const terminator: ProcessTreeTerminator = {
    async inspect() {
      throw new Error('inspect is not called directly by terminateSession');
    },
    async terminate(metadata) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, delayFor(metadata.rootPid)));
      inFlight -= 1;
      finished.push(metadata.rootPid);
      return {
        status: 'degraded',
        rootPid: metadata.rootPid,
        terminatedPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        remainingPids: metadata.rootPid === null ? [] : [metadata.rootPid],
        unverifiedPids: [9000],
        method: 'posix-leaf-first',
      };
    },
  };
  return {
    terminator,
    get maxInFlight() { return maxInFlight; },
    finished,
  };
}

function createSessions(manager: SessionManager, count: number): string[] {
  return Array.from({ length: count }, (_, index) => manager.createSession(`Tab ${index + 1}`, 'bash', process.cwd()).id);
}

test('PERF-BGSTAB-015 AC-1: a workspace\'s sessions are terminated side by side, not one after another', async () => {
  const counter = countingTerminator(() => 60);
  const manager = createManager(counter.terminator);
  const ids = createSessions(manager, 4);

  const result = await manager.terminateMultipleSessions(ids, { reason: 'workspace-delete' });

  assert.equal(counter.maxInFlight, 4, 'all four terminations were in flight at once');
  assert.equal(result.terminated, 4);
  for (const id of ids) assert.equal(manager.getSession(id), null, `${id} was finalized`);
});

test('PERF-BGSTAB-015 AC-1: the batch never runs more than a whole workspace at once', async () => {
  const counter = countingTerminator(() => 30);
  const manager = createManager(counter.terminator);
  const ids = createSessions(manager, WHOLE_WORKSPACE + 4);

  const result = await manager.terminateMultipleSessions(ids, { reason: 'shutdown' });

  assert.equal(counter.maxInFlight, WHOLE_WORKSPACE, 'a full default workspace runs at once and the rest waits its turn');
  assert.equal(result.attempted, WHOLE_WORKSPACE + 4);
  assert.equal(result.terminated, WHOLE_WORKSPACE + 4);
});

test('PERF-BGSTAB-015 AC-1: the batch result stays in input order when terminations finish out of order', async () => {
  // The first session is the slowest, so completion order is the reverse of
  // input order; the result must not follow completion order.
  let firstPid: number | null = null;
  const counter = countingTerminator(rootPid => {
    if (firstPid === null) firstPid = rootPid;
    return rootPid === firstPid ? 90 : 10;
  });
  const manager = createManager(counter.terminator);
  const [a, b, c] = createSessions(manager, 3);

  const result = await manager.terminateMultipleSessions(
    [a, 'missing-1', b, 'missing-2', c],
    { reason: 'workspace-delete' },
  );

  assert.notEqual(counter.finished[0], firstPid, 'the first session finished after the others');
  assert.deepEqual(result, {
    attempted: 5,
    terminated: 3,
    missing: ['missing-1', 'missing-2'],
    remainingVerifiedDescendants: 3,
    remainingUnverifiedDescendants: 3,
  });
});

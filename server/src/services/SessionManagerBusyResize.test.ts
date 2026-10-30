import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeadlessTerminalState } from '../utils/headlessTerminal.js';
import { SessionManager } from './SessionManager.js';
import { createCloseSignal } from '../utils/closeSignal.js';

/**
 * A retained resize must not wait behind output that never stops arriving.
 *
 * The resize was queued onto the headless write chain whenever any write was
 * pending. For a session with continuous output that queue is never empty, so
 * the geometry the client asked for lands late — and until it lands,
 * `getScreenRepair` compares the client's expected geometry against the
 * still-old applied geometry and answers `geometry-mismatch`. Measured over
 * eight workspace bounces with a codex TUI running: every
 * `screen_repair_reconnect_required` carried that reason, and none carried
 * `headless-busy`.
 *
 * Resizing between writes is safe: the queued output lands into the resized
 * buffer exactly as it would have had the resize arrived a moment earlier. Only
 * a write that is mid-apply, and an already queued resize whose order must be
 * kept, are reasons to queue.
 */

interface ResizeSessionData {
  cols: number;
  rows: number;
  pendingHeadlessWrites: number;
  headlessApplyInFlight: number;
  pendingRetainedResizes: number;
  headlessWriteChain: Promise<void>;
  headlessHealth: string;
  headless: unknown;
}

interface ManagerInternals {
  sessions: Map<string, ResizeSessionData>;
  resize: (id: string, cols: number, rows: number) => boolean;
  ensureRetainedTerminalSessionState: (data: unknown) => { mode: string };
}

const SESSION_ID = 'busy-resize';

function managerWithSession(overrides: Partial<ResizeSessionData>): ManagerInternals {
  const manager = new SessionManager() as unknown as ManagerInternals;
  assert.ok(manager.sessions instanceof Map, 'SessionManager.sessions is no longer a Map');
  assert.equal(typeof manager.resize, 'function', 'SessionManager.resize is gone');

  const data = {
    session: { id: SESSION_ID },
    cols: 80,
    rows: 24,
    pendingHeadlessWrites: 0,
    headlessApplyInFlight: 0,
    pendingRetainedResizes: 0,
    // Never settles: a session under continuous output holds a chain like this.
    headlessWriteChain: new Promise<void>(() => {}),
    headlessHealth: 'healthy',
    headlessCloseSignal: createCloseSignal(),
    headless: createHeadlessTerminalState({ cols: 80, rows: 24, scrollbackLines: 100 }),
    screenSeq: 1,
    authorityRevision: 1,
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    authorityEpoch: 'epoch-1',
    snapshotCache: null,
    pty: { resize() {} },
    ...overrides,
  } as unknown as ResizeSessionData;
  manager.sessions.set(SESSION_ID, data);

  const stored = manager.sessions.get(SESSION_ID)!;
  for (const field of ['pendingHeadlessWrites', 'headlessApplyInFlight', 'pendingRetainedResizes'] as const) {
    assert.equal(typeof stored[field], 'number', `${field} is not a number`);
  }
  return manager;
}

function shadowMode(manager: ManagerInternals): void {
  // The queueing path under test is the retained/shadow one.
  const data = manager.sessions.get(SESSION_ID)!;
  const retained = manager.ensureRetainedTerminalSessionState(data);
  retained.mode = 'shadow';
}

test('queued output alone does not delay a resize', () => {
  const manager = managerWithSession({ pendingHeadlessWrites: 5, headlessApplyInFlight: 0 });
  shadowMode(manager);

  assert.equal(manager.resize(SESSION_ID, 100, 30), true);

  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.cols, 100, 'the resize waited behind output that never drains');
  assert.equal(data.rows, 30);
});

test('a write in flight defers the resize', () => {
  const manager = managerWithSession({ pendingHeadlessWrites: 1, headlessApplyInFlight: 1 });
  shadowMode(manager);

  assert.equal(manager.resize(SESSION_ID, 100, 30), true);

  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.cols, 80, 'a half-applied write was resized underneath');
  assert.equal(data.rows, 24);
  assert.equal(data.pendingRetainedResizes, 1, 'the deferred resize was not recorded');
});

test('a resize already queued keeps the next one behind it', () => {
  const manager = managerWithSession({ pendingHeadlessWrites: 1, pendingRetainedResizes: 1 });
  shadowMode(manager);

  assert.equal(manager.resize(SESSION_ID, 100, 30), true);

  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.cols, 80, 'a later resize overtook one already queued');
  assert.equal(data.pendingRetainedResizes, 2);
});

test('an idle session still resizes immediately', () => {
  const manager = managerWithSession({});
  shadowMode(manager);

  assert.equal(manager.resize(SESSION_ID, 120, 40), true);

  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.cols, 120);
  assert.equal(data.rows, 40);
});

test('REL-BGSTAB-047 AC-4: a resize back to the applied size is not skipped while another one is queued', async () => {
  // #145: the grid redraw nudge sends rows-1 then rows. With a write in flight the
  // first one is queued and cols/rows still hold the old size, so the second was
  // judged "unchanged" and skipped -- and the queued one then left the PTY a row short.
  let release: () => void = () => {};
  const chain = new Promise<void>((resolve) => { release = resolve; });
  const ptySizes: string[] = [];
  const manager = managerWithSession({
    pendingHeadlessWrites: 1,
    headlessApplyInFlight: 1,
    headlessWriteChain: chain,
    pty: { resize(cols: number, rows: number) { ptySizes.push(`${cols}x${rows}`); } },
  } as unknown as Partial<ResizeSessionData>);
  shadowMode(manager);

  assert.equal(manager.resize(SESSION_ID, 80, 23), true);
  assert.equal(manager.resize(SESSION_ID, 80, 24), true);
  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.pendingRetainedResizes, 2, 'the restore was skipped as unchanged');

  // A repeat of the last queued size is still a no-op.
  assert.equal(manager.resize(SESSION_ID, 80, 24), true);
  assert.equal(data.pendingRetainedResizes, 2);

  data.headlessApplyInFlight = 0;
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ptySizes, ['80x23', '80x24']);
  assert.equal(data.rows, 24);
});

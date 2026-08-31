import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeadlessTerminalState } from '../utils/headlessTerminal.js';
import { VALIDATION_LIMITS } from '../utils/constants.js';
import { SessionManager } from './SessionManager.js';

/**
 * Terminal dimensions reach the PTY unchecked.
 *
 * `WsRouter.handleResize` passes the client's numbers straight to
 * `SessionManager.resize`, which passes them to `pty.resize`. The only
 * `cols <= 0` guard in the repository sits on the screen-repair message, a
 * different type on a different path, and `VALIDATION_LIMITS.MAX_COLS` /
 * `MAX_ROWS` have no use sites at all.
 *
 * Two shapes have to be told apart. A non-positive or non-integer size is
 * structurally invalid and cannot be honoured, so it is refused. An oversized
 * one is a real request the server simply will not carry — clamping it keeps
 * the terminal working where refusing would leave the client's geometry
 * permanently disagreeing with the server's.
 *
 * `MIN_COLS` / `MIN_ROWS` are deliberately not enforced: raising a narrow
 * terminal to 20 columns would make the PTY wrap at a width the browser does
 * not render, which is worse than honouring the small size.
 */

interface ResizeSessionData {
  cols: number;
  rows: number;
  headlessApplyInFlight: number;
  pendingRetainedResizes: number;
  pendingHeadlessWrites: number;
}

interface ManagerInternals {
  sessions: Map<string, ResizeSessionData>;
  resize: (id: string, cols: number, rows: number) => boolean;
}

const SESSION_ID = 'resize-bounds';

function setup(): { manager: ManagerInternals; ptyCalls: Array<{ cols: number; rows: number }> } {
  const manager = new SessionManager() as unknown as ManagerInternals;
  assert.ok(manager.sessions instanceof Map, 'SessionManager.sessions is no longer a Map');
  assert.equal(typeof manager.resize, 'function', 'SessionManager.resize is gone');

  const ptyCalls: Array<{ cols: number; rows: number }> = [];
  const data = {
    cols: 80,
    rows: 24,
    headlessApplyInFlight: 0,
    pendingRetainedResizes: 0,
    pendingHeadlessWrites: 0,
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: { promise: new Promise<void>(() => {}), resolve: () => {} },
    headlessHealth: 'healthy',
    headless: createHeadlessTerminalState({ cols: 80, rows: 24, scrollbackLines: 100 }),
    screenSeq: 1,
    authorityRevision: 1,
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    authorityEpoch: 'epoch-1',
    snapshotCache: null,
    pty: { resize(cols: number, rows: number) { ptyCalls.push({ cols, rows }); } },
  } as unknown as ResizeSessionData;
  manager.sessions.set(SESSION_ID, data);

  const stored = manager.sessions.get(SESSION_ID)!;
  assert.equal(typeof stored.cols, 'number', 'cols is not a number');
  assert.equal(typeof stored.rows, 'number', 'rows is not a number');
  return { manager, ptyCalls };
}

test('an ordinary resize reaches the pty unchanged', () => {
  const { manager, ptyCalls } = setup();
  assert.equal(manager.resize(SESSION_ID, 120, 40), true);
  assert.deepEqual(ptyCalls, [{ cols: 120, rows: 40 }]);
});

test('the documented maximum is honoured exactly', () => {
  const { manager, ptyCalls } = setup();
  assert.equal(manager.resize(SESSION_ID, VALIDATION_LIMITS.MAX_COLS, VALIDATION_LIMITS.MAX_ROWS), true);
  assert.deepEqual(ptyCalls, [{ cols: VALIDATION_LIMITS.MAX_COLS, rows: VALIDATION_LIMITS.MAX_ROWS }]);
});

test('an oversized resize is clamped rather than refused', () => {
  const { manager, ptyCalls } = setup();
  assert.equal(manager.resize(SESSION_ID, 70_000, 50_000), true);
  assert.deepEqual(
    ptyCalls,
    [{ cols: VALIDATION_LIMITS.MAX_COLS, rows: VALIDATION_LIMITS.MAX_ROWS }],
    'an absurd geometry reached the pty',
  );
  const data = manager.sessions.get(SESSION_ID)!;
  assert.equal(data.cols, VALIDATION_LIMITS.MAX_COLS, 'the session recorded the unclamped width');
  assert.equal(data.rows, VALIDATION_LIMITS.MAX_ROWS);
});

test('a non-positive resize is refused and never reaches the pty', () => {
  for (const [cols, rows] of [[0, 24], [80, 0], [-1, 24], [80, -5]] as const) {
    const { manager, ptyCalls } = setup();
    assert.equal(manager.resize(SESSION_ID, cols, rows), false, `accepted ${cols}x${rows}`);
    assert.deepEqual(ptyCalls, [], `${cols}x${rows} reached the pty`);
    assert.equal(manager.sessions.get(SESSION_ID)!.cols, 80, `${cols}x${rows} changed the session`);
  }
});

test('a non-integer or non-finite resize is refused', () => {
  for (const [cols, rows] of [[80.5, 24], [80, Number.NaN], [Number.POSITIVE_INFINITY, 24]] as const) {
    const { manager, ptyCalls } = setup();
    assert.equal(manager.resize(SESSION_ID, cols, rows), false, `accepted ${cols}x${rows}`);
    assert.deepEqual(ptyCalls, [], `${cols}x${rows} reached the pty`);
  }
});

test('a narrow terminal is honoured, not raised to the unused minimum', () => {
  const { manager, ptyCalls } = setup();
  assert.equal(manager.resize(SESSION_ID, 10, 3), true);
  assert.deepEqual(
    ptyCalls,
    [{ cols: 10, rows: 3 }],
    'a narrow geometry was widened, so the pty would wrap where the browser does not',
  );
});

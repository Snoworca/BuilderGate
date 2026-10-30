import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeadlessTerminalState } from '../utils/headlessTerminal.js';
import { SessionManager } from './SessionManager.js';
import { createCloseSignal } from '../utils/closeSignal.js';

/**
 * REL-BGSTAB-058 AC-2: the PTY is shared, and a browser terminal hidden behind
 * another tab does not see another screen or device resize it. The server tells
 * every subscriber when the size really changes, so the browser can redraw by
 * resizing only when the program may have drawn for another size.
 */

interface ManagerInternals {
  sessions: Map<string, unknown>;
  resize: (id: string, cols: number, rows: number) => boolean;
  broadcastWs: (sessionId: string, event: string, payload: object) => void;
}

const SESSION_ID = 'resize-broadcast';

function setup(): { manager: ManagerInternals; events: Array<{ sessionId: string; event: string; payload: object }> } {
  const manager = new SessionManager() as unknown as ManagerInternals;
  const events: Array<{ sessionId: string; event: string; payload: object }> = [];
  manager.broadcastWs = (sessionId, event, payload) => { events.push({ sessionId, event, payload }); };
  manager.sessions.set(SESSION_ID, {
    cols: 80,
    rows: 24,
    headlessApplyInFlight: 0,
    pendingRetainedResizes: 0,
    pendingHeadlessWrites: 0,
    headlessWriteChain: Promise.resolve(),
    headlessCloseSignal: createCloseSignal(),
    headlessHealth: 'healthy',
    headless: createHeadlessTerminalState({ cols: 80, rows: 24, scrollbackLines: 100 }),
    screenSeq: 1,
    authorityRevision: 1,
    parserComplete: true,
    pendingEscapeTailAnsi: '',
    authorityEpoch: 'epoch-1',
    snapshotCache: null,
    pty: { resize() {} },
  });
  return { manager, events };
}

test('REL-BGSTAB-058 AC-2: a real size change is sent to the session subscribers', () => {
  const { manager, events } = setup();
  assert.equal(manager.resize(SESSION_ID, 120, 40), true);
  assert.deepEqual(events, [{ sessionId: SESSION_ID, event: 'session:resized', payload: { cols: 120, rows: 40 } }]);
});

test('REL-BGSTAB-058 AC-2: a resize to the size the PTY already has sends nothing', () => {
  const { manager, events } = setup();
  assert.equal(manager.resize(SESSION_ID, 80, 24), true);
  assert.deepEqual(events, []);
});

test('REL-BGSTAB-058 AC-2: a refused size sends nothing', () => {
  const { manager, events } = setup();
  assert.equal(manager.resize(SESSION_ID, 0, 24), false);
  assert.equal(manager.resize('no-such-session', 100, 30), false);
  assert.deepEqual(events, []);
});

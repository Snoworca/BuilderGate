// FR-MSG-002 AC-2, FR-MSG-016: host sequencing; agent messages are counted but never held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeRoom, sequenceMessage } from './sequencing.js';
import type { Room, RoomMessage } from './types.js';

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'rm_1', name: 'r', hostNode: 'a', createdBy: 'a', createdAt: '2026-11-07T00:00:00.000Z',
    settings: { invitePolicy: 'auto', holdLimit: 20 }, people: [], sessions: [],
    agentRun: 0, held: false, lastSeq: 0, ...overrides,
  };
}

function message(kind: 'human' | 'agent' | 'system', id = Math.random().toString(36)): RoomMessage {
  return { seq: null, clientMsgId: id, roomId: 'rm_1', at: '2026-11-07T00:00:00.000Z', from: { node: 'a', kind }, to: [], text: 'x' };
}

test('FR-MSG-002 AC-2: the host gives the next sequence number', () => {
  const first = sequenceMessage(room(), message('human'));
  assert.equal(first.message.seq, 1);
  assert.equal(first.room.lastSeq, 1);
  const second = sequenceMessage(first.room, message('system'));
  assert.equal(second.message.seq, 2);
});

test('FR-MSG-016 AC-1: agent messages are never held, however many run; each carries its run count', () => {
  let current = room({ settings: { invitePolicy: 'auto', holdLimit: 3 } });
  const held: boolean[] = [];
  const runs: Array<number | undefined> = [];
  for (let i = 0; i < 5; i += 1) {
    const result = sequenceMessage(current, message('agent'));
    current = result.room;
    held.push(result.message.held === true);
    runs.push(result.message.agentRun);
  }
  assert.deepEqual(held, [false, false, false, false, false]);
  assert.deepEqual(runs, [1, 2, 3, 4, 5]);
  assert.equal(current.held, false);
  assert.equal(sequenceMessage(room(), message('human')).message.agentRun, undefined);
});

test('FR-MSG-016 AC-3: a room left held by an older version is freed by the next agent message', () => {
  const next = sequenceMessage(room({ agentRun: 25, held: true }), message('agent'));
  assert.equal(next.room.held, false);
  assert.equal(next.message.held, undefined);
});

test('FR-MSG-016: a human message or resume resets the run; system messages do not count', () => {
  let current = room({ agentRun: 25, held: true });
  const sys = sequenceMessage(current, message('system'));
  assert.equal(sys.room.agentRun, 25);
  assert.equal(sys.message.held, undefined);
  current = sequenceMessage(current, message('human')).room;
  assert.equal(current.agentRun, 0);
  assert.equal(current.held, false);
  assert.deepEqual(resumeRoom(room({ agentRun: 30, held: true })), room({ agentRun: 0, held: false }));
});

test('FR-MSG-002 AC-2: sequencing does not mutate its inputs', () => {
  const before = room();
  const input = message('agent');
  sequenceMessage(before, input);
  assert.equal(before.lastSeq, 0);
  assert.equal(input.seq, null);
});

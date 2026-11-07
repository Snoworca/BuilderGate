// FR-MSG-002 AC-3: rooms, logs and outboxes survive a restart (contract §2 files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileRoomStore, createMemoryRoomStore } from './roomStore.js';
import type { RoomMessage } from './types.js';

const message = (seq: number): RoomMessage => ({
  seq, clientMsgId: `m${seq}`, roomId: 'rm_abc', at: '2026-11-07T00:00:00.000Z', from: { node: 'a', kind: 'human' }, to: [], text: `t${seq}`,
});

for (const [label, make] of [
  ['file', (dir: string) => createFileRoomStore(dir)],
  ['memory', () => createMemoryRoomStore()],
] as const) {
  test(`FR-MSG-002 AC-3 (${label}): log append, outbox, rooms, invites and settings read back`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-rooms-'));
    try {
      const store = make(dir);
      await store.appendLog('rm_abc', [message(1), message(2)]);
      await store.appendLog('rm_abc', [message(3)]);
      assert.deepEqual((await store.readLog('rm_abc')).map((m) => m.seq), [1, 2, 3]);
      await store.writeLog('rm_abc', [message(9)]);
      assert.deepEqual((await store.readLog('rm_abc')).map((m) => m.seq), [9]);
      await store.writeOutbox('rm_abc', [{ ...message(0), seq: null }]);
      assert.equal((await store.readOutbox('rm_abc')).length, 1);
      await store.writeOutbox('rm_abc', []);
      assert.deepEqual(await store.readOutbox('rm_abc'), []);
      await store.saveState({ rooms: [], invites: [], approvals: [] });
      await store.saveSettings({ webhookUrl: 'https://chat.example/hook' });
      const loaded = await store.load();
      assert.deepEqual(loaded, { rooms: [], invites: [], approvals: [], settings: { webhookUrl: 'https://chat.example/hook' } });
      assert.deepEqual(await store.readLog('rm_none'), []);
      await store.writeReceipts('rm_abc', { '3': { targets: 2, delivered: 1, pasted: 1, nodes: ['a'], sessions: ['a::s1'] } });
      assert.deepEqual(await store.readReceipts('rm_abc'), { '3': { targets: 2, delivered: 1, pasted: 1, nodes: ['a'], sessions: ['a::s1'] } });
      assert.deepEqual(await store.readReceipts('rm_none'), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('FR-MSG-002 AC-3: the file store writes one jsonl line per message under rooms/', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-rooms-'));
  try {
    const store = createFileRoomStore(dir);
    await store.appendLog('rm_abc', [message(1), message(2)]);
    const lines = readFileSync(path.join(dir, 'rooms', 'rm_abc.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]!).text, 't2');
    await assert.rejects(store.appendLog('../evil', [message(1)]), /ROOM_ID_INVALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

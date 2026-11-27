// PERF-BGSTAB-030 AC-7: a small live write is parsed in the same task. xterm defers a write to a
// setTimeout unless it follows user input, and on Windows that timer can take 15.6 ms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalRawMutationAdapter, IMMEDIATE_PARSE_MAX_BYTES } from '../../src/utils/terminalRawMutationAdapter.ts';

type AdapterOptions = Parameters<typeof createTerminalRawMutationAdapter>[0];

function fakeTerminal(queued = 0) {
  const calls: string[] = [];
  const writeBuffer = {
    _writeBuffer: new Array(queued).fill('x'),
    handleUserInput: () => { calls.push('user-input'); },
  };
  const terminal = {
    _core: { _writeBuffer: writeBuffer },
    write: (data: string | Uint8Array, cb?: () => void) => { calls.push(`write:${data.length}`); cb?.(); },
  };
  const adapter = createTerminalRawMutationAdapter({ terminal, fitAddon: {} } as unknown as AdapterOptions);
  return { adapter, calls };
}

test('PERF-BGSTAB-030 AC-7: a small live write is flagged for immediate parsing', () => {
  const t = fakeTerminal();
  t.adapter.write({ kind: 'live', data: 'a' }, () => {});
  assert.deepEqual(t.calls, ['user-input', 'write:1']);
});

test('PERF-BGSTAB-030 AC-7: a large live write keeps xterm\'s own scheduling', () => {
  const t = fakeTerminal();
  t.adapter.write({ kind: 'live', data: 'x'.repeat(IMMEDIATE_PARSE_MAX_BYTES + 1) }, () => {});
  assert.deepEqual(t.calls, [`write:${IMMEDIATE_PARSE_MAX_BYTES + 1}`]);
});

test('PERF-BGSTAB-030 AC-7: nothing is flagged while xterm still has writes queued', () => {
  // The flag would stay set and make a later, possibly large, write parse synchronously.
  const t = fakeTerminal(2);
  t.adapter.write({ kind: 'live', data: 'a' }, () => {});
  assert.deepEqual(t.calls, ['write:1']);
});

test('PERF-BGSTAB-030 AC-7: repair and checkpoint writes are not flagged', () => {
  const t = fakeTerminal();
  t.adapter.write({ kind: 'repair', data: 'a' }, () => {});
  t.adapter.write({ kind: 'checkpoint', data: new Uint8Array([97]) }, () => {});
  assert.ok(!t.calls.includes('user-input'));
});

test('PERF-BGSTAB-030 AC-7: a terminal without the private write buffer is written as before', () => {
  const calls: string[] = [];
  const terminal = { write: (_data: string, cb?: () => void) => { calls.push('write'); cb?.(); } };
  const adapter = createTerminalRawMutationAdapter({ terminal, fitAddon: {} } as unknown as AdapterOptions);
  adapter.write({ kind: 'live', data: 'a' }, () => {});
  assert.deepEqual(calls, ['write']);
});

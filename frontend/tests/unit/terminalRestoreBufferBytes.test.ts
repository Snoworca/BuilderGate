import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  flushNextTerminalRestoreBufferedOutput,
  type TerminalOutputWriteData,
} from '../../src/utils/terminalOutputScheduler.ts';

/**
 * S4-C3 — the restore-buffer flush gate.
 *
 * `flushNextTerminalRestoreBufferedOutput` rejects anything that is not a string
 * before it reaches `write`. That gate sits on the **live** PTY output path, not
 * on snapshot restore: output held while a restore is pending drains through here.
 * Left as-is, every byte-carrying entry would settle as a failed write once the
 * live path stops producing strings.
 *
 * The gate is widened to the two shapes the write path already accepts, not
 * removed — a third type must still fail closed.
 */

interface FlushProbe {
  writes: TerminalOutputWriteData[];
  settlements: boolean[];
  committed: unknown[];
  result: boolean;
}

function runFlush(entry: unknown, getData?: (value: never) => unknown): FlushProbe {
  const writes: TerminalOutputWriteData[] = [];
  const settlements: boolean[] = [];
  const committed: unknown[] = [];

  const result = flushNextTerminalRestoreBufferedOutput<never>({
    peek: () => entry as never,
    getData: getData as ((value: never) => string) | undefined,
    commit: expected => {
      committed.push(expected);
      return true;
    },
    write: ((data: TerminalOutputWriteData, onWritten: () => void) => {
      writes.push(data);
      onWritten();
      return true;
    }) as never,
    onWritten: () => {},
    onSettled: success => settlements.push(success),
  });

  return { writes, settlements, committed, result };
}

test('a byte entry reaches the write path instead of settling as a failed write', () => {
  const bytes = new Uint8Array([27, 91, 50, 74]);
  const probe = runFlush({ data: bytes }, (entry: never) => (entry as { data: Uint8Array }).data);

  assert.deepEqual(probe.writes, [bytes], 'the gate must hand bytes through unchanged');
  assert.deepEqual(probe.settlements, [true], 'a successful byte write must settle true');
  assert.equal(probe.result, true);
});

test('boundary control — a string entry follows the identical path', () => {
  const probe = runFlush({ data: 'restored' }, (entry: never) => (entry as { data: string }).data);

  assert.deepEqual(probe.writes, ['restored']);
  assert.deepEqual(probe.settlements, [true]);
  assert.equal(probe.result, true);
});

test('boundary control — a third data type still fails closed', () => {
  const probe = runFlush({ data: 42 }, (entry: never) => (entry as { data: number }).data);

  assert.deepEqual(probe.writes, [], 'the gate is widened, not removed');
  assert.deepEqual(probe.settlements, [false]);
  assert.equal(probe.result, false);
  assert.deepEqual(probe.committed, [], 'a rejected entry must stay uncommitted');
});

test('boundary control — a null data value still fails closed', () => {
  const probe = runFlush({ data: null }, (entry: never) => (entry as { data: null }).data);

  assert.deepEqual(probe.writes, []);
  assert.deepEqual(probe.settlements, [false]);
  assert.equal(probe.result, false);
});

/**
 * The second clause of the gate — `typeof pending !== 'string' && !options.getData`
 * — is already unreachable in production because `TerminalView` always supplies
 * `getData`. It is pinned here so widening the first clause cannot quietly take
 * the second one with it.
 */
test('boundary control — a non-string entry with no getData still fails closed', () => {
  const probe = runFlush({ data: 'unreachable-without-getData' });

  assert.deepEqual(probe.writes, []);
  assert.deepEqual(probe.settlements, [false]);
  assert.equal(probe.result, false);
});

test('boundary control — an empty byte view is written, not treated as absent', () => {
  const empty = new Uint8Array(0);
  const probe = runFlush({ data: empty }, (entry: never) => (entry as { data: Uint8Array }).data);

  assert.deepEqual(
    probe.writes,
    [empty],
    'emptiness is the write path\'s decision; the gate must not swallow the entry',
  );
  assert.deepEqual(probe.settlements, [true]);
});

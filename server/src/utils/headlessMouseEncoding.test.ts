// REL-BGSTAB-039 — a restored terminal keeps the mouse report encoding the application selected.
//
// Claude Code runs in the alternate screen with mouse tracking and SGR reports (?1006h), and
// scrolls its own transcript on wheel reports. @xterm/addon-serialize restores the tracking mode
// (?1000/1002/1003h) but not the encoding, so a terminal rebuilt from a snapshot fell back to the
// default encoding and every wheel report after a reload was lost until a resize.
//
// server/src/test-runner.ts 는 *.test.ts 를 찾지 않으므로 이 파일은 node:test 로 따로 돈다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  mouseEncodingRestoreSequence,
  readHeadlessMouseEncoding,
  serializeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from './headlessTerminal.js';

const MAX_BYTES = 1_000_000;

async function withState(run: (state: HeadlessTerminalState) => Promise<void>): Promise<void> {
  const state = createHeadlessTerminalState({ cols: 80, rows: 6, scrollbackLines: 50 });
  try {
    await run(state);
  } finally {
    disposeHeadlessTerminal(state);
  }
}

async function encodingAfterRehydrate(data: string): Promise<string | null> {
  let encoding: string | null = null;
  await withState(async (fresh) => {
    await writeHeadlessTerminal(fresh, data);
    encoding = readHeadlessMouseEncoding(fresh);
  });
  return encoding;
}

test('AC-1: the restore snapshot of an SGR session re-applies SGR', async () => {
  await withState(async (state) => {
    await writeHeadlessTerminal(state, '\x1b[?1049h\x1b[?1000;1002;1006hclaude screen');
    assert.equal(readHeadlessMouseEncoding(state), 'SGR');
    const snapshot = serializeHeadlessTerminal(state, MAX_BYTES);
    assert.equal(snapshot.truncated, false);
    assert.ok(snapshot.data.endsWith('\x1b[?1006h'), JSON.stringify(snapshot.data.slice(-20)));
    assert.equal(await encodingAfterRehydrate(snapshot.data), 'SGR');
  });
});

test('AC-1: SGR-pixels is re-applied, and the retained checkpoint carries the encoding too', async () => {
  await withState(async (state) => {
    await writeHeadlessTerminal(state, '\x1b[?1003;1016hpixels');
    const snapshot = serializeHeadlessTerminal(state, MAX_BYTES, { scrollback: 50 });
    assert.ok(snapshot.data.endsWith('\x1b[?1016h'));
    const checkpoint = serializeRetainedHeadlessCheckpoint(state);
    assert.ok(checkpoint.rehydrateAnsi.endsWith('\x1b[?1016h'));
    assert.ok(checkpoint.serializedData.endsWith('\x1b[?1016h'));
    assert.equal(await encodingAfterRehydrate(checkpoint.rehydrateAnsi), 'SGR_PIXELS');
  });
});

test('AC-2: the default encoding leaves the snapshot byte-identical to the serializer', async () => {
  await withState(async (state) => {
    await writeHeadlessTerminal(state, '\x1b[?1000h\x1b[?1006h\x1b[?1006lplain');
    assert.equal(readHeadlessMouseEncoding(state), 'DEFAULT');
    const snapshot = serializeHeadlessTerminal(state, MAX_BYTES);
    assert.equal(snapshot.data, state.serializeAddon.serialize({ scrollback: 0 }));
    assert.equal(mouseEncodingRestoreSequence('DEFAULT'), '');
    assert.equal(mouseEncodingRestoreSequence(null), '');
  });
});

test('AC-2: the byte limit counts the appended sequence', async () => {
  await withState(async (state) => {
    await writeHeadlessTerminal(state, '\x1b[?1006hx');
    const bare = state.serializeAddon.serialize({ scrollback: 0 });
    const limit = Buffer.byteLength(bare, 'utf8');
    const snapshot = serializeHeadlessTerminal(state, limit);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.data, '');
  });
});

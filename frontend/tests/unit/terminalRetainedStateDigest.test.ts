import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { TerminalCheckpointStartMessage } from '../../src/types/ws-protocol.ts';
import { TERMINAL_CHECKPOINT_PROTOCOL_VERSION } from '../../src/types/ws-protocol.ts';
import { terminalCheckpointRetainedStateDigestMatches } from '../../src/utils/terminalCheckpointRuntime.ts';

const DATA_DIGEST = `sha256:${'a'.repeat(64)}`;

function retainedDigest(input: Omit<TerminalCheckpointStartMessage, 'retainedStateDigest'>): string {
  const modes = Object.fromEntries([
    'applicationCursorKeysMode',
    'applicationKeypadMode',
    'bracketedPasteMode',
    'insertMode',
    'originMode',
    'reverseWraparoundMode',
    'sendFocusMode',
    'wraparoundMode',
  ].flatMap(name => (
    typeof input.modes[name as keyof typeof input.modes] === 'boolean'
      ? [[name, input.modes[name as keyof typeof input.modes]]]
      : []
  )));
  const savedCursor = input.retainedSavedCursor === null
    ? null
    : { x: input.retainedSavedCursor!.x, y: input.retainedSavedCursor!.y };
  return `sha256:${createHash('sha256').update(JSON.stringify({
    version: 1,
    dataDigest: input.contentDigest,
    parserTail: input.parserTail.data,
    cols: input.sourceGeometry.cols,
    rows: input.sourceGeometry.rows,
    modes,
    activeBuffer: input.retainedActiveBuffer,
    cursor: input.retainedCursor,
    savedCursor,
  }), 'utf8').digest('hex')}`;
}

function startMessage(): TerminalCheckpointStartMessage {
  const start: Omit<TerminalCheckpointStartMessage, 'retainedStateDigest'> = {
    type: 'terminal-checkpoint:start',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    sessionId: 'retained-digest-session',
    viewGeneration: 3,
    streamEpoch: '7',
    checkpointEpoch: '9',
    sourceSeq: '41',
    snapshotSeq: '41',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'retained-scrollback:10000',
    sourceGeometry: { cols: 120, rows: 40 },
    chunkCount: 1,
    encodedByteTotal: 17,
    digest: { algorithm: 'sha256', hex: DATA_DIGEST.slice('sha256:'.length) },
    contentDigest: DATA_DIGEST,
    modes: { applicationCursorKeysMode: true, bracketedPasteMode: false },
    parserTail: { encoding: 'base64', data: 'G1s=', encodedBytes: 2 },
    retainedActiveBuffer: 'alternate',
    retainedCursor: { x: 17, y: 8 },
    retainedSavedCursor: { buffer: 'normal', x: 2, y: 3 },
  };
  return { ...start, retainedStateDigest: retainedDigest(start) };
}

test('retained-state digest covers data, parser, geometry, modes, buffer, and cursor state', () => {
  const valid = startMessage();
  assert.equal(terminalCheckpointRetainedStateDigestMatches(valid), true);

  const mutations: readonly TerminalCheckpointStartMessage[] = [
    { ...valid, contentDigest: `sha256:${'b'.repeat(64)}` },
    { ...valid, parserTail: { ...valid.parserTail, data: 'G1td' } },
    { ...valid, sourceGeometry: { ...valid.sourceGeometry, cols: 121 } },
    { ...valid, modes: { ...valid.modes, bracketedPasteMode: true } },
    { ...valid, retainedActiveBuffer: 'normal' },
    { ...valid, retainedCursor: { x: 18, y: 8 } },
    { ...valid, retainedSavedCursor: null },
  ];
  mutations.forEach(message => {
    assert.equal(terminalCheckpointRetainedStateDigestMatches(message), false);
  });
});

test('legacy checkpoint without additive retained-state digest remains compatible', () => {
  const legacy = { ...startMessage(), retainedStateDigest: undefined };
  assert.equal(terminalCheckpointRetainedStateDigestMatches(legacy), true);
});

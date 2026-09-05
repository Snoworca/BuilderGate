import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerminalCheckpointStartMessage } from '../../src/types/ws-protocol.ts';
import { TERMINAL_CHECKPOINT_PROTOCOL_VERSION } from '../../src/types/ws-protocol.ts';
import {
  RETAINED_STATE_DIGEST_VERSION,
  terminalCheckpointRetainedStateCanonicalInput,
  terminalCheckpointRetainedStateDigest,
  terminalCheckpointRetainedStateDigestMatches,
} from '../../src/utils/terminalCheckpointRuntime.ts';

// IR-BGSTAB-002 AC-3. The same fixed inputs and the same hex literals the server
// suite uses, so the two independent implementations and the hand-assembled
// table form a three-way comparison. An expected value produced by either
// implementation would let both be wrong together.
const DATA_DIGEST = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const GOLDEN: ReadonlyArray<{
  readonly name: string;
  readonly base64: string;
  readonly encodedBytes: number;
  readonly digest: string;
}> = [
  { name: 'empty', base64: '', encodedBytes: 0, digest: 'sha256:18dcd5f93397585893f1ec43aa6946d6d0b8137db3b3e3d02af6fa1204c385ed' },
  { name: 'ascii', base64: 'YWJj', encodedBytes: 3, digest: 'sha256:5e33ba90597462e2c9ceca0ec91b812f88234b4dc622e7a699c1f9e2ab4e57b3' },
  { name: 'incomplete-ansi', base64: 'G1s=', encodedBytes: 2, digest: 'sha256:f64310890ef238b4c2c64eaf23aa08b3eb566c4e762a25e9afa80e2fb9473a74' },
  { name: 'cjk-wide', base64: '7ZWc6riA', encodedBytes: 6, digest: 'sha256:9108477e590c1004b093c39a3b8f59be41cf2efe240cd3d23e91292421e46728' },
  { name: 'combining', base64: 'ZcyB', encodedBytes: 3, digest: 'sha256:6cabf5aacbc260346fe2ff426f183b51f51ae5c7203a9dd3a95d07b50bab720f' },
  { name: 'zwj-emoji', base64: '8J+RqeKAjfCfkrs=', encodedBytes: 11, digest: 'sha256:d8ae76c81757643ee99185b599cb10e8b82b212626d6fecf6580c77d6c33d83d' },
  { name: 'four-byte-utf8', base64: '8J+Zgg==', encodedBytes: 4, digest: 'sha256:04f870fc8fae33c63012881cc8199892a4bfb1ed611a6c13a7ee0232b3d050e3' },
];

function startMessage(overrides: Partial<TerminalCheckpointStartMessage> = {}): TerminalCheckpointStartMessage {
  const tail = GOLDEN[1]!; // ascii
  return {
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
    parserTail: { encoding: 'base64', data: tail.base64, encodedBytes: tail.encodedBytes },
    retainedActiveBuffer: 'normal',
    retainedCursor: { x: 7, y: 11 },
    retainedSavedCursor: { buffer: 'normal', x: 3, y: 5 },
    retainedStateDigestVersion: RETAINED_STATE_DIGEST_VERSION,
    retainedStateDigest: tail.digest,
    ...overrides,
  } as TerminalCheckpointStartMessage;
}

test('IR-BGSTAB-002 AC-3 matches the hand-assembled golden vectors', () => {
  assert.equal(GOLDEN.length >= 7, true, 'AC-3 requires at least seven fixed inputs');
  assert.equal(new Set(GOLDEN.map(row => row.digest)).size, GOLDEN.length);
  for (const row of GOLDEN) {
    const message = startMessage({
      parserTail: { encoding: 'base64', data: row.base64, encodedBytes: row.encodedBytes },
      retainedStateDigest: row.digest,
    });
    assert.equal(terminalCheckpointRetainedStateDigest(message), row.digest, row.name);
    assert.deepEqual(terminalCheckpointRetainedStateDigestMatches(message), { ok: true }, row.name);
  }
});

test('IR-BGSTAB-002 AC-1 derives the parser tail from the decoded bytes', () => {
  // 'abc' encodes to 'YWJj'. Folding the base64 text in instead of the bytes it
  // stands for is the defect this contract removes, so the two must differ.
  const asBytes = terminalCheckpointRetainedStateDigest(startMessage({
    parserTail: { encoding: 'base64', data: 'YWJj', encodedBytes: 3 },
  }));
  const asText = terminalCheckpointRetainedStateDigest(startMessage({
    parserTail: { encoding: 'base64', data: 'WVdKcQ==', encodedBytes: 4 },
  }));
  assert.notEqual(asBytes, asText);
  assert.equal(asBytes, GOLDEN[1]!.digest);
});

test('IR-BGSTAB-002 AC-5 covers every field the contract fixes', () => {
  const valid = startMessage();
  assert.deepEqual(terminalCheckpointRetainedStateDigestMatches(valid), { ok: true });

  const mutations: ReadonlyArray<readonly [string, Partial<TerminalCheckpointStartMessage>]> = [
    ['contentDigest', { contentDigest: `sha256:${'b'.repeat(64)}`, digest: { algorithm: 'sha256', hex: 'b'.repeat(64) } }],
    ['parserTail', { parserTail: { encoding: 'base64', data: 'G1td', encodedBytes: 3 } }],
    ['cols', { sourceGeometry: { cols: 121, rows: 40 } }],
    ['rows', { sourceGeometry: { cols: 120, rows: 41 } }],
    ['modes', { modes: { applicationCursorKeysMode: true, bracketedPasteMode: true } }],
    ['activeBuffer', { retainedActiveBuffer: 'alternate' }],
    ['cursor', { retainedCursor: { x: 8, y: 11 } }],
    ['savedCursor', { retainedSavedCursor: null }],
  ];
  for (const [name, override] of mutations) {
    assert.deepEqual(
      terminalCheckpointRetainedStateDigestMatches(startMessage(override)),
      { ok: false, reason: 'digest-mismatch' },
      name,
    );
  }
});

test('IR-BGSTAB-002 AC-5 ignores keys the terminal model may add to a cursor', () => {
  // The saved cursor arrives carrying a `buffer` key that the canonical input
  // must not admit; the golden vector was computed without it.
  const widened = startMessage({
    retainedSavedCursor: { buffer: 'alternate', x: 3, y: 5 } as unknown as TerminalCheckpointStartMessage['retainedSavedCursor'],
  });
  assert.deepEqual(terminalCheckpointRetainedStateDigestMatches(widened), { ok: true });
});

test('IR-BGSTAB-002 AC-6 refuses a digest version it does not know, and says so distinctly', () => {
  const unknown = startMessage({ retainedStateDigestVersion: 99 });
  assert.deepEqual(
    terminalCheckpointRetainedStateDigestMatches(unknown),
    { ok: false, reason: 'unknown-digest-version' },
  );
  // Boundary control: the same message on a known version passes, so the refusal
  // above is attributable to the version and not to anything else.
  assert.deepEqual(
    terminalCheckpointRetainedStateDigestMatches(startMessage({ retainedStateDigestVersion: RETAINED_STATE_DIGEST_VERSION })),
    { ok: true },
  );
  // A digest present without a version is not a version this verifier knows.
  assert.deepEqual(
    terminalCheckpointRetainedStateDigestMatches(startMessage({ retainedStateDigestVersion: undefined })),
    { ok: false, reason: 'unknown-digest-version' },
  );
});

test('IR-BGSTAB-002 AC-7 keeps a checkpoint without the additive digest compatible', () => {
  const legacy = startMessage({ retainedStateDigest: undefined, retainedStateDigestVersion: undefined });
  assert.deepEqual(terminalCheckpointRetainedStateDigestMatches(legacy), { ok: true });
});

test('IR-BGSTAB-002 AC-5 fixes the canonical field set and order on the browser side too', () => {
  const canonical = terminalCheckpointRetainedStateCanonicalInput(startMessage());
  assert.deepEqual(Object.keys(canonical), [
    'version',
    'dataDigest',
    'parserTailDigest',
    'cols',
    'rows',
    'modes',
    'activeBuffer',
    'cursor',
    'savedCursor',
  ]);
  assert.equal(canonical.version, RETAINED_STATE_DIGEST_VERSION);
  assert.deepEqual(Object.keys(canonical.cursor as object), ['x', 'y']);
  assert.deepEqual(Object.keys(canonical.savedCursor as object), ['x', 'y']);
  // The mode order is part of the contract, not of whichever object arrived.
  const reordered = terminalCheckpointRetainedStateCanonicalInput(startMessage({
    modes: { bracketedPasteMode: false, applicationCursorKeysMode: true },
  }));
  assert.deepEqual(Object.keys(reordered.modes as object), ['applicationCursorKeysMode', 'bracketedPasteMode']);
  assert.deepEqual(reordered, canonical);
});

test('IR-BGSTAB-002 AC-1 is unmoved by how the same bytes were spelled in base64', () => {
  // 'G1s=' and 'G1s' decode to the same two bytes; only the padding differs. The
  // digest follows the bytes, so the two spellings must agree.
  const padded = terminalCheckpointRetainedStateDigest(startMessage({
    parserTail: { encoding: 'base64', data: 'G1s=', encodedBytes: 2 },
  }));
  const unpadded = terminalCheckpointRetainedStateDigest(startMessage({
    parserTail: { encoding: 'base64', data: 'G1s', encodedBytes: 2 },
  }));
  assert.equal(padded, unpadded);
  assert.equal(padded, GOLDEN[2]!.digest);
  // Boundary control: bytes that genuinely differ must still separate.
  assert.notEqual(padded, terminalCheckpointRetainedStateDigest(startMessage({
    parserTail: { encoding: 'base64', data: 'G1st', encodedBytes: 3 },
  })));
});

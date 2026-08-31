import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DATA_PLANE_OPCODE } from '../../src/utils/binaryFrameCodec.ts';
import { intakeBinaryFrames } from '../../src/utils/binaryFrameIntake.ts';
import type { BinaryIntakeCollaborators } from '../../src/utils/binaryFrameIntake.ts';
import type { TerminalChannelRecord } from '../../src/utils/terminalChannelRegistry.ts';
import type { LiveOutputTokens } from '../../src/utils/liveOutputTokens.ts';
import type { TerminalOutputDelivery } from '../../src/utils/terminalOutputDelivery.ts';

/**
 * S4-C5 wiring — the step that turns an arriving binary frame into the same
 * `onOutput` delivery the JSON path produces.
 *
 * This lives outside `WebSocketContext.tsx` for the reason `wsFrameDispatch`
 * already documents: the unit runner strips types but cannot compile JSX, so a
 * test can never import the context. Keeping the intake here is what makes the
 * behaviour testable at all.
 *
 * The three identity values the adapter needs come from three different places,
 * and the tests below pin each one to its own source:
 *
 *   authorityEpoch  ← the channel registry (the frame carries only an index)
 *   replayToken     ← the live token store, keyed by the container's generation
 *   repairToken     ← same store
 */

const FIXTURE_URL = new URL(
  '../../../server/src/ws/__fixtures__/binary-frame-vectors.json',
  import.meta.url,
);

interface VectorFixture {
  name: string;
  byteLength: number;
  hexFrame: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as { vectors: VectorFixture[] };

function vectorBytes(name: string): Uint8Array {
  const found = fixture.vectors.find(v => v.name === name);
  assert.ok(found, `unknown vector ${name}`);
  const hex = found.hexFrame;
  assert.equal(hex.length % 2, 0, 'hex must have an even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  assert.equal(out.byteLength, found.byteLength, `${name} length disagrees with its fixture`);
  return out;
}

const SESSION = 'session-alpha';
const EPOCH_UUID = '6f1a2c34-5b6d-4e7f-8091-a2b3c4d5e6f7';

const RECORD: TerminalChannelRecord = Object.freeze({
  sessionId: SESSION,
  authorityEpoch: EPOCH_UUID,
  streamEpoch: '1',
});

interface Harness {
  collaborators: BinaryIntakeCollaborators;
  delivered: { sessionId: string; delivery: TerminalOutputDelivery }[];
  tokenLookups: string[];
}

function harness(overrides: Partial<BinaryIntakeCollaborators> = {}): Harness {
  const delivered: Harness['delivered'] = [];
  const tokenLookups: string[] = [];
  const collaborators: BinaryIntakeCollaborators = {
    maxBodyBytes: 4 * 1024 * 1024,
    channelState: () => 'active',
    // The corpus routes its output vectors over channels 1 and 7.
    lookupChannel: channelId => (channelId === 1 || channelId === 7 ? RECORD : undefined),
    liveTokens: sessionId => {
      tokenLookups.push(sessionId);
      return { replayToken: 'replay-1', repairToken: 'repair-1' } satisfies LiveOutputTokens;
    },
    deliverOutput: (sessionId, delivery) => {
      delivered.push({ sessionId, delivery });
    },
    ...overrides,
  };
  return { collaborators, delivered, tokenLookups };
}

// ---------------------------------------------------------------------------
// 1. The frame reaches `onOutput` at all — this is what issue #30 is about.
// ---------------------------------------------------------------------------

test('a valid output frame is delivered to the session that owns its channel', () => {
  const h = harness();
  const report = intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].sessionId, SESSION);
  assert.equal(h.delivered[0].delivery.codec, 'binary');
  assert.equal(report.delivered, 1);
  assert.equal(report.fatal, undefined);
});

test('a frame carrying a body forwards those bytes unchanged', () => {
  const h = harness();
  intakeBinaryFrames(vectorBytes('output-utf8-body-60'), h.collaborators);

  assert.equal(h.delivered.length, 1);
  const { whole } = h.delivered[0].delivery;
  assert.ok(whole.byteLength > 0, 'the body should not be empty');
  // The binary path must forward bytes, never a decoded string — decoding here
  // is the round trip this codec exists to remove.
  assert.ok(whole.data instanceof Uint8Array, 'the body must stay bytes');
  assert.equal(whole.data.byteLength, whole.byteLength);
});

test('every frame in a batch is delivered', () => {
  const h = harness();
  const report = intakeBinaryFrames(vectorBytes('batch-two-output-frames-106'), h.collaborators);

  assert.equal(h.delivered.length, 2);
  assert.equal(report.delivered, 2);
});

// ---------------------------------------------------------------------------
// 2. The three identity values, each from its own source.
// ---------------------------------------------------------------------------

test('authorityEpoch is taken from the channel registry, not from the frame index', () => {
  const h = harness();
  intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  // The vector's prologue carries authorityEpochIndex = 0, which is an alias
  // and not a UUID. Only the registry knows what it stands for.
  assert.equal(h.delivered[0].delivery.whole.authorityEpoch, EPOCH_UUID);
});

test('both tokens are taken from the live store, looked up by session', () => {
  const h = harness();
  intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.deepEqual(h.tokenLookups, [SESSION]);
  assert.equal(h.delivered[0].delivery.replayToken, 'replay-1');
  assert.equal(h.delivered[0].delivery.repairToken, 'repair-1');
});

// ---------------------------------------------------------------------------
// 3. The `:3294` policy, made explicit.
//
// An unresolvable token yields a delivery with no `replayToken` rather than a
// dropped frame. The container's post-ack convergence then fails that delivery
// exactly as it already fails a JSON output message carrying no token — the
// behaviour is deliberately identical across the two codecs.
// ---------------------------------------------------------------------------

test('an unresolvable token still delivers the frame, without inventing a token', () => {
  const h = harness({ liveTokens: () => undefined });
  const report = intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered.length, 1, 'the output must not be silently dropped');
  assert.equal(h.delivered[0].delivery.replayToken, undefined);
  assert.equal(h.delivered[0].delivery.repairToken, undefined);
  assert.equal(report.delivered, 1);
});

test('a store hit that carries only a repairToken leaves replayToken absent', () => {
  const h = harness({ liveTokens: () => ({ repairToken: 'repair-only' }) });
  intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered[0].delivery.replayToken, undefined);
  assert.equal(h.delivered[0].delivery.repairToken, 'repair-only');
});

// ---------------------------------------------------------------------------
// 4. Frames the intake must not deliver.
// ---------------------------------------------------------------------------

test('a channel with no registry record delivers nothing and is reported', () => {
  const h = harness({ lookupChannel: () => undefined });
  const report = intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered.length, 0);
  assert.deepEqual(report.unroutable, [1]);
  assert.equal(report.delivered, 0);
});

test('a non-output opcode is reported rather than delivered', () => {
  const h = harness();
  const report = intakeBinaryFrames(vectorBytes('screen-snapshot-54'), h.collaborators);

  assert.equal(h.delivered.length, 0);
  assert.deepEqual(report.unhandledOpcodes, [DATA_PLANE_OPCODE.SCREEN_SNAPSHOT]);
});

test('an opcode with no prologue parser is reported, not silently dropped', () => {
  // 0x03, 0x06 and 0x07 have `prologueBytes === 0`, so `parseFrameMessage`
  // returns undefined for them while the frame itself decoded cleanly. They
  // must not disappear more quietly than the opcodes that do parse.
  for (const opcode of [
    DATA_PLANE_OPCODE.SCREEN_REPAIR,
    DATA_PLANE_OPCODE.CHECKPOINT_COMMIT,
    DATA_PLANE_OPCODE.CHECKPOINT_OUTPUT,
  ]) {
    const h = harness();
    const bytes = vectorBytes('output-minimal-52');
    bytes[1] = opcode;

    const report = intakeBinaryFrames(bytes, h.collaborators);

    assert.equal(h.delivered.length, 0, `opcode ${opcode} must not be delivered`);
    assert.deepEqual(report.unhandledOpcodes, [opcode], `opcode ${opcode} vanished without a report`);
  }
});

test('the token store is not consulted for a frame that cannot be routed', () => {
  const h = harness({ lookupChannel: () => undefined });
  intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.deepEqual(h.tokenLookups, []);
});

// ---------------------------------------------------------------------------
// 5. A fatal rejection must not discard frames that were already parsed.
//
// `decodeWsMessage` returns both, and dropping the frames on `fatal` would lose
// output the peer already sent correctly.
// ---------------------------------------------------------------------------

test('frames parsed before a fatal rejection are still delivered', () => {
  const h = harness();
  // The corpus fault `D14-fault-mid-batch-prologue-present-cleared`: a two-frame
  // batch whose second frame clears a mandatory flag. The first frame decodes
  // and must survive the fault that follows it.
  const buffer = vectorBytes('batch-two-output-frames-106');
  buffer.set(new Uint8Array([0x00, 0x03]), 55);

  const report = intakeBinaryFrames(buffer, h.collaborators);

  assert.equal(report.fatal?.code, 'mandatory-flag-cleared');
  assert.equal(h.delivered.length, 1, 'the intact frame must survive the fatal tail');
  assert.equal(report.delivered, 1);
});

// ---------------------------------------------------------------------------
// 6. The codec's own rejections are surfaced, not swallowed.
// ---------------------------------------------------------------------------

test('a retired channel produces a diagnostic and no delivery', () => {
  const h = harness({ channelState: () => 'retired' });
  const report = intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered.length, 0);
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].channelId, 1);
});

test('an unknown channel is rejected as scoped and delivers nothing', () => {
  const h = harness({ channelState: () => undefined });
  const report = intakeBinaryFrames(vectorBytes('output-minimal-52'), h.collaborators);

  assert.equal(h.delivered.length, 0);
  assert.ok(report.scoped.length >= 1);
  assert.equal(report.fatal, undefined, 'an unknown channel must stay scoped');
});

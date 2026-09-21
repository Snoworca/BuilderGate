import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWsTransportMessage, tryCoalesceOutputMessage, type WsTransportCodec } from './wsSendPolicy.js';

/**
 * SDS-AC-6. `tryCoalesceOutputMessage` rebuilt the merged message with no codec,
 * so on a negotiated group two binary outputs merged into a JSON one — two
 * encodings inside one streamEpoch, which IR-BGSTAB-001 AC-3 forbids and
 * nothing reported.
 */

const encodeBinary = (message: object): Uint8Array =>
  new TextEncoder().encode('B:' + JSON.stringify(message));
const binaryCodec: WsTransportCodec = { binding: { codec: 'binary', codecEpoch: 3 }, encodeBinary };
const codecFor = (_sessionId: string) => binaryCodec;

function output(data: string, codec?: WsTransportCodec) {
  return createWsTransportMessage({ type: 'output', sessionId: 's', data }, 1000, { policyGeneration: 1 }, codec);
}

test('SDS-AC-6 two binary outputs coalesce into one binary message on the same codecEpoch', () => {
  const merged = tryCoalesceOutputMessage(output('ab', binaryCodec), output('cd', binaryCodec), 16, codecFor);
  assert.ok(merged, 'coalesce refused');
  assert.equal(merged.payload.codec, 'binary');
  assert.equal((merged.payload as { codecEpoch: number }).codecEpoch, 3);
  assert.equal(merged.outputData, 'abcd');
});

test('SDS-AC-6 mixed codecs are never merged', () => {
  assert.equal(tryCoalesceOutputMessage(output('ab', binaryCodec), output('cd'), 16, codecFor), null);
  assert.equal(tryCoalesceOutputMessage(output('ab'), output('cd', binaryCodec), 16, codecFor), null);
});

test('SDS-AC-6 two JSON outputs still coalesce into JSON (control)', () => {
  const merged = tryCoalesceOutputMessage(output('ab'), output('cd'), 16, () => undefined);
  assert.ok(merged);
  assert.equal(merged.payload.codec, 'json');
  assert.equal(merged.outputData, 'abcd');
});

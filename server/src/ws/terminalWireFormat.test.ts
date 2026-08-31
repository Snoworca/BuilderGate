import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideTerminalWireFormat, isBinaryNegotiable } from './terminalWireFormat.js';
import type { TerminalWireFormat } from './terminalWireFormat.js';
import type { WsTransportMode } from './wsTransportMode.js';

/**
 * The four-step rollout ladder (`05 §8.2`), and the gate that keeps every later
 * wiring step reversible.
 *
 * `json` is the default, so a deployment that never touches the config keeps
 * behaving exactly as it does today no matter how much binary machinery exists
 * behind this decision.
 */

const ALL_FORMATS: readonly TerminalWireFormat[] = [
  'json',
  'binary-shadow',
  'binary-optin',
  'binary',
];

function decide(overrides: {
  configured?: TerminalWireFormat;
  transportMode?: WsTransportMode;
  clientNegotiatedBinary?: boolean;
} = {}) {
  return decideTerminalWireFormat({
    configured: 'json',
    transportMode: 'unified',
    clientNegotiatedBinary: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. The default costs nothing and changes nothing.
// ---------------------------------------------------------------------------

test('json neither encodes nor sends binary', () => {
  const decision = decide({ configured: 'json', clientNegotiatedBinary: true });

  assert.equal(decision.encodeBinary, false);
  assert.equal(decision.sendBinary, false);
  assert.equal(decision.compareCodecs, false);
});

test('json is not negotiable even if a client asks', () => {
  assert.equal(isBinaryNegotiable('json', 'unified'), false);
});

// ---------------------------------------------------------------------------
// 2. Shadow — encode both, send neither change.
// ---------------------------------------------------------------------------

test('binary-shadow encodes binary but never puts it on the wire', () => {
  const decision = decide({ configured: 'binary-shadow' });

  // The whole value of this step is that the user-visible wire is unchanged
  // while the encoder runs in production (05:559).
  assert.equal(decision.encodeBinary, true);
  assert.equal(decision.sendBinary, false);
  assert.equal(decision.compareCodecs, true);
});

test('binary-shadow ignores what the client negotiated', () => {
  const negotiated = decide({ configured: 'binary-shadow', clientNegotiatedBinary: true });

  assert.equal(negotiated.sendBinary, false);
});

test('binary-shadow does not invite negotiation', () => {
  // Nothing binary reaches the wire in this step, so there is nothing to agree
  // about and no reason to expose the handshake yet.
  assert.equal(isBinaryNegotiable('binary-shadow', 'unified'), false);
});

// ---------------------------------------------------------------------------
// 3. Opt-in and default — the client's declaration decides.
// ---------------------------------------------------------------------------

for (const configured of ['binary-optin', 'binary'] as const) {
  test(`${configured} sends binary to a client that negotiated it`, () => {
    const decision = decide({ configured, clientNegotiatedBinary: true });

    assert.equal(decision.encodeBinary, true);
    assert.equal(decision.sendBinary, true);
    assert.equal(decision.compareCodecs, false);
  });

  test(`${configured} keeps a client that did not negotiate on JSON`, () => {
    const decision = decide({ configured, clientNegotiatedBinary: false });

    assert.equal(decision.sendBinary, false);
    assert.equal(decision.encodeBinary, false);
  });

  test(`${configured} invites negotiation`, () => {
    assert.equal(isBinaryNegotiable(configured, 'unified'), true);
  });
}

// ---------------------------------------------------------------------------
// 4. The transport gate — `05:564` recommends binary only under unified.
// ---------------------------------------------------------------------------

for (const transportMode of ['split', 'split-shadow'] as const) {
  test(`${transportMode} transport never sends binary, whatever the format says`, () => {
    const decision = decide({
      configured: 'binary',
      transportMode,
      clientNegotiatedBinary: true,
    });

    assert.equal(decision.encodeBinary, false);
    assert.equal(decision.sendBinary, false);
  });

  test(`${transportMode} transport is not negotiable`, () => {
    assert.equal(isBinaryNegotiable('binary', transportMode), false);
  });
}

test('the transport gate is reported as its own reason', () => {
  const decision = decide({
    configured: 'binary',
    transportMode: 'split',
    clientNegotiatedBinary: true,
  });

  // Distinguishable from "the client declined", which is the other way to end
  // up on JSON with binary configured.
  assert.match(decision.reason, /transport/i);
  assert.notEqual(
    decision.reason,
    decide({ configured: 'binary', clientNegotiatedBinary: false }).reason,
  );
});

// ---------------------------------------------------------------------------
// 5. Invariants that must hold across the whole ladder.
// ---------------------------------------------------------------------------

test('sending binary always implies encoding it', () => {
  for (const configured of ALL_FORMATS) {
    for (const transportMode of ['unified', 'split', 'split-shadow'] as const) {
      for (const clientNegotiatedBinary of [true, false]) {
        const decision = decide({ configured, transportMode, clientNegotiatedBinary });
        if (decision.sendBinary) {
          assert.equal(decision.encodeBinary, true, `${configured}/${transportMode}`);
        }
      }
    }
  }
});

test('comparing codecs never coincides with sending binary', () => {
  // Shadow compares because the binary frame is not the one being delivered.
  // Doing both would mean comparing a frame against itself.
  for (const configured of ALL_FORMATS) {
    for (const clientNegotiatedBinary of [true, false]) {
      const decision = decide({ configured, clientNegotiatedBinary });
      assert.ok(!(decision.compareCodecs && decision.sendBinary), configured);
    }
  }
});

test('every decision carries a reason', () => {
  for (const configured of ALL_FORMATS) {
    for (const transportMode of ['unified', 'split'] as const) {
      for (const clientNegotiatedBinary of [true, false]) {
        const { reason } = decide({ configured, transportMode, clientNegotiatedBinary });
        assert.ok(typeof reason === 'string' && reason.length > 0);
      }
    }
  }
});

test('a negotiable format is exactly one that can reach sendBinary', () => {
  for (const configured of ALL_FORMATS) {
    const reachable = decide({ configured, clientNegotiatedBinary: true }).sendBinary;
    assert.equal(isBinaryNegotiable(configured, 'unified'), reachable, configured);
  }
});

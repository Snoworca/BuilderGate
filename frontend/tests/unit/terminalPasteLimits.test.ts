// #18 criterion 8 — the size cap and the local/WAN timeout.
//
// Measured 2026-09-19 before this module existed:
//   - The browser applied NO size cap to a paste. The server hard-refuses any input over
//     MAX_REPLAY_QUEUED_INPUT_BYTES (64 KiB, WsRouter.ts:125) with `invalid-payload` --
//     the reason the codebase itself describes as having "blamed the client for a message
//     that was never malformed". So pasting a large file failed, and the user was told
//     their message was malformed rather than too big.
//   - `inputQueueTtlMs` (default 1500 ms) is the only timeout on pending input, and it is
//     one number for every deployment. On a WAN link 1500 ms is short enough to reject
//     input that was merely in flight, which the user experiences as dropped keystrokes.
//
// The issue states no concrete values for either, so these are round numbers chosen and
// written down rather than derived.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TERMINAL_PASTE_MAX_BYTES,
  TERMINAL_INPUT_TTL_LOCAL_MS,
  TERMINAL_INPUT_TTL_WAN_MS,
  measurePasteBytes,
  isPasteWithinCap,
  resolveTerminalInputTtlMs,
} from '../../src/utils/terminalPasteLimits.ts';

test('#18 criterion 8 the cap is measured in encoded bytes, not characters', () => {
  // 'ka' in Hangul is 3 UTF-8 bytes. A character count would report 1.
  assert.equal(measurePasteBytes('가'), 3);
  assert.equal(measurePasteBytes('abc'), 3);
  assert.equal(measurePasteBytes(''), 0);
});

test('#18 criterion 8 a paste at the cap is allowed and one byte over is not', () => {
  const atCap = 'a'.repeat(TERMINAL_PASTE_MAX_BYTES);

  assert.equal(isPasteWithinCap(atCap), true);
  assert.equal(isPasteWithinCap(`${atCap}a`), false);
});

test('#18 criterion 8 the cap counts bytes for multi-byte text too', () => {
  // Three-byte characters: the character count is well under the cap and the byte
  // count is over it. Counting characters here would let through a paste the server
  // then refuses as invalid-payload, which is the defect this cap exists to prevent.
  const overByBytes = '가'.repeat(TERMINAL_PASTE_MAX_BYTES / 3 + 1);

  assert.ok(overByBytes.length < TERMINAL_PASTE_MAX_BYTES, 'fixture must be short in characters');
  assert.equal(isPasteWithinCap(overByBytes), false);
});

test('#18 criterion 8 the cap does not exceed what the server will accept', () => {
  // The browser must not admit a paste the server hard-refuses as invalid-payload;
  // that is exactly the misleading failure this replaces. 64 KiB is WsRouter's
  // MAX_REPLAY_QUEUED_INPUT_BYTES.
  assert.equal(TERMINAL_PASTE_MAX_BYTES, 64 * 1024);
});

test('#18 criterion 8 a loopback origin resolves to the local timeout', () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(
      resolveTerminalInputTtlMs(hostname),
      TERMINAL_INPUT_TTL_LOCAL_MS,
      hostname,
    );
  }
});

test('#18 criterion 8 a remote origin resolves to the longer WAN timeout', () => {
  for (const hostname of ['builder.example.com', '10.0.0.7', '192.168.1.5']) {
    assert.equal(
      resolveTerminalInputTtlMs(hostname),
      TERMINAL_INPUT_TTL_WAN_MS,
      hostname,
    );
  }
});

test('#18 criterion 8 the WAN timeout is the longer of the two', () => {
  // The whole point of splitting them: one value cannot be right for both, and the
  // failure mode on the WAN side is rejecting input that was only in flight.
  assert.ok(
    TERMINAL_INPUT_TTL_WAN_MS > TERMINAL_INPUT_TTL_LOCAL_MS,
    'a WAN link needs more time than loopback, or splitting them achieves nothing',
  );
  assert.equal(TERMINAL_INPUT_TTL_LOCAL_MS, 1500);
  assert.equal(TERMINAL_INPUT_TTL_WAN_MS, 5000);
});

test('#18 criterion 8 an unknown hostname is treated as remote, not as loopback', () => {
  // Boundary: guessing "local" would apply the short timeout to a link that may be slow,
  // which drops input. Guessing "remote" only delays a rejection.
  assert.equal(resolveTerminalInputTtlMs(''), TERMINAL_INPUT_TTL_WAN_MS);
  assert.equal(resolveTerminalInputTtlMs(undefined), TERMINAL_INPUT_TTL_WAN_MS);
});

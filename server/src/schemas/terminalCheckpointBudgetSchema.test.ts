// @req REL-BGSTAB-023 AC-1, AC-4, AC-5
//
// Issue #25 / REL-BGSTAB-023. `resourceLimits.terminal.checkpointMaxBytes` must be a canonical
// configuration key in its own right — not an alias of, nor a value derived from,
// `visibleOutputQueueMaxBytes`, which governs a different budget (the post-checkpoint hold buffer).
import assert from 'node:assert/strict';
import test from 'node:test';

import { terminalResourceLimitsSchema } from './config.schema.js';
import { TERMINAL_RESOURCE_KEYS } from '../services/TerminalResourcePolicy.js';

const RESOURCE_KEY = 'resourceLimits.terminal.checkpointMaxBytes';
const DEFAULT_CHECKPOINT_MAX_BYTES = 4_194_304;

test('REL-BGSTAB-023 AC-1 the checkpoint byte budget is its own canonical schema key', () => {
  const parsed = terminalResourceLimitsSchema.parse({ checkpointMaxBytes: 8_388_608 });
  assert.equal(
    parsed.checkpointMaxBytes,
    8_388_608,
    'a configured checkpointMaxBytes must survive schema parsing unchanged',
  );
  assert.equal(
    parsed.visibleOutputQueueMaxBytes,
    DEFAULT_CHECKPOINT_MAX_BYTES,
    'setting the checkpoint budget must not move the post-checkpoint hold budget',
  );
});

test('REL-BGSTAB-023 AC-5 the shipped default leaves the effective budget unchanged', () => {
  const parsed = terminalResourceLimitsSchema.parse({});
  assert.equal(
    parsed.checkpointMaxBytes,
    DEFAULT_CHECKPOINT_MAX_BYTES,
    'the shipped default must equal the value the coupled fallback produced, so no behaviour changes',
  );
  assert.equal(parsed.visibleOutputQueueMaxBytes, DEFAULT_CHECKPOINT_MAX_BYTES);
});

test('REL-BGSTAB-023 AC-1 the checkpoint byte budget shares the range it was split from', () => {
  // Range parity is with `visibleOutputQueueMaxBytes` specifically — the key this one decouples
  // from — not with the terminal byte keys in general, several of which cap at 16 MiB.
  assert.equal(terminalResourceLimitsSchema.parse({ checkpointMaxBytes: 1024 }).checkpointMaxBytes, 1024);
  assert.equal(
    terminalResourceLimitsSchema.parse({ checkpointMaxBytes: 268_435_456 }).checkpointMaxBytes,
    268_435_456,
  );
  for (const rejected of [1023, 268_435_457, 4096.5, -1]) {
    assert.throws(
      () => terminalResourceLimitsSchema.parse({ checkpointMaxBytes: rejected }),
      `checkpointMaxBytes=${rejected} must be rejected rather than silently coerced`,
    );
  }
});

test('REL-BGSTAB-023 AC-1 the terminal block stays strict about unknown keys', () => {
  assert.throws(
    () => terminalResourceLimitsSchema.parse({ checkpointMaxByte: 4_194_304 }),
    'a misspelled key must be rejected, otherwise operators cannot tell the lever is not engaged',
  );
});

test('REL-BGSTAB-023 AC-4 the checkpoint byte budget is registered as a terminal resource key', () => {
  assert.equal(
    TERMINAL_RESOURCE_KEYS.includes(RESOURCE_KEY as (typeof TERMINAL_RESOURCE_KEYS)[number]),
    true,
    `${RESOURCE_KEY} must be registered in TerminalResourcePolicy, otherwise the static inventory `
    + 'contract test (OBS-BGSTAB-005 AC-6) cannot see it',
  );
});

// @req REL-BGSTAB-023 AC-2, AC-3, AC-5, AC-6
//
// Issue #25 / REL-BGSTAB-023. The checkpoint snapshot byte budget and the post-checkpoint hold
// byte budget are two different budgets. They used to be one number in production, because
// `terminalWriteCoordinator.ts` resolves `checkpointMaxBytes` as
// `options.checkpointMaxBytes ?? postCheckpointMaxBytes` and `TerminalView` — the only production
// call site of `createTerminalWriteCoordinator` — passed only `postCheckpointMaxBytes`.
//
// The coordinator always accepted an independent value; the missing half was the configuration
// plumbing, which now carries `resourceLimits.terminal.checkpointMaxBytes` to that call site. These
// tests pin the plumbing, not the coordinator arithmetic, so the `??` fallback is no longer what
// production resolves to.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getTerminalResourceLimits,
  initializeInputReliabilityMode,
} from '../../src/utils/inputReliabilityMode.ts';
import * as terminalWriteCoordinatorModule from '../../src/utils/terminalWriteCoordinator.ts';

const encoder = new TextEncoder();

// Shipped defaults. AC-5 pins the checkpoint default at the same number the hold budget already
// uses, so introducing the key changes no effective behaviour on its own.
const DEFAULT_VISIBLE_OUTPUT_QUEUE_MAX_BYTES = 4_194_304;
const DEFAULT_CHECKPOINT_MAX_BYTES = 4_194_304;

type TerminalLimitsWithCheckpointBudget = ReturnType<typeof getTerminalResourceLimits> & {
  checkpointMaxBytes: number;
};

async function loadRuntimeConfig(terminal: Record<string, unknown>): Promise<TerminalLimitsWithCheckpointBudget> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    resourceLimits: { terminal },
  }), { status: 200 });
  try {
    await initializeInputReliabilityMode();
    return getTerminalResourceLimits() as TerminalLimitsWithCheckpointBudget;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('REL_BGSTAB_023_AC3_runtime_config_carries_an_independent_checkpoint_byte_budget', async () => {
  const signature = 'a configured checkpointMaxBytes distinct from visibleOutputQueueMaxBytes did not survive runtime-config resolution';
  const limits = await loadRuntimeConfig({
    visibleOutputQueueMaxBytes: 1_048_576,
    checkpointMaxBytes: 8_388_608,
  });

  assert.equal(limits.checkpointMaxBytes, 8_388_608, signature);
  assert.equal(limits.visibleOutputQueueMaxBytes, 1_048_576, signature);
  assert.notEqual(
    limits.checkpointMaxBytes,
    limits.visibleOutputQueueMaxBytes,
    `${signature}; the two budgets collapsed back into one number`,
  );
});

test('REL_BGSTAB_023_AC3_absent_checkpoint_budget_falls_back_to_its_own_default_not_the_hold_budget', async () => {
  const signature = 'an absent checkpointMaxBytes inherited the hold budget instead of its own default';
  const limits = await loadRuntimeConfig({ visibleOutputQueueMaxBytes: 1_048_576 });

  assert.equal(limits.visibleOutputQueueMaxBytes, 1_048_576, signature);
  assert.equal(limits.checkpointMaxBytes, DEFAULT_CHECKPOINT_MAX_BYTES, signature);
  assert.notEqual(limits.checkpointMaxBytes, 1_048_576, signature);
});

test('REL_BGSTAB_023_AC3_an_out_of_range_checkpoint_budget_does_not_silently_coerce', async () => {
  // Boundary: the terminal block resolver rejects the whole block on any out-of-range integer and
  // returns the shipped defaults, exactly as it already does for its sibling byte keys. The new key
  // must join that contract rather than being clamped into range on its own.
  const signature = 'an out-of-range checkpointMaxBytes was silently coerced instead of falling back with its block';
  const belowMinimum = await loadRuntimeConfig({ checkpointMaxBytes: 512 });
  assert.equal(belowMinimum.checkpointMaxBytes, DEFAULT_CHECKPOINT_MAX_BYTES, signature);
  assert.equal(belowMinimum.visibleOutputQueueMaxBytes, DEFAULT_VISIBLE_OUTPUT_QUEUE_MAX_BYTES, signature);

  const aboveMaximum = await loadRuntimeConfig({ checkpointMaxBytes: 268_435_457 });
  assert.equal(aboveMaximum.checkpointMaxBytes, DEFAULT_CHECKPOINT_MAX_BYTES, signature);
  assert.equal(aboveMaximum.visibleOutputQueueMaxBytes, DEFAULT_VISIBLE_OUTPUT_QUEUE_MAX_BYTES, signature);
});

test('REL_BGSTAB_023_AC5_shipped_defaults_keep_the_effective_checkpoint_budget_unchanged', async () => {
  const signature = 'introducing the key changed the effective default checkpoint budget';
  const limits = await loadRuntimeConfig({});

  assert.equal(limits.checkpointMaxBytes, DEFAULT_CHECKPOINT_MAX_BYTES, signature);
  assert.equal(limits.visibleOutputQueueMaxBytes, DEFAULT_VISIBLE_OUTPUT_QUEUE_MAX_BYTES, signature);
  assert.equal(limits.checkpointMaxBytes, limits.visibleOutputQueueMaxBytes, signature);
});

test('REL_BGSTAB_023_AC2_the_only_production_call_site_passes_the_checkpoint_budget_separately', () => {
  // `TerminalView#mountTerminalRuntime` holds the only production `createTerminalWriteCoordinator`
  // call. This is the coupling site issue #25 names, and the boundary the terminal resource
  // consumer manifest also guards. Asserted on source text because the surrounding effect cannot be
  // invoked without mounting the whole terminal runtime; the manifest guard cross-checks it.
  const signature = 'TerminalView still lets the checkpoint budget default to the post-checkpoint hold budget';
  const source = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const callSite = source.indexOf('createTerminalWriteCoordinator(');
  assert.notEqual(callSite, -1, `${signature}; the production call site moved`);

  // Bound the search to the options object literal of that one call. Slicing to the end of this
  // ~3800-line file would let a comment, an unrelated object literal, or a second coordinator
  // construction anywhere below satisfy the assertion. Sibling option lines stay free to move
  // around inside the literal.
  const optionsStart = source.indexOf('{', callSite);
  assert.notEqual(optionsStart, -1, `${signature}; the production call site has no options object`);
  const optionsEnd = endOfObjectLiteral(source, optionsStart);
  assert.notEqual(optionsEnd, source.length, `${signature}; the production options object is unterminated`);
  const optionsRegion = source.slice(optionsStart, optionsEnd);

  const holdBudget = optionsRegion.indexOf('postCheckpointMaxBytes: coordinatorLimits.visibleOutputQueueMaxBytes');
  assert.notEqual(holdBudget, -1, `${signature}; the hold budget option moved`);

  const checkpointBudget = optionsRegion.indexOf('checkpointMaxBytes: coordinatorLimits.checkpointMaxBytes');
  assert.notEqual(
    checkpointBudget,
    -1,
    `${signature}; it must pass checkpointMaxBytes: coordinatorLimits.checkpointMaxBytes`,
  );
});

test('REL_BGSTAB_023_AC6_the_chunk_budget_deliberately_still_converges_on_the_hold_budget', () => {
  // Out of scope for REL-BGSTAB-023 by decision, not by impossibility. This test exists so the
  // exclusion is explicit and a later change to it is visible rather than silent.
  const signature = 'the chunk budget separation was changed without a requirement covering it';
  const source = readFileSync(
    new URL('../../src/utils/terminalWriteCoordinator.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /options\.checkpointMaxChunks \?\? postCheckpointMaxChunks/u,
    signature,
  );
});

test('REL_BGSTAB_023_AC2_checkpoint_admission_and_post_checkpoint_hold_are_governed_separately', () => {
  // Boundary/regression guard on the coordinator half, which already supports an independent value.
  // A snapshot larger than the hold budget but within the checkpoint budget must be admitted when
  // the two are configured separately, and rejected when the checkpoint budget is left to default.
  const signature = 'the checkpoint admission arm and the post-checkpoint hold arm shared one byte budget';
  const factory = (terminalWriteCoordinatorModule as Record<string, unknown>).createTerminalWriteCoordinator;
  assert.equal(typeof factory, 'function', `${signature}; coordinator factory missing`);

  const body = encoder.encode('x'.repeat(4096));
  const parserTail = encoder.encode('\x1b[');
  const begin = {
    type: 'checkpoint-begin',
    streamEpoch: '1',
    checkpointEpoch: '1',
    sourceSeq: '10',
    snapshotSeq: '10',
    oldestRetainedSeq: '1',
    retentionPolicyId: 'retained-state-v1',
    viewGeneration: 7,
    chunkCount: 1,
    encodedByteTotal: body.byteLength,
    digest: `size-probe:${body.byteLength}`,
    cols: 120,
    rows: 40,
    modes: { wraparoundMode: true },
    parserTail,
  };

  const build = (options: Record<string, unknown>) => (factory as (input: Record<string, unknown>) => {
    dispatch(command: unknown): { accepted: boolean; reason?: string };
  })({
    viewGeneration: 7,
    adapter: createInertAdapter(),
    digestBytes: (bytes: Uint8Array) => `size-probe:${bytes.byteLength}`,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    ...options,
  });

  assert.deepEqual(
    build({ checkpointMaxBytes: 1_048_576 }).dispatch(begin),
    { accepted: true },
    `${signature}; a snapshot within its own budget was refused`,
  );
  assert.deepEqual(
    build({}).dispatch(begin),
    { accepted: false, reason: 'invalid-checkpoint-metadata' },
    `${signature}; the coupled fallback no longer rejects, so this test no longer characterises it`,
  );
});

/**
 * Offset one past the `}` closing the object literal that opens at `start`, ignoring braces inside
 * string/template literals and comments. Returns `source.length` when the literal never closes.
 */
function endOfObjectLiteral(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index = endOfStringLiteral(source, index);
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return source.length;
}

function endOfStringLiteral(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index = endOfObjectLiteral(source, index + 1);
      continue;
    }
    index += 1;
  }
  return source.length;
}

function createInertAdapter(): Record<string, unknown> {
  return {
    write: (_command: unknown, onWritten: () => void) => { onWritten(); },
    resetParser: () => {},
    resize: () => {},
    applyModes: () => {},
    clearScreen: () => {},
    fit: () => ({ cols: 120, rows: 40 }),
    setWindowsPty: () => {},
    markReady: () => {},
    releaseInput: () => {},
    settleInput: () => {},
    requestFreshRecovery: () => {},
    requestRuntimeRecreation: () => {},
    compatibilityRecoveryDrained: () => {},
    checkpointApplied: () => {},
    checkpointDrained: () => {},
    settle: () => {},
  };
}

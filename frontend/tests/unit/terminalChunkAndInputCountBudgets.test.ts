// Issues #70 and #72. Two more budgets that production collapsed into one number at the same
// call site, for the same reason as the byte axis #25 fixed: the coordinator accepts independent
// values, and `TerminalView` -- the only production caller -- passed the OUTPUT chunk cap for all
// of them.
//
//   postCheckpointMaxChunks      <- visibleOutputMaxChunks   (correct: it IS the hold budget)
//   checkpointMaxChunks          <- (omitted, so `?? postCheckpointMaxChunks`)   #70
//   pendingInputMaxCount         <- visibleOutputMaxChunks   #72
//   settlementLedgerMaxEntries   <- visibleOutputMaxChunks   #72
//
// #25 recorded why the chunk axis was left out: "the coordinator already handles the chunk cap
// independently, so a unit test written against it passes today". That is true of the
// coordinator and false of production -- the plumbing is what was missing, and a test that
// drives the configuration into the production call site fails. These are that test.
//
// #72 is the one with a named failure mode rather than an asymmetry: an operator tuning OUTPUT
// chunking downward silently lowers the cap on how many INPUTS may be pending, and the input
// admission arm rejects beyond it. Nothing about output chunking should be able to starve input.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getTerminalResourceLimits,
  initializeInputReliabilityMode,
} from '../../src/utils/inputReliabilityMode.ts';

// Shipped defaults. Both new keys default to the number their borrowed key already resolved to,
// so introducing them changes no effective behaviour.
const DEFAULT_VISIBLE_OUTPUT_MAX_CHUNKS = 512;
const DEFAULT_CHECKPOINT_MAX_CHUNKS = 512;
const DEFAULT_INPUT_QUEUE_MAX_COUNT = 512;

type TerminalLimitsWithCountBudgets = ReturnType<typeof getTerminalResourceLimits> & {
  checkpointMaxChunks: number;
  inputQueueMaxCount: number;
};

async function loadRuntimeConfig(terminal: Record<string, unknown>): Promise<TerminalLimitsWithCountBudgets> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    resourceLimits: { terminal },
  }), { status: 200 });
  try {
    await initializeInputReliabilityMode();
    return getTerminalResourceLimits() as TerminalLimitsWithCountBudgets;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function productionCoordinatorOptions(): string {
  const source = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const callSite = source.indexOf('createTerminalWriteCoordinator(');
  assert.notEqual(callSite, -1, 'the production call site moved');
  const optionsStart = source.indexOf('{', callSite);
  assert.notEqual(optionsStart, -1, 'the production call site has no options object');
  // Bound the search to that one options literal: slicing to the end of this ~3800-line file
  // would let an unrelated object anywhere below satisfy the assertions.
  let depth = 0;
  let end = source.length;
  for (let index = optionsStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  assert.notEqual(end, source.length, 'the production options object is unterminated');
  return source.slice(optionsStart, end);
}

test('#70 a configured checkpoint chunk budget survives runtime-config resolution', async () => {
  const limits = await loadRuntimeConfig({
    visibleOutputMaxChunks: 64,
    checkpointMaxChunks: 1024,
  });
  assert.equal(limits.checkpointMaxChunks, 1024);
  assert.equal(limits.visibleOutputMaxChunks, 64);
  assert.notEqual(limits.checkpointMaxChunks, limits.visibleOutputMaxChunks,
    'the two chunk budgets collapsed back into one number');
});

test('#70 an absent checkpoint chunk budget falls back to its own default, not the hold budget', async () => {
  const limits = await loadRuntimeConfig({ visibleOutputMaxChunks: 64 });
  assert.equal(limits.visibleOutputMaxChunks, 64);
  assert.equal(limits.checkpointMaxChunks, DEFAULT_CHECKPOINT_MAX_CHUNKS);
  assert.notEqual(limits.checkpointMaxChunks, 64);
});

test('#70 the production call site passes the checkpoint chunk budget separately', () => {
  const options = productionCoordinatorOptions();
  assert.ok(options.includes('postCheckpointMaxChunks: coordinatorLimits.visibleOutputMaxChunks'),
    'the hold chunk budget option moved');
  assert.ok(options.includes('checkpointMaxChunks: coordinatorLimits.checkpointMaxChunks'),
    'production must pass checkpointMaxChunks: coordinatorLimits.checkpointMaxChunks');
});

test('#72 a configured input count budget survives runtime-config resolution', async () => {
  const limits = await loadRuntimeConfig({
    visibleOutputMaxChunks: 64,
    inputQueueMaxCount: 256,
  });
  assert.equal(limits.inputQueueMaxCount, 256);
  assert.equal(limits.visibleOutputMaxChunks, 64);
});

test('#72 lowering the OUTPUT chunk cap does not lower the INPUT count cap', async () => {
  // The failure mode this issue asked to confirm: an operator tuning output chunking downward
  // used to take the pending-input cap and the settlement ledger cap down with it, because both
  // read the output-scope key. Input scope now has its own key with its own default.
  const limits = await loadRuntimeConfig({ visibleOutputMaxChunks: 4 });
  assert.equal(limits.visibleOutputMaxChunks, 4);
  assert.equal(limits.inputQueueMaxCount, DEFAULT_INPUT_QUEUE_MAX_COUNT,
    'an output-scope knob must not decide how many inputs may be pending');
});

test('#72 the production call site sources both input count options from input scope', () => {
  const options = productionCoordinatorOptions();
  assert.ok(options.includes('pendingInputMaxCount: coordinatorInputLimits.inputQueueMaxCount'),
    'pendingInputMaxCount must come from the input-scope key');
  assert.ok(options.includes('settlementLedgerMaxEntries: coordinatorInputLimits.inputQueueMaxCount'),
    'settlementLedgerMaxEntries must come from the input-scope key');
  assert.ok(!options.includes('pendingInputMaxCount: coordinatorLimits.visibleOutputMaxChunks'),
    'pendingInputMaxCount must no longer borrow the output chunk cap');
  assert.ok(!options.includes('settlementLedgerMaxEntries: coordinatorLimits.visibleOutputMaxChunks'),
    'settlementLedgerMaxEntries must no longer borrow the output chunk cap');
});

test('#70 #72 shipped defaults keep every effective count budget unchanged', async () => {
  const limits = await loadRuntimeConfig({});
  assert.equal(limits.visibleOutputMaxChunks, DEFAULT_VISIBLE_OUTPUT_MAX_CHUNKS);
  assert.equal(limits.checkpointMaxChunks, DEFAULT_CHECKPOINT_MAX_CHUNKS);
  assert.equal(limits.inputQueueMaxCount, DEFAULT_INPUT_QUEUE_MAX_COUNT);
  assert.equal(limits.checkpointMaxChunks, limits.visibleOutputMaxChunks,
    'the checkpoint chunk default must equal what it used to inherit');
  assert.equal(limits.inputQueueMaxCount, limits.visibleOutputMaxChunks,
    'the input count default must equal what it used to inherit');
});

test('#70 #72 an out-of-range count budget falls back with its block instead of coercing', async () => {
  for (const terminal of [{ checkpointMaxChunks: 0 }, { checkpointMaxChunks: 65_537 },
    { inputQueueMaxCount: 0 }, { inputQueueMaxCount: 65_537 }]) {
    const limits = await loadRuntimeConfig(terminal);
    assert.equal(limits.checkpointMaxChunks, DEFAULT_CHECKPOINT_MAX_CHUNKS, JSON.stringify(terminal));
    assert.equal(limits.inputQueueMaxCount, DEFAULT_INPUT_QUEUE_MAX_COUNT, JSON.stringify(terminal));
    assert.equal(limits.visibleOutputMaxChunks, DEFAULT_VISIBLE_OUTPUT_MAX_CHUNKS, JSON.stringify(terminal));
  }
});

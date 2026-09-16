import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BENCHMARK_MODES,
  validateExecutionManifest,
  type BenchmarkExecutionManifest,
  type BenchmarkMode,
} from './benchmarkStatistics.js';
import {
  createTerminalCharacterizationManifest,
  createTerminalWorkloadCorpus,
  planExecutionOrder,
} from './terminalCharacterization.js';

// @req PERF-BGSTAB-012
//
// PERF-BGSTAB-008 AC-1..AC-7 are satisfied by the sealed Wave-1 run. This file
// covers only the three obligations GitHub issue #3 added and PERF-BGSTAB-008
// never contracted: an outlier policy, an execution-derived interleaved order,
// and visibility as an independently varied factor. It also pins the sealed
// artifacts so that satisfying those three cannot quietly rewrite them.

const SEALED_DIR = '../../../docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline';

/**
 * Two different digests, deliberately both pinned.
 *
 * `contentDigest` is what PERF-BGSTAB-008 VE-2 and VE-3 quote and what the
 * MIG-BGSTAB-001 G1 evidence audit binds: a canonical digest of the artifact's
 * content, computed over the object rather than the file. `fileSha256` is the
 * digest of the bytes on disk, measured on 2026-09-16.
 *
 * The content digest alone is the weaker seal, because a reformatting or a
 * change to a field outside the canonicalised subset leaves it untouched. The
 * file digest alone would not tell a reader that the value the SRS quotes is
 * still the value the artifact carries. AC-4 wants both to hold.
 */
const SEALED_DIGESTS: ReadonlyArray<{
  readonly name: string;
  readonly contentDigest: string;
  readonly fileSha256: string;
}> = [
  {
    name: 'benchmark-raw-samples.json',
    contentDigest: 'sha256:d82398218a04418de9a3bbf6b38a124a5f05ceaa7aa2f008dc5dc625dbcdc146',
    fileSha256: '459ab0ba9e104f19d2f193df8b64cb6b71081c971fd55a12240ccc6f25ed50cf',
  },
  {
    name: 'benchmark-summary.json',
    contentDigest: 'sha256:bb63c56be66e04b9ec05a2a72aa736ac4d3baa6b08820003686f23c4eeafa583',
    fileSha256: 'bb8ed018fe3d7179d0e335cd224ef339d6ba1e822b60fc7243af84c2eea387b3',
  },
];

function manifest(): BenchmarkExecutionManifest {
  return createTerminalCharacterizationManifest();
}

// @req PERF-BGSTAB-012 AC-1
test('PERF-BGSTAB-012 the manifest records an outlier policy, explicitly when nothing is excluded', () => {
  const m = manifest();
  const policy = m.outlierPolicy;

  assert.ok(policy, 'the manifest must carry an outlier policy');
  assert.ok(policy.rule.length > 0, 'the policy must name the rule applied');
  assert.ok(Array.isArray(policy.excludedSampleIds), 'the policy must list excluded samples');

  // AC-1: retaining every sample is recorded explicitly rather than by omission,
  // so a reader can tell "we kept everything" apart from "nobody decided".
  if (policy.rule === 'retain-all') {
    assert.deepEqual(policy.excludedSampleIds, [], 'retain-all must exclude nothing');
  }

  assert.doesNotThrow(() => validateExecutionManifest(m, { requireObservedOrder: false }));

  // The validator must actually enforce it, or the assertion above only
  // describes today's builder and not the contract.
  const stripped: Record<string, unknown> = { ...m };
  delete stripped.outlierPolicy;
  assert.throws(
    () => validateExecutionManifest(stripped),
    /outlierPolicy/u,
    'a manifest without an outlier policy must be rejected',
  );
});

// @req PERF-BGSTAB-012 AC-2
test('PERF-BGSTAB-012 the manifest records an execution-derived interleaved arm order', () => {
  const m = manifest();
  const execution = m.execution;

  assert.ok(execution, 'the manifest must carry an execution record');
  // The label names exactly what the record holds: the planned arm sequence,
  // with a completion timestamp measured per unit. The runner is one loop over
  // the plan, so it cannot walk a different sequence, and a label claiming the
  // sequence was discovered would be false.
  assert.equal(
    execution.derivedFrom,
    'planned-sequence-with-observed-completions',
    'the record must name the planned sequence and the observed completions, not claim a discovered order',
  );
  assert.equal(execution.interleaved, true);
  // An unrun manifest has taken no timestamp, so it can have nudged none.
  assert.equal(execution.tieBrokenCount, 0, 'an unrun manifest cannot have tie-broken a timestamp');
  assert.ok(execution.plannedOrder.length > 1, 'the plan must describe more than one unit of work');

  // The builder cannot know the observed order, so it emits the plan and leaves
  // `order` empty. That emptiness is the point: a builder that filled `order` in
  // would be publishing a declaration under an observed label.
  assert.deepEqual(execution.order, [], 'an unrun manifest must not claim an observed order');

  // The substance of AC-2: arms alternate rather than running as contiguous
  // blocks. A block-ordered run would let machine drift land entirely on one
  // arm, which is exactly what interleaving is for.
  const modes = [...new Set(execution.plannedOrder.map((step) => step.mode))];
  assert.ok(modes.length > 1, 'interleaving is only meaningful across more than one arm');

  // Strengthened from `longestRun < plannedOrder.length / modes.length`. That
  // compared the run against the arm's fair share, which a 252-step order of
  // 125 NO_ANALYZER, one NO_RENDER, 125 NO_ANALYZER, one NO_RENDER satisfies —
  // the exact block concentration interleaving exists to prevent. Consecutive
  // units must simply differ in mode, which no block order can satisfy.
  let longestRun = 1;
  let currentRun = 1;
  for (let i = 1; i < execution.plannedOrder.length; i += 1) {
    currentRun = execution.plannedOrder[i].mode === execution.plannedOrder[i - 1].mode ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }
  assert.equal(
    longestRun,
    1,
    `arms must interleave; longest same-arm run was ${longestRun} of ${execution.plannedOrder.length}`,
  );

  // Sequence numbers must be dense and ordered, so a partially recorded run
  // cannot masquerade as a complete interleave.
  execution.plannedOrder.forEach((step, index) => {
    assert.equal(step.sequence, index, 'execution order sequence numbers must be dense and ascending');
  });

  const stripped: Record<string, unknown> = { ...m };
  delete stripped.execution;
  assert.throws(
    () => validateExecutionManifest(stripped),
    /execution/u,
    'a manifest without an execution record must be rejected',
  );
});

// @req PERF-BGSTAB-012 AC-2
test('PERF-BGSTAB-012 an observed execution order must be timestamped and advance in time', () => {
  const m = manifest();

  // `observedAtMs` is the only field in `order` that the plan does not already
  // supply, so an untimestamped entry carries no observation at all. The
  // validator must reject it rather than take the `derivedFrom` label — which a
  // producer simply writes — at its word.
  const untimestamped = structuredClone(m) as unknown as Record<string, unknown>;
  (untimestamped.execution as { order: unknown[] }).order = m.execution.plannedOrder
    .map((step) => ({ ...step }));
  assert.throws(
    () => validateExecutionManifest(untimestamped),
    /observedAtMs/u,
    'an execution order without completion timestamps must be rejected',
  );

  // Timestamps that do not advance describe no sequence at all.
  const stalled = structuredClone(m) as unknown as Record<string, unknown>;
  (stalled.execution as { order: unknown[] }).order = m.execution.plannedOrder
    .map((step) => ({ ...step, observedAtMs: 100 }));
  assert.throws(
    () => validateExecutionManifest(stalled),
    /observedAtMs/u,
    'an execution order whose timestamps do not advance must be rejected',
  );

  // And a well-formed observation passes.
  const observed = structuredClone(m) as unknown as Record<string, unknown>;
  (observed.execution as { order: unknown[] }).order = m.execution.plannedOrder
    .map((step, index) => ({ ...step, observedAtMs: 100 + index }));
  assert.doesNotThrow(() => validateExecutionManifest(observed));

  // A run that has not happened yet is only legal for the builder, which says so.
  assert.throws(
    () => validateExecutionManifest(structuredClone(m)),
    /observed step/u,
    'a persisted manifest must carry an observed order',
  );
});

// @req PERF-BGSTAB-012 AC-2
test('PERF-BGSTAB-012 the interleaved flag is recomputed, not believed', () => {
  const m = manifest();

  // `interleaved: true` beside a block-ordered array is a producer literal that
  // nothing checks. The validator computes the longest same-arm run instead.
  const blocked = structuredClone(m) as unknown as Record<string, unknown>;
  const execution = blocked.execution as { plannedOrder: unknown[]; order: unknown[] };
  const blockOrdered = [...m.execution.plannedOrder]
    .sort((left, right) => (left.mode < right.mode ? -1 : left.mode > right.mode ? 1 : 0))
    .map((step, index) => ({ ...step, sequence: index }));
  execution.plannedOrder = blockOrdered;
  execution.order = blockOrdered.map((step, index) => ({ ...step, observedAtMs: 100 + index }));
  assert.throws(
    () => validateExecutionManifest(blocked),
    /not interleaved/u,
    'a block-ordered run must not be able to declare itself interleaved',
  );
});

// @req PERF-BGSTAB-012 AC-2
test('PERF-BGSTAB-012 a block-concentrated order cannot pass as interleaved, and a two-step alternation can', () => {
  const m = manifest();

  // The case the fair-share threshold accepted: two long blocks of one arm,
  // separated by a single step of the other. Its longest run is just under the
  // arm's fair share, so the old rule let it through.
  const concentrated = structuredClone(m) as unknown as Record<string, unknown>;
  const modes = ['NO_ANALYZER', 'NO_RENDER'];
  const blocky = [
    ...Array.from({ length: 125 }, () => modes[0]),
    modes[1],
    ...Array.from({ length: 125 }, () => modes[0]),
    modes[1],
  ].map((mode, index) => ({ sequence: index, mode, workloadIndex: 0, trialId: 'trial-1' }));
  const concentratedExecution = concentrated.execution as { plannedOrder: unknown[]; order: unknown[] };
  concentratedExecution.plannedOrder = blocky;
  concentratedExecution.order = blocky.map((step, index) => ({ ...step, observedAtMs: 100 + index }));
  assert.throws(
    () => validateExecutionManifest(concentrated),
    /not interleaved/u,
    'a block-concentrated order must be rejected however long the blocks are',
  );

  // And the case the fair-share threshold rejected: a genuinely alternating pair,
  // whose longest run of 1 is not less than its fair share of 1.
  const pair = structuredClone(m) as unknown as Record<string, unknown>;
  const twoStep = modes.map((mode, index) => ({
    sequence: index,
    mode,
    workloadIndex: 0,
    trialId: 'trial-1',
  }));
  const pairExecution = pair.execution as { plannedOrder: unknown[]; order: unknown[] };
  pairExecution.plannedOrder = twoStep;
  pairExecution.order = twoStep.map((step, index) => ({ ...step, observedAtMs: 100 + index }));
  assert.doesNotThrow(
    () => validateExecutionManifest(pair),
    'a two-step alternation is interleaved and must be accepted',
  );
});

// @req PERF-BGSTAB-012 AC-2
test('PERF-BGSTAB-012 the count of tie-broken completion timestamps is recorded and required', () => {
  const m = manifest();
  const observed = structuredClone(m) as unknown as Record<string, unknown>;
  (observed.execution as { order: unknown[] }).order = m.execution.plannedOrder
    .map((step, index) => ({ ...step, observedAtMs: 100 + index }));
  assert.doesNotThrow(() => validateExecutionManifest(observed));

  // Without the count, a run on a host whose clock never advanced would publish
  // a strictly increasing ramp of fabricated readings and look identical to a
  // healthy run. The field has to be present for that to be distinguishable.
  const stripped = structuredClone(observed);
  delete (stripped.execution as Record<string, unknown>).tieBrokenCount;
  assert.throws(
    () => validateExecutionManifest(stripped),
    /tieBrokenCount/u,
    'a manifest that does not say how many timestamps were nudged must be rejected',
  );

  const negative = structuredClone(observed);
  (negative.execution as Record<string, unknown>).tieBrokenCount = -1;
  assert.throws(() => validateExecutionManifest(negative), /tieBrokenCount/u);

  const fractional = structuredClone(observed);
  (fractional.execution as Record<string, unknown>).tieBrokenCount = 1.5;
  assert.throws(() => validateExecutionManifest(fractional), /tieBrokenCount/u);

  // A run that did nudge is still valid; the count is a disclosure, not a gate.
  const nudged = structuredClone(observed);
  (nudged.execution as Record<string, unknown>).tieBrokenCount = m.execution.plannedOrder.length;
  assert.doesNotThrow(() => validateExecutionManifest(nudged));
});

// @req PERF-BGSTAB-012
test('PERF-BGSTAB-012 the sealed schemaVersion 1 manifest still validates', () => {
  // The three PERF-BGSTAB-012 fields were added as required fields. Had they
  // been required at every schema version, the sealed Wave-1 manifest — which
  // predates them — would have started failing the schema it was written
  // against. The version is what separates the two shapes.
  const bytes = readFileSync(new URL(`${SEALED_DIR}/benchmark-raw-samples.json`, import.meta.url));
  const sealedManifest = (JSON.parse(bytes.toString('utf8')) as {
    manifest: Record<string, unknown>;
  }).manifest;

  assert.equal(sealedManifest.schemaVersion, 1, 'the sealed manifest is the pre-PERF-BGSTAB-012 shape');
  assert.equal(sealedManifest.outlierPolicy, undefined);
  assert.equal(sealedManifest.execution, undefined);
  assert.equal(sealedManifest.visibilityFactor, undefined);
  assert.doesNotThrow(
    () => validateExecutionManifest(sealedManifest),
    'the sealed Wave-1 manifest must still satisfy the schema it declares',
  );

  // A v1 manifest must not be able to smuggle the v2 fields in either, or the
  // version would stop meaning anything.
  assert.throws(
    () => validateExecutionManifest({
      ...sealedManifest,
      outlierPolicy: { rule: 'retain-all', rationale: 'x', parameters: {}, excludedSampleIds: [] },
    }),
    /schemaVersion 2/u,
  );

  // And the current builder emits the newer version.
  assert.equal(manifest().schemaVersion, 2, 'new manifests declare the PERF-BGSTAB-012 shape');
});

// @req PERF-BGSTAB-012 AC-3
test('PERF-BGSTAB-012 visibility is varied independently for every multi-session cell', () => {
  const corpus = createTerminalWorkloadCorpus();

  const byCell = new Map<string, Set<string>>();
  for (const workload of corpus) {
    const cell = `${workload.sessions}x${workload.clients}`;
    const mix = `${workload.viewMix.active}/${workload.viewMix.hidden}`;
    if (!byCell.has(cell)) byCell.set(cell, new Set());
    byCell.get(cell)?.add(mix);
  }

  assert.deepEqual(
    [...new Set(corpus.map((w) => w.sessions))].sort((a, b) => a - b),
    [1, 8, 32, 54],
    'the session axis must be unchanged',
  );
  assert.deepEqual(
    [...new Set(corpus.map((w) => w.clients))].sort((a, b) => a - b),
    [1, 2, 8],
    'the client axis must be unchanged',
  );

  for (const [cell, mixes] of byCell) {
    const sessions = Number(cell.split('x')[0]);
    if (sessions === 1) {
      // One session cannot be both partly hidden and fully visible, so the
      // second level is structurally unreachable rather than missing.
      assert.equal(mixes.size, 1, `${cell} admits exactly one visibility level`);
      continue;
    }
    assert.ok(
      mixes.size >= 2,
      `${cell} must vary visibility independently, saw only ${[...mixes].join(', ')}`,
    );
  }

  // AC-3 also requires the unreachable level to be recorded rather than
  // silently omitted, so the manifest says so in a machine-readable field.
  const visibility = manifest().visibilityFactor;
  assert.ok(visibility, 'the manifest must record the visibility factor');
  assert.ok(
    visibility.structurallyUnreachable.length > 0,
    'the single-session cells must be recorded as structurally unreachable',
  );
  for (const entry of visibility.structurallyUnreachable) {
    assert.ok(entry.reason.length > 0, 'each unreachable cell must record why');
  }
});

// @req PERF-BGSTAB-012 AC-4
test('PERF-BGSTAB-012 the sealed Wave-1 benchmark artifacts are byte-identical', () => {
  // AC-4. These two digests are quoted in PERF-BGSTAB-008 VE-2 and VE-3 and in
  // the MIG-BGSTAB-001 G1 evidence audit. Regenerating them in place would
  // retroactively invalidate that audit, so the contract is that new data goes
  // to a new directory and these files do not move.
  for (const sealed of SEALED_DIGESTS) {
    const bytes = readFileSync(new URL(`${SEALED_DIR}/${sealed.name}`, import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      sealed.fileSha256,
      `${sealed.name} is sealed by PERF-BGSTAB-008 and the G1 evidence audit; it must not be regenerated in place`,
    );

    const parsed = JSON.parse(bytes.toString('utf8')) as { contentDigest?: string };
    assert.equal(
      parsed.contentDigest,
      sealed.contentDigest,
      `${sealed.name} must still carry the contentDigest that PERF-BGSTAB-008 and the G1 audit quote`,
    );
  }
});

// @req PERF-BGSTAB-012 AC-2
//
// `planExecutionOrder` is the whole of the interleave guarantee: the runner is a
// single loop over what this function returns, so whatever it emits is what ran.
// Until this test existed the only coverage came through the manifest builder,
// which always passes the four default modes and so only ever exercised the
// rotating branch. The two-arm branch — added because a per-trial rotation puts
// the same arm on both sides of a trial boundary at exactly two arms, producing
// `A B | B A` — had no test at all, and deleting it left every suite green.
//
// The table is deliberately wider than the production call: arm counts either
// side of the branch, workload counts including one and a large odd number, and
// trial counts including one and two, because the defect appears at a boundary
// between trials and so needs at least two of them to show up.
test('PERF-BGSTAB-012 AC-2 planExecutionOrder alternates arms and covers every cell exactly once', () => {
  const armCounts = [2, 3, 4] as const;
  const workloadCounts = [1, 2, 3, 21] as const;
  const trialCounts = [1, 2, 3] as const;

  for (const armCount of armCounts) {
    const modes: BenchmarkMode[] = BENCHMARK_MODES.slice(0, armCount);
    assert.equal(modes.length, armCount, 'the fixture must supply as many distinct arms as the case names');

    for (const workloadCount of workloadCounts) {
      for (const trialCount of trialCounts) {
        const label = `${armCount} arms x ${workloadCount} workloads x ${trialCount} trials`;
        const order = planExecutionOrder(modes, workloadCount, trialCount);

        assert.equal(
          order.length,
          armCount * workloadCount * trialCount,
          `${label}: the plan must hold exactly one unit per (mode, workload, trial) cell`,
        );

        // The property `assertInterleaved` enforces on the persisted manifest,
        // asserted here at the source so a plan that breaks it cannot be built
        // in the first place. Trial boundaries are included because that is
        // where the rotation defect appeared.
        for (let index = 1; index < order.length; index += 1) {
          assert.notEqual(
            order[index].mode,
            order[index - 1].mode,
            `${label}: steps ${index - 1} and ${index} both ran ${order[index].mode}, so consecutive units did not alternate arms`,
          );
        }

        // Dense and ascending from zero: a plan with a hole or a repeat would
        // let a partial record look complete.
        for (const [index, step] of order.entries()) {
          assert.equal(step.sequence, index, `${label}: sequence must be dense and ascending from 0`);
        }

        // Alternation alone is satisfiable by a plan that drops cells and
        // repeats others, so coverage is checked as a multiset rather than a
        // set: every cell present, none twice.
        const cells = order.map(step => `${step.mode}|${step.workloadIndex}|${step.trialId}`);
        assert.equal(
          new Set(cells).size,
          cells.length,
          `${label}: no (mode, workloadIndex, trialId) cell may appear twice`,
        );
        const expected: string[] = [];
        for (let trial = 1; trial <= trialCount; trial += 1) {
          for (let workloadIndex = 0; workloadIndex < workloadCount; workloadIndex += 1) {
            for (const mode of modes) expected.push(`${mode}|${workloadIndex}|trial-${trial}`);
          }
        }
        assert.deepEqual(
          [...cells].sort(),
          expected.sort(),
          `${label}: the plan must cover every (mode, workloadIndex, trialId) cell exactly once`,
        );
      }
    }
  }
});

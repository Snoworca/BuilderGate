import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  validateExecutionManifest,
  type BenchmarkExecutionManifest,
} from './benchmarkStatistics.js';
import {
  createTerminalCharacterizationManifest,
  createTerminalWorkloadCorpus,
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
  assert.equal(execution.derivedFrom, 'execution', 'the order must be observed, not declared in advance');
  assert.equal(execution.interleaved, true);
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

  let longestRun = 1;
  let currentRun = 1;
  for (let i = 1; i < execution.plannedOrder.length; i += 1) {
    currentRun = execution.plannedOrder[i].mode === execution.plannedOrder[i - 1].mode ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }
  assert.ok(
    longestRun < execution.plannedOrder.length / modes.length,
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

  // Without `observedAtMs` the executed order is a copy of the plan wearing an
  // observed label, which is precisely what AC-2 refuses to accept. The
  // validator must reject an untimestamped entry rather than take the
  // `derivedFrom: 'execution'` string at its word.
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

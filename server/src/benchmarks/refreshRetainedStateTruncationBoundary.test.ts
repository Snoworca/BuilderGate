import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION,
  classifyRefreshRetainedLineLoss,
  measureRefreshRetainedStateBoundary,
  measureRefreshTruncationFiringBoundary,
  produceRefreshTruncationBoundaryEvidence,
} from './refreshRetainedStateTruncationBoundary.js';

const EVIDENCE_PATH = new URL(
  '../../../docs/analysis/2026-09-16.refresh-retained-state-boundary/refresh-truncation-boundary.json',
  import.meta.url,
);
const PR_MAP_PATH = new URL(
  '../../../docs/analysis/2026-09-16.refresh-retained-state-boundary/pr-decomposition-and-rollback-gates.json',
  import.meta.url,
);

// @req OBS-BGSTAB-009
const FIXTURE = { cols: 80, rows: 24, scrollbackLines: 100 } as const;

test('OBS-BGSTAB-009 AC-1 reproduces refresh retained-state truncation deterministically on the viewport-only path', async () => {
  const first = await measureRefreshRetainedStateBoundary({ ...FIXTURE, logicalLines: 200 });
  const second = await measureRefreshRetainedStateBoundary({ ...FIXTURE, logicalLines: 200 });

  assert.equal(first.refreshPath, 'legacy-viewport-only-snapshot');
  assert.equal(
    first.retainedLogicalLineCount > first.refreshDeliveredLogicalLineCount,
    true,
    'refresh must deliver fewer logical lines than the retained model holds',
  );
  assert.equal(first.observedLossLogicalLines > 0, true);
  assert.notEqual(first.preRefreshLogicalLineHash, first.postRefreshLogicalLineHash);
  assert.notEqual(first.preRefreshCellHash, first.postRefreshCellHash);

  // Determinism: identical inputs must produce byte-identical boundary evidence.
  assert.deepEqual(second, first);
});

test('OBS-BGSTAB-009 AC-2 pins the firing boundary at the first logical line above the viewport', async () => {
  const atViewport = await measureRefreshRetainedStateBoundary({ ...FIXTURE, logicalLines: FIXTURE.rows });
  const pastViewport = await measureRefreshRetainedStateBoundary({
    ...FIXTURE,
    logicalLines: FIXTURE.rows + 1,
  });

  assert.equal(atViewport.observedLossLogicalLines, 0, 'no loss while all lines fit the viewport');
  assert.equal(atViewport.preRefreshLogicalLineHash, atViewport.postRefreshLogicalLineHash);

  assert.equal(pastViewport.observedLossLogicalLines, 1, 'the first line above the viewport is lost');

  // The boundary is located by ascending probe, never assumed from `rows`.
  const probed = await measureRefreshTruncationFiringBoundary({
    ...FIXTURE,
    maxProbeLogicalLines: FIXTURE.rows + 16,
  });
  assert.equal(probed.probeMethod, 'ascending-linear-probe');
  assert.equal(probed.measuredFiringBoundaryLogicalLines, FIXTURE.rows + 1);
  assert.equal(probed.largestLosslessLogicalLines, FIXTURE.rows);

  // The label alone proves nothing -- a producer could return `rows + 1` and
  // still claim to have probed. Assert the defining PROPERTY instead: the
  // reported boundary loses, and the count directly below it does not.
  const boundary = probed.measuredFiringBoundaryLogicalLines!;
  const atBoundary = await measureRefreshRetainedStateBoundary({
    ...FIXTURE,
    logicalLines: boundary,
  });
  const belowBoundary = await measureRefreshRetainedStateBoundary({
    ...FIXTURE,
    logicalLines: boundary - 1,
  });
  assert.equal(atBoundary.observedLossLogicalLines > 0, true, 'boundary must lose');
  assert.equal(belowBoundary.observedLossLogicalLines, 0, 'the count below it must not');
  assert.equal(probed.probedThroughLogicalLines, boundary, 'probe stopped at the boundary');
  assert.equal(probed.probeCapLogicalLines >= boundary, true);

  // The audit trail must be a contiguous ascending search from 1 to the
  // boundary, losing only at the last step.
  assert.deepEqual(
    probed.probeObservations.map((observation) => observation.logicalLines),
    Array.from({ length: boundary }, (_unused, index) => index + 1),
  );
  assert.equal(
    probed.probeObservations.slice(0, -1).every((o) => o.observedLossLogicalLines === 0),
    true,
  );
  assert.equal(probed.probeObservations.at(-1)!.observedLossLogicalLines > 0, true);
});

test('OBS-BGSTAB-009 AC-2 rejects a boundary that was reported without searching', async () => {
  // Round-4 review built a producer that returned `rows + 1` with the right
  // label and passed the whole suite. Counting real evaluations rules that out.
  const evaluated: number[] = [];
  const probed = await measureRefreshTruncationFiringBoundary({
    ...FIXTURE,
    maxProbeLogicalLines: FIXTURE.rows + 8,
    measure: async (input) => {
      evaluated.push(input.logicalLines);
      return measureRefreshRetainedStateBoundary(input);
    },
  });

  const boundary = probed.measuredFiringBoundaryLogicalLines!;
  assert.deepEqual(
    evaluated,
    Array.from({ length: boundary }, (_unused, index) => index + 1),
    'the producer must evaluate every count from 1 up to the boundary',
  );
  assert.equal(
    evaluated.length,
    probed.probeObservations.length,
    'every recorded observation must correspond to a real evaluation',
  );
  assert.equal(evaluated.length > 1, true, 'a single evaluation is not a search');
});

test('OBS-BGSTAB-009 AC-2 reports the boundary its measurements show, not one derived from rows', async () => {
  // Round-5 review showed that counting calls is orthogonal to derivation: a
  // producer can call `measure` the right number of times, discard every
  // result, and still return `rows + 1`. The only assertion that separates a
  // real search from arithmetic is an oracle whose answer is NOT `rows + 1`.
  const syntheticBoundary = 7;
  assert.notEqual(
    syntheticBoundary,
    FIXTURE.rows + 1,
    'the oracle must disagree with the arithmetic a faking producer would use',
  );

  const template = await measureRefreshRetainedStateBoundary({ ...FIXTURE, logicalLines: 1 });
  const evaluated: number[] = [];
  const probed = await measureRefreshTruncationFiringBoundary({
    ...FIXTURE,
    maxProbeLogicalLines: 40,
    measure: async (input) => {
      evaluated.push(input.logicalLines);
      return {
        ...template,
        producedLogicalLineCount: input.logicalLines,
        observedLossLogicalLines: input.logicalLines >= syntheticBoundary ? 3 : 0,
      };
    },
  });

  assert.equal(
    probed.measuredFiringBoundaryLogicalLines,
    syntheticBoundary,
    'the producer must follow the measurements it received',
  );
  assert.equal(probed.largestLosslessLogicalLines, syntheticBoundary - 1);
  assert.equal(probed.probedThroughLogicalLines, syntheticBoundary);
  assert.deepEqual(
    evaluated,
    Array.from({ length: syntheticBoundary }, (_unused, index) => index + 1),
    'the search must stop as soon as the oracle reports loss',
  );
  assert.deepEqual(
    probed.probeObservations.map((observation) => observation.observedLossLogicalLines),
    [...Array.from({ length: syntheticBoundary - 1 }, () => 0), 3],
    'the audit trail must record the values the oracle actually returned',
  );
});

test('OBS-BGSTAB-009 AC-2 measures the boundary on the production path, where it is not rows + 1', async () => {
  // Rounds 3, 4 and 5 each claimed to have closed "the boundary must not be
  // derived from rows", and each was defeated. The reason every time: the
  // assertion sat behind the `measure` injection seam, so a producer could
  // honour the oracle when the hook was present and return `rows + 1` when it
  // was absent -- which is the path that writes the committed artifact.
  //
  // This test uses NO injection. The fixture emits 11-character lines, so at
  // cols=8 each logical line wraps across two physical rows and fewer logical
  // lines fit the viewport. The real boundary is therefore well below rows + 1,
  // and any producer deriving it from rows alone reports the wrong number here.
  //
  // The expected values below are MEASURED, not computed. Round 8 withdrew both
  // floor(rows/h)+1 and ceil(rows/h)+1 as general rules, and floor is wrong even
  // at cols=8: 8x9 has boundary 6 while floor(9/2)+1 = 5. It agrees at these two
  // even-`rows` geometries by coincidence, which is exactly why no formula is
  // used anywhere in this suite.
  for (const geometry of [
    { cols: 8, rows: 24, scrollbackLines: 100, expected: 13 },
    { cols: 8, rows: 10, scrollbackLines: 1000, expected: 6 },
  ]) {
    const probed = await measureRefreshTruncationFiringBoundary({
      cols: geometry.cols,
      rows: geometry.rows,
      scrollbackLines: geometry.scrollbackLines,
      maxProbeLogicalLines: 40,
    });

    assert.notEqual(
      probed.measuredFiringBoundaryLogicalLines,
      geometry.rows + 1,
      'the producer must not land on rows + 1 at a wrapping geometry',
    );
    assert.equal(
      probed.measuredFiringBoundaryLogicalLines,
      geometry.expected,
      `cols=${geometry.cols} rows=${geometry.rows} must report ${geometry.expected}, not ${geometry.rows + 1}`,
    );
    assert.equal(probed.largestLosslessLogicalLines, geometry.expected - 1);
  }
});

test('OBS-BGSTAB-009 AC-2 measures the firing boundary at a second, different geometry', async () => {
  // A different `rows` must move the measured boundary, proving it tracks the
  // viewport rather than a constant baked into the producer.
  const probed = await measureRefreshTruncationFiringBoundary({
    cols: 80,
    rows: 10,
    scrollbackLines: 1000,
    maxProbeLogicalLines: 30,
  });
  assert.equal(probed.measuredFiringBoundaryLogicalLines, 11);
  assert.equal(probed.largestLosslessLogicalLines, 10);
});

test('OBS-BGSTAB-009 AC-3 separates expected eviction outside retention from loss inside retention', async () => {
  const retentionCapacity = FIXTURE.scrollbackLines + FIXTURE.rows;
  const overflowing = await measureRefreshRetainedStateBoundary({
    ...FIXTURE,
    logicalLines: retentionCapacity + 50,
  });

  assert.equal(overflowing.expectedEvictionLogicalLines, 50);
  assert.equal(overflowing.observedLossLogicalLines, retentionCapacity - FIXTURE.rows);
  assert.equal(
    overflowing.expectedEvictionLogicalLines + overflowing.observedLossLogicalLines
      + overflowing.refreshDeliveredLogicalLineCount,
    overflowing.producedLogicalLineCount,
    'every produced line is accounted for exactly once',
  );

  const classification = classifyRefreshRetainedLineLoss({
    producedLogicalLines: 10,
    retainedLogicalLines: 6,
    refreshDeliveredLogicalLines: 2,
  });
  assert.deepEqual(classification, {
    expectedEvictionLogicalLines: 4,
    observedLossLogicalLines: 4,
    preservedLogicalLines: 2,
  });
});

test('OBS-BGSTAB-009 AC-4 target retained parity holds on the authority checkpoint path', async () => {
  const measurement = await measureRefreshRetainedStateBoundary({ ...FIXTURE, logicalLines: 200 });

  // The same pre/post hashes that the refresh path fails must pass when the
  // authoritative retained checkpoint is the restore source. This is the
  // target contract of REL-BGSTAB-007 AC-3, kept separate from TC-7004.
  assert.equal(measurement.retainedCheckpointParity.logicalLines, 'match');
  assert.equal(measurement.retainedCheckpointParity.cells, 'match');
  assert.equal(measurement.retainedCheckpointParity.attributes, 'match');
  assert.equal(measurement.retainedCheckpointParity.restoreSource, 'retained-checkpoint');
});

test('OBS-BGSTAB-009 AC-5 emits machine-readable boundary evidence without raw terminal payloads', async () => {
  const evidence = await produceRefreshTruncationBoundaryEvidence();

  assert.equal(evidence.schemaVersion, REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION);
  assert.equal(evidence.requirementId, 'OBS-BGSTAB-009');
  assert.equal(evidence.evidenceKind, 'refresh_retained_state_truncation_boundary');
  assert.equal(evidence.rawPayloadOmitted, true);
  assert.equal(evidence.setsProductRetainedRows, false);

  assert.equal(evidence.seeds.length, 8, 'the corpus is exactly the 8 documented seeds');
  assert.equal(evidence.legacyByteBoundaryExercised, false);
  assert.equal(
    evidence.seeds.every((seed) => seed.snapshotTruncated === false),
    true,
    'no seed reaches the legacy 2 MiB cap, so it must not be claimed as exercised',
  );
  assert.equal(evidence.unexercisedAxes.length > 0, true);
  assert.equal(
    evidence.unexercisedAxes.includes('view:active|hidden'),
    false,
    'the view axis is inapplicable here, not merely unexercised',
  );
  assert.deepEqual(evidence.inapplicableAxes, ['view:active|hidden']);
  assert.equal(
    evidence.firingBoundaries.every(
      (boundary) =>
        boundary.measuredFiringBoundaryLogicalLines === boundary.largestLosslessLogicalLines + 1
        && boundary.probeObservations.length === boundary.measuredFiringBoundaryLogicalLines,
    ),
    true,
    // Deliberately NOT `rows + 1`: AC-2 forbids deriving the boundary from
    // rows, so the guard must not do it either. Internal consistency of the
    // search is the property that holds regardless of geometry.
    'each boundary must sit one above its largest lossless count and match its audit trail',
  );
  assert.equal(
    new Set(evidence.firingBoundaries.map((boundary) => boundary.rows)).size > 1,
    true,
    'at least two distinct row counts must be probed',
  );
  assert.equal(
    evidence.firingBoundaries.some(
      (boundary) => boundary.measuredFiringBoundaryLogicalLines !== boundary.rows + 1,
    ),
    true,
    'the committed artifact must contain a boundary that rows + 1 does not explain',
  );
  for (const seed of evidence.seeds) {
    assert.equal(typeof seed.preRefreshLogicalLineHash, 'string');
    assert.equal(seed.preRefreshLogicalLineHash.length, 64);
    assert.equal(typeof seed.postRefreshLogicalLineHash, 'string');
    assert.equal(seed.postRefreshLogicalLineHash.length, 64);
    assert.equal(typeof seed.preRefreshCellHash, 'string');
    assert.equal(typeof seed.postRefreshCellHash, 'string');
    assert.equal(seed.seedKind, 'characterization-corpus');
    assert.equal(
      JSON.stringify(seed).includes('line-'),
      false,
      'boundary evidence must not embed raw terminal text',
    );
  }

  assert.equal(evidence.contentDigest.algorithm, 'sha256');
  assert.equal(evidence.contentDigest.value.length, 64);

  // Pin the committed artifact to this producer run. Self-consistency of the
  // artifact's own digest is not enough -- a hand-edited artifact with a
  // recomputed digest, or producer drift, would both pass that check alone.
  assert.equal(
    JSON.stringify(evidence, null, 2) + '\n',
    readFileSync(EVIDENCE_PATH, 'utf8'),
    'committed boundary artifact must equal a fresh producer run byte for byte',
  );
});

test('OBS-BGSTAB-009 AC-5 keeps the committed artifact digest self-consistent', () => {
  const raw = readFileSync(EVIDENCE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { contentDigest: { value: string } };
  const { contentDigest, ...body } = parsed as Record<string, unknown> & {
    contentDigest: { value: string };
  };
  const recomputed = createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
  // Self-consistency only. Producer <-> artifact equality is pinned by the
  // sibling AC-5 test that actually runs the producer.
  assert.equal(
    recomputed,
    contentDigest.value,
    'committed artifact digest must recompute from its own body',
  );
});

test('MIG-BGSTAB-005 AC-1..AC-3 pins the PR decomposition and rollback gate map', () => {
  const map = JSON.parse(readFileSync(PR_MAP_PATH, 'utf8')) as {
    prs: {
      prId: string;
      issue: number;
      authorityRequirements: string[];
      entryGate: string;
      rollbackGate: string;
      reversible: boolean;
      dependsOn: string[];
    }[];
  };

  for (const pr of map.prs) {
    for (const field of ['prId', 'entryGate', 'rollbackGate'] as const) {
      assert.equal(typeof pr[field] === 'string' && pr[field].length > 0, true, `${pr.prId}.${field}`);
    }
    assert.equal(typeof pr.issue, 'number');
    assert.equal(typeof pr.reversible, 'boolean');
    assert.equal(Array.isArray(pr.authorityRequirements) && pr.authorityRequirements.length > 0, true);
    assert.equal(Array.isArray(pr.dependsOn), true);
  }

  assert.deepEqual(
    map.prs.map((pr) => pr.issue).sort((a, b) => a - b),
    [10, 11, 12, 14, 22],
    'the map must cover exactly the five implementation issues',
  );

  const irreversible = map.prs.filter((pr) => !pr.reversible);
  assert.equal(irreversible.length >= 1, true, 'at least one gated irreversible PR');

  // AC-3 is plural-tolerant: every irreversible PR must follow every
  // reversible one, rather than there being exactly one in last position.
  const lastReversibleIndex = map.prs.reduce(
    (acc, pr, index) => (pr.reversible ? index : acc),
    -1,
  );
  const firstIrreversibleIndex = map.prs.findIndex((pr) => !pr.reversible);
  assert.equal(
    firstIrreversibleIndex > lastReversibleIndex,
    true,
    'every irreversible PR must come after every reversible one',
  );

  for (const pr of irreversible) {
    assert.match(pr.rollbackGate, /NOT REVERSIBLE/u);
    // Ordering in the array is not a gate on its own; an irreversible PR must
    // actually depend on prior work.
    assert.equal(pr.dependsOn.length > 0, true, `${pr.prId} must be gated by dependsOn`);
    for (const dependency of pr.dependsOn) {
      assert.equal(
        map.prs.some((candidate) => candidate.prId === dependency),
        true,
        `${pr.prId} dependsOn ${dependency} must exist in the map`,
      );
    }
  }
});

test('OBS-BGSTAB-009 AC-2 records a probe trail that carries no information beyond the boundary', async () => {
  // Deliberately a characterization, not a gate.
  //
  // Round 7 tried to use `probeObservations` to prove that a search actually
  // happened. It cannot: the trail is fully determined by the boundary. The
  // ascending probe stops at the first count that loses, and loss there is
  // always exactly 1, so the trail is always `[0, 0, ..., 0, 1]` of length
  // `boundary`. An implementation that computes the boundary analytically from
  // one measurement can emit a byte-identical trail, and it is not cheating --
  // it measured, it just used a better algorithm.
  //
  // This test pins that fact so nobody builds another false gate on the trail.
  // The property that matters -- the boundary reflects measurement rather than
  // a constant derived from `rows` -- is enforced by the wrapped-geometry test
  // above and by the unpinned-geometry confirmation test, neither of which uses
  // an injection hook.
  const probed = await measureRefreshTruncationFiringBoundary({
    cols: 8,
    rows: 10,
    scrollbackLines: 1000,
    maxProbeLogicalLines: 40,
  });
  const boundary = probed.measuredFiringBoundaryLogicalLines!;
  const canonical = Array.from({ length: boundary }, (_unused, index) => ({
    logicalLines: index + 1,
    observedLossLogicalLines: index + 1 === boundary ? 1 : 0,
  }));
  assert.deepEqual(
    probed.probeObservations,
    canonical,
    'if this ever differs, the trail has become informative and could gate provenance',
  );
});

test('OBS-BGSTAB-009 AC-2 confirms the reported boundary by independent measurement at an unpinned geometry', async () => {
  // Round-8 review built a producer that memorised the four (cols, rows) pairs
  // the artifact pins and returned `rows + 1` everywhere else, passing 12/12
  // because every boundary assertion compared against a constant the test
  // itself supplied. This test supplies no expected value: it asks the producer
  // for a boundary, then confirms that answer against
  // `measureRefreshRetainedStateBoundary` directly -- the reported count must
  // lose, the count below it must not.
  //
  // Round-9 review then defeated an earlier version of this test twice:
  //   * the candidate list was a 6-entry literal, so a 10-entry table (those
  //     six plus the artifact's four) passed 13/13 -- fixed here by DERIVING
  //     the geometry from a per-run draw instead of listing it;
  //   * one candidate, 12x6, does not wrap (the fixture line is 11 chars), so
  //     its true boundary IS rows + 1 and the gate silently passed the very
  //     adversary it was built for, 1 run in 6 -- fixed here by constraining
  //     the draw to wrapping widths only.
  //
  // LIMIT, stated plainly: no test of this shape can distinguish a producer
  // that measures from one that has memorised correct answers for every
  // geometry. Widening the draw raises the cost of such a table; it does not
  // close the gap, and it is not meant to. A producer that is correct at every
  // geometry is correct. See the requirement's Implementation Notes.
  const FIXTURE_LINE_WIDTH = 11;
  const cols = 2 + Math.floor(Math.random() * 9); // 2..10, always wraps
  const rows = 3 + Math.floor(Math.random() * 18); // 3..20
  const scrollbackLines = 1000;
  assert.equal(cols < FIXTURE_LINE_WIDTH, true, 'the drawn width must wrap the fixture line');

  const probed = await measureRefreshTruncationFiringBoundary({
    cols,
    rows,
    scrollbackLines,
    maxProbeLogicalLines: 60,
  });
  const boundary = probed.measuredFiringBoundaryLogicalLines;
  assert.notEqual(boundary, null, `no boundary found at ${cols}x${rows}`);
  assert.equal(boundary! > 1, true, `${cols}x${rows}: boundary ${boundary} leaves nothing below it`);

  const atBoundary = await measureRefreshRetainedStateBoundary({
    cols, rows, scrollbackLines, logicalLines: boundary!,
  });
  const belowBoundary = await measureRefreshRetainedStateBoundary({
    cols, rows, scrollbackLines, logicalLines: boundary! - 1,
  });

  assert.equal(
    atBoundary.observedLossLogicalLines > 0,
    true,
    `${cols}x${rows}: reported boundary ${boundary} must actually lose`,
  );
  assert.equal(
    belowBoundary.observedLossLogicalLines,
    0,
    `${cols}x${rows}: ${boundary! - 1} must not lose, or ${boundary} is not the first`,
  );
});

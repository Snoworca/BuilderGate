import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REFRESH_TRUNCATION_EVIDENCE_SCHEMA_VERSION,
  classifyRefreshRetainedLineLoss,
  measureRefreshRetainedStateBoundary,
  produceRefreshTruncationBoundaryEvidence,
} from './refreshRetainedStateTruncationBoundary.js';

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
  assert.equal(pastViewport.firingBoundaryLogicalLines, FIXTURE.rows + 1);
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

  assert.equal(evidence.seeds.length >= 4, true);
  for (const seed of evidence.seeds) {
    assert.equal(typeof seed.preRefreshLogicalLineHash, 'string');
    assert.equal(seed.preRefreshLogicalLineHash.length, 64);
    assert.equal(seed.seedKind, 'characterization-corpus');
    assert.equal(
      JSON.stringify(seed).includes('line-'),
      false,
      'boundary evidence must not embed raw terminal text',
    );
  }

  assert.equal(evidence.contentDigest.algorithm, 'sha256');
  assert.equal(evidence.contentDigest.value.length, 64);
});

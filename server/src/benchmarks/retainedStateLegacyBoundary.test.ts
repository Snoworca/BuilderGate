import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
  runLegacyServerSnapshotBoundaryCharacterization,
} from './retainedStateLegacyBoundary.js';

test('OBS-BGSTAB-004 AC-2 server serializeHeadlessTerminal exact byte boundary RED contract', () => {
  const evidence = runLegacyServerSnapshotBoundaryCharacterization();
  assert.equal(evidence.source.function, 'serializeHeadlessTerminal');
  assert.equal(evidence.source.file, 'server/src/utils/headlessTerminal.ts');
  assert.equal(evidence.maxSnapshotBytes, LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES);
  assert.deepEqual(
    evidence.cases.map((candidate) => ({
      position: candidate.position,
      requestedPayloadBytes: candidate.requestedPayloadBytes,
      measuredPayloadBytes: candidate.measuredPayloadBytes,
      truncated: candidate.truncated,
      returnedDataBytes: candidate.returnedDataBytes,
    })),
    [
      {
        position: 'before',
        requestedPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES - 1,
        measuredPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES - 1,
        truncated: false,
        returnedDataBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES - 1,
      },
      {
        position: 'at',
        requestedPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
        measuredPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
        truncated: false,
        returnedDataBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
      },
      {
        position: 'after',
        requestedPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES + 1,
        measuredPayloadBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES + 1,
        truncated: true,
        returnedDataBytes: 0,
      },
    ],
  );
  for (const candidate of evidence.cases) {
    assert.match(candidate.payloadSha256, /^[0-9a-f]{64}$/u);
    assert.equal(candidate.rawPayloadOmitted, true);
  }
});

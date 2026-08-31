import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HeadlessTerminalState } from '../utils/headlessTerminal.js';
import { serializeHeadlessTerminal } from '../utils/headlessTerminal.js';

export const LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES = 2 * 1024 * 1024;

export interface LegacyServerSnapshotBoundaryCase {
  position: 'before' | 'at' | 'after';
  requestedPayloadBytes: number;
  measuredPayloadBytes: number;
  payloadSha256: string;
  truncated: boolean;
  returnedDataBytes: number;
  rawPayloadOmitted: true;
}

export interface LegacyServerSnapshotBoundaryEvidence {
  schemaVersion: '1.0.0';
  requirementId: 'OBS-BGSTAB-004';
  evidenceKind: 'controlled_product_serializer_boundary';
  maxSnapshotBytes: number;
  source: {
    file: 'server/src/utils/headlessTerminal.ts';
    function: 'serializeHeadlessTerminal';
    comparison: 'Buffer.byteLength(serialized, utf8) > maxSnapshotBytes';
  };
  cases: LegacyServerSnapshotBoundaryCase[];
  contentDigest: { algorithm: 'sha256'; value: string };
}

const TEXT_SAMPLES = {
  before: 'A',
  at: '한',
  after: '😀',
} as const;

// @req OBS-BGSTAB-004
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// @req OBS-BGSTAB-004
function buildExactUtf8Payload(targetBytes: number, sample: string): string {
  const encoder = new TextEncoder();
  const sampleBytes = encoder.encode(sample).length;
  const payload = sample.repeat(Math.floor(targetBytes / sampleBytes))
    + 'A'.repeat(targetBytes % sampleBytes);
  const measured = Buffer.byteLength(payload, 'utf8');
  if (measured !== targetBytes) {
    throw new Error(`exact UTF-8 payload generation failed: ${measured} !== ${targetBytes}`);
  }
  return payload;
}

// @req OBS-BGSTAB-004
function createControlledSerializerState(payload: string): HeadlessTerminalState {
  return {
    terminal: { cols: 80, rows: 24 },
    serializeAddon: { serialize: () => payload },
    cursorHidden: false,
    cursorVisibilityTail: '',
  } as unknown as HeadlessTerminalState;
}

// @req OBS-BGSTAB-004
export function runLegacyServerSnapshotBoundaryCharacterization(): LegacyServerSnapshotBoundaryEvidence {
  const definitions = [
    { position: 'before' as const, bytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES - 1 },
    { position: 'at' as const, bytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES },
    { position: 'after' as const, bytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES + 1 },
  ];
  const cases = definitions.map((definition): LegacyServerSnapshotBoundaryCase => {
    const payload = buildExactUtf8Payload(definition.bytes, TEXT_SAMPLES[definition.position]);
    const snapshot = serializeHeadlessTerminal(
      createControlledSerializerState(payload),
      LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
    );
    return {
      position: definition.position,
      requestedPayloadBytes: definition.bytes,
      measuredPayloadBytes: Buffer.byteLength(payload, 'utf8'),
      payloadSha256: sha256(payload),
      truncated: snapshot.truncated,
      returnedDataBytes: Buffer.byteLength(snapshot.data, 'utf8'),
      rawPayloadOmitted: true,
    };
  });
  const payload = {
    schemaVersion: '1.0.0' as const,
    requirementId: 'OBS-BGSTAB-004' as const,
    evidenceKind: 'controlled_product_serializer_boundary' as const,
    maxSnapshotBytes: LEGACY_SERVER_SNAPSHOT_BOUNDARY_BYTES,
    source: {
      file: 'server/src/utils/headlessTerminal.ts' as const,
      function: 'serializeHeadlessTerminal' as const,
      comparison: 'Buffer.byteLength(serialized, utf8) > maxSnapshotBytes' as const,
    },
    cases,
  };
  return {
    ...payload,
    contentDigest: {
      algorithm: 'sha256',
      value: sha256(JSON.stringify(payload)),
    },
  };
}

// @req OBS-BGSTAB-004
export async function writeLegacyServerSnapshotBoundaryArtifact(
  outputPath = resolve(
    import.meta.dirname,
    '../../../docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/legacy-server-snapshot-boundary.json',
  ),
): Promise<LegacyServerSnapshotBoundaryEvidence> {
  const evidence = runLegacyServerSnapshotBoundaryCharacterization();
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const evidence = await writeLegacyServerSnapshotBoundaryArtifact();
  process.stdout.write(`${evidence.contentDigest.value}\n`);
}

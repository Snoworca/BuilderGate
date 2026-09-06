import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = resolve(serverRoot, '..');
const authorityRoot = resolve(repositoryRoot, 'docs/analysis/terminal-fairness-authority');
const compiledCanaryUrl = pathToFileURL(
  resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
).href;

// The six sources write-fair-scheduler-source-provenance.mjs pins, restated here so that this
// test and the writer reach the artifact's sourceDigest through independent implementations.
const PINNED_SOURCES = [
  'src/benchmarks/terminalFairnessCharacterization.ts',
  'src/benchmarks/fairSchedulerAuthorityLocator.ts',
  'src/ws/wsSendPolicy.ts',
  'src/ws/WsRouter.ts',
  'src/services/TerminalResourcePolicy.ts',
  'src/services/TerminalResourcePolicyCanary.ts',
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | readonly string[]): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}

function computePinnedSourceDigest(root: string): string {
  return sha256(PINNED_SOURCES.map(path => readFileSync(resolve(root, path), 'utf8')));
}

async function readPublishedArtifact(): Promise<Record<string, unknown>> {
  const pointer = JSON.parse(await readFile(join(authorityRoot, 'current.json'), 'utf8')) as {
    generation_id: string;
    decision_artifact: string;
  };
  return JSON.parse(await readFile(
    join(authorityRoot, 'generations', pointer.generation_id, pointer.decision_artifact),
    'utf8',
  )) as Record<string, unknown>;
}

// @req OPS-BGSTAB-010 AC-1
test('OPS-BGSTAB-010 the published generation pins the sources on disk', async () => {
  const artifact = await readPublishedArtifact();
  assert.equal(
    computePinnedSourceDigest(serverRoot),
    artifact.sourceDigest,
    'current.json must point at a generation whose sourceDigest matches the shipped sources',
  );
});

// @req OPS-BGSTAB-010 AC-2
test('OPS-BGSTAB-010 the compiled canary accepts the bundled artifact policy', async () => {
  assert.equal(
    existsSync(fileURLToPath(compiledCanaryUrl)),
    true,
    'server build must emit the compiled canary before this assertion means anything',
  );
  const compiled = await import(`${compiledCanaryUrl}?authority-pin=${Date.now()}`) as {
    validatePublishedFairDeliveryCandidateArtifact(input: { runtimePolicy: unknown }): {
      accepted: boolean;
      reason: string;
    };
  };
  const runtimeWsLimits = new RuntimeConfigStore(config).getEditableValues().resourceLimits.ws;
  const runtimePolicy = resolveFairTerminalDeliveryPolicy(runtimeWsLimits);
  assert.deepEqual(
    compiled.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy }),
    { accepted: true, reason: 'decision-artifact-verified' },
  );
});

// @req OPS-BGSTAB-010 AC-3
test('OPS-BGSTAB-010 altering one pinned byte breaks the digest equality', async () => {
  const artifact = await readPublishedArtifact();
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-pinned-source-boundary-'));
  try {
    for (const path of PINNED_SOURCES) {
      const destination = resolve(temporaryRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(serverRoot, path), destination);
    }
    // The copy alone must still reproduce the digest, otherwise the mutation below proves nothing.
    assert.equal(
      computePinnedSourceDigest(temporaryRoot),
      artifact.sourceDigest,
      'the unmutated copy must reproduce the published digest',
    );

    const mutated = resolve(temporaryRoot, 'src/ws/wsSendPolicy.ts');
    const original = await readFile(mutated, 'utf8');
    await mkdir(dirname(mutated), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(mutated, `${original} `, 'utf8');
    assert.notEqual(
      await readFile(mutated, 'utf8'),
      original,
      'the boundary control must actually have changed the copied source',
    );

    assert.notEqual(
      computePinnedSourceDigest(temporaryRoot),
      artifact.sourceDigest,
      'a single altered byte must break the digest equality',
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

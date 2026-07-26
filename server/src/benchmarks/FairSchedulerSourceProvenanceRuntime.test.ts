import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = resolve(
  serverRoot,
  '../docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness',
);
const manifestPath = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-source-provenance.json');
const compiledCanaryUrl = pathToFileURL(
  resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
).href;

function readPublishedArtifact(): Record<string, unknown> {
  const publication = JSON.parse(readFileSync(
    resolve(artifactRoot, 'fair-scheduler-decision.json.publication.json'),
    'utf8',
  )) as { artifactPath: string };
  return JSON.parse(readFileSync(resolve(artifactRoot, publication.artifactPath), 'utf8')) as Record<string, unknown>;
}

test('PERF-BGSTAB-010 compiled runtime validates the published artifact through build provenance', async () => {
  assert.equal(
    existsSync(manifestPath),
    true,
    'server build must emit the compiled fair-scheduler source provenance manifest',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const artifact = readPublishedArtifact();
  assert.equal(manifest.schemaVersion, 'fair-scheduler-source-provenance/v1');
  assert.equal(manifest.sourceDigest, artifact.sourceDigest);

  const compiled = await import(`${compiledCanaryUrl}?provenance-red=${Date.now()}`) as {
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
  const driftedRuntimePolicy = resolveFairTerminalDeliveryPolicy({
    ...runtimeWsLimits,
    perClientOutputQueueMaxBytes: runtimeWsLimits.perClientOutputQueueMaxBytes + 1,
  });
  assert.deepEqual(
    compiled.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy: driftedRuntimePolicy }),
    { accepted: false, reason: 'decision-artifact-runtime-policy-hash-mismatch' },
  );
});

test('PERF-BGSTAB-010 source provenance parser fails closed for malformed manifests', async () => {
  const source = await import('./terminalFairnessCharacterization.js') as {
    validateFairSchedulerSourceProvenanceManifest?: (value: unknown) => unknown;
  };
  assert.equal(typeof source.validateFairSchedulerSourceProvenanceManifest, 'function');
  assert.deepEqual(source.validateFairSchedulerSourceProvenanceManifest?.(null), {
    accepted: false,
    reason: 'source-provenance-invalid',
  });
  assert.deepEqual(source.validateFairSchedulerSourceProvenanceManifest?.({
    schemaVersion: 'fair-scheduler-source-provenance/v1',
    inputs: [],
    sourceDigest: 'not-a-sha256-digest',
  }), {
    accepted: false,
    reason: 'source-provenance-invalid',
  });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-source-provenance.json');
const compiledCanaryUrl = pathToFileURL(
  resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
).href;

async function createGeneratedAuthorityArtifact(): Promise<{
  artifact: Record<string, unknown>;
  cleanup(): Promise<void>;
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-generated-canonical-authority-'));
  const authorityRoot = join(temporaryRoot, 'docs', 'analysis', 'terminal-fairness-authority');
  try {
    const fairness = await import('./terminalFairnessCharacterization.js') as {
      publishFairSchedulerAuthorityGeneration(input: {
        authorityRoot: string;
        clients: readonly number[];
        wanLatencyMs: number;
        wanJitterMs: number;
        wanLossPercent: number;
        seed: number;
        repeats: number;
        samples: number;
      }): Promise<{ generationId: string }>;
    };
    const publication = await fairness.publishFairSchedulerAuthorityGeneration({
      authorityRoot,
      clients: [1, 2, 8],
      wanLatencyMs: 150,
      wanJitterMs: 20,
      wanLossPercent: 0,
      seed: 20260723,
      repeats: 5,
      samples: 30,
    });
    const pointer = JSON.parse(await readFile(join(authorityRoot, 'current.json'), 'utf8')) as {
      generation_id: string;
      decision_artifact: string;
    };
    assert.equal(pointer.generation_id, publication.generationId);
    return {
      artifact: JSON.parse(await readFile(
        join(authorityRoot, 'generations', pointer.generation_id, pointer.decision_artifact),
        'utf8',
      )) as Record<string, unknown>,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

test('PERF-BGSTAB-010 compiled runtime validates the published artifact through build provenance', async () => {
  assert.equal(
    existsSync(manifestPath),
    true,
    'server build must emit the compiled fair-scheduler source provenance manifest',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const generated = await createGeneratedAuthorityArtifact();
  try {
    assert.equal(manifest.schemaVersion, 'fair-scheduler-source-provenance/v1');
    assert.equal(manifest.sourceDigest, generated.artifact.sourceDigest);

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
  } finally {
    await generated.cleanup();
  }
});

test('PERF-BGSTAB-010 runtime policy profile default admission uses current authority identity', async () => {
  const signature = 'PERF-BGSTAB-010 compiled default admission must bind the effective RuntimeConfigStore WebSocket profile';
  assert.equal(existsSync(manifestPath), true, signature);
  const compiled = await import(`${compiledCanaryUrl}?runtime-profile-default=${Date.now()}`) as {
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
    signature,
  );
  const driftedRuntimePolicy = resolveFairTerminalDeliveryPolicy({
    ...runtimeWsLimits,
    perClientOutputQueueMaxBytes: runtimeWsLimits.perClientOutputQueueMaxBytes + 1,
  });
  assert.deepEqual(
    compiled.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy: driftedRuntimePolicy }),
    { accepted: false, reason: 'decision-artifact-runtime-policy-hash-mismatch' },
    signature,
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

test('PERF-BGSTAB-010 source-dist canonical authority parity fails closed', async () => {
  type Resolution = {
    accepted: boolean;
    reason: string;
    evidenceRoot?: string;
    generationId?: string;
    locatorPath?: string;
    logicalLocator?: string;
    publicationGeneration?: string;
  };
  type Resolver = {
    getLocator(): { authorityRoot: string };
    validate(input: { expectedPolicyDigest: string }): Resolution;
  };
  type FairnessModule = {
    createFairSchedulerRuntimePolicyProfile(runtimeConfig: Pick<RuntimeConfigStore, 'getEditableValues'>): {
      policyHash: string;
    };
    publishFairSchedulerAuthorityGeneration(input: {
      authorityRoot: string;
      clients: readonly number[];
      wanLatencyMs: number;
      wanJitterMs: number;
      wanLossPercent: number;
      seed: number;
      repeats: number;
      samples: number;
    }): Promise<{ generationId: string }>;
    createFairSchedulerEvidenceAuthorityResolver(input?: { repositoryRoot?: string }): Resolver;
  };
  const source = await import('./terminalFairnessCharacterization.js') as unknown as FairnessModule;
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-authority-parity-'));
  const repositoryRoot = join(temporaryRoot, 'repository');
  const authorityRoot = join(repositoryRoot, 'docs', 'analysis', 'terminal-fairness-authority');
  const fixtureDist = join(repositoryRoot, 'server', 'dist');
  const compiledAuthorityRoot = join(fixtureDist, 'benchmarks', 'fair-scheduler-evidence');
  const expectedPolicyDigest = source.createFairSchedulerRuntimePolicyProfile(
    new RuntimeConfigStore(config),
  ).policyHash;
  const hashBytes = (value: string): string => createHash('sha256').update(value).digest('hex');
  const readPointer = async (root: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(
    join(root, 'current.json'),
    'utf8',
  )) as Record<string, unknown>;
  const writePointer = async (root: string, pointer: Record<string, unknown>): Promise<void> => {
    await writeFile(join(root, 'current.json'), `${JSON.stringify(pointer)}\n`, 'utf8');
  };
  try {
    const publication = await source.publishFairSchedulerAuthorityGeneration({
      authorityRoot,
      clients: [1, 2, 8],
      wanLatencyMs: 150,
      wanJitterMs: 20,
      wanLossPercent: 0,
      seed: 20260728,
      repeats: 5,
      samples: 30,
    });
    await cp(resolve(serverRoot, 'dist'), fixtureDist, { recursive: true });
    const fixtureWriterPath = join(repositoryRoot, 'server', 'tools', 'write-fair-scheduler-evidence-bundle.mjs');
    await mkdir(dirname(fixtureWriterPath), { recursive: true });
    await cp(resolve(serverRoot, 'tools/write-fair-scheduler-evidence-bundle.mjs'), fixtureWriterPath);
    const writer = await import(pathToFileURL(
      fixtureWriterPath,
    ).href) as {
      writeFairSchedulerEvidenceBundle(): Promise<unknown>;
    };
    await writer.writeFairSchedulerEvidenceBundle();
    const pointer = await readPointer(authorityRoot);
    assert.equal(pointer.generation_id, publication.generationId);

    const compiledCanaryUrl = pathToFileURL(join(fixtureDist, 'services/TerminalResourcePolicyCanary.js')).href;
    const compiled = await import(`${compiledCanaryUrl}?canonical-authority-parity=${Date.now()}`) as {
      createFairSchedulerEvidenceAuthorityResolver?: (input?: { repositoryRoot?: string }) => Resolver;
    };
    assert.equal(typeof compiled.createFairSchedulerEvidenceAuthorityResolver, 'function');
    const emittedDistTest = fileURLToPath(import.meta.url) === resolve(
      serverRoot,
      'dist/benchmarks/FairSchedulerSourceProvenanceRuntime.test.js',
    );
    const sourceResolver = emittedDistTest
      ? undefined
      : source.createFairSchedulerEvidenceAuthorityResolver({ repositoryRoot });
    const compiledResolver = compiled.createFairSchedulerEvidenceAuthorityResolver?.();
    assert.equal(compiledResolver?.getLocator().authorityRoot, compiledAuthorityRoot);
    if (emittedDistTest) {
      assert.throws(
        () => compiled.createFairSchedulerEvidenceAuthorityResolver?.({ repositoryRoot }),
        /authority resolver root option is unsupported/u,
      );
    }
    const compiledAccepted = compiledResolver!.validate({ expectedPolicyDigest });
    if (sourceResolver) {
      assert.deepEqual(sourceResolver.validate({ expectedPolicyDigest }), {
        accepted: true,
        evidenceRoot: join(authorityRoot, 'generations', publication.generationId),
        generationId: publication.generationId,
        locatorPath: join(authorityRoot, 'current.json'),
        logicalLocator: 'docs/analysis/terminal-fairness-authority/current.json',
        publicationGeneration: publication.generationId,
        reason: 'authority-locator-verified',
      });
    }
    assert.deepEqual(compiledAccepted, {
      accepted: true,
      evidenceRoot: join(compiledAuthorityRoot, 'generations', publication.generationId),
      generationId: publication.generationId,
      locatorPath: join(compiledAuthorityRoot, 'current.json'),
      logicalLocator: 'docs/analysis/terminal-fairness-authority/current.json',
      publicationGeneration: publication.generationId,
      reason: 'authority-locator-verified',
    });
    const sourceAuthorityBaseline = join(temporaryRoot, 'source-authority-baseline');
    const compiledAuthorityBaseline = join(temporaryRoot, 'compiled-authority-baseline');
    await cp(authorityRoot, sourceAuthorityBaseline, { recursive: true });
    await cp(compiledAuthorityRoot, compiledAuthorityBaseline, { recursive: true });

    const cases: Array<{
      name: string;
      expectedReason: string;
      mutate(root: string): Promise<void>;
    }> = [
      {
        name: 'missing-pointer',
        expectedReason: 'authority-pointer-missing',
        mutate: root => rm(join(root, 'current.json')),
      },
      {
        name: 'tampered-decision',
        expectedReason: 'authority-decision-sha256-mismatch',
        async mutate(root) {
          const current = await readPointer(root);
          await writeFile(join(
            root,
            'generations',
            current.generation_id as string,
            current.decision_artifact as string,
          ), '{"tampered":true}\n', 'utf8');
        },
      },
      {
        name: 'pointer-posix-escape',
        expectedReason: 'authority-pointer-reference-invalid',
        async mutate(root) {
          await writePointer(root, { ...await readPointer(root), decision_artifact: '../outside.json' });
        },
      },
      {
        name: 'publication-generation-mismatch',
        expectedReason: 'authority-publication-generation-mismatch',
        async mutate(root) {
          const current = await readPointer(root);
          const mismatch = current.generation_id === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
          const provenancePath = join(root, 'generations', current.generation_id as string, 'provenance.json');
          const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as Record<string, unknown>;
          const provenanceBytes = `${JSON.stringify({ ...provenance, publication_generation: mismatch })}\n`;
          await writeFile(provenancePath, provenanceBytes, 'utf8');
          await writePointer(root, {
            ...current,
            publication_generation: mismatch,
            provenance_sha256: hashBytes(provenanceBytes),
          });
        },
      },
    ];
    for (const entry of cases) {
      await rm(authorityRoot, { recursive: true, force: true });
      await rm(compiledAuthorityRoot, { recursive: true, force: true });
      await cp(sourceAuthorityBaseline, authorityRoot, { recursive: true });
      await cp(compiledAuthorityBaseline, compiledAuthorityRoot, { recursive: true });
      await entry.mutate(authorityRoot);
      await entry.mutate(compiledAuthorityRoot);
      const compiledResolution = compiledResolver!.validate({ expectedPolicyDigest });
      if (sourceResolver) {
        const sourceResolution = sourceResolver.validate({ expectedPolicyDigest });
        assert.deepEqual(sourceResolution, { accepted: false, reason: entry.expectedReason }, entry.name);
        assert.deepEqual(compiledResolution, sourceResolution, entry.name);
      } else {
        assert.deepEqual(compiledResolution, { accepted: false, reason: entry.expectedReason }, entry.name);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

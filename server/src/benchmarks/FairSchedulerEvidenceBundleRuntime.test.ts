import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveFairTerminalDeliveryPolicy } from '../services/TerminalResourcePolicy.js';
import { RuntimeConfigStore } from '../services/RuntimeConfigStore.js';
import { config } from '../utils/config.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Resolution = { accepted: boolean; reason: string };
type Resolver = {
  getLocator(): { authorityRoot: string; locatorPath: string };
  validate(input: { expectedPolicyDigest: string }): Resolution;
};

async function createPortableCanonicalAuthority() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-portable-authority-'));
  const repositoryRoot = join(fixtureRoot, 'repository');
  const authorityRoot = join(repositoryRoot, 'docs', 'analysis', 'terminal-fairness-authority');
  const fixtureDist = join(repositoryRoot, 'server', 'dist');
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
    await cp(resolve(serverRoot, 'dist'), fixtureDist, { recursive: true });
    const outputRoot = join(fixtureDist, 'benchmarks', 'fair-scheduler-evidence');
    await rm(outputRoot, { recursive: true, force: true });
    const fixtureWriterPath = join(repositoryRoot, 'server', 'tools', 'write-fair-scheduler-evidence-bundle.mjs');
    await mkdir(dirname(fixtureWriterPath), { recursive: true });
    await cp(resolve(serverRoot, 'tools/write-fair-scheduler-evidence-bundle.mjs'), fixtureWriterPath);
    const writer = await import(pathToFileURL(
      fixtureWriterPath,
    ).href) as {
      writeFairSchedulerEvidenceBundle(): Promise<unknown>;
    };
    await writer.writeFairSchedulerEvidenceBundle();
    const pointer = JSON.parse(await readFile(join(outputRoot, 'current.json'), 'utf8')) as {
      generation_id: string;
      decision_artifact: string;
    };
    assert.equal(pointer.generation_id, publication.generationId);
    const decision = JSON.parse(await readFile(
      join(outputRoot, 'generations', pointer.generation_id, pointer.decision_artifact),
      'utf8',
    )) as { policy: unknown; policyHash: string };
    return {
      fixtureRoot,
      repositoryRoot,
      authorityRoot,
      fixtureDist,
      outputRoot,
      decision,
      generationId: pointer.generation_id,
      expectedPolicyDigest: decision.policyHash,
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

test('PERF-BGSTAB-010 compiled runtime resolves only its staged evidence bundle and rejects escaped references', async () => {
  const fixture = await createPortableCanonicalAuthority();
  const compiledCanaryUrl = pathToFileURL(join(fixture.fixtureDist, 'services/TerminalResourcePolicyCanary.js')).href;
  const compiled = await import(`${compiledCanaryUrl}?canonical-runtime=${Date.now()}`) as {
    resolveFairSchedulerEvidenceRoot?: () => string;
    validateFairSchedulerEvidenceReference?: (root: string, declaredPath: string) => Resolution;
    createFairSchedulerEvidenceAuthorityResolver?: () => Resolver;
    validatePublishedFairDeliveryCandidateArtifact?: (input: { runtimePolicy: unknown }) => Resolution;
  };
  try {
    assert.equal(typeof compiled.resolveFairSchedulerEvidenceRoot, 'function');
    assert.equal(typeof compiled.validateFairSchedulerEvidenceReference, 'function');
    assert.equal(typeof compiled.createFairSchedulerEvidenceAuthorityResolver, 'function');
    assert.equal(compiled.resolveFairSchedulerEvidenceRoot?.(), fixture.outputRoot);
    for (const escapedReference of ['../outside.json', './local.json', '/absolute.json', 'C:\\absolute.json', 'dir\\file.json']) {
      assert.deepEqual(
        compiled.validateFairSchedulerEvidenceReference?.(fixture.outputRoot, escapedReference),
        { accepted: false, reason: 'evidence-reference-invalid' },
      );
    }

    const resolver = compiled.createFairSchedulerEvidenceAuthorityResolver?.();
    assert.deepEqual(resolver?.validate({ expectedPolicyDigest: fixture.expectedPolicyDigest }), {
      accepted: true,
      evidenceRoot: join(fixture.outputRoot, 'generations', fixture.generationId),
      generationId: fixture.generationId,
      locatorPath: join(fixture.outputRoot, 'current.json'),
      logicalLocator: 'docs/analysis/terminal-fairness-authority/current.json',
      publicationGeneration: fixture.generationId,
      reason: 'authority-locator-verified',
    });
    const pointerPath = join(fixture.outputRoot, 'current.json');
    const originalPointer = await readFile(pointerPath, 'utf8');
    await rename(pointerPath, `${pointerPath}.missing`);
    try {
      assert.deepEqual(
        compiled.validatePublishedFairDeliveryCandidateArtifact?.({ runtimePolicy: fixture.decision.policy }),
        { accepted: false, reason: 'authority-pointer-missing' },
      );
    } finally {
      await rename(`${pointerPath}.missing`, pointerPath);
    }

    const pointer = JSON.parse(originalPointer) as Record<string, unknown>;
    await writeFile(pointerPath, `${JSON.stringify({ ...pointer, decision_artifact: '../outside.json' })}\n`, 'utf8');
    try {
      assert.deepEqual(
        resolver?.validate({ expectedPolicyDigest: fixture.expectedPolicyDigest }),
        { accepted: false, reason: 'authority-pointer-reference-invalid' },
      );
    } finally {
      await writeFile(pointerPath, originalPointer, 'utf8');
    }
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 portable compiled Canary accepts fresh canonical authority', async () => {
  const fixture = await createPortableCanonicalAuthority();
  const compiledCanaryUrl = pathToFileURL(join(fixture.fixtureDist, 'services/TerminalResourcePolicyCanary.js')).href;
  const compiled = await import(`${compiledCanaryUrl}?fresh-canonical-authority=${Date.now()}`) as {
    createFairSchedulerEvidenceAuthorityResolver?: (input?: { repositoryRoot?: string }) => Resolver;
    validatePublishedFairDeliveryCandidateArtifact?: (input: { runtimePolicy: unknown }) => Resolution;
  };
  try {
    await rm(fixture.authorityRoot, { recursive: true, force: true });
    assert.equal(typeof compiled.createFairSchedulerEvidenceAuthorityResolver, 'function');
    const resolver = compiled.createFairSchedulerEvidenceAuthorityResolver?.();
    assert.equal(resolver?.getLocator().authorityRoot, fixture.outputRoot);
    assert.deepEqual(resolver?.validate({ expectedPolicyDigest: fixture.expectedPolicyDigest }), {
      accepted: true,
      evidenceRoot: join(fixture.outputRoot, 'generations', fixture.generationId),
      generationId: fixture.generationId,
      locatorPath: join(fixture.outputRoot, 'current.json'),
      logicalLocator: 'docs/analysis/terminal-fairness-authority/current.json',
      publicationGeneration: fixture.generationId,
      reason: 'authority-locator-verified',
    });
    assert.deepEqual(
      compiled.validatePublishedFairDeliveryCandidateArtifact?.({ runtimePolicy: fixture.decision.policy }),
      { accepted: true, reason: 'decision-artifact-verified' },
    );
    assert.throws(
      () => compiled.createFairSchedulerEvidenceAuthorityResolver?.({ repositoryRoot: fixture.repositoryRoot }),
      /authority resolver root option is unsupported/u,
    );

    const pointerPath = join(fixture.outputRoot, 'current.json');
    const originalPointer = await readFile(pointerPath, 'utf8');
    const pointer = JSON.parse(originalPointer) as Record<string, unknown>;
    await writeFile(pointerPath, `${JSON.stringify({ ...pointer, raw_root: '../outside/' })}\n`, 'utf8');
    try {
      assert.deepEqual(
        resolver?.validate({ expectedPolicyDigest: fixture.expectedPolicyDigest }),
        { accepted: false, reason: 'authority-pointer-reference-invalid' },
      );
    } finally {
      await writeFile(pointerPath, originalPointer, 'utf8');
    }
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('PERF-BGSTAB-010 one-field authority identity drift rejects default admission', async () => {
  const signature = 'PERF-BGSTAB-010 compiled default authority must reject a one-field current identity drift';
  const compiledCanaryUrl = pathToFileURL(
    resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
  ).href;
  const compiled = await import(`${compiledCanaryUrl}?authority-identity-drift=${Date.now()}`) as {
    validatePublishedFairDeliveryCandidateArtifact(input: { runtimePolicy: unknown }): Resolution;
  };
  const runtimePolicy = resolveFairTerminalDeliveryPolicy(
    new RuntimeConfigStore(config).getEditableValues().resourceLimits.ws,
  );
  assert.deepEqual(
    compiled.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy }),
    { accepted: true, reason: 'decision-artifact-verified' },
    signature,
  );

  const pointerPath = resolve(serverRoot, 'dist/benchmarks/fair-scheduler-evidence/current.json');
  const pointerBytes = await readFile(pointerPath, 'utf8');
  const pointer = JSON.parse(pointerBytes) as { publication_generation: string } & Record<string, unknown>;
  const driftedPublicationGeneration = pointer.publication_generation === '0'.repeat(64)
    ? '1'.repeat(64)
    : '0'.repeat(64);
  try {
    await writeFile(pointerPath, `${JSON.stringify({
      ...pointer,
      publication_generation: driftedPublicationGeneration,
    })}\n`, 'utf8');
    assert.equal(
      compiled.validatePublishedFairDeliveryCandidateArtifact({ runtimePolicy }).accepted,
      false,
      signature,
    );
  } finally {
    await writeFile(pointerPath, pointerBytes, 'utf8');
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

test('PERF-BGSTAB-010 compiled runtime resolves only its staged evidence bundle and rejects escaped references', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'buildergate-fair-compiled-evidence-'));
  const fixtureDist = join(fixtureRoot, 'server', 'dist');
  await cp(resolve(serverRoot, 'dist'), fixtureDist, { recursive: true });
  const compiledCanaryUrl = pathToFileURL(join(fixtureDist, 'services/TerminalResourcePolicyCanary.js')).href;
  const compiled = await import(`${compiledCanaryUrl}?evidence-bundle-red=${Date.now()}`) as {
    resolveFairSchedulerEvidenceRoot?: () => string;
    validateFairSchedulerEvidenceReference?: (root: string, declaredPath: string) => {
      accepted: boolean;
      reason?: string;
    };
    validatePublishedFairDeliveryCandidateArtifact?: (input?: { runtimePolicy?: unknown }) => { accepted: boolean; reason: string };
  };
  try {
    assert.equal(typeof compiled.resolveFairSchedulerEvidenceRoot, 'function');
    assert.equal(typeof compiled.validateFairSchedulerEvidenceReference, 'function');
    const evidenceRoot = compiled.resolveFairSchedulerEvidenceRoot?.();
    assert.match(evidenceRoot ?? '', /dist[\\/]benchmarks[\\/]fair-scheduler-evidence$/u);
    for (const escapedReference of ['../outside.json', './local.json', '/absolute.json', 'C:\\absolute.json', 'dir\\file.json']) {
      assert.deepEqual(
        compiled.validateFairSchedulerEvidenceReference?.(evidenceRoot!, escapedReference),
        { accepted: false, reason: 'evidence-reference-invalid' },
      );
    }
    const parkedEvidenceRoot = `${evidenceRoot}.missing-${process.pid}`;
    await rename(evidenceRoot!, parkedEvidenceRoot);
    try {
      assert.deepEqual(compiled.validatePublishedFairDeliveryCandidateArtifact?.(), {
        accepted: false,
        reason: 'decision-artifact-publication-missing',
      });
    } finally {
      await rename(parkedEvidenceRoot, evidenceRoot!);
    }
    const pointerPath = join(evidenceRoot!, 'fair-scheduler-decision.json.publication.json');
    const originalPointer = await readFile(pointerPath, 'utf8');
    const publication = JSON.parse(originalPointer) as Record<string, unknown> & { artifactPath: string };
    const artifactPath = join(evidenceRoot!, ...publication.artifactPath.split('/'));
    const originalArtifact = await readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(originalArtifact) as Record<string, unknown>;
    const { digest: ignoredDigest, stagingValidated: ignoredMarker, ...unmarkedArtifact } = artifact;
    const artifactDigest = digest(unmarkedArtifact);
    try {
      await writeFile(artifactPath, `${canonicalJson({ ...unmarkedArtifact, digest: artifactDigest })}\n`, 'utf8');
      await writeFile(pointerPath, `${canonicalJson({ ...publication, digest: artifactDigest })}\n`, 'utf8');
      assert.deepEqual(compiled.validatePublishedFairDeliveryCandidateArtifact?.({
        runtimePolicy: artifact.policy,
      }), { accepted: false, reason: 'decision-artifact-staging-validation-missing' });
    } finally {
      await writeFile(artifactPath, originalArtifact, 'utf8');
      await writeFile(pointerPath, originalPointer, 'utf8');
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactPath = join(
  repositoryRoot,
  'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json',
);
const benchmarkPath = join(repositoryRoot, 'server/src/benchmarks/terminalFairnessCharacterization.ts');
const tsxPath = join(repositoryRoot, 'server/node_modules/tsx/dist/cli.mjs');
const profileArgs = [
  '--clients', '1,2,8',
  '--wan-latency-ms', '150',
  '--wan-jitter-ms', '20',
  '--wan-loss-percent', '0',
  '--seed', '20260723',
  '--repeats', '5',
  '--samples', '30',
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateArtifact(
  path,
  expectedPath,
  evidenceRoot = dirname(path),
  rawPath = `${path}.raw.json`,
  expectedRawPath = `${expectedPath}.raw.json`,
) {
  const artifact = readJson(path);
  assert.equal(artifact.schemaVersion, 'fair-scheduler-decision/v1', 'PERF-BGSTAB-010 fair scheduler artifact schema mismatch');
  assert.deepEqual(artifact.workload, {
    clients: [1, 2, 8],
    wan: { latencyMs: 150, jitterMs: 20, lossPercent: 0 },
    seed: 20260723,
    repeats: 5,
    samples: 30,
  }, 'PERF-BGSTAB-010 fixed WAN workload contract mismatch');
  assert.equal(artifact.prng?.algorithm, 'xorshift32', 'PERF-BGSTAB-010 PRNG algorithm missing');
  assert.equal(artifact.prng?.version, 1, 'PERF-BGSTAB-010 PRNG version missing');
  assert.equal(artifact.prng?.rootSeed, 20260723, 'PERF-BGSTAB-010 root seed mismatch');
  assert.equal(artifact.rawEvidencePaths?.length, 15, 'PERF-BGSTAB-010 trial raw evidence paths missing');
  for (const evidencePath of artifact.rawEvidencePaths ?? []) {
    assert.equal(existsSync(join(evidenceRoot, evidencePath)), true, 'PERF-BGSTAB-010 declared trial raw evidence missing');
  }
  assert.equal(artifact.rawSampleCount, 1650, 'PERF-BGSTAB-010 raw sample count mismatch');
  assert.equal(artifact.allRegisteredThresholdsPassed, true, 'PERF-BGSTAB-010 registered threshold failure');
  assert.equal(artifact.hasUnboundedEligibleLaneStarvation, false, 'PERF-BGSTAB-010 eligible lane starvation');
  assert.equal(artifact.validatorVerdict, 'accept', 'PERF-BGSTAB-010 validator did not accept artifact');
  assert.equal(artifact.accepted, true, 'PERF-BGSTAB-010 candidate must fail closed');
  const { digest: suppliedDigest, ...unsigned } = artifact;
  assert.equal(suppliedDigest, digest(unsigned), 'PERF-BGSTAB-010 artifact digest mismatch');
  assert.equal(existsSync(rawPath), true, 'PERF-BGSTAB-010 raw artifact missing');
  const raw = readJson(rawPath);
  assert.equal(raw.samples?.length, 1650, 'PERF-BGSTAB-010 raw samples missing');
  assert.equal(artifact.rawEvidenceDigest, digest(raw), 'PERF-BGSTAB-010 raw evidence digest mismatch');
  assert.equal(raw.trialSchedules?.length, artifact.rawEvidencePaths.length,
    'PERF-BGSTAB-010 trial schedule count mismatch');
  for (const [index, evidencePath] of (artifact.rawEvidencePaths ?? []).entries()) {
    const schedule = raw.trialSchedules[index];
    const trialArtifact = readJson(join(evidenceRoot, evidencePath));
    assert.deepEqual(trialArtifact, {
      schemaVersion: 'fair-scheduler-trial/v1',
      clientCount: schedule.clientCount,
      trial: schedule.trial,
      schedule,
      samples: raw.samples.filter(sample => (
        sample.clientCount === schedule.clientCount && sample.trial === schedule.trial
      )),
    }, 'PERF-BGSTAB-010 trial sidecar mismatch');
  }
  if (expectedPath) {
    assert.deepEqual(artifact, readJson(expectedPath),
      'PERF-BGSTAB-010 artifact must match a fresh execution of the fixed benchmark contract');
    assert.deepEqual(raw, readJson(expectedRawPath),
      'PERF-BGSTAB-010 raw evidence must match a fresh execution of the fixed benchmark contract');
  }
}

function resolvePublishedArtifact(outputPath) {
  const publicationPath = `${outputPath}.publication.json`;
  assert.equal(existsSync(publicationPath), true, 'PERF-BGSTAB-010 atomic publication manifest missing');
  const publication = readJson(publicationPath);
  assert.equal(publication.schemaVersion, 'fair-scheduler-publication/v1', 'PERF-BGSTAB-010 publication manifest schema mismatch');
  assert.equal(typeof publication.digest, 'string', 'PERF-BGSTAB-010 publication digest missing');
  assert.equal(typeof publication.generationId, 'string', 'PERF-BGSTAB-010 publication generation missing');
  assert.equal(typeof publication.artifactPath, 'string', 'PERF-BGSTAB-010 publication artifact path missing');
  assert.equal(typeof publication.rawPath, 'string', 'PERF-BGSTAB-010 publication raw path missing');
  const root = dirname(outputPath);
  const path = resolve(root, publication.artifactPath);
  const rawPath = resolve(root, publication.rawPath);
  assert.equal(path.startsWith(`${root}\\`), true, 'PERF-BGSTAB-010 publication escaped artifact root');
  assert.equal(rawPath.startsWith(`${root}\\`), true, 'PERF-BGSTAB-010 publication escaped raw root');
  assert.equal(existsSync(path), true, 'PERF-BGSTAB-010 published generation artifact missing');
  assert.equal(existsSync(rawPath), true, 'PERF-BGSTAB-010 published generation raw missing');
  return { path, rawPath, evidenceRoot: root };
}

function writeFixedBenchmarkArtifact(output) {
  const command = spawnSync(process.execPath, [tsxPath, benchmarkPath, ...profileArgs, '--output', output], {
    cwd: join(repositoryRoot, 'server'),
    encoding: 'utf8',
  });
  assert.equal(command.status, 0, `PERF-BGSTAB-010 fixture generation failed: ${command.stderr || command.stdout}`);
}

function withFreshContractExpectation(validate) {
  const directory = mkdtempSync(join(tmpdir(), 'buildergate-fair-scheduler-'));
  const expectedPath = join(directory, 'expected-fair-scheduler-decision.json');
  try {
    writeFixedBenchmarkArtifact(expectedPath);
    validate(expectedPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--fixture-only')) {
  withFreshContractExpectation(expectedPath => {
    const fixturePath = `${expectedPath}.fixture.json`;
    writeFixedBenchmarkArtifact(fixturePath);
    const fixture = resolvePublishedArtifact(fixturePath);
    const expected = resolvePublishedArtifact(expectedPath);
    validateArtifact(fixture.path, expected.path, fixture.evidenceRoot, fixture.rawPath, expected.rawPath);
  });
  process.stdout.write('PERF-BGSTAB-010 fair scheduler fixture validator PASS\n');
} else {
  assert.equal(existsSync(artifactPath), true, 'PERF-BGSTAB-010 measured decision artifact missing');
  withFreshContractExpectation(expectedPath => {
    const published = resolvePublishedArtifact(artifactPath);
    const expected = resolvePublishedArtifact(expectedPath);
    validateArtifact(published.path, expected.path, published.evidenceRoot, published.rawPath, expected.rawPath);
  });
  process.stdout.write('PERF-BGSTAB-010 fair scheduler decision artifact PASS\n');
}

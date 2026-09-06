import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const toolsRoot = dirname(fileURLToPath(import.meta.url));
const { validatePortableFairSchedulerEvidenceBundle } = require(resolve(toolsRoot, 'build-portable-runtime.js'));

const GENERATION_ID = 'cf56d5d0fe337118a7a670f31eb19ded123ad040a052cfa71899ad677296b2ff';
const SIDECAR_PATHS = [1, 2, 8].flatMap(clients =>
  [0, 1, 2, 3, 4].map(trial => `fair-scheduler-raw/clients-${clients}/trial-${trial}.json`));
const POLICY = { profile: 'fair-delivery-candidate', maxLaneShareRatio: 0.25 };

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function evidenceRootOf(outputDir) {
  return join(outputDir, 'server', 'dist', 'benchmarks', 'fair-scheduler-evidence');
}

function generationRootOf(outputDir, generationId = GENERATION_ID) {
  return join(evidenceRootOf(outputDir), 'generations', generationId);
}

/**
 * Reproduces the layout that server/tools/write-fair-scheduler-evidence-bundle.mjs emits:
 * a current.json pointer at the evidence root plus an immutable generations/<id>/ tree.
 */
function createBundleFixture(overrides = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'buildergate-portable-evidence-'));
  const canaryRecordPath = join(outputDir, 'canary-record.json');
  const generationId = overrides.generationId ?? GENERATION_ID;
  const rawEvidencePaths = overrides.rawEvidencePaths ?? SIDECAR_PATHS;

  writeJson(join(evidenceRootOf(outputDir), 'current.json'), {
    decision_artifact: 'fair-scheduler-decision.json',
    decision_sha256: 'a'.repeat(64),
    generation_id: generationId,
    provenance_artifact: 'provenance.json',
    provenance_sha256: 'b'.repeat(64),
    publication_generation: generationId,
    raw_manifest_sha256: 'c'.repeat(64),
    raw_root: 'raw/',
    schema_version: 'fair-scheduler-current-authority/v1',
    ...overrides.pointer,
  });

  const generationRoot = generationRootOf(outputDir, generationId);
  writeJson(join(generationRoot, 'fair-scheduler-decision.json'), {
    policy: POLICY,
    rawEvidencePaths,
    schemaVersion: 'fair-scheduler-decision/v1',
  });
  writeJson(join(generationRoot, 'provenance.json'), { generation_id: generationId });
  writeJson(join(generationRoot, 'raw', 'manifest.json'), {
    entries: SIDECAR_PATHS.map(path => ({ path: `raw/${path}`, sha256: 'd'.repeat(64) })),
    generation_id: generationId,
    schema_version: 'fair-scheduler-raw-manifest/v1',
  });
  for (const sidecar of SIDECAR_PATHS) {
    writeJson(join(generationRoot, 'raw', ...sidecar.split('/')), { trial: sidecar });
  }

  writeJson(join(outputDir, 'server', 'dist', 'benchmarks', 'fair-scheduler-source-provenance.json'), {
    generation_id: generationId,
  });
  writeJson(join(outputDir, 'server', 'package.json'), { name: 'buildergate-server-fixture', type: 'module' });

  const canaryPath = join(outputDir, 'server', 'dist', 'services', 'TerminalResourcePolicyCanary.js');
  mkdirSync(dirname(canaryPath), { recursive: true });
  writeFileSync(canaryPath, [
    "import { writeFileSync } from 'node:fs';",
    'export function validatePublishedFairDeliveryCandidateArtifact(input) {',
    `  writeFileSync(${JSON.stringify(canaryRecordPath)}, JSON.stringify(input ?? null), 'utf8');`,
    `  return { accepted: ${overrides.canaryAccepts === false ? 'false' : 'true'}, reason: 'fixture-canary' };`,
    '}',
    '',
  ].join('\n'), 'utf8');

  return { canaryRecordPath, generationRoot, outputDir };
}

function captureFailure(outputDir) {
  try {
    validatePortableFairSchedulerEvidenceBundle(outputDir);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('OPS-BGSTAB-009 accepts the bundle layout the evidence writer produces', () => {
  const { outputDir } = createBundleFixture();
  try {
    assert.doesNotThrow(() => validatePortableFairSchedulerEvidenceBundle(outputDir));
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
});

test('OPS-BGSTAB-009 still runs the runtime canary against the artifact policy', () => {
  const { canaryRecordPath, outputDir } = createBundleFixture();
  try {
    validatePortableFairSchedulerEvidenceBundle(outputDir);
    assert.deepEqual(
      JSON.parse(readFileSync(canaryRecordPath, 'utf8')),
      { runtimePolicy: POLICY },
      'the verifier must hand the artifact policy to the runtime canary',
    );
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
});

test('OPS-BGSTAB-009 rejects a bundle the runtime canary refuses', () => {
  const { outputDir } = createBundleFixture({ canaryAccepts: false });
  try {
    assert.equal(captureFailure(outputDir), 'compiled fair scheduler evidence rejected by portable preflight');
  } finally {
    rmSync(outputDir, { force: true, recursive: true });
  }
});

test('OPS-BGSTAB-009 still requires exactly 15 raw evidence sidecars', () => {
  for (const rawEvidencePaths of [SIDECAR_PATHS.slice(0, 14), [...SIDECAR_PATHS, SIDECAR_PATHS[0]]]) {
    const { outputDir } = createBundleFixture({ rawEvidencePaths });
    try {
      assert.equal(
        captureFailure(outputDir),
        'fair-scheduler-evidence sidecar manifest is invalid',
        `a declared sidecar count of ${rawEvidencePaths.length} must be rejected`,
      );
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  }
});

test('OPS-BGSTAB-009 rejects a bundle with any required file removed', () => {
  // Each removal is pinned to the check that must catch it, so that deleting one guard
  // cannot be masked by a later one failing for an unrelated reason.
  const removals = [
    [
      'current.json',
      outputDir => join(evidenceRootOf(outputDir), 'current.json'),
      /^fair-scheduler-evidence current pointer is invalid$/u,
    ],
    [
      'decision artifact',
      outputDir => join(generationRootOf(outputDir), 'fair-scheduler-decision.json'),
      /^fair-scheduler-evidence artifact missing: /u,
    ],
    [
      'raw manifest',
      outputDir => join(generationRootOf(outputDir), 'raw', 'manifest.json'),
      /^fair-scheduler-evidence raw manifest missing: /u,
    ],
    [
      'first sidecar',
      outputDir => join(generationRootOf(outputDir), 'raw', ...SIDECAR_PATHS[0].split('/')),
      /^fair-scheduler-evidence sidecar 0 missing: /u,
    ],
    [
      'last sidecar',
      outputDir => join(generationRootOf(outputDir), 'raw', ...SIDECAR_PATHS.at(-1).split('/')),
      /^fair-scheduler-evidence sidecar 14 missing: /u,
    ],
  ];

  for (const [label, locate, expected] of removals) {
    const { outputDir } = createBundleFixture();
    try {
      rmSync(locate(outputDir), { force: true });
      const message = captureFailure(outputDir);
      assert.notEqual(message, null, `removing the ${label} must fail the verifier`);
      assert.match(message, expected, `removing the ${label} must be caught by its own check, got: ${message}`);
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  }
});

test('OPS-BGSTAB-009 rejects declared paths that resolve outside the evidence root', () => {
  const escapes = [
    ['generation_id', { pointer: { generation_id: '../../../../escape' } }],
    ['generation_id absolute', { pointer: { generation_id: 'C:/Windows' } }],
    ['generation_id separator', { pointer: { generation_id: '..\\..\\escape' } }],
    ['decision_artifact', { pointer: { decision_artifact: '../../../../escape.json' } }],
    ['raw_root', { pointer: { raw_root: '../../../../' } }],
    ['sidecar', { rawEvidencePaths: ['../../../../escape.json', ...SIDECAR_PATHS.slice(1)] }],
  ];

  for (const [label, overrides] of escapes) {
    const { outputDir } = createBundleFixture(overrides);
    try {
      const message = captureFailure(outputDir);
      assert.notEqual(message, null, `an escaping ${label} must be rejected`);
      // The rejection must be a deliberate path decision, not an incidental "... missing"
      // from a mangled path that happened to land nowhere.
      assert.match(
        message,
        /^fair-scheduler-evidence .+ (?:is invalid|escapes its root)$/u,
        `an escaping ${label} must be refused as a path fault, got: ${message}`,
      );
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  }
});

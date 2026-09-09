const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  POSIX_LAUNCHER,
  WINDOWS_LAUNCHER_CMD,
  WINDOWS_LAUNCHER_PS1,
  createPosixLauncher,
  createWindowsCmdLauncher,
  createWindowsPowerShellLauncher,
  validatePortableBuildOutput,
  writePortableLaunchers,
} = require('../build-portable-runtime');
const { ICON_ICNS_NAME, ICON_ICO_NAME, ICON_SVG_NAME } = require('./icon-assets');

const temporaryDirectories = new Set();

function makeTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

const FIXTURE_GENERATION_ID = 'fixture-generation';
const FIXTURE_RUNTIME_POLICY = { maxLaneShareRatio: 0.25, profile: 'fair-delivery-candidate' };

function fairSchedulerEvidenceRootOf(outputDir) {
  return path.join(outputDir, 'server', 'dist', 'benchmarks', 'fair-scheduler-evidence');
}

function fairSchedulerGenerationRootOf(outputDir, generationId = FIXTURE_GENERATION_ID) {
  return path.join(fairSchedulerEvidenceRootOf(outputDir), 'generations', generationId);
}

function createPortableOutputFixture(platform = 'win32', {
  includeFairSchedulerProvenance = true,
  includeFairSchedulerEvidence = true,
  includeFairSchedulerRawManifest = true,
  includeFairSchedulerEvidenceSidecars = true,
  fairSchedulerCurrentPointer = 'valid',
  fairSchedulerSidecarCount = 15,
  fairSchedulerRuntimeAccepted = true,
} = {}) {
  const outputDir = makeTempDir('buildergate-portable-output-');
  touch(path.join(outputDir, 'web', 'index.html'), '<!doctype html>\n');
  touch(path.join(outputDir, 'shell-integration', 'bash-osc133.sh'), '# integration\n');
  touch(path.join(outputDir, 'config.json5'), 'auth: { password: "", jwtSecret: "" }\n');
  touch(path.join(outputDir, 'config.json5.example'), 'auth: { password: "", jwtSecret: "" }\n');
  touch(path.join(outputDir, 'README.md'), 'BuilderGate portable runtime\n');
  touch(path.join(outputDir, ICON_SVG_NAME), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  touch(path.join(outputDir, 'tools', 'start-runtime.js'), '// runtime\n');
  touch(path.join(outputDir, 'tools', 'daemon', 'launcher.js'), '// launcher\n');
  touch(path.join(outputDir, 'server', 'package.json'), '{"type":"module"}\n');
  touch(path.join(outputDir, 'server', 'package-lock.json'), '{}\n');
  touch(path.join(outputDir, 'server', 'dist', 'index.js'), 'export {};\n');
  if (includeFairSchedulerProvenance) {
    touch(
      path.join(outputDir, 'server', 'dist', 'benchmarks', 'fair-scheduler-source-provenance.json'),
      '{"schemaVersion":"fair-scheduler-source-provenance/v1"}\n',
    );
  }
  if (includeFairSchedulerEvidence) {
    const evidenceRoot = fairSchedulerEvidenceRootOf(outputDir);
    const generationRoot = fairSchedulerGenerationRootOf(outputDir);
    const rawEvidencePaths = Array.from({ length: fairSchedulerSidecarCount }, (_, index) => (
      `fair-scheduler-raw/clients-${1 + Math.floor(index / 5)}/trial-${index % 5}.json`
    ));
    if (fairSchedulerCurrentPointer === 'malformed') {
      touch(path.join(evidenceRoot, 'current.json'), 'not json\n');
    } else if (fairSchedulerCurrentPointer !== 'absent') {
      // Mirrors every field write-fair-scheduler-evidence-bundle.mjs emits, including the
      // three digests the verifier does not read, so the fixture cannot quietly drift
      // into a shape the writer never produces.
      touch(
        path.join(evidenceRoot, 'current.json'),
        `${JSON.stringify({
          decision_artifact: 'fair-scheduler-decision.json',
          decision_sha256: 'a'.repeat(64),
          generation_id: FIXTURE_GENERATION_ID,
          provenance_artifact: 'provenance.json',
          provenance_sha256: 'b'.repeat(64),
          publication_generation: FIXTURE_GENERATION_ID,
          raw_manifest_sha256: 'c'.repeat(64),
          raw_root: 'raw/',
          schema_version: 'fair-scheduler-current-authority/v1',
        })}\n`,
      );
    }
    touch(
      path.join(generationRoot, 'fair-scheduler-decision.json'),
      `${JSON.stringify({ policy: FIXTURE_RUNTIME_POLICY, rawEvidencePaths })}\n`,
    );
    touch(
      path.join(generationRoot, 'provenance.json'),
      `${JSON.stringify({ generation_id: FIXTURE_GENERATION_ID })}\n`,
    );
    if (includeFairSchedulerRawManifest) {
      touch(path.join(generationRoot, 'raw', 'manifest.json'), '{"entries":[]}\n');
    }
    if (includeFairSchedulerEvidenceSidecars) {
      for (const evidencePath of rawEvidencePaths) {
        touch(path.join(generationRoot, 'raw', ...evidencePath.split('/')), '{}\n');
      }
    } else {
      // Keep the raw root present so that omitting the sidecars is caught by the
      // per-sidecar check rather than by the raw-evidence check ahead of it.
      fs.mkdirSync(path.join(generationRoot, 'raw'), { recursive: true });
    }
  }
  touch(path.join(outputDir, 'server', 'dist', 'utils', 'configStrictLoader.js'), 'export {};\n');
  touch(path.join(outputDir, 'server', 'dist', 'services', 'daemonTotpPreflight.js'), 'export {};\n');
  touch(
    path.join(outputDir, 'server', 'dist', 'services', 'TerminalResourcePolicyCanary.js'),
    `export function validatePublishedFairDeliveryCandidateArtifact() { return { accepted: ${fairSchedulerRuntimeAccepted}, reason: 'fixture-runtime' }; }\n`,
  );
  touch(path.join(outputDir, 'server', 'node_modules', 'node-pty', 'package.json'), '{}\n');
  touch(path.join(outputDir, 'server', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js'), 'module.exports = {};\n');

  if (platform === 'win32') {
    touch(path.join(outputDir, WINDOWS_LAUNCHER_CMD), '@echo off\n');
    touch(path.join(outputDir, WINDOWS_LAUNCHER_PS1), '$root = ""\n');
    touch(path.join(outputDir, 'node', 'node.exe'), 'node');
    touch(path.join(outputDir, ICON_ICO_NAME), 'ico');
  } else {
    touch(path.join(outputDir, POSIX_LAUNCHER), '#!/usr/bin/env sh\n');
    touch(path.join(outputDir, 'node', 'bin', 'node'), 'node');
  }

  if (platform === 'darwin') {
    touch(path.join(outputDir, ICON_ICNS_NAME), 'icns');
  }

  return outputDir;
}

function realGenerationRootOf(outputDir) {
  const evidenceRoot = fairSchedulerEvidenceRootOf(outputDir);
  const { generation_id: generationId } = JSON.parse(
    fs.readFileSync(path.join(evidenceRoot, 'current.json'), 'utf8'),
  );
  assert.match(generationId, /^[0-9a-f]{64}$/, 'the staged bundle must name a real generation');
  return path.join(evidenceRoot, 'generations', generationId);
}

function fairSchedulerGenerationDigest(generationRoot) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of fs.readdirSync(generationRoot, { recursive: true }).sort()) {
    const entry = path.join(generationRoot, relativePath);
    if (!fs.statSync(entry).isFile()) continue;
    hash.update(relativePath).update('\n').update(fs.readFileSync(entry));
  }
  return hash.digest('hex');
}

function createRealFairSchedulerPortableFixture(platform = 'linux') {
  const outputDir = createPortableOutputFixture(platform);
  const stagedDist = path.join(outputDir, 'server', 'dist');
  fs.rmSync(stagedDist, { recursive: true, force: true });
  fs.cpSync(path.resolve(__dirname, '..', '..', 'server', 'dist'), stagedDist, { recursive: true });
  return outputDir;
}

test('portable launchers set runtime root, config, web, and shell integration envs', () => {
  const cmd = createWindowsCmdLauncher();
  assert.match(cmd, /BUILDERGATE_ROOT=%ROOT%/);
  assert.match(cmd, /BUILDERGATE_CONFIG_PATH=%ROOT%\\config\.json5/);
  assert.match(cmd, /BUILDERGATE_WEB_ROOT=%ROOT%\\web/);
  assert.match(cmd, /node\\node\.exe/);
  assert.match(cmd, /tools\\start-runtime\.js/);

  const ps1 = createWindowsPowerShellLauncher();
  assert.match(ps1, /BUILDERGATE_CONFIG_PATH/);
  assert.match(ps1, /node\\node\.exe/);

  const sh = createPosixLauncher();
  assert.match(sh, /BUILDERGATE_ROOT="\$ROOT"/);
  assert.match(sh, /node\/bin\/node/);
  assert.match(sh, /tools\/start-runtime\.js/);
});

test('writePortableLaunchers creates platform launcher entrypoints', () => {
  const winDir = makeTempDir('buildergate-portable-win-launchers-');
  writePortableLaunchers(winDir, 'win32');
  assert.equal(fs.existsSync(path.join(winDir, WINDOWS_LAUNCHER_CMD)), true);
  assert.equal(fs.existsSync(path.join(winDir, WINDOWS_LAUNCHER_PS1)), true);

  const linuxDir = makeTempDir('buildergate-portable-linux-launchers-');
  writePortableLaunchers(linuxDir, 'linux');
  const launcherPath = path.join(linuxDir, POSIX_LAUNCHER);
  assert.equal(fs.existsSync(launcherPath), true);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(launcherPath).mode & 0o111) !== 0, true);
  }
  assert.match(fs.readFileSync(launcherPath, 'utf8'), /node\/bin\/node/);
});

test('validatePortableBuildOutput accepts portable Windows runtime layout', () => {
  const outputDir = createPortableOutputFixture('win32');
  assert.doesNotThrow(() => validatePortableBuildOutput(outputDir, { platform: 'win32' }));
});

test('validatePortableBuildOutput requires the compiled fair scheduler provenance manifest', () => {
  const outputDir = createPortableOutputFixture('linux', { includeFairSchedulerProvenance: false });
  assert.throws(
    () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
    /fair-scheduler-source-provenance\.json/i,
  );
});

test('validatePortableBuildOutput requires the staged fair scheduler evidence bundle', () => {
  const outputDir = createPortableOutputFixture('linux', { includeFairSchedulerEvidence: false });
  // Pinned to the required-path check that owns this case. A bare /fair-scheduler-evidence/
  // would also be satisfied by any later evidence failure, which is not what this asserts.
  assert.throws(
    () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
    /fair-scheduler-evidence[\\/]current\.json missing/i,
  );
});

test('validatePortableBuildOutput reaches the bundle verifier for an unreadable current pointer', () => {
  // The absent case never enters the bundle verifier -- the required-path list catches it
  // first -- so only a present-but-unparseable pointer exercises that branch.
  const absent = createPortableOutputFixture('linux', { fairSchedulerCurrentPointer: 'absent' });
  assert.throws(
    () => validatePortableBuildOutput(absent, { platform: 'linux' }),
    /fair-scheduler-evidence[\\/]current\.json missing/i,
  );

  const malformed = createPortableOutputFixture('linux', { fairSchedulerCurrentPointer: 'malformed' });
  assert.throws(
    () => validatePortableBuildOutput(malformed, { platform: 'linux' }),
    /^Error: fair-scheduler-evidence current pointer is invalid$/,
  );
});

test('validatePortableBuildOutput requires fair scheduler raw evidence and every staged sidecar', () => {
  const missingRaw = createPortableOutputFixture('linux', { includeFairSchedulerRawManifest: false });
  assert.throws(
    () => validatePortableBuildOutput(missingRaw, { platform: 'linux' }),
    /fair-scheduler-evidence.*raw/i,
  );
  const missingSidecar = createPortableOutputFixture('linux', { includeFairSchedulerEvidenceSidecars: false });
  assert.throws(
    () => validatePortableBuildOutput(missingSidecar, { platform: 'linux' }),
    /fair-scheduler-evidence.*sidecar/i,
  );
});

test('validatePortableBuildOutput requires exactly fifteen unique fair scheduler sidecars', () => {
  for (const fairSchedulerSidecarCount of [14, 16]) {
    const outputDir = createPortableOutputFixture('linux', { fairSchedulerSidecarCount });
    assert.throws(
      () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
      /fair-scheduler-evidence.*sidecar/i,
    );
  }
});

test('validatePortableBuildOutput rejects evidence that the packaged compiled canary cannot admit', () => {
  const outputDir = createPortableOutputFixture('linux', { fairSchedulerRuntimeAccepted: false });
  assert.throws(
    () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
    /compiled fair scheduler evidence rejected/i,
  );
});

test('validatePortableBuildOutput admits a real compiled fair bundle and rejects a tampered one', () => {
  // Every tamper below was measured against a real staged dist. Two neighbouring mutations are
  // deliberately absent because they are NOT caught: an extra file in the generation root, and a
  // byte-identical rewrite of the decision. Asserting on those would only look like coverage.
  const tampers = [
    ['an unselected artifact inside the raw tree', generationRoot => {
      // The raw manifest enumerates this tree, so an unlisted file here is a real fault.
      // The same file one level up, in the generation root, is not enumerated and is admitted.
      touch(
        path.join(generationRoot, 'raw', 'fair-scheduler-raw', 'unselected.json'),
        '{"unselected":true}\n',
      );
    }],
    ['a single whitespace byte appended to the decision', generationRoot => {
      const artifactPath = path.join(generationRoot, 'fair-scheduler-decision.json');
      fs.writeFileSync(artifactPath, `${fs.readFileSync(artifactPath, 'utf8')} `, 'utf8');
    }],
    ['a changed decision sample count', generationRoot => {
      const artifactPath = path.join(generationRoot, 'fair-scheduler-decision.json');
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      artifact.rawSampleCount += 1;
      fs.writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`, 'utf8');
    }],
    ['a removed provenance artifact', generationRoot => {
      fs.rmSync(path.join(generationRoot, 'provenance.json'));
    }],
    ['a tampered raw sidecar', generationRoot => {
      const { rawEvidencePaths } = JSON.parse(
        fs.readFileSync(path.join(generationRoot, 'fair-scheduler-decision.json'), 'utf8'),
      );
      fs.writeFileSync(
        path.join(generationRoot, 'raw', ...rawEvidencePaths[0].split('/')),
        '{"tampered":true}\n',
        'utf8',
      );
    }],
  ];

  const admitted = createRealFairSchedulerPortableFixture('linux');
  assert.doesNotThrow(() => validatePortableBuildOutput(admitted, { platform: 'linux' }));

  for (const [label, tamper] of tampers) {
    const outputDir = createRealFairSchedulerPortableFixture('linux');
    const generationRoot = realGenerationRootOf(outputDir);
    const before = fairSchedulerGenerationDigest(generationRoot);
    tamper(generationRoot);
    assert.notEqual(
      fairSchedulerGenerationDigest(generationRoot),
      before,
      `${label} must actually change the staged bundle, or this case asserts nothing`,
    );
    assert.throws(
      () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
      /compiled fair scheduler evidence rejected/i,
      `${label} must be refused by the packaged compiled canary`,
    );
  }
});

test('validatePortableBuildOutput rejects an evidence root reached through a junction ancestor', () => {
  const outputDir = createPortableOutputFixture('linux');
  const aliasContainer = makeTempDir('buildergate-portable-evidence-alias-');
  const outputAlias = path.join(aliasContainer, 'runtime');
  try {
    fs.symlinkSync(outputDir, outputAlias, 'junction');
    assert.throws(
      () => validatePortableBuildOutput(outputAlias, { platform: 'linux' }),
      /symbolic link/i,
    );
  } finally {
    fs.rmSync(aliasContainer, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('validatePortableBuildOutput rejects exposed server config in portable runtime', () => {
  const outputDir = createPortableOutputFixture('linux');
  touch(path.join(outputDir, 'server', 'config.json5'), 'auth: { password: "secret" }\n');

  assert.throws(
    () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
    /server\/config\.json5 must not be exposed/i,
  );
});

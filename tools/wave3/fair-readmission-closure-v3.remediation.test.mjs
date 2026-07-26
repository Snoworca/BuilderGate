import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = process.cwd();
const outputDir = 'C:/Work/kiwi-run-output/2026-07-27.pm.fair-readmission-closure-v3/ac9-playwright';
const analysisDirectory = path.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);
const fixtureEntry = path.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness',
  'fair-scheduler-decision.json',
);

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function normalizedPath(value) {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function linkStat() {
  return {
    isReparsePoint: () => false,
    isSymbolicLink: () => true,
  };
}

function reparseStat() {
  return {
    isReparsePoint: () => true,
    isSymbolicLink: () => false,
  };
}

function fileSystemWith({ linkedPaths = [], missingPaths = [], reparsePaths = [] } = {}) {
  const links = new Set(linkedPaths.map(normalizedPath));
  const missing = new Set(missingPaths.map(normalizedPath));
  const reparses = new Set(reparsePaths.map(normalizedPath));
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return candidate => !missing.has(normalizedPath(candidate)) && target.existsSync(candidate);
      }
      if (property === 'lstatSync') {
        return candidate => reparses.has(normalizedPath(candidate))
          ? reparseStat()
          : links.has(normalizedPath(candidate))
            ? linkStat()
            : target.lstatSync(candidate);
      }
      if (property === 'readFileSync') {
        return (...args) => {
          const [candidate] = args;
          if (missing.has(normalizedPath(candidate))) {
            const error = new Error(`ENOENT: no such file or directory, open '${candidate}'`);
            error.code = 'ENOENT';
            throw error;
          }
          return target.readFileSync(...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
}

function ownedManifestPath(label) {
  return path.join(analysisDirectory, `.remediation-${label}-${process.pid}.json`);
}

function withOwnedManifestDirectory(callback) {
  const existed = fs.existsSync(analysisDirectory);
  fs.mkdirSync(analysisDirectory, { recursive: true });
  try {
    return callback();
  } finally {
    if (!existed && fs.existsSync(analysisDirectory) && fs.readdirSync(analysisDirectory).length === 0) {
      fs.rmdirSync(analysisDirectory);
    }
  }
}

function assertFailsBeforeWriting({ captureFrozenProvenance, label, expected, options }) {
  const manifestPath = ownedManifestPath(label);
  withOwnedManifestDirectory(() => {
    let absencePreconditionSucceeded = false;
    try {
      assert.equal(fs.existsSync(manifestPath), false, `${label} manifest leaf must start absent`);
      absencePreconditionSucceeded = true;
      assert.throws(
        () => captureFrozenProvenance({ workspaceRoot, manifestPath, phase: `remediation-${label}`, ...options }),
        expected,
      );
      assert.equal(fs.existsSync(manifestPath), false, `${label} failure must precede manifest write`);
    } finally {
      if (absencePreconditionSucceeded && fs.existsSync(manifestPath)) fs.rmSync(manifestPath);
    }
  });
}

test('SDS-AC-1 admits only the actual TerminalView CSS import as a hash-only source row', async () => {
  const { FROZEN_CONTRACT, collectSourceClosure } = await loadCollector();

  assert.equal(typeof collectSourceClosure, 'function');
  const closure = collectSourceClosure({
    workspaceRoot,
    sourceRoots: ['frontend/src/components/Terminal/TerminalView.tsx'],
    fs,
  });
  const cssRows = closure.sourceClosureRows.filter(row => row.path === 'frontend/src/components/Terminal/TerminalView.css');

  assert.deepEqual(cssRows, [{
    kind: 'source',
    path: 'frontend/src/components/Terminal/TerminalView.css',
    sha256: cssRows[0]?.sha256,
  }]);
  assert.match(cssRows[0].sha256, /^[a-f0-9]{64}$/i);
  assert.equal(FROZEN_CONTRACT.sourceRoots.includes('frontend/src/components/Terminal/TerminalView.css'), false);
  assert.throws(
    () => collectSourceClosure({
      workspaceRoot,
      sourceRoots: ['frontend/src/components/Terminal/TerminalView.css'],
      fs,
    }),
    /TerminalView\.tsx|non-code|dependency/i,
  );
  assert.throws(
    () => collectSourceClosure({ workspaceRoot, sourceRoots: ['server/config.json5'], fs }),
    /non-code|dependency/i,
  );
});

test('SDS-AC-2 rejects dangling output leaves and linked protected or manifest paths before writing', async () => {
  const { FROZEN_CONTRACT, captureFrozenProvenance, collectSourceClosure, validateFrozenContract } = await loadCollector();
  const manifestPath = ownedManifestPath('link');

  assert.throws(
    () => validateFrozenContract({
      workspaceRoot,
      contract: FROZEN_CONTRACT,
      fs: fileSystemWith({ linkedPaths: [outputDir] }),
    }),
    /output.*(?:link|reparse)|(?:link|reparse).*output/i,
  );
  assert.throws(
    () => validateFrozenContract({
      workspaceRoot,
      contract: FROZEN_CONTRACT,
      fs: fileSystemWith({ reparsePaths: [outputDir] }),
    }),
    /output.*(?:link|reparse)|(?:link|reparse).*output/i,
  );
  assert.throws(
    () => collectSourceClosure({
      workspaceRoot,
      sourceRoots: ['frontend/src/components/Terminal/TerminalView.tsx'],
      fs: fileSystemWith({ linkedPaths: [path.join(workspaceRoot, 'frontend', 'src', 'components', 'Terminal', 'TerminalView.css')] }),
    }),
    /link|reparse/i,
  );
  withOwnedManifestDirectory(() => {
    assert.throws(
      () => captureFrozenProvenance({
        workspaceRoot,
        manifestPath,
        phase: 'remediation-link',
        fs: fileSystemWith({ linkedPaths: [manifestPath] }),
      }),
      /manifest.*(?:link|reparse)|(?:link|reparse).*manifest/i,
    );
    assert.equal(fs.existsSync(manifestPath), false, 'linked manifest leaf must not be overwritten');
  });
});

test('SDS-AC-3 writes a contract-only canonical fingerprint independently of protected input rows', async () => {
  const { FROZEN_CONTRACT, buildCanonicalManifest, contractFingerprint } = await loadCollector();

  assert.equal(typeof contractFingerprint, 'function');
  const contract = contractFingerprint(FROZEN_CONTRACT);
  assert.deepEqual(Object.keys(contract).sort(), ['canonicalJson', 'sha256']);
  assert.equal(contract.sha256.length, 64);
  assert.equal(contract.canonicalJson.includes('protectedInput'), false);

  const build = sourceSha => buildCanonicalManifest({
    contract: FROZEN_CONTRACT,
    phase: 'remediation-contract',
    collector: { path: 'tools/wave3/fair-readmission-closure-v3.mjs', sha256: 'a'.repeat(64) },
    nodeRuntime: { path: 'C:/Program Files/nodejs/node.exe', sha256: 'b'.repeat(64), versionStdoutLf: 'v24.0.0\n' },
    selectedCommands: [{ id: 'decision-validator', cwd: '.', argv: ['node', 'tools/wave3/fair-scheduler-decision.test.mjs'] }],
    sourceClosureRows: [{ kind: 'source', path: 'server/src/ws/WsRouter.ts', sha256: sourceSha }],
    fixtureRows: [{ kind: 'fixture', path: 'docs/analysis/fair.json', sha256: 'c'.repeat(64) }],
    configLockRows: [{ kind: 'config_lock', path: 'server/config.json5', sha256: 'd'.repeat(64) }],
    externalSpecifierRows: [{ from: 'server/src/ws/WsRouter.ts', specifier: 'node:crypto', resolvedOrBuiltin: 'builtin' }],
    git: { head: 'e'.repeat(40), statusRows: [{ xy: '!!', path: 'server/config.json5' }], indexRows: [] },
  });
  const first = build('f'.repeat(64));
  const second = build('0'.repeat(64));

  assert.deepEqual(first.contract, contract);
  assert.deepEqual(second.contract, contract);
  assert.notEqual(first.protectedInput.sha256, second.protectedInput.sha256);
});

test('SDS-AC-4 captures the actual workspace into one disposable manifest without Playwright output', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const manifestPath = ownedManifestPath('capture');
  const analysisDirectoryExisted = fs.existsSync(analysisDirectory);

  assert.equal(fs.existsSync(outputDir), false, 'the frozen external Playwright leaf must start absent');
  try {
    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: 'remediation-disposable-capture',
      fs,
    });
    const written = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const writtenBytes = fs.readFileSync(manifestPath);

    assert.equal(writtenBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
    assert.equal(writtenBytes.includes(0x0d), false, 'manifest must use LF only');
    assert.deepEqual(written, manifest);
    assert.equal(written.contract.sha256, createHash('sha256').update(written.contract.canonicalJson, 'utf8').digest('hex'));
    assert.equal(written.protectedInput.sha256, createHash('sha256').update(written.protectedInput.canonicalJson, 'utf8').digest('hex'));
    assert.equal(written.protectedInput.value.sourceClosureRows.some(row => row.path === 'frontend/src/components/Terminal/TerminalView.tsx'), true);
    assert.equal(written.protectedInput.value.sourceClosureRows.some(row => row.path === 'frontend/src/components/Terminal/TerminalView.css'), true);
    assert.equal(written.protectedInput.value.fixtureRows.length > 0, true);
    assert.equal(written.protectedInput.value.configLockRows.some(row => row.path === 'server/config.json5'), true);
    assert.deepEqual(written.protectedInput.value.git.commandPrefix, ['git', '-c', 'core.longpaths=true']);
    assert.equal(written.protectedInput.value.git.protectedRepoPaths.includes('server/config.json5'), true);
    assert.match(written.protectedInput.value.nodeRuntime.sha256, /^[a-f0-9]{64}$/i);
    assert.equal(fs.existsSync(outputDir), false, 'provenance capture must not launch Playwright or create external output');
  } finally {
    if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath);
    if (!analysisDirectoryExisted && fs.existsSync(analysisDirectory) && fs.readdirSync(analysisDirectory).length === 0) {
      fs.rmdirSync(analysisDirectory);
    }
  }
});

test('SDS-AC-5 fails on injected source, fixture, and scoped-Git faults before writing', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const terminalView = path.join(workspaceRoot, 'frontend', 'src', 'components', 'Terminal', 'TerminalView.tsx');

  assertFailsBeforeWriting({
    captureFrozenProvenance,
    label: 'missing-source',
    expected: /missing source closure input/i,
    options: { fs: fileSystemWith({ missingPaths: [terminalView] }) },
  });
  assertFailsBeforeWriting({
    captureFrozenProvenance,
    label: 'missing-fixture',
    expected: /fixture/i,
    options: { fs: fileSystemWith({ missingPaths: [fixtureEntry] }) },
  });
  assertFailsBeforeWriting({
    captureFrozenProvenance,
    label: 'missing-config-lock',
    expected: /missing config_lock/i,
    options: { fs: fileSystemWith({ missingPaths: [path.join(workspaceRoot, 'server', 'config.json5')] }) },
  });

  const savedPath = process.env.PATH;
  const savedWindowsPath = process.env.Path;
  process.env.PATH = path.join(workspaceRoot, '__remediation-test-no-git__');
  process.env.Path = process.env.PATH;
  try {
    assertFailsBeforeWriting({
      captureFrozenProvenance,
      label: 'scoped-git',
      expected: /git|enoent/i,
      options: { fs },
    });
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedWindowsPath === undefined) delete process.env.Path;
    else process.env.Path = savedWindowsPath;
  }
});

test('SDS-AC-4 rejects test-only input overrides so every capture binds the frozen closure', async () => {
  const { captureFrozenProvenance } = await loadCollector();

  assertFailsBeforeWriting({
    captureFrozenProvenance,
    label: 'test-input-override',
    expected: /test.?only|frozen.*input|override/i,
    options: { testOnlyInputs: { sourceRoots: [] } },
  });
});

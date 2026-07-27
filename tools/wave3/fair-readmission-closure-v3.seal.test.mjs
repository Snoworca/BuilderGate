import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const analysisRoot = path.win32.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);
const collectorUrl = new URL('./fair-readmission-closure-v3.mjs', import.meta.url);
const publicProtectedIo = new Set([
  'createProtectedInputSnapshot',
  'createStrictAdmissionContext',
  'readProtectedInput',
  'hashConfigLockFile',
  'collectSourceClosure',
  'writeCapturedManifest',
]);

async function loadCollector() {
  return import(collectorUrl);
}

function testOwnedLeaf(prefix) {
  return path.win32.join(
    analysisRoot,
    `${prefix}-${process.pid}-${randomBytes(8).toString('hex')}.json`,
  );
}

function assertOwnedLeaf(candidate, prefix) {
  const normalizedRoot = `${path.win32.normalize(analysisRoot).toLowerCase()}\\`;
  const normalizedCandidate = path.win32.normalize(candidate).toLowerCase();
  assert.equal(normalizedCandidate.startsWith(normalizedRoot), true, 'cleanup must stay in the capture analysis root');
  assert.equal(path.win32.basename(candidate).startsWith(`${prefix}-`), true, 'cleanup must target this test nonce only');
}

function removeOwnedLeaf(candidate, prefix) {
  assertOwnedLeaf(candidate, prefix);
  if (existsSync(candidate)) unlinkSync(candidate);
}

test('SDS-AC-1 keeps protected-admission minting and protected I/O private to native capture', async () => {
  const collector = await loadCollector();
  for (const name of publicProtectedIo) {
    assert.equal(
      Object.hasOwn(collector, name),
      false,
      `${name} must not be a public protected-input authority or I/O seam`,
    );
  }

  const prefix = 'seal-forged-authority';
  const manifestPath = testOwnedLeaf(prefix);
  const poisonFs = new Proxy({}, {
    get(_target, property) {
      throw new Error(`caller-supplied filesystem authority was observed: ${String(property)}`);
    },
  });
  try {
    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath,
        phase: 'seal-forged-authority',
        fs: poisonFs,
        reparseGuard: Object.freeze({}),
        snapshot: Object.freeze({}),
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
      'native capture must reject every caller authority before any protected filesystem operation',
    );
    assert.equal(existsSync(manifestPath), false, 'a rejected caller authority must not mint a manifest leaf');
  } finally {
    removeOwnedLeaf(manifestPath, prefix);
  }
});

test('SDS-AC-2 fails closed for every unsupported import or export form without a test-source exception', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  assert.equal(typeof parseAdmittedImportSpecifiers, 'function', 'the lexical extractor remains directly contract-testable without exposing protected I/O');

  const fromPath = 'server/src/ws/WsRouter.ts';
  const unsupportedForms = [
    ['import.meta', 'void import.meta.url;'],
    ['export default', 'export default { retained: true };'],
    ['local export', 'const retained = true; export { retained };'],
    ['export default declaration', 'export default function retained() {}'],
    ['escaped static literal', "import './child\\x2ejs';"],
    ['template dynamic import', 'await import(`./child.js`);'],
    ['dynamic expression', "const target = './child.js'; await import(target);"],
    ['options dynamic import', "await import('./child.js', { with: { type: 'json' } });"],
  ];

  for (const [label, sourceText] of unsupportedForms) {
    assert.throws(
      () => parseAdmittedImportSpecifiers({ sourceText, fromPath }),
      /unsupported|nonliteral|dynamic|import|export|lexical/i,
      `${label} must abort closure capture rather than be silently omitted`,
    );
  }

  const collectorSource = readFileSync(collectorUrl, 'utf8');
  assert.doesNotMatch(
    collectorSource,
    /testHarnessSource/,
    'the lexical extractor must not special-case test filenames when deciding whether malformed import syntax is admissible',
  );
  assert.doesNotMatch(
    collectorSource,
    /(?:node_modules\/)?typescript(?:\.js)?/i,
    'the closure collector must not execute an external TypeScript parser runtime',
  );
});

test('SDS-AC-3 rejects an unexpected manifest-leaf directory role through the sole native capture entry point', async () => {
  const collector = await loadCollector();
  const prefix = 'seal-directory-role';
  const manifestPath = testOwnedLeaf(prefix);
  try {
    mkdirSync(manifestPath);
    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath,
        phase: 'seal-directory-role',
      }),
      /directory|role|regular|file|manifest|reparse/i,
      'a manifest leaf directory is never an admissible native-capture role',
    );
    assert.equal(existsSync(manifestPath), true, 'native capture must not replace a disallowed directory leaf');
  } finally {
    assertOwnedLeaf(manifestPath, prefix);
    if (existsSync(manifestPath)) rmSync(manifestPath, { recursive: true, force: true });
  }

  const collectorSource = readFileSync(collectorUrl, 'utf8');
  const captureSource = collectorSource.slice(collectorSource.indexOf('export function captureFrozenProvenance'));
  const manifestAdmission = captureSource.indexOf('assertManifestDestination');
  const firstProtectedRead = captureSource.indexOf('validateFrozenContract');
  assert.equal(manifestAdmission >= 0 && manifestAdmission < firstProtectedRead, true, 'native capture must validate manifest path roles before it probes or reads protected inputs');
});

test('SDS-AC-4 runs native capture with a fixed Git executable despite poisoned ambient Git variables', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const prefix = 'seal-fixed-git';
  const manifestPath = testOwnedLeaf(prefix);
  const poisoned = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS,
  };
  try {
    process.env.PATH = path.win32.join(workspaceRoot, '__seal-test-no-git__');
    process.env.Path = process.env.PATH;
    process.env.GIT_CONFIG_GLOBAL = path.win32.join(workspaceRoot, '__seal-test-forged-gitconfig__');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_OPTIONAL_LOCKS = '0';

    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: 'seal-fixed-git',
    });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'the fixed-Git capture must persist the canonical native manifest');
    assert.equal(
      manifest.protectedInput.value.git.commandPrefix[0],
      'C:/Program Files/Git/cmd/git.exe',
      'Git provenance must record the fixed, verified absolute executable rather than an ambient command name',
    );
  } finally {
    for (const [name, value] of Object.entries(poisoned)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeOwnedLeaf(manifestPath, prefix);
  }
});

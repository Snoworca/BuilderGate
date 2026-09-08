import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOwnedAnalysisLeaf } from './admission-fixture-ownership.mjs';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
  const leaf = createOwnedAnalysisLeaf(prefix);
  const { manifestPath } = leaf;
  let priorFailure;
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
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

test('SDS-AC-2 consumes explicit lexical zero-edge forms and fails closed for unsupported resolution without a test-source exception', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  assert.equal(typeof parseAdmittedImportSpecifiers, 'function', 'the lexical extractor remains directly contract-testable without exposing protected I/O');

  const fromPath = 'server/src/ws/WsRouter.ts';
  const zeroEdgeForms = [
    ['import.meta.url', 'void import.meta.url;'],
    ['export default', 'export default { retained: true };'],
    ['local export', 'const retained = true; export { retained };'],
    ['export default declaration', 'export default function retained() {}'],
    ['TypeScript literal import type query', "type Retained = import('./retained.js').Retained;"],
  ];
  for (const [label, sourceText] of zeroEdgeForms) {
    assert.deepEqual(
      parseAdmittedImportSpecifiers({ sourceText, fromPath }),
      [],
      `${label} is explicit zero-edge syntax and must not produce a closure dependency`,
    );
  }

  const unsupportedForms = [
    ['resolver-capable import.meta', "import.meta.resolve('./child.js');"],
    ['escaped static literal', "import './child\\x2ejs';"],
    ['template dynamic import', 'await import(`./child.js`);'],
    ['mutable dynamic binding', "let target = './child.js'; await import(target);"],
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
  const leaf = createOwnedAnalysisLeaf(prefix);
  const { manifestPath } = leaf;
  let priorFailure;
  try {
    leaf.createDirectory();
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
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }

  const collectorSource = readFileSync(collectorUrl, 'utf8');
  const captureSource = collectorSource.slice(collectorSource.indexOf('export function captureFrozenProvenance'));
  const manifestAdmission = captureSource.indexOf('assertManifestDestination');
  const firstProtectedRead = captureSource.indexOf('validateFrozenContract');
  assert.equal(manifestAdmission >= 0 && manifestAdmission < firstProtectedRead, true, 'native capture must validate manifest path roles before it probes or reads protected inputs');
});

test('SDS-AC-4 runs native capture with a fixed Git executable despite poisoned ambient Git variables', async () => {
  const prefix = 'seal-fixed-git';
  const leaf = createOwnedAnalysisLeaf(prefix);
  const { manifestPath } = leaf;
  let priorFailure;
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

    const manifest = leaf.capture('seal-fixed-git');
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'the fixed-Git capture must persist the canonical native manifest');
    assert.equal(
      manifest.protectedInput.value.git.commandPrefix[0],
      'C:/Program Files/Git/cmd/git.exe',
      'Git provenance must record the fixed, verified absolute executable rather than an ambient command name',
    );
  } catch (error) { priorFailure = { error }; } finally {
    for (const [name, value] of Object.entries(poisoned)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    leaf.cleanup(priorFailure);
  }
});

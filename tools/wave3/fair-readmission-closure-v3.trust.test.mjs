import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const inventoryPath = 'server/src/services/TerminalResourcePolicyInventory.ts';
const analysisRoot = path.win32.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function noProtectedIo() {
  const calls = [];
  const deny = operation => () => {
    calls.push(operation);
    throw new Error(`unexpected protected I/O: ${operation}`);
  };
  return {
    calls,
    existsSync: deny('existsSync'),
    statSync: deny('statSync'),
    lstatSync: deny('lstatSync'),
    readFileSync: deny('readFileSync'),
    writeFileSync: deny('writeFileSync'),
    mkdirSync: deny('mkdirSync'),
  };
}

function noOpIngress(events) {
  return {
    reparseGuard: {
      assertSafeMany() {
        events.push('assertSafeMany');
        throw new Error('unexpected caller-supplied guard invocation');
      },
      prepareWave() {
        events.push('prepareWave');
        throw new Error('unexpected caller-supplied guard invocation');
      },
      completeWave() {
        events.push('completeWave');
        throw new Error('unexpected caller-supplied guard invocation');
      },
    },
    snapshot: {
      readWave() {
        events.push('readWave');
        throw new Error('unexpected caller-supplied snapshot invocation');
      },
    },
  };
}

function ownedNativeCaptureManifestPath() {
  return path.win32.join(analysisRoot, `.trust-native-capture-${process.pid}-${randomBytes(6).toString('hex')}.json`);
}

function removeOwnedNativeCaptureManifest(manifestPath) {
  assert.equal(path.win32.dirname(manifestPath), analysisRoot, 'trust capture cleanup must stay within its analysis directory');
  assert.equal(path.win32.basename(manifestPath).startsWith('.trust-native-capture-'), true, 'trust capture cleanup must target only its own leaf');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

test('SDS-AC-1 rejects every caller-provided protected ingress authority before native capture I/O', async () => {
  const collector = await loadCollector();
  const cases = [
    ['counterfeit admission', { admission: Object.freeze({ token: 'counterfeit-admission' }) }],
    ['caller filesystem', { fs: noProtectedIo() }],
    ['caller guard and snapshot', noOpIngress([])],
  ];

  for (const [label, supplied] of cases) {
    const fs = supplied.fs ?? noProtectedIo();
    const ingressEvents = [];
    const ingress = label === 'caller guard and snapshot' ? noOpIngress(ingressEvents) : {};
    const manifestPath = ownedNativeCaptureManifestPath();
    try {
      assert.throws(
        () => collector.captureFrozenProvenance({
          workspaceRoot,
          manifestPath,
          phase: 'trust-forged-ingress',
          ...supplied,
          ...ingress,
        }),
        /capture options|native|authority|unsupported|forbid|reject/i,
        `${label} must be rejected before native capture can observe a caller seam`,
      );
      assert.equal(existsSync(manifestPath), false, `${label} must not mint a manifest leaf`);
    } finally {
      removeOwnedNativeCaptureManifest(manifestPath);
    }
    assert.deepEqual(fs.calls, [], `${label} must perform zero caller filesystem operations`);
    assert.deepEqual(ingressEvents, [], `${label} must not invoke a caller-supplied probe, guard, or snapshot`);
  }
});

test('SDS-AC-2 uses collector-owned lexical parsing without executing TypeScript and retains literal inventory imports', async () => {
  const {
    captureFrozenProvenance,
    parseAdmittedImportSpecifiers,
  } = await loadCollector();
  const collectorSource = readFileSync(new URL('./fair-readmission-closure-v3.mjs', import.meta.url), 'utf8');
  const inventorySource = readFileSync(inventoryPath, 'utf8');

  assert.doesNotMatch(
    collectorSource,
    /^\s*import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s+['"][^'"]*(?:node_modules\/)?typescript(?:\.js)?['"];?/m,
    'the collector must not execute an external TypeScript parser before provenance admission',
  );
  assert.doesNotMatch(
    collectorSource,
    /server\/node_modules\/typescript\/lib\/typescript\.js/i,
    'the collector must not reach into an ignored TypeScript runtime path',
  );
  assert.match(inventorySource, /await\s+import\(\s*['"]typescript['"]\s*\)/, 'the real inventory must retain its literal dynamic import');
  assert.match(inventorySource, /import\(\s*['"]typescript['"]\s*\)\./, 'the real inventory must retain its literal type import');

  const synthetic = [
    "import type { TerminalResourceKey } from './TerminalResourcePolicy.js';",
    "export type { TerminalResourcePolicyConsumerId } from './TerminalResourcePolicy.js';",
    "const module = await import('typescript');",
    "type SourceFile = import('typescript').SourceFile;",
    'void module;',
  ].join('\n');
  assert.deepEqual(
    parseAdmittedImportSpecifiers({ sourceText: synthetic, fromPath: inventoryPath }).sort(),
    ['./TerminalResourcePolicy.js', './TerminalResourcePolicy.js', 'typescript'].sort(),
    'the lexical extractor must retain normal literal static/type/dynamic edges while consuming a TypeScript literal import type query as zero-edge syntax',
  );
  assert.equal(
    parseAdmittedImportSpecifiers({ sourceText: inventorySource, fromPath: inventoryPath }).includes('typescript'),
    true,
    'the real inventory type/dynamic forms must remain in the admitted parser result',
  );
  assert.deepEqual(
    parseAdmittedImportSpecifiers({
      sourceText: "const requested = './child.js'; await import(requested);",
      fromPath: inventoryPath,
    }),
    ['./child.js'],
    'one prior immutable literal const must form a normal runtime dynamic-import edge',
  );
  assert.throws(
    () => parseAdmittedImportSpecifiers({
      sourceText: "let requested = './child.js'; await import(requested);",
      fromPath: inventoryPath,
    }),
    /nonliteral|dynamic|unsupported|lexical|import|mutable/i,
    'a mutable dynamic import must still fail closed instead of escaping lexical provenance',
  );

  const manifestPath = ownedNativeCaptureManifestPath();
  assert.equal(existsSync(manifestPath), false, 'the test-owned native capture leaf must start absent');
  try {
    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: 'trust-native-frozen-capture',
    });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'the native capture must persist exactly the admitted manifest');
    const protectedInput = manifest.protectedInput.value;
    assert.equal(
      protectedInput.sourceClosureRows.some(row => row.path === inventoryPath),
      true,
      'the default frozen native closure must reach the real Inventory through its admitted source roots',
    );
    assert.equal(protectedInput.externalSpecifierRows.some(row => (
      row.from === inventoryPath
      && row.specifier === 'typescript'
      && row.resolvedOrBuiltin === 'package:typescript'
    )), true, 'the default frozen native closure must retain the Inventory TypeScript external rows');
  } finally {
    removeOwnedNativeCaptureManifest(manifestPath);
  }
});

test('SDS-AC-3 rejects real directory leaves before native probing or writing and keeps special-role simulation private', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const directoryLeaf = ownedNativeCaptureManifestPath();
  const callerFs = noProtectedIo();
  try {
    mkdirSync(directoryLeaf);
    assert.throws(
      () => captureFrozenProvenance({
        workspaceRoot,
        manifestPath: directoryLeaf,
        phase: 'trust-directory-role',
      }),
      /regular|file|directory|special|role|manifest|reparse/i,
      'a real directory leaf must fail native role admission before it can become a manifest destination',
    );
    assert.equal(existsSync(directoryLeaf), true, 'native capture must not replace a disallowed directory leaf');
    assert.throws(
      () => captureFrozenProvenance({
        workspaceRoot,
        manifestPath: ownedNativeCaptureManifestPath(),
        phase: 'trust-special-role',
        fs: callerFs,
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
      'a caller must not simulate a special role through a public manifest-writing seam',
    );
    assert.deepEqual(callerFs.calls, [], 'the rejected caller filesystem cannot be probed or asked to write');
  } finally {
    if (existsSync(directoryLeaf)) rmSync(directoryLeaf, { recursive: true, force: true });
  }
});

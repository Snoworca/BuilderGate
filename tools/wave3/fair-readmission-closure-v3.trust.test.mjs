import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
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

function roleStat(role, seed = 1) {
  return {
    dev: 7,
    ino: seed,
    mode: role === 'directory' ? 0o040755 : role === 'file' ? 0o100644 : 0o020666,
    ctimeMs: 10_000 + seed,
    mtimeMs: 20_000 + seed,
    size: 30_000 + seed,
    isDirectory: () => role === 'directory',
    isFile: () => role === 'file',
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  };
}

function normalizeWindows(value) {
  return path.win32.normalize(value).replaceAll('\\', '/').toLowerCase();
}

function ownedNativeCaptureManifestPath() {
  return path.win32.join(analysisRoot, `.trust-native-capture-${process.pid}-${randomBytes(6).toString('hex')}.json`);
}

function removeOwnedNativeCaptureManifest(manifestPath) {
  assert.equal(path.win32.dirname(manifestPath), analysisRoot, 'trust capture cleanup must stay within its analysis directory');
  assert.equal(path.win32.basename(manifestPath).startsWith('.trust-native-capture-'), true, 'trust capture cleanup must target only its own leaf');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

test('SDS-AC-1 rejects absent, counterfeit, and no-op admission before any protected ingress I/O', async () => {
  const {
    collectSourceClosure,
    hashConfigLockFile,
    readProtectedInput,
  } = await loadCollector();
  const cases = [
    ['absent', undefined],
    ['counterfeit', Object.freeze({ token: 'counterfeit-admission' })],
    ['no-op', Object.freeze({ reparseGuard: Object.freeze({}), snapshot: Object.freeze({}) })],
  ];

  for (const [label, admission] of cases) {
    const fs = noProtectedIo();
    const ingressEvents = [];
    const ingress = noOpIngress(ingressEvents);
    const calls = [
      () => readProtectedInput({
        fs,
        absolutePath: `${workspaceRoot}/server/src/ws/WsRouter.ts`,
        kind: 'source',
        path: 'server/src/ws/WsRouter.ts',
        ...(label === 'absent' ? {} : { admission }),
        reparseGuard: ingress.reparseGuard,
      }),
      () => hashConfigLockFile({
        fs,
        workspaceRoot,
        relativePath: 'server/config.json5',
        ...(label === 'absent' ? {} : { admission }),
        reparseGuard: ingress.reparseGuard,
        snapshot: ingress.snapshot,
      }),
      () => collectSourceClosure({
        fs,
        workspaceRoot,
        ...(label === 'absent' ? {} : { admission }),
        reparseGuard: ingress.reparseGuard,
        snapshot: ingress.snapshot,
      }),
    ];

    for (const invoke of calls) {
      assert.throws(
        invoke,
        /admission|native|minted|capabilit|strict|protected/i,
        `${label} admission must be rejected before a row-producing ingress can observe a caller seam`,
      );
    }
    assert.deepEqual(fs.calls, [], `${label} admission must perform zero filesystem operations`);
    assert.deepEqual(ingressEvents, [], `${label} admission must not invoke a caller-supplied probe, guard, or snapshot`);
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
    ['./TerminalResourcePolicy.js', './TerminalResourcePolicy.js', 'typescript', 'typescript'].sort(),
    'the lexical extractor must retain contained literal static/type/dynamic import specifiers without a host parser',
  );
  assert.equal(
    parseAdmittedImportSpecifiers({ sourceText: inventorySource, fromPath: inventoryPath }).includes('typescript'),
    true,
    'the real inventory type/dynamic forms must remain in the admitted parser result',
  );
  assert.throws(
    () => parseAdmittedImportSpecifiers({
      sourceText: "const requested = './child.js'; await import(requested);",
      fromPath: inventoryPath,
    }),
    /nonliteral|dynamic|unsupported|lexical|import/i,
    'a nonliteral dynamic import must fail closed instead of escaping lexical provenance',
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

test('SDS-AC-3 rejects special and directory manifest leaves before probing or writing', async () => {
  const { createSegmentReparseGuard, writeCapturedManifest } = await loadCollector();
  const manifest = { schemaVersion: 'trust-role-test', protectedInput: { sha256: 'a'.repeat(64) } };

  for (const role of ['special', 'directory']) {
    const destination = path.win32.join(analysisRoot, `trust-${role}-leaf.json`);
    const destinationKey = normalizeWindows(destination);
    const operations = [];
    const fs = {
      lstatSync(candidate) {
        return normalizeWindows(candidate) === destinationKey ? roleStat(role, 99) : roleStat('directory', 1);
      },
      mkdirSync(candidate, options) {
        operations.push(['mkdir', candidate, options]);
      },
      writeFileSync(candidate, text, options) {
        operations.push(['write', candidate, text, options]);
      },
    };
    const reparseGuard = createSegmentReparseGuard({
      fs,
      probeBatch(paths) {
        operations.push(['probe', paths]);
      },
    });

    assert.throws(
      () => writeCapturedManifest({ workspaceRoot, manifestPath: destination, manifest, fs, reparseGuard }),
      /regular|file|directory|special|role|manifest|reparse/i,
      `${role} leaf must fail role admission before it can become a manifest destination`,
    );
    assert.equal(
      operations.some(([operation]) => operation === 'probe'),
      false,
      `${role} leaf must fail before a reparse probe can bless it`,
    );
    assert.equal(
      operations.some(([operation]) => operation === 'write'),
      false,
      `${role} leaf must fail before a write can replace or race it`,
    );
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const inventoryPath = 'server/src/services/TerminalResourcePolicyInventory.ts';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function noFilesystemAccess() {
  const calls = [];
  const deny = operation => () => {
    calls.push(operation);
    throw new Error(`unexpected filesystem ${operation}`);
  };
  return {
    calls,
    existsSync: deny('existsSync'),
    statSync: deny('statSync'),
    lstatSync: deny('lstatSync'),
    readFileSync: deny('readFileSync'),
  };
}

function counterfeitIngress(probeCalls) {
  return {
    reparseGuard: {
      assertSafeMany() {
        probeCalls.push('assertSafeMany');
      },
      prepareWave() {
        probeCalls.push('prepareWave');
        return Object.freeze({ counterfeit: true });
      },
      completeWave() {
        probeCalls.push('completeWave');
      },
    },
    snapshot: {
      readWave() {
        probeCalls.push('readWave');
        return [];
      },
    },
  };
}

test('SDS-AC-1 rejects absent, no-op, and counterfeit admission contexts before filesystem or probe work', async () => {
  const {
    collectSourceClosure,
    hashConfigLockFile,
    readProtectedInput,
  } = await loadCollector();
  const cases = [
    ['absent', undefined],
    ['no-op', Object.freeze({})],
    ['counterfeit', Object.freeze({ token: 'module-minted' })],
  ];

  for (const [label, admission] of cases) {
    const fs = noFilesystemAccess();
    const probeCalls = [];
    const counterfeit = counterfeitIngress(probeCalls);
    const publicCalls = [
      () => readProtectedInput({
        fs,
        absolutePath: `${workspaceRoot}/server/src/ws/WsRouter.ts`,
        kind: 'source',
        path: 'server/src/ws/WsRouter.ts',
        admission,
        reparseGuard: counterfeit.reparseGuard,
      }),
      () => hashConfigLockFile({
        fs,
        workspaceRoot,
        relativePath: 'server/config.json5',
        admission,
        reparseGuard: counterfeit.reparseGuard,
        snapshot: counterfeit.snapshot,
      }),
      () => collectSourceClosure({
        fs,
        workspaceRoot,
        sourceRoots: ['server/src/services/TerminalResourcePolicyInventory.ts'],
        admission,
        reparseGuard: counterfeit.reparseGuard,
        snapshot: counterfeit.snapshot,
      }),
    ];

    for (const invoke of publicCalls) {
      assert.throws(
        invoke,
        /admission|minted|capabilit|strict|protected/i,
        `${label} context must be rejected before any protected ingress work`,
      );
    }
    assert.deepEqual(fs.calls, [], `${label} context must perform zero filesystem operations`);
    assert.deepEqual(probeCalls, [], `${label} context must perform zero guard, snapshot, or probe operations`);
  }
});

test('SDS-AC-2 rejects an 8 KiB-plus singleton before an injected custom batch probe', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  let probeCalls = 0;

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  assert.throws(
    () => probeWindowsReparsePoints({
      paths: [`C:/${'x'.repeat(8 * 1024)}`],
      platform: 'win32',
      spawnSync() {
        probeCalls += 1;
        throw new Error('oversized singleton reached the custom probe');
      },
    }),
    /count|byte|limit|cap|reparse/i,
  );
  assert.equal(probeCalls, 0, 'the oversized singleton must not launch a custom probe');
});

test('SDS-AC-3 includes TerminalResourcePolicyInventory literal dynamic and type imports in admitted closure discovery', async () => {
  const {
    collectSourceClosure,
    createStrictAdmissionContext,
    parseAdmittedImportSpecifiers,
  } = await loadCollector();
  const inventoryText = readFileSync(inventoryPath, 'utf8');
  const probeBatches = [];

  assert.match(inventoryText, /await\s+import\(\s*['"]typescript['"]\s*\)/, 'the real inventory must retain its literal dynamic import fixture');
  assert.match(inventoryText, /(?:typeof\s+)?import\(\s*['"]typescript['"]\s*\)\./, 'the real inventory must retain its literal type-import fixture');
  assert.equal(typeof createStrictAdmissionContext, 'function');
  assert.equal(typeof parseAdmittedImportSpecifiers, 'function');
  assert.equal(
    parseAdmittedImportSpecifiers({ sourceText: inventoryText, fromPath: inventoryPath }).includes('typescript'),
    true,
    'the admitted parser must retain literal dynamic/type import specifiers from the real inventory source',
  );

  const admission = createStrictAdmissionContext({
    probeBatch(paths) {
      probeBatches.push([...paths]);
    },
  });
  const closure = collectSourceClosure({
    workspaceRoot,
    sourceRoots: [inventoryPath],
    admission,
  });
  const inventoryExternalSpecifiers = closure.externalSpecifierRows.filter(row => (
    row.from === inventoryPath && row.specifier === 'typescript' && row.resolvedOrBuiltin === 'package:typescript'
  ));

  assert.equal(
    closure.sourceClosureRows.some(row => row.path === inventoryPath),
    true,
    'the real inventory root must remain in the admitted source closure',
  );
  assert.equal(
    inventoryExternalSpecifiers.length >= 1,
    true,
    'literal dynamic/type imports must remain represented as admitted external closure rows',
  );
  assert.equal(probeBatches.length > 0, true, 'a minted admission context must own guarded discovery');
});

test('SDS-AC-3 fails closed instead of omitting a nonliteral dynamic import', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const sourceText = [
    "import type { TerminalResourceKey } from './TerminalResourcePolicy.js';",
    "const requestedModule = './dynamic-child.js';",
    'await import(requestedModule);',
  ].join('\n');

  assert.equal(typeof parseAdmittedImportSpecifiers, 'function');
  assert.throws(
    () => parseAdmittedImportSpecifiers({ sourceText, fromPath: inventoryPath }),
    /nonliteral|dynamic|unsupported|admitted|capture/i,
  );
});

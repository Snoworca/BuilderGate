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

test('SDS-AC-1 keeps protected ingress private and rejects every caller authority before filesystem or probe work', async () => {
  const collector = await loadCollector();
  const cases = [
    ['filesystem', { fs: noFilesystemAccess() }],
    ['no-op admission', { admission: Object.freeze({}) }],
    ['counterfeit admission', { admission: Object.freeze({ token: 'module-minted' }) }],
    ['caller reparse guard', { reparseGuard: counterfeitIngress([]).reparseGuard }],
    ['caller snapshot', { snapshot: counterfeitIngress([]).snapshot }],
  ];

  for (const [label, suppliedAuthority] of cases) {
    const probeCalls = [];
    const counterfeit = counterfeitIngress(probeCalls);
    for (const protectedName of ['collectSourceClosure', 'hashConfigLockFile', 'readProtectedInput']) {
      assert.equal(Object.hasOwn(collector, protectedName), false, `${protectedName} must not expose a caller-controlled protected ingress`);
    }
    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath: `${workspaceRoot}/docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3/admission-${label}.json`,
        phase: `admission-${label}`,
        ...suppliedAuthority,
        reparseGuard: suppliedAuthority.reparseGuard ?? counterfeit.reparseGuard,
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
      `${label} authority must be rejected before native protected ingress work`,
    );
    assert.deepEqual(probeCalls, [], `${label} context must not invoke a caller-supplied guard, snapshot, or probe`);
    if (suppliedAuthority.fs) assert.deepEqual(suppliedAuthority.fs.calls, [], `${label} context must perform zero caller filesystem operations`);
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

test('SDS-AC-3 collector-owned lexical parsing retains TerminalResourcePolicyInventory literal dynamic and type imports', async () => {
  const {
    parseAdmittedImportSpecifiers,
  } = await loadCollector();
  const inventoryText = readFileSync(inventoryPath, 'utf8');

  assert.match(inventoryText, /await\s+import\(\s*['"]typescript['"]\s*\)/, 'the real inventory must retain its literal dynamic import fixture');
  assert.match(inventoryText, /(?:typeof\s+)?import\(\s*['"]typescript['"]\s*\)\./, 'the real inventory must retain its literal type-import fixture');
  assert.equal(typeof parseAdmittedImportSpecifiers, 'function');
  assert.equal(
    parseAdmittedImportSpecifiers({ sourceText: inventoryText, fromPath: inventoryPath }).includes('typescript'),
    true,
    'the admitted parser must retain literal dynamic/type import specifiers from the real inventory source',
  );

});

test('SDS-AC-3 fails closed instead of omitting a nonliteral dynamic import', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const sourceText = [
    "import type { TerminalResourceKey } from './TerminalResourcePolicy.js';",
    "let requestedModule = './dynamic-child.js';",
    'await import(requestedModule);',
  ].join('\n');

  assert.equal(typeof parseAdmittedImportSpecifiers, 'function');
  assert.throws(
    () => parseAdmittedImportSpecifiers({ sourceText, fromPath: inventoryPath }),
    /nonliteral|dynamic|unsupported|admitted|capture/i,
  );
});

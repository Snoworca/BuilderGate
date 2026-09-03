import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const parserFromPath = 'server/src/ws/WsRouter.ts';
const canarySourcePath = 'server/src/services/TerminalResourcePolicyCanary.test.ts';
const analysisRoot = path.win32.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function ownedManifestPath(prefix) {
  return path.win32.join(analysisRoot, `${prefix}-${process.pid}-${randomBytes(8).toString('hex')}.json`);
}

function removeOwnedManifest(manifestPath, prefix) {
  assert.equal(path.win32.dirname(manifestPath), analysisRoot, 'cleanup must remain in the frozen-capture analysis directory');
  assert.equal(path.win32.basename(manifestPath).startsWith(`${prefix}-`), true, 'cleanup must target only this test-owned manifest leaf');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

test('SDS-AC-2 treats explicit zero-edge forms separately from contained literal edges', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const sourceText = [
    "import './side-effect.js';",
    "import { scheduler } from './scheduler.js';",
    "export { scheduler } from './reexport.js';",
    "export type { Scheduler } from './type-reexport.js';",
    "const MODULE_PATH: string = './literal-const.js';",
    'void import.meta.url;',
    'export { MODULE_PATH };',
    'export default MODULE_PATH;',
    'export default function localDefault() {}',
    'export type LocalOnly = { path: typeof MODULE_PATH };',
    "type TypeOnlyQuery = import('./type-query.js').Scheduler;",
    'await import(MODULE_PATH);',
  ].join('\n');

  assert.deepEqual(
    parseAdmittedImportSpecifiers({ sourceText, fromPath: parserFromPath }).sort(),
    [
      './literal-const.js',
      './reexport.js',
      './scheduler.js',
      './side-effect.js',
      './type-reexport.js',
    ].sort(),
    'zero-edge import.meta/local-export/default/type-query syntax must not become a closure edge, while literal static/reexport and proved literal-const imports must remain edges',
  );
});

test('SDS-AC-2 admits every frozen runtime import(identifier) edge without source rewrite', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const expectedOccurrences = [
    {
      path: 'server/src/ws/FairTerminalDeliveryScheduler.test.ts',
      specifier: './wsSendPolicy.js',
      occurrences: 2,
      dynamicOccurrences: 1,
    },
    {
      path: 'server/src/ws/WsRouterSendPriority.test.ts',
      specifier: '../services/TerminalResourcePolicyCanary.js',
      occurrences: 2,
      dynamicOccurrences: 1,
    },
    {
      path: canarySourcePath,
      specifier: './TerminalResourcePolicyCanary.js',
      occurrences: 15,
      dynamicOccurrences: 15,
    },
  ];

  let dynamicEdges = 0;
  for (const expected of expectedOccurrences) {
    const sourceText = readFileSync(expected.path, 'utf8');
    const parsed = parseAdmittedImportSpecifiers({ sourceText, fromPath: expected.path });
    assert.equal(
      parsed.filter(specifier => specifier === expected.specifier).length,
      expected.occurrences,
      `${expected.path} must retain every literal static and proved dynamic occurrence of ${expected.specifier}`,
    );
    dynamicEdges += expected.dynamicOccurrences;
  }
  assert.equal(dynamicEdges, 17, 'the frozen roots contain exactly seventeen committee-approved runtime import(identifier) edges');
});

test('SDS-AC-3 fails closed for dynamic resolution outside the single immutable literal-const proof', async () => {
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const unsupported = [
    ['import.meta.resolve', "import.meta.resolve('./child.js');"],
    ['unbound identifier', 'await import(modulePath);'],
    ['use before declaration', "await import(modulePath); const modulePath = './child.js';"],
    ['mutable let binding', "let modulePath = './child.js'; await import(modulePath);"],
    ['reassigned const binding', "const modulePath = './child.js'; modulePath = './other.js'; await import(modulePath);"],
    ['redeclared binding', "const modulePath = './child.js'; const modulePath = './other.js'; await import(modulePath);"],
    ['shadowed binding', "const modulePath = './outer.js'; { const modulePath = './inner.js'; await import(modulePath); }"],
    ['escaped literal binding', "const modulePath = './child\\x2ejs'; await import(modulePath);"],
    ['template argument', 'await import(`./child.js`);'],
    ['concatenated argument', "await import('./' + 'child.js');"],
    ['call argument', "await import(resolve('./child.js'));"],
    ['conditional argument', "const modulePath = './child.js'; await import(flag ? modulePath : './other.js');"],
    ['options argument', "const modulePath = './child.js'; await import(modulePath, { with: { type: 'json' } });"],
    ['destructured binding', "const { modulePath } = { modulePath: './child.js' }; await import(modulePath);"],
    ['parameter binding', "async function load(modulePath) { return import(modulePath); }"],
  ];

  for (const [label, sourceText] of unsupported) {
    assert.throws(
      () => parseAdmittedImportSpecifiers({ sourceText, fromPath: parserFromPath }),
      /unsupported|nonliteral|dynamic|lexical|import|export|ambiguous|mutable|scope/i,
      `${label} must abort capture instead of being silently omitted or evaluated`,
    );
  }
});

test('SDS-AC-1 and SDS-AC-4 retain private native capture, fixed Git, and a complete default frozen closure', async () => {
  const collector = await loadCollector();
  for (const protectedName of [
    'createProtectedInputSnapshot',
    'createStrictAdmissionContext',
    'readProtectedInput',
    'hashConfigLockFile',
    'collectSourceClosure',
    'writeCapturedManifest',
  ]) {
    assert.equal(Object.hasOwn(collector, protectedName), false, `${protectedName} must remain private to native capture`);
  }

  const prefix = 'lexical-default-capture';
  const manifestPath = ownedManifestPath(prefix);
  try {
    const manifest = collector.captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: 'lexical-default-capture',
    });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'native capture must persist its canonical default manifest');
    assert.equal(
      manifest.protectedInput.value.sourceClosureRows.some(row => row.path === canarySourcePath),
      true,
      'default frozen capture must include the source containing fourteen proved dynamic edges',
    );
    assert.equal(
      manifest.protectedInput.value.git.commandPrefix[0],
      'C:/Program Files/Git/cmd/git.exe',
      'the default capture must retain its fixed Git provenance executable',
    );
  } finally {
    removeOwnedManifest(manifestPath, prefix);
  }
});

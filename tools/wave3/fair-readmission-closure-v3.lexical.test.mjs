import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedAnalysisLeaf } from './admission-fixture-ownership.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parserFromPath = 'server/src/ws/WsRouter.ts';
const canarySourcePath = 'server/src/services/TerminalResourcePolicyCanary.test.ts';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

test('PERF-BGSTAB-011 runtime identifier oracle distinguishes static and dynamic edges with equal specifier totals', async () => {
  const { observeRuntimeIdentifierImports } = await import('./runtime-import-observation.mjs');
  const { parseAdmittedImportSpecifiers } = await loadCollector();
  const staticText = "const MODULE = './same.js'; import './same.js';";
  const dynamicText = "const MODULE = './same.js'; await import(MODULE);";
  assert.deepEqual(parseAdmittedImportSpecifiers({ sourceText: staticText, fromPath: parserFromPath }), ['./same.js']);
  assert.deepEqual(parseAdmittedImportSpecifiers({ sourceText: dynamicText, fromPath: parserFromPath }), ['./same.js']);
  assert.deepEqual(observeRuntimeIdentifierImports({ sourceText: staticText, fromPath: parserFromPath }), []);
  assert.deepEqual(observeRuntimeIdentifierImports({ sourceText: dynamicText, fromPath: parserFromPath }), [
    { binding: 'MODULE', offset: dynamicText.indexOf('import(MODULE)') },
  ]);
  // Reverse replacement must likewise remove the runtime row, despite equal totals.
  const reversed = dynamicText.replace('await import(MODULE)', "import './same.js'");
  assert.deepEqual(observeRuntimeIdentifierImports({ sourceText: reversed, fromPath: parserFromPath }), []);
});

test('PERF-BGSTAB-011 runtime identifier oracle preserves duplicate occurrences and observes removal with unique offsets', async () => {
  const { observeRuntimeIdentifierImports } = await import('./runtime-import-observation.mjs');
  const sourceText = "const MODULE = './same.js';\nawait import(MODULE);\nawait import(MODULE);";
  const rows = observeRuntimeIdentifierImports({ sourceText, fromPath: parserFromPath });
  assert.deepEqual(rows, [
    { binding: 'MODULE', offset: sourceText.indexOf('import(MODULE)') },
    { binding: 'MODULE', offset: sourceText.lastIndexOf('import(MODULE)') },
  ]);
  assert.equal(new Set(rows.map(row => row.offset)).size, 2);
  const removed = sourceText.slice(0, sourceText.lastIndexOf('\n'));
  assert.deepEqual(observeRuntimeIdentifierImports({ sourceText: removed, fromPath: parserFromPath }), [rows[0]]);
});

test('PERF-BGSTAB-011 runtime identifier oracle excludes comments strings type queries literal imports and nonidentifier calls', async () => {
  const { observeRuntimeIdentifierImports } = await import('./runtime-import-observation.mjs');
  const sourceText = [
    "// await import(COMMENT);",
    "/* import(BLOCK) */",
    "const text = 'import(STRING)';",
    'const template = `import(TEMPLATE)`;',
    "type Query = import('./type.js').Value;",
    'type IdentifierQuery = import(TYPE_ONLY).Value;',
    "import './static.js';",
    "export { value } from './reexport.js';",
    "await import('./literal.js');",
    'await import(`./template.js`);',
    "await import('./' + name);",
    'await import(resolve(name));',
    'await import(MODULE, options);',
    'loader.import(METHOD);',
    'void import.meta.url;',
    'await import(ACTUAL);',
  ].join('\n');
  assert.deepEqual(observeRuntimeIdentifierImports({ sourceText, fromPath: parserFromPath }), [
    { binding: 'ACTUAL', offset: sourceText.indexOf('import(ACTUAL)') },
  ]);
});

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
  const { observeRuntimeIdentifierImports } = await import('./runtime-import-observation.mjs');
  const expectedOccurrences = [
    {
      path: 'server/src/ws/FairTerminalDeliveryScheduler.test.ts',
      specifier: './wsSendPolicy.js',
      occurrences: 2,
      dynamicOccurrences: 1,
      binding: 'modulePath',
    },
    {
      path: 'server/src/ws/WsRouterSendPriority.test.ts',
      specifier: '../services/TerminalResourcePolicyCanary.js',
      occurrences: 2,
      dynamicOccurrences: 1,
      binding: 'canaryModulePath',
    },
    {
      path: canarySourcePath,
      specifier: './TerminalResourcePolicyCanary.js',
      occurrences: 15,
      dynamicOccurrences: 15,
      binding: 'CANARY_MODULE_PATH',
    },
  ];

  let dynamicEdges = 0;
  for (const expected of expectedOccurrences) {
    const sourceText = readFileSync(path.join(workspaceRoot, expected.path), 'utf8');
    const parsed = parseAdmittedImportSpecifiers({ sourceText, fromPath: expected.path });
    assert.equal(
      parsed.filter(specifier => specifier === expected.specifier).length,
      expected.occurrences,
      `${expected.path} must retain every literal static and proved dynamic occurrence of ${expected.specifier}`,
    );
    const observed = observeRuntimeIdentifierImports({ sourceText, fromPath: expected.path });
    assert.deepEqual(observed.map(row => row.binding), Array(expected.dynamicOccurrences).fill(expected.binding),
      `${expected.path} must preserve the actual runtime identifier-import multiset`);
    assert.equal(new Set(observed.map(row => row.offset)).size, observed.length,
      'each repeated import must retain its distinct source occurrence');
    dynamicEdges += observed.length;
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

  const leaf = createOwnedAnalysisLeaf('lexical-default-capture');
  const { manifestPath } = leaf;
  let priorFailure;
  try {
    const manifest = leaf.capture('lexical-default-capture');
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'native capture must persist its canonical default manifest');
    assert.equal(
      manifest.protectedInput.value.sourceClosureRows.some(row => row.path === canarySourcePath),
      true,
      'default frozen capture must include the source containing the proved dynamic import edges',
    );
    assert.equal(
      manifest.protectedInput.value.git.commandPrefix[0],
      'C:/Program Files/Git/cmd/git.exe',
      'the default capture must retain its fixed Git provenance executable',
    );
  } catch (error) { priorFailure = { error }; } finally {
    leaf.cleanup(priorFailure);
  }
});

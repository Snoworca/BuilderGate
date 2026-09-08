import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { parseAdmittedImportSpecifiers } from './fair-readmission-closure-v3.mjs';
const require = createRequire(import.meta.url), ts = require('../../server/node_modules/typescript/lib/typescript.js');
const virtualRoot = 'C:\\virtual-checkout', foreignCwd = 'C:\\unrelated-cwd';
function all(node, predicate) { const result = []; function visit(n) { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); } visit(node); return result; }
function executeReadSite(suite, variable, relativePath, expected) {
  const url = new URL(`./fair-readmission-closure-v3.${suite}.test.mjs`, import.meta.url);
  const ast = ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const candidates = all(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === variable
    && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'readFileSync');
  assert.equal(candidates.length, 1, 'select exactly the current real source read');
  let readScope = candidates[0].parent;
  while (readScope && !ts.isBlock(readScope)) readScope = readScope.parent;
  const parsers = all(readScope, n => ts.isCallExpression(n) && n.expression.getText(ast) === 'parseAdmittedImportSpecifiers'
    && ts.isObjectLiteralExpression(n.arguments[0]) && n.arguments[0].properties.some(property =>
      (ts.isPropertyAssignment(property) && property.name.getText(ast) === 'sourceText' && property.initializer.getText(ast) === variable)
      || (ts.isShorthandPropertyAssignment(property) && property.name.text === 'sourceText' && variable === 'sourceText')));
  assert.equal(parsers.length, 1, 'retain the actual parser call and its fromPath expression');
  const rootDeclaration = all(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'workspaceRoot')[0];
  const transform = expression => {
    const result = ts.transform(expression, [context => node => {
      function visit(n) {
        if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url') return ts.factory.createStringLiteral(`file:///C:/virtual-checkout/tools/wave3/fair-readmission-closure-v3.${suite}.test.mjs`);
        return ts.visitEachChild(n, visit, context);
      }
      return ts.visitNode(node, visit);
    }]);
    return ts.createPrinter().printNode(ts.EmitHint.Expression, result.transformed[0], ast);
  };
  const text = "const MODULE = './child.js'; await import(MODULE);";
  const reads = [], parses = [];
  const run = new Function('path', 'fileURLToPath', 'process', 'readFileSync', 'parseAdmittedImportSpecifiers', 'expected', 'inventoryPath',
    `${rootDeclaration ? `const workspaceRoot = ${transform(rootDeclaration.initializer)};` : ''} const ${variable} = ${transform(candidates[0].initializer)}; return ${transform(parsers[0])};`);
  const result = run(path.win32, fileURLToPath, { cwd: () => foreignCwd }, (requested, encoding) => {
    reads.push(requested); assert.equal(encoding, 'utf8');
    assert.equal(path.win32.isAbsolute(requested), true, 'actual read must not resolve against foreign process.cwd');
    assert.equal(path.win32.normalize(requested), path.win32.join(virtualRoot, relativePath));
    return text;
  }, input => {
    parses.push(input); assert.equal(input.fromPath, relativePath); assert.equal(path.win32.isAbsolute(input.fromPath), false);
    return parseAdmittedImportSpecifiers(input);
  }, expected, relativePath);
  assert.equal(reads.length, 1); assert.equal(parses.length, 1); assert.deepEqual(result, ['./child.js']);
}
test('AC5 lexical actual source reads use module checkout while parser paths remain relative under foreign cwd', () => {
  for (const relativePath of ['server/src/ws/FairTerminalDeliveryScheduler.test.ts', 'server/src/ws/WsRouterSendPriority.test.ts', 'server/src/services/TerminalResourcePolicyCanary.test.ts']) executeReadSite('lexical', 'sourceText', relativePath, { path: relativePath });
});
test('AC5 trust actual Inventory source read is module-bound without changing parser identity', () => executeReadSite('trust', 'inventorySource', 'server/src/services/TerminalResourcePolicyInventory.ts'));
test('AC5 admission actual Inventory source read is module-bound without changing parser identity', () => executeReadSite('admission', 'inventoryText', 'server/src/services/TerminalResourcePolicyInventory.ts'));

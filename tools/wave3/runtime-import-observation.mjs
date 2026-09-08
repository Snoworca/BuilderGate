import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');

// Test-only syntax observation. Binding safety and resolution remain the
// production collector's responsibility; this does not admit an import.
export function observeRuntimeIdentifierImports({ sourceText, fromPath }) {
  const source = ts.createSourceFile(fromPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rows = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isIdentifier(node.arguments[0])) {
      rows.push({ binding: node.arguments[0].text, offset: node.getStart(source) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return rows;
}

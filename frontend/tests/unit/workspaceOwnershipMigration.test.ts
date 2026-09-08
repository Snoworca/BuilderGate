import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// REL-BGSTAB-001 / B2: bounded call-site inventory supplements actual core,
// tracker and prefix-cleanup behavior tests; this is not browser completion.
const directory = new URL('../e2e/', import.meta.url);
const mockOnly = new Set(['auth-bootstrap.spec.ts', 'settings-password-policy.spec.ts', 'settings-resource-limits.spec.ts']);
const knownCreators = new Set([
  'busy-agent-workspace-bounce.spec.ts', 'grid-equal-mode.spec.ts', 'terminal-authority.spec.ts',
  'terminal-keyboard-regression.spec.ts', 'terminal-korean-ime.spec.ts', 'terminal-mobile-scroll.spec.ts',
  'terminal-title-auto-tab-name.spec.ts', 'terminal-clipboard.spec.ts', 'header-context-menu-regression.spec.ts',
  'terminal-shortcut-manager.spec.ts', 'wave1-retained-state-characterization.spec.ts',
  'wave3-terminal-authority-promotion.spec.ts', 'wave3-terminal-authority-fairness.spec.ts',
  'workspace-ownership-validation.spec.ts',
]);
const files = readdirSync(directory).filter(name => name.endsWith('.spec.ts')).sort();
function read(name: string) {
  const url = new URL(name, directory);
  return ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node); ts.forEachChild(node, child => { walk(child, visit); });
}
function pathShape(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => '{}' + span.literal.text).join('');
  return undefined;
}
function hasOwnedTestImport(ast: ts.SourceFile): boolean {
  return ast.statements.some(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && /\/workspaceOwnershipFixture(?:\.ts)?$/.test(node.moduleSpecifier.text)
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(item => (item.propertyName ?? item.name).text === 'test'));
}
function calls(ast: ts.SourceFile) {
  // Independently reviewed B2 quota observation only. Any initializer change
  // requires a new review; the forwarded requests still appear in inventory.
  let observedProxy: ts.NewExpression | undefined;
  if (ast.fileName.split(/[\\/]/).at(-1) === 'workspace-ownership-validation.spec.ts') {
    const declarations: ts.VariableDeclaration[] = [];
    walk(ast, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'quotaRequest') declarations.push(node);
    });
    const initializer = declarations.length === 1 ? declarations[0].initializer : undefined;
    if (initializer && ts.isNewExpression(initializer)) {
      const printed = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
        .printNode(ts.EmitHint.Expression, initializer, ast);
      if (createHash('sha256').update(printed).digest('hex') === '1d0a9cfb713b52aa08c839d4084b878c38217dbbf8b56d940d1e69b23675afae') {
        observedProxy = initializer;
      }
    }
  }
  const rows: Array<{ line: number; method: string; path?: string; callee: string; kind: string; directApiMethod: boolean }> = [];
  walk(ast, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression.getText(ast);
    let method: string | undefined;
    const options = node.arguments[1];
    if (options && ts.isObjectLiteralExpression(options)) {
      const property = options.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(ast).replace(/['"]/g, '') === 'method');
      if (property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) method = property.initializer.text.toUpperCase();
    }
    const member = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
      : ts.isElementAccessExpression(node.expression) && ts.isStringLiteralLike(node.expression.argumentExpression)
        ? node.expression.argumentExpression.text : undefined;
    const directApiMethod = member === 'post' || member === 'delete';
    if (directApiMethod) method = member.toUpperCase();
    if (method !== 'POST' && method !== 'DELETE') return;
    let shape = pathShape(node.arguments[0]);
    const argument = node.arguments[0];
    // Existing promotion debug request uses a local const endpoint = new URL(...).
    // Resolve that bounded syntax; unknown/dynamic mutations still require review.
    if (shape === undefined && argument && ts.isIdentifier(argument)) {
      let scope: ts.Node = node;
      while (scope.parent && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
      const declarations: ts.VariableDeclaration[] = [];
      walk(scope, candidate => {
        if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name)
          && candidate.name.text === argument.text && candidate.pos < node.pos) declarations.push(candidate);
      });
      const initializer = declarations.length === 1 ? declarations[0].initializer : undefined;
      if (initializer && ts.isNewExpression(initializer) && initializer.expression.getText(ast) === 'URL') {
        shape = pathShape(initializer.arguments?.[0]);
      }
    }
    const url = shape?.split('?')[0];
    let knownCollection = false;
    if (shape === undefined && member === 'delete'
      && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const receiver = node.expression.expression;
      const name = ts.isIdentifier(receiver) ? receiver.text
        : ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword ? receiver.name.text : undefined;
      // Classify the existing Map/Set/WeakMap removals, not all unknown .delete calls.
      const collections: ts.Node[] = [];
      walk(ast, candidate => {
        if ((ts.isVariableDeclaration(candidate) || ts.isPropertyDeclaration(candidate))
          && ts.isIdentifier(candidate.name) && candidate.name.text === name
          && candidate.initializer && ts.isNewExpression(candidate.initializer)
          && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(candidate.initializer.expression.getText(ast))) collections.push(candidate);
      });
      knownCollection = collections.length === 1;
    }
    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor && ancestor !== observedProxy) ancestor = ancestor.parent;
    const observedForward = observedProxy !== undefined && ancestor === observedProxy
      && (callee === 'target.post' || callee === 'target.delete') && node.arguments.length === 1
      && ts.isSpreadElement(node.arguments[0]) && ts.isIdentifier(node.arguments[0].expression)
      && node.arguments[0].expression.text === 'args';
    const kind = observedForward ? 'observed-api-forward'
      : url?.endsWith('/api/workspaces') ? 'workspace-create'
      : /\/api\/workspaces\/[^/]+$/.test(url ?? '') ? 'workspace-delete'
        : /\/api\/workspaces\/[^/]+\/tabs(?:\/|$)/.test(url ?? '') ? 'tab-operation'
          : url?.includes('/api/sessions/') ? 'session-or-debug-operation'
            : knownCollection ? 'collection-delete'
              : shape === undefined ? 'dynamic-path-needs-review' : 'other-api-or-nonworkspace-call';
    rows.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, method, path: shape, callee, kind, directApiMethod });
  });
  return rows;
}

test('B2 scanner finds direct, aliased, nested and literal-computed workspace API methods', () => {
  const ast = ts.createSourceFile('scanner-fixture.ts', `
    request.post('/api/workspaces'); request.delete('/api/workspaces/one');
    const api = request; api.post('/api/workspaces'); api.delete('/api/workspaces/two');
    page.request.post('/api/workspaces'); page.request.delete('/api/workspaces/three');
    api['post']('/api/workspaces'); api['delete']('/api/workspaces/four');
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(calls(ast).map(row => [row.method, row.kind]), Array.from({ length: 4 }, () => [
    ['POST', 'workspace-create'], ['DELETE', 'workspace-delete'],
  ]).flat());
});

test('B2 scanner retains unresolved direct API mutations as explicit review entries', () => {
  const ast = ts.createSourceFile('scanner-dynamic.ts', `
    request.post(target); api.delete(otherTarget); api['post'](dynamicUrl);
  `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(calls(ast).map(row => [row.method, row.kind]), [
    ['POST', 'dynamic-path-needs-review'], ['DELETE', 'dynamic-path-needs-review'], ['POST', 'dynamic-path-needs-review'],
  ]);
});

// The reviewed quota observer is an exact adapter forwarding site, not an
// exemption for a file or a receiver name. Exercise the real initializer and
// nearby adversarial variants without evaluating any browser/API code.
function quotaObserverSource(): string {
  const ast = read('workspace-ownership-validation.spec.ts');
  const declarations: ts.VariableDeclaration[] = [];
  walk(ast, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'quotaRequest') declarations.push(node);
  });
  assert.equal(declarations.length, 1);
  assert.ok(declarations[0].initializer && ts.isNewExpression(declarations[0].initializer));
  return `const ${declarations[0].getText(ast)};`;
}
function observerRows(source: string, filename = 'workspace-ownership-validation.spec.ts') {
  return calls(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}
test('B2 scanner records the exact reviewed quota observer forwarders explicitly', () => {
  const rows = calls(read('workspace-ownership-validation.spec.ts')).filter(row => row.callee === 'target.post' || row.callee === 'target.delete');
  assert.deepEqual(rows.map(row => [row.callee, row.kind]), [
    ['target.post', 'observed-api-forward'], ['target.delete', 'observed-api-forward'],
  ]);
});
test('B2 scanner does not exempt identical receiver calls outside the reviewed Proxy', () => {
  const rows = observerRows(`${quotaObserverSource()}\ntarget.post(...args); target.delete(...args);`);
  assert.deepEqual(rows.slice(-2).map(row => row.kind), ['dynamic-path-needs-review', 'dynamic-path-needs-review']);
});
test('B2 scanner does not transfer the reviewed Proxy exemption to another file', () => {
  assert.deepEqual(observerRows(quotaObserverSource(), 'other.spec.ts').map(row => row.kind),
    ['dynamic-path-needs-review', 'dynamic-path-needs-review']);
});
test('B2 scanner requires review again when the quota Proxy body changes', () => {
  const original = quotaObserverSource();
  const changed = original.replace('quotaStatus = response.status()', 'quotaStatus = 409');
  assert.notEqual(changed, original);
  assert.deepEqual(observerRows(changed).map(row => row.kind), ['dynamic-path-needs-review', 'dynamic-path-needs-review']);
});
test('B2 scanner rejects renamed observers and altered forwarding arguments', () => {
  const original = quotaObserverSource();
  for (const changed of [original.replace('const quotaRequest', 'const unrelatedRequest'),
    original.replace('target.post(...args)', "target.post('/api/workspaces')")]) {
    assert.notEqual(changed, original);
    const rows = observerRows(changed);
    assert.equal(rows.some(row => row.kind === 'observed-api-forward'), false);
    assert.ok(rows.some(row => row.kind === 'dynamic-path-needs-review' || row.kind === 'workspace-create'));
  }
});

for (const name of files) {
  test(`B2 source inventory preserves owned workspace mutation boundaries: ${name}`, t => {
    const ast = read(name); const inventory = calls(ast);
    t.diagnostic(JSON.stringify({ file: name, calls: inventory }));
    if (mockOnly.has(name)) {
      assert.equal(hasOwnedTestImport(ast), false, 'mock-only contexts must not register synthetic workspace IDs');
      return;
    }
    if (name === 'perf-bgstab-010-ac6-server-ack-fault.spec.ts' || name === 'perf-bgstab-010-ac9-isolated.spec.ts') {
      assert.deepEqual(inventory.filter(row => row.kind === 'workspace-create' || row.kind === 'workspace-delete'), [],
        'the existing mutation-denial/topology-only probes do not establish workspace creation ownership');
    }
    assert.deepEqual(inventory.filter(row => row.method === 'DELETE' && row.kind === 'workspace-delete'), [],
      'live workspace DELETE must delegate to the owner-checked single-ID helper');
    if (knownCreators.has(name) || inventory.some(row => row.method === 'POST' && row.kind === 'workspace-create')) {
      assert.equal(hasOwnedTestImport(ast), true, 'live page creators must use the owned Playwright fixture');
    }
    assert.deepEqual(inventory.filter(row => row.kind === 'dynamic-path-needs-review'), [],
      'new dynamic mutation paths require explicit classification, not a silent scan exemption');
    assert.deepEqual(inventory.filter(row => row.method === 'POST' && row.kind === 'workspace-create' && row.directApiMethod), [],
      'APIRequestContext creation bypasses browser response events and must use createOwnedWorkspaceViaApi');
    const unownedContexts: string[] = [];
    walk(ast, node => {
      if (ts.isCallExpression(node) && /\.newContext$/.test(node.expression.getText(ast))) unownedContexts.push(node.getText(ast));
    });
    assert.deepEqual(unownedContexts, [], 'new independent contexts need a reviewed ownership attachment path; current peers use context.newPage');
  });
}

test('B2 quota handling cannot retain prefix eviction or unowned shortcut reset loops', () => {
  const unsafe: string[] = [];
  for (const name of files.filter(file => !mockOnly.has(file))) {
    const ast = read(name);
    walk(ast, node => {
      if (!ts.isForStatement(node) && !ts.isWhileStatement(node) && !ts.isDoStatement(node)) return;
      const text = node.getText(ast);
      if (/\b409\b/.test(text) && /startsWith\(|isEvictableTestWorkspace|oldWorkspace|staleWorkspace|evictCandidate|terminal-shortcuts\/reset/.test(text)) {
        unsafe.push(`${name}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
      }
    });
  }
  assert.deepEqual(unsafe, [], 'removing DELETE alone must not retain preceding unowned workspace reset mutations');
});

test('B2 actual busy-bounce setup preserves an unowned test-looking workspace', async () => {
  const ast = read('busy-agent-workspace-bounce.spec.ts');
  const callbacks: ts.ArrowFunction[] = [];
  walk(ast, node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'test.beforeEach') {
      assert.ok(node.arguments[0] && ts.isArrowFunction(node.arguments[0])); callbacks.push(node.arguments[0]);
    }
  });
  assert.equal(callbacks.length, 1, 'execute the actual unique setup callback');
  const cleanup = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'deleteTestWorkspaces');
  const prefix = ast.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(ast) === 'TEST_WORKSPACE_PREFIXES');
  const compiled = ts.transpileModule(`${prefix ? `const ${prefix.getText(ast)};` : ''}\n${cleanup?.getText(ast) ?? ''}\nconst setup = ${callbacks[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deletes: string[] = []; let logins = 0;
  const dependencies = {
    test: { skip: (skip: boolean) => assert.equal(skip, false) },
    captureServerFrames: async () => {}, login: async () => { logins += 1; }, waitForTerminal: async () => {},
    localStorage: { getItem: (key: string) => key === 'active_workspace_id' ? 'user-current' : 'fake-token' },
    fetch: async (url: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') { deletes.push(url); return new Response(null, { status: 204 }); }
      assert.equal(url, '/api/workspaces');
      return Response.json({ workspaces: [{ id: 'user-current', name: 'Main' }, { id: 'user-saved', name: 'BusyAgent-USER-SAVED' }] });
    },
  };
  const setup = new Function(...Object.keys(dependencies), `${compiled}\nreturn setup;`)(...Object.values(dependencies));
  await setup({ page: { evaluate: (callback: (value: unknown) => unknown, value: unknown) => callback(value) } }, { project: { name: 'Desktop Chrome' } });
  assert.equal(logins, 1, 'actual setup executes before the mutation assertion');
  assert.deepEqual(deletes, [], 'a test-looking name from GET is not a successful creation proof');
});

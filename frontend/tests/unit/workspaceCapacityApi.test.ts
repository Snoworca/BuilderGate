import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const url = new URL('../../src/services/api.ts', import.meta.url);
const source = readFileSync(url, 'utf8');
const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const loaders: ts.ArrowFunction[] = [];
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'workspaceApi') {
    assert.ok(node.initializer && ts.isObjectLiteralExpression(node.initializer));
    for (const property of node.initializer.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText(ast) === 'getAll') {
        assert.ok(ts.isArrowFunction(property.initializer));
        loaders.push(property.initializer);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(loaders.length, 1, 'execute the uniquely declared production workspaceApi.getAll');
const compiled = ts.transpileModule(`const getAll = ${loaders[0].getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(body: unknown, status = 200) {
  const warnings: unknown[][] = [];
  const requests: unknown[][] = [];
  let jsonCalls = 0;
  const httpError = new Error(`HTTP ${status}`);
  const response = { ok: status < 400, status, async json() { jsonCalls += 1; return body; } };
  const dependencies = {
    API_BASE: '/api',
    getAuthHeaders: () => ({ Authorization: 'Bearer test-only-token' }),
    authFetch: async (...args: unknown[]) => { requests.push(args); return response; },
    parseError: async (value: unknown) => { assert.equal(value, response); return httpError; },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
  };
  const getAll = new Function(...Object.keys(dependencies), `${compiled}\nreturn getAll;`)(...Object.values(dependencies)) as () => Promise<unknown>;
  return { getAll, requests, warnings, httpError, jsonCalls: () => jsonCalls };
}

test('FR-BGSTAB-026 CAP-03 actual getAll retains authenticated fetch and exact valid capacity values', async () => {
  // #66 added maxTotalSessions to what the server publishes, and these fixtures kept the
  // two-key shape -- so this file was green while the real payload was being rejected and the
  // browser showed an empty sidebar, tab bar and terminal. The fixtures are what the server
  // sends.
  for (const limits of [
    { maxWorkspaces: 3, maxTabsPerWorkspace: 4, maxTotalSessions: 32 },
    { maxWorkspaces: 20, maxTabsPerWorkspace: 12, maxTotalSessions: 8 },
    { maxWorkspaces: 3.5, maxTabsPerWorkspace: 4.5, maxTotalSessions: 4.5 },
    { maxWorkspaces: 1, maxTabsPerWorkspace: 16, maxTotalSessions: 1 },
    { maxWorkspaces: 50, maxTabsPerWorkspace: 1, maxTotalSessions: 128 },
  ]) {
    const body = { workspaces: [{ id: 'existing' }], tabs: [], gridLayouts: [], limits };
    const before = structuredClone(body);
    const h = harness(body);
    assert.deepEqual(await h.getAll(), before);
    assert.deepEqual(body, before, 'validation must not rewrite existing state or fractional limits');
    assert.deepEqual(h.requests, [['/api/workspaces', { headers: { Authorization: 'Bearer test-only-token' } }]]);
    assert.equal(h.jsonCalls(), 1);
    assert.deepEqual(h.warnings, []);
  }
});

test('FR-BGSTAB-026 CAP-03 actual getAll warns once and rejects malformed limits without leaking the response', async () => {
  const valid = { maxWorkspaces: 10, maxTabsPerWorkspace: 8, maxTotalSessions: 32 };
  const malformed: unknown[] = [undefined, null, [], {}, { maxWorkspaces: 10 }, { maxTabsPerWorkspace: 8 },
    // The pre-#66 two-key payload is now the malformed one: a server that stopped sending the
    // session cap would put the browser back to hardcoding it.
    { maxWorkspaces: 10, maxTabsPerWorkspace: 8 },
    // An unknown fourth key still fails, which is what the exact count is for.
    { ...valid, maxSomethingNew: 1 },
    ...['10', null, NaN, Infinity, 0, 51].map(maxWorkspaces => ({ ...valid, maxWorkspaces })),
    ...['8', null, NaN, -Infinity, 0, 17].map(maxTabsPerWorkspace => ({ ...valid, maxTabsPerWorkspace })),
    ...['32', null, NaN, Infinity, 0, 129].map(maxTotalSessions => ({ ...valid, maxTotalSessions })),
  ];
  for (const limits of malformed) {
    const body = { workspaces: [], tabs: [], gridLayouts: [], sensitiveFixture: 'DO_NOT_LOG_RESPONSE',
      ...(limits === undefined ? {} : { limits }) };
    const h = harness(body);
    await assert.rejects(h.getAll(), /invalid-workspace-limits/);
    assert.equal(h.warnings.length, 1, 'one invalid response must produce exactly one targeted warning');
    assert.match(JSON.stringify(h.warnings[0]), /invalid-workspace-limits/);
    assert.doesNotMatch(JSON.stringify(h.warnings[0]), /DO_NOT_LOG_RESPONSE|sensitiveFixture|Bearer test-only-token/);
  }
});

test('FR-BGSTAB-026 CAP-03 HTTP authentication failure keeps the existing parseError path', async () => {
  const h = harness({ limits: null }, 401);
  await assert.rejects(h.getAll(), error => error === h.httpError);
  assert.equal(h.jsonCalls(), 0, 'HTTP failure must not be reported as a limits decoding failure');
  assert.deepEqual(h.warnings, []);
});

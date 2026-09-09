import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('../../node_modules/typescript/lib/typescript.js');
const source = readFileSync(new URL('./FileServiceWrite.test.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('FileServiceWrite.test.ts', source, ts.ScriptTarget.Latest, true);
function loadBridge(withLocalHttpServer) {
  const helpers = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'listenOnEphemeralPort');
  assert.equal(helpers.length, 1);
  const compiled = ts.transpileModule(helpers[0].getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('withLocalHttpServer', `${compiled}; return listenOnEphemeralPort;`)(withLocalHttpServer);
}

test('IR-MDE-001 local HTTP bridge close waits for shared fixture cleanup', async () => {
  let finishCleanup, entered = false, released = false;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const app = { listen() { assert.fail('TCP forbidden'); } };
  const request = async () => ({ statusCode: 200, body: 'ok', headers: {} });
  const helper = loadBridge(async (received, run) => {
    assert.equal(received, app); entered = true;
    await run({ request }); released = true; await cleanup;
  });
  const running = await helper(app);
  assert.equal(entered, true); assert.equal(released, false);
  let closed = false;
  const closing = running.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, true); assert.equal(closed, false);
  } finally { finishCleanup(); await closing; }
  assert.equal(closed, true);
});

test('IR-MDE-001 local HTTP bridge preserves startup and teardown failure identity', async () => {
  const app = { listen() { assert.fail('TCP forbidden'); } };
  const startup = Error('shared fixture startup');
  await assert.rejects(loadBridge(async () => { throw startup; })(app), error => error === startup);
  const teardown = Error('shared fixture teardown');
  const running = await loadBridge(async (_app, run) => {
    await run({ request: async () => ({ statusCode: 200, body: 'ok', headers: {} }) });
    throw teardown;
  })(app);
  await assert.rejects(running.close(), error => error === teardown);
});

test('IR-MDE-001 HTTP fixture does not bind ephemeral or any TCP port', async () => {
  const helpers = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'listenOnEphemeralPort');
  assert.equal(helpers.length, 1, 'actual transport helper must be inspected, never import the HTTP suite');
  const compiled = ts.transpileModule(helpers[0].getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const attempts = [];
  const app = { listen(...args) { attempts.push(args); throw Error('INERT_TCP_BIND_BLOCKED'); } };
  const helper = new Function('withLocalHttpServer', `${compiled}; return listenOnEphemeralPort;`)(async (_app, run) => run({ request() {} }));
  let failure;
  try { const running = await helper(app); await running.close(); } catch (error) { failure = error; }
  assert.deepEqual(attempts, [], 'real fixture tried a TCP listener before a request; transport must reuse owned local HTTP fixture');
  if (failure) throw failure;
});

test('FR-BGSTAB-025 write fixture uses active maxFileSize rather than retired maxCodeFileSize', () => {
  const declarations = ast.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]);
  const config = declarations.find(n => n.name.getText(ast) === 'DEFAULT_FILE_MANAGER_CONFIG');
  assert.ok(config && ts.isObjectLiteralExpression(config.initializer));
  const keys = config.initializer.properties.map(p => p.name?.getText(ast));
  assert.ok(keys.includes('maxFileSize'));
  assert.equal(keys.includes('maxCodeFileSize'), false, 'retired key must not re-enter active typed fixtures');
});

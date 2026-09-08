import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Server, type IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

// REL-BGSTAB-001 / B0: these contracts retain actual Express and HTTP execution
// while forbidding a TCP listener, including ephemeral port zero.
interface LocalHttpFixture {
  server: Server;
  endpoint: string;
  request(input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: string }>;
}
type WithLocalHttpServer = <T>(app: Express, run: (fixture: LocalHttpFixture) => Promise<T>) => Promise<T>;

async function loadHelper(): Promise<WithLocalHttpServer> {
  const source = new URL('./localHttpTestServer.ts', import.meta.url);
  assert.ok(existsSync(source), 'B0 requires the localHttpTestServer helper before transport assertions can run');
  const module = await import(source.href);
  assert.equal(typeof module.withLocalHttpServer, 'function', 'the owned callback fixture must be exported');
  return module.withLocalHttpServer as WithLocalHttpServer;
}

function observeRealPipeListeners(t: TestContext): Array<{ server: Server; endpoint: string }> {
  const listeners: Array<{ server: Server; endpoint: string }> = [];
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    const endpoint = args[0];
    assert.equal(typeof endpoint, 'string', 'B0 must not bind numeric zero, 2222, or another TCP port');
    assert.ok(typeof endpoint === 'string');
    if (process.platform === 'win32') {
      assert.ok(endpoint.startsWith('\\\\.\\pipe\\'), 'use the local Windows pipe namespace');
    } else {
      const withinTemp = relative(tmpdir(), endpoint);
      assert.ok(isAbsolute(endpoint));
      assert.ok(withinTemp.length > 0 && !isAbsolute(withinTemp) && !withinTemp.split(/[\\/]/u).includes('..'),
        'the Unix endpoint must belong to the temporary directory');
    }
    listeners.push({ server: this, endpoint });
    return Reflect.apply(listen, this, args);
  });
  return listeners;
}

async function assertClosed(fixture: LocalHttpFixture | undefined): Promise<void> {
  assert.ok(fixture, 'the callback must have received a live owned fixture');
  assert.equal(fixture.server.listening, false, 'cleanup must await server closure');
  // Node can retain a pipe's address after close. Probe its reachability rather
  // than requiring address() to become null (native control: ENOENT).
  const socket = createConnection({ path: fixture.endpoint });
  const reconnect = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.setTimeout(1000, () => socket.destroy(new Error('Closed endpoint probe timed out')));
  });
  try {
    await assert.rejects(reconnect, (error: unknown) => error instanceof Error
      && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'),
    'the same owned local endpoint must refuse a real reconnection after cleanup');
  } finally { socket.destroy(); }
  if (process.platform !== 'win32') assert.equal(existsSync(fixture.endpoint), false, 'remove the owned Unix endpoint');
}

test('B0 ST-01/ST-03 real Express receives exact JSON bytes and headers over a local endpoint', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  const listeners = observeRealPipeListeners(t);
  const app = express();
  let middlewareCalls = 0;
  const observedBytes: Buffer[] = [];
  app.use(express.json({ verify: (_req, _res, body) => { observedBytes.push(Buffer.from(body)); } }));
  app.use((_req, res, next) => { middlewareCalls += 1; res.setHeader('x-fixture-middleware', 'executed'); next(); });
  app.post('/echo', (req, res) => res.status(201).json({ received: req.body, marker: req.get('x-fixture-marker') }));
  const body = JSON.stringify({ text: '한글🙂', count: 3 });
  let owned: LocalHttpFixture | undefined;
  const sentinel = { returned: true };
  const result = await withLocalHttpServer(app, async fixture => {
    owned = fixture;
    assert.equal(fixture.server.listening, true);
    assert.equal(fixture.server.address(), fixture.endpoint);
    assert.deepEqual(listeners, [{ server: fixture.server, endpoint: fixture.endpoint }]);
    const response = await fixture.request({ method: 'POST', path: '/echo', body, headers: {
      'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body, 'utf8')), 'x-fixture-marker': 'exact-header',
    } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers['x-fixture-middleware'], 'executed');
    assert.equal(response.body, JSON.stringify({ received: JSON.parse(body), marker: 'exact-header' }));
    assert.deepEqual(observedBytes, [Buffer.from(body, 'utf8')]);
    assert.equal(middlewareCalls, 1);
    return sentinel;
  });
  assert.equal(result, sentinel, 'preserve the callback result');
  await assertClosed(owned);
});

test('B0 ST-02 Express error middleware and non-success responses remain observable', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  observeRealPipeListeners(t);
  const app = express();
  const failure = new Error('fixture-route-rejected');
  let errorCalls = 0;
  app.get('/error', (_req, _res, next) => next(failure));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    assert.equal(error, failure);
    errorCalls += 1;
    res.status(422).json({ error: 'route-rejected' });
  });
  let owned: LocalHttpFixture | undefined;
  await withLocalHttpServer(app, async fixture => {
    owned = fixture;
    const response = await fixture.request({ method: 'GET', path: '/error' });
    assert.equal(response.statusCode, 422);
    assert.deepEqual(JSON.parse(response.body), { error: 'route-rejected' });
    assert.equal(errorCalls, 1);
  });
  await assertClosed(owned);
});

test('B0 ST-02 callback assertion failure closes the owned server before rejection', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  observeRealPipeListeners(t);
  const app = express();
  app.get('/', (_req, res) => res.send('ready'));
  const failure = new assert.AssertionError({ message: 'intentional callback assertion' });
  let owned: LocalHttpFixture | undefined;
  await assert.rejects(withLocalHttpServer(app, async fixture => {
    owned = fixture;
    assert.equal((await fixture.request({ method: 'GET', path: '/' })).body, 'ready');
    throw failure;
  }), error => error === failure);
  await assertClosed(owned);
});

test('B0 ST-02 actual request reset rejects and releases its owned server', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  observeRealPipeListeners(t);
  const app = express();
  let resets = 0;
  app.get('/reset', req => { resets += 1; req.socket.destroy(); });
  let owned: LocalHttpFixture | undefined;
  await assert.rejects(withLocalHttpServer(app, async fixture => {
    owned = fixture;
    return fixture.request({ method: 'GET', path: '/reset' });
  }));
  assert.equal(resets, 1, 'the request must reach the real route before failing');
  await assertClosed(owned);
});

test('B0 ST-02 simultaneous local fixtures remain isolated through sibling cleanup', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  const listeners = observeRealPipeListeners(t);
  const firstApp = express();
  const secondApp = express();
  firstApp.get('/', (_req, res) => res.send('first'));
  secondApp.get('/', (_req, res) => res.send('second'));
  let firstOwned: LocalHttpFixture | undefined;
  let secondOwned: LocalHttpFixture | undefined;
  await withLocalHttpServer(firstApp, async first => {
    firstOwned = first;
    await withLocalHttpServer(secondApp, async second => {
      secondOwned = second;
      assert.notEqual(first.endpoint, second.endpoint);
      assert.notEqual(first.server, second.server);
      assert.equal(listeners.length, 2);
      const responses = await Promise.all([
        first.request({ method: 'GET', path: '/' }), second.request({ method: 'GET', path: '/' }),
      ]);
      assert.deepEqual(responses.map(response => response.body), ['first', 'second']);
    });
    await assertClosed(secondOwned);
    assert.equal(first.server.listening, true, 'closing the sibling must not close this server');
    assert.equal((await first.request({ method: 'GET', path: '/' })).body, 'first');
  });
  await assertClosed(firstOwned);
});

test('B0 bind failure is observable without retrying an alternate endpoint or port', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  const failure = new Error('injected local bind failure');
  let attempts = 0;
  let callbackCalls = 0;
  t.mock.method(Server.prototype, 'listen', () => { attempts += 1; throw failure; });
  await assert.rejects(withLocalHttpServer(express(), async () => { callbackCalls += 1; }),
    error => error === failure || (error instanceof Error && error.cause === failure));
  assert.equal(attempts, 1);
  assert.equal(callbackCalls, 0, 'a failed bind must not supply a fabricated live fixture');
});

test('B0 asynchronous bind error rejects without a live fixture or endpoint', { timeout: 5000 }, async t => {
  const withLocalHttpServer = await loadHelper();
  const failure = new Error('injected asynchronous local bind failure');
  let attempts = 0;
  let callbackCalls = 0;
  let ownedServer: Server | undefined;
  let endpoint: string | undefined;
  t.mock.method(Server.prototype, 'listen', function (this: Server, ...args: unknown[]) {
    assert.ok(typeof args[0] === 'string', 'the failed attempt must still target a local endpoint, not TCP');
    attempts += 1;
    ownedServer = this;
    endpoint = args[0];
    process.nextTick(() => this.emit('error', failure));
    return this;
  });
  await assert.rejects(withLocalHttpServer(express(), async () => { callbackCalls += 1; }), error => error === failure);
  assert.equal(attempts, 1, 'an asynchronous bind error must not trigger another endpoint attempt');
  assert.equal(callbackCalls, 0);
  assert.ok(ownedServer);
  assert.equal(ownedServer.listening, false);
  assert.equal(ownedServer.address(), null);
  assert.ok(endpoint);
  if (process.platform !== 'win32') assert.equal(existsSync(endpoint), false);
});

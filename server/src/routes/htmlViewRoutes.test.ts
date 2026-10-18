// SEC-MDE-002 (#141), FR-MDE-028 AC-5, AC-6: the HTML view token route and the token-addressed,
// unauthenticated file route, over real HTTP on a real temporary folder, behind the application's
// own security headers so the route's overrides are what the browser would see.
// Run: cwd=server/, npx tsx --test src/routes/htmlViewRoutes.test.ts
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import express, { type RequestHandler } from 'express';
import { FileService } from '../services/FileService.js';
import { HtmlViewTokenStore } from '../services/HtmlViewTokenStore.js';
import { createHtmlViewRoutes } from './htmlViewRoutes.js';
import { createSecurityHeadersMiddleware } from '../middleware/securityHeaders.js';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';

const SESSION = 'session-html';
const OTHER = 'session-other';
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups';

interface Res { status: number; headers: IncomingHttpHeaders; body: Buffer }

interface Ctx {
  cwd: string;
  outside: string;
  clock: { now: number };
  /** user: the JWT subject, or null for no Authorization at all. */
  send: (method: string, url: string, options?: { body?: unknown; user?: string | null }) => Promise<Res>;
  issue: (filePath: string, user?: string) => Promise<{ token: string; url: string; baseUrl: string }>;
}

async function withApp(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-html-view-')));
  const cwd = path.join(root, 'site');
  const outside = path.join(root, 'outside');
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION || id === OTHER ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };
  const service = new FileService(sessionManager as never, {
    maxFileSize: 1024, maxDirectoryEntries: 100, blockedExtensions: ['.exe'], blockedPaths: ['.ssh'], cwdCacheTtlMs: 1000,
  });
  const clock = { now: 1_000_000 };
  const store = new HtmlViewTokenStore({ now: () => clock.now });
  // A stand-in for the JWT middleware: the subject comes from a test header.
  const auth: RequestHandler = (req, res, next) => {
    const user = req.header('x-test-user');
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      return;
    }
    (req as unknown as { user: { sub: string } }).user = { sub: user };
    next();
  };
  const routes = createHtmlViewRoutes(service, store, { auth });
  const app = express();
  app.use(createSecurityHeadersMiddleware({ enableHSTS: true }));
  app.use(express.json());
  app.use('/api/sessions', auth, routes.sessionRouter);
  app.use('/api/html-view', routes.viewRouter);
  try {
    await withLocalHttpServer(app, async (fixture) => {
      const send: Ctx['send'] = (method, url, options = {}) => new Promise<Res>((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const headers: Record<string, string> = {};
        if (payload !== undefined) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(Buffer.byteLength(payload));
        }
        const user = options.user === undefined ? 'alice' : options.user;
        if (user !== null) headers['x-test-user'] = user;
        const req = request({ socketPath: fixture.endpoint, agent: false, method, path: url, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(payload);
      });
      const issue: Ctx['issue'] = async (filePath, user = 'alice') => {
        const res = await send('POST', `/api/sessions/${SESSION}/files/html-view`, { body: { path: filePath }, user });
        assert.equal(res.status, 200, res.body.toString());
        return JSON.parse(res.body.toString()) as { token: string; url: string; baseUrl: string };
      };
      await run({ cwd, outside, clock, send, issue });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const json = (res: Res) => JSON.parse(res.body.toString('utf8')) as Record<string, any>;
const code = (res: Res) => json(res).error?.code;

async function seedSite(cwd: string): Promise<void> {
  await fs.mkdir(path.join(cwd, 'report', 'assets'), { recursive: true });
  await fs.writeFile(path.join(cwd, 'report', '보고서 1.html'), '<!doctype html><link rel="stylesheet" href="assets/s.css"><script src="assets/a.js"></script>');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 's.css'), 'body{}');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'a.js'), 'console.log(1)');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'm.mjs'), 'export {}');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'd.json'), '{}');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'i.svg'), '<svg/>');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'f.woff2'), Buffer.from('wOF2'));
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'w.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'n.txt'), 'note');
  await fs.writeFile(path.join(cwd, 'report', 'assets', 'blob.xyz'), 'unknown');
  await fs.writeFile(path.join(cwd, 'index.htm'), '<p>root</p>');
  await fs.mkdir(path.join(cwd, '.ssh'));
  await fs.writeFile(path.join(cwd, '.ssh', 'id_rsa'), 'secret');
  await fs.writeFile(path.join(cwd, 'report', 'tool.exe'), 'MZ');
}

test('SEC-MDE-002 AC-1: the token route checks the file and answers a token, its URL and the folder URL', async () => {
  await withApp(async ({ cwd, send, issue }) => {
    await seedSite(cwd);
    const issued = await issue('report/보고서 1.html');
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.url, `/api/html-view/${issued.token}/report/${encodeURIComponent('보고서 1.html')}`);
    assert.equal(issued.baseUrl, `/api/html-view/${issued.token}/report/`);
    const rootFile = await issue(path.join(cwd, 'index.htm'));
    assert.equal(rootFile.baseUrl, `/api/html-view/${rootFile.token}/`);

    const refused: Array<[string, number, string]> = [
      ['../outside.html', 403, 'PATH_TRAVERSAL'],
      ['.ssh/id_rsa', 403, 'PATH_BLOCKED'],
      ['missing.html', 404, 'PATH_NOT_FOUND'],
      ['report', 400, 'NOT_A_FILE'],
      ['report/assets/a.js', 400, 'INVALID_INPUT'],
    ];
    for (const [p, status, expected] of refused) {
      const res = await send('POST', `/api/sessions/${SESSION}/files/html-view`, { body: { path: p } });
      assert.equal(res.status, status, `${p}: ${res.body.toString()}`);
      assert.equal(code(res), expected, p);
    }
    const noAuth = await send('POST', `/api/sessions/${SESSION}/files/html-view`, { body: { path: 'index.htm' }, user: null });
    assert.equal(noAuth.status, 401);
  });
});

test('SEC-MDE-002 AC-2, FR-MDE-028 AC-6: the page and its relative resources load without a JWT, typed by extension', async () => {
  await withApp(async ({ cwd, send, issue }) => {
    await seedSite(cwd);
    const { url, baseUrl } = await issue('report/보고서 1.html');
    const page = await send('GET', url, { user: null });
    assert.equal(page.status, 200, page.body.toString());
    assert.match(String(page.headers['content-type']), /^text\/html; charset=utf-8/);
    assert.match(page.body.toString(), /assets\/s\.css/);
    const types: Record<string, RegExp> = {
      's.css': /^text\/css/, 'a.js': /^text\/javascript/, 'm.mjs': /^text\/javascript/, 'd.json': /^application\/json/,
      'i.svg': /^image\/svg\+xml/, 'p.png': /^image\/png/, 'f.woff2': /^font\/woff2/, 'w.wasm': /^application\/wasm/,
      'n.txt': /^text\/plain/, 'blob.xyz': /^application\/octet-stream/,
    };
    for (const [name, type] of Object.entries(types)) {
      const res = await send('GET', `${baseUrl}assets/${name}`, { user: null });
      assert.equal(res.status, 200, name);
      assert.match(String(res.headers['content-type']), type, name);
    }
    // A query string is the page's own business; the file is the same.
    assert.equal((await send('GET', `${baseUrl}assets/s.css?v=3`, { user: null })).status, 200);
    // Anything under the session folder, not only the page's folder.
    assert.equal((await send('GET', `${baseUrl}../index.htm`, { user: null })).status, 200);
  });
});

test('SEC-MDE-002 AC-2: missing files and folders answer 404 without a listing; refused paths answer 403', async (t: TestContext) => {
  await withApp(async ({ cwd, outside, send, issue }) => {
    await seedSite(cwd);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    const { token } = await issue('report/보고서 1.html');
    const base = `/api/html-view/${token}`;
    const cases: Array<[string, number]> = [
      [`${base}/report/nope.css`, 404],
      [`${base}/report/assets`, 404],
      [`${base}/report/assets/`, 404],
      [`${base}/`, 404],
      [`${base}/.ssh/id_rsa`, 403],
      [`${base}/report/tool.exe`, 403],
      [`${base}/report/TOOL.EXE`, 403],
      // Win32 opens tool.exe for these spellings.
      [`${base}/report/tool.exe.`, 403],
      [`${base}/report/tool.exe%20`, 403],
      [`${base}/report/tool.exe::$DATA`, 403],
      [`${base}/%2e%2e/outside/secret.txt`, 403],
      [`${base}/report/..%2f..%2foutside%2fsecret.txt`, 403],
      [`${base}/report/%00.css`, 403],
    ];
    try {
      await fs.symlink(outside, path.join(cwd, 'escape'), 'junction');
      cases.push([`${base}/escape/secret.txt`, 403]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
      t.diagnostic('junction needs privilege; the link case is skipped');
    }
    for (const [url, status] of cases) {
      const res = await send('GET', url, { user: null });
      assert.equal(res.status, status, `${url}: ${res.body.toString()}`);
      assert.doesNotMatch(res.body.toString(), /outside|secret|s\.css/, `${url} leaks nothing`);
    }
  });
});

test('SEC-MDE-002 AC-3: every response of the view route carries the sandbox CSP and the isolation headers', async () => {
  await withApp(async ({ cwd, send, issue }) => {
    await seedSite(cwd);
    const { url, baseUrl, token } = await issue('report/보고서 1.html');
    const responses = [
      await send('GET', url, { user: null }),
      await send('GET', `${baseUrl}assets/a.js`, { user: null }),
      await send('GET', `${baseUrl}missing.css`, { user: null }),
      await send('GET', `/api/html-view/${token}/.ssh/id_rsa`, { user: null }),
      await send('GET', '/api/html-view/not-a-token/x.html', { user: null }),
    ];
    for (const res of responses) {
      const csp = String(res.headers['content-security-policy']);
      assert.match(csp, new RegExp(`^${SANDBOX}; frame-ancestors 'self'$`), csp);
      assert.doesNotMatch(csp, /allow-same-origin/);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['x-frame-options'], undefined, 'framing is governed by frame-ancestors here');
      // The sandboxed page has an opaque origin; its resource loads and fetches are cross-origin.
      assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.equal(res.headers['access-control-allow-origin'], '*');
    }
  });
});

test('SEC-MDE-002 AC-3: the application keeps frame-ancestors none elsewhere and allows frame-src self', async () => {
  await withApp(async ({ cwd, send }) => {
    await seedSite(cwd);
    const res = await send('POST', `/api/sessions/${SESSION}/files/html-view`, { body: { path: 'index.htm' } });
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /frame-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });
});

test('SEC-MDE-002 AC-4: a token is reused, expires 30 minutes after its last use, and DELETE revokes it', async () => {
  await withApp(async ({ cwd, clock, send, issue }) => {
    await seedSite(cwd);
    const { url, token } = await issue('report/보고서 1.html');
    for (let i = 0; i < 3; i += 1) {
      clock.now += 29 * 60_000; // each use keeps it alive
      assert.equal((await send('GET', url, { user: null })).status, 200, `use ${i}`);
    }
    clock.now += 30 * 60_000 + 1;
    const expired = await send('GET', url, { user: null });
    assert.equal(expired.status, 404);
    assert.equal(code(expired), 'HTML_VIEW_TOKEN_INVALID');

    const fresh = await issue('report/보고서 1.html');
    assert.equal((await send('DELETE', `/api/html-view/${fresh.token}`, { user: null })).status, 401, 'revoking needs the JWT');
    assert.equal((await send('DELETE', `/api/html-view/${fresh.token}`, { user: 'mallory' })).status, 404, 'another user cannot revoke it');
    assert.equal((await send('DELETE', `/api/html-view/${fresh.token}`)).status, 204);
    const revoked = await send('GET', fresh.url, { user: null });
    assert.equal(revoked.status, 404);
    assert.equal(code(revoked), 'HTML_VIEW_TOKEN_INVALID');
    assert.equal((await send('DELETE', `/api/html-view/${fresh.token}`)).status, 404);
    assert.equal(code(await send('GET', '/api/html-view/garbage/a.html', { user: null })), 'HTML_VIEW_TOKEN_INVALID');
    void token;
  });
});

test('SEC-MDE-002 AC-5: requests are recorded per token with their result, the last 500 kept, read with the JWT of its session', async () => {
  await withApp(async ({ cwd, send, issue }) => {
    await seedSite(cwd);
    const { url, baseUrl, token } = await issue('report/보고서 1.html');
    await send('GET', url, { user: null });
    await send('GET', `${baseUrl}assets/s.css`, { user: null });
    await send('GET', `${baseUrl}assets/none.png`, { user: null });
    await send('GET', `/api/html-view/${token}/.ssh/id_rsa`, { user: null });
    const res = await send('GET', `/api/sessions/${SESSION}/files/html-view/${token}/resources`);
    assert.equal(res.status, 200, res.body.toString());
    const entries = json(res).entries as Array<{ path: string; result: string; at: string }>;
    assert.deepEqual(entries.map((e) => [e.path, e.result]), [
      ['report/보고서 1.html', 'loaded'],
      ['report/assets/s.css', 'loaded'],
      ['report/assets/none.png', 'not-found'],
      ['.ssh/id_rsa', 'blocked'],
    ]);
    assert.match(entries[0].at, /^\d{4}-\d{2}-\d{2}T/);

    for (let i = 0; i < 520; i += 1) await send('GET', `${baseUrl}assets/x${i}.css`, { user: null });
    const capped = json(await send('GET', `/api/sessions/${SESSION}/files/html-view/${token}/resources`)).entries as Array<{ path: string }>;
    assert.equal(capped.length, 500);
    assert.equal(capped[capped.length - 1].path, 'report/assets/x519.css');

    assert.equal((await send('GET', `/api/sessions/${OTHER}/files/html-view/${token}/resources`)).status, 404, 'another session');
    assert.equal((await send('GET', `/api/sessions/${SESSION}/files/html-view/${token}/resources`, { user: 'mallory' })).status, 404, 'another user');
    assert.equal((await send('GET', `/api/sessions/${SESSION}/files/html-view/${token}/resources`, { user: null })).status, 401);
  });
});

/**
 * IR-MDE-003 AC-2·AC-4·AC-5·AC-6 · SEC-MDE-001 AC-5 —
 * GET /api/sessions/:id/files/read-image 와 두 CSP 의 img-src.
 *
 * createFileRoutes 를 index.ts 와 같은 체인(`app.use('/api/sessions', authMiddleware, fileRoutes)`)
 * 으로 실제 HTTP 위에 띄운다. FileService 와 AuthService 는 실물이고, 세션 관리자만 임시 디렉터리를
 * cwd 로 돌려주는 최소 구현이다.
 *
 * 서버는 withLocalHttpServer 의 named pipe / Unix socket 위에서만 뜬다 — TCP 포트를 열지 않으므로
 * 운영 중인 2001/2002 와 검증용 2222 어느 것에도 닿지 않는다.
 *
 * withLocalHttpServer 의 request 는 본문을 utf8 문자열로 디코딩하므로 바이트 동일성을 볼 수 없다.
 * 그래서 이 파일은 같은 endpoint 에 Buffer 로 받는 요청을 직접 보낸다.
 *
 * server/src/test-runner.ts 는 *.test.ts 를 찾지 않으므로 이 파일은 node:test 로 따로 돌린다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createFileRoutes } from './fileRoutes.js';
import { FileService } from '../services/FileService.js';
import { AuthService } from '../services/AuthService.js';
import { CryptoService } from '../services/CryptoService.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';
import { createSecurityHeadersMiddleware } from '../middleware/securityHeaders.js';
import { ErrorCode } from '../utils/errors.js';

const SESSION = 'session-1';
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface Harness {
  cwd: string;
  token: string;
  get(urlPath: string, options?: { auth?: boolean }): Promise<RawResponse>;
}

function pngBytes(size: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(Math.max(0, size - signature.length));
  // 텍스트로 디코딩하면 깨지는 바이트를 섞는다 — utf8 왕복으로는 같은 본문이 나올 수 없게.
  for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 0x80) & 0xff;
  return Buffer.concat([signature, body]);
}

function json(res: RawResponse): any {
  try { return JSON.parse(res.body.toString('utf8')); } catch { return null; }
}

function mimeOf(res: RawResponse): string {
  return String(res.headers['content-type'] ?? '').split(';')[0].trim();
}

function imageUrl(p: string): string {
  return `/api/sessions/${SESSION}/files/read-image?path=${encodeURIComponent(p)}`;
}

function textUrl(p: string): string {
  return `/api/sessions/${SESSION}/files/read?path=${encodeURIComponent(p)}`;
}

/**
 * @param withSecurityHeaders 운영처럼 helmet 을 앞에 둘지. AC-4 의 nosniff 는 helmet 도 붙이므로,
 *   라우트가 스스로 붙이는지 보려면 helmet 없이 띄워야 한다. SVG 의 CSP 는 반대로 helmet 이
 *   먼저 붙인 CSP 를 라우트가 덮어쓰는지 봐야 하므로 helmet 과 함께 띄운다.
 */
async function withHarness(
  files: Record<string, Buffer | string>,
  options: { withSecurityHeaders: boolean; blockedPaths?: string[]; blockedExtensions?: string[] },
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bg-read-image-')));
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd);
  const cryptoService = new CryptoService('file-routes-image-read-test');
  const authService = new AuthService({
    password: 'unused-password',
    durationMs: 60000,
    jwtSecret: 'file-routes-image-read-jwt-secret',
  }, cryptoService);
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(root, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }

    const fileService = new FileService({
      getSession: (id: string) => (id === SESSION ? { id } : undefined),
      getPtyPid: () => null,
      getInitialCwd: () => cwd,
      getCwdFilePath: () => null,
    }, {
      maxFileSize: 1024 * 1024,
      maxDirectoryEntries: 10000,
      blockedExtensions: options.blockedExtensions ?? [],
      blockedPaths: options.blockedPaths ?? [],
      cwdCacheTtlMs: 1000,
    });

    const app = express();
    if (options.withSecurityHeaders) app.use(createSecurityHeadersMiddleware({ enableHSTS: true }));
    app.use(express.json());
    app.use('/api/sessions', createAuthMiddleware(() => authService), createFileRoutes(fileService));

    const { token } = authService.issueToken();

    await withLocalHttpServer(app, async (fixture) => {
      await run({
        cwd,
        token,
        get: (urlPath, getOptions = {}) => new Promise<RawResponse>((resolve, reject) => {
          const req = request({
            socketPath: fixture.endpoint,
            agent: false,
            method: 'GET',
            path: urlPath,
            headers: getOptions.auth === false ? {} : { authorization: `Bearer ${token}` },
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }));
          });
          req.once('error', reject);
          req.setTimeout(2000, () => req.destroy(new Error('image read request timed out')));
          req.end();
        }),
      });
    });
  } finally {
    authService.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// TC-REQ-IR-MDE-003-AC4-01 (IR-MDE-003 AC-4)
test('GET /:id/files/read-image png → Content-Type image/png, X-Content-Type-Options nosniff, 본문 바이트 동일', async () => {
  const bytes = pngBytes(4096);
  await withHarness({ 'work/pic.png': bytes }, { withSecurityHeaders: false }, async (h) => {
    const res = await h.get(imageUrl('pic.png'));
    assert.equal(res.status, 200, `status: ${res.body.toString('utf8').slice(0, 200)}`);
    assert.equal(mimeOf(res), 'image/png');
    assert.equal(res.headers['x-content-type-options'], 'nosniff', 'the route itself must send nosniff');
    assert.equal(res.body.length, bytes.length, 'body length');
    assert.ok(res.body.equals(bytes), 'body must be the file bytes, not a JSON or text re-encoding');
  });
});

// TC-REQ-IR-MDE-003-AC2-02 (IR-MDE-003 AC-2)
test('경로 밖·차단 확장자 요청은 /files/read 와 같은 상태 코드·오류 코드', async () => {
  await withHarness({
    'outside.png': pngBytes(64),
    'work/.ssh/key.png': pngBytes(64),
    'work/pic.bmp': pngBytes(64),
  }, { withSecurityHeaders: false, blockedPaths: ['.ssh'], blockedExtensions: ['.bmp'] }, async (h) => {
    const cases: Array<[string, string, number]> = [
      ['../outside.png', ErrorCode.PATH_TRAVERSAL, 403],
      ['.ssh/key.png', ErrorCode.PATH_BLOCKED, 403],
      ['pic.bmp', ErrorCode.PATH_BLOCKED, 403],
    ];
    for (const [target, code, status] of cases) {
      const text = await h.get(textUrl(target));
      const image = await h.get(imageUrl(target));
      // 기준선: 텍스트 라우트가 기대한 오류를 낸다 — 이것이 깨지면 비교가 공허해진다.
      assert.equal(text.status, status, `${target}: /files/read baseline status`);
      assert.equal(json(text)?.error?.code, code, `${target}: /files/read baseline code`);
      assert.equal(image.status, text.status, `${target}: read-image status must match /files/read`);
      assert.equal(json(image)?.error?.code, json(text)?.error?.code, `${target}: read-image error code must match /files/read`);
    }
  });
});

// TC-REQ-IR-MDE-003-AC5-01 (IR-MDE-003 AC-5)
test('Authorization 없는 요청은 다른 세션 파일 API 와 같은 401', async () => {
  await withHarness({ 'work/pic.png': pngBytes(128) }, { withSecurityHeaders: false }, async (h) => {
    // 인증 미들웨어는 라우트 매칭 전에 돈다 — 라우트가 없어도 401 이 난다. 그래서 같은 토큰으로
    // 인증된 요청이 이미지를 받는지도 함께 본다. 그래야 "인증 뒤에 라우트가 있다" 가 확인된다.
    const authed = await h.get(imageUrl('pic.png'));
    assert.equal(authed.status, 200, 'authenticated request must reach the route');
    assert.equal(mimeOf(authed), 'image/png');

    const text = await h.get(textUrl('pic.png'), { auth: false });
    const image = await h.get(imageUrl('pic.png'), { auth: false });
    assert.equal(text.status, 401, '/files/read baseline');
    assert.equal(image.status, 401);
    assert.equal(json(image)?.error?.code, json(text)?.error?.code);
    assert.equal(json(image)?.error?.code, ErrorCode.MISSING_TOKEN);
  });
});

function parseCsp(header: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of String(header ?? '').split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

// TC-REQ-IR-MDE-003-AC6-01 (IR-MDE-003 AC-6)
test('securityHeaders 기본 CSP img-src 에 blob: 이 있고 나머지 지시어는 스냅샷과 같다; 소스 가드: index.ts 개발 CSP img-src 에도 blob:', async () => {
  const app = express();
  app.use(createSecurityHeadersMiddleware({ enableHSTS: true }));
  app.get('/probe', (_req, res) => { res.send('ok'); });

  await withLocalHttpServer(app, async (fixture) => {
    const res = await fixture.request({ method: 'GET', path: '/probe' });
    const csp = parseCsp(res.headers['content-security-policy'] as string | undefined);

    assert.deepEqual(csp.get('img-src'), ["'self'", 'data:', 'blob:'], 'production img-src');

    // 다른 지시어는 바뀌지 않는다 (AC-6) — 현재 값의 스냅샷.
    const expectedOthers: Record<string, string[]> = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'"],
      'font-src': ["'self'"],
      'object-src': ["'none'"],
      'media-src': ["'none'"],
      'frame-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'base-uri': ["'self'"],
      'upgrade-insecure-requests': [],
      // helmet 이 기본으로 더하는 지시어 — securityHeaders.ts 에는 없지만 응답에는 있다.
      'script-src-attr': ["'none'"],
    };
    const actualOthers = Object.fromEntries([...csp.entries()].filter(([name]) => name !== 'img-src'));
    assert.deepEqual(actualOthers, expectedOthers, 'directives other than img-src must be unchanged');
  });

  // 개발 CSP 는 index.ts 모듈 최상위에서 조립되고 export 되지 않는다 — 소스 텍스트로 본다.
  const indexSource = await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8');
  const devBlock = indexSource.match(/createSecurityHeadersMiddleware\(\{[\s\S]*?cspDirectives:\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}\)/);
  assert.ok(devBlock, 'index.ts development cspDirectives block not found');
  const devImg = devBlock[1].match(/imgSrc:\s*\[([^\]]*)\]/);
  assert.ok(devImg, 'index.ts development imgSrc not found');
  const devTokens = devImg[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  assert.deepEqual(devTokens, ["'self'", 'data:', 'blob:'], 'development img-src');
});

// TC-REQ-SEC-MDE-001-AC5-01 (SEC-MDE-001 AC-5)
test("svg 응답에 Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';
  await withHarness({ 'work/icon.svg': svg, 'work/pic.png': pngBytes(64) }, { withSecurityHeaders: true }, async (h) => {
    const res = await h.get(imageUrl('icon.svg'));
    assert.equal(res.status, 200, `status: ${res.body.toString('utf8').slice(0, 200)}`);
    assert.equal(mimeOf(res), 'image/svg+xml');
    // helmet 이 앞에서 붙인 페이지 CSP 를 라우트가 덮어써야 한다 — 두 헤더가 합쳐지면 sandbox 가 빠질 수 있다.
    assert.equal(res.headers['content-security-policy'], SVG_CSP);
    assert.equal(res.body.toString('utf8'), svg);

    // 경계: svg 가 아닌 이미지에는 sandbox CSP 를 붙이지 않는다(페이지 CSP 그대로).
    const png = await h.get(imageUrl('pic.png'));
    assert.equal(png.status, 200);
    assert.notEqual(png.headers['content-security-policy'], SVG_CSP);
  });
});

// FR-BGSTAB-034: auth.localhostNoAuth lets a browser on this computer log in without a password.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { createAuthRoutes } from './authRoutes.js';
import { AuthService } from '../services/AuthService.js';
import { CryptoService } from '../services/CryptoService.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { evaluateLocalLogin } from '../utils/localLoginPolicy.js';

function harness(localhostNoAuth: boolean | undefined) {
  const authService = new AuthService(
    { password: 'test-password', durationMs: 1800000, jwtSecret: 'test-jwt-secret', localhostPasswordOnly: false },
    new CryptoService('local-login-test-key-32-bytes!!!'),
  );
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRoutes({
    getAuthService: () => authService,
    getTOTPService: () => undefined,
    getTwoFactorExternalOnly: () => false,
    ...(localhostNoAuth === undefined ? {} : { getLocalhostNoAuth: () => localhostNoAuth }),
    getBootstrapSetupService: () => ({
      getStatus: () => ({ setupRequired: false, requesterAllowed: false, allowPolicy: 'configured' as const }),
      bootstrapPassword: () => { throw new AppError(ErrorCode.BOOTSTRAP_NOT_REQUIRED); },
    }),
    getRequestIp: (req: Request) => String(req.headers['x-test-remote-addr'] ?? '127.0.0.1'),
  }));
  return { app, authService };
}

async function post(app: express.Express, headers: Record<string, string>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/local-login', headers }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

test('FR-BGSTAB-034 AC-1: without the setting the route refuses and issues no token', async () => {
  for (const setting of [undefined, false]) {
    const { app } = harness(setting);
    const res = await post(app, { Host: 'localhost:2222' });
    assert.equal(res.status, 403, String(setting));
    assert.equal((res.body.error as Record<string, unknown>).code, 'LOCAL_LOGIN_DISABLED');
    assert.equal(res.body.token, undefined);
  }
});

test('FR-BGSTAB-034 AC-2: a loopback request with a local Host gets a valid token', async () => {
  const { app, authService } = harness(true);
  for (const [addr, host, origin] of [
    ['127.0.0.1', 'localhost:2222', undefined],
    ['::1', '[::1]:2222', 'https://[::1]:2222'],
    ['::ffff:127.0.0.1', '127.0.0.1:2222', 'https://127.0.0.1:2222'],
    ['127.0.0.1', 'localhost', 'https://localhost:2222'],
  ] as const) {
    const headers: Record<string, string> = { Host: host, 'x-test-remote-addr': addr };
    if (origin) headers.Origin = origin;
    const res = await post(app, headers);
    assert.equal(res.status, 200, `${addr} ${host} ${origin}`);
    assert.equal(res.body.success, true);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.expiresIn, authService.getSessionDuration());
    assert.equal(authService.verifyToken(res.body.token as string).valid, true);
  }
});

test('FR-BGSTAB-034 AC-3: a remote socket, a foreign Host or Origin, or a proxy header is refused', async () => {
  const { app } = harness(true);
  const cases: Array<Record<string, string>> = [
    { Host: 'localhost:2222', 'x-test-remote-addr': '192.168.0.10' },
    { Host: 'localhost:2222', 'x-test-remote-addr': '10.0.0.1' },
    { Host: 'evil.example:2222' },
    { Host: 'localhost.evil.example' },
    { Host: 'localhost:2222', Origin: 'https://evil.example' },
    { Host: 'localhost:2222', Origin: 'null' },
    { Host: 'localhost:2222', 'X-Forwarded-For': '203.0.113.5' },
    { Host: 'localhost:2222', Forwarded: 'for=203.0.113.5' },
    { Host: 'localhost:2222', 'X-Real-IP': '203.0.113.5' },
  ];
  for (const headers of cases) {
    const res = await post(app, headers);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal((res.body.error as Record<string, unknown>).code, 'LOCAL_LOGIN_REFUSED');
    assert.equal(res.body.token, undefined);
  }
});

test('FR-BGSTAB-034: the policy names why it refuses', () => {
  assert.deepEqual(evaluateLocalLogin({ enabled: false, remoteAddress: '127.0.0.1', headers: { host: 'localhost' } }), { allowed: false, reason: 'disabled' });
  assert.deepEqual(evaluateLocalLogin({ enabled: true, remoteAddress: '8.8.8.8', headers: { host: 'localhost' } }), { allowed: false, reason: 'remote-address' });
  assert.deepEqual(evaluateLocalLogin({ enabled: true, remoteAddress: '127.0.0.1', headers: { host: 'a.example' } }), { allowed: false, reason: 'host' });
  assert.deepEqual(evaluateLocalLogin({ enabled: true, remoteAddress: '127.0.0.1', headers: { host: 'localhost', origin: 'https://a.example' } }), { allowed: false, reason: 'origin' });
  assert.deepEqual(evaluateLocalLogin({ enabled: true, remoteAddress: '127.0.0.1', headers: { host: 'localhost', 'x-forwarded-for': '1.2.3.4' } }), { allowed: false, reason: 'proxied' });
  assert.deepEqual(evaluateLocalLogin({ enabled: true, remoteAddress: '127.0.0.1', headers: { host: 'LOCALHOST:443' } }), { allowed: true });
});

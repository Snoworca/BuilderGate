// REL-BGSTAB-045: a refreshed token keeps working for a grace period before it is revoked.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from './AuthService.js';
import { CryptoService } from './CryptoService.js';
import { authSchema } from '../schemas/config.schema.js';
import { ErrorCode } from '../utils/errors.js';

const created: AuthService[] = [];
after(() => { for (const auth of created) auth.destroy(); });

function service(auth: Record<string, unknown> = {}) {
  let clock = Date.now();
  const instance = new AuthService(authSchema.parse(auth), new CryptoService('test-machine'), { now: () => clock });
  created.push(instance);
  return { auth: instance, advance: (ms: number) => { clock += ms; } };
}

test('REL-BGSTAB-045 AC-2: the grace defaults to 180 seconds and accepts 0..3600 whole seconds', () => {
  assert.equal(authSchema.parse({}).refreshGraceSeconds, 180);
  assert.equal(authSchema.parse({ refreshGraceSeconds: 0 }).refreshGraceSeconds, 0);
  assert.equal(authSchema.parse({ refreshGraceSeconds: 3600 }).refreshGraceSeconds, 3600);
  for (const bad of [-1, 3601, 1.5, '180']) {
    assert.equal(authSchema.safeParse({ refreshGraceSeconds: bad }).success, false, String(bad));
  }
});

test('REL-BGSTAB-045 AC-1: the old token works for the grace period, then is refused', () => {
  const { auth, advance } = service();
  const first = auth.issueToken();
  const refreshed = auth.refreshToken(first.token);
  assert.ok(refreshed);
  assert.equal(auth.verifyToken(first.token).valid, true, 'right after the refresh');
  advance(179_000);
  assert.equal(auth.verifyToken(first.token).valid, true, 'just inside 180 s');
  advance(1_000);
  assert.deepEqual(auth.verifyToken(first.token), { valid: false, error: ErrorCode.TOKEN_REVOKED });
  assert.equal(auth.verifyToken(refreshed.token).valid, true);
});

test('REL-BGSTAB-045 AC-1: a second refresh of the old token inside the grace does not move its revocation later', () => {
  const { auth, advance } = service();
  const first = auth.issueToken();
  assert.ok(auth.refreshToken(first.token));
  advance(170_000);
  assert.ok(auth.refreshToken(first.token), 'another tab refreshing with the same old token');
  advance(10_000);
  assert.equal(auth.verifyToken(first.token).valid, false);
});

test('REL-BGSTAB-045 AC-1: with 0 seconds the old token is refused at once', () => {
  const { auth } = service({ refreshGraceSeconds: 0 });
  const first = auth.issueToken();
  assert.ok(auth.refreshToken(first.token));
  assert.equal(auth.verifyToken(first.token).valid, false);
});

test('REL-BGSTAB-045 AC-2: a changed grace applies to the next refresh', () => {
  const { auth, advance } = service();
  auth.updateRuntimeConfig({ refreshGraceSeconds: 10 });
  const first = auth.issueToken();
  assert.ok(auth.refreshToken(first.token));
  advance(9_000);
  assert.equal(auth.verifyToken(first.token).valid, true);
  advance(1_000);
  assert.equal(auth.verifyToken(first.token).valid, false);
});

test('REL-BGSTAB-045: logout still revokes at once', () => {
  const { auth } = service();
  const first = auth.issueToken();
  auth.revokeToken(first.payload.jti, first.payload.exp);
  assert.equal(auth.verifyToken(first.token).valid, false);
});

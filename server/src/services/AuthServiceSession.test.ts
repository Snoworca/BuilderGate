// REL-BGSTAB-037: a browser login lasts seven days after its last use.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { AuthService } from './AuthService.js';
import { CryptoService } from './CryptoService.js';
import { authSchema } from '../schemas/config.schema.js';
import { normalizeRawConfigForPlatform } from '../utils/ptyPlatformPolicy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const created: AuthService[] = [];
after(() => { for (const auth of created) auth.destroy(); });

function service(durationMs?: number) {
  const auth = new AuthService(authSchema.parse(durationMs === undefined ? {} : { durationMs }), new CryptoService('test-machine'));
  created.push(auth);
  return auth;
}

test('REL-BGSTAB-037 AC-1: the default login lasts seven days', () => {
  assert.equal(authSchema.parse({}).durationMs, 7 * DAY_MS);
  const { payload } = service().issueToken();
  assert.equal(payload.exp - payload.iat, 7 * 24 * 60 * 60);
});

test('REL-BGSTAB-037 AC-1: the former 30-minute default moves to seven days; other values stay', () => {
  const parse = (durationMs: number) => authSchema.parse(normalizeRawConfigForPlatform({ auth: { durationMs } }, 'linux').auth).durationMs;
  assert.equal(parse(1_800_000), 7 * DAY_MS);
  assert.equal(parse(3_600_000), 3_600_000);
  assert.equal(normalizeRawConfigForPlatform({}, 'linux').auth, undefined, 'no auth section is left alone');
  assert.equal(authSchema.parse({ durationMs: 30 * DAY_MS }).durationMs, 30 * DAY_MS);
  assert.equal(authSchema.safeParse({ durationMs: 30 * DAY_MS + 1 }).success, false);
  assert.equal(authSchema.safeParse({ durationMs: 59_999 }).success, false);
});

test('REL-BGSTAB-037 AC-2: refresh extends to the full duration and keeps the old token revoked until it expires', () => {
  const auth = service();
  const first = auth.issueToken();
  const refreshed = auth.refreshToken(first.token);
  assert.ok(refreshed);
  assert.equal(refreshed.payload.exp - refreshed.payload.iat, 7 * 24 * 60 * 60);
  assert.equal(auth.verifyToken(first.token).valid, false);
  const blacklist = (auth as unknown as { tokenBlacklist: Map<string, number> }).tokenBlacklist;
  assert.equal(blacklist.get(first.payload.jti), first.payload.exp, 'revoked for the rest of its life, not 24 h');
  assert.equal(auth.verifyToken(refreshed.token).valid, true);
  assert.equal(typeof jwt.decode(refreshed.token), 'object');
});

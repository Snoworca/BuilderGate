import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tryLocalLogin } from '../../src/services/localLogin.ts';

// FR-BGSTAB-034 AC-4 — with auth.localhostNoAuth on, a browser on this computer skips the login screen.

function storage() {
  const stored: Array<[string, number]> = [];
  return { stored, setToken: (token: string, expiresIn: number) => { stored.push([token, expiresIn]); } };
}

test('FR-BGSTAB-034 AC-4: an issued token is stored and reported', async () => {
  const s = storage();
  const result = await tryLocalLogin(async () => ({ success: true, token: 'tok', expiresIn: 1000 }), s);
  assert.equal(result, true);
  assert.deepEqual(s.stored, [['tok', 1000]]);
});

test('FR-BGSTAB-034 AC-4: a refusal or a network error leaves the login screen and stores nothing', async () => {
  for (const call of [
    async () => { throw new Error('Login without a password from this computer is turned off'); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ success: true }),
  ]) {
    const s = storage();
    assert.equal(await tryLocalLogin(call as never, s), false);
    assert.deepEqual(s.stored, []);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_REFRESH_MAX_AGE_MS, shouldRefreshAuthToken } from '../../src/utils/authRefreshPolicy.ts';
import { authFetchWithRetry } from '../../src/services/authRetry.ts';

// REL-BGSTAB-037 — a login survives sleep, tab freezing and several tabs.

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

test('REL-BGSTAB-037 AC-3: a seven-day token is refreshed once it is ten minutes old', () => {
  const now = 1_000_000_000;
  const duration = 7 * DAY;
  const issuedAt = (age: number) => ({ now, durationMs: duration, expiresAt: now - age + duration });
  assert.equal(AUTH_REFRESH_MAX_AGE_MS, 10 * MIN);
  assert.equal(shouldRefreshAuthToken(issuedAt(9 * MIN)), false);
  assert.equal(shouldRefreshAuthToken(issuedAt(10 * MIN)), true);
  assert.equal(shouldRefreshAuthToken(issuedAt(3 * DAY)), true, 'after a long sleep it refreshes at once');
});

test('REL-BGSTAB-037 AC-3: a short token is refreshed at half its life', () => {
  const now = 5_000_000;
  const duration = 4 * MIN;
  assert.equal(shouldRefreshAuthToken({ now, durationMs: duration, expiresAt: now + 3 * MIN }), false);
  assert.equal(shouldRefreshAuthToken({ now, durationMs: duration, expiresAt: now + 2 * MIN }), true);
});

test('REL-BGSTAB-037 AC-3: an expired or missing token is never refreshed', () => {
  const now = 5_000_000;
  assert.equal(shouldRefreshAuthToken({ now, durationMs: 7 * DAY, expiresAt: now }), false);
  assert.equal(shouldRefreshAuthToken({ now, durationMs: 7 * DAY, expiresAt: null }), false);
  // A token stored before the duration was recorded is refreshed once so the duration is learned.
  assert.equal(shouldRefreshAuthToken({ now, durationMs: null, expiresAt: now + MIN }), true);
});

function fakeFetch(responses: number[]) {
  const calls: Array<string | null> = [];
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push(headers.get('Authorization'));
    return new Response(null, { status: responses.shift() ?? 200 });
  };
  return { fetchFn, calls };
}

test('REL-BGSTAB-037 AC-4: a 401 for a token another tab already rotated is retried with the stored token', async () => {
  const { fetchFn, calls } = fakeFetch([401, 200]);
  let expired = 0;
  const res = await authFetchWithRetry(
    { fetch: fetchFn, readToken: () => 'new-token', onExpired: () => { expired += 1; } },
    '/api/x',
    { headers: { Authorization: 'Bearer old-token', 'x-client-id': 'c1' } },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['Bearer old-token', 'Bearer new-token']);
  assert.equal(expired, 0);
});

test('REL-BGSTAB-037 AC-4: a 401 with the current token still expires the login', async () => {
  const same = fakeFetch([401]);
  let expired = 0;
  const res = await authFetchWithRetry(
    { fetch: same.fetchFn, readToken: () => 'tok', onExpired: () => { expired += 1; } },
    '/api/x',
    { headers: { Authorization: 'Bearer tok' } },
  );
  assert.equal(res.status, 401);
  assert.equal(same.calls.length, 1);
  assert.equal(expired, 1);

  const retryFails = fakeFetch([401, 401]);
  let expired2 = 0;
  await authFetchWithRetry(
    { fetch: retryFails.fetchFn, readToken: () => 'newer', onExpired: () => { expired2 += 1; } },
    '/api/x',
    { headers: { Authorization: 'Bearer old' } },
  );
  assert.equal(retryFails.calls.length, 2, 'retried only once');
  assert.equal(expired2, 1);

  const noToken = fakeFetch([401]);
  let expired3 = 0;
  await authFetchWithRetry(
    { fetch: noToken.fetchFn, readToken: () => null, onExpired: () => { expired3 += 1; } },
    '/api/x',
    { headers: { Authorization: 'Bearer old' } },
  );
  assert.equal(noToken.calls.length, 1);
  assert.equal(expired3, 1);
});

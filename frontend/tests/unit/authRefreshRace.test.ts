import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authFetchWithRetry } from '../../src/services/authRetry.ts';
import { trackRefresh, waitForRefreshInFlight } from '../../src/services/refreshInFlight.ts';

// REL-BGSTAB-045 AC-3 — a 401 that races this page's own refresh is not a logout.

function res(status: number): Response {
  return new Response(null, { status });
}

test('REL-BGSTAB-045 AC-3: a 401 during a refresh waits for it and retries with the new token', async () => {
  let stored = 'old';
  let finishRefresh!: () => void;
  const refresh = trackRefresh(new Promise<void>((resolve) => { finishRefresh = () => { stored = 'new'; resolve(); }; }));
  const sent: string[] = [];
  let expired = 0;
  const pending = authFetchWithRetry({
    fetch: async (_input, init) => {
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      sent.push(auth);
      return res(auth === 'Bearer new' ? 200 : 401);
    },
    readToken: () => stored,
    onExpired: () => { expired += 1; },
    waitForRefresh: waitForRefreshInFlight,
  }, '/api/x', { headers: { Authorization: 'Bearer old' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(expired, 0, 'no logout while the refresh is still running');
  finishRefresh();
  await refresh;
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(sent, ['Bearer old', 'Bearer new']);
  assert.equal(expired, 0);
});

test('REL-BGSTAB-045 AC-3: without a refresh in progress a 401 with the current token still logs out', async () => {
  let expired = 0;
  const result = await authFetchWithRetry({
    fetch: async () => res(401),
    readToken: () => 'same',
    onExpired: () => { expired += 1; },
    waitForRefresh: waitForRefreshInFlight,
  }, '/api/x', { headers: { Authorization: 'Bearer same' } });
  assert.equal(result.status, 401);
  assert.equal(expired, 1);
});

test('REL-BGSTAB-045 AC-3: a refresh that fails brings no new token, so the 401 logs out', async () => {
  let expired = 0;
  const refresh = trackRefresh(Promise.reject(new Error('network')));
  const result = await authFetchWithRetry({
    fetch: async () => res(401),
    readToken: () => 'old',
    onExpired: () => { expired += 1; },
    waitForRefresh: waitForRefreshInFlight,
  }, '/api/x', { headers: { Authorization: 'Bearer old' } });
  await refresh.catch(() => undefined);
  assert.equal(result.status, 401);
  assert.equal(expired, 1);
});

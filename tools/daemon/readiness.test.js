const assert = require('node:assert/strict');
const test = require('node:test');

const {
  matchesHealthIdentity,
  waitForReadiness,
} = require('./readiness');

function createState() {
  return {
    appPid: 41001,
    startAttemptId: 'attempt-identity',
    stateGeneration: 7,
  };
}

test('matchesHealthIdentity rejects unrelated health 200 without daemon identity', () => {
  const state = createState();

  assert.equal(matchesHealthIdentity({ statusCode: 200, body: { status: 'ok' }, headers: {} }, state), false);
});

test('matchesHealthIdentity requires app pid and startAttemptId or stateGeneration match', () => {
  const state = createState();

  assert.equal(
    matchesHealthIdentity({
      statusCode: 200,
      body: { status: 'ok', pid: 41001, startAttemptId: 'attempt-identity' },
      headers: {},
    }, state),
    true,
  );
  assert.equal(
    matchesHealthIdentity({
      statusCode: 200,
      body: { status: 'ok', pid: 41001, stateGeneration: 7 },
      headers: {},
    }, state),
    true,
  );
  assert.equal(
    matchesHealthIdentity({
      statusCode: 200,
      body: { status: 'ok', pid: 41001, startAttemptId: 'other' },
      headers: {},
    }, state),
    false,
  );
  assert.equal(
    matchesHealthIdentity({
      statusCode: 200,
      body: { status: 'ok', pid: 49999, startAttemptId: 'attempt-identity' },
      headers: {},
    }, state),
    false,
  );
});

test('matchesHealthIdentity accepts identity supplied through response headers', () => {
  const state = createState();

  assert.equal(
    matchesHealthIdentity({
      statusCode: 200,
      body: { status: 'ok' },
      headers: {
        'x-buildergate-pid': '41001',
        'x-buildergate-start-attempt-id': 'attempt-identity',
      },
    }, state),
    true,
  );
});

test('waitForReadiness does not succeed on repeated unrelated /health responses', async () => {
  const result = await waitForReadiness({
    port: 2002,
    state: createState(),
    timeoutMs: 5,
    intervalMs: 1,
    fetchHealth: async () => ({ statusCode: 200, body: { status: 'ok' }, headers: {} }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /identity/i);
});

test('waitForReadiness succeeds only after matching identity is observed', async () => {
  const state = createState();
  let calls = 0;
  const result = await waitForReadiness({
    port: 2002,
    state,
    timeoutMs: 100,
    intervalMs: 1,
    fetchHealth: async () => {
      calls += 1;
      return calls === 1
        ? { statusCode: 200, body: { status: 'ok' }, headers: {} }
        : { statusCode: 200, body: { status: 'ok', pid: 41001, startAttemptId: 'attempt-identity' }, headers: {} };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

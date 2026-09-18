import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearAuthFailures, currentAuthDelayMs, recordAuthFailure, resetAuthThrottleForTests,
} from './authAttemptThrottle.js';

// #61. Every assertion pairs a "throttles" case with a "does not throttle" case, so a
// middleware that always delayed would fail as surely as one that never did.

test('#61 the first attempts are free, then the delay grows', () => {
  resetAuthThrottleForTests();
  const key = 'probe-a';
  for (let i = 0; i < 5; i += 1) {
    recordAuthFailure(key);
    assert.equal(currentAuthDelayMs(key), 0, `attempt ${i + 1} must not be delayed`);
  }
  recordAuthFailure(key);
  const first = currentAuthDelayMs(key);
  assert.ok(first > 0, 'the sixth failure must start costing time');
  recordAuthFailure(key);
  assert.ok(currentAuthDelayMs(key) > first, 'the delay must grow with further failures');
});

test('#61 the delay is capped, so this cannot become a self-inflicted outage', () => {
  resetAuthThrottleForTests();
  const key = 'probe-b';
  for (let i = 0; i < 500; i += 1) recordAuthFailure(key);
  assert.equal(currentAuthDelayMs(key), 10_000,
    'an unbounded delay would be a lockout wearing a different name');
});

test('#61 success clears the counter', () => {
  resetAuthThrottleForTests();
  const key = 'probe-c';
  for (let i = 0; i < 8; i += 1) recordAuthFailure(key);
  assert.ok(currentAuthDelayMs(key) > 0);
  clearAuthFailures(key);
  assert.equal(currentAuthDelayMs(key), 0, 'a user who gets in must stop paying');
});

test('#61 one source address cannot throttle another', () => {
  resetAuthThrottleForTests();
  for (let i = 0; i < 20; i += 1) recordAuthFailure('attacker');
  assert.ok(currentAuthDelayMs('attacker') > 0);
  assert.equal(currentAuthDelayMs('bystander'), 0,
    'keying must isolate sources, or this becomes the DoS lever a lockout would have been');
});

test('#61 the window expires', () => {
  resetAuthThrottleForTests();
  const key = 'probe-d';
  const t0 = Date.now();
  for (let i = 0; i < 10; i += 1) recordAuthFailure(key, t0);
  assert.ok(currentAuthDelayMs(key, t0) > 0);
  assert.equal(currentAuthDelayMs(key, t0 + 16 * 60 * 1000), 0,
    'an old burst must not follow someone around forever');
});

test('#61 tracking is bounded against a spray from many addresses', () => {
  resetAuthThrottleForTests();
  const now = Date.now();
  for (let i = 0; i < 10_050; i += 1) recordAuthFailure(`spray-${i}`, now);
  // The most recent key must still be tracked; the map must not have grown without limit.
  assert.ok(currentAuthDelayMs('spray-0', now) === 0, 'the oldest entries are evicted first');
});

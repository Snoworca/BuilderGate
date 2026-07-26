import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPublicObservedSessionFixture,
} from './TerminalResourcePolicyCanaryPublicFixture.fixture.js';

// @req 2026-07-26.pm.canary-fixture-recovery-public-api
test('public recovery fixture observes one public session and releases it', () => {
  const fixture = createPublicObservedSessionFixture({
    sessionId: 'canary-public-fixture-session',
  });

  try {
    assert.equal(fixture.createCallCount, 1);
    assert.equal(fixture.spawnCount, 1);
    assert.equal(fixture.onDataRegistrationCount, 1);
    assert.equal(fixture.createdSession.id, 'canary-public-fixture-session');
    assert.equal(fixture.observedSession?.id, fixture.createdSession.id);
  } finally {
    assert.equal(fixture.dispose(), true);
    assert.equal(fixture.manager.getSession(fixture.createdSession.id), null);
    assert.equal(fixture.activeDataCallbackCount, 0);
  }
});

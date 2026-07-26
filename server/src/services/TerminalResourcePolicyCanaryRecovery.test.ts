import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createObservedHeadlessSessionFixture,
} from './TerminalResourcePolicyCanaryRecovery.fixture.js';

// @req 2026-07-26.pm.canary-fixture-recovery
test('recovery fixture creates and releases one observed public headless session', () => {
  const fixture = createObservedHeadlessSessionFixture({
    sessionId: 'canary-recovery-public-session',
  });

  try {
    assert.equal(fixture.createCallCount, 1);
    assert.equal(fixture.spawnCount, 1);
    assert.equal(fixture.onDataRegistrationCount, 1);
    assert.equal(fixture.createdSession.id, 'canary-recovery-public-session');
    assert.strictEqual(fixture.observedState, fixture.createdState);
    assert.equal(fixture.manager.getSession(fixture.createdSession.id)?.id, fixture.createdSession.id);
  } finally {
    assert.equal(fixture.dispose(), true);
    assert.equal(fixture.manager.getSession(fixture.createdSession.id), null);
    assert.equal(fixture.activeDataCallbackCount, 0);
  }
});

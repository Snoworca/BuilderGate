import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalBinaryGroupSession } from './terminalBinaryGroupSession.js';

/** SDS §4: the send path needs the reverse lookup the interface never had. */
function negotiated() {
  const group = createTerminalBinaryGroupSession({ now: () => 1, wireFormat: 'binary-optin', transportMode: 'unified' });
  const r = group.negotiate({ supportedFrameVersions: [1], acceptedFlagMask: 0x0001 | 0x0008 } as never);
  assert.equal(r.type, 'terminal-binary:capability');
  return group;
}

test('lookupChannel returns the open channel for a session and undefined after retirement', () => {
  const group = negotiated();
  const opened = group.openChannel({ sessionId: 's1', streamEpoch: '4', authorityEpoch: 'a' });
  assert.equal(typeof opened.channelId, 'number');
  assert.deepEqual(group.lookupChannel('s1'), { channelId: opened.channelId, streamEpoch: '4' });
  assert.equal(group.lookupChannel('never'), undefined);
  group.closeSession('s1');
  assert.equal(group.lookupChannel('s1'), undefined);
});

test('shadowMismatch starts at zero and haltShadow is idempotent', () => {
  const group = createTerminalBinaryGroupSession({ now: () => 1, wireFormat: 'binary-shadow', transportMode: 'unified' });
  assert.equal(group.shadowMismatch, 0);
  assert.equal(group.shadowActive, true);
  group.recordShadowMismatch(); group.recordShadowMismatch();
  assert.equal(group.shadowMismatch, 1, 'the first mismatch halts shadow; later calls are no-ops');
  assert.equal(group.shadowActive, false);
});

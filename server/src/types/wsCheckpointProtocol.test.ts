import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
  parseTerminalCheckpointClientMessage,
} from './ws-protocol.js';

function ackIdentity() {
  return {
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    sessionId: 'session-checkpoint-1',
    viewGeneration: 7,
    streamEpoch: '9',
    checkpointEpoch: '4',
    sourceSeq: '101',
    snapshotSeq: '100',
    oldestRetainedSeq: '10',
    retentionPolicyId: 'retained-scrollback:10000',
    connectionId: 'connection-checkpoint-1',
    transitionEpoch: '11',
    authorityEpoch: 'authority-checkpoint-1',
    responderLeaseId: 'responder-checkpoint-1',
    boundarySourceSeq: '99',
  } as const;
}

test('checkpoint client contract accepts negotiate and apply/drain/failure ACK frames', () => {
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:negotiate',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
  }).ok, true);

  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:apply-ack',
    ...ackIdentity(),
    appliedThroughSeq: '100',
  }).ok, true);

  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:drain-ack',
    ...ackIdentity(),
    drainedThroughSeq: '101',
  }).ok, true);

  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:failure-ack',
    ...ackIdentity(),
    reason: 'digest-mismatch',
    lastAppliedSeq: '99',
  }).ok, true);

  for (const message of [
    {
      type: 'terminal-checkpoint:apply-ack',
      ...ackIdentity(),
      appliedThroughSeq: '100',
    },
    {
      type: 'terminal-checkpoint:drain-ack',
      ...ackIdentity(),
      drainedThroughSeq: '101',
    },
    {
      type: 'terminal-checkpoint:failure-ack',
      ...ackIdentity(),
      reason: 'digest-mismatch',
      lastAppliedSeq: '99',
    },
  ] as const) {
    assert.equal(
      parseTerminalCheckpointClientMessage({ ...message, connectionId: undefined }).ok,
      false,
      `${message.type} must carry its exact connection identity`,
    );
  }

  const applyAck = {
    type: 'terminal-checkpoint:apply-ack',
    ...ackIdentity(),
    appliedThroughSeq: '100',
  } as const;
  for (const [field, value] of [
    ['connectionId', ''],
    ['transitionEpoch', '011'],
    ['transitionEpoch', 11],
    ['authorityEpoch', ''],
    ['responderLeaseId', ''],
    ['boundarySourceSeq', '099'],
    ['boundarySourceSeq', 99],
  ] as const) {
    assert.equal(
      parseTerminalCheckpointClientMessage({ ...applyAck, [field]: value }).ok,
      false,
      `present extended checkpoint identity ${field} must be canonical`,
    );
  }
});

test('MIG-BGSTAB-002 checkpoint delivery ready accepts only the prepared canonical control identity', () => {
  const ready = {
    type: 'terminal-checkpoint:ready',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    sessionId: 'session-checkpoint-1',
    viewGeneration: 7,
    authorityEpoch: 'authority-checkpoint-1',
    streamEpoch: '9',
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    viewAttributesChallengeId: 'challenge-checkpoint-1',
    checkpointDeliveryId: 'delivery-checkpoint-1',
  };
  assert.equal(parseTerminalCheckpointClientMessage(ready).ok, true);
  for (const [field, value] of [
    ['sessionId', ''],
    ['viewGeneration', -1],
    ['streamEpoch', '09'],
    ['driverLeaseGeneration', '09'],
    ['acceptedViewAttributesGeneration', '09'],
    ['authorityEpoch', ''],
    ['viewAttributesChallengeId', ''],
    ['checkpointDeliveryId', ''],
  ] as const) {
    assert.equal(
      parseTerminalCheckpointClientMessage({ ...ready, [field]: value }).ok,
      false,
      `checkpoint ready ${field} must be canonical`,
    );
  }
});

test('checkpoint ACK contract rejects number, noncanonical, out-of-range and inconsistent ordinals', () => {
  const base = {
    type: 'terminal-checkpoint:apply-ack',
    ...ackIdentity(),
    appliedThroughSeq: '100',
  };
  for (const field of [
    'streamEpoch',
    'checkpointEpoch',
    'sourceSeq',
    'snapshotSeq',
    'oldestRetainedSeq',
    'appliedThroughSeq',
  ] as const) {
    for (const value of [100, '0100', '+100', '18446744073709551616'] as const) {
      assert.equal(parseTerminalCheckpointClientMessage({ ...base, [field]: value }).ok, false);
    }
  }
  assert.equal(parseTerminalCheckpointClientMessage({
    ...base,
    appliedThroughSeq: '99',
  }).ok, false, 'apply ACK must cover the exact snapshot');
  assert.equal(parseTerminalCheckpointClientMessage({
    ...base,
    sourceSeq: '99',
  }).ok, false, 'sourceSeq cannot precede snapshotSeq');
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:drain-ack',
    ...ackIdentity(),
    drainedThroughSeq: '100',
  }).ok, false, 'partial drain cannot release readiness');
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:drain-ack',
    ...ackIdentity(),
    drainedThroughSeq: '101',
  }).ok, true, 'exact transaction tail completes the drain');
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:drain-ack',
    ...ackIdentity(),
    drainedThroughSeq: '102',
  }).ok, true, 'context-free parser accepts post-snapshot tail; the adapter ledger enforces its upper bound');
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:failure-ack',
    ...ackIdentity(),
    reason: 'drain-failed',
    lastAppliedSeq: '102',
  }).ok, false, 'failure progress cannot exceed the transaction tail');
  assert.equal(parseTerminalCheckpointClientMessage({
    type: 'terminal-checkpoint:failure-ack',
    ...ackIdentity(),
    reason: 'unknown-reason',
  }).ok, false);

});

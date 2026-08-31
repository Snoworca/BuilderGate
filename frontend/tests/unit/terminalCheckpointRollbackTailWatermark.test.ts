import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { createTerminalCheckpointRuntime } from '../../src/utils/terminalCheckpointRuntime.ts';
import { digestTerminalBytes } from '../../src/utils/terminalRawMutationAdapter.ts';
import {
  createTerminalWriteCoordinator,
  type TerminalWriteCoordinator,
} from '../../src/utils/terminalWriteCoordinator.ts';
import type {
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointServerMessage,
} from '../../src/types/ws-protocol.ts';

const ACTIVE_CAPABILITY: TerminalCheckpointCapabilityMessage = {
  type: 'terminal-checkpoint:capability',
  protocolVersion: 1,
  accepted: true,
  authorityMode: 'checkpoint',
  checkpointDeliveryActive: true,
  ordinalEncoding: 'canonical-uint64-decimal',
  digestAlgorithms: ['sha256'],
  registeredViews: [{ sessionId: 'session-1', viewGeneration: 7 }],
};

const CHECKPOINT_IDENTITY = Object.freeze({
  protocolVersion: 1 as const,
  sessionId: 'session-1',
  viewGeneration: 7,
  streamEpoch: '3',
  checkpointEpoch: '4',
  sourceSeq: '10',
  snapshotSeq: '10',
  oldestRetainedSeq: '1',
  retentionPolicyId: 'retained-10000-v1',
});

const CHECKPOINT_DIGEST = Object.freeze({
  algorithm: 'sha256' as const,
  hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
});

function checkpointStart(): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:start',
    ...CHECKPOINT_IDENTITY,
    sourceGeometry: { cols: 120, rows: 40 },
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: CHECKPOINT_DIGEST,
    modes: { bracketedPasteMode: true, wraparoundMode: false },
    parserTail: { encoding: 'base64', data: '', encodedBytes: 0 },
  };
}

function checkpointChunk(): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:chunk',
    ...CHECKPOINT_IDENTITY,
    chunkIndex: 0,
    chunkCount: 1,
    encoding: 'base64',
    data: 'YWJj',
    encodedBytes: 3,
  };
}

function checkpointCommit(): TerminalCheckpointServerMessage {
  return {
    type: 'terminal-checkpoint:commit',
    ...CHECKPOINT_IDENTITY,
    chunkCount: 1,
    encodedByteTotal: 3,
    digest: CHECKPOINT_DIGEST,
  };
}

test('MIG-BGSTAB-002 AC-5 rollback drain ACK advances through the contiguous post-snapshot tail', () => {
  const sent: Array<Record<string, unknown>> = [];
  let coordinator: TerminalWriteCoordinator | null = null;
  const runtime = createTerminalCheckpointRuntime({
    sessionId: 'session-1',
    initialViewGeneration: 7,
    getCoordinator: () => coordinator,
    send: (message) => {
      sent.push(message as unknown as Record<string, unknown>);
      return { ok: true };
    },
    requestFreshRecovery: reason => {
      throw new Error(`unexpected recovery: ${reason}`);
    },
    advanceViewGeneration: () => {},
  });
  coordinator = createTerminalWriteCoordinator({
    viewGeneration: 7,
    digestBytes: digestTerminalBytes,
    adapter: {
      write: (_command, callback) => callback(),
      resetParser: () => {},
      resize: () => {},
      applyModes: () => {},
      clearScreen: () => {},
      fit: () => ({ cols: 80, rows: 24 }),
      setWindowsPty: () => {},
      checkpointApplied: (metadata) => {
        const result = runtime.checkpointApplied(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      checkpointDrained: (metadata) => {
        const result = runtime.checkpointDrained(metadata);
        if (!result.accepted) throw new Error(result.reason);
      },
      markReady: () => {},
      releaseInput: () => {},
      settleInput: () => {},
      requestFreshRecovery: reason => {
        throw new Error(`unexpected coordinator recovery: ${reason}`);
      },
      requestRuntimeRecreation: reason => {
        throw new Error(`unexpected runtime recreation: ${reason}`);
      },
      compatibilityRecoveryDrained: () => {},
      settle: () => {},
    },
    timeoutMs: 100,
    postCheckpointMaxBytes: 1024,
    postCheckpointMaxChunks: 16,
    pendingInputMaxBytes: 1024,
    pendingInputMaxCount: 16,
    pendingInputTtlMs: 1000,
    settlementLedgerMaxEntries: 16,
    settlementLedgerTtlMs: 1000,
  });
  runtime.setCapability(ACTIVE_CAPABILITY);
  assert.equal(runtime.handleMessage(checkpointStart()).accepted, true);
  assert.equal(runtime.handleMessage(checkpointChunk()).accepted, true);
  for (const sourceSeq of ['11', '12']) {
    const tail = `tail-${sourceSeq}`;
    assert.equal(runtime.handleMessage({
      type: 'terminal-checkpoint:output',
      ...CHECKPOINT_IDENTITY,
      sourceSeq,
      encoding: 'base64',
      data: Buffer.from(tail).toString('base64'),
      encodedBytes: tail.length,
    }).accepted, true);
  }
  assert.equal(runtime.handleMessage(checkpointCommit()).accepted, true);

  const applyAck = sent.find(message => message.type === 'terminal-checkpoint:apply-ack');
  const drainAck = sent.find(message => message.type === 'terminal-checkpoint:drain-ack');
  assert.equal(applyAck?.sourceSeq, '10', 'checkpoint apply identity must remain fixed at checkpoint sourceSeq');
  assert.equal(applyAck?.appliedThroughSeq, '10');
  assert.equal(drainAck?.sourceSeq, '10', 'drain ACK must preserve the checkpoint wire identity');
  assert.equal(
    drainAck?.drainedThroughSeq,
    '12',
    'drain ACK must advance to the latest physically written contiguous tail sourceSeq',
  );
});

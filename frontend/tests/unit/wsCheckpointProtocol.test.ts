import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
  parseTerminalCheckpointServerMessage,
} from '../../src/types/ws-protocol.ts';
import * as wsProtocolModule from '../../src/types/ws-protocol.ts';
import {
  attachRetainedMutationLease,
  releaseTerminalCheckpointDispatcherRegistration,
} from '../../src/utils/terminalCheckpointRuntime.ts';

const SHA256 = '0123456789abcdef'.repeat(4);

interface LegacyResponderEnabledProtocolContract {
  parseTerminalResponderHandoffServerMessage(value: unknown):
    | Readonly<{
      ok: true;
      message: Readonly<{
        type: 'terminal-authority:legacy-responder-enabled';
        sessionId: string;
        connectionId: string;
        viewGeneration: number;
        transitionEpoch: string;
        authorityEpoch: string;
        streamEpoch: string;
        responderLeaseId: string;
        driverLeaseId: string;
        driverLeaseGeneration: string;
        acceptedViewAttributesGeneration: string;
        queryReplyCapability: 'terminal.query-reply-input.v1';
        parserResponderCapability: 'terminal.parser-responder-disable.v1';
        boundarySourceSeq: string;
        checkpointEpoch: string;
        snapshotSeq: string;
        drainedThroughSourceSeq: string;
        checkpointApplied: true;
        postSnapshotTailDrained: true;
        affectedViewCount: number;
      }>;
    }>
    | Readonly<{ ok: false; reason: string }>;
}

function checkpointContract(source: string): string {
  const startMarker = '// terminal-checkpoint-contract:start';
  const endMarker = '// terminal-checkpoint-contract:end';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start + startMarker.length, end).trim();
}

function identity() {
  return {
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    sessionId: 'session-checkpoint-1',
    viewGeneration: 7,
    streamEpoch: '9',
    checkpointEpoch: '4',
    sourceSeq: '18446744073709551615',
    snapshotSeq: '18446744073709551615',
    oldestRetainedSeq: '0',
    retentionPolicyId: 'retained-scrollback:10000',
  } as const;
}

function startMessage(): Record<string, unknown> {
  return {
    type: 'terminal-checkpoint:start',
    ...identity(),
    sourceGeometry: { cols: 160, rows: 48 },
    chunkCount: 2,
    encodedByteTotal: 6,
    digest: { algorithm: 'sha256', hex: SHA256 },
    modes: { applicationCursorKeysMode: true, bracketedPasteMode: false },
    parserTail: { encoding: 'base64', data: 'G1s=', encodedBytes: 2 },
  };
}

test('checkpoint server contract accepts canonical start/chunk/commit frames', () => {
  const start = parseTerminalCheckpointServerMessage(startMessage());
  assert.equal(start.ok, true);

  const chunk = parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:chunk',
    ...identity(),
    chunkIndex: 0,
    chunkCount: 2,
    encoding: 'base64',
    data: 'YWJj',
    encodedBytes: 3,
  });
  assert.equal(chunk.ok, true);

  const commit = parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:commit',
    ...identity(),
    chunkCount: 2,
    encodedByteTotal: 6,
    digest: { algorithm: 'sha256', hex: SHA256 },
  });
  assert.equal(commit.ok, true);

  const output = parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:output',
    ...identity(),
    encoding: 'base64',
    data: 'YWJj',
    encodedBytes: 3,
  });
  assert.equal(output.ok, true);

  const parseResponderHandoff = (
    wsProtocolModule as unknown as Partial<LegacyResponderEnabledProtocolContract>
  ).parseTerminalResponderHandoffServerMessage;
  assert.equal(
    typeof parseResponderHandoff,
    'function',
    'typed terminal-authority:legacy-responder-enabled parser contract missing',
  );
  if (!parseResponderHandoff) return;
  const enableFrame = {
    type: 'terminal-authority:legacy-responder-enabled',
    sessionId: 'session-checkpoint-1',
    connectionId: 'connection-a',
    viewGeneration: 7,
    transitionEpoch: '8',
    authorityEpoch: 'authority-7',
    streamEpoch: '8',
    responderLeaseId: 'responder-browser-7',
    driverLeaseId: 'driver-compatibility-9',
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
    boundarySourceSeq: '41',
    checkpointEpoch: '9001',
    snapshotSeq: '50',
    drainedThroughSourceSeq: '52',
    checkpointApplied: true,
    postSnapshotTailDrained: true,
    affectedViewCount: 2,
  } as const;
  const parsedEnableFrame = parseResponderHandoff(enableFrame);
  assert.equal(parsedEnableFrame.ok, true);
  if (parsedEnableFrame.ok) assert.deepEqual(parsedEnableFrame.message, enableFrame);
  for (const mutation of [
    { sessionId: '' },
    { connectionId: '' },
    { viewGeneration: -1 },
    { viewGeneration: 1.5 },
    { viewGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { transitionEpoch: '08' },
    { authorityEpoch: '' },
    { streamEpoch: '08' },
    { responderLeaseId: '' },
    { driverLeaseId: '' },
    { driverLeaseGeneration: '09' },
    { acceptedViewAttributesGeneration: '09' },
    { queryReplyCapability: 'terminal.query-reply-input.v2' },
    { parserResponderCapability: '' },
    { boundarySourceSeq: 41 },
    { checkpointEpoch: '-1' },
    { snapshotSeq: '050' },
    { drainedThroughSourceSeq: '052' },
    { checkpointApplied: false },
    { postSnapshotTailDrained: false },
    { affectedViewCount: 0 },
    { affectedViewCount: 1.5 },
  ] as const) {
    assert.equal(
      parseResponderHandoff({ ...enableFrame, ...mutation }).ok,
      false,
      `legacy responder enable identity must fail closed for ${JSON.stringify(mutation)}`,
    );
  }
});

test('frontend and server expose the exact same checkpoint wire declarations', () => {
  const frontend = readFileSync(new URL('../../src/types/ws-protocol.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../../server/src/types/ws-protocol.ts', import.meta.url), 'utf8');
  assert.equal(checkpointContract(frontend), checkpointContract(server));
});

test('MIG-BGSTAB-002 checkpoint ACK rejections reject malformed identity correlation metadata', () => {
  const valid = {
    type: 'terminal-checkpoint:rejected',
    supportedProtocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    phase: 'ack',
    reason: 'checkpoint-not-active',
    sessionId: 'session-checkpoint-1',
    ackIdentity: {
      sessionId: 'session-checkpoint-1',
      connectionId: 'connection-1',
      viewGeneration: 7,
      streamEpoch: '9',
      checkpointEpoch: '4',
    },
  };
  assert.equal(parseTerminalCheckpointServerMessage(valid).ok, true);
  for (const mutation of [
    { sessionId: '' },
    { connectionId: '' },
    { viewGeneration: -1 },
    { streamEpoch: '09' },
    { checkpointEpoch: '-1' },
  ] as const) {
    assert.equal(
      parseTerminalCheckpointServerMessage({
        ...valid,
        ackIdentity: { ...valid.ackIdentity, ...mutation },
      }).ok,
      false,
      `ack rejection identity must fail closed for ${JSON.stringify(mutation)}`,
    );
  }
});

test('WebSocket ingress validates every checkpoint-prefixed frame before routing or mutation', () => {
  const context = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');
  const prefixGuard = context.indexOf("rawMessage.type.startsWith('terminal-checkpoint:')");
  const parseCall = context.indexOf('parseTerminalCheckpointServerMessage(rawMessage)', prefixGuard);
  const normalRouteCast = context.indexOf('const msg = rawMessage as ServerWsMessage', parseCall);
  assert.ok(prefixGuard >= 0 && parseCall > prefixGuard && normalRouteCast > parseCall);
  assert.match(context.slice(parseCall, normalRouteCast), /terminal-checkpoint:failure-ack/);
  assert.match(context.slice(parseCall, normalRouteCast), /terminal_checkpoint_inactive_frame_rejected/);
  assert.match(context.slice(parseCall, normalRouteCast), /return;/);
});

test('checkpoint server contract rejects JSON numbers and every noncanonical Ordinal64 form', () => {
  const fields = ['streamEpoch', 'checkpointEpoch', 'sourceSeq', 'snapshotSeq', 'oldestRetainedSeq'] as const;
  const invalidValues: readonly unknown[] = [1, -1, 1.5, '01', '+1', '-1', ' 1', '1 ', '', '18446744073709551616'];
  for (const field of fields) {
    for (const value of invalidValues) {
      const frame = startMessage();
      frame[field] = value;
      assert.equal(
        parseTerminalCheckpointServerMessage(frame).ok,
        false,
        `${field}=${JSON.stringify(value)} must fail closed`,
      );
    }
  }
});

test('checkpoint server contract rejects malformed transaction metadata before dispatch', () => {
  const mutations: Array<(frame: Record<string, unknown>) => void> = [
    frame => { frame.protocolVersion = 2; },
    frame => { frame.sessionId = ''; },
    frame => { frame.viewGeneration = -1; },
    frame => { frame.retentionPolicyId = ''; },
    frame => { frame.sourceGeometry = { cols: 0, rows: 48 }; },
    frame => { frame.chunkCount = 0; },
    frame => { frame.encodedByteTotal = -1; },
    frame => { frame.digest = { algorithm: 'sha256', hex: SHA256.toUpperCase() }; },
    frame => { frame.modes = { bracketedPaste: 'yes' }; },
    frame => { frame.parserTail = { encoding: 'base64', data: 'not base64', encodedBytes: 2 }; },
    frame => { frame.parserTail = { encoding: 'base64', data: 'G1s=', encodedBytes: 1 }; },
  ];
  for (const mutate of mutations) {
    const frame = startMessage();
    mutate(frame);
    assert.equal(parseTerminalCheckpointServerMessage(frame).ok, false);
  }

  assert.equal(parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:chunk',
    ...identity(),
    chunkIndex: 2,
    chunkCount: 2,
    encoding: 'base64',
    data: 'YWJj',
    encodedBytes: 3,
  }).ok, false);

  assert.equal(parseTerminalCheckpointServerMessage({
    ...startMessage(),
    sourceSeq: '0',
  }).ok, false, 'sourceSeq cannot precede snapshotSeq');

  assert.equal(parseTerminalCheckpointServerMessage({
    ...startMessage(),
    modes: { unsupportedMode: true },
  }).ok, false, 'unsupported mode must fail before parser reset/resize');
});

test('checkpoint capability response is explicit and cannot silently activate authority', () => {
  const result = parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:capability',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    accepted: true,
    authorityMode: 'legacy',
    checkpointDeliveryActive: false,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: [{ sessionId: 'session-checkpoint-1', viewGeneration: 7 }],
    mutationLeases: [{
      sessionId: 'session-checkpoint-1', authorityEpoch: 'epoch-1',
      viewGeneration: 7, leaseGeneration: 'lease-1',
    }],
  });
  assert.equal(result.ok, true);
  if (result.ok && result.message.type === 'terminal-checkpoint:capability') {
    assert.equal(result.message.checkpointDeliveryActive, false);
    assert.equal(result.message.authorityMode, 'legacy');
  }
  assert.equal(parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:capability',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    accepted: true,
    authorityMode: 'legacy',
    checkpointDeliveryActive: false,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    mutationLeases: [{
      sessionId: 'session-checkpoint-1', authorityEpoch: '',
      viewGeneration: 7, leaseGeneration: 'lease-1',
    }],
  }).ok, false, 'invalid mutation identity must be rejected before it can fence a write');
});

test('MIG-BGSTAB-002 compatibility recovery role is narrowly scoped to passive legacy snapshots', () => {
  const capability = {
    type: 'terminal-checkpoint:capability',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    accepted: true,
    authorityMode: 'legacy',
    checkpointDeliveryActive: false,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: [{ sessionId: 'session-checkpoint-1', viewGeneration: 7 }],
  } as const;
  const passive = parseTerminalCheckpointServerMessage({
    ...capability,
    compatibilityRecoveryRole: 'passive-snapshot',
  });
  assert.equal(passive.ok, true);
  if (passive.ok && passive.message.type === 'terminal-checkpoint:capability') {
    assert.equal(passive.message.compatibilityRecoveryRole, 'passive-snapshot');
  }
  for (const invalid of [
    { compatibilityRecoveryRole: 'unexpected-role' },
    { authorityMode: 'checkpoint', checkpointDeliveryActive: true, compatibilityRecoveryRole: 'passive-snapshot' },
  ] as const) {
    assert.equal(parseTerminalCheckpointServerMessage({
      ...capability,
      ...invalid,
    }).ok, false, 'only the legacy passive recovery capability may carry a recovery role');
  }
});

test('MIG-BGSTAB-002 server responder grant carries one canonical authority generation', () => {
  const grant = {
    sessionId: 'session-checkpoint-1',
    viewGeneration: 7,
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
    authorityStreamEpoch: '9',
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    viewAttributesChallengeId: 'view-attributes-challenge-9',
  } as const;
  const capability = (registeredView: Record<string, unknown>) => ({
    type: 'terminal-checkpoint:capability',
    protocolVersion: TERMINAL_CHECKPOINT_PROTOCOL_VERSION,
    accepted: true,
    authorityMode: 'legacy',
    checkpointDeliveryActive: false,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: [registeredView],
  });
  assert.equal(parseTerminalCheckpointServerMessage(capability(grant)).ok, true);
  assert.equal(parseTerminalCheckpointServerMessage(capability({
    ...grant,
    authorityStreamEpoch: undefined,
  })).ok, false, 'browser-authored lease generations must not pass without a server stream grant');
  assert.equal(parseTerminalCheckpointServerMessage(capability({
    ...grant,
    driverLeaseGeneration: '8',
  })).ok, false, 'mixed responder generations must fail closed');
  assert.equal(parseTerminalCheckpointServerMessage(capability({
    ...grant,
    authorityStreamEpoch: '09',
  })).ok, false, 'authority generation must use canonical uint64 encoding');
});

test('future active checkpoint capability is explicit while the current server default remains passive', () => {
  const active = parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:capability',
    protocolVersion: 1,
    accepted: true,
    authorityMode: 'checkpoint',
    checkpointDeliveryActive: true,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: [{ sessionId: 'session-checkpoint-1', viewGeneration: 7 }],
  });
  assert.equal(active.ok, true);
  assert.equal(parseTerminalCheckpointServerMessage({
    type: 'terminal-checkpoint:capability',
    protocolVersion: 1,
    accepted: true,
    authorityMode: 'checkpoint',
    checkpointDeliveryActive: true,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
  }).ok, false, 'active capability must acknowledge negotiated view generations');

  for (const mismatched of [
    { authorityMode: 'legacy', checkpointDeliveryActive: true },
    { authorityMode: 'checkpoint', checkpointDeliveryActive: false },
  ] as const) {
    assert.equal(parseTerminalCheckpointServerMessage({
      type: 'terminal-checkpoint:capability',
      protocolVersion: 1,
      accepted: true,
      ...mismatched,
      ordinalEncoding: 'canonical-uint64-decimal',
      digestAlgorithms: ['sha256'],
    }).ok, false);
  }

  const serverSource = readFileSync(new URL('../../../server/src/ws/WsRouter.ts', import.meta.url), 'utf8');
  assert.match(serverSource, /for \(const registeredView of registeredViews\)/u);
  assert.match(serverSource, /registeredViews: \[registeredView\]/u);
  assert.match(serverSource, /checkpointDeliveryActive: authorityMode === 'checkpoint'/u);
  assert.doesNotMatch(serverSource, /authorityModes\.includes\('checkpoint'\)/u,
    'one active session must not promote every registered session capability');
});

test('MIG-BGSTAB-002 prepared checkpoint delivery capability is bound to its registered server view', () => {
  const registeredView = {
    sessionId: 'session-checkpoint-1',
    viewGeneration: 7,
    queryReplyCapability: 'terminal.query-reply-input.v1',
    parserResponderCapability: 'terminal.parser-responder-disable.v1',
    authorityStreamEpoch: '9',
    driverLeaseGeneration: '9',
    acceptedViewAttributesGeneration: '9',
    viewAttributesChallengeId: 'view-attributes-challenge-9',
  } as const;
  const capability = {
    type: 'terminal-checkpoint:capability',
    protocolVersion: 1,
    accepted: true,
    authorityMode: 'checkpoint',
    checkpointDeliveryActive: true,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: [registeredView],
    checkpointDeliveryPreparation: {
      checkpointDeliveryId: 'delivery-9',
      authorityEpoch: 'authority-9',
      streamEpoch: '9',
      viewGeneration: 7,
      driverLeaseGeneration: '9',
      acceptedViewAttributesGeneration: '9',
      viewAttributesChallengeId: 'view-attributes-challenge-9',
    },
  } as const;
  assert.equal(parseTerminalCheckpointServerMessage(capability).ok, true);
  for (const invalid of [
    { checkpointDeliveryId: '' },
    { viewGeneration: 8 },
    { streamEpoch: '8' },
    { viewAttributesChallengeId: 'wrong-challenge' },
  ] as const) {
    assert.equal(parseTerminalCheckpointServerMessage({
      ...capability,
      checkpointDeliveryPreparation: {
        ...capability.checkpointDeliveryPreparation,
        ...invalid,
      },
    }).ok, false);
  }
  assert.equal(parseTerminalCheckpointServerMessage({
    ...capability,
    authorityMode: 'legacy',
    checkpointDeliveryActive: false,
  }).ok, false);
});

test('RED reviewer — negotiated mutation lease is attached only to matching input and resize frames', () => {
  const leases = new Map([['session-checkpoint-1', {
    sessionId: 'session-checkpoint-1',
    authorityEpoch: 'authority-epoch-1',
    viewGeneration: 7,
    leaseGeneration: 'lease-1',
  }]]);
  const identity = {
    authorityEpoch: 'authority-epoch-1',
    viewGeneration: 7,
    leaseGeneration: 'lease-1',
  };
  assert.deepEqual(
    attachRetainedMutationLease({
      type: 'input', sessionId: 'session-checkpoint-1', data: 'input',
    }, leases),
    { type: 'input', sessionId: 'session-checkpoint-1', data: 'input', retainedIdentity: identity },
  );
  assert.deepEqual(
    attachRetainedMutationLease({
      type: 'resize', sessionId: 'session-checkpoint-1', cols: 80, rows: 24,
    }, leases),
    { type: 'resize', sessionId: 'session-checkpoint-1', cols: 80, rows: 24, retainedIdentity: identity },
  );
  assert.deepEqual(
    attachRetainedMutationLease({ type: 'input', sessionId: 'other', data: 'legacy' }, leases),
    { type: 'input', sessionId: 'other', data: 'legacy' },
  );
  assert.deepEqual(
    attachRetainedMutationLease({ type: 'ping' }, leases),
    { type: 'ping' },
  );
});

test('RED reviewer — dispatcher cleanup removes its lease before listing remaining views for renegotiation', () => {
  const lifecycle: string[] = [];
  const leases = new Map([
    ['removed-session', {
      sessionId: 'removed-session',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 7,
      leaseGeneration: 'lease-1',
    }],
    ['remaining-session', {
      sessionId: 'remaining-session',
      authorityEpoch: 'authority-epoch-1',
      viewGeneration: 3,
      leaseGeneration: 'lease-2',
    }],
  ]);
  const remainingViews = [{ sessionId: 'remaining-session', viewGeneration: 3 }] as const;

  const views = releaseTerminalCheckpointDispatcherRegistration({
    sessionId: 'removed-session',
    leases,
    unregister: () => {
      lifecycle.push('unregister');
      return true;
    },
    listViews: () => {
      lifecycle.push('list-views');
      assert.equal(leases.has('removed-session'), false, 'stale lease survived local unregister');
      return remainingViews;
    },
  });

  assert.deepEqual(lifecycle, ['unregister', 'list-views']);
  assert.deepEqual(views, remainingViews);
  assert.equal(leases.has('remaining-session'), true);

  const replacementLease = new Map([['removed-session', {
    sessionId: 'removed-session',
    authorityEpoch: 'authority-epoch-2',
    viewGeneration: 8,
    leaseGeneration: 'lease-replacement',
  }]]);
  const replacementViews = [{ sessionId: 'removed-session', viewGeneration: 8 }] as const;
  assert.deepEqual(releaseTerminalCheckpointDispatcherRegistration({
    sessionId: 'removed-session',
    leases: replacementLease,
    unregister: () => false,
    listViews: () => replacementViews,
  }), replacementViews);
  assert.equal(
    replacementLease.has('removed-session'),
    true,
    'a stale disposer must not remove the replacement dispatcher lease',
  );

  const context = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');
  const registration = context.indexOf('const registerTerminalCheckpointDispatcher = useCallback');
  const registrationEnd = context.indexOf('const requestReconnect = useCallback', registration);
  const cleanupContract = context.slice(registration, registrationEnd);
  assert.match(cleanupContract, /releaseTerminalCheckpointDispatcherRegistration/u);
  assert.match(cleanupContract, /requestTerminalCheckpointCapability/u);
});

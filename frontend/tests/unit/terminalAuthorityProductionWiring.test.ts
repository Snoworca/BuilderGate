import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseTerminalResponderHandoffServerMessage } from '../../src/types/ws-protocol.ts';

const VIEW = {
  connectionId: 'connection-a',
  viewGeneration: 7,
  responderLeaseId: 'responder-browser-7',
  queryReplyCapability: 'terminal.query-reply-input.v1',
  parserResponderCapability: 'terminal.parser-responder-disable.v1',
  driverLeaseGeneration: '7',
  acceptedViewAttributesGeneration: '7',
} as const;

test('MIG-BGSTAB-002 production parser accepts full disable and rollback boundaries only', () => {
  const disable = {
    type: 'terminal-authority:responder-disable-boundary',
    sessionId: 'session-1',
    transitionEpoch: '8',
    authorityEpoch: 'authority-7',
    streamEpoch: '8',
    boundarySourceSeq: '41',
    responderLeaseId: VIEW.responderLeaseId,
    requiredResponderViews: [VIEW],
  } as const;
  const rollback = {
    type: 'terminal-authority:rollback-start',
    source: 'server-controller',
    sessionId: 'session-1',
    transitionEpoch: '9',
    authorityEpoch: 'authority-7',
    streamEpoch: '9',
    responderLeaseId: 'responder-compatibility-9',
    driverLeaseId: 'driver-compatibility-9',
    boundarySourceSeq: '52',
    checkpointEpoch: '9001',
    affectedViews: [VIEW],
  } as const;

  assert.deepEqual(parseTerminalResponderHandoffServerMessage(disable), {
    ok: true,
    message: disable,
  });
  assert.deepEqual(parseTerminalResponderHandoffServerMessage(rollback), {
    ok: true,
    message: rollback,
  });
  assert.equal(parseTerminalResponderHandoffServerMessage({
    ...disable,
    transitionEpoch: '08',
  }).ok, false);
  assert.equal(parseTerminalResponderHandoffServerMessage({
    ...rollback,
    affectedViews: [{ ...VIEW, connectionId: '' }],
  }).ok, false);
});

test('MIG-BGSTAB-002 production wiring preserves user-input order and generation ownership', () => {
  const context = readFileSync(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
    'utf8',
  );
  const view = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const container = readFileSync(
    new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
    'utf8',
  );

  const typedParse = context.indexOf('parseTerminalResponderHandoffServerMessage(rawMessage)');
  const genericCast = context.indexOf('const msg = rawMessage as ServerWsMessage');
  assert.ok(typedParse >= 0 && genericCast > typedParse, 'typed authority frames must be parsed before generic ingress');
  assert.match(context, /createTerminalResponderHandoffDispatcher/u);
  assert.match(context, /registerTerminalResponderHandoffView/u);
  assert.match(context, /registerTerminalResponderHandoffRuntime/u);
  assert.match(context, /getTerminalControlSocketReceipt/u);
  assert.match(context, /sendTerminalAuthorityControl/u);

  assert.match(view, /createTerminalResponderHandoffRuntime/u);
  assert.match(view, /createTerminalInputKindRouter/u);
  assert.match(view, /isTerminalQueryReply\(data, \{ provenance: 'parser-generated' \}\)/u);
  assert.match(view, /onResponderDisableBoundary/u);
  assert.match(view, /onRollbackStart/u);
  assert.match(view, /restoreLegacyParserRepliesAfterCompatibilityDrain/u);
  assert.match(view, /flushPendingUserInputBeforeQueryReply\('query-reply-boundary'\)/u);
  assert.match(container, /flushPendingUserInputBeforeQueryReply=\{flushTransportPipeline\}/u);
});

test('MIG-BGSTAB-002 rollback preserves focus before closing the checkpoint input barrier', () => {
  const view = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const rollbackStart = view.indexOf('onRollbackStart: (');
  const rollbackEnd = view.indexOf('onLegacyResponderEnabled:', rollbackStart);
  const rollback = view.slice(rollbackStart, rollbackEnd);

  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  assert.match(
    rollback,
    /queueFocusRestoreIfFocused\('terminal-authority-rollback-start'\);[\s\S]*checkpointInputBarrierRef\.current = true;/u,
    'a focused terminal must retain its restoration intent before rollback fences input',
  );
});

test('MIG-BGSTAB-002 browser capability declaration never authors authority generations', () => {
  const context = readFileSync(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
    'utf8',
  );
  const e2e = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const listStart = context.indexOf('const listNegotiatedTerminalCheckpointViews');
  const listEnd = context.indexOf('const requestCurrentTerminalCheckpointCapability', listStart);
  const listContract = context.slice(listStart, listEnd);
  assert.match(listContract, /queryReplyCapability:\s*'terminal\.query-reply-input\.v1'/u);
  assert.match(listContract, /parserResponderCapability:\s*'terminal\.parser-responder-disable\.v1'/u);
  assert.doesNotMatch(listContract, /driverLeaseGeneration/u);
  assert.doesNotMatch(listContract, /acceptedViewAttributesGeneration/u);
  assert.doesNotMatch(context, /responderNegotiatedGenerationRef/u);

  const openStart = context.indexOf('ws.onopen = () =>');
  const openEnd = context.indexOf('ws.onmessage =', openStart);
  assert.match(
    context.slice(openStart, openEnd),
    /listNegotiatedTerminalCheckpointViews\(\)/u,
    'reconnect must repeat the same capability declaration for the replacement socket',
  );
  assert.doesNotMatch(
    e2e,
    /driverLeaseGeneration:\s*['"](?:1|7)['"]/u,
    'E2E must derive responder authority generations from routed server capability frames',
  );
  assert.doesNotMatch(
    e2e,
    /acceptedViewAttributesGeneration:\s*['"](?:1|7)['"]/u,
    'E2E must not inject accepted attribute generations',
  );
});

test('MIG-BGSTAB-002 E2E same-view renegotiation recognizes the already accepted attribute identity', () => {
  const e2e = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const helperStart = e2e.indexOf('async function registerCapableUnselectedResponder');
  const helperEnd = e2e.indexOf('function unsubscribeUnrelatedSessions', helperStart);
  const helper = e2e.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(
    helper,
    /viewAttributesChallengeId === undefined[\s\S]*return current;/u,
    'an exact same-view capability without a new challenge must settle as an already accepted identity',
  );
});

test('MIG-BGSTAB-002 rollback query parity uses the live input-gate diagnostic', () => {
  const e2e = readFileSync(
    new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url),
    'utf8',
  );
  const rollbackStart = e2e.indexOf("test('compatibility-drain rollback'");
  const rollback = e2e.slice(rollbackStart);

  assert.ok(rollbackStart >= 0);
  assert.match(
    rollback,
    /await waitForVisibleTerminalInputReady\(selectedQueryPage, first\.sessionId\);/u,
    'rollback query parity must surface the current mount gate on timeout',
  );
});

test('MIG-BGSTAB-002 WebSocket status changes do not replace the terminal send callback', () => {
  const context = readFileSync(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
    'utf8',
  );
  const sendStart = context.indexOf('const send = useCallback');
  const sendEnd = context.indexOf('const getTerminalControlSocketReceipt', sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  const sendBlock = context.slice(sendStart, sendEnd);

  assert.match(sendBlock, /statusRef\.current/u);
  assert.doesNotMatch(
    sendBlock,
    /\}, \[status\]\);/u,
    'transport status is diagnostic state and must not remount xterm through callback identity churn',
  );
});

test('MIG-BGSTAB-002 replacement connection retargets output policy without replacing xterm callbacks', () => {
  const view = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const schedulerStart = view.indexOf('const getOutputScheduler = useCallback');
  const schedulerEnd = view.indexOf('const writeOutput = useCallback', schedulerStart);
  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart);
  const schedulerBlock = view.slice(schedulerStart, schedulerEnd);
  assert.match(schedulerBlock, /outputPolicyConfigRef\.current/u);
  assert.doesNotMatch(schedulerBlock, /\boutputPolicyConnectionId\b/u);
  assert.doesNotMatch(schedulerBlock, /\boutputPolicyReconnectGeneration\b/u);
  assert.doesNotMatch(schedulerBlock, /\boutputPolicySelectionCoordinator\b/u);
  assert.doesNotMatch(
    view,
    /const outputPolicyConfigRef = useRef\([\s\S]*?\}\);\s*outputPolicyConfigRef\.current\s*=/u,
    'an interrupted render must not publish an uncommitted output-policy target',
  );
  assert.match(
    view,
    /useLayoutEffect\(\(\) => \{\s*outputPolicyConfigRef\.current = \{\s*connectionId: outputPolicyConnectionId,\s*reconnectGeneration: outputPolicyReconnectGeneration,\s*selectionCoordinator: outputPolicySelectionCoordinator,\s*\};\s*\}, \[\s*outputPolicyConnectionId,\s*outputPolicyReconnectGeneration,\s*outputPolicySelectionCoordinator,\s*\]\);/u,
    'the output-policy target must become visible to stable callbacks only after commit',
  );
});

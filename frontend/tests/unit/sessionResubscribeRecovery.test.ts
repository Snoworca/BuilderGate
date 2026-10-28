import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  chooseVisibleRecoveryTransport,
  createSessionResubscribeFence,
  resubscribeSessionOnSocket,
} from '../../src/utils/sessionResubscribe.ts';

// REL-BGSTAB-055: one terminal's failed recovery resubscribes that session on the shared
// socket instead of closing it, so the other sessions keep their output and input.

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-1/AC-4: every attempt but the last resubscribes; the last reconnects', () => {
  assert.equal(chooseVisibleRecoveryTransport({ attempt: 1, maxAttempts: 3 }), 'resubscribe');
  assert.equal(chooseVisibleRecoveryTransport({ attempt: 2, maxAttempts: 3 }), 'resubscribe');
  assert.equal(chooseVisibleRecoveryTransport({ attempt: 3, maxAttempts: 3 }), 'reconnect');
  assert.equal(chooseVisibleRecoveryTransport({ attempt: 1, maxAttempts: 1 }), 'reconnect');
});

const request = { sessionId: 's1', reason: 'screen-repair-reconnect-required', attempt: 1 };

function recordingDeps() {
  const calls: string[] = [];
  const fence = createSessionResubscribeFence();
  return {
    calls,
    fence,
    deps: {
      isOpen: () => true,
      sharesOneSocket: () => true,
      sendJson: (message: { type: string; sessionIds: string[]; recovery?: { reason: string; attempt: number } }) => {
        const recovery = message.recovery ? `(${message.recovery.reason}#${message.recovery.attempt})` : '';
        calls.push(`${message.type}:${message.sessionIds.join(',')}${recovery}`);
        return true;
      },
      refreshCapabilities: () => { calls.push('negotiate'); },
      retireChannels: (sessionId: string) => { calls.push(`retire:${sessionId}`); },
      dropGraceBuffer: (sessionId: string) => { calls.push(`grace:${sessionId}`); },
      fence,
    },
  };
}

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-1/AC-3, REL-BGSTAB-056 AC-1: the session is unsubscribed with its recovery reason, renegotiated and subscribed in that order', () => {
  const { calls, deps, fence } = recordingDeps();
  assert.equal(resubscribeSessionOnSocket(request, deps), true);
  assert.deepEqual(calls, [
    'grace:s1',
    'retire:s1',
    'unsubscribe:s1(screen-repair-reconnect-required#1)',
    'negotiate',
    'subscribe:s1',
  ]);
  assert.equal(fence.isFenced('s1'), true);
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-4: with the socket not open nothing is sent, so the caller reconnects', () => {
  const { calls, deps, fence } = recordingDeps();
  assert.equal(resubscribeSessionOnSocket(request, { ...deps, isOpen: () => false }), false);
  assert.deepEqual(calls, []);
  assert.equal(fence.isFenced('s1'), false);
});

// @req REL-BGSTAB-056
test('REL-BGSTAB-056 AC-2: with a separate output socket (split) nothing is sent, so the caller reconnects', () => {
  const { calls, deps, fence } = recordingDeps();
  assert.equal(resubscribeSessionOnSocket(request, { ...deps, sharesOneSocket: () => false }), false);
  assert.deepEqual(calls, []);
  assert.equal(fence.isFenced('s1'), false);
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-1: a failed send reports failure so the caller can reconnect instead', () => {
  const { deps, fence } = recordingDeps();
  fence.begin('other');
  assert.equal(resubscribeSessionOnSocket(request, { ...deps, sendJson: () => false }), false);
  assert.equal(fence.isFenced('s1'), false, 'a fence nobody will lift is not left behind');
  assert.equal(fence.isFenced('other'), true, 'another session keeps its fence');
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-3: frames of the old subscription are dropped until the unsubscribed reply', () => {
  const fence = createSessionResubscribeFence();
  fence.begin('s1');
  assert.deepEqual(fence.admit({ type: 'screen-snapshot', sessionId: 's1' }), { deliver: false, sessionId: 's1', type: 'screen-snapshot' });
  assert.deepEqual(fence.admit({ type: 'output', sessionId: 's2' }), { deliver: true }, 'other sessions pass');
  assert.deepEqual(fence.admit({ type: 'input:rejected', sessionId: 's1' }), { deliver: true }, 'input replies always pass');
  assert.equal(fence.consumeMarker({ type: 'unsubscribed', sessionId: 's2' }), true);
  assert.equal(fence.isFenced('s1'), true, 'a reply for another session does not lift it');
  assert.equal(fence.consumeMarker({ type: 'unsubscribed', sessionId: 's1' }), true);
  assert.equal(fence.isFenced('s1'), false);
  // The server sends the new snapshot before its subscribed reply; it must get through.
  assert.deepEqual(fence.admit({ type: 'screen-snapshot', sessionId: 's1' }), { deliver: true });
  assert.equal(fence.consumeMarker({ type: 'screen-snapshot', sessionId: 's1' }), false);
  assert.deepEqual(fence.admit('not a record'), { deliver: true });
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-3: a reply to an earlier unsubscribe of the same session does not lift the fence', () => {
  const fence = createSessionResubscribeFence();
  fence.noteUnsubscribeSent('s1'); // e.g. an unmount's delayed unsubscribe, reply still in flight
  fence.begin('s1');
  fence.noteUnsubscribeSent('s1'); // the resubscribe's own unsubscribe
  fence.consumeMarker({ type: 'unsubscribed', sessionId: 's1' });
  assert.equal(fence.isFenced('s1'), true, 'the first reply answers the earlier unsubscribe');
  fence.consumeMarker({ type: 'unsubscribed', sessionId: 's1' });
  assert.equal(fence.isFenced('s1'), false);
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-4: a closed socket clears every fence', () => {
  const fence = createSessionResubscribeFence();
  fence.begin('s1');
  fence.clear();
  assert.equal(fence.isFenced('s1'), false);
});

const containerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);
const contextSource = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-1/AC-2/AC-5: bounded recovery resubscribes the session after dropping its recovery state', () => {
  const start = containerSource.indexOf('const requestBoundedVisibleRecoveryReconnect = useCallback');
  assert.notEqual(start, -1);
  const chunk = containerSource.slice(start, start + 2400);
  assert.match(chunk, /chooseVisibleRecoveryTransport\(/);
  assert.match(chunk, /prepareSessionResubscribe\(/);
  assert.match(chunk, /resubscribeSession\(sessionId, \{ reason, attempt: decision\.attempt \}\)/);
  assert.match(chunk, /'visible_output_resync_resubscribe_requested'/);
  assert.ok(
    chunk.indexOf('prepareSessionResubscribe(') < chunk.indexOf('resubscribeSession(sessionId,'),
    'the recovery state is dropped before the resubscribe is sent',
  );
});

// @req REL-BGSTAB-055
test('REL-BGSTAB-055 AC-3: the context fences JSON frames before any routing and clears fences on a new socket', () => {
  const handleStart = contextSource.indexOf('const rawMessage: unknown = frame.message;');
  assert.notEqual(handleStart, -1);
  const afterRaw = contextSource.slice(handleStart, handleStart + 900);
  assert.match(afterRaw, /resubscribeFenceRef\.current\.consumeMarker\(rawMessage\)/);
  assert.match(afterRaw, /resubscribeFenceRef\.current\.admit\(rawMessage\)/);
  assert.match(contextSource, /resubscribeSession: \(sessionId: string, recovery: SessionRecoveryReason\) => boolean/);
  assert.match(contextSource, /sharesOneSocket: \(\) => outputWsRef\.current === null/);
  const onOpen = contextSource.indexOf('ws.onopen = () => {');
  assert.match(contextSource.slice(onOpen, onOpen + 900), /resubscribeFenceRef\.current\.clear\(\)/);
});

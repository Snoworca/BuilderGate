import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as webSocketBackpressure from '../../src/utils/webSocketBackpressure.ts';
import {
  evaluateBrowserInputBackpressure,
  getBrowserInputBackpressureLowWaterBytes,
  getUtf8ByteLength,
  isBrowserInputBackpressureRecovered,
  readOpenBrowserBufferedAmount,
} from '../../src/utils/webSocketBackpressure.ts';

const LIMITS = {
  inputBackpressureBytes: 10,
  hardReconnectBytes: 20,
};

test('browser backpressure allows non-input control messages even when buffered amount is high', () => {
  const decision = evaluateBrowserInputBackpressure({
    messageType: 'screen-snapshot:ready',
    serializedPayload: '{"type":"screen-snapshot:ready"}',
    bufferedAmount: 1_000_000,
    limits: LIMITS,
  });

  assert.deepEqual(decision, { action: 'send' });
});

test('browser backpressure allows input below soft threshold', () => {
  const decision = evaluateBrowserInputBackpressure({
    messageType: 'input',
    serializedPayload: 'abc',
    bufferedAmount: 4,
    limits: LIMITS,
  });

  assert.deepEqual(decision, { action: 'send' });
});

test('browser backpressure rejects input when queued bytes would cross soft threshold', () => {
  const decision = evaluateBrowserInputBackpressure({
    messageType: 'input',
    serializedPayload: 'abcd',
    bufferedAmount: 7,
    limits: LIMITS,
  });

  assert.deepEqual(decision, {
    action: 'backpressure',
    reason: 'client-backpressure',
    bufferedAmount: 7,
    payloadBytes: 4,
  });
});

test('browser backpressure requests hard reconnect at the hard threshold', () => {
  const decision = evaluateBrowserInputBackpressure({
    messageType: 'input',
    serializedPayload: 'a',
    bufferedAmount: 20,
    limits: LIMITS,
  });

  assert.deepEqual(decision, {
    action: 'hard-reconnect',
    reason: 'client-hard-backpressure',
    bufferedAmount: 20,
    payloadBytes: 1,
  });
});

test('browser backpressure treats invalid buffered amount as zero', () => {
  const decision = evaluateBrowserInputBackpressure({
    messageType: 'input',
    serializedPayload: 'abcd',
    bufferedAmount: Number.POSITIVE_INFINITY,
    limits: LIMITS,
  });

  assert.deepEqual(decision, { action: 'send' });
});

test('browser backpressure counts UTF-8 bytes instead of UTF-16 code units', () => {
  assert.equal(getUtf8ByteLength('한'), 3);

  const decision = evaluateBrowserInputBackpressure({
    messageType: 'input',
    serializedPayload: '한',
    bufferedAmount: 8,
    limits: LIMITS,
  });

  assert.deepEqual(decision, {
    action: 'backpressure',
    reason: 'client-backpressure',
    bufferedAmount: 8,
    payloadBytes: 3,
  });
});

test('browser backpressure recovery requires buffered amount below low water', () => {
  const limits = {
    inputBackpressureBytes: 1000,
    hardReconnectBytes: 4000,
  };

  assert.equal(getBrowserInputBackpressureLowWaterBytes(limits), 500);
  assert.equal(isBrowserInputBackpressureRecovered(500, limits), false);
  assert.equal(isBrowserInputBackpressureRecovered(499, limits), true);
});

test('browser backpressure recovery can read buffered amount without sending probe frames', () => {
  let sendCalled = false;
  const socketLike = {
    readyState: 1,
    bufferedAmount: 750,
    send: () => {
      sendCalled = true;
    },
  };

  assert.equal(readOpenBrowserBufferedAmount(socketLike), 750);
  assert.equal(sendCalled, false);
  assert.equal(readOpenBrowserBufferedAmount({ readyState: 3, bufferedAmount: 750 }), null);
  assert.equal(readOpenBrowserBufferedAmount({ readyState: 1, bufferedAmount: Number.NaN }), 0);
});

test('browser websocket send gate applies input backpressure before sending', () => {
  const sendOpenBrowserWebSocketMessage = (webSocketBackpressure as any).sendOpenBrowserWebSocketMessage;
  assert.equal(typeof sendOpenBrowserWebSocketMessage, 'function');

  const limits = {
    inputBackpressureBytes: 100,
    hardReconnectBytes: 1000,
  };
  const sent: string[] = [];
  const result = sendOpenBrowserWebSocketMessage({
    message: { type: 'input', sessionId: 'session-1', data: 'abc' },
    socket: {
      readyState: 1,
      bufferedAmount: limits.inputBackpressureBytes,
      send: (payload: string) => {
        sent.push(payload);
      },
    },
    limits,
    openReadyState: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'client-backpressure');
  assert.deepEqual(sent, []);
});

test('browser websocket send gate lets control messages bypass input backpressure', () => {
  const sendOpenBrowserWebSocketMessage = (webSocketBackpressure as any).sendOpenBrowserWebSocketMessage;
  assert.equal(typeof sendOpenBrowserWebSocketMessage, 'function');

  const sent: string[] = [];
  const result = sendOpenBrowserWebSocketMessage({
    message: { type: 'screen-snapshot:ready', sessionId: 'session-1', replayToken: 'token-1' },
    socket: {
      readyState: 1,
      bufferedAmount: LIMITS.hardReconnectBytes,
      send: (payload: string) => {
        sent.push(payload);
      },
    },
    limits: LIMITS,
    openReadyState: 1,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /screen-snapshot:ready/);
});

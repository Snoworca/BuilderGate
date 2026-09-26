import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildControlWebSocketUrl,
  buildSplitOutputWebSocketUrl,
  createWebSocketConnectAttemptFence,
} from '../../src/utils/webSocketUrl.ts';

const location = {
  protocol: 'https:',
  host: 'localhost:2202',
};

test('control websocket URL stays unified when transport mode is unified', () => {
  assert.equal(
    buildControlWebSocketUrl({ token: 'jwt-token', location, transportMode: 'unified' }),
    'wss://localhost:2202/ws?token=jwt-token',
  );
});

test('control websocket URL opts into split control for split and split-shadow modes', () => {
  assert.equal(
    buildControlWebSocketUrl({ token: 'jwt-token', location, transportMode: 'split' }),
    'wss://localhost:2202/ws?token=jwt-token&mode=split&channel=control',
  );
  assert.equal(
    buildControlWebSocketUrl({ token: 'jwt-token', location, transportMode: 'split-shadow' }),
    'wss://localhost:2202/ws?token=jwt-token&mode=split&channel=control',
  );
});

test('split output websocket URL is created only from split control metadata', () => {
  assert.equal(
    buildSplitOutputWebSocketUrl({
      token: 'jwt-token',
      location,
      metadata: {
        wsTransportMode: 'split',
        channel: 'control',
        clientGroupId: 'group-1',
        pairToken: 'pair-token',
      },
    }),
    'wss://localhost:2202/ws?token=jwt-token&mode=split&channel=output&clientGroupId=group-1&pairToken=pair-token',
  );

  assert.equal(buildSplitOutputWebSocketUrl({
    token: 'jwt-token',
    location,
    metadata: {
      wsTransportMode: 'split-shadow',
      channel: 'control',
      clientGroupId: 'group-1',
      pairToken: 'pair-token',
    },
  }), null);

  assert.equal(buildSplitOutputWebSocketUrl({
    token: 'jwt-token',
    location,
    metadata: {
      wsTransportMode: 'split',
      channel: 'output',
      clientGroupId: 'group-1',
      pairToken: 'pair-token',
    },
  }), null);
});

test('MIG-BGSTAB-002 async connect fence invalidates StrictMode predecessors and final cleanup', () => {
  const fence = createWebSocketConnectAttemptFence();
  const staleMount = fence.begin();
  const currentMount = fence.begin();
  assert.equal(fence.isCurrent(staleMount), false);
  assert.equal(fence.isCurrent(currentMount), true);
  fence.invalidate();
  assert.equal(fence.isCurrent(currentMount), false);
});


// --- #111 / #18 criterion 11: the connect URL carries the logical client -----------

test('#111 the control URL carries the logical client id so dedup can survive a reconnect', () => {
  const url = buildControlWebSocketUrl({
    token: 'jwt-token',
    location: { protocol: 'https:', host: 'localhost:2222' },
    transportMode: 'unified',
    logicalClientId: 'tab-abc',
  });

  // Before this the URL carried only token/mode/channel, so the server had nothing stable
  // to key a dedup record by and keyed it by the connection instead -- which is why a
  // resent input ran twice after a reconnect.
  assert.equal(new URL(url).searchParams.get('logicalClientId'), 'tab-abc');
});

test('#111 omitting the logical client id leaves the parameter off entirely', () => {
  const url = buildControlWebSocketUrl({
    token: 'jwt-token',
    location: { protocol: 'https:', host: 'localhost:2222' },
    transportMode: 'unified',
  });

  // An empty parameter would be a claim of identity the client cannot back. Absent means
  // absent, and the server falls back to the connection-scoped behaviour.
  assert.equal(new URL(url).searchParams.has('logicalClientId'), false);
});

test('#111 a blank logical client id is treated as absent, not sent as empty', () => {
  const url = buildControlWebSocketUrl({
    token: 'jwt-token',
    location: { protocol: 'https:', host: 'localhost:2222' },
    transportMode: 'unified',
    logicalClientId: '   ',
  });

  assert.equal(new URL(url).searchParams.has('logicalClientId'), false);
});

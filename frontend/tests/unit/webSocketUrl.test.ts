import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildControlWebSocketUrl,
  buildSplitOutputWebSocketUrl,
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


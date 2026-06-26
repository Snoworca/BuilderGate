import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseWsTransportRequest,
  type WsTransportMode,
} from './wsTransportMode.js';

function parse(rawPath: string, configuredMode: WsTransportMode = 'unified') {
  return parseWsTransportRequest(
    new URL(rawPath, 'https://localhost'),
    configuredMode,
  );
}

test('ws transport parser keeps legacy websocket requests in unified mode', () => {
  assert.deepEqual(parse('/ws?token=t'), {
    ok: true,
    requestedMode: 'unified',
    channelRole: 'single',
  });
});

test('ws transport parser rejects split opt-in while feature flag is unified', () => {
  const result = parse('/ws?token=t&mode=split&channel=control', 'unified');

  assert.deepEqual(result, {
    ok: false,
    statusCode: 400,
    reason: 'split-disabled',
  });
});

test('ws transport parser accepts split-shadow control channel', () => {
  assert.deepEqual(parse('/ws?token=t&mode=split&channel=control', 'split-shadow'), {
    ok: true,
    requestedMode: 'split-shadow',
    channelRole: 'control',
  });
});

test('ws transport parser accepts split control and output channels', () => {
  assert.deepEqual(parse('/ws?token=t&mode=split&channel=control', 'split'), {
    ok: true,
    requestedMode: 'split',
    channelRole: 'control',
  });
  assert.deepEqual(
    parse('/ws?token=t&mode=split&channel=output&clientGroupId=g1&pairToken=p1', 'split'),
    {
      ok: true,
      requestedMode: 'split',
      channelRole: 'output',
      clientGroupId: 'g1',
      pairToken: 'p1',
    },
  );
});

test('ws transport parser requires pairing fields for split output channel', () => {
  assert.deepEqual(parse('/ws?token=t&mode=split&channel=output', 'split-shadow'), {
    ok: false,
    statusCode: 400,
    reason: 'missing-output-pairing',
  });

  assert.deepEqual(
    parse('/ws?token=t&mode=split&channel=output&clientGroupId=g1&pairToken=p1', 'split-shadow'),
    {
      ok: true,
      requestedMode: 'split-shadow',
      channelRole: 'output',
      clientGroupId: 'g1',
      pairToken: 'p1',
    },
  );
});

test('ws transport parser rejects invalid split channel names', () => {
  assert.deepEqual(parse('/ws?token=t&mode=split&channel=sideband', 'split-shadow'), {
    ok: false,
    statusCode: 400,
    reason: 'invalid-channel',
  });
});

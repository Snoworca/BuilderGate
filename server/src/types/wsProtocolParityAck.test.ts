import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as server from './ws-protocol.js';
import type { ServerWsMessage, TerminalDeliveryAckMessage, TerminalDeliveryAckRejectedMessage } from './ws-protocol.js';

function productionTypeContracts() {
  const legacy: TerminalDeliveryAckMessage = { type: 'terminal-delivery:ack', sessionId: 's', connectionEpoch: 'c', deliverySeq: 1 };
  const source: TerminalDeliveryAckMessage = { type: 'terminal-delivery:ack', sessionId: 's', connectionEpoch: 'c', kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '1' };
  const rejection: TerminalDeliveryAckRejectedMessage = { ...source, type: 'terminal-delivery:ack-rejected', reason: 'ACK_OVER_ACK' };
  const routedSource: ServerWsMessage = {
    type: 'terminal-delivery:ack-rejected', sessionId: 's', connectionEpoch: 'c',
    kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '1', reason: 'ACK_OVER_ACK',
  };
  // @ts-expect-error The actual outbound wire union must reject mixed-domain rejections.
  const routedMixed: ServerWsMessage = { type: 'terminal-delivery:ack-rejected', sessionId: 's', connectionEpoch: 'c', kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '1', deliverySeq: 1, reason: 'ACK_OVER_ACK' };
  // @ts-expect-error An ACK cannot inhabit both identity domains.
  const mixed: TerminalDeliveryAckMessage = { ...source, deliverySeq: 1 };
  // @ts-expect-error Source identity requires the epoch.
  const missing: TerminalDeliveryAckMessage = { type: 'terminal-delivery:ack', sessionId: 's', connectionEpoch: 'c', kind: 'sourceSeq', sourceSeq: '1' };
  // @ts-expect-error Rejection identity must also preserve domain exclusivity.
  const mixedRejection: TerminalDeliveryAckRejectedMessage = { ...rejection, deliverySeq: 1 };
  return { legacy, source, rejection, routedSource, routedMixed, mixed, missing, mixedRejection };
}
void productionTypeContracts;

// PERF-BGSTAB-011 AC-10 / PERF-BGSTAB-010 AC-5/6: exercise both real parsers.
const frontendUrl = new URL('../../../frontend/src/types/ws-protocol.ts', import.meta.url);
const frontend = await import(frontendUrl.href);
type Parser = (input: unknown) => { ok: boolean; message?: unknown; reason?: string };
const common = { sessionId: 'session-a', connectionEpoch: 'connection-a' };
const source = { kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '9007199254740993' };

const accepted: Array<Record<string, unknown>> = [
  { deliverySeq: 1 }, { kind: 'deliverySeq', deliverySeq: Number.MAX_SAFE_INTEGER },
  source,
  ...['0', '9007199254740992', '9007199254740993', '18446744073709551615'].map(ordinal => ({
    kind: 'sourceSeq', streamEpoch: ordinal, sourceSeq: ordinal,
  })),
];
const rejected: Array<[Record<string, unknown>, string]> = [
  [{}, 'ACK_DOMAIN_MISSING'],
  [{ kind: 'sourceSeq' }, 'ACK_DOMAIN_MISSING'],
  [{ ...source, deliverySeq: 1 }, 'ACK_DOMAIN_CONFLICT'],
  [{ deliverySeq: 1, streamEpoch: '7' }, 'ACK_DOMAIN_CONFLICT'],
  [{ kind: 'sourceSeq', sourceSeq: '1' }, 'ACK_DOMAIN_INVALID'],
  [{ kind: 'sourceSeq', streamEpoch: '7' }, 'ACK_DOMAIN_INVALID'],
  [{ streamEpoch: '7', sourceSeq: '1' }, 'ACK_DOMAIN_INVALID'],
  [{ ...source, kind: 'deliverySeq' }, 'ACK_DOMAIN_INVALID'],
  [{ kind: 'unknown', deliverySeq: 1 }, 'ACK_DOMAIN_INVALID'],
  [{ kind: 'sourceSeq', deliverySeq: 1 }, 'ACK_DOMAIN_INVALID'],
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, NaN, Infinity].map(value => [
    { deliverySeq: value }, 'invalid-delivery-seq',
  ] as [Record<string, unknown>, string]),
  ...['', '01', '-1', '1.0', ' 1', '1e2', '18446744073709551616', 1, null].flatMap(value => [
    [{ ...source, sourceSeq: value }, 'ACK_DOMAIN_INVALID'],
    [{ ...source, streamEpoch: value }, 'ACK_DOMAIN_INVALID'],
  ] as Array<[Record<string, unknown>, string]>),
];

for (const [name, type] of [
  ['parseTerminalDeliveryAckMessage', 'terminal-delivery:ack'],
  ['parseTerminalDeliveryAckRejectedMessage', 'terminal-delivery:ack-rejected'],
] as const) {
  test(`${name}: server/frontend accept exact exclusive identities without precision loss`, () => {
    const parsers = [server, frontend].map(module => (module as Record<string, unknown>)[name]);
    for (const parser of parsers) assert.equal(typeof parser, 'function', name);
    for (const identity of accepted) {
      const input = { type, ...common, ...identity, ...(type.endsWith('rejected') ? { reason: 'ACK_OVER_ACK' } : {}) };
      for (const parser of parsers) assert.deepEqual((parser as Parser)(input), { ok: true, message: input });
    }
  });

  test(`${name}: server/frontend reject ambiguous and malformed domains with the same reason`, () => {
    for (const module of [server, frontend]) {
      const parser = (module as Record<string, unknown>)[name];
      assert.equal(typeof parser, 'function', name);
      for (const [identity, reason] of rejected) {
        const input = { type, ...common, ...identity, ...(type.endsWith('rejected') ? { reason: 'ACK_OVER_ACK' } : {}) };
        assert.deepEqual((parser as Parser)(input), { ok: false, reason }, JSON.stringify(input));
      }
    }
  });

  test(`${name}: common identity errors retain precedence over domain errors`, () => {
    for (const module of [server, frontend]) {
      const parser = (module as Record<string, unknown>)[name];
      assert.equal(typeof parser, 'function', name);
      for (const invalidCommon of [{ sessionId: '' }, { connectionEpoch: '' }, { sessionId: null }]) {
        for (const identity of [{ deliverySeq: 0 }, { ...source, streamEpoch: '-1' }, { ...source, deliverySeq: 1 }]) {
          assert.deepEqual((parser as Parser)({ type, ...common, ...invalidCommon, ...identity, reason: 'failure' }), {
            ok: false, reason: 'invalid-identity',
          });
        }
      }
      assert.deepEqual((parser as Parser)(null), { ok: false, reason: 'invalid-message' });
      assert.deepEqual((parser as Parser)({ type: 'output' }), { ok: false, reason: 'invalid-message-type' });
    }
  });
}

test('ACK rejection parsers require an observable nonempty reason for either domain', () => {
  for (const module of [server, frontend]) {
    const parser = (module as Record<string, unknown>).parseTerminalDeliveryAckRejectedMessage;
    assert.equal(typeof parser, 'function');
    for (const identity of accepted) {
      for (const reason of [undefined, '', null, 4]) {
        assert.deepEqual((parser as Parser)({ type: 'terminal-delivery:ack-rejected', ...common, ...identity, reason }), {
          ok: false, reason: 'invalid-reason',
        });
      }
    }
  }
});

function contractBlock(text: string): string {
  const start = '// terminal-delivery-ack-contract:start';
  const end = '// terminal-delivery-ack-contract:end';
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  assert.ok(first >= 0 && last > first, 'ACK contract anchors must exist in order');
  assert.equal(text.indexOf(start, first + start.length), -1, 'start anchor must be unique');
  assert.equal(text.indexOf(end, last + end.length), -1, 'end anchor must be unique');
  const block = text.slice(first + start.length, last);
  for (const name of ['TerminalDeliveryAckIdentity', 'TerminalDeliveryAckMessage', 'TerminalDeliveryAckRejectedMessage']) {
    assert.match(block, new RegExp(`export type ${name}\\b`), `${name} must be present`);
  }
  return block.replace(/\s+/gu, ' ').trim();
}

test('ACK source contracts are identical and cannot pass with missing anchors', () => {
  const serverText = readFileSync(new URL('./ws-protocol.ts', import.meta.url), 'utf8');
  const frontendText = readFileSync(frontendUrl, 'utf8');
  assert.equal(contractBlock(serverText), contractBlock(frontendText));
  assert.throws(() => contractBlock(''), /anchors/u);
  assert.throws(() => contractBlock(serverText.replace('// terminal-delivery-ack-contract:end', '')), /anchors/u);
});

test('ServerWsMessage binds the named exclusive ACK rejection contract in the actual outbound union', () => {
  const sourceText = readFileSync(new URL('./ws-protocol.ts', import.meta.url), 'utf8');
  const startAnchor = 'export type ServerWsMessage =';
  const endAnchor = 'export interface SubscribedSessionInfo {';
  const start = sourceText.indexOf(startAnchor);
  const end = sourceText.indexOf(endAnchor, start);
  assert.ok(start >= 0 && end > start, 'actual outbound union anchors must exist in order');
  assert.equal(sourceText.indexOf(startAnchor, start + startAnchor.length), -1, 'outbound union declaration must be unique');
  const outboundUnion = sourceText.slice(start + startAnchor.length, end);
  assert.match(outboundUnion, /^\s*\|\s*TerminalDeliveryAckRejectedMessage\s*$/mu,
    'ServerWsMessage must include the named exclusive rejection type, not a disconnected declaration');
  assert.doesNotMatch(outboundUnion, /type:\s*['"]terminal-delivery:ack-rejected['"]/u,
    'an inline legacy rejection must not widen or replace the exclusive domain contract');
});

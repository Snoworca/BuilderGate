// FR-MCP-017 AC-2, FR-MCP-020 AC-1/AC-3 (#233): peer link settings, their defaults and validation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PEER_LINK_SETTINGS,
  effectivePeerTimeoutMs,
  PEER_NAME_PATTERN,
  validatePeerLinkSettings,
} from './peerLinkSettings.js';

const link = { name: 'azure', url: 'wss://20.1.2.3:3333/mcp/peer', accessKey: 'k', enabled: true };

test('FR-MCP-020 AC-1: defaults are 15 s heartbeat, 60 s queue, 5 s key queue, 256 messages, paste and list inbound', () => {
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.heartbeatMs, 15_000);
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.timeoutMs, null);
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.queueTtlMs, 60_000);
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.keyQueueTtlMs, 5_000);
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.maxQueuedMessages, 256);
  assert.equal(DEFAULT_PEER_LINK_SETTINGS.maxQueuedBytes, 1024 * 1024);
  // FR-MCP-022 AC-10 added search, so the master can search a linked server.
  assert.deepEqual(DEFAULT_PEER_LINK_SETTINGS.inboundScopes, ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste']);
  assert.deepEqual(DEFAULT_PEER_LINK_SETTINGS.links, []);
});

test('FR-MCP-017 AC-2: the timeout defaults to 2.5 times the heartbeat and can be set', () => {
  assert.equal(effectivePeerTimeoutMs({ heartbeatMs: 15_000, timeoutMs: null }), 37_500);
  assert.equal(effectivePeerTimeoutMs({ heartbeatMs: 4_000, timeoutMs: null }), 10_000);
  assert.equal(effectivePeerTimeoutMs({ heartbeatMs: 15_000, timeoutMs: 90_000 }), 90_000);
});

test('FR-MCP-020 AC-3: a valid patch is accepted and missing fields keep the current values', () => {
  const result = validatePeerLinkSettings({ nodeName: 'corp', links: [link] }, DEFAULT_PEER_LINK_SETTINGS);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.settings.nodeName, 'corp');
  assert.equal(result.settings.heartbeatMs, 15_000);
  assert.equal(result.settings.links[0]!.accessKey, 'k');
  assert.equal(result.settings.links[0]!.tlsFingerprintSha256, undefined);
});

test('FR-MCP-020 AC-2: an empty access key keeps the stored key of the same link', () => {
  const current = { ...DEFAULT_PEER_LINK_SETTINGS, links: [{ ...link, accessKey: 'stored' }] };
  const result = validatePeerLinkSettings({ links: [{ ...link, accessKey: '' }] }, current);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.settings.links[0]!.accessKey, 'stored');
});

test('FR-MCP-020 AC-3: bad values are refused field by field', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ nodeName: 'bad name!' }, 'nodeName'],
    [{ heartbeatMs: 500 }, 'heartbeatMs'],
    [{ heartbeatMs: 301_000 }, 'heartbeatMs'],
    [{ heartbeatMs: 10_000, timeoutMs: 10_000 }, 'timeoutMs'],
    [{ queueTtlMs: 0 }, 'queueTtlMs'],
    [{ keyQueueTtlMs: -1 }, 'keyQueueTtlMs'],
    [{ maxQueuedMessages: 0 }, 'maxQueuedMessages'],
    [{ inboundScopes: ['mcp:everything'] }, 'inboundScopes'],
    [{ links: [{ ...link, url: 'https://x/mcp/peer' }] }, 'links.0.url'],
    [{ links: [{ ...link, name: 'a/b' }] }, 'links.0.name'],
    [{ links: [link, { ...link }] }, 'links.1.name'],
    [{ links: [{ ...link, tlsFingerprintSha256: 'zz' }] }, 'links.0.tlsFingerprintSha256'],
    [{ links: [{ ...link, accessKey: '' }] }, 'links.0.accessKey'],
  ];
  for (const [patch, field] of cases) {
    const result = validatePeerLinkSettings(patch, DEFAULT_PEER_LINK_SETTINGS);
    assert.equal(result.ok, false, `${field}: ${JSON.stringify(patch)}`);
    if (!result.ok) assert.ok(field in result.fieldErrors, `${field} not in ${JSON.stringify(result.fieldErrors)}`);
  }
});

test('FR-MCP-020 AC-3: a fingerprint is accepted with or without colons, in either case, and kept as lower-case hex', () => {
  const hex = 'AB'.repeat(32);
  const colons = hex.match(/../g)!.join(':');
  for (const value of [hex, colons, hex.toLowerCase()]) {
    const result = validatePeerLinkSettings({ links: [{ ...link, tlsFingerprintSha256: value }] }, DEFAULT_PEER_LINK_SETTINGS);
    assert.equal(result.ok, true, value);
    if (result.ok) assert.equal(result.settings.links[0]!.tlsFingerprintSha256, 'ab'.repeat(32));
  }
});

test('FR-MCP-022 (review M2): a link may not have this server name', () => {
  const result = validatePeerLinkSettings({ nodeName: 'corp', links: [{ ...link, name: 'Corp' }] }, DEFAULT_PEER_LINK_SETTINGS);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /links\.0\.name/);
});

test('FR-MSG-008 AC-1: a name may hold Korean letters and underscores but no space, ::, @ or /', () => {
  for (const name of ['김철수_대리', 'corp', 'a-b_c', 'Ab9']) {
    assert.equal(PEER_NAME_PATTERN.test(name), true, name);
  }
  for (const name of ['김 철수', 'a::b', 'a@b', 'a/b', '_lead', '-lead', '', 'x'.repeat(33)]) {
    assert.equal(PEER_NAME_PATTERN.test(name), false, name);
  }
  const result = validatePeerLinkSettings({ nodeName: '홍길동_팀장', links: [{ ...link, name: '김철수_대리' }] }, DEFAULT_PEER_LINK_SETTINGS);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('FR-MSG-009: a link is a contact unless it says it is a room link, and the kind is kept', () => {
  const result = validatePeerLinkSettings({ links: [link, { ...link, name: 'host1', kind: 'room' }] }, DEFAULT_PEER_LINK_SETTINGS);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.settings.links[0]!.kind, undefined);
  assert.equal(result.settings.links[1]!.kind, 'room');
  const bad = validatePeerLinkSettings({ links: [{ ...link, kind: 'group' }] }, DEFAULT_PEER_LINK_SETTINGS);
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad), /links\.0\.kind/);
});

test('review H3: a link saved without kind keeps the kind it has (the MCP panel does not send it)', () => {
  const current = { ...DEFAULT_PEER_LINK_SETTINGS, links: [{ ...link, name: 'host1', kind: 'room' as const }] };
  const result = validatePeerLinkSettings({ links: [{ ...link, name: 'host1', accessKey: '' }] }, current);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.settings.links[0]!.kind, 'room');
});

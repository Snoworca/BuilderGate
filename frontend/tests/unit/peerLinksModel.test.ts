// FR-MCP-020 (#233): the Remote links tab of the MCP settings window -- draft from the server
// settings, and the patch built back from it.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPeerLinksPatch,
  createPeerLinksDraft,
  effectivePeerTimeoutSeconds,
  emptyPeerLinkRow,
  peerStateLabelKey,
  type PeerLinksSettingsView,
} from '../../src/components/McpControlManager/peerLinksModel.ts';
import { koCatalog } from './i18nTestSetup.ts';

const view: PeerLinksSettingsView = {
  nodeName: 'corp',
  heartbeatMs: 15_000,
  timeoutMs: null,
  queueTtlMs: 60_000,
  keyQueueTtlMs: 5_000,
  maxQueuedMessages: 256,
  maxQueuedBytes: 1_048_576,
  inboundScopes: ['mcp:sessions.list', 'mcp:message.paste'],
  links: [{ name: 'azure', url: 'wss://a/mcp/peer', hasAccessKey: true, enabled: true, tlsFingerprintSha256: 'ab'.repeat(32) }],
};

test('FR-MCP-020 AC-1: the draft shows seconds, an empty timeout, and no key text', () => {
  const draft = createPeerLinksDraft(view);
  assert.equal(draft.heartbeatSecondsText, '15');
  assert.equal(draft.timeoutSecondsText, '');
  assert.equal(draft.queueTtlSecondsText, '60');
  assert.equal(draft.keyQueueTtlSecondsText, '5');
  assert.equal(draft.maxQueuedMessagesText, '256');
  assert.equal(draft.links[0]!.accessKey, '');
  assert.equal(draft.links[0]!.hasAccessKey, true);
  assert.equal(effectivePeerTimeoutSeconds(draft), 37.5);
  assert.equal(effectivePeerTimeoutSeconds({ ...draft, timeoutSecondsText: '90' }), 90);
});

test('FR-MCP-020 AC-1/AC-2: the patch goes back in ms, keeps an empty key empty, and an empty timeout as null', () => {
  const draft = createPeerLinksDraft(view);
  const result = buildPeerLinksPatch({ ...draft, heartbeatSecondsText: '20', links: [...draft.links, { ...emptyPeerLinkRow(), name: 'lab', url: 'wss://b/mcp/peer', accessKey: ' k2 ' }] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.heartbeatMs, 20_000);
  assert.equal(result.patch.timeoutMs, null);
  assert.equal(result.patch.queueTtlMs, 60_000);
  assert.deepEqual(result.patch.links, [
    { name: 'azure', url: 'wss://a/mcp/peer', accessKey: '', tlsFingerprintSha256: 'ab'.repeat(32), enabled: true },
    { name: 'lab', url: 'wss://b/mcp/peer', accessKey: 'k2', tlsFingerprintSha256: '', enabled: true },
  ]);
});

test('FR-MCP-020 AC-3: numbers that are not numbers are caught before saving', () => {
  const draft = createPeerLinksDraft(view);
  const result = buildPeerLinksPatch({ ...draft, heartbeatSecondsText: 'abc', maxQueuedMessagesText: '-1' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(Object.keys(result.errors).sort(), ['heartbeatSecondsText', 'maxQueuedMessagesText']);
});

test('FR-MCP-020 AC-5: each link state has a label in the catalog', () => {
  for (const state of ['connecting', 'connected', 'disconnected', 'other'] as const) {
    assert.ok(peerStateLabelKey(state) in koCatalog, state);
  }
});

test('FR-MCP-020 AC-3: field errors from the server are named by their field, and by remote number for a link', async () => {
  const { describePeerFieldErrors } = await import('../../src/components/McpControlManager/peerLinksModel.ts');
  const lines = describePeerFieldErrors({ 'links.1.url': 'wss://host:port/mcp/peer', heartbeatMs: 'a whole number', mystery: 'x' });
  assert.deepEqual(lines, [
    `${koCatalog['mcp.peers.link.url']}(원격 2): wss://host:port/mcp/peer`,
    `${koCatalog['mcp.peers.heartbeat']}: a whole number`,
    'mystery: x',
  ]);
});

// FR-MCP-016..FR-MCP-019 (#233): two BuilderGate MCP tool services joined by a real peer link over
// loopback WebSocket. corp dials azure; each side's agent reaches the other's sessions.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createMcpToolService } from '../McpToolService.js';
import { createPeerLinkManager, type PeerLinkManager } from './peerLinkManager.js';
import { DEFAULT_PEER_LINK_SETTINGS } from './peerLinkSettings.js';
import { createPeerUpgradeHandler, dialPeerWebSocket } from './peerWsTransport.js';

type Rec = Record<string, unknown>;
type Service = { callTool: (request: unknown) => Promise<Rec> };

const FULL = ['mcp:sessions.list', 'mcp:message.paste', 'mcp:message.submit'];

function node(name: string, sessions: Rec[], peerLinks: () => PeerLinkManager) {
  const delivered: Rec[] = [];
  const service = createMcpToolService({
    listSessions: () => sessions,
    deliverMessage: (delivery: Rec) => { delivered.push(delivery); return { ok: true, status: 'delivered' }; },
    get peerLinks() { return peerLinks(); },
  } as never) as unknown as Service;
  return { name, service, delivered };
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('FR-MCP-019: corp sends to azure/worker, azure lists corp sessions back, and scopes narrow both ways', async () => {
  let azureLinks!: PeerLinkManager;
  let corpLinks!: PeerLinkManager;
  const azure = node('azure', [{ sessionKey: 'k-w', sessionId: 's-w', alias: 'worker', bindingLifecycle: 'live' }], () => azureLinks);
  const corp = node('corp', [{ sessionKey: 'k-l', sessionId: 's-l', alias: 'leader', bindingLifecycle: 'live' }], () => corpLinks);
  const runAs = (service: Service) => (tool: string, args: Rec, actor: unknown) => service.callTool({ name: tool, arguments: args, actor });

  azureLinks = createPeerLinkManager({
    dial: () => { throw new Error('azure does not dial'); },
    authenticate: async (key) => (key === 'azure-key' ? { ok: true, scopes: FULL } : { ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: runAs(azure.service),
  }, { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: 'azure' });
  const server = http.createServer();
  const upgrade = createPeerUpgradeHandler({ manager: azureLinks, isAllowed: () => true });
  server.on('upgrade', (req, socket, head) => { if (!upgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  corpLinks = createPeerLinkManager({
    dial: dialPeerWebSocket,
    authenticate: async () => ({ ok: false, code: 'PEER_AUTH_FAILED' }),
    callTool: runAs(corp.service),
  }, {
    ...DEFAULT_PEER_LINK_SETTINGS,
    nodeName: 'corp',
    links: [{ name: 'azure', url: `ws://127.0.0.1:${port}/mcp/peer`, accessKey: 'azure-key', enabled: true }],
  });

  try {
    corpLinks.start();
    await waitFor(() => corpLinks.list()[0]?.state === 'connected');

    const sent = await corp.service.callTool({
      name: 'buildergate.message.send',
      arguments: { target: 'azure/worker', prompt: 'run the tests', deliveryMode: 'submit', includeSender: true },
      actor: { type: 'mcp', sessionKey: 'k-l', scopes: FULL },
    });
    assert.equal(sent.status, 'delivered', JSON.stringify(sent));
    assert.equal(azure.delivered.length, 1);
    assert.equal(azure.delivered[0]!.sessionKey, 'k-w');
    assert.match(String(azure.delivered[0]!.prompt), /^\[from: corp\/leader · sessionKey k-l/);
    assert.match(String(azure.delivered[0]!.prompt), /run the tests/);

    // azure -> corp: corp lets a remote it dialed list sessions and paste, not submit.
    const listed = await azure.service.callTool({
      name: 'buildergate.peer.call',
      arguments: { peer: 'corp', tool: 'buildergate.session.list', arguments: {} },
      actor: { type: 'mcp-fixed-access-key', scopes: FULL },
    });
    assert.deepEqual((listed.sessions as Rec[]).map((s) => s.alias), ['leader'], JSON.stringify(listed));
    const submit = await azure.service.callTool({
      name: 'buildergate.message.send',
      arguments: { target: 'corp/leader', prompt: 'done', deliveryMode: 'submit' },
      actor: { type: 'mcp-fixed-access-key', scopes: FULL },
    });
    assert.equal(submit.ok, false, JSON.stringify(submit));
    assert.equal(corp.delivered.length, 0);
    const paste = await azure.service.callTool({
      name: 'buildergate.message.send',
      arguments: { target: 'corp/leader', prompt: 'done', deliveryMode: 'paste' },
      actor: { type: 'mcp-fixed-access-key', scopes: FULL },
    });
    assert.equal(paste.status, 'delivered', JSON.stringify(paste));
    assert.equal(corp.delivered.length, 1);

    // A paste-only caller on corp cannot submit on azure, though the link key could.
    const narrowed = await corp.service.callTool({
      name: 'buildergate.peer.call',
      arguments: { peer: 'azure', tool: 'buildergate.message.send', arguments: { target: 'worker', prompt: 'x', deliveryMode: 'submit' } },
      actor: { type: 'mcp', sessionKey: 'k-l', scopes: ['mcp:message.paste'] },
    });
    assert.equal(narrowed.ok, false, JSON.stringify(narrowed));
    assert.equal(azure.delivered.length, 1);
  } finally {
    corpLinks.stop();
    azureLinks.stop();
    server.closeAllConnections();
    server.close();
  }
});

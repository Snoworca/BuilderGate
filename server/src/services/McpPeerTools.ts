// FR-MCP-019 (#233): MCP tools over the peer link. message.send to "peer/target" is routed in
// McpToolService (it shares the key and scope checks); the peer.* tools are here.

type Rec = Record<string, unknown>;

/** What McpToolService needs from the peer link (implemented by peer/peerLinkManager.ts). */
export interface McpPeerLinks {
  /** FR-MCP-022: this server's own name, the server of its items in merged lists. */
  nodeName(): string;
  hasPeer(name: string): boolean;
  sendMessage(input: { peer: string; args: Rec; scopes: string[]; hasKeys: boolean }): Promise<Rec>;
  call(input: { peer: string; tool: string; arguments: Rec; scopes: string[] }): Promise<Rec>;
  list(): unknown[];
  messageStatus(messageId: string): unknown | undefined;
}

export const MCP_PEER_TOOL_NAMES = [
  'buildergate.peer.list',
  'buildergate.peer.call',
  'buildergate.peer.message.status',
] as const;

const PEER_TOOL_PREFIX = 'buildergate.peer.';
/** The actor type of a request that arrived over a link (peerLinkManager PeerActor). */
const PEER_ACTOR_TYPE = 'mcp-peer';

export const MCP_PEER_TOOL_SCHEMAS: Record<string, Rec> = {
  'buildergate.peer.list': { type: 'object', properties: {}, additionalProperties: false },
  'buildergate.peer.call': {
    type: 'object',
    properties: {
      peer: { type: 'string', description: 'The remote BuilderGate, by the name shown in buildergate.peer.list.' },
      tool: { type: 'string', description: 'An MCP tool of the remote, e.g. buildergate.session.list.' },
      arguments: { type: 'object', description: 'The arguments of that tool.' },
    },
    required: ['peer', 'tool'],
    additionalProperties: false,
  },
  'buildergate.peer.message.status': {
    type: 'object',
    properties: { messageId: { type: 'string' } },
    required: ['messageId'],
    additionalProperties: false,
  },
};

export const MCP_PEER_TOOL_DESCRIPTIONS: Record<string, string> = {
  'buildergate.peer.list': 'List the remote BuilderGate servers linked to this one, with link state and queued messages. '
    + 'Send to a remote session with buildergate.message.send target "<peer>/<alias>".',
  'buildergate.peer.call': 'Call an MCP tool on a remote BuilderGate (e.g. buildergate.session.list). Not queued: fails at once '
    + 'with PEER_DISCONNECTED when the link is down. Runs with your scopes narrowed by the link.',
  'buildergate.peer.message.status': 'The state of a message sent to a remote session: queued, sent, delivered, failed, '
    + 'expired (never sent) or unknown (sent, no result before it expired).',
};

export function isMcpPeerTool(name: string): boolean {
  return (MCP_PEER_TOOL_NAMES as readonly string[]).includes(name);
}

/** FR-MCP-019 AC-6: a request that arrived over a link does not go out over a link again. */
export function isPeerRelay(actor: Rec): boolean {
  return actor.type === PEER_ACTOR_TYPE;
}

export const PEER_RELAY_REFUSED: Rec = Object.freeze({
  ok: false,
  code: 'PEER_RELAY_REFUSED',
  message: 'A request that came over a peer link cannot use a peer link again.',
});

/** FR-MCP-019 AC-1: "azure/worker" names the remote azure when azure is a peer; otherwise undefined. */
export function splitPeerTarget(links: McpPeerLinks | undefined, target: string | undefined): { peer: string; target: string } | undefined {
  if (!links || !target) return undefined;
  const slash = target.indexOf('/');
  if (slash <= 0 || slash === target.length - 1) return undefined;
  const peer = target.slice(0, slash);
  return links.hasPeer(peer) ? { peer, target: target.slice(slash + 1) } : undefined;
}

export async function callMcpPeerTool(links: McpPeerLinks | undefined, name: string, actor: Rec, args: Rec): Promise<Rec> {
  if (isPeerRelay(actor)) return { ...PEER_RELAY_REFUSED };
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  switch (name) {
    case 'buildergate.peer.list':
      if (!scopes.includes('mcp:sessions.list')) return { ok: false, code: 'INVALID_SCOPE' };
      return { ok: true, peers: links?.list() ?? [] };
    case 'buildergate.peer.message.status': {
      if (!scopes.includes('mcp:sessions.list')) return { ok: false, code: 'INVALID_SCOPE' };
      const messageId = typeof args.messageId === 'string' ? args.messageId : '';
      const status = messageId ? links?.messageStatus(messageId) : undefined;
      return status ? { ok: true, ...(status as Rec) } : { ok: false, code: 'MESSAGE_NOT_FOUND', messageId };
    }
    case 'buildergate.peer.call': {
      const peer = typeof args.peer === 'string' ? args.peer : '';
      const tool = typeof args.tool === 'string' ? args.tool : '';
      if (!peer || !tool) {
        return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { ...(peer ? {} : { peer: 'required' }), ...(tool ? {} : { tool: 'required' }) } };
      }
      if (tool.startsWith(PEER_TOOL_PREFIX)) return { ...PEER_RELAY_REFUSED };
      if (!links) return { ok: false, code: 'PEER_NOT_FOUND', peer };
      const toolArgs = args.arguments !== null && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Rec : {};
      return links.call({ peer, tool, arguments: toolArgs, scopes });
    }
    default:
      return { ok: false, code: 'UNKNOWN_TOOL' };
  }
}

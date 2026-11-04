// FR-MCP-022 (#235): the linked servers act as one. On the master, list tools merge the results of
// every connected server, each item naming its server and a target "<server>/<sessionKey>" that
// message.send takes as is; every other tool takes a server argument that picks where it runs.
// A request that arrived over a link is answered by this server alone (no relay, FR-MCP-019 AC-6).
import { isMcpPeerTool, isPeerRelay, PEER_RELAY_REFUSED, type McpPeerLinks } from './McpPeerTools.js';

type Rec = Record<string, unknown>;

/** FR-MCP-022 AC-3: how long a list waits for one remote server. */
export const REMOTE_LIST_TIMEOUT_MS = 3_000;
/** FR-MCP-022 AC-9. */
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 20;

const SEARCH_TOOL = 'buildergate.session.search';
const SEND_TOOL = 'buildergate.message.send';

/** The list tools that merge, and the arrays of items they answer with. */
const MERGED_LISTS: Readonly<Record<string, readonly string[]>> = {
  'buildergate.session.list': ['sessions'],
  [SEARCH_TOOL]: ['matches', 'candidates'],
  'buildergate.workspace.list': ['workspaces'],
  'buildergate.terminal.list': ['terminals'],
};

/** FR-MCP-022 AC-6: tools that never run elsewhere. */
const LOCAL_ONLY_TOOLS = new Set(['buildergate.session.whoami', 'buildergate.session.claim']);

export function takesServerArgument(name: string): boolean {
  return !LOCAL_ONLY_TOOLS.has(name) && !isMcpPeerTool(name);
}

const SERVER_PROPERTY: Rec = {
  type: 'string',
  description: 'The linked BuilderGate server to run on (its name in an item\'s server field). Leave it out for this server; '
    + 'list tools then answer for every connected server.',
};

/** FR-MCP-022 AC-6: the schema shown in tools/list. */
export function withServerProperty(name: string, schema: Rec | undefined): Rec | undefined {
  if (!schema || !takesServerArgument(name)) return schema;
  const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties as Rec : {};
  return { ...schema, properties: { ...properties, server: SERVER_PROPERTY } };
}

export interface FederatedCall {
  links: McpPeerLinks | undefined;
  name: string;
  actor: Rec;
  args: Rec;
  /** Runs the tool on this server. */
  runLocal: (args: Rec) => Promise<Rec>;
  timeoutMs?: number;
}

export async function callFederated(input: FederatedCall): Promise<Rec> {
  const { links, name, actor } = input;
  const { server: rawServer, ...rest } = input.args;
  const server = typeof rawServer === 'string' && rawServer.trim() ? rawServer.trim() : undefined;
  if (!links) return input.runLocal(input.args);
  const self = links.nodeName();

  if (name === SEND_TOOL) {
    const routed = sendArguments(links, self, server, rest);
    return 'refused' in routed ? routed.refused : input.runLocal(routed.args);
  }
  if (server !== undefined && server !== self && takesServerArgument(name)) {
    if (isPeerRelay(actor)) return { ...PEER_RELAY_REFUSED };
    if (!links.hasPeer(server)) return { ok: false, code: 'SERVER_NOT_FOUND', server };
    const result = await links.call({ peer: server, tool: name, arguments: rest, scopes: scopesOf(actor) });
    return MERGED_LISTS[name] ? labelResult(name, result, server) : result;
  }

  const local = await input.runLocal(rest);
  const keys = MERGED_LISTS[name];
  if (!keys) return local;
  const localListed = Array.isArray(local[keys[0]!]);
  const merging = server === undefined && !isPeerRelay(actor);
  if (!localListed && !merging) return local;
  const parts = localListed ? [{ server: self, result: local }] : [];
  // A list this server cannot answer (a workspace that is elsewhere) still merges the others.
  const unreachable: Rec[] = localListed ? [] : [{ server: self, code: typeof local.code === 'string' ? local.code : 'LOCAL_FAILED' }];
  if (merging) {
    const remote = await askConnectedServers(links, self, name, rest, scopesOf(actor), input.timeoutMs ?? REMOTE_LIST_TIMEOUT_MS);
    parts.push(...remote.answered);
    unreachable.push(...remote.unreachable);
  }
  if (parts.length === 0) return local;
  const merged = name === SEARCH_TOOL
    ? mergeSearch(parts, self, searchLimit(rest.limit))
    : mergeLists(name, parts);
  return isPeerRelay(actor) ? merged : { ...merged, unreachable };
}

/**
 * FR-MCP-022 AC-2/AC-4: server is the same as a target prefix, and "<this server>/<key>" is local.
 * A session named by sessionKey, alias or sessionId with a remote server becomes that remote target.
 */
function sendArguments(links: McpPeerLinks, self: string, server: string | undefined, args: Rec): { args: Rec } | { refused: Rec } {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const target = text(args.target);
  if (server !== undefined && server !== self) {
    if (!links.hasPeer(server)) return { refused: { ok: false, code: 'SERVER_NOT_FOUND', server } };
    const session = target ?? text(args.sessionKey) ?? text(args.alias) ?? text(args.sessionId);
    if (!session) return { refused: { ok: false, code: 'VALIDATION_ERROR', fieldErrors: { target: 'required with server' } } };
    const { sessionKey: _key, alias: _alias, sessionId: _id, ...rest } = args;
    const prefix = `${server}/`;
    return { args: { ...rest, target: session.startsWith(prefix) ? session : `${prefix}${session}` } };
  }
  const prefix = `${self}/`;
  return { args: target?.startsWith(prefix) ? { ...args, target: target.slice(prefix.length) } : args };
}

async function askConnectedServers(
  links: McpPeerLinks,
  self: string,
  tool: string,
  args: Rec,
  scopes: string[],
  timeoutMs: number,
): Promise<{ answered: Array<{ server: string; result: Rec }>; unreachable: Rec[] }> {
  const names = [...new Set(links.list().map((peer) => (peer as Rec).name).filter((name): name is string => typeof name === 'string'))];
  const connected = new Set(links.list().filter((peer) => (peer as Rec).state === 'connected').map((peer) => (peer as Rec).name));
  const key = MERGED_LISTS[tool]![0]!;
  const answers = await Promise.all(names.map(async (server) => {
    // A remote named like this server would give its sessions this server's targets.
    if (server === self) return { server, code: 'PEER_NAME_IS_SELF' };
    if (!connected.has(server)) return { server, code: 'PEER_DISCONNECTED' };
    const result = await withTimeout(links.call({ peer: server, tool, arguments: args, scopes }), timeoutMs);
    if (!result) return { server, code: 'PEER_TIMEOUT' };
    if (!Array.isArray(result[key])) return { server, code: typeof result.code === 'string' ? result.code : 'PEER_BAD_ANSWER' };
    return { server, result };
  }));
  const answered: Array<{ server: string; result: Rec }> = [];
  const unreachable: Rec[] = [];
  for (const answer of answers) {
    if ('result' in answer && answer.result) answered.push({ server: answer.server, result: answer.result });
    else unreachable.push(answer);
  }
  return { answered, unreachable };
}

function withTimeout(promise: Promise<Rec>, ms: number): Promise<Rec | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

function label(item: unknown, server: string): Rec {
  const record = item !== null && typeof item === 'object' ? item as Rec : {};
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey : undefined;
  return { ...record, server, ...(sessionKey ? { target: `${server}/${sessionKey}` } : {}) };
}

function labelResult(name: string, result: Rec, server: string): Rec {
  const labelled: Rec = { ...result };
  for (const key of MERGED_LISTS[name]!) {
    if (Array.isArray(result[key])) labelled[key] = (result[key] as unknown[]).map((item) => label(item, server));
  }
  return labelled;
}

function mergeLists(name: string, parts: Array<{ server: string; result: Rec }>): Rec {
  const key = MERGED_LISTS[name]![0]!;
  return {
    ...parts[0]!.result,
    [key]: parts.flatMap(({ server, result }) => (result[key] as unknown[]).map((item) => label(item, server))),
  };
}

function searchLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT;
}

/** FR-MCP-022 AC-9: by score; on a tie this server first, then by server name, each in its own order. */
function mergeSearch(parts: Array<{ server: string; result: Rec }>, self: string, limit: number): Rec {
  const rank = (server: string) => (server === self ? '' : server);
  const total = parts.reduce((sum, { result }) => sum + (typeof result.total === 'number'
    ? result.total
    : Array.isArray(result.matches) ? result.matches.length : 0), 0);
  const all = parts
    .flatMap(({ server, result }) => (Array.isArray(result.matches) ? result.matches : []).map((item) => label(item, server)))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => scoreOf(b.item) - scoreOf(a.item)
      || rank(String(a.item.server)).localeCompare(rank(String(b.item.server)))
      || a.index - b.index)
    .map(({ item }) => item);
  if (all.length === 0) {
    return { allowed: false, code: 'TARGET_NOT_FOUND', reason: 'zero-matches', matches: [], candidates: [], total };
  }
  const top = scoreOf(all[0]!);
  const tied = all.filter((item) => scoreOf(item) === top);
  const matches = all.slice(0, limit);
  if (tied.length > 1) {
    return { allowed: false, code: 'AMBIGUOUS_TARGET', reason: 'ambiguous-equal-rank', matches, candidates: tied.slice(0, limit), total };
  }
  return { allowed: true, matches, total };
}

function scoreOf(item: Rec): number {
  return typeof item.score === 'number' ? item.score : 0;
}

function scopesOf(actor: Rec): string[] {
  return Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
}

// FR-MCP-026: which BuilderGate session an MCP client belongs to, found from the OS instead of
// asking the user. The client end of a loopback MCP connection names a process; walking up its
// parents reaches the PTY shell of the terminal it was started in. Read-only: nothing here signals
// or stops a process.
import { execFile } from 'node:child_process';
import { detectAgentFromProcesses, type ProcessInfo } from './agentSession/agentSessionResolver.js';

/** The two ports of one TCP connection, seen from the MCP listener. */
export interface McpConnectionPorts {
  listenerPort: number;
  clientPort: number;
}

export interface McpCallerRequest extends McpConnectionPorts {
  remoteAddress: string;
}

export interface McpCallerSessionDeps {
  findClientPid: (ports: McpConnectionPorts) => Promise<number | undefined>;
  listProcesses: () => Promise<ProcessInfo[]>;
  listShells: () => Array<{ sessionId: string; shellPid: number | null }>;
  sessionKeyFor: (sessionId: string) => string | undefined;
}

/** The terminal session a client runs in, and whether the client itself is an agent CLI. */
export interface McpCallerSession {
  sessionKey: string;
  /** The PTY session id; a new terminal under the same key gets a new token. */
  sessionId: string;
  /** AC-7: claude, codex, ... -- not a tunnel or a script that happens to run in the terminal. */
  agent: boolean;
}

export type McpCallerSessionResolver = (request: McpCallerRequest) => Promise<McpCallerSession | undefined>;

/** AC-4: how far up the parent chain a client may be from its terminal shell. */
export const MAX_ANCESTOR_STEPS = 64;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** AC-8: how long one process listing answers every lookup (it is the slow part). */
export const PROCESS_LIST_TTL_MS = 5_000;

export function createMcpCallerSessionResolver(deps: McpCallerSessionDeps): McpCallerSessionResolver {
  const listProcesses = shared(deps.listProcesses, PROCESS_LIST_TTL_MS);
  return async (request) => {
    // AC-3: only a client on this machine can be under one of its terminals.
    if (!LOOPBACK.has(request.remoteAddress.toLowerCase())) return undefined;
    try {
      const clientPid = await deps.findClientPid(request);
      if (clientPid === undefined) return undefined;
      let processes = await listProcesses();
      // A client that started after the shared listing is not in it yet: read once more.
      if (!processes.some((info) => info.pid === clientPid)) processes = await listProcesses.fresh();
      const sessionId = findShellAncestor(processes, clientPid, deps.listShells());
      const sessionKey = sessionId === undefined ? undefined : deps.sessionKeyFor(sessionId);
      if (sessionId === undefined || !sessionKey) return undefined;
      const client = processes.find((info) => info.pid === clientPid);
      return { sessionKey, sessionId, agent: client !== undefined && detectAgentFromProcesses([client]) !== null };
    } catch {
      // AC-3: a failed lookup leaves the connection on the MCP key alone.
      return undefined;
    }
  };
}

/**
 * AC-8: one call in flight at a time, and its answer reused for `ttlMs`. `fresh()` starts a new
 * read unless one started after the caller's answer -- concurrent callers still share it.
 */
function shared<T>(read: () => Promise<T>, ttlMs: number): (() => Promise<T>) & { fresh: () => Promise<T> } {
  let cached: { at: number; value: Promise<T> } | undefined;
  let generation = 0;
  const start = () => {
    const value = read();
    generation += 1;
    cached = { at: Date.now(), value };
    value.catch(() => { if (cached?.value === value) cached = undefined; });
    return value;
  };
  const get = () => (!cached || Date.now() - cached.at > ttlMs ? start() : cached.value);
  const freshFrom = new Map<number, Promise<T>>();
  const fresh = () => {
    const seen = generation;
    const pending = freshFrom.get(seen);
    if (pending) return pending;
    const value = start();
    freshFrom.clear();
    freshFrom.set(seen, value);
    return value;
  };
  return Object.assign(get, { fresh });
}

/** AC-1/AC-4: the session whose shell is the client or one of its ancestors. */
export function findShellAncestor(
  processes: readonly ProcessInfo[],
  clientPid: number,
  shells: ReadonlyArray<{ sessionId: string; shellPid: number | null }>,
): string | undefined {
  const sessionByShell = new Map<number, string>();
  for (const shell of shells) if (shell.shellPid !== null) sessionByShell.set(shell.shellPid, shell.sessionId);
  const byPid = new Map<number, ProcessInfo>();
  for (const info of processes) byPid.set(info.pid, info);
  const seen = new Set<number>();
  let pid: number | undefined = clientPid;
  for (let step = 0; pid !== undefined && step <= MAX_ANCESTOR_STEPS && !seen.has(pid); step += 1) {
    const sessionId = sessionByShell.get(pid);
    if (sessionId !== undefined) return sessionId;
    seen.add(pid);
    const child = byPid.get(pid);
    const parent = child ? byPid.get(child.ppid) : undefined;
    // Review L1: Windows reuses pids. A "parent" that started after its child is another process.
    if (child?.createdAtMs !== undefined && parent?.createdAtMs !== undefined && parent.createdAtMs > child.createdAtMs) return undefined;
    pid = child?.ppid;
  }
  return undefined;
}

/** `netstat -ano -p TCP` (Windows): the row whose local end is the client port and remote end the listener. */
export function parseNetstatClientPid(text: string, ports: McpConnectionPorts): number | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)\s*$/iu.exec(line);
    if (match && portOf(match[1]!) === ports.clientPort && portOf(match[2]!) === ports.listenerPort) {
      return Number(match[3]);
    }
  }
  return undefined;
}

/** `ss -Htnp` (Linux): the row whose local end is the client port and peer end the listener. */
export function parseSsClientPid(text: string, ports: McpConnectionPorts): number | undefined {
  for (const line of text.split('\n')) {
    const match = /^\S+\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+.*?pid=(\d+)/u.exec(line);
    if (match && portOf(match[1]!) === ports.clientPort && portOf(match[2]!) === ports.listenerPort) {
      return Number(match[3]);
    }
  }
  return undefined;
}

function portOf(address: string): number {
  return Number(address.slice(address.lastIndexOf(':') + 1));
}

const readWindowsConnections = shared(() => run('netstat.exe', ['-ano', '-p', 'TCP'], 10_000), 1_000);
const readLinuxConnections = shared(() => run('ss', ['-Htnp'], 10_000), 1_000);

/** The client pid from the OS connection table of this platform (one read shared per second, AC-8). */
export async function findClientPidFromOs(ports: McpConnectionPorts): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const found = parseNetstatClientPid(await readWindowsConnections(), ports);
    // A socket newer than the shared read is not in it yet: read once more.
    return found ?? parseNetstatClientPid(await run('netstat.exe', ['-ano', '-p', 'TCP'], 10_000), ports);
  }
  if (process.platform === 'linux') {
    const found = parseSsClientPid(await readLinuxConnections(), ports);
    return found ?? parseSsClientPid(await run('ss', ['-Htnp'], 10_000), ports);
  }
  return undefined;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

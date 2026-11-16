// FR-MCP-026: an agent started in a BuilderGate terminal is bound to that terminal's session on its
// own -- the server finds the client process behind the MCP connection and walks up to the PTY shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpCallerSessionResolver,
  findShellAncestor,
  parseNetstatClientPid,
  parseSsClientPid,
} from './mcpCallerSession.js';
import type { ProcessInfo } from './agentSession/agentSessionResolver.js';

const NETSTAT = [
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:3333           0.0.0.0:0              LISTENING       900',
  '  TCP    127.0.0.1:3333         127.0.0.1:52344        ESTABLISHED     900',
  '  TCP    127.0.0.1:52344        127.0.0.1:3333         ESTABLISHED     4242',
  '  TCP    [::1]:61000            [::1]:3333             ESTABLISHED     5151',
  '  TCP    127.0.0.1:52345        127.0.0.1:4444         ESTABLISHED     7777',
].join('\r\n');

test('FR-MCP-026 AC-1: netstat names the process on the client end of the connection, IPv4 and IPv6', () => {
  assert.equal(parseNetstatClientPid(NETSTAT, { listenerPort: 3333, clientPort: 52344 }), 4242);
  assert.equal(parseNetstatClientPid(NETSTAT, { listenerPort: 3333, clientPort: 61000 }), 5151);
  // The server's own end of the same connection is not the client.
  assert.equal(parseNetstatClientPid(NETSTAT, { listenerPort: 52344, clientPort: 3333 }), 900);
  assert.equal(parseNetstatClientPid(NETSTAT, { listenerPort: 3333, clientPort: 52345 }), undefined);
});

test('FR-MCP-026 AC-1: ss names the process on the client end of the connection', () => {
  const ss = [
    'ESTAB 0 0 127.0.0.1:3333 127.0.0.1:52344 users:(("node",pid=900,fd=30))',
    'ESTAB 0 0 127.0.0.1:52344 127.0.0.1:3333 users:(("claude",pid=4242,fd=21))',
    'ESTAB 0 0 [::1]:61000 [::1]:3333 users:(("claude",pid=5151,fd=9))',
  ].join('\n');
  assert.equal(parseSsClientPid(ss, { listenerPort: 3333, clientPort: 52344 }), 4242);
  assert.equal(parseSsClientPid(ss, { listenerPort: 3333, clientPort: 61000 }), 5151);
  assert.equal(parseSsClientPid(ss, { listenerPort: 3333, clientPort: 1 }), undefined);
});

const proc = (pid: number, ppid: number, name = 'x', extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid, ppid, name, ...extra });

test('FR-MCP-026 AC-1/AC-4: the walk goes up to the PTY shell, stops on a cycle and after 64 steps', () => {
  const processes = [proc(10, 1, 'pwsh'), proc(20, 10, 'node'), proc(30, 20, 'claude'), proc(40, 30, 'npx')];
  const shells = [{ sessionId: 's-1', shellPid: 10 }, { sessionId: 's-2', shellPid: 99 }];
  assert.equal(findShellAncestor(processes, 40, shells), 's-1');
  assert.equal(findShellAncestor(processes, 10, shells), 's-1', 'the shell itself counts');
  assert.equal(findShellAncestor(processes, 30, [{ sessionId: 's-2', shellPid: 99 }]), undefined);
  assert.equal(findShellAncestor([proc(5, 6), proc(6, 5)], 5, shells), undefined, 'a cycle ends the walk');
  const chain = Array.from({ length: 80 }, (_, i) => proc(1000 + i, 1000 + i + 1));
  assert.equal(findShellAncestor(chain, 1000, [{ sessionId: 'deep', shellPid: 1070 }]), undefined, 'gives up past 64 steps');
  assert.equal(findShellAncestor(chain, 1000, [{ sessionId: 'near', shellPid: 1010 }]), 'near');
});

test('FR-MCP-026 AC-1/AC-3: the resolver answers the session only for a loopback client under a terminal', async () => {
  let looked = 0;
  const resolve = createMcpCallerSessionResolver({
    findClientPid: async ({ clientPort }) => { looked += 1; return clientPort === 52344 ? 40 : undefined; },
    listProcesses: async () => [proc(10, 1, 'pwsh.exe'), proc(30, 10, 'cmd.exe'), proc(40, 30, 'claude.exe')],
    listShells: () => [{ sessionId: 's-1', shellPid: 10 }],
    sessionKeyFor: (sessionId) => (sessionId === 's-1' ? 'key-1' : undefined),
  });
  assert.deepEqual(await resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 52344 }), { sessionKey: 'key-1', sessionId: 's-1', agent: true });
  assert.equal((await resolve({ remoteAddress: '::ffff:127.0.0.1', listenerPort: 3333, clientPort: 52344 }))?.sessionKey, 'key-1');
  assert.equal(await resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 1 }), undefined);
  const before = looked;
  assert.equal(await resolve({ remoteAddress: '10.0.1.13', listenerPort: 3333, clientPort: 52344 }), undefined);
  assert.equal(looked, before, 'a remote client is never looked up');
  const failing = createMcpCallerSessionResolver({
    findClientPid: async () => { throw new Error('netstat missing'); },
    listProcesses: async () => [],
    listShells: () => [],
    sessionKeyFor: () => undefined,
  });
  assert.equal(await failing({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 52344 }), undefined);
});


test('FR-MCP-026 AC-7 (review C1): only an agent CLI itself counts as an agent; a tunnel under the same shell does not', async () => {
  const cases: Array<[ProcessInfo, boolean]> = [
    [proc(40, 10, 'claude.exe'), true],
    [proc(40, 10, 'node.exe', { commandLine: 'node C:/npm/node_modules/@openai/codex/bin/codex.js resume' }), true],
    [proc(40, 10, 'codex.exe'), true],
    [proc(40, 10, 'ssh.exe', { commandLine: 'ssh -R 9000:127.0.0.1:3333 host' }), false],
    [proc(40, 10, 'ngrok.exe', { commandLine: 'ngrok http 3333' }), false],
    [proc(40, 10, 'cloudflared.exe'), false],
    [proc(40, 10, 'node.exe', { commandLine: 'node probe.mjs' }), false],
  ];
  for (const [client, agent] of cases) {
    const resolve = createMcpCallerSessionResolver({
      findClientPid: async () => 40,
      listProcesses: async () => [proc(10, 1, 'pwsh.exe'), client],
      listShells: () => [{ sessionId: 's-1', shellPid: 10 }],
      sessionKeyFor: () => 'key-1',
    });
    assert.equal((await resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 52344 }))?.agent, agent, `${client.name} ${client.commandLine ?? ''}`);
  }
});

test('FR-MCP-026 AC-4 (review L1): a parent that started after its child is a reused pid, not the parent', () => {
  const processes = [proc(10, 1, 'pwsh', { createdAtMs: 5_000 }), proc(40, 10, 'claude', { createdAtMs: 1_000 })];
  assert.equal(findShellAncestor(processes, 40, [{ sessionId: 's-1', shellPid: 10 }]), undefined);
  const real = [proc(10, 1, 'pwsh', { createdAtMs: 1_000 }), proc(40, 10, 'claude', { createdAtMs: 5_000 })];
  assert.equal(findShellAncestor(real, 40, [{ sessionId: 's-1', shellPid: 10 }]), 's-1');
});

test('FR-MCP-026 AC-8 (review H3): concurrent lookups share one process listing', async () => {
  let listings = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const resolve = createMcpCallerSessionResolver({
    findClientPid: async () => 40,
    listProcesses: async () => { listings += 1; await gate; return [proc(10, 1), proc(40, 10, 'claude.exe')]; },
    listShells: () => [{ sessionId: 's-1', shellPid: 10 }],
    sessionKeyFor: () => 'key-1',
  });
  const all = Array.from({ length: 20 }, (_, i) => resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 50000 + i }));
  release();
  const answers = await Promise.all(all);
  assert.equal(listings, 1, 'one listing for twenty sockets');
  assert.ok(answers.every((answer) => answer?.sessionKey === 'key-1'));
});

test('FR-MCP-026 AC-8: a client newer than the shared process listing is found by reading the list once more', async () => {
  // Live 2026-11-16: an agent started seconds after another lookup was missing from the cached list.
  let listings = 0;
  const resolve = createMcpCallerSessionResolver({
    findClientPid: async ({ clientPort }) => (clientPort === 1 ? 40 : 41),
    listProcesses: async () => {
      listings += 1;
      return listings === 1
        ? [proc(10, 1), proc(40, 10, 'node.exe')]
        : [proc(10, 1), proc(40, 10, 'node.exe'), proc(41, 10, 'claude.exe')];
    },
    listShells: () => [{ sessionId: 's-1', shellPid: 10 }],
    sessionKeyFor: () => 'key-1',
  });
  assert.equal((await resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 1 }))?.agent, false);
  const fresh = await resolve({ remoteAddress: '127.0.0.1', listenerPort: 3333, clientPort: 2 });
  assert.deepEqual(fresh, { sessionKey: 'key-1', sessionId: 's-1', agent: true });
  assert.equal(listings, 2);
});

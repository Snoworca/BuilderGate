#!/usr/bin/env node
// End-to-end checks of the MCP peer link (FR-MCP-016..020), keys (FR-MCP-015) and one-use upload
// URLs (FR-MCP-021) against a running BuilderGate -- the 2222 test server of this checkout.
//
//   node tools/mcp-e2e/mcp-e2e.mjs setup      enable the MCP listener on 127.0.0.1:<port> (REST, needs the login)
//   node tools/mcp-e2e/mcp-e2e.mjs run        all checks below (needs the fixed MCP access key)
//   node tools/mcp-e2e/mcp-e2e.mjs teardown   remove the peer link added by run and turn the listener off
//   node tools/mcp-e2e/mcp-e2e.mjs delete-workspace <id>   delete one workspace a stopped run left behind
//
// Secrets never go in a file of this repository or on the command line:
//   BUILDERGATE_PASSWORD  the 2222 login (setup, teardown, the peer step of run)
//   BG_MCP_KEY_FILE       a file outside the repository holding the fixed MCP access key (run)
// Other settings: BG_URL (default https://localhost:2222), BG_MCP_PORT (default 3334).
// Everything the run creates (a workspace, its terminal, an uploaded file, the "e2e-self" peer
// link) is removed by exact id/name at the end, also when a check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../server/package.json'));
const WebSocket = require('ws');

const BG_URL = process.env.BG_URL ?? 'https://localhost:2222';
const MCP_PORT = Number(process.env.BG_MCP_PORT ?? 3334);
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const PEER_URL = `ws://127.0.0.1:${MCP_PORT}/mcp/peer`;
const SELF_LINK = 'e2e-self';
// FR-MCP-022: a name made of words, found later by other words in another order.
const SEARCH_NAME = `복구 작업 판단 e2e${Date.now() % 10000}`;
const insecure = new https.Agent({ rejectUnauthorized: false });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// REST (browser login) -- the settings the UI changes

function rest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(urlPath, BG_URL), {
      method,
      agent: insecure,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function login() {
  const password = process.env.BUILDERGATE_PASSWORD;
  if (!password) throw new Error('BUILDERGATE_PASSWORD is not set');
  const res = await rest('POST', '/api/auth/login', { password });
  if (!res.json.token) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  return res.json.token;
}

async function setup() {
  const token = await login();
  const res = await rest('PATCH', '/api/mcp-control/config', {
    enabled: true, bindMode: 'loopback', host: '127.0.0.1', port: MCP_PORT, transportSecurity: 'none',
  }, token);
  console.log(`PATCH /api/mcp-control/config -> ${res.status} listener=${res.json.status ?? res.json.listenerStatus ?? '?'} port=${res.json.port}`);
  for (let i = 0; i < 20; i += 1) {
    if (await fetch(`${MCP_URL}/health-probe`).then(() => true, () => false)) break;
    await sleep(250);
  }
  const reachable = await fetch(`${MCP_URL}/mcp`, { method: 'POST', body: '{}' }).then((r) => r.status, () => 0);
  console.log(`MCP listener ${MCP_URL}: ${reachable ? `answers (${reachable})` : 'not reachable'}`);
}

async function teardown() {
  const token = await login();
  const peers = await rest('GET', '/api/mcp-control/peers', undefined, token);
  const links = (peers.json.settings?.links ?? []).filter((link) => link.name !== SELF_LINK)
    .map((link) => ({ name: link.name, url: link.url, accessKey: '', tlsFingerprintSha256: link.tlsFingerprintSha256 ?? '', enabled: link.enabled }));
  await rest('PUT', '/api/mcp-control/peers', { links }, token);
  const res = await rest('PATCH', '/api/mcp-control/config', { enabled: false }, token);
  console.log(`peer link ${SELF_LINK} removed; MCP listener off -> ${res.status}`);
}

// ---------------------------------------------------------------------------------------------
// MCP over HTTP (JSON-RPC)

function readKey() {
  const file = process.env.BG_MCP_KEY_FILE;
  if (!file) throw new Error('BG_MCP_KEY_FILE is not set');
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw new Error('BG_MCP_KEY_FILE is empty');
  return key;
}

function mcpClient(key) {
  let sessionId;
  let nextId = 1;
  const post = async (body) => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };
  return {
    init: async () => post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bg-mcp-e2e', version: '1' } } }),
    listTools: async () => (await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} })).result?.tools ?? [],
    call: async (name, args = {}) => {
      const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
      if (reply.error) return { ok: false, rpcError: reply.error };
      const result = reply.result ?? {};
      if (result.structuredContent) return result.structuredContent;
      const text = result.content?.[0]?.text;
      try { return text ? JSON.parse(text) : result; } catch { return { text }; }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Raw peer socket

function openPeer() {
  const ws = new WebSocket(PEER_URL);
  const frames = [];
  const waiters = [];
  let closeCode;
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
  });
  ws.on('close', (code) => { closeCode = code; for (const waiter of waiters.splice(0)) waiter.resolve(undefined); });
  ws.on('error', () => {});
  return {
    ws,
    frames,
    get closeCode() { return closeCode; },
    opened: new Promise((resolve) => { ws.on('open', () => resolve(true)); ws.on('close', () => resolve(false)); }),
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (match, ms = 5000) => new Promise((resolve) => {
      const found = frames.find(match);
      if (found) { resolve(found); return; }
      const waiter = { match, resolve };
      waiters.push(waiter);
      setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) { waiters.splice(i, 1); resolve(undefined); } }, ms);
    }),
  };
}

async function socketChecks(key) {
  console.log('\n== peer socket (FR-MCP-016/017/019)');
  const peer = openPeer();
  check('socket: upgrade to /mcp/peer opens', await peer.opened);
  peer.send({ t: 'hello', v: 1, node: 'e2e-raw', epoch: `e2e-${Date.now()}`, heartbeatMs: 2000, key });
  const welcome = await peer.next((f) => f.t === 'welcome');
  check('socket: hello with the fixed key gets welcome', welcome?.t === 'welcome', welcome ? `node=${welcome.node} heartbeatMs=${welcome.heartbeatMs}` : 'no welcome');
  const hb = await peer.next((f) => f.t === 'hb', 4000);
  check('socket: the server sends heartbeats at the shorter interval (2 s)', hb?.t === 'hb');
  peer.send({ t: 'call', id: 'c1', tool: 'buildergate.session.list', arguments: {}, scopes: ['mcp:sessions.list'] });
  const listed = await peer.next((f) => f.t === 'call-result' && f.id === 'c1');
  check('socket: call buildergate.session.list returns sessions', Array.isArray(listed?.result?.sessions), `${listed?.result?.sessions?.length ?? '-'} sessions`);
  peer.send({ t: 'call', id: 'c2', tool: 'buildergate.session.list', arguments: {}, scopes: [] });
  const narrowed = await peer.next((f) => f.t === 'call-result' && f.id === 'c2');
  check('socket: a caller with no scopes is refused (link scopes intersected)', narrowed?.result?.ok === false, narrowed?.result?.code);
  peer.send({ t: 'call', id: 'c3', tool: 'buildergate.peer.list', arguments: {}, scopes: ['mcp:sessions.list'] });
  const relay = await peer.next((f) => f.t === 'call-result' && f.id === 'c3');
  check('socket: a peer.* tool over the link is refused', relay?.result?.code === 'PEER_RELAY_REFUSED', relay?.result?.code);
  peer.ws.close();

  const wrong = openPeer();
  await wrong.opened;
  wrong.send({ t: 'hello', v: 1, node: 'e2e-wrong', epoch: 'x', heartbeatMs: 2000, key: 'not-the-key' });
  const bye = await wrong.next((f) => f.t === 'bye');
  check('socket: a wrong key gets bye PEER_AUTH_FAILED and nothing else', bye?.code === 'PEER_AUTH_FAILED' && wrong.frames.length === 1, bye?.code);
  check('socket: ... and the connection closes', (await wrong.closed) !== undefined);

  const silent = openPeer();
  await silent.opened;
  const started = Date.now();
  await silent.closed;
  const waited = Date.now() - started;
  check('socket: no hello closes the connection after about 10 s', waited >= 9000 && waited < 15000, `${waited} ms`);

  const big = openPeer();
  await big.opened;
  big.ws.send('x'.repeat(1024 * 1024 + 1));
  const bigCode = await big.closed;
  check('socket: a frame over 1 MiB closes with 1009', bigCode === 1009, String(bigCode));
}

// ---------------------------------------------------------------------------------------------
// MCP tools on a real terminal

async function readScreen(mcp, ref, lines = 30) {
  const read = await mcp.call('buildergate.terminal.read', { ...ref, lines });
  return String(read.text ?? read.output ?? read.screen ?? JSON.stringify(read));
}

async function waitScreen(mcp, ref, pattern, ms = 8000) {
  const end = Date.now() + ms;
  let screen = '';
  while (Date.now() < end) {
    screen = await readScreen(mcp, ref);
    if (pattern.test(screen)) return { ok: true, screen };
    await sleep(300);
  }
  return { ok: false, screen };
}

async function run() {
  const key = readKey();
  await socketChecks(key);

  console.log('\n== MCP tools (FR-MCP-015/019/021)');
  const mcp = mcpClient(key);
  await mcp.init();
  const names = (await mcp.listTools()).map((tool) => tool.name);
  for (const name of ['buildergate.peer.list', 'buildergate.peer.call', 'buildergate.peer.message.status', 'buildergate.file.upload_url']) {
    check(`tools/list offers ${name}`, names.includes(name));
  }

  const workspace = await mcp.call('buildergate.workspace.create', { name: `e2e-mcp-${Date.now() % 100000}` });
  const workspaceId = workspace.workspace?.workspaceId ?? workspace.workspace?.id ?? workspace.workspaceId;
  check('workspace.create', Boolean(workspaceId), JSON.stringify(workspace).slice(0, 160));
  let uploadedPath;
  let token;
  try {
    const terminal = await mcp.call('buildergate.terminal.create', { workspaceId, name: SEARCH_NAME, shell: 'wsl' });
    const tab = terminal.terminal ?? terminal.tab ?? terminal;
    const ref = { workspaceId, terminalId: tab.id ?? tab.terminalId ?? tab.tabId };
    const sessionId = tab.sessionId;
    check('terminal.create (wsl)', Boolean(ref.terminalId && sessionId), JSON.stringify(terminal).slice(0, 200));
    await waitScreen(mcp, ref, /\$\s*$/m, 15000);

    // FR-MCP-015 AC-3: the bytes of an arrow key, in normal and in application cursor mode.
    await mcp.call('buildergate.terminal.exec', { ...ref, command: 'cat -v' });
    await sleep(800);
    await mcp.call('buildergate.terminal.input', { sessionId, keys: ['up', 'shift+up'] });
    await mcp.call('buildergate.terminal.input', { sessionId, keys: ['enter'] });
    const normal = await waitScreen(mcp, ref, /\^\[\[A\^\[\[1;2A/);
    check('keys: up and shift+up arrive as ESC [ A and ESC [ 1;2 A', normal.ok, normal.ok ? '' : normal.screen.slice(-200));
    await mcp.call('buildergate.terminal.input', { sessionId, keys: ['ctrl+c'] });
    await sleep(500);
    await mcp.call('buildergate.terminal.exec', { ...ref, command: "printf '\\033[?1h'; cat -v" });
    await sleep(800);
    await mcp.call('buildergate.terminal.input', { sessionId, keys: ['up', 'enter'] });
    const app = await waitScreen(mcp, ref, /\^\[OA/);
    check('keys: in application cursor mode up arrives as ESC O A (FR-MCP-015 AC-3)', app.ok, app.ok ? '' : app.screen.slice(-200));
    await mcp.call('buildergate.terminal.input', { sessionId, keys: ['ctrl+c'] });
    await mcp.call('buildergate.terminal.exec', { ...ref, command: "printf '\\033[?1l'; clear" });

    // FR-MCP-021: a one-use upload URL into the folder of the moment it was opened.
    const pwd = await mcp.call('buildergate.terminal.exec', { ...ref, command: 'pwd', waitMs: 800 });
    const opened = await mcp.call('buildergate.file.upload_url', { sessionId });
    check('upload_url returns url, path and directory', Boolean(opened.url && opened.directory), JSON.stringify({ ...opened, url: opened.url ? '<url>' : undefined, path: undefined }).slice(0, 200));
    token = opened.path;
    await mcp.call('buildergate.terminal.exec', { ...ref, command: 'cd ..' });
    const name = `e2e-upload-${Date.now()}.txt`;
    const put = await fetch(`${opened.url}&name=${encodeURIComponent(name)}`, { method: 'PUT', body: 'uploaded by the MCP e2e' });
    const putJson = await put.json();
    check('upload: PUT stores the file', put.status === 200 && putJson.ok === true, `${put.status} ${putJson.name}`);
    uploadedPath = path.join(opened.directory, putJson.name ?? name);
    check('upload: the file is in the folder of the moment the URL was opened, not after cd ..', fs.existsSync(uploadedPath) && fs.readFileSync(uploadedPath, 'utf8') === 'uploaded by the MCP e2e', uploadedPath);
    const again = await fetch(`${opened.url}&name=again.txt`, { method: 'PUT', body: 'x' });
    check('upload: the second request gets 410', again.status === 410, String(again.status));
    const page = await fetch(`${opened.url}`);
    check('upload: a used URL no longer serves the page', page.status === 410, String(page.status));
    const fresh = await mcp.call('buildergate.file.upload_url', { sessionId });
    const pageFresh = await fetch(fresh.url);
    check('upload: GET of a fresh URL serves the upload page', pageFresh.status === 200 && /type="file"/.test(await pageFresh.text()));
    const stillFresh = await fetch(`${fresh.url}&name=${encodeURIComponent(`fresh-${name}`)}`, { method: 'PUT', body: 'y' });
    const freshJson = await stillFresh.json();
    check('upload: GET did not use the URL up', stillFresh.status === 200, String(stillFresh.status));
    if (freshJson.name) fs.rmSync(path.join(fresh.directory, freshJson.name), { force: true });
    const noSession = await mcp.call('buildergate.file.upload_url', {});
    check('upload_url without sessionId is refused', noSession.code === 'VALIDATION_ERROR', noSession.code);
    void pwd;

    // FR-MCP-016..019 over a real link: this server dials itself.
    await peerChecks(mcp, sessionId, ref);
  } finally {
    if (uploadedPath) fs.rmSync(uploadedPath, { force: true });
    if (workspaceId) {
      const deleted = await mcp.call('buildergate.workspace.delete', { workspaceId, confirm: true });
      console.log(`cleanup: workspace ${workspaceId} deleted -> ${deleted.ok !== false}`);
    }
  }
}

async function peerChecks(mcp, sessionId, ref) {
  console.log('\n== peer link through the UI settings (FR-MCP-016..020)');
  if (!process.env.BUILDERGATE_PASSWORD) {
    check('peer: skipped, BUILDERGATE_PASSWORD not set', false);
    return;
  }
  const token = await login();
  const before = await rest('GET', '/api/mcp-control/peers', undefined, token);
  const keep = (before.json.settings?.links ?? []).filter((link) => link.name !== SELF_LINK)
    .map((link) => ({ name: link.name, url: link.url, accessKey: '', tlsFingerprintSha256: link.tlsFingerprintSha256 ?? '', enabled: link.enabled }));
  const saved = await rest('PUT', '/api/mcp-control/peers', {
    links: [...keep, { name: SELF_LINK, url: PEER_URL, accessKey: readKey(), tlsFingerprintSha256: '', enabled: true }],
    inboundScopes: ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste', 'mcp:message.submit'],
  }, token);
  check('peer: saving a link in the settings is accepted', saved.status === 200, `${saved.status} ${JSON.stringify(saved.json?.fieldErrors ?? saved.json?.error ?? '')}`);
  check('peer: the settings never return the key', !JSON.stringify(saved.json).includes(readKey()));
  try {
    let state;
    for (let i = 0; i < 40; i += 1) {
      state = (await mcp.call('buildergate.peer.list')).peers?.find((p) => p.name === SELF_LINK);
      if (state?.state === 'connected') break;
      await sleep(250);
    }
    check('peer: the link connects (peer.list)', state?.state === 'connected', JSON.stringify(state));
    const listed = await mcp.call('buildergate.peer.call', { peer: SELF_LINK, tool: 'buildergate.session.list' });
    check('peer: peer.call session.list over the link', Array.isArray(listed.sessions), `${listed.sessions?.length ?? listed.code}`);
    const marker = `peer-e2e-${Date.now()}`;
    const sent = await mcp.call('buildergate.terminal.input', { target: `${SELF_LINK}/${sessionId}`, command: `echo ${marker}` });
    check('peer: terminal.input to "<link>/<sessionId>" is delivered', sent.status === 'delivered', JSON.stringify(sent).slice(0, 200));
    const seen = await waitScreen(mcp, ref, new RegExp(marker));
    check('peer: the text arrives in the terminal', seen.ok);
    const status = await mcp.call('buildergate.peer.message.status', { messageId: sent.messageId });
    check('peer: message.status says delivered', status.status === 'delivered', status.status);
    const keys = await mcp.call('buildergate.terminal.input', { target: `${SELF_LINK}/${sessionId}`, keys: ['ctrl+c'] });
    check('peer: keys go over the link too', keys.status === 'delivered', keys.status ?? keys.code);
    // FR-MCP-011 AC-8: a message over the link arrives tagged "[from: <link>/<alias> ..." by the receiver.
    const note = await mcp.call('buildergate.message.send', { target: `${SELF_LINK}/${sessionId}`, prompt: `note ${marker}`, deliveryMode: 'paste', fromSessionId: sessionId });
    check('peer: message.send over the link is delivered', note.status === 'delivered', JSON.stringify(note).slice(0, 200));
    const tagged = await waitScreen(mcp, ref, new RegExp(`\\[from: ${SELF_LINK}/`));
    check('peer: the message carries the sender tag', tagged.ok);
    await mcp.call('buildergate.terminal.input', { target: `${SELF_LINK}/${sessionId}`, keys: ['ctrl+c'] });
    await federationChecks(mcp, sessionId, ref);
  } finally {
    await rest('PUT', '/api/mcp-control/peers', { links: keep }, token);
    console.log(`cleanup: peer link ${SELF_LINK} removed`);
  }
}

// FR-MCP-022: over the self link the same session is both local and remote, which is exactly an
// ambiguous search across servers; picking the remote candidate sends over the link.
async function federationChecks(mcp, sessionId, ref) {
  console.log('\n== linked servers as one (FR-MCP-022)');
  const listed = await mcp.call('buildergate.session.list');
  const mine = (listed.sessions ?? []).filter((s) => s.sessionId === sessionId || s.currentSessionId === sessionId);
  const self = mine.find((s) => s.server !== SELF_LINK)?.server;
  check('list: the session shows up from this server and over the link, each with server and target',
    Boolean(self) && mine.some((s) => s.server === SELF_LINK && s.target === `${SELF_LINK}/${s.sessionKey}`),
    JSON.stringify(mine.map((s) => [s.server, s.target])));
  check('list: the inbound side of the self link (named like this server) is left out',
    (listed.unreachable ?? []).some((u) => u.server === self && u.code === 'PEER_NAME_IS_SELF'), JSON.stringify(listed.unreachable));
  const sessionKey = mine.find((s) => s.server === self)?.sessionKey;
  const alias = SEARCH_NAME;
  const started = Date.now();
  const found = await mcp.call('buildergate.session.search', { query: `${alias.split(' ').pop()} 판단 복구 세션` });
  const elapsed = Date.now() - started;
  const servers = (found.candidates ?? []).map((m) => m.server);
  check('search: loose words find it on both servers in one call, this server first',
    found.code === 'AMBIGUOUS_TARGET' && servers[0] === self && servers[1] === SELF_LINK, `${found.code} ${JSON.stringify(servers)} ${elapsed} ms`);
  check('search: matches keep score and matchType', typeof found.candidates?.[0]?.score === 'number' && Boolean(found.candidates?.[0]?.matchType),
    `${found.candidates?.[0]?.score} ${found.candidates?.[0]?.matchType}`);
  console.log(`   search over the link took ${elapsed} ms (total ${found.total})`);
  const remote = found.candidates?.find((m) => m.server === SELF_LINK);
  const marker = `fed-e2e-${Date.now()}`;
  const sent = await mcp.call('buildergate.terminal.input', { target: remote?.target, command: `echo ${marker}` });
  check('send: the remote candidate target goes over the link', sent.status === 'delivered', JSON.stringify(sent).slice(0, 160));
  check('send: the text arrives', (await waitScreen(mcp, ref, new RegExp(marker))).ok);
  const viaServer = await mcp.call('buildergate.terminal.input', { server: SELF_LINK, sessionKey, command: `echo s-${marker}` });
  check('send: server with sessionKey goes over the link', viaServer.status === 'delivered', JSON.stringify(viaServer).slice(0, 160));
  const terminals = await mcp.call('buildergate.terminal.list', { server: SELF_LINK });
  check('server argument: terminal.list runs on the linked server', Array.isArray(terminals.terminals) && terminals.terminals.every((t) => t.server === SELF_LINK),
    `${terminals.terminals?.length ?? terminals.code}`);
  const unknown = await mcp.call('buildergate.terminal.list', { server: 'no-such-server' });
  check('server argument: an unknown name is SERVER_NOT_FOUND', unknown.code === 'SERVER_NOT_FOUND', unknown.code);
  const tools = await mcp.listTools();
  check('tools/list: list tools have the server property', Boolean(tools.find((t) => t.name === 'buildergate.session.search')?.inputSchema?.properties?.server));
}

// ---------------------------------------------------------------------------------------------

const command = process.argv[2];
// Deletes one workspace by its exact id (a run that stopped before its own cleanup).
async function deleteWorkspace() {
  const workspaceId = process.argv[3];
  if (!workspaceId) throw new Error('usage: delete-workspace <workspaceId>');
  const mcp = mcpClient(readKey());
  await mcp.init();
  console.log(JSON.stringify(await mcp.call('buildergate.workspace.delete', { workspaceId, confirm: true })));
}

const actions = { setup, run, teardown, 'delete-workspace': deleteWorkspace };
if (!actions[command]) {
  console.error('usage: node tools/mcp-e2e/mcp-e2e.mjs setup|run|teardown|delete-workspace <id>');
  process.exit(2);
}
actions[command]().then(() => {
  if (command === 'run') {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length === 0 ? 0 : 1);
  }
}, (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

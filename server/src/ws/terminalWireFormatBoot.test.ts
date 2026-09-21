import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// IR-BGSTAB-001 AC-7 makes realtime.terminalWireFormat a kill switch: the value
// an operator writes into config.json5 decides whether the server will answer a
// binary negotiation at all. Every other suite here builds WsRouter by hand and
// so starts downstream of the question. The stretch from the config file to the
// router is only executed by booting the server, because `config` is a module
// top-level `export const config = loadConfig()` and index.ts is a top-level
// side-effect module that never exports its bootstrap.
//
// A regression in that stretch is silent: realtimeSchema is a defaultObject, so
// a lost `realtime` fills back in as 'json' without an error, and the settings
// still read correctly in every static check.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = path.join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(SERVER_ROOT, 'src', 'index.ts');
const PASSWORD = 'BootProbe1234';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 100;
const NEGOTIATION_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 5_000;
const LOG_CAP_BYTES = 262_144;

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocket = require_('ws') as any;

/** Every child we start, so an interrupted run does not strand a server. */
const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of live) {
    try {
      child.kill();
    } catch {
      // the run is already ending; nothing useful to do here
    }
  }
});

function tryBind(port: number): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    // No host on purpose. The server binds with a bare listen(), which lands on
    // the dual-stack `::`; probing '0.0.0.0' instead reports a port as free that
    // the server then fails to take.
    server.listen(port, () => resolve(server));
  });
}

const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * index.ts also binds HTTP_PORT = PORT - 1, and that listen() has no error
 * handler, so a taken neighbour kills the process after HTTPS is already up.
 * Both ports have to be free, so claim both before trusting either.
 */
async function reserveAdjacentPortPair(attempts = 50): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const high = 20_000 + Math.floor(Math.random() * 20_000);
    const upper = await tryBind(high);
    if (!upper) continue;
    const lower = await tryBind(high - 1);
    if (!lower) {
      await closeServer(upper);
      continue;
    }
    await closeServer(upper);
    await closeServer(lower);
    return high;
  }
  // Falling back to an arbitrary port would turn EADDRINUSE into a timeout.
  throw new Error(`no adjacent free port pair after ${attempts} attempts`);
}

function get(port: number, at: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: at, method: 'GET', rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

function postJson(
  port: number,
  at: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: at,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
      },
      (res) => {
        let out = '';
        res.on('data', (chunk) => { out += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? null, body: out }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitHealthy(port: number, cancelled: { done: boolean }): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline && !cancelled.done) {
    if (await get(port, '/health') === 200) return true;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}

function childEnv(configPath: string, root: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The shell running the suite may carry any of these, and one of them
  // silently redirects the child away from the fixture. Drop the whole prefix
  // rather than a list that goes stale as new variables appear.
  for (const key of Object.keys(env)) {
    if (key.startsWith('BUILDERGATE_')) delete env[key];
  }
  delete env.DEV_FRONTEND_PORT;
  env.BUILDERGATE_CONFIG_PATH = configPath;
  // Read by both SSLService and the config loader. Without it the child writes
  // certificates and state into the checked-out server/ directory.
  env.BUILDERGATE_SERVER_ROOT = root;
  // index.ts prefers process.env.PORT over config.server.port.
  env.PORT = String(port);
  env.NODE_ENV = 'development';
  return env;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_GRACE_MS)),
  ]);
  if (timedOut && child.pid) {
    // Targets this child's own pid tree. Never a name-wide kill, which would
    // reach the dev server and other sessions.
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

interface NegotiationOutcome {
  type: string;
  accepted?: boolean;
  reason?: string;
}

/**
 * Boots the server against a throwaway config and asks it to negotiate binary.
 * The answer is the observable the kill switch controls.
 */
/**
 * Boots a server on the given realtime block and reads back its answer to a
 * capability offer. `clientQuery` is appended to the socket URL so a case can
 * ask as the client does; it defaults to empty, which is what a browser sends.
 */
async function negotiateWithServerConfigured(
  realtimeBlock: string,
  clientQuery = '',
): Promise<NegotiationOutcome> {
  const port = await reserveAdjacentPortPair();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-wire-format-'));
  const configPath = path.join(root, 'config.json5');

  fs.writeFileSync(configPath, `{
  server: { port: ${port} },
  pty: { shell: "auto" },
  session: { idleDelayMs: 200 },
  ssl: { certPath: "", keyPath: "", caPath: "" },
  auth: { password: "${PASSWORD}", durationMs: 1800000, maxDurationMs: 86400000, jwtSecret: "", localhostPasswordOnly: false },
  twoFactor: { enabled: false },
${realtimeBlock}}
`, 'utf-8');

  const env = childEnv(configPath, root, port);
  assert.equal(env.BUILDERGATE_SERVER_ROOT, root, 'the child must be pointed away from the checked-out server root');

  const child = spawn(process.execPath, [TSX_CLI, ENTRY], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);

  const log: string[] = [];
  let logBytes = 0;
  const capture = (chunk: unknown) => {
    const text = String(chunk);
    logBytes += text.length;
    if (logBytes <= LOG_CAP_BYTES) log.push(text);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  try {
    // Racing the exit matters more than the timeout does: a taken HTTP_PORT
    // kills the child immediately, and without this the failure would surface
    // 30 seconds later as an unexplained negotiation timeout.
    // Losing the race does not stop the poll on its own, so an early exit
    // would otherwise hold its timer for the full health timeout and stretch a
    // fast failure into a 30-second one.
    const cancelled = { done: false };
    const exited = new Promise<{ exitCode: number | null }>((resolve) => {
      child.once('exit', (code) => {
        cancelled.done = true;
        resolve({ exitCode: code });
      });
    });
    const first = await Promise.race([
      exited,
      waitHealthy(port, cancelled).then((healthy) => ({ healthy })),
    ]);
    if ('exitCode' in first) {
      throw new Error(`server exited with ${first.exitCode} before becoming healthy\n${log.join('')}`);
    }
    if (!first.healthy) {
      throw new Error(`server never became healthy within ${HEALTH_TIMEOUT_MS}ms\n${log.join('')}`);
    }

    const login = await postJson(port, '/api/auth/login', { password: PASSWORD });
    assert.equal(login.status, 200, `login failed: ${login.body}\n${log.join('')}`);
    const token = (JSON.parse(login.body) as { token?: string }).token;
    assert.ok(token, `login returned no token: ${login.body}`);

    return await new Promise<NegotiationOutcome>((resolve, reject) => {
      const ws = new WebSocket(
        `wss://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}${clientQuery}`,
        { rejectUnauthorized: false },
      );
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* closing a dead socket */ }
        reject(new Error(`no negotiation answer within ${NEGOTIATION_TIMEOUT_MS}ms\n${log.join('')}`));
      }, NEGOTIATION_TIMEOUT_MS);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'terminal-binary:negotiate',
          supportedFrameVersions: [1],
          acceptedFlagMask: 0xff,
        }));
      });
      ws.on('message', (raw: unknown) => {
        let message: NegotiationOutcome;
        try {
          message = JSON.parse(String(raw)) as NegotiationOutcome;
        } catch {
          return;
        }
        if (message.type === 'terminal-binary:capability' || message.type === 'terminal-binary:rejected') {
          clearTimeout(timer);
          try { ws.close(); } catch { /* closing a dead socket */ }
          resolve(message);
        }
      });
      ws.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`${error.message}\n${log.join('')}`));
      });
    });
  } finally {
    await stop(child);
    live.delete(child);
    // Windows holds the child's handles for a moment past its exit event, so a
    // removal right here hits EPERM. Retry, and if the directory still resists,
    // leave it to the OS rather than failing a negotiation assertion over
    // housekeeping.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // a stray fixture under os.tmpdir() is not worth a red test
    }
  }
}

test('IR-BGSTAB-001 a configured binary-optin wire format reaches the running server', async () => {
  const answer = await negotiateWithServerConfigured('  realtime: { terminalWireFormat: "binary-optin" },\n');

  assert.equal(answer.type, 'terminal-binary:capability');
  assert.equal(answer.accepted, true, `expected the server to answer the offer, got ${JSON.stringify(answer)}`);
});

test('IR-BGSTAB-001 a configured json wire format leaves binary negotiation closed', async () => {
  // Spelled out rather than left unset. AC-7 disclaims the default value as its
  // invariant and hands it to MIG-BGSTAB-004; the 2026-08-18 change note removed
  // the unconditional-default clause for that reason. Leaving this case unset
  // would report an approved migration as a regression against this requirement.
  const answer = await negotiateWithServerConfigured('  realtime: { terminalWireFormat: "json" },\n');

  assert.equal(answer.type, 'terminal-binary:rejected');
  assert.notEqual(answer.accepted, true);
});

test('IR-BGSTAB-001 a config with no realtime block still negotiates to an answer', async () => {
  // The shipped server/config.json5 carries no realtime key, so defaultObject
  // is what supplies one. Dropping that wrapper makes the loader throw on the
  // real config and takes every boot down with it, yet the two cases above
  // would stay green because both spell the key out.
  //
  // Which answer comes back depends on the schema default, so this asserts only
  // that one arrives.
  const answer = await negotiateWithServerConfigured('');

  assert.ok(
    answer.type === 'terminal-binary:capability' || answer.type === 'terminal-binary:rejected',
    `expected a negotiation answer, got ${JSON.stringify(answer)}`,
  );
});

test('IR-BGSTAB-001 a split transport mode refuses binary negotiation without a query parameter', async () => {
  // AC-7 allows binary only while wsTransportMode is unified, and calls the
  // setting a kill switch. The query parameter is the client speaking, so a
  // client that omits it must not reach a wider eligibility than the operator
  // configured. The wire format is spelled binary-optin so the refusal can only
  // come from the transport gate.
  const answer = await negotiateWithServerConfigured(
    '  realtime: { wsTransportMode: "split", terminalWireFormat: "binary-optin" },\n',
  );

  assert.equal(answer.type, 'terminal-binary:rejected');
  assert.notEqual(answer.accepted, true);
});

test('IR-BGSTAB-001 a split-shadow transport mode also refuses binary negotiation', async () => {
  // AC-7 admits only `unified` out of a closed three-value enum. Checking
  // `split` alone leaves a gate written as `!== 'split'` alive, and that gate
  // answers a split-shadow server with accepted: true.
  const answer = await negotiateWithServerConfigured(
    '  realtime: { wsTransportMode: "split-shadow", terminalWireFormat: "binary-optin" },\n',
  );

  assert.equal(answer.type, 'terminal-binary:rejected');
  assert.notEqual(answer.accepted, true);
});

test('IR-BGSTAB-001 a client asking for split cannot negotiate binary on a unified server', async () => {
  // The other half of the gate. The cases above pin the configured side; this
  // one pins the connection side, so a gate that drops the connection term and
  // reads the setting alone no longer goes unobserved.
  const answer = await negotiateWithServerConfigured(
    '  realtime: { wsTransportMode: "unified", terminalWireFormat: "binary-optin" },\n',
    '&wsTransportMode=split',
  );

  assert.equal(answer.type, 'terminal-binary:rejected');
  assert.notEqual(answer.accepted, true);
});

/**
 * MIG-BGSTAB-004 AC-1 end to end, with no `realtime` block at all.
 *
 * Every other test in this repository builds the codec path from parts. This one
 * asks the question an operator actually has: with a stock config, does a real
 * server hand a real client real binary frames? The config deliberately omits
 * `realtime` — the answer therefore comes from the resolved default and the
 * published evidence, which is the thing the flip changed.
 */
async function readFirstBinaryOutputOnDefaultConfig(): Promise<{
  negotiated: string;
  binaryFrames: number;
  jsonOutputs: number;
  firstFrameBody: string;
  seen: string[];
}> {
  const port = await reserveAdjacentPortPair();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-binary-e2e-'));
  const configPath = path.join(root, 'config.json5');
  fs.writeFileSync(configPath, `{
  server: { port: ${port} },
  pty: { shell: "auto" },
  session: { idleDelayMs: 200 },
  ssl: { certPath: "", keyPath: "", caPath: "" },
  auth: { password: "${PASSWORD}", durationMs: 1800000, maxDurationMs: 86400000, jwtSecret: "", localhostPasswordOnly: false },
  twoFactor: { enabled: false },
}
`, 'utf-8');

  const env = childEnv(configPath, root, port);
  const child = spawn(process.execPath, [TSX_CLI, ENTRY], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  const log: string[] = [];
  let logBytes = 0;
  const capture = (chunk: unknown) => {
    const text = String(chunk);
    logBytes += text.length;
    if (logBytes <= LOG_CAP_BYTES) log.push(text);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  try {
    const cancelled = { done: false };
    const exited = new Promise<{ exitCode: number | null }>((resolve) => {
      child.once('exit', (code) => { cancelled.done = true; resolve({ exitCode: code }); });
    });
    const first = await Promise.race([exited, waitHealthy(port, cancelled).then(healthy => ({ healthy }))]);
    if ('exitCode' in first) throw new Error(`server exited with ${first.exitCode}\n${log.join('')}`);
    if (!first.healthy) throw new Error(`server never became healthy\n${log.join('')}`);

    const login = await postJson(port, '/api/auth/login', { password: PASSWORD });
    assert.equal(login.status, 200, `login failed: ${login.body}`);
    const token = (JSON.parse(login.body) as { token?: string }).token;
    assert.ok(token, 'login returned no token');

    const created = await postJson(port, '/api/sessions', { name: 'binary-e2e' }, token);
    assert.equal(created.status, 201, `session create failed: ${created.status} ${created.body}`);
    const sessionId = (JSON.parse(created.body) as { id?: string }).id;
    assert.ok(sessionId, `session create returned no id: ${created.body}`);

    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, {
        rejectUnauthorized: false,
      });
      let negotiated = 'none';
      let binaryFrames = 0;
      let jsonOutputs = 0;
      let firstFrameBody = '';
      const seen: string[] = [];
      const finish = (error?: Error) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        if (error) reject(error);
        else resolve({ negotiated, binaryFrames, jsonOutputs, firstFrameBody, seen });
      };
      const timer = setTimeout(() => {
        // Resolving rather than rejecting: the counts are the finding, and a
        // zero is a result worth reading, not a harness failure to debug.
        finish();
      }, NEGOTIATION_TIMEOUT_MS);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'terminal-binary:negotiate',
          supportedFrameVersions: [1],
          acceptedFlagMask: 0xff,
        }));
      });
      ws.on('message', (raw: unknown, isBinary?: boolean) => {
        if (isBinary === true || Buffer.isBuffer(raw) && negotiated === 'terminal-binary:capability' && raw[0] === 1) {
          const bytes = raw as Buffer;
          binaryFrames += 1;
          if (firstFrameBody === '') {
            // 28-byte header + 24-byte OUTPUT prologue, then the body.
            firstFrameBody = bytes.subarray(28 + 24).toString('utf8');
          }
          if (binaryFrames >= 1 && firstFrameBody.length > 0) finish();
          return;
        }
        let message: { type?: string } = {};
        try { message = JSON.parse(String(raw)) as { type?: string }; } catch { return; }
        if (typeof message.type === 'string' && seen.length < 60) seen.push(message.type);
        if (message.type === 'terminal-binary:capability' || message.type === 'terminal-binary:rejected') {
          negotiated = message.type;
          ws.send(JSON.stringify({ type: 'subscribe', sessionIds: [sessionId] }));
          // No `input` here: a raw socket cannot satisfy the browser's input
          // provenance permit and the server answers `input:rejected`, which
          // would look like a codec failure. The shell's own prompt is enough.
          return;
        }
        // The snapshot gate holds queued output until the client says it has
        // applied the snapshot. Without this reply nothing is ever delivered,
        // and the test would report "binary never arrived" for a reason that has
        // nothing to do with the codec.
        if (message.type === 'screen-snapshot') {
          const snapshot = message as { sessionId?: string; replayToken?: string };
          if (typeof snapshot.sessionId === 'string') {
            ws.send(JSON.stringify({
              type: 'screen-snapshot:ready',
              sessionId: snapshot.sessionId,
              replayToken: snapshot.replayToken,
            }));
            // A shell prints its prompt on its own once output is released.
            setTimeout(() => {
              try {
                ws.send(JSON.stringify({ type: 'resize', sessionId: snapshot.sessionId, cols: 80, rows: 24 }));
              } catch { /* closed */ }
            }, 300);
          }
          return;
        }
        if (message.type === 'output') jsonOutputs += 1;
      });
      ws.on('error', (error: Error) => finish(new Error(`${error.message}\n${log.join('')}`)));
    });
  } finally {
    await stop(child);
    live.delete(child);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* housekeeping */ }
  }
}

test('MIG-BGSTAB-004 AC-1 a stock config negotiates binary and delivers real binary frames', async () => {
  const observed = await readFirstBinaryOutputOnDefaultConfig();
  assert.equal(
    observed.negotiated,
    'terminal-binary:capability',
    'with the binary default resolved, a stock server must accept a capability offer',
  );
  assert.ok(
    observed.binaryFrames > 0,
    `no binary frame arrived (json outputs: ${observed.jsonOutputs}; messages seen: ${observed.seen.join(', ')})`,
  );
  assert.ok(
    observed.firstFrameBody.length > 0,
    'the first binary frame decoded to an empty body',
  );
});

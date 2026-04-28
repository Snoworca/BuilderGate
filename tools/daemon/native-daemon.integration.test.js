const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const startRuntime = require('../start-runtime');
const stopRuntime = require('../../stop');
const { createRunningState, createStartingState, readState, writeStateAtomic } = require('./state-store');

const NODE_PTY_DIR = path.resolve(__dirname, '..', '..', 'server', 'node_modules', 'node-pty');

function makeTempRuntime(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const paths = {
    root,
    serverDir: path.join(root, 'server'),
    serverEntry: path.join(root, 'server', 'dist', 'index.js'),
    nodeBin: path.join(root, 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    configPath: path.join(root, 'server', 'config.json5'),
    statePath: path.join(root, 'runtime', 'buildergate.daemon.json'),
    logPath: path.join(root, 'runtime', 'buildergate-daemon.log'),
    sentinelLogPath: path.join(root, 'runtime', 'buildergate-sentinel.log'),
    launcherPath: path.resolve(__dirname, '..', 'start-runtime.js'),
    totpSecretPath: path.join(root, 'server', 'data', 'totp.secret'),
    isPackaged: false,
  };

  fs.mkdirSync(path.dirname(paths.serverEntry), { recursive: true });
  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
  fs.writeFileSync(paths.configPath, '{ server: { port: 2002 } }\n', 'utf8');

  return paths;
}

function writeServerEntry(paths, content) {
  fs.writeFileSync(paths.serverEntry, content, 'utf8');
}

function writeForegroundCliArtifacts(paths, port) {
  const serverDistDir = path.dirname(paths.serverEntry);
  fs.mkdirSync(path.join(serverDistDir, 'utils'), { recursive: true });
  fs.mkdirSync(path.join(serverDistDir, 'services'), { recursive: true });
  fs.mkdirSync(path.join(serverDistDir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(serverDistDir, 'shell-integration'), { recursive: true });
  fs.writeFileSync(
    path.join(serverDistDir, 'utils', 'configStrictLoader.js'),
    `export function loadConfigFromPathStrict() { return { server: { port: ${port} }, twoFactor: { enabled: false } }; }\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(serverDistDir, 'services', 'daemonTotpPreflight.js'),
    'export async function runDaemonTotpPreflight() { return { enabled: false }; }\n',
    'utf8',
  );
  fs.writeFileSync(path.join(serverDistDir, 'public', 'index.html'), '<html></html>\n', 'utf8');
  fs.writeFileSync(path.join(serverDistDir, 'shell-integration', 'bash-osc133.sh'), '#!/usr/bin/env bash\n', 'utf8');
}

function runNodeScript(scriptPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out running ${scriptPath}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function createRunningDaemonState(paths) {
  const starting = createStartingState({
    paths,
    port: 2002,
    argvHash: 'integration-stop',
  });
  return createRunningState(starting, { appPid: 1111, sentinelPid: 2222 });
}

test('source native daemon launch spawns app and sentinel without PM2', async () => {
  const paths = makeTempRuntime('buildergate-native-daemon-source-');
  writeServerEntry(paths, 'process.exit(0);\n');
  const launches = [];
  const preflights = [];

  const exitCode = await startRuntime.startDaemon(2002, 'cli', ['127.0.0.1'], paths, {
    spawnDetached: (launch) => {
      launches.push(launch);
      return { pid: launch.role === 'app' ? 1111 : 2222 };
    },
    waitForReadiness: async () => ({ ok: true }),
    processExists: () => false,
    daemonPreflight: async (args) => {
      preflights.push(args);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].role, 'app');
  assert.equal(launches[1].role, 'sentinel');
  assert.equal(launches[0].options.env.BUILDERGATE_SUPPRESS_TOTP_QR, '1');
  assert.equal(launches[1].args.includes('--internal-sentinel'), true);
  assert.doesNotMatch(JSON.stringify(launches), /pm2/i);
  assert.equal(preflights.length, 1);

  const state = readState(paths.statePath);
  assert.equal(state.status, 'running');
  assert.equal(state.appPid, 1111);
  assert.equal(state.sentinelPid, 2222);
});

test('source foreground runs in current-console contract and writes no daemon state', async () => {
  const paths = makeTempRuntime('buildergate-native-daemon-foreground-');
  writeServerEntry(paths, "console.log('foreground smoke'); process.exit(0);\n");

  const exitCode = await startRuntime.startForeground(2002, 'cli', [], paths);

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(paths.statePath), false);
});

test('source foreground Ctrl+C in a terminal lets the app child flush before exit', async () => {
  assert.equal(
    fs.existsSync(NODE_PTY_DIR),
    true,
    `node-pty is required for mandatory foreground Ctrl+C integration coverage: ${NODE_PTY_DIR}`,
  );
  const paths = makeTempRuntime('buildergate-native-daemon-foreground-ctrlc-');
  const port = 24670;
  const projectRoot = path.resolve(__dirname, '..', '..');
  const startedMarker = path.join(paths.root, 'foreground-started.txt');
  const flushMarker = path.join(paths.root, 'foreground-flushed.txt');
  const harnessPath = path.join(paths.root, 'foreground-pty-harness.js');
  writeForegroundCliArtifacts(paths, port);
  writeServerEntry(paths, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');
function flush(signal) {
  fs.writeFileSync(${JSON.stringify(flushMarker)}, signal);
  process.exit(0);
}
process.on('SIGINT', () => flush('SIGINT'));
process.on('SIGTERM', () => flush('SIGTERM'));
setInterval(() => {}, 1000);
`);

  fs.writeFileSync(harnessPath, `
const fs = require('fs');
const path = require('path');
const pty = require(${JSON.stringify(NODE_PTY_DIR)});
const outputLimit = 12000;
let output = '';
let terminal = null;

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for ' + label + '\\n' + output));
      }
    }, 50);
  });
}

(async () => {
  terminal = pty.spawn(process.execPath, [
    ${JSON.stringify(path.join(projectRoot, 'tools', 'start-runtime.js'))},
    '--foreground',
    '-p',
    ${JSON.stringify(String(port))},
  ], {
    cwd: ${JSON.stringify(projectRoot)},
    cols: 80,
    rows: 24,
    env: {
      ...process.env,
      BUILDERGATE_ROOT: ${JSON.stringify(paths.root)},
    },
  });
  terminal.onData((chunk) => {
    output += chunk;
    if (output.length > outputLimit) {
      output = output.slice(-outputLimit);
    }
  });
  const exitPromise = new Promise(resolve => terminal.onExit(resolve));

  await waitFor(() => fs.existsSync(${JSON.stringify(startedMarker)}), 5000, 'foreground child start');
  terminal.write('\\x03');
  await waitFor(() => fs.existsSync(${JSON.stringify(flushMarker)}), 5000, 'foreground Ctrl+C flush');
  const exit = await Promise.race([
    exitPromise,
    waitFor(() => false, 7000, 'foreground Ctrl+C exit'),
  ]);
  try { terminal.destroy(); } catch {}
  console.log(JSON.stringify({ exitCode: exit.exitCode, signal: exit.signal, output }));
})().catch((error) => {
  try { if (terminal) terminal.destroy(); } catch {}
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`, 'utf8');

  const result = await runNodeScript(harnessPath, 15000);
  assert.equal(result.code, 0, `foreground PTY harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
  const payload = JSON.parse(lastLine);

  assert.equal(fs.readFileSync(flushMarker, 'utf8'), 'SIGINT');
  assert.equal(fs.existsSync(paths.statePath), false);
  assert.match(payload.output, /Starting BuilderGate in foreground/);
  assert.doesNotMatch(payload.output, /Sentinel PID|daemon is running/);
  assert.ok([0, 130].includes(payload.exitCode));
});

test('native stop utility uses shutdown route and records stopped state', async () => {
  const paths = makeTempRuntime('buildergate-native-daemon-stop-');
  writeServerEntry(paths, 'process.exit(0);\n');
  const running = createRunningDaemonState(paths);
  writeStateAtomic(paths.statePath, running);

  const exitCode = await stopRuntime.main({
    paths,
    processExists: () => true,
    validateAppProcess: async () => ({ valid: true }),
    validateSentinelProcess: async () => ({ valid: true }),
    waitForProcessExit: async () => ({ exited: true }),
    sendShutdownRequest: async ({ port, token }) => ({
      ok: port === 2002 && token === running.shutdownToken,
      statusCode: 200,
      body: {
        workspaceFlushed: true,
        workspaceDataPath: path.join(paths.root, 'server', 'data', 'workspaces.json'),
        workspaceLastUpdated: new Date().toISOString(),
        workspaceLastCwdCount: 1,
        workspaceTabCount: 1,
        workspaceFlushMarker: '[Shutdown] Workspace state + CWDs saved',
      },
    }),
    waitForHealthNonresponse: async () => ({ stopped: true }),
  });

  assert.equal(exitCode, 0);
  const stopped = readState(paths.statePath);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.appPid, null);
  assert.equal(stopped.sentinelPid, null);
});

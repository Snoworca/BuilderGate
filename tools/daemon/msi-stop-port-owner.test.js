const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// OPS-BGSTAB-021. The MSI runs this script before InstallValidate to make sure no BuilderGate
// holds the ports it is about to serve. These tests run the real script against real processes
// on ephemeral ports -- never 2001 or 2002, which this machine may be serving in production.

const SCRIPT = path.join(__dirname, 'msi-stop-port-owner.ps1');
const isWindows = process.platform === 'win32';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnListener(port, extraArgs) {
  const script = `require('net').createServer().listen(${port}, '0.0.0.0'); setInterval(() => {}, 1000);`;
  const child = childProcess.spawn(process.execPath, ['-e', script, '--', ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return child;
}

function spawnIdle(extraArgs) {
  return childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', '--', ...extraArgs], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function waitListening(port) {
  for (let i = 0; i < 100; i += 1) {
    const listening = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} never listened`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runScript(ports, timeoutSeconds = 10) {
  return childProcess.spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Ports', ports.join(','),
    '-TimeoutSeconds', String(timeoutSeconds),
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
}

function cleanup(...children) {
  for (const child of children) {
    if (child && alive(child.pid)) child.kill();
  }
}

test('OPS-BGSTAB-021 AC-2 AC-3 a BuilderGate listener and its own sentinel are stopped', { skip: !isWindows }, async () => {
  const port = await freePort();
  const app = spawnListener(port, ['--internal-app']);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-msi-stop-'));
  const statePath = path.join(stateDir, 'daemon-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ appPid: app.pid, port }));
  const sentinel = spawnIdle(['--internal-sentinel', '--internal-sentinel-state', statePath]);
  // A sentinel of another instance: its state names another app, so it must survive.
  const otherStatePath = path.join(stateDir, 'other-state.json');
  fs.writeFileSync(otherStatePath, JSON.stringify({ appPid: 999999, port: 1 }));
  const otherSentinel = spawnIdle(['--internal-sentinel', '--internal-sentinel-state', otherStatePath]);
  try {
    await waitListening(port);
    const result = runScript([port]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(app.pid), false, 'the BuilderGate listener must be stopped');
    assert.equal(alive(sentinel.pid), false, 'its sentinel must be stopped so it cannot restart the app');
    assert.equal(alive(otherSentinel.pid), true, 'another instance sentinel must not be touched');
  } finally {
    cleanup(app, sentinel, otherSentinel);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('OPS-BGSTAB-021 AC-4 a listener that is not BuilderGate is left running', { skip: !isWindows }, async () => {
  const port = await freePort();
  const stranger = spawnListener(port, ['--some-other-program']);
  try {
    await waitListening(port);
    const result = runScript([port]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(alive(stranger.pid), true, 'an unrelated program must not be terminated');
    await waitListening(port);
  } finally {
    cleanup(stranger);
  }
});

test('OPS-BGSTAB-021 AC-2 a free port is a no-op that succeeds', { skip: !isWindows }, async () => {
  const port = await freePort();
  const result = runScript([port], 2);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

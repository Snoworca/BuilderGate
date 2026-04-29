#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;
const DEFAULT_PROFILE = process.platform === 'darwin'
  ? 'macos-arm64'
  : process.platform === 'win32'
    ? 'win-amd64'
    : 'linux-amd64';

function parseArgs(argv) {
  const options = {
    runtimeDir: path.join(ROOT, 'dist', 'bin', `${DEFAULT_PROFILE}-${PACKAGE_VERSION}`),
    port: 2002,
    timeoutMs: 45_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--runtime') {
      const next = argv[index + 1];
      if (!next) throw new Error('--runtime requires a directory');
      options.runtimeDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (current === '--port') {
      const next = argv[index + 1];
      if (!next || !/^\d+$/.test(next)) throw new Error('--port requires a number');
      options.port = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (current === '--timeout-ms') {
      const next = argv[index + 1];
      if (!next || !/^\d+$/.test(next)) throw new Error('--timeout-ms requires a number');
      options.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${current}`);
  }

  return options;
}

function getExecutablePath(runtimeDir) {
  const executableName = process.platform === 'win32' ? 'BuilderGate.exe' : 'buildergate';
  return path.join(runtimeDir, executableName);
}

function assertBootstrapSafeConfig(runtimeDir) {
  const configPath = path.join(runtimeDir, 'config.json5');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json5 missing: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf8');
  if (!/auth\s*:\s*\{[\s\S]*?password\s*:\s*""/.test(content)) {
    throw new Error('config.json5 must keep auth.password empty for first-run bootstrap');
  }
  if (!/auth\s*:\s*\{[\s\S]*?jwtSecret\s*:\s*""/.test(content)) {
    throw new Error('config.json5 must keep auth.jwtSecret empty for first-run bootstrap');
  }
  if (fs.existsSync(path.join(runtimeDir, 'server', 'config.json5'))) {
    throw new Error('server/config.json5 must not be exposed in packaged runtime');
  }
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => {
      reject(new Error(`Port ${port} is already in use. Stop BuilderGate before running packaged bootstrap smoke.`));
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(port, '127.0.0.1');
  });
}

function getRedirectPort(port) {
  const redirectPort = port - 1;
  if (redirectPort < 1) {
    throw new Error(`Port ${port} cannot be used because the HTTP redirect port would be invalid.`);
  }
  return redirectPort;
}

async function assertRuntimePortsFree(port) {
  await assertPortFree(getRedirectPort(port));
  await assertPortFree(port);
}

function createSmokeEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === 'PKG_EXECPATH' || upperKey.startsWith('BUILDERGATE_')) {
      delete env[key];
    }
  }
  return env;
}

function fetchBootstrapStatus(port) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: 'localhost',
      port,
      path: '/api/auth/bootstrap-status',
      rejectUnauthorized: false,
      timeout: 2_000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`bootstrap-status returned HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('bootstrap-status request timed out'));
    });
  });
}

async function waitForBootstrapStatus(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await fetchBootstrapStatus(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error(`bootstrap-status did not become available: ${lastError?.message ?? 'unknown error'}`);
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('process exit timed out'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function assertBootstrapStatus(status, label) {
  if (status?.setupRequired !== true || status?.requesterAllowed !== true) {
    throw new Error(`${label} expected setupRequired/requesterAllowed true, got ${JSON.stringify(status)}`);
  }
}

async function runForegroundSmoke(executablePath, runtimeDir, port, timeoutMs) {
  await assertRuntimePortsFree(port);
  const child = spawn(executablePath, ['--foreground', '-p', String(port)], {
    cwd: runtimeDir,
    env: createSmokeEnv(),
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const status = await waitForBootstrapStatus(port, timeoutMs);
    assertBootstrapStatus(status, 'foreground');
    console.log(`[smoke] foreground bootstrap-status ok: ${JSON.stringify(status)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try {
        await waitForProcessExit(child, 5_000);
      } catch {
        child.kill('SIGKILL');
        await waitForProcessExit(child, 5_000).catch(() => {});
      }
    }
  }
}

async function runDaemonSmoke(executablePath, runtimeDir, port, timeoutMs) {
  await assertRuntimePortsFree(port);
  const env = createSmokeEnv();
  const start = spawnSync(executablePath, ['-p', String(port)], {
    cwd: runtimeDir,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (start.status !== 0) {
    throw new Error(`daemon start failed: ${start.stderr || start.stdout || `exit ${start.status}`}`);
  }

  try {
    const status = await waitForBootstrapStatus(port, timeoutMs);
    assertBootstrapStatus(status, 'daemon');
    console.log(`[smoke] daemon bootstrap-status ok: ${JSON.stringify(status)}`);
  } finally {
    spawnSync(executablePath, ['stop'], {
      cwd: runtimeDir,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtimeDir = options.runtimeDir;
  const executablePath = getExecutablePath(runtimeDir);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`packaged executable missing: ${executablePath}`);
  }

  assertBootstrapSafeConfig(runtimeDir);
  await runForegroundSmoke(executablePath, runtimeDir, options.port, options.timeoutMs);
  await runDaemonSmoke(executablePath, runtimeDir, options.port, options.timeoutMs);
  console.log('[smoke] packaged bootstrap smoke passed');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[smoke] failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}

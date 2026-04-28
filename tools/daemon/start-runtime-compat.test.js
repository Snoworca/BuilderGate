const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRandomToken, readState, writeStateAtomic } = require('./state-store');

const startRuntimePath = path.resolve(__dirname, '..', 'start-runtime.js');

function loadStartRuntimeWithConfig(configPath) {
  return loadStartRuntimeWithEnv({ BUILDERGATE_CONFIG_PATH: configPath });
}

function loadStartRuntimeWithEnv(envPatch) {
  const previousConfigPath = process.env.BUILDERGATE_CONFIG_PATH;
  const previousRoot = process.env.BUILDERGATE_ROOT;

  if (Object.prototype.hasOwnProperty.call(envPatch, 'BUILDERGATE_CONFIG_PATH')) {
    process.env.BUILDERGATE_CONFIG_PATH = envPatch.BUILDERGATE_CONFIG_PATH;
  }
  if (Object.prototype.hasOwnProperty.call(envPatch, 'BUILDERGATE_ROOT')) {
    process.env.BUILDERGATE_ROOT = envPatch.BUILDERGATE_ROOT;
  }

  delete require.cache[startRuntimePath];
  const startRuntime = require(startRuntimePath);

  return {
    startRuntime,
    restore: () => {
      delete require.cache[startRuntimePath];
      if (previousConfigPath === undefined) {
        delete process.env.BUILDERGATE_CONFIG_PATH;
      } else {
        process.env.BUILDERGATE_CONFIG_PATH = previousConfigPath;
      }
      if (previousRoot === undefined) {
        delete process.env.BUILDERGATE_ROOT;
      } else {
        process.env.BUILDERGATE_ROOT = previousRoot;
      }
    },
  };
}

function createRuntimeRootFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'buildergate-runtime-root-'));
  const serverDist = path.join(root, 'server', 'dist');
  const publicDir = path.join(serverDist, 'public');
  const utilsDir = path.join(serverDist, 'utils');
  const servicesDir = path.join(serverDist, 'services');
  const shellIntegrationDir = path.join(serverDist, 'shell-integration');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(shellIntegrationDir, { recursive: true });
  fs.writeFileSync(path.join(serverDist, 'index.js'), options.serverEntry ?? 'process.exit(0);\n', 'utf8');
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html>\n', 'utf8');
  fs.writeFileSync(path.join(shellIntegrationDir, 'bash-osc133.sh'), '# bash integration\n', 'utf8');

  if (options.strictLoader !== false) {
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.writeFileSync(
      path.join(utilsDir, 'configStrictLoader.js'),
      `exports.loadConfigFromPathStrict = async () => ({ server: { port: ${options.configPort ?? 2002} } });\n`,
      'utf8',
    );
  }

  if (options.totpPreflight !== false) {
    fs.mkdirSync(servicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(servicesDir, 'daemonTotpPreflight.js'),
      'export async function runDaemonTotpPreflight() { return { enabled: false }; }\n',
      'utf8',
    );
  }

  return {
    root,
    statePath: path.join(root, 'runtime', 'buildergate.daemon.json'),
  };
}

function writeConfig(configPath, password) {
  fs.writeFileSync(configPath, `{
  server: { port: 2002 },
  auth: {
    password: "${password}",
  },
}
`, 'utf8');
}

test('--reset-password clears only the resolved BUILDERGATE_CONFIG_PATH file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-reset-password-'));
  const configA = path.join(dir, 'config-a.json5');
  const configB = path.join(dir, 'config-b.json5');
  writeConfig(configA, 'secret-a');
  writeConfig(configB, 'secret-b');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configA);
  try {
    assert.equal(startRuntime.resetPasswordInConfigFile(), true);

    assert.match(fs.readFileSync(configA, 'utf8'), /password:\s*""/);
    assert.match(fs.readFileSync(configB, 'utf8'), /password:\s*"secret-b"/);
  } finally {
    restore();
  }
});

test('--bootstrap-allow-ip is passed through runtime env and is not persisted to config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-bootstrap-env-'));
  const configPath = path.join(dir, 'config.json5');
  writeConfig(configPath, 'secret');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    const env = startRuntime.createRuntimeEnv(2002, ['127.0.0.1', '10.0.0.8'], { PATH: process.env.PATH ?? '' });

    assert.equal(env.BUILDERGATE_CONFIG_PATH, configPath);
    assert.equal(env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS, '127.0.0.1,10.0.0.8');
    assert.ok(env.BUILDERGATE_TOTP_SECRET_PATH.endsWith(path.join('server', 'data', 'totp.secret')));
    assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /127\.0\.0\.1|10\.0\.0\.8/);
  } finally {
    restore();
  }
});

test('hasDeploymentArtifacts requires strict config loader artifact, not only server and public files', () => {
  const fixture = createRuntimeRootFixture({ strictLoader: false });
  const { startRuntime, restore } = loadStartRuntimeWithEnv({ BUILDERGATE_ROOT: fixture.root });
  try {
    assert.equal(startRuntime.hasDeploymentArtifacts(), false);
  } finally {
    restore();
  }

  fs.mkdirSync(path.join(fixture.root, 'server', 'dist', 'utils'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.root, 'server', 'dist', 'utils', 'configStrictLoader.js'),
    'exports.loadConfigFromPathStrict = async () => ({ server: { port: 2002 } });\n',
    'utf8',
  );

  const { startRuntime: rebuiltStartRuntime, restore: restoreRebuilt } = loadStartRuntimeWithEnv({
    BUILDERGATE_ROOT: fixture.root,
  });
  try {
    assert.equal(rebuiltStartRuntime.hasDeploymentArtifacts(), true);
  } finally {
    restoreRebuilt();
  }
});

test('hasDeploymentArtifacts requires daemon TOTP preflight helper artifact', () => {
  const fixture = createRuntimeRootFixture({ totpPreflight: false });
  const { startRuntime, restore } = loadStartRuntimeWithEnv({ BUILDERGATE_ROOT: fixture.root });
  try {
    assert.equal(startRuntime.hasDeploymentArtifacts(), false);
  } finally {
    restore();
  }

  fs.mkdirSync(path.join(fixture.root, 'server', 'dist', 'services'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.root, 'server', 'dist', 'services', 'daemonTotpPreflight.js'),
    'export async function runDaemonTotpPreflight() { return { enabled: false }; }\n',
    'utf8',
  );

  const { startRuntime: rebuiltStartRuntime, restore: restoreRebuilt } = loadStartRuntimeWithEnv({
    BUILDERGATE_ROOT: fixture.root,
  });
  try {
    assert.equal(rebuiltStartRuntime.hasDeploymentArtifacts(), true);
  } finally {
    restoreRebuilt();
  }
});

test('start-runtime default daemon path no longer contains PM2 runtime calls', () => {
  const source = fs.readFileSync(startRuntimePath, 'utf8');

  assert.doesNotMatch(source, /pm2/i);
});

test('packaged internal daemon log tee records stdout and stderr writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-log-tee-'));
  const logPath = path.join(dir, 'buildergate-daemon.log');
  const script = `
const startRuntime = require(${JSON.stringify(startRuntimePath)});
startRuntime.installDaemonLogTee(${JSON.stringify(logPath)}, { echo: false });
process.stdout.write('stdout from internal app\\n');
process.stderr.write(Buffer.from('stderr from internal app\\n'));
`;

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /stdout from internal app/);
  assert.match(log, /stderr from internal app/);
});

test('start-runtime CLI routes --foreground through foreground child and propagates exit code', () => {
  const fixture = createRuntimeRootFixture({
    prefix: 'buildergate-foreground-cli-',
    serverEntry: `
const forbidden = [
  'BUILDERGATE_SUPPRESS_TOTP_QR',
  'BUILDERGATE_SHUTDOWN_TOKEN',
  'BUILDERGATE_DAEMON_START_ID',
  'BUILDERGATE_DAEMON_STATE_PATH',
  'BUILDERGATE_INTERNAL_MODE',
].filter((key) => process.env[key] !== undefined);
if (forbidden.length > 0) {
  console.error('forbidden daemon env: ' + forbidden.join(','));
  process.exit(12);
}
console.log('foreground child port=' + process.env.PORT);
console.log('foreground child config=' + process.env.BUILDERGATE_CONFIG_PATH);
console.log('foreground child totp=' + process.env.BUILDERGATE_TOTP_SECRET_PATH);
process.exit(7);
`,
  });

  const result = spawnSync(process.execPath, [startRuntimePath, '--foreground', '-p', '2456'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      BUILDERGATE_ROOT: fixture.root,
      BUILDERGATE_SUPPRESS_TOTP_QR: '1',
      BUILDERGATE_SHUTDOWN_TOKEN: 'leaked-token',
      BUILDERGATE_DAEMON_START_ID: 'leaked-start-id',
      BUILDERGATE_DAEMON_STATE_PATH: fixture.statePath,
      BUILDERGATE_INTERNAL_MODE: 'app',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /Starting BuilderGate in foreground/);
  assert.match(result.stdout, /foreground child port=2456/);
  assert.match(result.stdout, /foreground child config=.*server.*config\.json5/);
  assert.match(result.stdout, /foreground child totp=.*server.*data.*totp\.secret/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /pm2/i);
  assert.equal(fs.existsSync(fixture.statePath), false);
});

test('start-runtime CLI keeps legacy --forground alias on the same foreground route', () => {
  const fixture = createRuntimeRootFixture({
    prefix: 'buildergate-forground-cli-',
    serverEntry: "console.log('legacy foreground alias child'); process.exit(6);\n",
  });

  const result = spawnSync(process.execPath, [startRuntimePath, '--forground'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      BUILDERGATE_ROOT: fixture.root,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 6, result.stderr);
  assert.match(result.stdout, /legacy foreground alias child/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /pm2/i);
  assert.equal(fs.existsSync(fixture.statePath), false);
});

test('start-runtime CLI routes stop subcommand without requiring deployment artifacts', () => {
  const fixture = createRuntimeRootFixture({
    prefix: 'buildergate-stop-cli-',
    strictLoader: false,
    totpPreflight: false,
  });

  const result = spawnSync(process.execPath, [startRuntimePath, 'stop'], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      BUILDERGATE_ROOT: fixture.root,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon is not running/i);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Deployment dist missing|Building frontend|pm2/i);
});

test('createForegroundLaunchOptions connects app process to current console without daemon state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-foreground-options-'));
  const configPath = path.join(dir, 'config.json5');
  const paths = {
    root: dir,
    serverDir: path.join(dir, 'server'),
    serverCwd: path.join(dir, 'server'),
    serverEntry: path.join(dir, 'server', 'dist', 'index.js'),
    nodeBin: path.join(dir, 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    configPath,
    statePath: path.join(dir, 'runtime', 'buildergate.daemon.json'),
    logPath: path.join(dir, 'runtime', 'buildergate-daemon.log'),
    launcherPath: path.join(dir, 'BuilderGate.exe'),
    totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
    webDir: path.join(dir, 'server', 'dist', 'public'),
    shellIntegrationDir: path.join(dir, 'server', 'dist', 'shell-integration'),
  };
  writeConfig(configPath, 'secret');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    const launch = startRuntime.createForegroundLaunchOptions(2002, ['127.0.0.1'], paths);

    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [paths.serverEntry]);
    assert.equal(launch.options.cwd, paths.serverDir);
    assert.equal(launch.options.stdio, 'inherit');
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.env.NODE_ENV, 'production');
    assert.equal(launch.options.env.PORT, '2002');
    assert.equal(launch.options.env.BUILDERGATE_CONFIG_PATH, configPath);
    assert.equal(launch.options.env.BUILDERGATE_SERVER_ROOT, paths.serverCwd);
    assert.equal(launch.options.env.BUILDERGATE_WEB_ROOT, paths.webDir);
    assert.equal(launch.options.env.BUILDERGATE_SHELL_INTEGRATION_ROOT, paths.shellIntegrationDir);
    assert.equal(launch.options.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS, '127.0.0.1');
    assert.equal(launch.options.env.BUILDERGATE_TOTP_SECRET_PATH, paths.totpSecretPath);
    assert.equal(fs.existsSync(paths.statePath), false);
  } finally {
    restore();
  }
});

test('createForegroundLaunchOptions uses same executable for packaged clean layout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-foreground-packaged-self-'));
  const configPath = path.join(dir, 'config.json5');
  const paths = {
    root: dir,
    serverDir: path.resolve('server'),
    serverCwd: dir,
    serverEntry: path.resolve('server', 'dist', 'index.js'),
    nodeBin: path.join(dir, 'BuilderGate.exe'),
    configPath,
    statePath: path.join(dir, 'runtime', 'buildergate.daemon.json'),
    logPath: path.join(dir, 'runtime', 'buildergate-daemon.log'),
    launcherPath: path.join(dir, 'BuilderGate.exe'),
    totpSecretPath: path.join(dir, 'runtime', 'totp.secret'),
    webDir: path.join(dir, 'web'),
    shellIntegrationDir: path.join(dir, 'shell-integration'),
    isPackaged: true,
  };
  writeConfig(configPath, 'secret');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    const launch = startRuntime.createForegroundLaunchOptions(2002, [], paths);

    assert.equal(launch.command, paths.launcherPath);
    assert.deepEqual(launch.args, ['--internal-app']);
    assert.equal(launch.options.cwd, dir);
    assert.equal(launch.options.env.BUILDERGATE_WEB_ROOT, paths.webDir);
    assert.equal(launch.options.env.BUILDERGATE_SHELL_INTEGRATION_ROOT, paths.shellIntegrationDir);
  } finally {
    restore();
  }
});

test('runStrictConfigPreflight records daemon fatal state before port fallback on invalid config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-start-preflight-invalid-'));
  const configPath = path.join(dir, 'config.json5');
  const statePath = path.join(dir, 'runtime', 'buildergate.daemon.json');
  fs.writeFileSync(configPath, '{ server: ', 'utf8');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    await assert.rejects(
      () => startRuntime.runStrictConfigPreflight({
        mode: 'daemon',
        paths: {
          root: dir,
          serverDir: path.resolve('server'),
          serverEntry: path.resolve('server', 'dist', 'index.js'),
          nodeBin: process.execPath,
          configPath,
          statePath,
          logPath: path.join(dir, 'runtime', 'buildergate-daemon.log'),
          launcherPath: path.join(dir, 'BuilderGate.exe'),
          totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
        },
      }),
      /JSON5|invalid|end of input/i,
    );

    const state = readState(statePath);
    assert.equal(state.status, 'fatal');
    assert.equal(state.fatalStage, 'preflight');
    assert.match(state.fatalReason, /JSON5|invalid|end of input/i);
    assert.equal(state.port, null);
    assert.equal(state.appPid, null);
    assert.equal(state.sentinelPid, null);
  } finally {
    restore();
  }
});

test('runStrictConfigPreflight preserves existing active daemon state on invalid config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-start-preflight-active-invalid-'));
  const configPath = path.join(dir, 'config.json5');
  const statePath = path.join(dir, 'runtime', 'buildergate.daemon.json');
  fs.writeFileSync(configPath, '{ server: ', 'utf8');
  const now = new Date().toISOString();
  const activeState = {
    version: '1',
    appName: 'buildergate',
    mode: 'daemon',
    status: 'running',
    appPid: process.pid,
    sentinelPid: process.pid,
    port: 2002,
    launcherPath: path.join(dir, 'BuilderGate.exe'),
    serverEntryPath: path.resolve('server', 'dist', 'index.js'),
    serverCwd: path.resolve('server'),
    nodeBinPath: process.execPath,
    configPath,
    totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
    shutdownToken: createRandomToken(),
    startAttemptId: createRandomToken(),
    stateGeneration: 1,
    restartCount: 0,
    lastRestartAt: null,
    lastExitCode: null,
    fatalReason: null,
    fatalStage: null,
    appProcessStartedAt: now,
    heartbeatAt: now,
    startedAt: now,
    argvHash: 'active-daemon',
    updatedAt: now,
  };
  writeStateAtomic(statePath, activeState);

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    await assert.rejects(
      () => startRuntime.runStrictConfigPreflight({
        mode: 'daemon',
        paths: {
          root: dir,
          serverDir: path.resolve('server'),
          serverEntry: path.resolve('server', 'dist', 'index.js'),
          nodeBin: process.execPath,
          configPath,
          statePath,
          logPath: path.join(dir, 'runtime', 'buildergate-daemon.log'),
          launcherPath: path.join(dir, 'BuilderGate.exe'),
          totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
        },
        inspectExistingDaemon: async () => ({ state: activeState, active: true }),
      }),
      /JSON5|invalid|end of input/i,
    );

    const state = readState(statePath);
    assert.equal(state.status, 'running');
    assert.equal(state.appPid, process.pid);
    assert.equal(state.startAttemptId, activeState.startAttemptId);
  } finally {
    restore();
  }
});

test('runStrictConfigPreflight does not write daemon state for foreground invalid config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-start-preflight-foreground-'));
  const configPath = path.join(dir, 'config.json5');
  const statePath = path.join(dir, 'runtime', 'buildergate.daemon.json');
  fs.writeFileSync(configPath, '{ server: ', 'utf8');

  const { startRuntime, restore } = loadStartRuntimeWithConfig(configPath);
  try {
    await assert.rejects(
      () => startRuntime.runStrictConfigPreflight({
        mode: 'foreground',
        paths: {
          root: dir,
          serverDir: path.resolve('server'),
          serverEntry: path.resolve('server', 'dist', 'index.js'),
          nodeBin: process.execPath,
          configPath,
          statePath,
          logPath: path.join(dir, 'runtime', 'buildergate-daemon.log'),
          launcherPath: path.join(dir, 'BuilderGate.exe'),
          totpSecretPath: path.join(dir, 'server', 'data', 'totp.secret'),
        },
      }),
      /JSON5|invalid|end of input/i,
    );

    assert.equal(fs.existsSync(statePath), false);
  } finally {
    restore();
  }
});

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveRuntimePaths } = require('./runtime-paths');

test('resolveRuntimePaths uses the executable directory as packaged runtime root', () => {
  const execPath = path.join('C:', 'dist', 'bin', 'BuilderGate.exe');
  const paths = resolveRuntimePaths({
    env: {},
    isPackaged: true,
    execPath,
    platform: 'win32',
  });

  assert.equal(paths.root, path.dirname(execPath));
  assert.equal(paths.configPath, path.join(path.dirname(execPath), 'config.json5'));
  assert.equal(paths.serverDir, path.join(path.dirname(execPath), 'server'));
  assert.equal(paths.serverEntry, path.join(path.dirname(execPath), 'server', 'dist', 'index.js'));
  assert.equal(paths.statePath, path.join(path.dirname(execPath), 'runtime', 'buildergate.daemon.json'));
  assert.equal(paths.logDir, path.join(path.dirname(execPath), 'runtime'));
  assert.equal(paths.logPath, path.join(path.dirname(execPath), 'runtime', 'buildergate-daemon.log'));
  assert.equal(paths.sentinelLogPath, path.join(path.dirname(execPath), 'runtime', 'buildergate-sentinel.log'));
  assert.equal(paths.launcherPath, execPath);
  assert.equal(paths.totpSecretPath, path.join(path.dirname(execPath), 'server', 'data', 'totp.secret'));
});

test('resolveRuntimePaths uses source root and server config by default in source mode', () => {
  const sourceRoot = path.resolve('C:/Work/git/_Snoworca/ProjectMaster');
  const paths = resolveRuntimePaths({
    env: {},
    isPackaged: false,
    sourceRoot,
    platform: 'win32',
  });

  assert.equal(paths.root, sourceRoot);
  assert.equal(paths.configPath, path.join(sourceRoot, 'server', 'config.json5'));
  assert.equal(paths.serverDir, path.join(sourceRoot, 'server'));
  assert.equal(paths.statePath, path.join(sourceRoot, 'runtime', 'buildergate.daemon.json'));
  assert.equal(paths.logPath, path.join(sourceRoot, 'runtime', 'buildergate-daemon.log'));
  assert.equal(paths.sentinelLogPath, path.join(sourceRoot, 'runtime', 'buildergate-sentinel.log'));
  assert.equal(paths.nodeBin, process.execPath);
  assert.equal(paths.launcherPath, path.join(sourceRoot, 'tools', 'start-runtime.js'));
});

test('resolveRuntimePaths honors BUILDERGATE_ROOT and BUILDERGATE_CONFIG_PATH overrides', () => {
  const root = path.resolve('C:/runtime/root');
  const configPath = path.resolve('C:/runtime/custom/config.json5');
  const paths = resolveRuntimePaths({
    env: {
      BUILDERGATE_ROOT: root,
      BUILDERGATE_CONFIG_PATH: configPath,
    },
    isPackaged: false,
    sourceRoot: path.resolve('C:/ignored'),
    platform: 'win32',
  });

  assert.equal(paths.root, root);
  assert.equal(paths.configPath, configPath);
  assert.equal(paths.serverDir, path.join(root, 'server'));
});

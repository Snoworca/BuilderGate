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
  const codeRoot = path.resolve(__dirname, '..', '..');

  assert.equal(paths.root, path.dirname(execPath));
  assert.equal(paths.codeRoot, codeRoot);
  assert.equal(paths.configPath, path.join(path.dirname(execPath), 'config.json5'));
  assert.equal(paths.serverDir, path.join(codeRoot, 'server'));
  assert.equal(paths.serverCwd, path.dirname(execPath));
  assert.equal(paths.serverEntry, path.join(codeRoot, 'server', 'dist-pkg', 'index.cjs'));
  assert.equal(paths.configLoaderEntry, path.join(codeRoot, 'server', 'dist-pkg', 'configStrictLoader.cjs'));
  assert.equal(paths.daemonTotpPreflightEntry, path.join(codeRoot, 'server', 'dist-pkg', 'daemonTotpPreflight.cjs'));
  assert.equal(paths.webDir, path.join(path.dirname(execPath), 'web'));
  assert.equal(paths.shellIntegrationDir, path.join(path.dirname(execPath), 'shell-integration'));
  assert.equal(paths.webIndexPath, path.join(path.dirname(execPath), 'web', 'index.html'));
  assert.equal(paths.statePath, path.join(path.dirname(execPath), 'runtime', 'buildergate.daemon.json'));
  assert.equal(paths.logDir, path.join(path.dirname(execPath), 'runtime'));
  assert.equal(paths.logPath, path.join(path.dirname(execPath), 'runtime', 'buildergate-daemon.log'));
  assert.equal(paths.sentinelLogPath, path.join(path.dirname(execPath), 'runtime', 'buildergate-sentinel.log'));
  assert.equal(paths.launcherPath, execPath);
  assert.equal(paths.nodeBin, execPath);
  assert.equal(paths.totpSecretPath, path.join(path.dirname(execPath), 'runtime', 'totp.secret'));
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
  assert.equal(paths.serverCwd, path.join(sourceRoot, 'server'));
  assert.equal(paths.serverEntry, path.join(sourceRoot, 'server', 'dist', 'index.js'));
  assert.equal(paths.configLoaderEntry, path.join(sourceRoot, 'server', 'dist', 'utils', 'configStrictLoader.js'));
  assert.equal(paths.daemonTotpPreflightEntry, path.join(sourceRoot, 'server', 'dist', 'services', 'daemonTotpPreflight.js'));
  assert.equal(paths.webDir, path.join(sourceRoot, 'server', 'dist', 'public'));
  assert.equal(paths.shellIntegrationDir, path.join(sourceRoot, 'server', 'dist', 'shell-integration'));
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

test('resolveRuntimePaths supports portable runtime web and shell root overrides', () => {
  const root = path.resolve('C:/portable/BuilderGate');
  const paths = resolveRuntimePaths({
    env: {
      BUILDERGATE_ROOT: root,
      BUILDERGATE_CONFIG_PATH: path.join(root, 'config.json5'),
      BUILDERGATE_WEB_ROOT: path.join(root, 'web'),
      BUILDERGATE_SHELL_INTEGRATION_ROOT: path.join(root, 'shell-integration'),
    },
    isPackaged: false,
    sourceRoot: path.resolve('C:/ignored'),
    platform: 'win32',
    execPath: path.join(root, 'node', 'node.exe'),
  });

  assert.equal(paths.serverEntry, path.join(root, 'server', 'dist', 'index.js'));
  assert.equal(paths.configPath, path.join(root, 'config.json5'));
  assert.equal(paths.webDir, path.join(root, 'web'));
  assert.equal(paths.shellIntegrationDir, path.join(root, 'shell-integration'));
  assert.equal(paths.nodeBin, path.join(root, 'node', 'node.exe'));
  assert.equal(paths.launcherPath, path.join(root, 'tools', 'start-runtime.js'));
  assert.equal(paths.totpSecretPath, path.join(root, 'runtime', 'totp.secret'));
});

// OPS-BGSTAB-020 — an MSI-installed executable keeps user data in LocalAppData.
const { INSTALL_MARKER_FILE_NAME } = require('./runtime-paths');

function installedPaths(extra = {}) {
  const execPath = path.join('C:', 'Program Files', 'BuilderGate', 'BuilderGate.exe');
  const markerPath = path.join(path.dirname(execPath), INSTALL_MARKER_FILE_NAME);
  return {
    execPath,
    paths: resolveRuntimePaths({
      env: { LOCALAPPDATA: path.join('C:', 'Users', 'u', 'AppData', 'Local') },
      isPackaged: true,
      execPath,
      platform: 'win32',
      fileExists: (candidate) => candidate === markerPath,
      ...extra,
    }),
  };
}

test('OPS-BGSTAB-020 AC-1: installed executable keeps user data in LocalAppData and code beside the exe', () => {
  const { execPath, paths } = installedPaths();
  const installDir = path.dirname(execPath);
  const dataRoot = path.join('C:', 'Users', 'u', 'AppData', 'Local', 'BuilderGate');

  assert.equal(paths.isInstalled, true);
  assert.equal(paths.root, installDir);
  assert.equal(paths.dataRoot, dataRoot);
  assert.equal(paths.configPath, path.join(dataRoot, 'config.json5'));
  assert.equal(paths.serverCwd, dataRoot);
  assert.equal(paths.runtimeDir, path.join(dataRoot, 'runtime'));
  assert.equal(paths.statePath, path.join(dataRoot, 'runtime', 'buildergate.daemon.json'));
  assert.equal(paths.logPath, path.join(dataRoot, 'runtime', 'buildergate-daemon.log'));
  assert.equal(paths.sentinelLogPath, path.join(dataRoot, 'runtime', 'buildergate-sentinel.log'));
  assert.equal(paths.totpSecretPath, path.join(dataRoot, 'runtime', 'totp.secret'));
  assert.equal(paths.webDir, path.join(installDir, 'web'));
  assert.equal(paths.shellIntegrationDir, path.join(installDir, 'shell-integration'));
  assert.equal(paths.launcherPath, execPath);
});

test('OPS-BGSTAB-020 AC-1: the child keeps the same data root when the launcher sets BUILDERGATE_ROOT', () => {
  const { execPath, paths } = installedPaths();
  const { paths: child } = installedPaths({
    env: { LOCALAPPDATA: path.join('C:', 'Users', 'u', 'AppData', 'Local'), BUILDERGATE_ROOT: path.dirname(execPath) },
  });
  assert.equal(child.dataRoot, paths.dataRoot);
  assert.equal(child.configPath, paths.configPath);
  assert.equal(child.statePath, paths.statePath);
});

test('OPS-BGSTAB-020 AC-2: without the marker, or off Windows, the portable layout is unchanged', () => {
  const { paths: portable } = installedPaths({ fileExists: () => false });
  const installDir = path.join('C:', 'Program Files', 'BuilderGate');
  assert.equal(portable.isInstalled, false);
  assert.equal(portable.dataRoot, installDir);
  assert.equal(portable.configPath, path.join(installDir, 'config.json5'));
  assert.equal(portable.serverCwd, installDir);
  assert.equal(portable.statePath, path.join(installDir, 'runtime', 'buildergate.daemon.json'));

  const { paths: linux } = installedPaths({ platform: 'linux' });
  assert.equal(linux.isInstalled, false);
  assert.equal(linux.configPath, path.join(installDir, 'config.json5'));

  const { paths: source } = installedPaths({ isPackaged: false, sourceRoot: installDir });
  assert.equal(source.isInstalled, false);
});

test('OPS-BGSTAB-020 AC-2: an explicit BUILDERGATE_CONFIG_PATH still wins for an installed executable', () => {
  const explicit = path.join('D:', 'custom', 'config.json5');
  const { paths } = installedPaths({
    env: { LOCALAPPDATA: path.join('C:', 'Users', 'u', 'AppData', 'Local'), BUILDERGATE_CONFIG_PATH: explicit },
  });
  assert.equal(paths.configPath, path.resolve(explicit));
});

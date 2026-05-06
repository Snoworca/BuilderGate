const fs = require('fs');
const path = require('path');

const {
  CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  ROOT,
  assertSafeOutputDir,
  assertSafeOutputRoot,
  copyRuntimeFiles,
  ensureBuildArtifacts,
  ensureTargetNodeRuntime,
  parseArgs,
  resolveBuildTargets,
  validateBootstrapSafeConfigFile,
  validateSourceDaemonInputs,
} = require('./build-daemon-exe');

const SERVER_DIR = path.join(ROOT, 'server');
const SERVER_DIST_DIR = path.join(SERVER_DIR, 'dist');
const TOOLS_DIR = path.join(ROOT, 'tools');
const OUTPUT_NODE_DIR = 'node';
const WINDOWS_LAUNCHER_CMD = 'BuilderGate.cmd';
const WINDOWS_LAUNCHER_PS1 = 'BuilderGate.ps1';
const POSIX_LAUNCHER = 'buildergate';

function assertPathExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing: ${filePath}`);
  }
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDirectory(source, target, options = {}) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: options.filter,
  });
}

function copyPortableTools(outputDir) {
  const outputToolsDir = path.join(outputDir, 'tools');
  const outputDaemonDir = path.join(outputToolsDir, 'daemon');

  fs.rmSync(outputToolsDir, { recursive: true, force: true });
  fs.mkdirSync(outputDaemonDir, { recursive: true });
  copyFile(path.join(TOOLS_DIR, 'start-runtime.js'), path.join(outputToolsDir, 'start-runtime.js'));

  const daemonDir = path.join(TOOLS_DIR, 'daemon');
  for (const entry of fs.readdirSync(daemonDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) {
      continue;
    }
    if (entry.name === 'packaged-bootstrap-smoke.js') {
      continue;
    }
    copyFile(path.join(daemonDir, entry.name), path.join(outputDaemonDir, entry.name));
  }
}

function copyPortableServer(outputDir) {
  const outputServerDir = path.join(outputDir, 'server');
  fs.rmSync(outputServerDir, { recursive: true, force: true });
  fs.mkdirSync(outputServerDir, { recursive: true });

  copyFile(path.join(SERVER_DIR, 'package.json'), path.join(outputServerDir, 'package.json'));
  copyFile(path.join(SERVER_DIR, 'package-lock.json'), path.join(outputServerDir, 'package-lock.json'));
  copyDirectory(SERVER_DIST_DIR, path.join(outputServerDir, 'dist'), {
    filter: (source) => !source.endsWith(`${path.sep}public`) && !source.includes(`${path.sep}public${path.sep}`),
  });
  copyDirectory(path.join(SERVER_DIR, 'node_modules'), path.join(outputServerDir, 'node_modules'));
}

async function copyPortableNodeRuntime(outputDir, target, options = {}) {
  const nodePath = await ensureTargetNodeRuntime(target, {
    ...options,
    log: options.log ?? console.log,
  });
  const relativeNodePath = target.platform === 'win32'
    ? path.join(OUTPUT_NODE_DIR, 'node.exe')
    : path.join(OUTPUT_NODE_DIR, 'bin', 'node');
  const outputNodePath = path.join(outputDir, relativeNodePath);

  copyFile(nodePath, outputNodePath);
  if (target.platform !== 'win32') {
    fs.chmodSync(outputNodePath, 0o755);
  }

  return outputNodePath;
}

function createWindowsCmdLauncher() {
  return [
    '@echo off',
    'setlocal',
    'set "ROOT=%~dp0"',
    'set "ROOT=%ROOT:~0,-1%"',
    'set "BUILDERGATE_ROOT=%ROOT%"',
    'set "BUILDERGATE_CONFIG_PATH=%ROOT%\\config.json5"',
    'set "BUILDERGATE_WEB_ROOT=%ROOT%\\web"',
    'set "BUILDERGATE_SHELL_INTEGRATION_ROOT=%ROOT%\\shell-integration"',
    'set "BUILDERGATE_EXECUTABLE_NAME=BuilderGate.cmd"',
    '"%ROOT%\\node\\node.exe" "%ROOT%\\tools\\start-runtime.js" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function createWindowsPowerShellLauncher() {
  return [
    '$ErrorActionPreference = "Stop"',
    '$root = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$env:BUILDERGATE_ROOT = $root',
    '$env:BUILDERGATE_CONFIG_PATH = Join-Path $root "config.json5"',
    '$env:BUILDERGATE_WEB_ROOT = Join-Path $root "web"',
    '$env:BUILDERGATE_SHELL_INTEGRATION_ROOT = Join-Path $root "shell-integration"',
    '$env:BUILDERGATE_EXECUTABLE_NAME = "BuilderGate.ps1"',
    '& (Join-Path $root "node\\node.exe") (Join-Path $root "tools\\start-runtime.js") @args',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

function createPosixLauncher() {
  return [
    '#!/usr/bin/env sh',
    'set -eu',
    'ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'export BUILDERGATE_ROOT="$ROOT"',
    'export BUILDERGATE_CONFIG_PATH="$ROOT/config.json5"',
    'export BUILDERGATE_WEB_ROOT="$ROOT/web"',
    'export BUILDERGATE_SHELL_INTEGRATION_ROOT="$ROOT/shell-integration"',
    'export BUILDERGATE_EXECUTABLE_NAME="buildergate"',
    'exec "$ROOT/node/bin/node" "$ROOT/tools/start-runtime.js" "$@"',
    '',
  ].join('\n');
}

function writePortableLaunchers(outputDir, platform) {
  if (platform === 'win32') {
    fs.writeFileSync(path.join(outputDir, WINDOWS_LAUNCHER_CMD), createWindowsCmdLauncher(), 'utf8');
    fs.writeFileSync(path.join(outputDir, WINDOWS_LAUNCHER_PS1), createWindowsPowerShellLauncher(), 'utf8');
    return;
  }

  const launcherPath = path.join(outputDir, POSIX_LAUNCHER);
  fs.writeFileSync(launcherPath, createPosixLauncher(), 'utf8');
  fs.chmodSync(launcherPath, 0o755);
}

function validatePortableBuildOutput(outputDir, target) {
  const requiredPaths = [
    [path.join(outputDir, 'web', 'index.html'), path.join('web', 'index.html')],
    [path.join(outputDir, 'shell-integration', 'bash-osc133.sh'), path.join('shell-integration', 'bash-osc133.sh')],
    [path.join(outputDir, 'config.json5'), 'config.json5'],
    [path.join(outputDir, 'config.json5.example'), 'config.json5.example'],
    [path.join(outputDir, 'README.md'), 'README.md'],
    [path.join(outputDir, ICON_SVG_NAME), ICON_SVG_NAME],
    [path.join(outputDir, 'tools', 'start-runtime.js'), path.join('tools', 'start-runtime.js')],
    [path.join(outputDir, 'tools', 'daemon', 'launcher.js'), path.join('tools', 'daemon', 'launcher.js')],
    [path.join(outputDir, 'server', 'package.json'), path.join('server', 'package.json')],
    [path.join(outputDir, 'server', 'package-lock.json'), path.join('server', 'package-lock.json')],
    [path.join(outputDir, 'server', 'dist', 'index.js'), path.join('server', 'dist', 'index.js')],
    [path.join(outputDir, 'server', 'dist', 'utils', 'configStrictLoader.js'), path.join('server', 'dist', 'utils', 'configStrictLoader.js')],
    [path.join(outputDir, 'server', 'dist', 'services', 'daemonTotpPreflight.js'), path.join('server', 'dist', 'services', 'daemonTotpPreflight.js')],
    [path.join(outputDir, 'server', 'node_modules', 'node-pty', 'package.json'), path.join('server', 'node_modules', 'node-pty', 'package.json')],
    [path.join(outputDir, 'server', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js'), path.join('server', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js')],
  ];

  if (target.platform === 'win32') {
    requiredPaths.push(
      [path.join(outputDir, WINDOWS_LAUNCHER_CMD), WINDOWS_LAUNCHER_CMD],
      [path.join(outputDir, WINDOWS_LAUNCHER_PS1), WINDOWS_LAUNCHER_PS1],
      [path.join(outputDir, OUTPUT_NODE_DIR, 'node.exe'), path.join(OUTPUT_NODE_DIR, 'node.exe')],
      [path.join(outputDir, ICON_ICO_NAME), ICON_ICO_NAME],
    );
  } else {
    requiredPaths.push(
      [path.join(outputDir, POSIX_LAUNCHER), POSIX_LAUNCHER],
      [path.join(outputDir, OUTPUT_NODE_DIR, 'bin', 'node'), path.join(OUTPUT_NODE_DIR, 'bin', 'node')],
    );
  }

  if (target.platform === 'darwin') {
    requiredPaths.push([path.join(outputDir, ICON_ICNS_NAME), ICON_ICNS_NAME]);
  }

  for (const [filePath, label] of requiredPaths) {
    assertPathExists(filePath, label);
  }

  const forbiddenPaths = [
    [path.join(outputDir, 'server', 'config.json5'), 'server/config.json5 must not be exposed in release artifact'],
    [path.join(outputDir, 'server', 'dist-pkg'), 'pkg-only server/dist-pkg must not be required by portable runtime'],
  ];

  for (const [filePath, label] of forbiddenPaths) {
    if (fs.existsSync(filePath)) {
      throw new Error(`${label}: ${filePath}`);
    }
  }
}

async function buildPortableTarget(target, options = {}) {
  fs.rmSync(target.outputDir, { recursive: true, force: true });
  fs.mkdirSync(target.outputDir, { recursive: true });

  await copyRuntimeFiles(target.outputDir, {
    platform: target.platform,
    configPolicy: options.configPolicy ?? CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  });
  copyPortableTools(target.outputDir);
  copyPortableServer(target.outputDir);
  await copyPortableNodeRuntime(target.outputDir, target, options);
  writePortableLaunchers(target.outputDir, target.platform);
  validatePortableBuildOutput(target.outputDir, target);
  validateBootstrapSafeConfigFile(path.join(target.outputDir, 'config.json5'), 'portable root config.json5');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = resolveBuildTargets(options);
  const multiTargetOutputRoot = targets.length > 1 ? path.resolve(options.outputDir) : null;
  for (const target of targets) {
    assertSafeOutputDir(target.outputDir);
  }
  if (multiTargetOutputRoot) {
    assertSafeOutputRoot(multiTargetOutputRoot);
  }

  validateSourceDaemonInputs(ROOT);
  console.log(`[portable-build] Targets: ${targets.map((target) => target.profileName).join(', ')}`);
  if (multiTargetOutputRoot) {
    console.log(`[portable-build] Cleaning multi-target output root: ${multiTargetOutputRoot}`);
    fs.rmSync(multiTargetOutputRoot, { recursive: true, force: true });
    fs.mkdirSync(multiTargetOutputRoot, { recursive: true });
  }

  ensureBuildArtifacts();

  for (const target of targets) {
    console.log(`[portable-build] Output (${target.profileName}): ${target.outputDir}`);
    await buildPortableTarget(target, {
      configPolicy: options.configPolicy,
    });
    const launcherName = target.platform === 'win32' ? WINDOWS_LAUNCHER_CMD : POSIX_LAUNCHER;
    console.log(`[portable-build] Done (${target.profileName}).`);
    console.log(`[portable-build] Start: ${path.join(target.outputDir, launcherName)}`);
    console.log(`[portable-build] Stop:  ${path.join(target.outputDir, launcherName)} stop`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[portable-build] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  POSIX_LAUNCHER,
  WINDOWS_LAUNCHER_CMD,
  WINDOWS_LAUNCHER_PS1,
  buildPortableTarget,
  copyPortableNodeRuntime,
  copyPortableServer,
  copyPortableTools,
  createPosixLauncher,
  createWindowsCmdLauncher,
  createWindowsPowerShellLauncher,
  validatePortableBuildOutput,
  writePortableLaunchers,
};

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { validateReadmeFile } = require('./daemon/docs-policy');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const SERVER_DIR = path.join(ROOT, 'server');
const FRONTEND_DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const SERVER_DIST_DIR = path.join(SERVER_DIR, 'dist');
const SERVER_PUBLIC_DIR = path.join(SERVER_DIST_DIR, 'public');
const OUTPUT_DEFAULT = path.join(ROOT, 'dist', 'bin');
const DEFAULT_EXECUTABLE_NAMES = getExecutableNames(process.platform);
const APP_EXE_NAME = DEFAULT_EXECUTABLE_NAMES.appExeName;
const STOP_EXE_NAME = DEFAULT_EXECUTABLE_NAMES.stopExeName;
const REQUIRED_SOURCE_FILES = [
  path.join('tools', 'start-runtime.js'),
  path.join('tools', 'daemon', 'sentinel.js'),
  path.join('tools', 'daemon', 'sentinel-entry.js'),
  path.join('tools', 'daemon', 'launcher.js'),
];
const DAEMON_RUNTIME_FILES = [
  'config-preflight.js',
  'launcher.js',
  'log.js',
  'process-info.js',
  'readiness.js',
  'runtime-paths.js',
  'sentinel-entry.js',
  'sentinel.js',
  'state-store.js',
  'totp-preflight.js',
];

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function defaultTarget() {
  if (process.platform === 'win32') return 'node18-win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'node18-macos-arm64' : 'node18-macos-x64';
  return process.arch === 'arm64' ? 'node18-linux-arm64' : 'node18-linux-x64';
}

function platformFromPkgTarget(target) {
  if (/(^|-)win($|-)/i.test(target)) return 'win32';
  if (/(^|-)linux($|-)/i.test(target)) return 'linux';
  if (/(^|-)macos($|-)/i.test(target)) return 'darwin';
  return null;
}

function archFromPkgTarget(target) {
  if (/(^|-)x64($|-)/i.test(target)) return 'x64';
  if (/(^|-)arm64($|-)/i.test(target)) return 'arm64';
  return null;
}

function assertHostTarget(target, hostPlatform = process.platform, hostArch = process.arch) {
  const targetPlatform = platformFromPkgTarget(target);
  const targetArch = archFromPkgTarget(target);
  if (!targetPlatform) {
    throw new Error(`Unsupported pkg target platform: ${target}`);
  }

  if (!targetArch) {
    throw new Error(`Unsupported pkg target architecture: ${target}`);
  }

  if (targetPlatform !== hostPlatform || targetArch !== hostArch) {
    throw new Error(
      `Cross-platform or cross-architecture pkg targets are not supported by this build script because the bundled Node runtime and generated config must match the target OS and CPU architecture. `
      + `Run the build on ${targetPlatform}/${targetArch} or use a ${hostPlatform}/${hostArch} target.`,
    );
  }

  return targetPlatform;
}

function parseArgs(argv) {
  const options = {
    outputDir: OUTPUT_DEFAULT,
    target: defaultTarget(),
    skipRuntimeInstall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      console.log('Usage: node tools/build-daemon-exe.js [--target <pkg-target>] [--output <dist-dir>] [--skip-runtime-install]');
      console.log('');
      console.log('Builds a daemon launcher exe plus a server runtime folder.');
      console.log(`Default target: ${options.target}`);
      console.log(`Default output: ${path.relative(ROOT, options.outputDir)}`);
      process.exit(0);
    }

    if (current === '--target') {
      const next = argv[index + 1];
      if (!next) throw new Error('--target requires a pkg target value');
      options.target = next;
      index += 1;
      continue;
    }

    if (current === '--output') {
      const next = argv[index + 1];
      if (!next) throw new Error('--output requires a directory value');
      options.outputDir = path.resolve(ROOT, next);
      index += 1;
      continue;
    }

    if (current === '--skip-runtime-install') {
      options.skipRuntimeInstall = true;
      continue;
    }

    throw new Error(`Unknown option: ${current}`);
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    encoding: options.captureOutput ? 'utf8' : undefined,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const label = options.label ?? `${command} ${args.join(' ')}`;
    throw new Error(`${label} failed with exit code ${result.status}`);
  }

  return result;
}

function assertSafeOutputDir(outputDir) {
  const resolved = path.resolve(outputDir);
  const distRoot = path.resolve(ROOT, 'dist');
  if (resolved !== distRoot && !resolved.startsWith(`${distRoot}${path.sep}`)) {
    throw new Error(`Refusing to clean output outside dist/: ${resolved}`);
  }
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyRequiredFile(source, target, label) {
  assertPathExists(source, label);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

async function loadBootstrapConfigTemplate(serverDistDir = SERVER_DIST_DIR) {
  const templateModulePath = path.join(serverDistDir, 'utils', 'configTemplate.js');
  assertPathExists(templateModulePath, path.join('server', 'dist', 'utils', 'configTemplate.js'));
  const templateModule = await import(pathToFileURL(templateModulePath).href);
  if (typeof templateModule.renderBootstrapConfigTemplate !== 'function') {
    throw new Error(`renderBootstrapConfigTemplate missing in ${templateModulePath}`);
  }
  return templateModule.renderBootstrapConfigTemplate;
}

async function copyRuntimeConfigFile({
  sourceConfigPath = path.join(SERVER_DIR, 'config.json5'),
  serverDistDir = SERVER_DIST_DIR,
  targetConfigPath,
  platform = process.platform,
  renderBootstrapConfigTemplate,
  log = console.log,
}) {
  if (!targetConfigPath) {
    throw new Error('targetConfigPath is required');
  }

  if (fs.existsSync(sourceConfigPath)) {
    fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
    fs.copyFileSync(sourceConfigPath, targetConfigPath);
    return 'source';
  }

  const renderTemplate = renderBootstrapConfigTemplate ?? await loadBootstrapConfigTemplate(serverDistDir);
  fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
  fs.writeFileSync(targetConfigPath, renderTemplate(platform), 'utf8');
  log(`[exe-build] ${path.basename(sourceConfigPath)} not found; generated packaged config with ${platform} bootstrap defaults.`);
  return 'template';
}

async function copyRuntimeFiles(outputDir, options = {}) {
  const outputServerDir = path.join(outputDir, 'server');
  const outputDaemonDir = path.join(outputDir, 'tools', 'daemon');
  const platform = options.platform ?? process.platform;

  fs.mkdirSync(outputServerDir, { recursive: true });
  fs.cpSync(SERVER_DIST_DIR, path.join(outputServerDir, 'dist'), { recursive: true, force: true });
  fs.mkdirSync(outputDaemonDir, { recursive: true });
  for (const fileName of DAEMON_RUNTIME_FILES) {
    copyRequiredFile(
      path.join(ROOT, 'tools', 'daemon', fileName),
      path.join(outputDaemonDir, fileName),
      path.join('tools', 'daemon', fileName),
    );
  }
  copyFileIfExists(path.join(SERVER_DIR, 'package.json'), path.join(outputServerDir, 'package.json'));
  copyFileIfExists(path.join(SERVER_DIR, 'package-lock.json'), path.join(outputServerDir, 'package-lock.json'));
  copyFileIfExists(path.join(SERVER_DIR, 'config.json5.example'), path.join(outputDir, 'config.json5.example'));
  await copyRuntimeConfigFile({ targetConfigPath: path.join(outputDir, 'config.json5'), platform });
  copyFileIfExists(path.join(ROOT, 'README.md'), path.join(outputDir, 'README.md'));
}

function ensureDependencies(projectDir, label) {
  if (fs.existsSync(path.join(projectDir, 'node_modules'))) {
    console.log(`[exe-build] ${label} dependencies already installed. Skipping npm install.`);
    return;
  }

  console.log(`[exe-build] Installing ${label} dependencies...`);
  run(getNpmCommand(), ['install'], { cwd: projectDir, label: `${label} npm install` });
}

function ensureBuildArtifacts() {
  ensureDependencies(FRONTEND_DIR, 'frontend');
  ensureDependencies(SERVER_DIR, 'server');

  console.log('[exe-build] Building frontend...');
  run(getNpmCommand(), ['run', 'build'], { cwd: FRONTEND_DIR, label: 'frontend build' });

  console.log('[exe-build] Building server...');
  run(getNpmCommand(), ['run', 'build'], { cwd: SERVER_DIR, label: 'server build' });

  if (!fs.existsSync(path.join(FRONTEND_DIST_DIR, 'index.html'))) {
    throw new Error('Frontend index.html missing after build');
  }

  if (!fs.existsSync(path.join(SERVER_DIST_DIR, 'index.js'))) {
    throw new Error('Server index.js missing after build');
  }

  fs.rmSync(SERVER_PUBLIC_DIR, { recursive: true, force: true });
  fs.cpSync(FRONTEND_DIST_DIR, SERVER_PUBLIC_DIR, { recursive: true, force: true });
}

function installRuntimeDependencies(outputDir, skipRuntimeInstall, deps = {}) {
  return installRuntimeDependenciesWithDeps(outputDir, skipRuntimeInstall, deps);
}

function installRuntimeDependenciesWithDeps(outputDir, skipRuntimeInstall, deps = {}) {
  const runCommand = deps.runCommand ?? run;
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? console.log;

  const outputServerDir = path.join(outputDir, 'server');
  if (skipRuntimeInstall) {
    log('[exe-build] Skipping production dependency install; bundled Node will still be copied.');
  } else {
    log('[exe-build] Installing production server dependencies in output...');
    runCommand(getNpmCommand(), ['install', '--omit=dev'], {
      cwd: outputServerDir,
      label: 'runtime server npm install --omit=dev',
    });
  }

  const runtimeBinDir = path.join(outputServerDir, 'node_modules', '.bin');
  const runtimeNodeName = platform === 'win32' ? 'node.exe' : 'node';
  const runtimeNodeTarget = path.join(runtimeBinDir, runtimeNodeName);
  fs.mkdirSync(runtimeBinDir, { recursive: true });
  fs.copyFileSync(execPath, runtimeNodeTarget);
  if (platform !== 'win32') {
    fs.chmodSync(runtimeNodeTarget, 0o755);
  }
  log(`[exe-build] Bundled Node runtime: ${runtimeNodeTarget}`);
}

function buildExe(outputDir, target, options = {}) {
  const platform = options.platform ?? platformFromPkgTarget(target) ?? process.platform;
  const { appExeName, stopExeName } = getExecutableNames(platform);
  const npx = getNpxCommand();
  const commonArgs = ['--yes', 'pkg@5.8.1'];

  console.log(`[exe-build] Building daemon launcher (${target})...`);
  run(npx, [
    ...commonArgs,
    path.join(ROOT, 'tools', 'start-runtime.js'),
    '--targets', target,
    '--output', path.join(outputDir, appExeName),
    '--no-bytecode',
    '--public-packages', '*',
    '--public',
  ], { label: 'pkg daemon launcher' });

  console.log(`[exe-build] Building stop utility (${target})...`);
  run(npx, [
    ...commonArgs,
    path.join(ROOT, 'stop.js'),
    '--targets', target,
    '--output', path.join(outputDir, stopExeName),
    '--no-bytecode',
    '--public-packages', '*',
    '--public',
  ], { label: 'pkg stop utility' });
}

function getExecutableNames(platform = process.platform) {
  return {
    appExeName: platform === 'win32' ? 'BuilderGate.exe' : 'buildergate',
    stopExeName: platform === 'win32' ? 'BuilderGateStop.exe' : 'buildergate-stop',
    nodeExeName: platform === 'win32' ? 'node.exe' : 'node',
  };
}

function assertPathExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} missing: ${filePath}`);
  }
}

function assertFileContains(filePath, pattern, label) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!pattern.test(content)) {
    throw new Error(`${label} missing in ${filePath}`);
  }
}

function validateSourceDaemonInputs(root = ROOT) {
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    assertPathExists(path.join(root, relativePath), relativePath);
  }

  assertFileContains(
    path.join(root, 'tools', 'start-runtime.js'),
    /internalSentinel|--internal-sentinel|runSentinelLoop/,
    'packaged sentinel launcher entrypoint',
  );
  assertFileContains(
    path.join(root, 'tools', 'daemon', 'sentinel.js'),
    /runSentinelLoop/,
    'source sentinel loop',
  );
  assertFileContains(
    path.join(root, 'tools', 'daemon', 'sentinel-entry.js'),
    /runSentinelLoop/,
    'packaged sentinel entrypoint',
  );
  assertFileContains(
    path.join(root, 'tools', 'daemon', 'launcher.js'),
    /--internal-sentinel|sentinelEntry/,
    'sentinel launcher marker',
  );
}

function validateBuildOutput(outputDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const { appExeName, stopExeName, nodeExeName } = getExecutableNames(platform);
  const requiredPaths = [
    [path.join(outputDir, appExeName), appExeName],
    [path.join(outputDir, stopExeName), stopExeName],
    [path.join(outputDir, 'server'), 'server runtime directory'],
    [path.join(outputDir, 'server', 'dist', 'index.js'), path.join('server', 'dist', 'index.js')],
    [path.join(outputDir, 'server', 'node_modules', '.bin', nodeExeName), `bundled ${nodeExeName}`],
    ...DAEMON_RUNTIME_FILES.map(fileName => [
      path.join(outputDir, 'tools', 'daemon', fileName),
      path.join('tools', 'daemon', fileName),
    ]),
    [path.join(outputDir, 'config.json5'), 'config.json5'],
    [path.join(outputDir, 'config.json5.example'), 'config.json5.example'],
    [path.join(outputDir, 'README.md'), 'README.md'],
  ];

  for (const [filePath, label] of requiredPaths) {
    assertPathExists(filePath, label);
  }

  const pm2RuntimePath = path.join(outputDir, 'server', 'node_modules', 'pm2');
  if (fs.existsSync(pm2RuntimePath)) {
    throw new Error(`PM2 runtime dependency must not exist: ${pm2RuntimePath}`);
  }

  const readmePath = path.join(outputDir, 'README.md');
  validateReadmeFile(readmePath, 'packaged README');

  const legacyDefaultOutput = path.join(ROOT, 'dist', 'daemon');
  if (path.resolve(outputDir) === path.resolve(legacyDefaultOutput)) {
    throw new Error(`dist/daemon must not be used as the default output: ${outputDir}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetPlatform = assertHostTarget(options.target);
  assertSafeOutputDir(options.outputDir);
  validateSourceDaemonInputs(ROOT);

  console.log(`[exe-build] Output: ${options.outputDir}`);
  fs.rmSync(options.outputDir, { recursive: true, force: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  ensureBuildArtifacts();
  await copyRuntimeFiles(options.outputDir, { platform: targetPlatform });
  installRuntimeDependencies(options.outputDir, options.skipRuntimeInstall, { platform: targetPlatform });
  buildExe(options.outputDir, options.target, { platform: targetPlatform });
  validateBuildOutput(options.outputDir, { platform: targetPlatform });

  const { appExeName, stopExeName } = getExecutableNames(targetPlatform);
  console.log('[exe-build] Done.');
  console.log(`[exe-build] Start: ${path.join(options.outputDir, appExeName)}`);
  console.log(`[exe-build] Stop:  ${path.join(options.outputDir, stopExeName)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[exe-build] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  APP_EXE_NAME,
  OUTPUT_DEFAULT,
  ROOT,
  STOP_EXE_NAME,
  DAEMON_RUNTIME_FILES,
  assertSafeOutputDir,
  assertHostTarget,
  archFromPkgTarget,
  buildExe,
  copyRuntimeConfigFile,
  copyRuntimeFiles,
  defaultTarget,
  ensureBuildArtifacts,
  getExecutableNames,
  installRuntimeDependencies,
  loadBootstrapConfigTemplate,
  parseArgs,
  platformFromPkgTarget,
  validateBuildOutput,
  validateSourceDaemonInputs,
};

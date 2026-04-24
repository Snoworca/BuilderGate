const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const SERVER_DIR = path.join(ROOT, 'server');
const FRONTEND_DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const SERVER_DIST_DIR = path.join(SERVER_DIR, 'dist');
const SERVER_PUBLIC_DIR = path.join(SERVER_DIST_DIR, 'public');
const OUTPUT_DEFAULT = path.join(ROOT, 'dist', 'bin');
const APP_EXE_NAME = process.platform === 'win32' ? 'BuilderGate.exe' : 'buildergate';
const STOP_EXE_NAME = process.platform === 'win32' ? 'BuilderGateStop.exe' : 'buildergate-stop';

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

function copyRuntimeFiles(outputDir) {
  const outputServerDir = path.join(outputDir, 'server');

  fs.mkdirSync(outputServerDir, { recursive: true });
  fs.cpSync(SERVER_DIST_DIR, path.join(outputServerDir, 'dist'), { recursive: true, force: true });
  copyFileIfExists(path.join(SERVER_DIR, 'package.json'), path.join(outputServerDir, 'package.json'));
  copyFileIfExists(path.join(SERVER_DIR, 'package-lock.json'), path.join(outputServerDir, 'package-lock.json'));
  copyFileIfExists(path.join(SERVER_DIR, 'config.json5.example'), path.join(outputDir, 'config.json5.example'));
  copyFileIfExists(path.join(SERVER_DIR, 'config.json5'), path.join(outputDir, 'config.json5'));
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

function installRuntimeDependencies(outputDir, skipRuntimeInstall) {
  if (skipRuntimeInstall) {
    console.log('[exe-build] Skipping runtime dependency install.');
    return;
  }

  const outputServerDir = path.join(outputDir, 'server');
  console.log('[exe-build] Installing production server dependencies in output...');
  run(getNpmCommand(), ['install', '--omit=dev'], {
    cwd: outputServerDir,
    label: 'runtime server npm install --omit=dev',
  });

  console.log('[exe-build] Installing local PM2 runtime in output...');
  run(getNpmCommand(), ['install', '--omit=dev', '--no-save', 'pm2@latest'], {
    cwd: outputServerDir,
    label: 'runtime pm2 install',
  });

  const runtimeBinDir = path.join(outputServerDir, 'node_modules', '.bin');
  const runtimeNodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const runtimeNodeTarget = path.join(runtimeBinDir, runtimeNodeName);
  fs.mkdirSync(runtimeBinDir, { recursive: true });
  fs.copyFileSync(process.execPath, runtimeNodeTarget);
  if (process.platform !== 'win32') {
    fs.chmodSync(runtimeNodeTarget, 0o755);
  }
  console.log(`[exe-build] Bundled Node runtime: ${runtimeNodeTarget}`);
}

function buildExe(outputDir, target) {
  const npx = getNpxCommand();
  const commonArgs = ['--yes', 'pkg@5.8.1'];

  console.log(`[exe-build] Building daemon launcher (${target})...`);
  run(npx, [
    ...commonArgs,
    path.join(ROOT, 'tools', 'start-runtime.js'),
    '--targets', target,
    '--output', path.join(outputDir, APP_EXE_NAME),
    '--no-bytecode',
    '--public-packages', '*',
    '--public',
  ], { label: 'pkg daemon launcher' });

  console.log(`[exe-build] Building stop utility (${target})...`);
  run(npx, [
    ...commonArgs,
    path.join(ROOT, 'stop.js'),
    '--targets', target,
    '--output', path.join(outputDir, STOP_EXE_NAME),
    '--no-bytecode',
    '--public-packages', '*',
    '--public',
  ], { label: 'pkg stop utility' });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertSafeOutputDir(options.outputDir);

  console.log(`[exe-build] Output: ${options.outputDir}`);
  fs.rmSync(options.outputDir, { recursive: true, force: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  ensureBuildArtifacts();
  copyRuntimeFiles(options.outputDir);
  installRuntimeDependencies(options.outputDir, options.skipRuntimeInstall);
  buildExe(options.outputDir, options.target);

  console.log('[exe-build] Done.');
  console.log(`[exe-build] Start: ${path.join(options.outputDir, APP_EXE_NAME)}`);
  console.log(`[exe-build] Stop:  ${path.join(options.outputDir, STOP_EXE_NAME)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[exe-build] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

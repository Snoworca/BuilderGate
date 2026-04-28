const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { pathToFileURL } = require('url');

const { validateReadmeFile } = require('./daemon/docs-policy');
const {
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  copyIconAssets,
} = require('./daemon/icon-assets');

const ROOT = path.resolve(__dirname, '..');
const ROOT_PACKAGE = require(path.join(ROOT, 'package.json'));
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const SERVER_DIR = path.join(ROOT, 'server');
const FRONTEND_DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const SERVER_DIST_DIR = path.join(SERVER_DIR, 'dist');
const SERVER_PUBLIC_DIR = path.join(SERVER_DIST_DIR, 'public');
const OUTPUT_DEFAULT = path.join(ROOT, 'dist', 'bin');
const NODE_RUNTIME_CACHE_DIR = path.join(ROOT, 'dist', '.node-runtime');
const RCEDIT_CACHE_DIR = path.join(ROOT, 'dist', '.rcedit');
const BROWSER_ICON_PATH = path.join(FRONTEND_DIR, 'public', 'logo.svg');
const MAC_APP_BUNDLE_NAME = 'BuilderGate.app';
const MAC_APP_EXECUTABLE_NAME = 'BuilderGate';
const DEFAULT_EXECUTABLE_NAMES = getExecutableNames(process.platform);
const APP_EXE_NAME = DEFAULT_EXECUTABLE_NAMES.appExeName;
const STOP_EXE_NAME = DEFAULT_EXECUTABLE_NAMES.stopExeName;
const PACKAGE_VERSION = String(ROOT_PACKAGE.version ?? '').trim();
const TARGET_PROFILES = Object.freeze({
  'win-amd64': {
    profileName: 'win-amd64',
    pkgTarget: 'node18-win-x64',
    platform: 'win32',
    arch: 'x64',
  },
  'linux-amd64': {
    profileName: 'linux-amd64',
    pkgTarget: 'node18-linux-x64',
    platform: 'linux',
    arch: 'x64',
  },
  'win-arm64': {
    profileName: 'win-arm64',
    pkgTarget: 'node18-win-arm64',
    platform: 'win32',
    arch: 'arm64',
  },
  'linux-arm64': {
    profileName: 'linux-arm64',
    pkgTarget: 'node18-linux-arm64',
    platform: 'linux',
    arch: 'arm64',
  },
  'macos-arm64': {
    profileName: 'macos-arm64',
    pkgTarget: 'node18-macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
  },
});
const TARGET_PROFILE_ALIASES = Object.freeze({
  'windows-amd64': 'win-amd64',
  'mac-arm64': 'macos-arm64',
  'darwin-arm64': 'macos-arm64',
  'windows-arm64': 'win-arm64',
});
const REQUIRED_AMD64_TARGETS = Object.freeze(['win-amd64', 'linux-amd64']);
const ALL_ARM64_TARGETS = Object.freeze(['win-arm64', 'linux-arm64', 'macos-arm64']);
const ALL_SUPPORTED_TARGETS = Object.freeze([
  ...REQUIRED_AMD64_TARGETS,
  ...ALL_ARM64_TARGETS,
]);
const ARM64_TARGET_PROFILES = Object.freeze(Object.fromEntries(
  ALL_ARM64_TARGETS.map((profileName) => [profileName, TARGET_PROFILES[profileName]]),
));
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

function profileNameFor(platform, arch) {
  if (platform === 'win32') return `win-${arch}`;
  if (platform === 'darwin') return `macos-${arch}`;
  return `${platform}-${arch}`;
}

function nodeDistPlatformName(platform) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'darwin';
  return platform;
}

function assertSupportedPkgTarget(target) {
  const targetPlatform = platformFromPkgTarget(target);
  const targetArch = archFromPkgTarget(target);
  if (!targetPlatform) {
    throw new Error(`Unsupported pkg target platform: ${target}`);
  }

  if (!targetArch) {
    throw new Error(`Unsupported pkg target architecture: ${target}`);
  }

  return { platform: targetPlatform, arch: targetArch };
}

function assertHostTarget(target) {
  return assertSupportedPkgTarget(target).platform;
}

function normalizeTargetProfileName(profileName) {
  const normalized = String(profileName).trim().toLowerCase();
  return TARGET_PROFILE_ALIASES[normalized] ?? normalized;
}

function cloneBuildTarget(target) {
  return {
    profileName: target.profileName,
    pkgTarget: target.pkgTarget,
    platform: target.platform,
    arch: target.arch,
    outputDir: target.outputDir,
  };
}

function versionedProfileOutputName(profileName, version = PACKAGE_VERSION) {
  if (!version) {
    throw new Error('package.json version is required for target output directory names');
  }

  return `${profileName}-${version}`;
}

function resolveTargetSpec(spec) {
  const normalizedProfileName = normalizeTargetProfileName(spec);
  const profile = TARGET_PROFILES[normalizedProfileName];
  if (profile) {
    return cloneBuildTarget(profile);
  }

  const { platform, arch } = assertSupportedPkgTarget(spec);
  return {
    profileName: profileNameFor(platform, arch),
    pkgTarget: spec,
    platform,
    arch,
  };
}

function resolveBuildTargets(options) {
  const rawTargets = options.targetSpecs?.length
    ? options.targetSpecs
    : [options.target ?? defaultTarget()];
  const outputDirWasExplicit = options.outputDirWasExplicit === true;
  const targets = rawTargets.map(resolveTargetSpec);
  const useProfileSubdirs = targets.length > 1 || options.useProfileOutputDir === true;

  return targets.map((target) => {
    const profileOutputDir = useProfileSubdirs
      ? path.join(options.outputDir, versionedProfileOutputName(target.profileName))
      : options.outputDir;
    return {
      ...target,
      outputDir: outputDirWasExplicit && targets.length === 1 ? options.outputDir : profileOutputDir,
    };
  });
}

function parseArgs(argv) {
  const options = {
    outputDir: OUTPUT_DEFAULT,
    target: defaultTarget(),
    targetSpecs: [],
    useProfileOutputDir: false,
    outputDirWasExplicit: false,
    skipRuntimeInstall: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      console.log('Usage: node tools/build-daemon-exe.js [--target <pkg-target>|--profile <target-profile>|--all-supported|--required-amd64|--all-arm64] [--output <dist-dir>] [--skip-runtime-install]');
      console.log('');
      console.log('Builds daemon launcher executables plus a server runtime folder.');
      console.log(`Default target: ${options.target}`);
      console.log(`Default output: ${path.relative(ROOT, options.outputDir)}`);
      console.log(`Required amd64 profiles: ${REQUIRED_AMD64_TARGETS.join(', ')}`);
      console.log(`Additional ARM64 profiles: ${ALL_ARM64_TARGETS.join(', ')}`);
      console.log(`All supported profiles: ${ALL_SUPPORTED_TARGETS.join(', ')}`);
      process.exit(0);
    }

    if (current === '--target') {
      const next = argv[index + 1];
      if (!next) throw new Error('--target requires a pkg target value');
      options.target = next;
      options.targetSpecs = [next];
      index += 1;
      continue;
    }

    if (current === '--targets') {
      const next = argv[index + 1];
      if (!next) throw new Error('--targets requires a comma-separated target list');
      options.targetSpecs = next.split(',').map((value) => value.trim()).filter(Boolean);
      if (options.targetSpecs.length === 0) throw new Error('--targets requires at least one target');
      index += 1;
      continue;
    }

    if (current === '--profile') {
      const next = argv[index + 1];
      if (!next) throw new Error('--profile requires a build profile value');
      options.targetSpecs = [next];
      options.useProfileOutputDir = true;
      index += 1;
      continue;
    }

    if (current === '--all-arm64') {
      options.targetSpecs = [...ALL_ARM64_TARGETS];
      options.useProfileOutputDir = true;
      continue;
    }

    if (current === '--required-amd64') {
      options.targetSpecs = [...REQUIRED_AMD64_TARGETS];
      options.useProfileOutputDir = true;
      continue;
    }

    if (current === '--all-supported') {
      options.targetSpecs = [...ALL_SUPPORTED_TARGETS];
      options.useProfileOutputDir = true;
      continue;
    }

    if (current === '--output') {
      const next = argv[index + 1];
      if (!next) throw new Error('--output requires a directory value');
      options.outputDir = path.resolve(ROOT, next);
      options.outputDirWasExplicit = true;
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
    shell: options.shell ?? process.platform === 'win32',
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

function normalizeNodeVersion(version = process.versions.node) {
  return version.startsWith('v') ? version : `v${version}`;
}

function getNodeRuntimeCandidates(target, nodeVersion = process.versions.node) {
  const versionLabel = normalizeNodeVersion(nodeVersion);
  const platformName = nodeDistPlatformName(target.platform);
  const baseName = `node-${versionLabel}-${platformName}-${target.arch}`;
  const archiveExtensions = target.platform === 'win32' ? ['zip'] : ['tar.xz', 'tar.gz'];

  return archiveExtensions.map((extension) => ({
    versionLabel,
    baseName,
    archiveName: `${baseName}.${extension}`,
    archiveUrl: `https://nodejs.org/dist/${versionLabel}/${baseName}.${extension}`,
    extractRoot: path.join(NODE_RUNTIME_CACHE_DIR, versionLabel, baseName),
    nodePath: path.join(
      NODE_RUNTIME_CACHE_DIR,
      versionLabel,
      baseName,
      target.platform === 'win32' ? 'node.exe' : 'bin',
      target.platform === 'win32' ? '' : 'node',
    ),
  })).map((candidate) => ({
    ...candidate,
    nodePath: target.platform === 'win32'
      ? path.join(candidate.extractRoot, 'node.exe')
      : candidate.nodePath,
  }));
}

function downloadFile(url, targetPath, deps = {}) {
  const get = deps.httpsGet ?? https.get;
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const request = get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, targetPath, deps).then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed (${statusCode}): ${url}`));
        return;
      }

      const file = fs.createWriteStream(targetPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (error) => {
        fs.rmSync(targetPath, { force: true });
        reject(error);
      });
    });

    request.on('error', (error) => {
      fs.rmSync(targetPath, { force: true });
      reject(error);
    });
  });
}

function extractArchive(archivePath, destinationDir, deps = {}) {
  const runCommand = deps.runCommand ?? run;
  fs.mkdirSync(destinationDir, { recursive: true });

  if (/\.zip$/i.test(archivePath)) {
    if (process.platform === 'win32') {
      runCommand('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '& { param($ArchivePath, $DestinationPath) Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force }',
        archivePath,
        destinationDir,
      ], { label: 'extract Node runtime zip', shell: false });
      return;
    }

    try {
      runCommand('unzip', ['-q', archivePath, '-d', destinationDir], { label: 'extract Node runtime zip' });
      return;
    } catch (error) {
      runCommand('tar', ['-xf', archivePath, '-C', destinationDir], { label: 'extract Node runtime zip with tar' });
      return;
    }
  }

  const args = ['-xf', archivePath, '-C', destinationDir];
  if (deps.memberPath) {
    args.push(deps.memberPath);
  }
  runCommand('tar', args, { label: 'extract Node runtime archive' });
}

async function ensureTargetNodeRuntime(target, deps = {}) {
  if (deps.nodeRuntimePath) {
    assertPathExists(deps.nodeRuntimePath, 'target Node runtime');
    return deps.nodeRuntimePath;
  }

  if (!deps.forceDownload && target.platform === process.platform && target.arch === process.arch) {
    return deps.execPath ?? process.execPath;
  }

  const log = deps.log ?? console.log;
  const cacheRoot = deps.cacheRoot ?? NODE_RUNTIME_CACHE_DIR;
  const candidates = getNodeRuntimeCandidates(target, deps.nodeVersion ?? process.versions.node)
    .map((candidate) => ({
      ...candidate,
      extractRoot: candidate.extractRoot.replace(NODE_RUNTIME_CACHE_DIR, cacheRoot),
      nodePath: candidate.nodePath.replace(NODE_RUNTIME_CACHE_DIR, cacheRoot),
      archivePath: path.join(cacheRoot, candidate.versionLabel, candidate.archiveName),
      destinationDir: path.join(cacheRoot, candidate.versionLabel),
    }));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate.nodePath)) {
      log(`[exe-build] Using cached Node runtime: ${candidate.nodePath}`);
      return candidate.nodePath;
    }
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate.archivePath)) {
        log(`[exe-build] Downloading Node runtime: ${candidate.archiveUrl}`);
        await downloadFile(candidate.archiveUrl, candidate.archivePath, deps);
      }
      extractArchive(candidate.archivePath, candidate.destinationDir, {
        ...deps,
        memberPath: target.platform === 'win32' ? undefined : `${candidate.baseName}/bin/node`,
      });
      assertPathExists(candidate.nodePath, `target Node runtime ${target.profileName}`);
      if (target.platform !== 'win32') {
        fs.chmodSync(candidate.nodePath, 0o755);
      }
      return candidate.nodePath;
    } catch (error) {
      failures.push(`${candidate.archiveUrl}: ${error instanceof Error ? error.message : error}`);
      fs.rmSync(candidate.extractRoot, { recursive: true, force: true });
    }
  }

  throw new Error(`Unable to prepare Node runtime for ${target.profileName}: ${failures.join('; ')}`);
}

function getRceditExecutablePath(cacheDir = RCEDIT_CACHE_DIR) {
  const executableName = process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe';
  return path.join(cacheDir, 'node_modules', 'rcedit', 'bin', executableName);
}

function ensureRceditExecutable(deps = {}) {
  if (deps.rceditPath) {
    assertPathExists(deps.rceditPath, 'rcedit executable');
    return deps.rceditPath;
  }

  const cacheDir = deps.cacheDir ?? RCEDIT_CACHE_DIR;
  const rceditPath = getRceditExecutablePath(cacheDir);
  if (fs.existsSync(rceditPath)) {
    return rceditPath;
  }

  const runCommand = deps.runCommand ?? run;
  runCommand(getNpmCommand(), ['install', '--prefix', cacheDir, 'rcedit@5.0.2', '--omit=dev'], {
    label: 'install rcedit',
  });
  assertPathExists(rceditPath, 'rcedit executable');
  return rceditPath;
}

function assertSafeOutputDir(outputDir) {
  const resolved = path.resolve(outputDir);
  const distRoot = path.resolve(ROOT, 'dist');
  if (resolved !== distRoot && !resolved.startsWith(`${distRoot}${path.sep}`)) {
    throw new Error(`Refusing to clean output outside dist/: ${resolved}`);
  }
}

function assertSafeOutputRoot(outputDir) {
  assertSafeOutputDir(outputDir);
  const resolved = path.resolve(outputDir);
  const distRoot = path.resolve(ROOT, 'dist');
  if (resolved === distRoot) {
    throw new Error(`Refusing to clean dist/ root as a multi-target output: ${resolved}`);
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
  copyIconAssets(outputDir, { sourceSvgPath: BROWSER_ICON_PATH });
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
  const nodeRuntimePath = deps.nodeRuntimePath ?? deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const log = deps.log ?? console.log;

  const outputServerDir = path.join(outputDir, 'server');
  if (skipRuntimeInstall) {
    log('[exe-build] Skipping production dependency install; bundled Node will still be copied.');
  } else {
    log(`[exe-build] Installing production server dependencies in output for ${platform}/${arch}...`);
    const installEnv = {
      ...process.env,
      npm_config_os: platform,
      npm_config_cpu: arch,
    };
    runCommand(getNpmCommand(), ['install', '--omit=dev', '--os', platform, '--cpu', arch], {
      cwd: outputServerDir,
      env: installEnv,
      label: 'runtime server npm install --omit=dev',
    });
  }

  const runtimeBinDir = path.join(outputServerDir, 'node_modules', '.bin');
  const runtimeNodeName = platform === 'win32' ? 'node.exe' : 'node';
  const runtimeNodeTarget = path.join(runtimeBinDir, runtimeNodeName);
  fs.mkdirSync(runtimeBinDir, { recursive: true });
  fs.copyFileSync(nodeRuntimePath, runtimeNodeTarget);
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

function applyExecutableIcons(outputDir, platform, options = {}) {
  const log = options.log ?? console.log;
  const runCommand = options.runCommand ?? run;
  const { appExeName, stopExeName } = getExecutableNames(platform);
  const icoPath = path.join(outputDir, ICON_ICO_NAME);
  const svgPath = path.join(outputDir, ICON_SVG_NAME);

  assertPathExists(svgPath, ICON_SVG_NAME);

  if (platform !== 'win32') {
    log(`[exe-build] Icon assets staged: ${svgPath}`);
    return;
  }

  assertPathExists(icoPath, ICON_ICO_NAME);
  const rceditPath = ensureRceditExecutable({
    rceditPath: options.rceditPath,
    cacheDir: options.rceditCacheDir,
    runCommand,
  });

  for (const executableName of [appExeName, stopExeName]) {
    const executablePath = path.join(outputDir, executableName);
    assertPathExists(executablePath, executableName);
    log(`[exe-build] Embedding Windows icon: ${executableName}`);
    runCommand(rceditPath, [executablePath, '--set-icon', icoPath], {
      label: `rcedit ${executableName}`,
      shell: false,
    });
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createMacAppLauncherScript() {
  return `#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../Resources/runtime" && pwd)
APP_BIN="$RUNTIME_DIR/buildergate"

quote_arg() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \\$s/\\$/'/"
}

if [ -t 1 ]; then
  exec "$APP_BIN" "$@"
fi

COMMAND_FILE=$(mktemp "\${TMPDIR:-/tmp}/buildergate.XXXXXX")
cleanup() {
  rm -f "$COMMAND_FILE"
}
trap cleanup EXIT

{
  printf "cd "
  quote_arg "$RUNTIME_DIR"
  printf " && exec "
  quote_arg "$APP_BIN"
  for arg in "$@"; do
    printf " "
    quote_arg "$arg"
  done
  printf "\\n"
} > "$COMMAND_FILE"

osascript - "$COMMAND_FILE" <<'APPLESCRIPT'
on run argv
  set commandPath to item 1 of argv
  set commandText to do shell script "/bin/cat " & quoted form of commandPath
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run
APPLESCRIPT
`;
}

function createMacInfoPlist(options = {}) {
  const bundleName = options.bundleName ?? 'BuilderGate';
  const bundleIdentifier = options.bundleIdentifier ?? 'com.snoworca.buildergate';
  const bundleVersion = options.bundleVersion ?? '0.1.0';
  const executableName = options.executableName ?? MAC_APP_EXECUTABLE_NAME;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${escapeXml(bundleName)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapeXml(executableName)}</string>
  <key>CFBundleIconFile</key>
  <string>${escapeXml(ICON_ICNS_NAME)}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${escapeXml(bundleName)}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapeXml(bundleVersion)}</string>
  <key>CFBundleVersion</key>
  <string>${escapeXml(bundleVersion)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function copyMacRuntimeItem(outputDir, runtimeDir, itemName) {
  const source = path.join(outputDir, itemName);
  if (!fs.existsSync(source)) {
    return;
  }

  const target = path.join(runtimeDir, itemName);
  fs.cpSync(source, target, { recursive: true, force: true });
}

function createMacAppBundle(outputDir, options = {}) {
  const platform = options.platform ?? 'darwin';
  if (platform !== 'darwin') {
    return null;
  }

  const log = options.log ?? console.log;
  const { appExeName, stopExeName } = getExecutableNames('darwin');
  const appDir = path.join(outputDir, MAC_APP_BUNDLE_NAME);
  const contentsDir = path.join(appDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const runtimeDir = path.join(resourcesDir, 'runtime');

  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const itemName of [
    appExeName,
    stopExeName,
    'server',
    'tools',
    'config.json5',
    'config.json5.example',
    'README.md',
    ICON_SVG_NAME,
    ICON_ICO_NAME,
    ICON_ICNS_NAME,
  ]) {
    copyMacRuntimeItem(outputDir, runtimeDir, itemName);
  }

  const launcherPath = path.join(macosDir, MAC_APP_EXECUTABLE_NAME);
  fs.writeFileSync(launcherPath, createMacAppLauncherScript(), 'utf8');
  fs.chmodSync(launcherPath, 0o755);

  const appBinaryPath = path.join(runtimeDir, appExeName);
  const stopBinaryPath = path.join(runtimeDir, stopExeName);
  const bundledNodePath = path.join(runtimeDir, 'server', 'node_modules', '.bin', 'node');
  for (const executablePath of [appBinaryPath, stopBinaryPath, bundledNodePath]) {
    if (fs.existsSync(executablePath)) {
      fs.chmodSync(executablePath, 0o755);
    }
  }

  copyRequiredFile(
    path.join(outputDir, ICON_ICNS_NAME),
    path.join(resourcesDir, ICON_ICNS_NAME),
    ICON_ICNS_NAME,
  );
  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), createMacInfoPlist(options), 'utf8');

  log(`[exe-build] macOS app bundle: ${appDir}`);
  return appDir;
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
    [path.join(outputDir, 'server', 'dist', 'public', 'index.html'), path.join('server', 'dist', 'public', 'index.html')],
    [path.join(outputDir, 'server', 'node_modules', '.bin', nodeExeName), `bundled ${nodeExeName}`],
    ...DAEMON_RUNTIME_FILES.map(fileName => [
      path.join(outputDir, 'tools', 'daemon', fileName),
      path.join('tools', 'daemon', fileName),
    ]),
    [path.join(outputDir, 'config.json5'), 'config.json5'],
    [path.join(outputDir, 'config.json5.example'), 'config.json5.example'],
    [path.join(outputDir, 'README.md'), 'README.md'],
    [path.join(outputDir, ICON_SVG_NAME), ICON_SVG_NAME],
  ];

  if (platform === 'win32') {
    requiredPaths.push([path.join(outputDir, ICON_ICO_NAME), ICON_ICO_NAME]);
  }

  if (platform === 'darwin') {
    requiredPaths.push(
      [path.join(outputDir, ICON_ICNS_NAME), ICON_ICNS_NAME],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME), MAC_APP_BUNDLE_NAME],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Info.plist'), 'macOS app Info.plist'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'MacOS', MAC_APP_EXECUTABLE_NAME), 'macOS app launcher'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', ICON_ICNS_NAME), 'macOS app icon'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', appExeName), 'macOS app bundled daemon executable'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', stopExeName), 'macOS app bundled stop executable'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'server', 'dist', 'index.js'), 'macOS app server runtime'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'server', 'dist', 'public', 'index.html'), 'macOS app frontend runtime'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'server', 'node_modules', '.bin', nodeExeName), `macOS app bundled ${nodeExeName}`],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'config.json5'), 'macOS app config.json5'],
    );
  }

  for (const [filePath, label] of requiredPaths) {
    assertPathExists(filePath, label);
  }

  const pm2RuntimePath = path.join(outputDir, 'server', 'node_modules', 'pm2');
  if (fs.existsSync(pm2RuntimePath)) {
    throw new Error(`PM2 runtime dependency must not exist: ${pm2RuntimePath}`);
  }

  if (platform === 'darwin') {
    const macAppPm2RuntimePath = path.join(
      outputDir,
      MAC_APP_BUNDLE_NAME,
      'Contents',
      'Resources',
      'runtime',
      'server',
      'node_modules',
      'pm2',
    );
    if (fs.existsSync(macAppPm2RuntimePath)) {
      throw new Error(`PM2 runtime dependency must not exist: ${macAppPm2RuntimePath}`);
    }
  }

  const readmePath = path.join(outputDir, 'README.md');
  validateReadmeFile(readmePath, 'packaged README');

  if (platform === 'darwin') {
    assertFileContains(
      path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Info.plist'),
      /CFBundleIconFile[\s\S]*BuilderGate\.icns/,
      'macOS app icon plist entry',
    );
  }

  const legacyDefaultOutput = path.join(ROOT, 'dist', 'daemon');
  if (path.resolve(outputDir) === path.resolve(legacyDefaultOutput)) {
    throw new Error(`dist/daemon must not be used as the default output: ${outputDir}`);
  }
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

  console.log(`[exe-build] Targets: ${targets.map((target) => `${target.profileName}:${target.pkgTarget}`).join(', ')}`);
  if (multiTargetOutputRoot) {
    console.log(`[exe-build] Cleaning multi-target output root: ${multiTargetOutputRoot}`);
    fs.rmSync(multiTargetOutputRoot, { recursive: true, force: true });
    fs.mkdirSync(multiTargetOutputRoot, { recursive: true });
  }
  ensureBuildArtifacts();

  for (const target of targets) {
    console.log(`[exe-build] Output (${target.profileName}): ${target.outputDir}`);
    fs.rmSync(target.outputDir, { recursive: true, force: true });
    fs.mkdirSync(target.outputDir, { recursive: true });

    const targetNodeRuntime = await ensureTargetNodeRuntime(target);
    await copyRuntimeFiles(target.outputDir, { platform: target.platform });
    installRuntimeDependencies(target.outputDir, options.skipRuntimeInstall, {
      platform: target.platform,
      arch: target.arch,
      nodeRuntimePath: targetNodeRuntime,
    });
    buildExe(target.outputDir, target.pkgTarget, { platform: target.platform });
    applyExecutableIcons(target.outputDir, target.platform);
    createMacAppBundle(target.outputDir, { platform: target.platform });
    validateBuildOutput(target.outputDir, { platform: target.platform });

    const { appExeName, stopExeName } = getExecutableNames(target.platform);
    console.log(`[exe-build] Done (${target.profileName}).`);
    console.log(`[exe-build] Start: ${path.join(target.outputDir, appExeName)}`);
    console.log(`[exe-build] Stop:  ${path.join(target.outputDir, stopExeName)}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[exe-build] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  APP_EXE_NAME,
  ALL_ARM64_TARGETS,
  ALL_SUPPORTED_TARGETS,
  ARM64_TARGET_PROFILES,
  BROWSER_ICON_PATH,
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  MAC_APP_BUNDLE_NAME,
  MAC_APP_EXECUTABLE_NAME,
  NODE_RUNTIME_CACHE_DIR,
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  RCEDIT_CACHE_DIR,
  REQUIRED_AMD64_TARGETS,
  ROOT,
  STOP_EXE_NAME,
  DAEMON_RUNTIME_FILES,
  TARGET_PROFILES,
  applyExecutableIcons,
  assertSafeOutputDir,
  assertSafeOutputRoot,
  assertHostTarget,
  assertSupportedPkgTarget,
  archFromPkgTarget,
  buildExe,
  createMacAppBundle,
  createMacAppLauncherScript,
  createMacInfoPlist,
  copyRuntimeConfigFile,
  copyRuntimeFiles,
  defaultTarget,
  ensureTargetNodeRuntime,
  ensureBuildArtifacts,
  ensureRceditExecutable,
  getNodeRuntimeCandidates,
  getExecutableNames,
  getRceditExecutablePath,
  installRuntimeDependencies,
  loadBootstrapConfigTemplate,
  parseArgs,
  platformFromPkgTarget,
  profileNameFor,
  resolveBuildTargets,
  resolveTargetSpec,
  validateBuildOutput,
  validateSourceDaemonInputs,
  versionedProfileOutputName,
};

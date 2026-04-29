const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
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
const SERVER_DIST_PKG_DIR = path.join(SERVER_DIR, 'dist-pkg');
const SERVER_PACKAGED_ENTRY = path.join(SERVER_DIST_PKG_DIR, 'index.cjs');
const SERVER_PACKAGED_CONFIG_LOADER = path.join(SERVER_DIST_PKG_DIR, 'configStrictLoader.cjs');
const SERVER_PACKAGED_TOTP_PREFLIGHT = path.join(SERVER_DIST_PKG_DIR, 'daemonTotpPreflight.cjs');
const SERVER_PUBLIC_DIR = path.join(SERVER_DIST_DIR, 'public');
const OUTPUT_DEFAULT = path.join(ROOT, 'dist', 'bin');
const NODE_RUNTIME_CACHE_DIR = path.join(ROOT, 'dist', '.node-runtime');
const PKG_CACHE_DIR = path.join(ROOT, 'dist', '.pkg-cache');
const RCEDIT_CACHE_DIR = path.join(ROOT, 'dist', '.rcedit');
const PKG_FETCH_CACHE_VERSION = 'v3.4';
const PKG_FETCH_NODE_VERSION = 'v18.5.0';
const BROWSER_ICON_PATH = path.join(FRONTEND_DIR, 'public', 'logo.svg');
const MAC_APP_BUNDLE_NAME = 'BuilderGate.app';
const MAC_APP_EXECUTABLE_NAME = 'BuilderGate';
const DEFAULT_EXECUTABLE_NAMES = getExecutableNames(process.platform);
const APP_EXE_NAME = DEFAULT_EXECUTABLE_NAMES.appExeName;
const PACKAGE_VERSION = String(ROOT_PACKAGE.version ?? '').trim();
const CONFIG_POLICY_BOOTSTRAP_TEMPLATE = 'bootstrap-template';
const CONFIG_POLICY_SOURCE_OR_TEMPLATE = 'source-or-template';
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
const PACKAGED_SERVER_BUNDLES = Object.freeze([
  {
    entry: path.join(SERVER_DIST_DIR, 'index.js'),
    outfile: SERVER_PACKAGED_ENTRY,
    label: 'server runtime',
  },
  {
    entry: path.join(SERVER_DIST_DIR, 'utils', 'configStrictLoader.js'),
    outfile: SERVER_PACKAGED_CONFIG_LOADER,
    label: 'strict config preflight',
  },
  {
    entry: path.join(SERVER_DIST_DIR, 'services', 'daemonTotpPreflight.js'),
    outfile: SERVER_PACKAGED_TOTP_PREFLIGHT,
    label: 'TOTP daemon preflight',
  },
]);

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function resolveEsbuildModule() {
  const searchRoots = [SERVER_DIR, FRONTEND_DIR, ROOT];
  for (const searchRoot of searchRoots) {
    try {
      return require(require.resolve('esbuild', { paths: [searchRoot] }));
    } catch {
      // Try the next workspace. esbuild is installed by the local build toolchain.
    }
  }

  throw new Error('esbuild is required to create packaged server bundles. Run npm ci in server or frontend first.');
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
    configPolicy: CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      console.log('Usage: node tools/build-daemon-exe.js [--target <pkg-target>|--profile <target-profile>|--all-supported|--required-amd64|--all-arm64] [--output <dist-dir>] [--skip-runtime-install] [--include-user-config]');
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

    if (current === '--include-user-config') {
      options.configPolicy = CONFIG_POLICY_SOURCE_OR_TEMPLATE;
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

function getDefaultPkgCacheDir() {
  return path.join(os.homedir(), '.pkg-cache');
}

function getPkgFetchBinaryName(target) {
  const targetSuffixes = {
    'node18-win-x64': 'win-x64',
    'node18-win-arm64': 'win-arm64',
  };
  const suffix = targetSuffixes[target];
  return suffix ? `fetched-${PKG_FETCH_NODE_VERSION}-${suffix}` : null;
}

function getPkgBuiltBinaryName(target) {
  const targetSuffixes = {
    'node18-win-x64': 'win-x64',
    'node18-win-arm64': 'win-arm64',
  };
  const suffix = targetSuffixes[target];
  return suffix ? `built-${PKG_FETCH_NODE_VERSION}-${suffix}` : null;
}

function getPkgFetchBasePath(cacheDir, target) {
  const binaryName = getPkgFetchBinaryName(target);
  return binaryName ? path.join(cacheDir, PKG_FETCH_CACHE_VERSION, binaryName) : null;
}

function getPkgBuiltBasePath(cacheDir, target) {
  const binaryName = getPkgBuiltBinaryName(target);
  return binaryName ? path.join(cacheDir, PKG_FETCH_CACHE_VERSION, binaryName) : null;
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

function downloadPkgBaseToCache(target, pkgCacheDir, runCommand) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-pkg-base-'));
  const probeEntry = path.join(probeDir, 'index.js');
  const probeOutput = path.join(probeDir, 'probe.exe');
  fs.writeFileSync(probeEntry, 'console.log("buildergate pkg base probe");\n', 'utf8');

  try {
    runCommand(getNpxCommand(), [
      '--yes',
      'pkg@5.8.1',
      probeEntry,
      '--targets',
      target,
      '--output',
      probeOutput,
      '--no-bytecode',
      '--public',
    ], {
      label: `pkg base download ${target}`,
      env: {
        ...process.env,
        PKG_CACHE_PATH: pkgCacheDir,
      },
    });
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function prepareWindowsPkgBaseIcon(target, icoPath, options = {}) {
  if (platformFromPkgTarget(target) !== 'win32') {
    return null;
  }

  assertPathExists(icoPath, ICON_ICO_NAME);

  const runCommand = options.runCommand ?? run;
  const log = options.log ?? console.log;
  const pkgCacheDir = options.pkgCacheDir ?? PKG_CACHE_DIR;
  const sourcePkgCacheDir = options.sourcePkgCacheDir ?? getDefaultPkgCacheDir();
  const basePath = getPkgBuiltBasePath(pkgCacheDir, target);
  const fetchedBasePath = getPkgFetchBasePath(pkgCacheDir, target);
  if (!basePath) {
    throw new Error(`Unsupported Windows pkg target for icon embedding: ${target}`);
  }

  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  const sourceBasePath = getPkgFetchBasePath(sourcePkgCacheDir, target);
  if (sourceBasePath && fs.existsSync(sourceBasePath)) {
    fs.copyFileSync(sourceBasePath, basePath);
  } else if (!fs.existsSync(basePath)) {
    downloadPkgBaseToCache(target, pkgCacheDir, runCommand);
    if (fetchedBasePath && fs.existsSync(fetchedBasePath)) {
      fs.copyFileSync(fetchedBasePath, basePath);
    }
  }

  assertPathExists(basePath, `pkg base binary for ${target}`);
  if (fetchedBasePath) {
    fs.rmSync(fetchedBasePath, { force: true });
  }
  const rceditPath = ensureRceditExecutable({
    rceditPath: options.rceditPath,
    cacheDir: options.rceditCacheDir,
    runCommand,
  });
  log(`[exe-build] Embedding Windows icon into pkg base: ${path.relative(ROOT, basePath)}`);
  runCommand(rceditPath, [basePath, '--set-icon', icoPath], {
    label: `rcedit pkg base ${target}`,
    shell: false,
  });

  return { cacheDir: pkgCacheDir, basePath };
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
  configPolicy = CONFIG_POLICY_SOURCE_OR_TEMPLATE,
  renderBootstrapConfigTemplate,
  log = console.log,
}) {
  if (!targetConfigPath) {
    throw new Error('targetConfigPath is required');
  }

  if (configPolicy !== CONFIG_POLICY_BOOTSTRAP_TEMPLATE && fs.existsSync(sourceConfigPath)) {
    fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
    fs.copyFileSync(sourceConfigPath, targetConfigPath);
    return 'source';
  }

  const renderTemplate = renderBootstrapConfigTemplate ?? await loadBootstrapConfigTemplate(serverDistDir);
  fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
  fs.writeFileSync(targetConfigPath, renderTemplate(platform), 'utf8');
  const reason = configPolicy === CONFIG_POLICY_BOOTSTRAP_TEMPLATE
    ? 'release-safe config policy'
    : `${path.basename(sourceConfigPath)} not found`;
  log(`[exe-build] ${reason}; generated packaged config with ${platform} bootstrap defaults.`);
  return 'template';
}

async function copyRuntimeFiles(outputDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const outputWebDir = path.join(outputDir, 'web');
  const outputShellIntegrationDir = path.join(outputDir, 'shell-integration');

  fs.mkdirSync(outputWebDir, { recursive: true });
  fs.cpSync(FRONTEND_DIST_DIR, outputWebDir, { recursive: true, force: true });
  fs.rmSync(outputShellIntegrationDir, { recursive: true, force: true });
  fs.cpSync(path.join(SERVER_DIST_DIR, 'shell-integration'), outputShellIntegrationDir, { recursive: true, force: true });
  copyFileIfExists(path.join(SERVER_DIR, 'config.json5.example'), path.join(outputDir, 'config.json5.example'));
  await copyRuntimeConfigFile({
    targetConfigPath: path.join(outputDir, 'config.json5'),
    platform,
    configPolicy: options.configPolicy ?? CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  });
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

async function bundlePackagedServer(options = {}) {
  const esbuild = options.esbuild ?? resolveEsbuildModule();
  const log = options.log ?? console.log;
  const external = options.external ?? ['node-pty', 'selfsigned'];

  fs.rmSync(SERVER_DIST_PKG_DIR, { recursive: true, force: true });
  fs.mkdirSync(SERVER_DIST_PKG_DIR, { recursive: true });

  for (const bundle of PACKAGED_SERVER_BUNDLES) {
    assertPathExists(bundle.entry, bundle.label);
    log(`[exe-build] Bundling ${bundle.label}: ${path.relative(ROOT, bundle.outfile)}`);
    await esbuild.build({
      entryPoints: [bundle.entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      outfile: bundle.outfile,
      external,
      logLevel: options.logLevel ?? 'warning',
    });
    assertPathExists(bundle.outfile, `${bundle.label} bundle`);
  }
}

function installRuntimeDependencies(outputDir, skipRuntimeInstall, deps = {}) {
  return installRuntimeDependenciesWithDeps(outputDir, skipRuntimeInstall, deps);
}

function installRuntimeDependenciesWithDeps(outputDir, skipRuntimeInstall, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const log = deps.log ?? console.log;

  if (skipRuntimeInstall) {
    log('[exe-build] Skipping external runtime dependency staging.');
    return;
  }

  log(`[exe-build] External server dependencies are not staged for ${platform}/${arch}; pkg embeds the server runtime.`);
}

function buildExe(outputDir, target, options = {}) {
  const platform = options.platform ?? platformFromPkgTarget(target) ?? process.platform;
  const { appExeName } = getExecutableNames(platform);
  const npx = getNpxCommand();
  const commonArgs = ['--yes', 'pkg@5.8.1'];
  const runCommand = options.runCommand ?? run;
  const pkgBaseIcon = platform === 'win32'
    ? prepareWindowsPkgBaseIcon(target, path.join(outputDir, ICON_ICO_NAME), {
      pkgCacheDir: options.pkgCacheDir,
      rceditCacheDir: options.rceditCacheDir,
      rceditPath: options.rceditPath,
      runCommand,
      sourcePkgCacheDir: options.sourcePkgCacheDir,
      log: options.log ?? console.log,
    })
    : null;
  const env = pkgBaseIcon
    ? {
      ...process.env,
      PKG_CACHE_PATH: pkgBaseIcon.cacheDir,
    }
    : process.env;

  console.log(`[exe-build] Building daemon launcher (${target})...`);
  runCommand(npx, [
    ...commonArgs,
    ROOT,
    '--targets', target,
    '--output', path.join(outputDir, appExeName),
    '--no-bytecode',
    '--public-packages', '*',
    '--public',
  ], { label: 'pkg daemon launcher', env });
}

function applyExecutableIcons(outputDir, platform, options = {}) {
  const log = options.log ?? console.log;
  const { appExeName } = getExecutableNames(platform);
  const icoPath = path.join(outputDir, ICON_ICO_NAME);
  const svgPath = path.join(outputDir, ICON_SVG_NAME);

  assertPathExists(svgPath, ICON_SVG_NAME);

  if (platform === 'win32') {
    assertPathExists(icoPath, ICON_ICO_NAME);
    const executablePath = path.join(outputDir, appExeName);
    assertPathExists(executablePath, appExeName);
    log(`[exe-build] Windows icon embedded during pkg build; ICO asset staged: ${icoPath}`);
    return;
  }

  if (platform !== 'darwin') {
    log(`[exe-build] Icon assets staged: ${svgPath}`);
    return;
  }

  log(`[exe-build] Icon assets staged: ${svgPath}`);
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
  const { appExeName } = getExecutableNames('darwin');
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
    'web',
    'shell-integration',
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
  if (fs.existsSync(appBinaryPath)) {
    fs.chmodSync(appBinaryPath, 0o755);
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

function validateBootstrapSafeConfigFile(filePath, label = 'bootstrap-safe config.json5') {
  assertPathExists(filePath, label);
  assertFileContains(filePath, /auth\s*:\s*\{[\s\S]*?password\s*:\s*""/, `${label} empty auth.password`);
  assertFileContains(filePath, /auth\s*:\s*\{[\s\S]*?jwtSecret\s*:\s*""/, `${label} empty auth.jwtSecret`);
}

function validateBootstrapSafeBuildConfig(outputDir, options = {}) {
  const platform = options.platform ?? process.platform;
  validateBootstrapSafeConfigFile(path.join(outputDir, 'config.json5'), 'packaged root config.json5');

  const exposedServerConfigPath = path.join(outputDir, 'server', 'config.json5');
  if (fs.existsSync(exposedServerConfigPath)) {
    throw new Error(`release artifact must not expose server/config.json5: ${exposedServerConfigPath}`);
  }

  if (platform === 'darwin') {
    validateBootstrapSafeConfigFile(
      path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'config.json5'),
      'macOS app runtime config.json5',
    );
  }
}

function validateSourceDaemonInputs(root = ROOT) {
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    assertPathExists(path.join(root, relativePath), relativePath);
  }

  assertFileContains(
    path.join(root, 'tools', 'start-runtime.js'),
    /internalApp|--internal-app|internalSentinel|--internal-sentinel|runSentinelLoop/,
    'packaged internal app/sentinel launcher entrypoint',
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
    /--internal-app|--internal-sentinel|BUILDERGATE_INTERNAL_MODE/,
    'sentinel launcher marker',
  );
}

function validateBuildOutput(outputDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const { appExeName, nodeExeName } = getExecutableNames(platform);
  const requiredPaths = [
    [path.join(outputDir, appExeName), appExeName],
    [path.join(outputDir, 'web', 'index.html'), path.join('web', 'index.html')],
    [path.join(outputDir, 'shell-integration', 'bash-osc133.sh'), path.join('shell-integration', 'bash-osc133.sh')],
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
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'web', 'index.html'), 'macOS app web runtime'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'shell-integration', 'bash-osc133.sh'), 'macOS app shell integration runtime'],
      [path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'config.json5'), 'macOS app config.json5'],
    );
  }

  for (const [filePath, label] of requiredPaths) {
    assertPathExists(filePath, label);
  }

  const forbiddenPaths = [
    [path.join(outputDir, 'server'), 'server runtime directory must be embedded in the executable'],
    [path.join(outputDir, 'tools'), 'daemon tools directory must be embedded in the executable'],
    [path.join(outputDir, 'node_modules'), 'node_modules must be embedded in the executable'],
    [path.join(outputDir, nodeExeName), `standalone ${nodeExeName} must not be shipped`],
    [path.join(outputDir, 'server', 'node_modules', '.bin', nodeExeName), `bundled ${nodeExeName} must not be shipped`],
  ];

  if (platform === 'darwin') {
    const macRuntimeDir = path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime');
    forbiddenPaths.push(
      [path.join(macRuntimeDir, 'server'), 'macOS app server runtime directory must be embedded in the executable'],
      [path.join(macRuntimeDir, 'tools'), 'macOS app daemon tools directory must be embedded in the executable'],
      [path.join(macRuntimeDir, 'server', 'node_modules', '.bin', nodeExeName), `macOS app bundled ${nodeExeName} must not be shipped`],
    );
  }

  for (const [filePath, label] of forbiddenPaths) {
    if (fs.existsSync(filePath)) {
      throw new Error(`${label}: ${filePath}`);
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
  await bundlePackagedServer();

  for (const target of targets) {
    console.log(`[exe-build] Output (${target.profileName}): ${target.outputDir}`);
    fs.rmSync(target.outputDir, { recursive: true, force: true });
    fs.mkdirSync(target.outputDir, { recursive: true });

    await copyRuntimeFiles(target.outputDir, {
      platform: target.platform,
      configPolicy: options.configPolicy,
    });
    installRuntimeDependencies(target.outputDir, options.skipRuntimeInstall, {
      platform: target.platform,
      arch: target.arch,
    });
    buildExe(target.outputDir, target.pkgTarget, { platform: target.platform });
    applyExecutableIcons(target.outputDir, target.platform);
    createMacAppBundle(target.outputDir, { platform: target.platform });
    validateBuildOutput(target.outputDir, { platform: target.platform });
    if (options.configPolicy === CONFIG_POLICY_BOOTSTRAP_TEMPLATE) {
      validateBootstrapSafeBuildConfig(target.outputDir, { platform: target.platform });
    }

    const { appExeName } = getExecutableNames(target.platform);
    console.log(`[exe-build] Done (${target.profileName}).`);
    console.log(`[exe-build] Start: ${path.join(target.outputDir, appExeName)}`);
    console.log(`[exe-build] Stop:  ${path.join(target.outputDir, appExeName)} stop`);
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
  CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  CONFIG_POLICY_SOURCE_OR_TEMPLATE,
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  MAC_APP_BUNDLE_NAME,
  MAC_APP_EXECUTABLE_NAME,
  NODE_RUNTIME_CACHE_DIR,
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  PACKAGED_SERVER_BUNDLES,
  PKG_CACHE_DIR,
  PKG_FETCH_CACHE_VERSION,
  PKG_FETCH_NODE_VERSION,
  RCEDIT_CACHE_DIR,
  REQUIRED_AMD64_TARGETS,
  ROOT,
  DAEMON_RUNTIME_FILES,
  SERVER_DIST_PKG_DIR,
  SERVER_PACKAGED_CONFIG_LOADER,
  SERVER_PACKAGED_ENTRY,
  SERVER_PACKAGED_TOTP_PREFLIGHT,
  TARGET_PROFILES,
  applyExecutableIcons,
  assertSafeOutputDir,
  assertSafeOutputRoot,
  assertHostTarget,
  assertSupportedPkgTarget,
  archFromPkgTarget,
  buildExe,
  bundlePackagedServer,
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
  getPkgBuiltBasePath,
  getPkgBuiltBinaryName,
  getPkgFetchBasePath,
  getPkgFetchBinaryName,
  getRceditExecutablePath,
  installRuntimeDependencies,
  loadBootstrapConfigTemplate,
  parseArgs,
  platformFromPkgTarget,
  prepareWindowsPkgBaseIcon,
  profileNameFor,
  resolveBuildTargets,
  resolveTargetSpec,
  validateBuildOutput,
  validateBootstrapSafeBuildConfig,
  validateBootstrapSafeConfigFile,
  validateSourceDaemonInputs,
  versionedProfileOutputName,
};

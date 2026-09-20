const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALL_ARM64_TARGETS,
  ALL_SUPPORTED_TARGETS,
  CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
  CONFIG_POLICY_SOURCE_OR_TEMPLATE,
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  MAC_APP_BUNDLE_NAME,
  MAC_APP_EXECUTABLE_NAME,
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  PACKAGED_SERVER_BUNDLES,
  REQUIRED_AMD64_TARGETS,
  SERVER_PACKAGED_CONFIG_LOADER,
  SERVER_PACKAGED_ENTRY,
  SERVER_PACKAGED_TOTP_PREFLIGHT,
  TARGET_PROFILES,
  archFromPkgTarget,
  applyExecutableIcons,
  assertSafeOutputRoot,
  assertSupportedPkgTarget,
  buildExe,
  bundlePackagedServer,
  createMacAppBundle,
  copyRuntimeConfigFile,
  getExecutableNames,
  getNodeRuntimeCandidates,
  getPkgBuiltBasePath,
  getPkgFetchBasePath,
  installRuntimeDependencies,
  canEmbedWindowsIcon,
  describeNodePtyHostSupport,
  parseArgs,
  platformFromPkgTarget,
  resolveNodePtyAssetGlobs,
  resolvePkgBuildConfig,
  resolvePkgConfigPath,
  PKG_ENTRY_SCRIPT,
  prepareWindowsPkgBaseIcon,
  resolveBuildTargets,
  validateBuildOutput,
  validateBootstrapSafeBuildConfig,
  validateSourceDaemonInputs,
  versionedProfileOutputName,
} = require('../build-daemon-exe');

const { copyIconAssets } = require('./icon-assets');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createPolicyCompliantReadme() {
  return [
    'BuilderGate native daemon runtime',
    'BuilderGate.exe',
    './buildergate',
    'BuilderGate.app',
    'BuilderGate.exe --foreground',
    './buildergate --forground',
    'BuilderGate.exe stop',
    'buildergate stop',
    'config.json5',
    'dist/bin',
    'TOTP QR prints before detach',
    '--reset-password',
    '--bootstrap-allow-ip',
    '--help',
    'curl -k https://localhost:2002/health',
    '',
  ].join('\n');
}

function createBuildOutputFixture(options = {}) {
  const outputDir = makeTempDir('buildergate-build-output-');
  const platform = options.platform ?? 'win32';
  const includeWindowsIcon = options.includeWindowsIcon ?? platform === 'win32';
  const includeMacIcon = options.includeMacIcon ?? platform === 'darwin';
  const { appExeName } = getExecutableNames(platform);
  touch(path.join(outputDir, appExeName));
  touch(path.join(outputDir, 'web', 'index.html'), '<!doctype html><html></html>\n');
  touch(path.join(outputDir, 'shell-integration', 'bash-osc133.sh'), '# bash integration\n');
  touch(path.join(outputDir, 'config.json5'));
  touch(path.join(outputDir, 'config.json5.example'));
  touch(path.join(outputDir, 'README.md'), options.readmeContent ?? createPolicyCompliantReadme());
  touch(path.join(outputDir, ICON_SVG_NAME), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  if (includeWindowsIcon) {
    touch(path.join(outputDir, ICON_ICO_NAME), 'ico');
  }
  if (includeMacIcon) {
    touch(path.join(outputDir, ICON_ICNS_NAME), 'icns');
  }
  return outputDir;
}

test('build output default is dist/bin, not dist/daemon', () => {
  const options = parseArgs([]);

  assert.equal(options.outputDir, OUTPUT_DEFAULT);
  assert.equal(options.configPolicy, CONFIG_POLICY_BOOTSTRAP_TEMPLATE);
  assert.equal(path.basename(options.outputDir), 'bin');
  assert.equal(path.basename(path.dirname(options.outputDir)), 'dist');
  assert.doesNotMatch(options.outputDir, /dist[\\/]daemon$/);
});

test('build args allow explicit local user config inclusion only by opt-in', () => {
  const options = parseArgs(['--include-user-config']);

  assert.equal(options.configPolicy, CONFIG_POLICY_SOURCE_OR_TEMPLATE);
});

test('multi-target output root cleanup refuses the dist root', () => {
  assert.doesNotThrow(() => assertSafeOutputRoot(OUTPUT_DEFAULT));
  assert.throws(
    () => assertSafeOutputRoot(path.join(__dirname, '..', '..', 'dist')),
    /Refusing to clean dist\/ root/i,
  );
});

test('build target parser accepts cross-platform ARM64 pkg targets', () => {
  assert.equal(platformFromPkgTarget('node22-win-x64'), 'win32');
  assert.equal(platformFromPkgTarget('node22-linux-x64'), 'linux');
  assert.equal(platformFromPkgTarget('node22-macos-arm64'), 'darwin');
  assert.equal(archFromPkgTarget('node22-win-x64'), 'x64');
  assert.equal(archFromPkgTarget('node22-linux-arm64'), 'arm64');
  assert.deepEqual(assertSupportedPkgTarget('node22-win-arm64'), {
    platform: 'win32',
    arch: 'arm64',
  });

  assert.throws(
    () => assertSupportedPkgTarget('node22-plan9-arm64'),
    /Unsupported pkg target platform/i,
  );
});

test('supported build profiles resolve to separate dist/bin target directories', () => {
  assert.deepEqual(REQUIRED_AMD64_TARGETS, ['win-amd64', 'linux-amd64']);
  assert.deepEqual(ALL_ARM64_TARGETS, ['win-arm64', 'linux-arm64', 'macos-arm64']);
  assert.deepEqual(ALL_SUPPORTED_TARGETS, [
    'win-amd64',
    'linux-amd64',
    'win-arm64',
    'linux-arm64',
    'macos-arm64',
  ]);
  assert.deepEqual(Object.keys(TARGET_PROFILES), ALL_SUPPORTED_TARGETS);

  const allOptions = parseArgs(['--all-supported']);
  const allTargets = resolveBuildTargets(allOptions);

  assert.deepEqual(allTargets.map((target) => target.profileName), [
    'win-amd64',
    'linux-amd64',
    'win-arm64',
    'linux-arm64',
    'macos-arm64',
  ]);
  assert.deepEqual(allTargets.map((target) => target.pkgTarget), [
    'node22-win-x64',
    'node22-linux-x64',
    'node22-win-arm64',
    'node22-linux-arm64',
    'node22-macos-arm64',
  ]);
  assert.equal(allTargets[0].outputDir, path.join(OUTPUT_DEFAULT, `win-amd64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[1].outputDir, path.join(OUTPUT_DEFAULT, `linux-amd64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[2].outputDir, path.join(OUTPUT_DEFAULT, `win-arm64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[3].outputDir, path.join(OUTPUT_DEFAULT, `linux-arm64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[4].outputDir, path.join(OUTPUT_DEFAULT, `macos-arm64-${PACKAGE_VERSION}`));

  const requiredOptions = parseArgs(['--required-amd64']);
  const requiredTargets = resolveBuildTargets(requiredOptions);
  assert.deepEqual(requiredTargets.map((target) => target.profileName), ['win-amd64', 'linux-amd64']);
  assert.deepEqual(requiredTargets.map((target) => target.pkgTarget), ['node22-win-x64', 'node22-linux-x64']);

  const arm64Options = parseArgs(['--all-arm64']);
  const arm64Targets = resolveBuildTargets(arm64Options);
  assert.deepEqual(arm64Targets.map((target) => target.profileName), [
    'win-arm64',
    'linux-arm64',
    'macos-arm64',
  ]);

  const macOptions = parseArgs(['--profile', 'mac-arm64']);
  const [macTarget] = resolveBuildTargets(macOptions);
  assert.equal(macTarget.profileName, 'macos-arm64');
  assert.equal(macTarget.outputDir, path.join(OUTPUT_DEFAULT, `macos-arm64-${PACKAGE_VERSION}`));

  const winOptions = parseArgs(['--profile', 'windows-amd64']);
  const [winTarget] = resolveBuildTargets(winOptions);
  assert.equal(winTarget.profileName, 'win-amd64');
  assert.equal(winTarget.outputDir, path.join(OUTPUT_DEFAULT, `win-amd64-${PACKAGE_VERSION}`));
  assert.equal(versionedProfileOutputName('linux-amd64'), `linux-amd64-${PACKAGE_VERSION}`);
});

test('default daemon exe target keeps single dist/bin output contract', () => {
  const [target] = resolveBuildTargets(parseArgs([]));

  assert.equal(target.outputDir, OUTPUT_DEFAULT);
  assert.notEqual(path.basename(target.outputDir), target.profileName);
  assert.match(target.pkgTarget, /^node22-/);
});

test('OPS-BGSTAB-017 AC-1 the default build produces a single executable for every supported OS', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

  // The whole point of the requirement: `npm run build` reaches the single-file
  // builder, not the portable one that ships a Node runtime and node_modules.
  assert.equal(packageJson.scripts.build, 'npm run build:daemon-all');
  assert.equal(packageJson.scripts['build:daemon-all'], 'node tools/build-daemon-exe.js --all-supported');

  for (const [script, profile] of [
    ['build:windows-amd64', 'win-amd64'],
    ['build:linux-amd64', 'linux-amd64'],
    ['build:windows-arm64', 'win-arm64'],
    ['build:linux-arm64', 'linux-arm64'],
    ['build:macos-arm64', 'macos-arm64'],
  ]) {
    assert.equal(packageJson.scripts[script], `node tools/build-daemon-exe.js --profile ${profile}`);
    assert.equal(packageJson.scripts[`build:pkg:${script.slice('build:'.length)}`], `npm run ${script}`);
  }

  // Windows, Linux and macOS are each covered by at least one default target.
  const platforms = new Set(ALL_SUPPORTED_TARGETS.map((name) => TARGET_PROFILES[name].platform));
  assert.deepEqual([...platforms].sort(), ['darwin', 'linux', 'win32']);

  // The portable layout stays reachable under its own name rather than being
  // deleted: it is the fallback if a platform turns out not to survive pkg.
  assert.equal(packageJson.scripts['build:portable-all'], 'node tools/build-portable-runtime.js --all-supported');
  assert.equal(packageJson.scripts['build:portable:linux-amd64'], 'node tools/build-portable-runtime.js --profile linux-amd64');

  assert.deepEqual(packageJson.pkg.scripts.filter((entry) => entry.startsWith('server/')), [
    'server/dist-pkg/*.cjs',
    'server/node_modules/node-pty/lib/**/*.js',
  ]);

  // Assets are per target now (AC-6) and come from resolveNodePtyAssetGlobs. A
  // repo-wide list left here would never be read and would still read as
  // authoritative to the next person.
  assert.equal('assets' in packageJson.pkg, false);
});

test('OPS-BGSTAB-017 AC-6 a target embeds its own node-pty artifacts and nothing else', () => {
  const windows = resolveNodePtyAssetGlobs('win32', 'x64');

  // Measured 2026-09-21: a packaged Windows executable carrying exactly this set
  // spawned a PTY through both backends, the two producing different escape
  // sequences, so neither entry here is speculative.
  assert.deepEqual(windows, [
    'server/node_modules/node-pty/package.json',
    'server/node_modules/node-pty/prebuilds/win32-x64/*.node',
    'server/node_modules/node-pty/prebuilds/win32-x64/winpty.dll',
    'server/node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe',
    'server/node_modules/node-pty/prebuilds/win32-x64/conpty/*',
  ]);
});

test('OPS-BGSTAB-017 AC-6 macOS carries spawn-helper, which it execs rather than loads', () => {
  // node-pty only uses spawn-helper under __APPLE__ (src/unix/pty.cc); on Linux
  // it forks and execs directly, which is why the Linux set has no helper.
  assert.deepEqual(resolveNodePtyAssetGlobs('darwin', 'arm64'), [
    'server/node_modules/node-pty/package.json',
    'server/node_modules/node-pty/prebuilds/darwin-arm64/*.node',
    'server/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ]);
});

test('OPS-BGSTAB-017 AC-6 Linux takes the locally built addon because node-pty ships no Linux prebuild', () => {
  // node-pty 1.1.0 prebuilds cover darwin-{arm64,x64} and win32-{arm64,x64} only.
  // A Linux target therefore depends on the host build, which is why CI builds
  // each Linux target on a matching runner.
  assert.deepEqual(resolveNodePtyAssetGlobs('linux', 'x64'), [
    'server/node_modules/node-pty/package.json',
    'server/node_modules/node-pty/build/Release/*.node',
  ]);
});

test('OPS-BGSTAB-017 AC-6 no target glob reaches another platform or a debug symbol', () => {
  // The old static `prebuilds/**/*` put 60 MB into every executable, including
  // winpty-agent.pdb and OpenConsole.exe inside the Linux binary. Verified by
  // reading those strings back out of the built Linux executable.
  for (const profile of Object.values(TARGET_PROFILES)) {
    const globs = resolveNodePtyAssetGlobs(profile.platform, profile.arch);
    const own = profile.platform === 'linux'
      ? 'build/Release'
      : `prebuilds/${profile.platform === 'win32' ? 'win32' : 'darwin'}-${profile.arch}`;

    for (const glob of globs) {
      assert.equal(glob.includes('.pdb'), false, `${glob} reaches debug symbols`);
      assert.equal(glob.includes('**'), false, `${glob} is a recursive glob`);
      if (glob.includes('prebuilds/') || glob.includes('build/Release')) {
        assert.equal(glob.includes(own), true, `${glob} does not belong to ${profile.profileName}`);
      }
    }
  }
});

test('OPS-BGSTAB-017 AC-6 the per-target pkg config keeps the script list and swaps only the assets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const config = resolvePkgBuildConfig(TARGET_PROFILES['win-amd64']);

  // pkg refuses `package.json` and `--config` together, so the config has to
  // carry the scripts too; dropping them would silently leave the daemon
  // entrypoints out of the snapshot.
  assert.deepEqual(config.scripts, packageJson.pkg.scripts);
  assert.deepEqual(config.assets, resolveNodePtyAssetGlobs('win32', 'x64'));
});

test('packaged server bundle contract has one CJS runtime and two CJS preflight entries', () => {
  assert.deepEqual(PACKAGED_SERVER_BUNDLES.map((bundle) => bundle.outfile), [
    SERVER_PACKAGED_ENTRY,
    SERVER_PACKAGED_CONFIG_LOADER,
    SERVER_PACKAGED_TOTP_PREFLIGHT,
  ]);
  assert.deepEqual(PACKAGED_SERVER_BUNDLES.map((bundle) => path.extname(bundle.outfile)), [
    '.cjs',
    '.cjs',
    '.cjs',
  ]);
});

test('bundlePackagedServer runs esbuild for all packaged CJS entries', async () => {
  const calls = [];
  for (const bundle of PACKAGED_SERVER_BUNDLES) {
    if (!fs.existsSync(bundle.entry)) {
      touch(bundle.entry, 'export {};\n');
    }
  }

  await bundlePackagedServer({
    log: () => {},
    logLevel: 'silent',
    esbuild: {
      build: async (options) => {
        calls.push(options);
        touch(options.outfile, 'module.exports = {};\n');
      },
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.format), ['cjs', 'cjs', 'cjs']);
  assert.deepEqual(calls.map((call) => call.platform), ['node', 'node', 'node']);
  assert.deepEqual(calls.map((call) => call.external), [
    ['node-pty', 'selfsigned'],
    ['node-pty', 'selfsigned'],
    ['node-pty', 'selfsigned'],
  ]);
});

test('installRuntimeDependencies no longer stages production dependencies or bundled Node', () => {
  const outputDir = makeTempDir('buildergate-runtime-install-');
  const sourceNode = path.join(outputDir, 'fake-node.exe');
  touch(path.join(outputDir, 'server', 'package.json'), '{"name":"buildergate-server"}\n');
  touch(sourceNode, 'node-runtime');
  const calls = [];

  installRuntimeDependencies(outputDir, false, {
    execPath: sourceNode,
    platform: 'win32',
    arch: 'arm64',
    runCommand: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(calls), /pm2/i);
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe')), false);
});

test('installRuntimeDependencies leaves amd64 clean layout without npm install', () => {
  const outputDir = makeTempDir('buildergate-runtime-amd64-install-');
  const sourceNode = path.join(outputDir, 'fake-node.exe');
  touch(path.join(outputDir, 'server', 'package.json'), '{"name":"buildergate-server"}\n');
  touch(sourceNode, 'node-runtime');
  const calls = [];

  installRuntimeDependencies(outputDir, false, {
    execPath: sourceNode,
    platform: 'win32',
    arch: 'x64',
    runCommand: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules')), false);
});

test('installRuntimeDependencies skip path keeps the clean layout unchanged', () => {
  const outputDir = makeTempDir('buildergate-runtime-skip-install-');
  const sourceNode = path.join(outputDir, 'fake-node.exe');
  touch(path.join(outputDir, 'server', 'package.json'), '{"name":"buildergate-server"}\n');
  touch(sourceNode, 'node-runtime');
  const calls = [];

  installRuntimeDependencies(outputDir, true, {
    execPath: sourceNode,
    platform: 'win32',
    runCommand: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe')), false);
});

test('target Node runtime candidates use official OS and ARM64 archive names', () => {
  const [winCandidate] = getNodeRuntimeCandidates({
    profileName: 'win-arm64',
    platform: 'win32',
    arch: 'arm64',
  }, '20.11.1');
  const linuxCandidates = getNodeRuntimeCandidates({
    profileName: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
  }, '20.11.1');
  const macCandidates = getNodeRuntimeCandidates({
    profileName: 'macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
  }, '20.11.1');

  assert.match(winCandidate.archiveUrl, /node-v20\.11\.1-win-arm64\.zip$/);
  assert.match(winCandidate.nodePath, /node\.exe$/);
  assert.match(linuxCandidates[0].archiveUrl, /node-v20\.11\.1-linux-arm64\.tar\.xz$/);
  assert.match(linuxCandidates[0].nodePath, /bin[\\/]node$/);
  assert.match(macCandidates[0].archiveUrl, /node-v20\.11\.1-darwin-arm64\.tar\.xz$/);
});

test('copyIconAssets stages browser tab SVG and generated ICO', () => {
  const outputDir = makeTempDir('buildergate-icon-assets-');
  const sourceSvg = path.join(outputDir, 'logo.svg');
  touch(sourceSvg, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1" /></svg>\n');

  const result = copyIconAssets(outputDir, { sourceSvgPath: sourceSvg });

  assert.equal(fs.existsSync(result.svgPath), true);
  assert.equal(fs.existsSync(result.icoPath), true);
  assert.equal(fs.readFileSync(result.svgPath, 'utf8'), fs.readFileSync(sourceSvg, 'utf8'));
  assert.deepEqual(Array.from(fs.readFileSync(result.icoPath).subarray(0, 4)), [0, 0, 1, 0]);
  assert.equal(fs.readFileSync(result.icnsPath).subarray(0, 4).toString('ascii'), 'icns');
});

test('prepareWindowsPkgBaseIcon patches a local pkg base instead of the final executable', () => {
  const root = makeTempDir('buildergate-pkg-base-icon-');
  const sourceCacheDir = path.join(root, 'source-cache');
  const pkgCacheDir = path.join(root, 'local-cache');
  const outputDir = createBuildOutputFixture();
  const sourceBase = getPkgFetchBasePath(sourceCacheDir, 'node22-win-x64');
  const fakeRceditPath = path.join(root, 'fake-rcedit.exe');
  touch(sourceBase, 'base');
  touch(fakeRceditPath);
  const calls = [];

  const result = prepareWindowsPkgBaseIcon('node22-win-x64', path.join(outputDir, ICON_ICO_NAME), {
    pkgCacheDir,
    sourcePkgCacheDir: sourceCacheDir,
    rceditPath: fakeRceditPath,
    runCommand: (command, args, options) => {
      calls.push({ command, args, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  const localBase = getPkgBuiltBasePath(pkgCacheDir, 'node22-win-x64');
  assert.equal(result.basePath, localBase);
  assert.equal(fs.readFileSync(localBase, 'utf8'), 'base');
  assert.deepEqual(calls, [{
    command: fakeRceditPath,
    args: [
      localBase,
      '--set-icon',
      path.join(outputDir, ICON_ICO_NAME),
    ],
    label: 'rcedit pkg base node22-win-x64',
  }]);
  assert.equal(fs.existsSync(path.join(outputDir, 'BuilderGate.exe')), true);
});

test('buildExe uses the icon-patched local pkg cache for Windows executables', () => {
  const outputDir = createBuildOutputFixture();
  const sourceCacheDir = makeTempDir('buildergate-pkg-build-source-cache-');
  const pkgCacheDir = makeTempDir('buildergate-pkg-build-cache-');
  const sourceBase = getPkgFetchBasePath(sourceCacheDir, 'node22-win-x64');
  const fakeRceditPath = path.join(outputDir, 'fake-rcedit.exe');
  touch(sourceBase, 'base');
  touch(fakeRceditPath);
  const calls = [];

  buildExe(outputDir, 'node22-win-x64', {
    platform: 'win32',
    // This is the Windows-host path; rcedit cannot run anywhere else, and the
    // separate skip test covers what happens when the host is not Windows.
    hostPlatform: 'win32',
    pkgConfigPath: path.join(outputDir, 'pkg-config.json'),
    pkgCacheDir,
    sourcePkgCacheDir: sourceCacheDir,
    rceditPath: fakeRceditPath,
    runCommand: (command, args, options) => {
      calls.push({ command, args, env: options.env, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, fakeRceditPath);
  assert.deepEqual(calls[0].args, [
    getPkgBuiltBasePath(pkgCacheDir, 'node22-win-x64'),
    '--set-icon',
    path.join(outputDir, ICON_ICO_NAME),
  ]);
  assert.equal(calls[0].label, 'rcedit pkg base node22-win-x64');
  assert.match(calls[1].command, /npx(?:\.cmd)?$/);
  assert.equal(calls[1].label, 'pkg daemon launcher');
  assert.equal(calls[1].env.PKG_CACHE_PATH, pkgCacheDir);
});

test('applyExecutableIcons still requires Windows ICO as a staged artifact', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, ICON_ICO_NAME), { force: true });

  assert.throws(
    () => applyExecutableIcons(outputDir, 'win32', { log: () => {} }),
    /BuilderGate\.ico/,
  );
});

test('applyExecutableIcons does not require Windows ICO for non-Windows outputs', () => {
  const outputDir = createBuildOutputFixture({ platform: 'linux' });
  const calls = [];

  assert.doesNotThrow(() => applyExecutableIcons(outputDir, 'linux', {
    runCommand: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    log: () => {},
  }));
  assert.deepEqual(calls, []);
});

test('createMacAppBundle builds a macOS .app with ICNS icon and runtime launcher', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });

  const appDir = createMacAppBundle(outputDir, {
    platform: 'darwin',
    log: () => {},
  });

  assert.equal(appDir, path.join(outputDir, MAC_APP_BUNDLE_NAME));
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Info.plist')), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'MacOS', MAC_APP_EXECUTABLE_NAME)), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', ICON_ICNS_NAME)), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'runtime', 'buildergate')), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'runtime', 'web', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'runtime', 'shell-integration', 'bash-osc133.sh')), true);
  assert.match(
    fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8'),
    /CFBundleIconFile[\s\S]*BuilderGate\.icns/,
  );
  const launcherScript = fs.readFileSync(path.join(appDir, 'Contents', 'MacOS', MAC_APP_EXECUTABLE_NAME), 'utf8');
  assert.match(launcherScript, /Terminal/);
  assert.match(launcherScript, /Resources\/runtime/);
  assert.doesNotThrow(() => validateBuildOutput(outputDir, { platform: 'darwin' }));
});

test('copyRuntimeConfigFile generates OS-aware bootstrap config when user config is absent', async () => {
  const dir = makeTempDir('buildergate-config-copy-');
  const sourceConfigPath = path.join(dir, 'server', 'config.json5');
  const targetConfigPath = path.join(dir, 'dist', 'bin', 'config.json5');

  const result = await copyRuntimeConfigFile({
    sourceConfigPath,
    targetConfigPath,
    platform: 'win32',
    renderBootstrapConfigTemplate: (platform) => `{
  server: { port: 2002 },
  pty: { useConpty: ${platform === 'win32'}, shell: "powershell" },
}\n`,
    log: () => {},
  });

  assert.equal(result, 'template');
  assert.match(fs.readFileSync(targetConfigPath, 'utf8'), /useConpty: true/);
});

test('copyRuntimeConfigFile prefers existing user config over generated template', async () => {
  const dir = makeTempDir('buildergate-config-copy-source-');
  const sourceConfigPath = path.join(dir, 'server', 'config.json5');
  const targetConfigPath = path.join(dir, 'dist', 'bin', 'config.json5');
  touch(sourceConfigPath, '{ server: { port: 2456 } }\n');

  const result = await copyRuntimeConfigFile({
    sourceConfigPath,
    targetConfigPath,
    renderBootstrapConfigTemplate: () => '{ server: { port: 2002 } }\n',
    log: () => {},
  });

  assert.equal(result, 'source');
  assert.equal(fs.readFileSync(targetConfigPath, 'utf8'), fs.readFileSync(sourceConfigPath, 'utf8'));
});

test('copyRuntimeConfigFile release-safe policy ignores existing user config', async () => {
  const dir = makeTempDir('buildergate-config-copy-template-policy-');
  const sourceConfigPath = path.join(dir, 'server', 'config.json5');
  const targetConfigPath = path.join(dir, 'dist', 'bin', 'config.json5');
  touch(sourceConfigPath, '{ auth: { password: "encrypted-local", jwtSecret: "local-secret" } }\n');

  const result = await copyRuntimeConfigFile({
    sourceConfigPath,
    targetConfigPath,
    configPolicy: CONFIG_POLICY_BOOTSTRAP_TEMPLATE,
    renderBootstrapConfigTemplate: () => '{ auth: { password: "", jwtSecret: "" } }\n',
    log: () => {},
  });

  assert.equal(result, 'template');
  assert.equal(fs.readFileSync(targetConfigPath, 'utf8'), '{ auth: { password: "", jwtSecret: "" } }\n');
});

test('validateBootstrapSafeBuildConfig requires empty auth secrets and no exposed server config', () => {
  const outputDir = createBuildOutputFixture();
  touch(path.join(outputDir, 'config.json5'), '{ auth: { password: "", jwtSecret: "" } }\n');

  assert.doesNotThrow(() => validateBootstrapSafeBuildConfig(outputDir, { platform: 'win32' }));

  touch(path.join(outputDir, 'config.json5'), '{ auth: { password: "encrypted", jwtSecret: "" } }\n');
  assert.throws(
    () => validateBootstrapSafeBuildConfig(outputDir, { platform: 'win32' }),
    /empty auth\.password/,
  );

  touch(path.join(outputDir, 'config.json5'), '{ auth: { password: "", jwtSecret: "" } }\n');
  touch(path.join(outputDir, 'server', 'config.json5'), '{ auth: { password: "encrypted" } }\n');
  assert.throws(
    () => validateBootstrapSafeBuildConfig(outputDir, { platform: 'win32' }),
    /server\/config\.json5|server\\config\.json5/,
  );
});

test('validateBuildOutput accepts complete TTTGate-style dist/bin runtime', () => {
  const outputDir = createBuildOutputFixture();

  assert.doesNotThrow(() => validateBuildOutput(outputDir, { platform: 'win32' }));
});

test('validateBuildOutput accepts Linux runtime without ICO or ICNS artifacts', () => {
  const outputDir = createBuildOutputFixture({ platform: 'linux' });

  assert.equal(fs.existsSync(path.join(outputDir, ICON_ICO_NAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, ICON_ICNS_NAME)), false);
  assert.doesNotThrow(() => validateBuildOutput(outputDir, { platform: 'linux' }));
});

test('validateBuildOutput fails when web index is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, 'web', 'index.html'), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /web[\\/]index\.html/,
  );
});

test('validateBuildOutput rejects exposed server runtime directories', () => {
  const outputDir = createBuildOutputFixture();
  touch(path.join(outputDir, 'server', 'dist', 'index.js'));

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /server runtime directory must be embedded/i,
  );
});

test('validateBuildOutput rejects exposed daemon tools directories', () => {
  const outputDir = createBuildOutputFixture();
  touch(path.join(outputDir, 'tools', 'daemon', 'process-info.js'));

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /daemon tools directory must be embedded/i,
  );
});

test('validateBuildOutput fails when packaged icon assets are missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, ICON_SVG_NAME), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /BuilderGate\.svg/,
  );
});

test('validateBuildOutput fails when Windows ICO artifact is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, ICON_ICO_NAME), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /BuilderGate\.ico/,
  );
});

test('validateBuildOutput fails when macOS ICNS artifact is missing', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });
  createMacAppBundle(outputDir, {
    platform: 'darwin',
    log: () => {},
  });
  fs.rmSync(path.join(outputDir, ICON_ICNS_NAME), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /BuilderGate\.icns/,
  );
});

test('validateBuildOutput fails when macOS app bundle is missing', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /BuilderGate\.app/,
  );
});

test('validateBuildOutput fails when macOS app web runtime is missing', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });
  createMacAppBundle(outputDir, {
    platform: 'darwin',
    log: () => {},
  });
  fs.rmSync(
    path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'web', 'index.html'),
    { force: true },
  );

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /macOS app web runtime/,
  );
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`validateBuildOutput rejects bundled Node/runtime directory in ${platform} output`, () => {
    const outputDir = createBuildOutputFixture({ platform });
    if (platform === 'darwin') {
      createMacAppBundle(outputDir, {
        platform: 'darwin',
        log: () => {},
      });
    }
    const { nodeExeName } = getExecutableNames(platform);
    touch(path.join(outputDir, 'server', 'node_modules', '.bin', nodeExeName), 'node');

    assert.throws(
      () => validateBuildOutput(outputDir, { platform }),
      /server runtime directory must be embedded/i,
    );
  });
}

test('validateBuildOutput rejects exposed runtime inside macOS app bundle', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });
  createMacAppBundle(outputDir, {
    platform: 'darwin',
    log: () => {},
  });
  touch(
    path.join(
      outputDir,
      MAC_APP_BUNDLE_NAME,
      'Contents',
      'Resources',
      'runtime',
      'server',
      'dist',
      'index.js',
    ),
    'console.log("leaked");\n',
  );

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /macOS app server runtime directory must be embedded/i,
  );
});

test('validateBuildOutput rejects PM2 documentation in packaged README', () => {
  const outputDir = createBuildOutputFixture({
    readmeContent: 'This packaged runtime starts with PM2.\n',
  });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /forbidden pattern found: pm2 token/i,
  );
});

test('validateSourceDaemonInputs requires source and packaged sentinel entrypoints', () => {
  const root = makeTempDir('buildergate-source-inputs-');
  touch(path.join(root, 'tools', 'start-runtime.js'), "daemonLauncher.runSentinelLoop(); '--internal-app'; '--internal-sentinel';\n");
  touch(path.join(root, 'tools', 'daemon', 'sentinel.js'), 'function runSentinelLoop() {}\n');
  touch(path.join(root, 'tools', 'daemon', 'sentinel-entry.js'), "require('./sentinel').runSentinelLoop();\n");
  touch(path.join(root, 'tools', 'daemon', 'launcher.js'), "args: ['--internal-app']; args: ['--internal-sentinel'];\n");

  assert.doesNotThrow(() => validateSourceDaemonInputs(root));

  fs.rmSync(path.join(root, 'tools', 'daemon', 'sentinel.js'), { force: true });
  assert.throws(
    () => validateSourceDaemonInputs(root),
    /tools[\\/]daemon[\\/]sentinel\.js/,
  );
});

test('OPS-BGSTAB-017 a Windows or macOS target packages from any host', () => {
  // node-pty ships prebuilt addons for both, so pkg can embed the right file
  // without the host matching. Measured 2026-09-21: a win32-x64 executable
  // packaged on linux/x64 spawned a PTY on Windows through both backends.
  for (const profileName of ['win-amd64', 'win-arm64', 'macos-arm64']) {
    const support = describeNodePtyHostSupport(TARGET_PROFILES[profileName], {
      platform: 'linux',
      arch: 'x64',
    });
    assert.equal(support.supported, true, `${profileName} should package from linux/x64`);
    assert.equal(support.reason, null);
  }
});

test('OPS-BGSTAB-017 a Linux target refuses a host of another architecture', () => {
  // Without this the build succeeds and produces an executable carrying an x64
  // addon for an arm64 machine: it looks right and cannot open a terminal.
  const support = describeNodePtyHostSupport(TARGET_PROFILES['linux-arm64'], {
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(support.supported, false);
  assert.match(support.reason, /linux\/arm64 host/);
  assert.match(support.reason, /this one is linux\/x64/);
});

test('OPS-BGSTAB-017 a Linux target is supported on a matching host', () => {
  // Boundary: the guard must not block the case release CI actually runs, where
  // every Linux target is built on a runner of its own architecture.
  for (const [profileName, arch] of [['linux-amd64', 'x64'], ['linux-arm64', 'arm64']]) {
    const support = describeNodePtyHostSupport(TARGET_PROFILES[profileName], {
      platform: 'linux',
      arch,
    });
    assert.equal(support.supported, true, `${profileName} on linux/${arch}`);
  }
});

test('OPS-BGSTAB-017 a Linux target refuses a non-Linux host', () => {
  const support = describeNodePtyHostSupport(TARGET_PROFILES['linux-amd64'], {
    platform: 'win32',
    arch: 'x64',
  });

  assert.equal(support.supported, false);
  assert.match(support.reason, /this one is win32\/x64/);
});

test('OPS-BGSTAB-017 the Windows icon step is skipped, not failed, on a non-Windows host', () => {
  // rcedit is itself a Windows executable. Under WSL it starts and then cannot
  // read its own argument: `Unable to load file: "/mnt/c/.../built-v22.22.2-win-x64"`.
  // The base binary is a valid PE32+ and pkg packages it correctly without the
  // icon, so losing the icon must not lose the executable.
  assert.equal(canEmbedWindowsIcon('win32'), true);
  assert.equal(canEmbedWindowsIcon('linux'), false);
  assert.equal(canEmbedWindowsIcon('darwin'), false);

  const outputDir = createBuildOutputFixture();
  const calls = [];
  buildExe(outputDir, 'node22-win-x64', {
    platform: 'win32',
    hostPlatform: 'linux',
    pkgConfigPath: path.join(outputDir, 'pkg-config.json'),
    runCommand: (command, args, options) => {
      calls.push({ command, args, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  // One call, and it is pkg — rcedit was not attempted.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'pkg daemon launcher');
  assert.equal(calls.some((call) => call.label.startsWith('rcedit')), false);
});

test('OPS-BGSTAB-017 the packaged build names the entry and a per-target config', () => {
  const outputDir = createBuildOutputFixture({ platform: 'linux' });
  const configPath = path.join(outputDir, 'pkg-config.json');
  const calls = [];

  buildExe(outputDir, 'node22-linux-x64', {
    platform: 'linux',
    pkgConfigPath: configPath,
    runCommand: (command, args, options) => {
      calls.push({ command, args, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  const args = calls[0].args;
  // pkg refuses `package.json` and `--config` together, so the entry is named.
  assert.equal(args.includes('.'), false);
  assert.equal(args.includes(PKG_ENTRY_SCRIPT), true);
  assert.deepEqual(args.slice(args.indexOf('--config'), args.indexOf('--config') + 2), ['--config', configPath]);

  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(written.assets, resolveNodePtyAssetGlobs('linux', 'x64'));
  assert.equal(written.assets.some((glob) => glob.includes('win32')), false);
});

test('OPS-BGSTAB-017 the per-target pkg config is written at the project root', () => {
  // This is the invariant that broke. pkg resolves a --config file's globs
  // against that file's own directory, so writing it anywhere but ROOT makes
  // `server/dist-pkg/*.cjs` resolve somewhere that does not exist. pkg then
  // exits 0 and writes an executable with no application in it: measured
  // 2026-09-21 with the config under dist/, the binary held 0 `node-pty`
  // strings and 0 `Provenance` strings, and every check that existed passed.
  const configPath = resolvePkgConfigPath('node22-linux-x64', '/srv/project');

  assert.equal(path.dirname(configPath), path.resolve('/srv/project'));
  assert.equal(path.basename(configPath), '.pkg-config-node22-linux-x64.json');

  // Two targets must not share a file: `--all-supported` builds them in turn
  // and each one deletes its own config when it finishes.
  assert.notEqual(
    resolvePkgConfigPath('node22-win-x64', '/srv/project'),
    resolvePkgConfigPath('node22-linux-x64', '/srv/project'),
  );
});

test('OPS-BGSTAB-017 the per-target config exists while pkg runs and is gone after', () => {
  const outputDir = createBuildOutputFixture({ platform: 'linux' });
  const configPath = resolvePkgConfigPath('node22-linux-x64');
  let presentDuringBuild = null;
  let contentsDuringBuild = null;

  buildExe(outputDir, 'node22-linux-x64', {
    platform: 'linux',
    runCommand: () => {
      presentDuringBuild = fs.existsSync(configPath);
      contentsDuringBuild = presentDuringBuild ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
      return { status: 0 };
    },
    log: () => {},
  });

  // pkg reads the file while it runs, so it has to be there then...
  assert.equal(presentDuringBuild, true);
  assert.deepEqual(contentsDuringBuild.assets, resolveNodePtyAssetGlobs('linux', 'x64'));
  // ...and it is a build artifact at the project root, so it must not survive.
  assert.equal(fs.existsSync(configPath), false);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ALL_ARM64_TARGETS,
  ALL_SUPPORTED_TARGETS,
  DAEMON_RUNTIME_FILES,
  ICON_ICNS_NAME,
  ICON_ICO_NAME,
  ICON_SVG_NAME,
  MAC_APP_BUNDLE_NAME,
  MAC_APP_EXECUTABLE_NAME,
  OUTPUT_DEFAULT,
  PACKAGE_VERSION,
  REQUIRED_AMD64_TARGETS,
  TARGET_PROFILES,
  archFromPkgTarget,
  applyExecutableIcons,
  assertSafeOutputRoot,
  assertSupportedPkgTarget,
  createMacAppBundle,
  copyRuntimeConfigFile,
  getExecutableNames,
  getNodeRuntimeCandidates,
  installRuntimeDependencies,
  parseArgs,
  platformFromPkgTarget,
  resolveBuildTargets,
  validateBuildOutput,
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
    'node tools/start-runtime.js',
    'node tools/start-runtime.js --foreground',
    'node tools/start-runtime.js --forground',
    'BuilderGateStop.exe',
    'buildergate-stop',
    'node stop.js',
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
  const { appExeName, stopExeName, nodeExeName } = getExecutableNames(platform);
  touch(path.join(outputDir, appExeName));
  touch(path.join(outputDir, stopExeName));
  touch(path.join(outputDir, 'server', 'dist', 'index.js'));
  touch(path.join(outputDir, 'server', 'dist', 'public', 'index.html'), '<!doctype html><html></html>\n');
  touch(path.join(outputDir, 'server', 'node_modules', '.bin', nodeExeName));
  touch(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe'));
  touch(path.join(outputDir, 'server', 'node_modules', '.bin', 'node'));
  for (const fileName of DAEMON_RUNTIME_FILES) {
    touch(path.join(outputDir, 'tools', 'daemon', fileName));
  }
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
  assert.equal(path.basename(options.outputDir), 'bin');
  assert.equal(path.basename(path.dirname(options.outputDir)), 'dist');
  assert.doesNotMatch(options.outputDir, /dist[\\/]daemon$/);
});

test('multi-target output root cleanup refuses the dist root', () => {
  assert.doesNotThrow(() => assertSafeOutputRoot(OUTPUT_DEFAULT));
  assert.throws(
    () => assertSafeOutputRoot(path.join(__dirname, '..', '..', 'dist')),
    /Refusing to clean dist\/ root/i,
  );
});

test('build target parser accepts cross-platform ARM64 pkg targets', () => {
  assert.equal(platformFromPkgTarget('node18-win-x64'), 'win32');
  assert.equal(platformFromPkgTarget('node18-linux-x64'), 'linux');
  assert.equal(platformFromPkgTarget('node18-macos-arm64'), 'darwin');
  assert.equal(archFromPkgTarget('node18-win-x64'), 'x64');
  assert.equal(archFromPkgTarget('node18-linux-arm64'), 'arm64');
  assert.deepEqual(assertSupportedPkgTarget('node18-win-arm64'), {
    platform: 'win32',
    arch: 'arm64',
  });

  assert.throws(
    () => assertSupportedPkgTarget('node18-plan9-arm64'),
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
    'node18-win-x64',
    'node18-linux-x64',
    'node18-win-arm64',
    'node18-linux-arm64',
    'node18-macos-arm64',
  ]);
  assert.equal(allTargets[0].outputDir, path.join(OUTPUT_DEFAULT, `win-amd64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[1].outputDir, path.join(OUTPUT_DEFAULT, `linux-amd64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[2].outputDir, path.join(OUTPUT_DEFAULT, `win-arm64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[3].outputDir, path.join(OUTPUT_DEFAULT, `linux-arm64-${PACKAGE_VERSION}`));
  assert.equal(allTargets[4].outputDir, path.join(OUTPUT_DEFAULT, `macos-arm64-${PACKAGE_VERSION}`));

  const requiredOptions = parseArgs(['--required-amd64']);
  const requiredTargets = resolveBuildTargets(requiredOptions);
  assert.deepEqual(requiredTargets.map((target) => target.profileName), ['win-amd64', 'linux-amd64']);
  assert.deepEqual(requiredTargets.map((target) => target.pkgTarget), ['node18-win-x64', 'node18-linux-x64']);

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
  assert.match(target.pkgTarget, /^node18-/);
});

test('root npm build scripts expose all supported daemon targets', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts.build, 'npm run build:daemon-all');
  assert.equal(packageJson.scripts['build:daemon-all'], 'node tools/build-daemon-exe.js --all-supported');
  assert.equal(packageJson.scripts['build:windows-amd64'], 'node tools/build-daemon-exe.js --profile win-amd64');
  assert.equal(packageJson.scripts['build:linux-amd64'], 'node tools/build-daemon-exe.js --profile linux-amd64');
  assert.equal(packageJson.scripts['build:windows-arm64'], 'node tools/build-daemon-exe.js --profile win-arm64');
  assert.equal(packageJson.scripts['build:linux-arm64'], 'node tools/build-daemon-exe.js --profile linux-arm64');
  assert.equal(packageJson.scripts['build:macos-arm64'], 'node tools/build-daemon-exe.js --profile macos-arm64');
  assert.equal(packageJson.scripts['build:daemon-win-arm64'], 'npm run build:windows-arm64');
  assert.equal(packageJson.scripts['build:daemon-linux-arm64'], 'npm run build:linux-arm64');
  assert.equal(packageJson.scripts['build:daemon-mac-arm64'], 'npm run build:macos-arm64');
  assert.equal(packageJson.scripts['build:daemon-macos-arm64'], 'npm run build:macos-arm64');
});

test('installRuntimeDependencies installs production dependencies only and keeps bundled Node', () => {
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

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['install', '--omit=dev', '--os', 'win32', '--cpu', 'arm64']);
  assert.equal(calls[0].env.npm_config_os, 'win32');
  assert.equal(calls[0].env.npm_config_cpu, 'arm64');
  assert.doesNotMatch(JSON.stringify(calls), /pm2/i);
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe')), true);
});

test('installRuntimeDependencies maps amd64 build profiles to npm x64 CPU', () => {
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

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['install', '--omit=dev', '--os', 'win32', '--cpu', 'x64']);
  assert.equal(calls[0].env.npm_config_os, 'win32');
  assert.equal(calls[0].env.npm_config_cpu, 'x64');
});

test('installRuntimeDependencies skip path still keeps bundled Node for packaged validation', () => {
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
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe')), true);
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

test('applyExecutableIcons embeds Windows icon into both executables', () => {
  const outputDir = createBuildOutputFixture();
  const rceditPath = path.join(outputDir, 'rcedit-x64.exe');
  const calls = [];
  touch(rceditPath, 'rcedit');

  applyExecutableIcons(outputDir, 'win32', {
    rceditPath,
    runCommand: (command, args, options) => {
      calls.push({ command, args, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, rceditPath);
  assert.match(calls[0].args.join(' '), /BuilderGate\.exe .*--set-icon/i);
  assert.match(calls[1].args.join(' '), /BuilderGateStop\.exe .*--set-icon/i);
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
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'runtime', 'buildergate-stop')), true);
  assert.equal(fs.existsSync(path.join(appDir, 'Contents', 'Resources', 'runtime', 'server', 'dist', 'index.js')), true);
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

test('validateBuildOutput accepts complete dist/bin runtime without PM2', () => {
  const outputDir = createBuildOutputFixture();

  assert.doesNotThrow(() => validateBuildOutput(outputDir, { platform: 'win32' }));
});

test('validateBuildOutput accepts Linux runtime without ICO or ICNS artifacts', () => {
  const outputDir = createBuildOutputFixture({ platform: 'linux' });

  assert.equal(fs.existsSync(path.join(outputDir, ICON_ICO_NAME)), false);
  assert.equal(fs.existsSync(path.join(outputDir, ICON_ICNS_NAME)), false);
  assert.doesNotThrow(() => validateBuildOutput(outputDir, { platform: 'linux' }));
});

test('validateBuildOutput fails when server entry is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, 'server', 'dist', 'index.js'), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /server[\\/]dist[\\/]index\.js/,
  );
});

test('validateBuildOutput fails when frontend public index is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, 'server', 'dist', 'public', 'index.html'), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /server[\\/]dist[\\/]public[\\/]index\.html/,
  );
});

test('validateBuildOutput fails when a packaged daemon runtime dependency is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, 'tools', 'daemon', 'process-info.js'), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /tools[\\/]daemon[\\/]process-info\.js/,
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

test('validateBuildOutput fails when macOS app frontend runtime is missing', () => {
  const outputDir = createBuildOutputFixture({ platform: 'darwin' });
  createMacAppBundle(outputDir, {
    platform: 'darwin',
    log: () => {},
  });
  fs.rmSync(
    path.join(outputDir, MAC_APP_BUNDLE_NAME, 'Contents', 'Resources', 'runtime', 'server', 'dist', 'public', 'index.html'),
    { force: true },
  );

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /macOS app frontend runtime/,
  );
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`validateBuildOutput rejects PM2 runtime dependency in ${platform} output`, () => {
    const outputDir = createBuildOutputFixture({ platform });
    if (platform === 'darwin') {
      createMacAppBundle(outputDir, {
        platform: 'darwin',
        log: () => {},
      });
    }
    touch(path.join(outputDir, 'server', 'node_modules', 'pm2', 'package.json'), '{"name":"pm2"}\n');

    assert.throws(
      () => validateBuildOutput(outputDir, { platform }),
      /PM2 runtime dependency must not exist/i,
    );
  });
}

test('validateBuildOutput rejects PM2 runtime dependency inside macOS app bundle', () => {
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
      'node_modules',
      'pm2',
      'package.json',
    ),
    '{"name":"pm2"}\n',
  );

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'darwin' }),
    /PM2 runtime dependency must not exist/i,
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
  touch(path.join(root, 'tools', 'start-runtime.js'), "daemonLauncher.runSentinelLoop(); '--internal-sentinel';\n");
  touch(path.join(root, 'tools', 'daemon', 'sentinel.js'), 'function runSentinelLoop() {}\n');
  touch(path.join(root, 'tools', 'daemon', 'sentinel-entry.js'), "require('./sentinel').runSentinelLoop();\n");
  touch(path.join(root, 'tools', 'daemon', 'launcher.js'), "args: ['--internal-sentinel'];\n");

  assert.doesNotThrow(() => validateSourceDaemonInputs(root));

  fs.rmSync(path.join(root, 'tools', 'daemon', 'sentinel.js'), { force: true });
  assert.throws(
    () => validateSourceDaemonInputs(root),
    /tools[\\/]daemon[\\/]sentinel\.js/,
  );
});

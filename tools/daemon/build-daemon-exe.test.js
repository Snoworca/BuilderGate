const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DAEMON_RUNTIME_FILES,
  OUTPUT_DEFAULT,
  archFromPkgTarget,
  assertHostTarget,
  copyRuntimeConfigFile,
  installRuntimeDependencies,
  parseArgs,
  platformFromPkgTarget,
  validateBuildOutput,
  validateSourceDaemonInputs,
} = require('../build-daemon-exe');

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
  touch(path.join(outputDir, 'BuilderGate.exe'));
  touch(path.join(outputDir, 'BuilderGateStop.exe'));
  touch(path.join(outputDir, 'server', 'dist', 'index.js'));
  touch(path.join(outputDir, 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const fileName of DAEMON_RUNTIME_FILES) {
    touch(path.join(outputDir, 'tools', 'daemon', fileName));
  }
  touch(path.join(outputDir, 'config.json5'));
  touch(path.join(outputDir, 'config.json5.example'));
  touch(path.join(outputDir, 'README.md'), options.readmeContent ?? createPolicyCompliantReadme());
  return outputDir;
}

test('build output default is dist/bin, not dist/daemon', () => {
  const options = parseArgs([]);

  assert.equal(options.outputDir, OUTPUT_DEFAULT);
  assert.equal(path.basename(options.outputDir), 'bin');
  assert.equal(path.basename(path.dirname(options.outputDir)), 'dist');
  assert.doesNotMatch(options.outputDir, /dist[\\/]daemon$/);
});

test('build target must match host platform and architecture because bundled Node is host-specific', () => {
  assert.equal(platformFromPkgTarget('node18-win-x64'), 'win32');
  assert.equal(platformFromPkgTarget('node18-linux-x64'), 'linux');
  assert.equal(platformFromPkgTarget('node18-macos-arm64'), 'darwin');
  assert.equal(archFromPkgTarget('node18-win-x64'), 'x64');
  assert.equal(archFromPkgTarget('node18-linux-arm64'), 'arm64');
  assert.equal(assertHostTarget('node18-win-x64', 'win32', 'x64'), 'win32');

  assert.throws(
    () => assertHostTarget('node18-linux-x64', 'win32', 'x64'),
    /Cross-platform or cross-architecture pkg targets are not supported/i,
  );
  assert.throws(
    () => assertHostTarget('node18-win-arm64', 'win32', 'x64'),
    /Cross-platform or cross-architecture pkg targets are not supported/i,
  );
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
    runCommand: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, label: options.label });
      return { status: 0 };
    },
    log: () => {},
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['install', '--omit=dev']);
  assert.doesNotMatch(JSON.stringify(calls), /pm2/i);
  assert.equal(fs.existsSync(path.join(outputDir, 'server', 'node_modules', '.bin', 'node.exe')), true);
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

test('validateBuildOutput fails when server entry is missing', () => {
  const outputDir = createBuildOutputFixture();
  fs.rmSync(path.join(outputDir, 'server', 'dist', 'index.js'), { force: true });

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
    /server[\\/]dist[\\/]index\.js/,
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

test('validateBuildOutput rejects PM2 runtime dependency in output', () => {
  const outputDir = createBuildOutputFixture();
  touch(path.join(outputDir, 'server', 'node_modules', 'pm2', 'package.json'), '{"name":"pm2"}\n');

  assert.throws(
    () => validateBuildOutput(outputDir, { platform: 'win32' }),
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

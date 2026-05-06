const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  POSIX_LAUNCHER,
  WINDOWS_LAUNCHER_CMD,
  WINDOWS_LAUNCHER_PS1,
  createPosixLauncher,
  createWindowsCmdLauncher,
  createWindowsPowerShellLauncher,
  validatePortableBuildOutput,
  writePortableLaunchers,
} = require('../build-portable-runtime');
const { ICON_ICNS_NAME, ICON_ICO_NAME, ICON_SVG_NAME } = require('./icon-assets');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createPortableOutputFixture(platform = 'win32') {
  const outputDir = makeTempDir('buildergate-portable-output-');
  touch(path.join(outputDir, 'web', 'index.html'), '<!doctype html>\n');
  touch(path.join(outputDir, 'shell-integration', 'bash-osc133.sh'), '# integration\n');
  touch(path.join(outputDir, 'config.json5'), 'auth: { password: "", jwtSecret: "" }\n');
  touch(path.join(outputDir, 'config.json5.example'), 'auth: { password: "", jwtSecret: "" }\n');
  touch(path.join(outputDir, 'README.md'), 'BuilderGate portable runtime\n');
  touch(path.join(outputDir, ICON_SVG_NAME), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
  touch(path.join(outputDir, 'tools', 'start-runtime.js'), '// runtime\n');
  touch(path.join(outputDir, 'tools', 'daemon', 'launcher.js'), '// launcher\n');
  touch(path.join(outputDir, 'server', 'package.json'), '{"type":"module"}\n');
  touch(path.join(outputDir, 'server', 'package-lock.json'), '{}\n');
  touch(path.join(outputDir, 'server', 'dist', 'index.js'), 'export {};\n');
  touch(path.join(outputDir, 'server', 'dist', 'utils', 'configStrictLoader.js'), 'export {};\n');
  touch(path.join(outputDir, 'server', 'dist', 'services', 'daemonTotpPreflight.js'), 'export {};\n');
  touch(path.join(outputDir, 'server', 'node_modules', 'node-pty', 'package.json'), '{}\n');
  touch(path.join(outputDir, 'server', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js'), 'module.exports = {};\n');

  if (platform === 'win32') {
    touch(path.join(outputDir, WINDOWS_LAUNCHER_CMD), '@echo off\n');
    touch(path.join(outputDir, WINDOWS_LAUNCHER_PS1), '$root = ""\n');
    touch(path.join(outputDir, 'node', 'node.exe'), 'node');
    touch(path.join(outputDir, ICON_ICO_NAME), 'ico');
  } else {
    touch(path.join(outputDir, POSIX_LAUNCHER), '#!/usr/bin/env sh\n');
    touch(path.join(outputDir, 'node', 'bin', 'node'), 'node');
  }

  if (platform === 'darwin') {
    touch(path.join(outputDir, ICON_ICNS_NAME), 'icns');
  }

  return outputDir;
}

test('portable launchers set runtime root, config, web, and shell integration envs', () => {
  const cmd = createWindowsCmdLauncher();
  assert.match(cmd, /BUILDERGATE_ROOT=%ROOT%/);
  assert.match(cmd, /BUILDERGATE_CONFIG_PATH=%ROOT%\\config\.json5/);
  assert.match(cmd, /BUILDERGATE_WEB_ROOT=%ROOT%\\web/);
  assert.match(cmd, /node\\node\.exe/);
  assert.match(cmd, /tools\\start-runtime\.js/);

  const ps1 = createWindowsPowerShellLauncher();
  assert.match(ps1, /BUILDERGATE_CONFIG_PATH/);
  assert.match(ps1, /node\\node\.exe/);

  const sh = createPosixLauncher();
  assert.match(sh, /BUILDERGATE_ROOT="\$ROOT"/);
  assert.match(sh, /node\/bin\/node/);
  assert.match(sh, /tools\/start-runtime\.js/);
});

test('writePortableLaunchers creates platform launcher entrypoints', () => {
  const winDir = makeTempDir('buildergate-portable-win-launchers-');
  writePortableLaunchers(winDir, 'win32');
  assert.equal(fs.existsSync(path.join(winDir, WINDOWS_LAUNCHER_CMD)), true);
  assert.equal(fs.existsSync(path.join(winDir, WINDOWS_LAUNCHER_PS1)), true);

  const linuxDir = makeTempDir('buildergate-portable-linux-launchers-');
  writePortableLaunchers(linuxDir, 'linux');
  const launcherPath = path.join(linuxDir, POSIX_LAUNCHER);
  assert.equal(fs.existsSync(launcherPath), true);
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(launcherPath).mode & 0o111) !== 0, true);
  }
  assert.match(fs.readFileSync(launcherPath, 'utf8'), /node\/bin\/node/);
});

test('validatePortableBuildOutput accepts portable Windows runtime layout', () => {
  const outputDir = createPortableOutputFixture('win32');
  assert.doesNotThrow(() => validatePortableBuildOutput(outputDir, { platform: 'win32' }));
});

test('validatePortableBuildOutput rejects exposed server config in portable runtime', () => {
  const outputDir = createPortableOutputFixture('linux');
  touch(path.join(outputDir, 'server', 'config.json5'), 'auth: { password: "secret" }\n');

  assert.throws(
    () => validatePortableBuildOutput(outputDir, { platform: 'linux' }),
    /server\/config\.json5 must not be exposed/i,
  );
});

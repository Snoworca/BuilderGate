const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { INSTALL_MARKER_FILE_NAME } = require('./runtime-paths');
const {
  MSI_UPGRADE_CODE,
  msiArchForProfile,
  msiProductVersion,
  renderWixSource,
  stageMsiPayload,
} = require('../build-msi');

// OPS-BGSTAB-020 AC-4 — the MSI installs per machine to Program Files, major-upgrades, and leaves
// LocalAppData alone. The installed executable finds the marker the MSI puts beside it.

function makeRuntimeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-msi-runtime-'));
  for (const name of ['BuilderGate.exe', 'BuilderGate.ico', 'README.md', 'config.json5', 'config.json5.example']) {
    fs.writeFileSync(path.join(dir, name), name);
  }
  fs.mkdirSync(path.join(dir, 'web', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<html>');
  fs.writeFileSync(path.join(dir, 'web', 'assets', 'app.js'), '');
  fs.mkdirSync(path.join(dir, 'shell-integration'));
  fs.writeFileSync(path.join(dir, 'shell-integration', 'bash.sh'), '');
  return dir;
}

test('OPS-BGSTAB-020 AC-4: the staged payload carries the install marker and no config', () => {
  const runtimeDir = makeRuntimeDir();
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-msi-stage-'));
  try {
    stageMsiPayload(runtimeDir, stageDir);

    assert.equal(fs.existsSync(path.join(stageDir, INSTALL_MARKER_FILE_NAME)), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'config.json5')), false, 'config lives in LocalAppData');
    assert.equal(fs.existsSync(path.join(stageDir, 'BuilderGate.exe')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'web', 'assets', 'app.js')), true);
    assert.equal(fs.existsSync(path.join(stageDir, 'shell-integration', 'bash.sh')), true);
    // The portable directory is also zipped for release; it must not gain the marker.
    assert.equal(fs.existsSync(path.join(runtimeDir, INSTALL_MARKER_FILE_NAME)), false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test('OPS-BGSTAB-020 AC-4: the WiX source installs per machine to Program Files with a major upgrade', () => {
  const wxs = renderWixSource({ version: '0.10.4', stageDir: 'C:\\stage', arch: 'x64' });

  assert.match(wxs, /Scope="perMachine"/);
  assert.match(wxs, /Version="0\.10\.4"/);
  assert.match(wxs, new RegExp(`UpgradeCode="${MSI_UPGRADE_CODE}"`));
  assert.match(wxs, /<MajorUpgrade [^>]*DowngradeErrorMessage=/);
  assert.match(wxs, /<StandardDirectory Id="ProgramFiles64Folder">\s*<Directory Id="INSTALLFOLDER" Name="BuilderGate"/);
  assert.match(wxs, /<Files Include="C:\\stage\\\*\*" \/>/);
  assert.match(wxs, /<Shortcut [^>]*Target="\[INSTALLFOLDER\]BuilderGate\.exe"/);
  // Nothing in the package touches LocalAppData, so upgrade and uninstall leave user data alone.
  assert.doesNotMatch(wxs, /LocalAppData|RemoveFolderEx|util:RemoveFolderEx/i);
});

test('OPS-BGSTAB-020 AC-4: a running daemon is stopped before upgrade or uninstall replaces the exe', () => {
  const wxs = renderWixSource({ version: '0.10.4', stageDir: 'C:\\stage', arch: 'x64' });

  assert.match(wxs, /<CustomAction Id="StopRunningDaemon" [^>]*ExeCommand="&quot;\[INSTALLFOLDER\]BuilderGate\.exe&quot; stop"[^>]*Return="ignore"/);
  assert.match(wxs, /<Custom Action="StopRunningDaemon" Before="InstallValidate" Condition="WIX_UPGRADE_DETECTED OR REMOVE=&quot;ALL&quot;"/);
});

test('OPS-BGSTAB-020 AC-4: the upgrade code is fixed and the arch follows the profile', () => {
  assert.match(MSI_UPGRADE_CODE, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(msiArchForProfile('win-amd64'), 'x64');
  assert.equal(msiArchForProfile('win-arm64'), 'arm64');
  assert.throws(() => msiArchForProfile('linux-amd64'), /Windows/);
});

test('OPS-BGSTAB-020 AC-4: the MSI product version is the numeric core of the package version', () => {
  assert.equal(msiProductVersion('0.10.4'), '0.10.4');
  assert.equal(msiProductVersion('0.11.0-beta.2'), '0.11.0');
  assert.equal(msiProductVersion('1.2.3+build.7'), '1.2.3');
  assert.throws(() => msiProductVersion('next'), /version/);
});

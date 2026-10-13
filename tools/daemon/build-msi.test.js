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

test('FR-BGSTAB-032 AC-4: the Start Menu shortcut starts BuilderGate with --open', () => {
  const wxs = renderWixSource({ version: '0.10.4', stageDir: 'C:\\stage', arch: 'x64' });
  assert.match(wxs, /<Shortcut Id="StartShortcut" [^>]*Arguments="--open"/);
});

// OPS-BGSTAB-021. The graceful stop above runs only on an upgrade and ignores its result, and an
// instance the MSI did not install (portable, source checkout) was never stopped. The installer
// now also runs msi-stop-port-owner.ps1 on every install and upgrade, before InstallValidate.
function decodedStopScript(wxs, propertyId) {
  const property = new RegExp(`<SetProperty Id="${propertyId}" [^>]*Value="([^"]*)"`).exec(wxs);
  assert.ok(property, `${propertyId} must carry the stop command`);
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(property[1]);
  assert.ok(encoded, 'the command must carry the script as -EncodedCommand');
  return { command: property[1], script: Buffer.from(encoded[1], 'base64').toString('utf16le') };
}

for (const [arch, binary, entry, propertyId, system] of [
  ['x64', 'Wix4UtilCA_X64', 'WixQuietExec64', 'WixQuietExec64CmdLine', 'System64Folder'],
  ['arm64', 'Wix4UtilCA_A64', 'WixQuietExec64', 'WixQuietExec64CmdLine', 'System64Folder'],
  ['x86', 'Wix4UtilCA_X86', 'WixQuietExec', 'WixQuietExecCmdLine', 'SystemFolder'],
]) {
  test(`OPS-BGSTAB-021 AC-2 AC-5: ${arch} stops a BuilderGate on 2002/2001 before InstallValidate and fails if it cannot`, () => {
    const wxs = renderWixSource({ version: '0.10.13', stageDir: 'C:\\stage', arch });
    const { command, script } = decodedStopScript(wxs, propertyId);

    assert.match(command, new RegExp(`^&quot;\\[${system}\\]WindowsPowerShell\\\\v1\\.0\\\\powershell\\.exe&quot; -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand `));
    const source = fs.readFileSync(path.join(__dirname, 'msi-stop-port-owner.ps1'), 'utf8');
    assert.ok(script.includes(source.trim()), 'the encoded command must run the reviewed script unchanged');
    assert.match(script, /-Ports 2002,2001 -TimeoutSeconds 20\s*$/);

    assert.match(wxs, new RegExp(`<CustomAction Id="StopPortOwner" BinaryRef="${binary}" DllEntry="${entry}" Execute="immediate" Return="check" />`));
    assert.match(wxs, /<Custom Action="StopPortOwner" After="StopRunningDaemon" Condition="NOT REMOVE=&quot;ALL&quot;" \/>/);
    assert.match(wxs, new RegExp(`<SetProperty Id="${propertyId}" [^>]*Before="StopPortOwner" Sequence="execute"`));
    assert.match(wxs, /<Custom Action="StopRunningDaemon" Before="InstallValidate"/);
  });
}

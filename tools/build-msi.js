#!/usr/bin/env node
// OPS-BGSTAB-020 — build a per-machine Windows MSI from a packaged runtime directory.
//
// The MSI installs BuilderGate.exe, web/ and shell-integration/ to Program Files\BuilderGate and
// adds buildergate-install.json beside the exe. That marker makes the exe keep config.json5,
// data/, certs/ and runtime/ in %LOCALAPPDATA%\BuilderGate (tools/daemon/runtime-paths.js), so a
// major upgrade replaces the program and keeps the user's settings. The package never installs
// anything under LocalAppData, so neither upgrade nor uninstall removes user data.
//
// Usage: node tools/build-msi.js --profile win-amd64 [--runtime-dir <dir>] [--output <file.msi>]
// Requires the WiX Toolset v5 CLI (`dotnet tool install --global wix --version 5.0.2`).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { INSTALL_MARKER_FILE_NAME } = require('./daemon/runtime-paths');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;
// Fixed for the product's lifetime: Windows Installer matches it to find the version to upgrade.
const MSI_UPGRADE_CODE = '17056674-75A9-429F-9679-D8F559247BE2';
const EXECUTABLE_NAME = 'BuilderGate.exe';
const ICON_NAME = 'BuilderGate.ico';
// Config is created per user in LocalAppData on first run; shipping one in Program Files would
// only be a stale copy nobody reads.
const EXCLUDED_PAYLOAD_FILES = new Set(['config.json5']);

function msiArchForProfile(profile) {
  const arch = { 'win-amd64': 'x64', 'win-arm64': 'arm64' }[profile];
  if (!arch) {
    throw new Error(`MSI builds are Windows-only; unsupported profile: ${profile}`);
  }
  return arch;
}

// Windows Installer versions are numeric (major.minor.build); a pre-release suffix is dropped.
function msiProductVersion(version) {
  const core = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  if (!core) {
    throw new Error(`Cannot derive an MSI product version from: ${version}`);
  }
  return `${core[1]}.${core[2]}.${core[3]}`;
}

function stageMsiPayload(runtimeDir, stageDir) {
  fs.mkdirSync(stageDir, { recursive: true });
  for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
    if (EXCLUDED_PAYLOAD_FILES.has(entry.name) || entry.name === INSTALL_MARKER_FILE_NAME) continue;
    fs.cpSync(path.join(runtimeDir, entry.name), path.join(stageDir, entry.name), { recursive: true });
  }
  fs.writeFileSync(
    path.join(stageDir, INSTALL_MARKER_FILE_NAME),
    `${JSON.stringify({ layout: 'msi', dataRoot: '%LOCALAPPDATA%\\BuilderGate' }, null, 2)}\n`,
  );
}

function xmlAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderWixSource({ version, stageDir, arch }) {
  const stage = stageDir.replace(/[\\/]+$/, '');
  const programFiles = arch === 'x86' ? 'ProgramFilesFolder' : 'ProgramFiles64Folder';
  const stopCommand = xmlAttr(`"[INSTALLFOLDER]${EXECUTABLE_NAME}" stop`);
  const removeAll = xmlAttr('REMOVE="ALL"');
  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="BuilderGate" Manufacturer="Snoworca" Version="${xmlAttr(version)}" UpgradeCode="${MSI_UPGRADE_CODE}" Scope="perMachine" Language="1033" Compressed="yes">
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="A newer version of BuilderGate is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <Icon Id="BuilderGateIcon" SourceFile="${xmlAttr(`${stage}\\${ICON_NAME}`)}" />
    <Property Id="ARPPRODUCTICON" Value="BuilderGateIcon" />

    <StandardDirectory Id="${programFiles}">
      <Directory Id="INSTALLFOLDER" Name="BuilderGate" />
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ShortcutFolder" Name="BuilderGate" />
    </StandardDirectory>

    <ComponentGroup Id="AppFiles" Directory="INSTALLFOLDER">
      <Files Include="${xmlAttr(`${stage}\\**`)}" />
    </ComponentGroup>

    <Component Id="StartMenuShortcuts" Directory="ShortcutFolder">
      <Shortcut Id="StartShortcut" Name="BuilderGate" Description="Start BuilderGate and open it in the browser" Target="[INSTALLFOLDER]${EXECUTABLE_NAME}" Arguments="--open" WorkingDirectory="INSTALLFOLDER" Icon="BuilderGateIcon" />
      <Shortcut Id="StopShortcut" Name="Stop BuilderGate" Description="Stop BuilderGate" Target="[INSTALLFOLDER]${EXECUTABLE_NAME}" Arguments="stop" WorkingDirectory="INSTALLFOLDER" Icon="BuilderGateIcon" />
      <RemoveFolder Id="RemoveShortcutFolder" On="uninstall" />
      <RegistryValue Root="HKLM" Key="Software\\Snoworca\\BuilderGate" Name="StartMenuShortcuts" Type="integer" Value="1" KeyPath="yes" />
    </Component>

    <Feature Id="Main" Title="BuilderGate">
      <ComponentGroupRef Id="AppFiles" />
      <ComponentRef Id="StartMenuShortcuts" />
    </Feature>

    <!-- The old exe is still in place before InstallValidate; stop its daemon so the file can be replaced. -->
    <CustomAction Id="StopRunningDaemon" Directory="INSTALLFOLDER" ExeCommand="${stopCommand}" Execute="immediate" Return="ignore" />
    <InstallExecuteSequence>
      <Custom Action="StopRunningDaemon" Before="InstallValidate" Condition="WIX_UPGRADE_DETECTED OR ${removeAll}" />
    </InstallExecuteSequence>
  </Package>
</Wix>
`;
}

function resolveWixCommand(env = process.env) {
  if (env.WIX_EXE) return env.WIX_EXE;
  const dotnetTool = path.join(os.homedir(), '.dotnet', 'tools', 'wix.exe');
  return fs.existsSync(dotnetTool) ? dotnetTool : 'wix';
}

function parseArgs(argv) {
  const options = { profile: 'win-amd64', runtimeDir: null, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--profile') options.profile = next();
    else if (arg === '--runtime-dir') options.runtimeDir = path.resolve(next());
    else if (arg === '--output') options.output = path.resolve(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.runtimeDir ??= path.join(ROOT, 'dist', 'bin', `${options.profile}-${PACKAGE_VERSION}`);
  options.output ??= path.join(ROOT, 'dist', 'msi', `BuilderGate-${options.profile}-${PACKAGE_VERSION}.msi`);
  return options;
}

function buildMsi(options) {
  if (process.platform !== 'win32') {
    throw new Error('MSI builds run on Windows (WiX Toolset).');
  }
  const arch = msiArchForProfile(options.profile);
  if (!fs.existsSync(path.join(options.runtimeDir, EXECUTABLE_NAME))) {
    throw new Error(`No ${EXECUTABLE_NAME} in ${options.runtimeDir}; build the ${options.profile} exe first.`);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-msi-'));
  try {
    const stageDir = path.join(workDir, 'stage');
    stageMsiPayload(options.runtimeDir, stageDir);
    const wxsPath = path.join(workDir, 'BuilderGate.wxs');
    fs.writeFileSync(wxsPath, renderWixSource({ version: msiProductVersion(PACKAGE_VERSION), stageDir, arch }), 'utf8');
    fs.mkdirSync(path.dirname(options.output), { recursive: true });

    const result = spawnSync(resolveWixCommand(), ['build', wxsPath, '-arch', arch, '-pdbtype', 'none', '-o', options.output], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`wix build exited with ${result.status}`);
    console.log(`[msi] ${options.output}`);
    return options.output;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    buildMsi(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error('[msi] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  MSI_UPGRADE_CODE,
  buildMsi,
  msiArchForProfile,
  msiProductVersion,
  parseArgs,
  renderWixSource,
  stageMsiPayload,
};

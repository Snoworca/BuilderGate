const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_HEARTBEAT_STALE_MS = 15_000;
const START_TIME_FUTURE_TOLERANCE_MS = 5_000;

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function killProcess(pid, signal = 'SIGTERM') {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function isActiveDaemonState(state, processExists = isProcessRunning) {
  if (!state || state.mode !== 'daemon' || state.status !== 'running') {
    return false;
  }

  return processExists(state.appPid) && processExists(state.sentinelPid);
}

function normalizePathForCompare(value, platform = process.platform) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const normalized = path.resolve(value).replace(/\\/g, '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsEqual(a, b, platform = process.platform) {
  const left = normalizePathForCompare(a, platform);
  const right = normalizePathForCompare(b, platform);
  return left !== null && right !== null && left === right;
}

function commandLineContainsPath(commandLine, expectedPath, platform = process.platform) {
  if (!commandLine || !expectedPath) {
    return false;
  }

  const normalizedCommand = String(commandLine).replace(/\\/g, '/');
  const normalizedExpected = String(expectedPath).replace(/\\/g, '/');
  const haystack = platform === 'win32' ? normalizedCommand.toLowerCase() : normalizedCommand;
  const needle = platform === 'win32' ? normalizedExpected.toLowerCase() : normalizedExpected;
  return haystack.includes(needle);
}

function isPackagedSelfExecutableState(state, platform = process.platform) {
  return pathsEqual(state.nodeBinPath, state.launcherPath, platform);
}

function parseDateMs(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isHeartbeatFresh(heartbeatAt, now = new Date(), maxHeartbeatAgeMs = DEFAULT_HEARTBEAT_STALE_MS) {
  const heartbeatMs = parseDateMs(heartbeatAt);
  if (heartbeatMs === null) {
    return false;
  }

  return now.getTime() - heartbeatMs <= maxHeartbeatAgeMs;
}

function validateProcessStartedBeforeState(processStartTime, stateStartedAt) {
  const processStartMs = parseDateMs(processStartTime);
  const stateStartMs = parseDateMs(stateStartedAt);
  if (processStartMs === null || stateStartMs === null) {
    return true;
  }

  return processStartMs <= stateStartMs + START_TIME_FUTURE_TOLERANCE_MS;
}

function parseWindowsCreationDate(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const jsonDateMatch = value.match(/^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/);
  if (jsonDateMatch) {
    return new Date(Number(jsonDateMatch[1])).toISOString();
  }

  const cimMatch = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-])?(\d{3})?/);
  if (cimMatch) {
    const [, year, month, day, hour, minute, second, micros = '0', sign, offsetMinutes] = cimMatch;
    const utcMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(micros.slice(0, 3).padEnd(3, '0')),
    );
    if (sign && offsetMinutes) {
      const offsetMs = Number(offsetMinutes) * 60_000;
      return new Date(sign === '+' ? utcMs - offsetMs : utcMs + offsetMs).toISOString();
    }
    return new Date(utcMs).toISOString();
  }

  const parsed = parseDateMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function queryWindowsProcessInfo(pid, options = {}) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 2 }',
    '$creation = if ($p.CreationDate -is [datetime]) { $p.CreationDate.ToUniversalTime().ToString("o") } else { [string]$p.CreationDate }',
    '[pscustomobject]@{ProcessId=$p.ProcessId;ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine;CreationDate=$creation} | ConvertTo-Json -Compress',
  ].join('; ');
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const result = spawnSyncFn('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return { pid, running: false };
  }

  const parsed = JSON.parse(result.stdout);
  return {
    pid,
    running: true,
    executablePath: parsed.ExecutablePath ?? null,
    commandLine: parsed.CommandLine ?? null,
    cwd: null,
    startTime: parseWindowsCreationDate(parsed.CreationDate),
  };
}

function queryProcfsProcessInfo(pid) {
  const procDir = `/proc/${pid}`;
  if (!fs.existsSync(procDir)) {
    return { pid, running: false };
  }

  let executablePath = null;
  let commandLine = null;
  let cwd = null;

  try {
    executablePath = fs.readlinkSync(path.join(procDir, 'exe'));
  } catch {
    executablePath = null;
  }

  try {
    commandLine = fs.readFileSync(path.join(procDir, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    commandLine = null;
  }

  try {
    cwd = fs.readlinkSync(path.join(procDir, 'cwd'));
  } catch {
    cwd = null;
  }

  return {
    pid,
    running: true,
    executablePath,
    commandLine,
    cwd,
    startTime: null,
  };
}

function queryProcessInfo(pid, options = {}) {
  if (!isProcessRunning(pid)) {
    return { pid, running: false };
  }

  if ((options.platform ?? process.platform) === 'win32') {
    try {
      return queryWindowsProcessInfo(pid, options);
    } catch {
      return { pid, running: true, executablePath: null, commandLine: null, cwd: null, startTime: null };
    }
  }

  try {
    return queryProcfsProcessInfo(pid);
  } catch {
    return { pid, running: true, executablePath: null, commandLine: null, cwd: null, startTime: null };
  }
}

function fail(reason, info = null) {
  return { valid: false, reason, info };
}

function ok(info = null) {
  return { valid: true, reason: null, info };
}

async function getProcessInfo(pid, options = {}) {
  const provider = options.processInfoProvider ?? queryProcessInfo;
  return provider(pid, options);
}

function validateExecutable(info, expectedExecutablePath, platform = process.platform) {
  if (!info.executablePath) {
    return null;
  }

  if (pathsEqual(info.executablePath, expectedExecutablePath, platform)) {
    return null;
  }

  return `executable mismatch: expected ${expectedExecutablePath}, got ${info.executablePath}`;
}

function validateCwdIfAvailable(info, expectedCwd, platform = process.platform) {
  if (!info.cwd) {
    return null;
  }

  if (pathsEqual(info.cwd, expectedCwd, platform)) {
    return null;
  }

  return `cwd mismatch: expected ${expectedCwd}, got ${info.cwd}`;
}

function sentinelEntryPathFromState(state) {
  return path.join(path.dirname(state.serverCwd), 'tools', 'daemon', 'sentinel-entry.js');
}

async function validateDaemonAppProcess(state, options = {}) {
  if (
    !state
    || state.mode !== 'daemon'
    || (state.status !== 'running' && !(options.allowStoppingState && state.status === 'stopping'))
  ) {
    return fail('daemon state is not running or stopping');
  }

  const info = await getProcessInfo(state.appPid, options);
  if (!info?.running) {
    return fail(`app PID ${state.appPid} is not running`, info);
  }

  const platform = options.platform ?? process.platform;
  const executableError = validateExecutable(info, state.nodeBinPath, platform);
  if (executableError) {
    return fail(executableError, info);
  }

  const commandLine = String(info.commandLine ?? '');
  const hasInternalAppMarker = /\s--internal-app(?:\s|$)/.test(` ${commandLine} `);
  const hasPackagedSelfExecutable = isPackagedSelfExecutableState(state, platform)
    && commandLineContainsPath(commandLine, state.launcherPath, platform);
  if (!hasInternalAppMarker && !hasPackagedSelfExecutable && !commandLineContainsPath(commandLine, state.serverEntryPath, platform)) {
    return fail(`app command line does not include server entry: ${state.serverEntryPath}`, info);
  }

  const cwdError = validateCwdIfAvailable(info, state.serverCwd, platform);
  if (cwdError) {
    return fail(cwdError, info);
  }

  if (!options.skipHeartbeatFreshness && !isHeartbeatFresh(state.heartbeatAt, options.now ?? new Date(), options.maxHeartbeatAgeMs)) {
    return fail(`stale heartbeat: ${state.heartbeatAt}`, info);
  }

  if (!validateProcessStartedBeforeState(info.startTime, state.appProcessStartedAt)) {
    return fail('app process start time indicates PID reuse', info);
  }

  return ok(info);
}

async function validateDaemonSentinelProcess(state, options = {}) {
  if (
    !state
    || state.mode !== 'daemon'
    || (state.status !== 'running' && !(options.allowStoppingState && state.status === 'stopping'))
  ) {
    return fail('daemon state is not running or stopping');
  }

  const info = await getProcessInfo(state.sentinelPid, options);
  if (!info?.running) {
    return fail(`sentinel PID ${state.sentinelPid} is not running`, info);
  }

  const commandLine = String(info.commandLine ?? '');
  const platform = options.platform ?? process.platform;
  const expectedSentinelEntryPath = sentinelEntryPathFromState(state);
  const hasInternalSentinelMarker = /\s--internal-sentinel(?:\s|$)/.test(` ${commandLine} `);
  const hasPackagedSentinelEntry = commandLineContainsPath(commandLine, expectedSentinelEntryPath, platform);
  const hasPackagedSelfExecutable = isPackagedSelfExecutableState(state, platform)
    && commandLineContainsPath(commandLine, state.launcherPath, platform);
  if (!hasInternalSentinelMarker && !hasPackagedSentinelEntry && !hasPackagedSelfExecutable) {
    return fail('sentinel process is missing the internal sentinel marker', info);
  }

  if (
    info.executablePath
    && !pathsEqual(info.executablePath, state.launcherPath, platform)
    && !pathsEqual(info.executablePath, state.nodeBinPath, platform)
  ) {
    return fail(`sentinel executable mismatch: ${info.executablePath}`, info);
  }

  if (
    !commandLineContainsPath(commandLine, state.launcherPath, platform)
    && !hasPackagedSentinelEntry
  ) {
    return fail(`sentinel command line does not include launcher path or sentinel entry: ${state.launcherPath}`, info);
  }

  const expectedStatePath = options.expectedStatePath ?? statePathFromState(state);
  if (!hasPackagedSelfExecutable && expectedStatePath && !commandLineContainsPath(commandLine, expectedStatePath, platform)) {
    return fail('sentinel command line does not include daemon state path marker', info);
  }

  if (!hasPackagedSelfExecutable && !commandLine.includes(state.startAttemptId)) {
    return fail('sentinel command line does not include start attempt marker', info);
  }

  if (!validateProcessStartedBeforeState(info.startTime, state.appProcessStartedAt)) {
    return fail('sentinel process start time indicates PID reuse', info);
  }

  const expectedRoot = isPackagedSelfExecutableState(state, platform)
    ? state.serverCwd
    : path.dirname(state.serverCwd);
  const cwdError = validateCwdIfAvailable(info, expectedRoot, platform);
  if (cwdError) {
    return fail(cwdError, info);
  }

  return ok(info);
}

function statePathFromState(state) {
  return state.daemonStatePath ?? state.statePath ?? '';
}

module.exports = {
  isActiveDaemonState,
  isProcessRunning,
  killProcess,
  parseWindowsCreationDate,
  queryProcessInfo,
  validateDaemonAppProcess,
  validateDaemonSentinelProcess,
};

// @req 2026-07-27.pm.fair-readmission-closure-v3
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync as nodeSpawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const TASK = '2026-07-27.pm.fair-readmission-closure-v3';
const PLAYWRIGHT_OUTPUT_DIR = 'C:/Work/kiwi-run-output/2026-07-27.pm.fair-readmission-closure-v3/ac9-playwright';
const BROWSER_GREP = 'PERF-BGSTAB-010 AC-9 isolated browser evidence.*visible fair-delivery ACK preserves idle through the real HTTPS WebSocket';
const ANALYSIS_DIRECTORY = `docs/analysis/kiwi-coder-${TASK}`;

const SOURCE_ROOTS = [
  'server/src/ws/FairTerminalDeliveryScheduler.test.ts',
  'server/src/ws/WsRouterSendPriority.test.ts',
  'server/src/ws/wsSendPolicyRestoreMetadata.test.ts',
  'server/src/services/TerminalResourcePolicy.test.ts',
  'server/src/services/TerminalResourcePolicyCanary.test.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/services/SessionManager.ts',
  'server/src/ws/wsSendPolicy.ts',
  'server/src/services/TerminalResourcePolicy.ts',
  'server/src/benchmarks/terminalFairnessCharacterization.ts',
  'tools/wave3/fair-scheduler-decision.test.mjs',
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/types/ws-protocol.ts',
  'frontend/src/utils/terminalDebugCapture.ts',
  'frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts',
  'frontend/tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts',
  'frontend/tests/unit/terminalContainerRecoveryContract.test.ts',
  'frontend/tests/unit/terminalDebugCapture.test.ts',
  'frontend/tests/unit/webSocketBackpressure.test.ts',
];

const CONFIG_LOCK_PATHS = [
  'server/package.json',
  'server/package-lock.json',
  'server/config.json5',
  'server/tsconfig.json',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/pnpm-lock.yaml',
  'frontend/tsconfig.json',
  'frontend/tsconfig.app.json',
  'frontend/tsconfig.node.json',
  'frontend/vite.config.ts',
  'frontend/playwright.config.ts',
];

const FIXTURE_ROOT = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const FIXTURE_ENTRY = `${FIXTURE_ROOT}/fair-scheduler-decision.json`;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const REPARSE_BATCH_ENV_KEY = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_BATCH_PATHS_BASE64';
const REPARSE_PATH_ENV_KEY = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_PATH_BASE64';
const REPARSE_BATCH_MAX_COUNT = 64;
const REPARSE_BATCH_MAX_BYTES = 8 * 1024;
const REPARSE_PROBE_TIMEOUT_MS = 10_000;
const TRUSTED_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function normalizeLf(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

function normalizePath(value) {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.replace(/\/\.(?=\/|$)/g, '').replace(/\/$/, '');
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(normalizeLf(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  assertPlainObject(value, 'canonical JSON value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableRows(rows) {
  return [...rows].sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJson(left), 'utf8'),
    Buffer.from(canonicalJson(right), 'utf8'),
  ));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function commandFamily(id, cwd, posixArgv, environment) {
  return {
    id,
    cwd,
    ...(environment ? { environment } : {}),
    posixArgv,
    windowsArgv: [posixArgv[0] === 'npx' ? 'npx.cmd' : posixArgv[0], ...posixArgv.slice(1)],
  };
}

export const FROZEN_CONTRACT = deepFreeze({
  procedureVersion: 'closure-v3',
  serialization: 'UTF-8, LF, no BOM, recursively lexicographic object keys; row arrays stable-JSON sorted; command arrays preserve execution order',
  playwright: {
    outputDir: PLAYWRIGHT_OUTPUT_DIR,
    environment: { PLAYWRIGHT_BASE_URL: 'https://localhost:2222' },
    retries: 0,
    workers: 1,
  },
  commandFamilies: [
    commandFamily('browser-ac9-isolated', 'frontend', [
      'npx', '--no-install', 'playwright', 'test',
      'tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts', '--project', 'Desktop Chrome',
      '--retries=0', '--workers=1', '--output', PLAYWRIGHT_OUTPUT_DIR, '--grep', BROWSER_GREP,
    ], { PLAYWRIGHT_BASE_URL: 'https://localhost:2222' }),
    commandFamily('decision-validator', '.', [
      'node', 'tools/wave3/fair-scheduler-decision.test.mjs', '--verify-existing',
    ]),
    commandFamily('five-file-replay', 'server', [
      'npx', '--no-install', 'tsx', '--test',
      'src/ws/FairTerminalDeliveryScheduler.test.ts',
      'src/ws/WsRouterSendPriority.test.ts',
      'src/ws/wsSendPolicyRestoreMetadata.test.ts',
      'src/services/TerminalResourcePolicy.test.ts',
      'src/services/TerminalResourcePolicyCanary.test.ts',
    ]),
    commandFamily('frontend-unit', 'frontend', [
      'node', '--experimental-strip-types', '--test',
      'tests/unit/terminalContainerRecoveryContract.test.ts',
      'tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts',
      'tests/unit/webSocketBackpressure.test.ts',
      'tests/unit/terminalDebugCapture.test.ts',
    ]),
  ],
  sourceRoots: SOURCE_ROOTS,
  configLockPaths: CONFIG_LOCK_PATHS,
  fixtureEntry: FIXTURE_ENTRY,
});

function isWithinPath(candidate, parent) {
  const candidateKey = normalizePath(candidate).toLowerCase();
  const parentKey = normalizePath(parent).toLowerCase();
  return candidateKey === parentKey || candidateKey.startsWith(`${parentKey}/`);
}

function isAbsoluteWindowsPath(value) {
  return /^[a-zA-Z]:\//.test(normalizePath(value));
}

function assertExistingWindowsPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty path`);
  }
  const normalized = normalizePath(value);
  if (!isAbsoluteWindowsPath(normalized)) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return normalized;
}

const REPARSE_BATCH_PROGRAM = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  `  $inputBase64 = $env:${REPARSE_BATCH_ENV_KEY}`,
  '  if ([string]::IsNullOrWhiteSpace($inputBase64)) { exit 1 }',
  '  $inputJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($inputBase64))',
  '  Add-Type -AssemblyName System.Web.Extensions',
  '  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer',
  '  $paths = $serializer.DeserializeObject($inputJson)',
  '  if ($paths -isnot [System.Array]) { exit 1 }',
  '  foreach ($candidate in $paths) {',
  '    if (-not ($candidate -is [string])) { exit 1 }',
  '    $attributes = [System.IO.File]::GetAttributes([string]$candidate)',
  '    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }',
  '  }',
  '  $hash = [System.Security.Cryptography.SHA256]::Create()',
  '  try { $digest = -join ($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($inputJson)) | ForEach-Object { $_.ToString("x2") }) } finally { $hash.Dispose() }',
  '  [Console]::Out.Write(("FRRPB1:{0}:{1}`n" -f $paths.Count, $digest))',
  '} catch {',
  '  exit 1',
  '}',
].join('\n');
const REPARSE_BATCH_ARGV = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(REPARSE_BATCH_PROGRAM, 'utf16le').toString('base64'),
];

const REPARSE_PATH_PROGRAM = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  `  $candidate = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:${REPARSE_PATH_ENV_KEY}))`,
  '  $attributes = [System.IO.File]::GetAttributes($candidate)',
  '  [Console]::Out.Write((if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { "1`n" } else { "0`n" }))',
  '} catch {',
  '  exit 1',
  '}',
].join('\n');
const REPARSE_PATH_ARGV = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(REPARSE_PATH_PROGRAM, 'utf16le').toString('base64'),
];

function fixedReparseProbeOptions(environmentKey, environmentValue) {
  return {
    env: { [environmentKey]: environmentValue },
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: REPARSE_PROBE_TIMEOUT_MS,
    windowsHide: true,
  };
}

function trustedWindowsPath(value) {
  return nodePath.win32.normalize(value).replaceAll('/', '\\').toLowerCase();
}

function inspectTrustedPowerShellPath(fs, candidate, label) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    throw new Error(`cannot inspect trusted PowerShell ${label}: ${error?.message ?? String(error)}`);
  }
  if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
    throw new Error(`trusted PowerShell ${label} is a link or reparse point: ${candidate}`);
  }
  return stat;
}

export function resolveTrustedWindowsPowerShell({ fs = nodeFs, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('trusted PowerShell probe requires Windows');
  const parsed = nodePath.win32.parse(TRUSTED_WINDOWS_POWERSHELL);
  const segments = nodePath.win32.relative(parsed.root, TRUSTED_WINDOWS_POWERSHELL).split(nodePath.win32.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = nodePath.win32.join(current, segment);
    const stat = inspectTrustedPowerShellPath(fs, current, current === TRUSTED_WINDOWS_POWERSHELL ? 'binary' : 'ancestor');
    if (current === TRUSTED_WINDOWS_POWERSHELL && !stat?.isFile?.()) {
      throw new Error(`trusted PowerShell binary is not a regular file: ${TRUSTED_WINDOWS_POWERSHELL}`);
    }
  }
  let realpath;
  try {
    if (typeof fs.realpathSync?.native !== 'function') throw new Error('realpath.native is unavailable');
    realpath = fs.realpathSync.native(TRUSTED_WINDOWS_POWERSHELL);
  } catch (error) {
    throw new Error(`cannot inspect trusted PowerShell realpath: ${error?.message ?? String(error)}`);
  }
  if (trustedWindowsPath(realpath) !== trustedWindowsPath(TRUSTED_WINDOWS_POWERSHELL)) {
    throw new Error(`trusted PowerShell realpath differs from fixed binary: ${realpath}`);
  }
  return TRUSTED_WINDOWS_POWERSHELL;
}

function exactBatchPaths(paths) {
  if (!Array.isArray(paths)) throw new Error('reparse batch paths must be an array');
  const normalized = paths.map((candidate, index) => assertExistingWindowsPath(candidate, `reparse batch path ${index}`));
  if (normalized.length > REPARSE_BATCH_MAX_COUNT || Buffer.byteLength(JSON.stringify(normalized), 'utf8') > REPARSE_BATCH_MAX_BYTES) {
    throw new Error('reparse batch exceeds the fixed count or byte limit');
  }
  return normalized;
}

function assertExactBatchResult(result, expected) {
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
    throw new Error('PowerShell reparse batch probe failed closed: invalid child result');
  }
  if (result.stderr !== '') {
    throw new Error('PowerShell reparse batch probe failed closed: child wrote stderr');
  }
  if (result.stdout !== expected) {
    throw new Error('PowerShell reparse batch probe failed closed: invalid FRRPB1 success record');
  }
}

function runTrustedReparseProbe({ spawn, fs, platform, argv, environmentKey, environmentValue, label }) {
  const run = spawn ?? nodeSpawnSync;
  if (typeof run !== 'function') {
    throw new Error(`PowerShell reparse ${label} probe failed closed: spawnSync must be a function`);
  }
  const executable = resolveTrustedWindowsPowerShell({ fs, platform });
  try {
    return run(
      executable,
      argv,
      fixedReparseProbeOptions(environmentKey, environmentValue),
    );
  } catch (error) {
    throw new Error(`PowerShell reparse ${label} probe failed closed: ${error?.message ?? String(error)}`);
  }
}

export function probeWindowsReparsePoints({
  paths,
  spawnSync: spawn = undefined,
  fs = nodeFs,
  platform = process.platform,
} = {}) {
  const normalizedPaths = exactBatchPaths(paths);
  if (normalizedPaths.length === 0) return false;
  const inputJson = JSON.stringify(normalizedPaths);
  const expected = `FRRPB1:${normalizedPaths.length}:${sha256(inputJson)}\n`;
  const encodedPaths = Buffer.from(inputJson, 'utf8').toString('base64');
  const result = runTrustedReparseProbe({
    spawn,
    fs,
    platform,
    argv: REPARSE_BATCH_ARGV,
    environmentKey: REPARSE_BATCH_ENV_KEY,
    environmentValue: encodedPaths,
    label: 'batch',
  });
  assertExactBatchResult(result, expected);
  return false;
}

export function probeWindowsReparsePoint({
  path,
  spawnSync: spawn = undefined,
  fs = nodeFs,
  platform = process.platform,
} = {}) {
  const candidate = assertExistingWindowsPath(path, 'reparse probe path');
  const encodedPath = Buffer.from(path, 'utf8').toString('base64');
  const result = runTrustedReparseProbe({
    spawn,
    fs,
    platform,
    argv: REPARSE_PATH_ARGV,
    environmentKey: REPARSE_PATH_ENV_KEY,
    environmentValue: encodedPath,
    label: 'path',
  });
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.stderr !== '') {
    throw new Error(`PowerShell reparse probe failed closed for ${candidate}`);
  }
  const output = result.stdout;
  if (output === '0\n') return false;
  if (output === '1\n') return true;
  throw new Error(`PowerShell reparse probe failed closed for ${candidate}`);
}

function statIdentity(stat, label) {
  const fields = ['dev', 'ino', 'mode', 'ctimeMs', 'mtimeMs', 'size'];
  const identity = {};
  for (const field of fields) {
    if (!Object.hasOwn(stat ?? {}, field)) throw new Error(`cannot establish ${label} identity`);
    identity[field] = stat[field];
  }
  return identity;
}

function sameIdentity(left, right) {
  return left !== undefined && right !== undefined
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function lstatSafeSegment(fs, candidate, label) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    throw new Error(`cannot inspect ${label}: ${candidate} (${error?.message ?? String(error)})`);
  }
  if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
    throw new Error(`${label} is a reparse point or link: ${candidate}`);
  }
  return statIdentity(stat, label);
}

function splitReparseBatches(paths) {
  const batches = [];
  let batch = [];
  for (const candidate of paths) {
    const proposed = [...batch, candidate];
    if (batch.length > 0 && (
      proposed.length > REPARSE_BATCH_MAX_COUNT
      || Buffer.byteLength(JSON.stringify(proposed), 'utf8') > REPARSE_BATCH_MAX_BYTES
    )) {
      batches.push(batch);
      batch = [candidate];
      continue;
    }
    batch = proposed;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function windowsSegmentFrontier(paths) {
  const frontier = [];
  const seen = new Set();
  for (const candidate of paths) {
    const parsed = nodePath.win32.parse(candidate);
    const segments = nodePath.win32.relative(parsed.root, candidate).split(nodePath.win32.sep).filter(Boolean);
    let current = parsed.root;
    for (const segment of segments) {
      current = nodePath.win32.join(current, segment);
      const normalized = normalizePath(current);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      frontier.push(normalized);
    }
  }
  return frontier;
}

function lstatExistingSafeSegment(fs, candidate, label) {
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`cannot inspect ${label}: ${candidate} (${error?.message ?? String(error)})`);
  }
  if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
    throw new Error(`${label} is a reparse point or link: ${candidate}`);
  }
  return statIdentity(stat, label);
}

function collectExistingSegmentFrontier(fs, candidates) {
  return windowsSegmentFrontier(candidates).flatMap(candidate => {
    const identity = lstatExistingSafeSegment(fs, candidate, 'reparse guard path');
    return identity === undefined ? [] : [{ candidate, identity }];
  });
}

export function createSegmentReparseGuard({ fs = nodeFs, probe, probeBatch } = {}) {
  if (probe === undefined && probeBatch === undefined) {
    probeBatch = paths => probeWindowsReparsePoints({ paths });
  }
  if (!fs || typeof fs.lstatSync !== 'function') throw new Error('reparse guard requires lstatSync');
  if (probeBatch !== undefined && typeof probeBatch !== 'function') throw new Error('reparse guard probeBatch must be a function');
  if (probeBatch === undefined && typeof probe !== 'function') throw new Error('reparse guard probe must be a function');
  const cache = new Map();

  if (probeBatch === undefined) {
    const assertSafe = (candidate, { forceFresh = false } = {}) => {
      const normalized = assertExistingWindowsPath(candidate, 'reparse guard path');
      const identity = lstatSafeSegment(fs, normalized, 'reparse guard path');
      const cached = cache.get(normalized);
      if (!forceFresh && sameIdentity(cached, identity)) return;
      let unsafe;
      try {
        unsafe = probe(candidate);
      } catch (error) {
        cache.delete(normalized);
        throw error;
      }
      if (unsafe) {
        cache.delete(normalized);
        throw new Error(`reparse guard rejected unsafe path: ${normalized}`);
      }
      cache.set(normalized, identity);
    };
    return {
      assertSafe,
      assertSafeMany(paths, options) {
        if (!Array.isArray(paths)) throw new Error('reparse guard paths must be an array');
        for (const candidate of paths) assertSafe(candidate, options);
      },
    };
  }

  const assertSafeMany = (paths, { forceFresh = false } = {}) => {
    if (!Array.isArray(paths)) throw new Error('reparse guard paths must be an array');
    const candidates = paths.map(candidate => assertExistingWindowsPath(candidate, 'reparse guard path'));
    if (candidates.length === 0) return;
    const frontier = collectExistingSegmentFrontier(fs, candidates);
    if (frontier.length === 0) return;
    const probeCandidates = [];
    const queued = new Set();
    for (const { candidate, identity } of frontier) {
      if ((forceFresh || !sameIdentity(cache.get(candidate), identity)) && !queued.has(candidate)) {
        queued.add(candidate);
        probeCandidates.push(candidate);
      }
    }
    try {
      for (const batch of splitReparseBatches(probeCandidates)) probeBatch(batch);
      const post = collectExistingSegmentFrontier(fs, candidates);
      if (
        post.length !== frontier.length
        || post.some(({ candidate, identity }, index) => candidate !== frontier[index].candidate || !sameIdentity(frontier[index].identity, identity))
      ) {
        throw new Error('reparse guard identity changed during batch probe');
      }
      for (const { candidate, identity } of post) cache.set(candidate, identity);
    } catch (error) {
      for (const { candidate } of frontier) cache.delete(candidate);
      throw error;
    }
  };
  return {
    assertSafe(candidate, options) {
      assertSafeMany([candidate], options);
    },
    assertSafeMany,
  };
}

function checkedPathSegments(fs, absolutePath, label) {
  const resolved = nodePath.resolve(absolutePath);
  const parsed = nodePath.parse(resolved);
  const segments = nodePath.relative(parsed.root, resolved).split(nodePath.sep).filter(Boolean);
  let current = parsed.root;
  const checked = [];
  for (const segment of segments) {
    current = nodePath.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(normalizePath(current));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`cannot inspect ${label}: ${current}`);
    }
    if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
      throw new Error(`${label} is a reparse point or link: ${current}`);
    }
    checked.push(normalizePath(current));
  }
  return checked;
}

function assertPathHasNoLinkOrReparsePoint(fs, absolutePath, label, reparseGuard, { forceFresh = false } = {}) {
  const checked = checkedPathSegments(fs, absolutePath, label);
  if (reparseGuard && checked.length > 0) reparseGuard.assertSafeMany(checked, { forceFresh });
}

function assertExternalOutputPath({ workspaceRoot, outputDir, fs, reparseGuard }) {
  const normalizedOutput = normalizePath(outputDir);
  const normalizedWorkspace = normalizePath(workspaceRoot);
  if (normalizedOutput !== PLAYWRIGHT_OUTPUT_DIR || !isAbsoluteWindowsPath(normalizedOutput)) {
    throw new Error('Playwright output path must equal the frozen external output literal');
  }
  if (/placeholder|<[^>]+>|(?:^|\/)temp(?:\/|$)/i.test(normalizedOutput) || isWithinPath(normalizedOutput, normalizedWorkspace)) {
    throw new Error('Playwright output path must be external, non-Temp, and workspace-disjoint');
  }
  if (fs.existsSync(normalizedOutput)) {
    throw new Error('Playwright output leaf must be absent before launch');
  }
  assertPathHasNoLinkOrReparsePoint(fs, normalizedOutput, 'Playwright output ancestor or leaf', reparseGuard, { forceFresh: true });
}

export function validateFrozenContract({ workspaceRoot, contract = FROZEN_CONTRACT, fs = nodeFs, reparseGuard }) {
  if (!workspaceRoot || !isAbsoluteWindowsPath(workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute Windows path');
  }
  assertPlainObject(contract, 'frozen contract');
  assertPlainObject(contract.playwright, 'frozen contract playwright');
  assertExternalOutputPath({ workspaceRoot, outputDir: contract.playwright.outputDir, fs, reparseGuard });
  if (canonicalJson(contract) !== canonicalJson(FROZEN_CONTRACT)) {
    throw new Error('frozen contract does not match closure-v3 literals and argv');
  }
  return JSON.parse(canonicalJson(contract));
}

function assertHashRow(row, kind, label) {
  assertPlainObject(row, label);
  if (row.kind !== kind || typeof row.path !== 'string' || !row.path || !HASH_PATTERN.test(row.sha256 ?? '')) {
    throw new Error(`${label} is not a resolved ${kind} hash row`);
  }
  const normalized = normalizePath(row.path);
  if (normalized !== row.path || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`${label} has an unsafe repository-relative path`);
  }
}

export function validateConfigLockRows({ statusRows, indexRows }) {
  if (!Array.isArray(statusRows) || !Array.isArray(indexRows)) {
    throw new Error('config-lock rows must be arrays');
  }
  if (statusRows.length !== 1 || statusRows[0]?.xy !== '!!' || statusRows[0]?.path !== 'server/config.json5') {
    throw new Error('server/config.json5 must have exactly one literal !! status row');
  }
  if (indexRows.length !== 0) {
    throw new Error('server/config.json5 must have no index row');
  }
}

export function validateProtectedRows({
  sourceClosureRows = [],
  fixtureRows = [],
  configLockRows = [],
  externalSpecifierRows = [],
  gitDiagnostics = [],
}) {
  if (!Array.isArray(gitDiagnostics) || gitDiagnostics.length > 0) {
    throw new Error(`Git protected-input diagnostics are unresolved: ${(gitDiagnostics ?? []).join('; ')}`);
  }
  if (!Array.isArray(externalSpecifierRows)) throw new Error('external specifier rows must be an array');
  for (const row of externalSpecifierRows) {
    if (!row || row.unresolved || typeof row.from !== 'string' || typeof row.specifier !== 'string' || typeof row.resolvedOrBuiltin !== 'string') {
      throw new Error('unresolved protected external specifier');
    }
  }
  for (const row of sourceClosureRows) assertHashRow(row, 'source', 'source closure row');
  for (const row of fixtureRows) assertHashRow(row, 'fixture', 'fixture row');
  for (const row of configLockRows) assertHashRow(row, 'config_lock', 'config-lock row');
}

export function contractFingerprint(contract = FROZEN_CONTRACT) {
  assertPlainObject(contract, 'frozen contract');
  const contractCanonicalJson = canonicalJson(contract);
  return {
    canonicalJson: contractCanonicalJson,
    sha256: sha256(contractCanonicalJson),
  };
}

export function buildCanonicalManifest({
  contract = FROZEN_CONTRACT,
  phase,
  collector,
  nodeRuntime,
  selectedCommands,
  sourceClosureRows,
  fixtureRows,
  configLockRows,
  externalSpecifierRows,
  git,
}) {
  if (!phase || typeof phase !== 'string') throw new Error('capture phase is required');
  assertPlainObject(collector, 'collector');
  assertPlainObject(nodeRuntime, 'node runtime');
  validateProtectedRows({ sourceClosureRows, fixtureRows, configLockRows, externalSpecifierRows, gitDiagnostics: git?.diagnostics ?? [] });
  assertPlainObject(git, 'git');

  const value = {
    collector,
    commandFamilies: contract.commandFamilies,
    commands: selectedCommands,
    configLockRows: stableRows(configLockRows),
    externalSpecifierRows: stableRows(externalSpecifierRows),
    fixtureRows: stableRows(fixtureRows),
    git: {
      ...git,
      indexRows: stableRows(git.indexRows ?? []),
      statusRows: stableRows(git.statusRows ?? []),
    },
    nodeRuntime,
    procedureVersion: contract.procedureVersion,
    runtime: {
      playwrightBaseUrl: contract.playwright.environment.PLAYWRIGHT_BASE_URL,
      playwrightOutputDir: contract.playwright.outputDir,
      playwrightRetries: contract.playwright.retries,
      playwrightWorkers: contract.playwright.workers,
    },
    serialization: contract.serialization,
    sourceClosureRows: stableRows(sourceClosureRows),
  };
  const protectedInputCanonicalJson = canonicalJson(value);
  return {
    schemaVersion: 'fair-readmission-provenance/v3',
    phase,
    contract: contractFingerprint(contract),
    protectedInput: {
      canonicalJson: protectedInputCanonicalJson,
      sha256: sha256(protectedInputCanonicalJson),
      value,
    },
  };
}

function workspacePath(workspaceRoot, relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`unsafe workspace-relative path: ${relativePath}`);
  }
  return nodePath.resolve(workspaceRoot, ...normalized.split('/'));
}

function assertSafeFixtureComponents(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty fixture path`);
  }
  if (nodePath.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`unsafe fixture ${label}: absolute or volume-qualified path`);
  }
  const components = value.replaceAll('\\', '/').split('/');
  const reservedDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  for (const component of components) {
    if (!component || component === '.' || component === '..') {
      throw new Error(`unsafe fixture ${label} component`);
    }
    if (component.includes(':') || /[<>"|?*]/.test(component) || /[. ]$/.test(component) || reservedDevice.test(component)) {
      throw new Error(`unsafe fixture ${label} component: ${component}`);
    }
  }
  return components;
}

export function resolveFixturePath({ workspaceRoot, fixtureRoot = FIXTURE_ROOT, value } = {}) {
  const normalizedWorkspace = assertExistingWindowsPath(workspaceRoot, 'fixture workspace root');
  const rootComponents = assertSafeFixtureComponents(fixtureRoot, 'root');
  const valueComponents = assertSafeFixtureComponents(value, 'path');
  const evidenceRoot = nodePath.win32.resolve(normalizedWorkspace, ...rootComponents);
  if (!isWithinPath(evidenceRoot, normalizedWorkspace)) {
    throw new Error(`fixture root escapes workspace: ${fixtureRoot}`);
  }
  const resolved = nodePath.win32.resolve(evidenceRoot, ...valueComponents);
  if (!isWithinPath(resolved, evidenceRoot)) {
    throw new Error(`fixture path escapes evidence root: ${value}`);
  }
  return resolved;
}

function relativeWorkspacePath(workspaceRoot, absolutePath) {
  const relative = normalizePath(nodePath.relative(workspaceRoot, absolutePath));
  if (!relative || relative.startsWith('../') || nodePath.isAbsolute(relative)) {
    throw new Error(`path escapes workspace: ${absolutePath}`);
  }
  return relative;
}

function hashFile(fs, absolutePath) {
  return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function requireFile(fs, workspaceRoot, relativePath, kind, { reparseGuard, alreadyGuarded = false } = {}) {
  const absolutePath = workspacePath(workspaceRoot, relativePath);
  if (!alreadyGuarded) assertPathHasNoLinkOrReparsePoint(fs, absolutePath, `${kind} input`, reparseGuard);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`missing ${kind}: ${relativePath}`);
  }
  return { kind, path: normalizePath(relativePath), sha256: hashFile(fs, absolutePath) };
}

export function hashConfigLockFile({ fs = nodeFs, workspaceRoot, relativePath, reparseGuard } = {}) {
  const absolutePath = workspacePath(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`missing config_lock: ${relativePath}`);
  }
  if (reparseGuard) reparseGuard.assertSafeMany([absolutePath], { forceFresh: true });
  const digest = hashFile(fs, absolutePath);
  if (reparseGuard) reparseGuard.assertSafeMany([absolutePath], { forceFresh: true });
  return { kind: 'config_lock', path: normalizePath(relativePath), sha256: digest };
}

function isCodeFile(relativePath) {
  return /\.(?:[cm]?[jt]sx?)$/i.test(relativePath);
}

function compilerOptionsFor(ts, workspaceRoot, relativePath, cache) {
  const configRelativePath = relativePath.startsWith('server/') ? 'server/tsconfig.json' : 'frontend/tsconfig.json';
  if (cache.has(configRelativePath)) return cache.get(configRelativePath);
  const configPath = workspacePath(workspaceRoot, configRelativePath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(`cannot read TypeScript config: ${configRelativePath}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, nodePath.dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) throw new Error(`cannot parse TypeScript config: ${configRelativePath}`);
  cache.set(configRelativePath, parsed.options);
  return parsed.options;
}

function sourceClosureRowsFromRoots(fs, workspaceRoot, sourceRoots = SOURCE_ROOTS, reparseGuard) {
  if (!Array.isArray(sourceRoots) || sourceRoots.some(relativePath => typeof relativePath !== 'string')) {
    throw new Error('source closure roots must be a string array');
  }
  if (sourceRoots.some(relativePath => normalizePath(relativePath).endsWith('.css'))) {
    throw new Error('TerminalView.css is permitted only as a TerminalView.tsx dependency');
  }
  const serverRequire = createRequire(workspacePath(workspaceRoot, 'server/package.json'));
  let ts;
  try {
    ts = serverRequire('typescript');
  } catch (error) {
    throw new Error(`TypeScript resolver is unavailable: ${error.message}`);
  }
  const pending = [...sourceRoots];
  const resolved = new Set();
  const externalSpecifierRows = [];
  const compilerOptionsCache = new Map();
  while (pending.length > 0) {
    const currentWave = [];
    const queued = new Set();
    for (const pendingPath of pending.splice(0)) {
      const relativePath = normalizePath(pendingPath);
      if (resolved.has(relativePath) || queued.has(relativePath)) continue;
      if (relativePath.endsWith('.css') && relativePath !== 'frontend/src/components/Terminal/TerminalView.css') {
        throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
      }
      if (!relativePath.endsWith('.css') && !isCodeFile(relativePath)) {
        throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
      }
      queued.add(relativePath);
      currentWave.push(relativePath);
    }
    if (reparseGuard && currentWave.length > 0) {
      reparseGuard.assertSafeMany(currentWave.map(relativePath => workspacePath(workspaceRoot, relativePath)));
    }
    for (const relativePath of currentWave) {
      if (resolved.has(relativePath)) continue;
      if (relativePath.endsWith('.css')) {
      if (relativePath !== 'frontend/src/components/Terminal/TerminalView.css') {
        throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
      }
      const cssPath = workspacePath(workspaceRoot, relativePath);
      requireFile(fs, workspaceRoot, relativePath, 'source', { reparseGuard, alreadyGuarded: Boolean(reparseGuard) });
      const css = fs.readFileSync(cssPath, 'utf8');
      if (/@import\s+(?!url\(['"]?(?:https?:|\/\/))/i.test(css) || /url\(\s*['"]?(?!data:|https?:|\/\/|#)/i.test(css)) {
        throw new Error('TerminalView.css has a local @import or url dependency');
      }
      resolved.add(relativePath);
      continue;
    }
    if (!isCodeFile(relativePath)) throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
    const absolutePath = workspacePath(workspaceRoot, relativePath);
    requireFile(fs, workspaceRoot, relativePath, 'source closure input', { reparseGuard, alreadyGuarded: Boolean(reparseGuard) });
    resolved.add(relativePath);
    const sourceText = fs.readFileSync(absolutePath, 'utf8');
    const imported = ts.preProcessFile(sourceText, true, true).importedFiles;
    const options = compilerOptionsFor(ts, workspaceRoot, relativePath, compilerOptionsCache);
    for (const { fileName: specifier } of imported) {
      if (relativePath === 'frontend/src/components/Terminal/TerminalView.tsx' && specifier === './TerminalView.css') {
        const cssRelativePath = relativeWorkspacePath(workspaceRoot, nodePath.resolve(nodePath.dirname(absolutePath), specifier));
        if (cssRelativePath !== 'frontend/src/components/Terminal/TerminalView.css') {
          throw new Error(`unexpected workspace-local non-code dependency: ${relativePath} -> ${specifier}`);
        }
        pending.push(cssRelativePath);
        continue;
      }
      const moduleResolution = ts.resolveModuleName(specifier, absolutePath, options, ts.sys).resolvedModule;
      if (moduleResolution?.resolvedFileName) {
        const resolvedRelativePath = relativeWorkspacePath(workspaceRoot, moduleResolution.resolvedFileName);
        if (resolvedRelativePath.endsWith('.css')) {
          throw new Error(`unexpected workspace-local non-code dependency: ${relativePath} -> ${specifier}`);
        }
        if (!isCodeFile(resolvedRelativePath)) {
          throw new Error(`unexpected workspace-local non-code dependency: ${resolvedRelativePath}`);
        }
        pending.push(resolvedRelativePath);
        continue;
      }
      const configuredPaths = Object.keys(options.paths ?? {});
      const configuredAlias = configuredPaths.some(pattern => specifier.startsWith(pattern.replace(/\*$/, '')));
      if (specifier.startsWith('.') || specifier.startsWith('/') || configuredAlias) {
        if (/\.(?:css|json(?:5)?)$/i.test(specifier)) {
          throw new Error(`unexpected workspace-local non-code dependency: ${relativePath} -> ${specifier}`);
        }
        throw new Error(`unresolved workspace-relative or alias import: ${relativePath} -> ${specifier}`);
      }
      externalSpecifierRows.push({
        from: relativePath,
        specifier,
        resolvedOrBuiltin: specifier.startsWith('node:') ? 'builtin' : `package:${specifier}`,
      });
    }
    }
  }
  const resolvedPaths = [...resolved];
  if (reparseGuard && resolvedPaths.length > 0) {
    reparseGuard.assertSafeMany(resolvedPaths.map(relativePath => workspacePath(workspaceRoot, relativePath)));
  }
  return {
    sourceClosureRows: stableRows(resolvedPaths.map(relativePath => requireFile(
      fs,
      workspaceRoot,
      relativePath,
      'source',
      { reparseGuard, alreadyGuarded: Boolean(reparseGuard) },
    ))),
    externalSpecifierRows: stableRows(externalSpecifierRows),
  };
}

export function collectSourceClosure({ workspaceRoot, sourceRoots = SOURCE_ROOTS, fs = nodeFs }) {
  if (!workspaceRoot || !isAbsoluteWindowsPath(workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute Windows path');
  }
  return sourceClosureRowsFromRoots(fs, workspaceRoot, sourceRoots);
}

function collectSourceClosureWithGuard({ workspaceRoot, sourceRoots = SOURCE_ROOTS, fs = nodeFs, reparseGuard }) {
  if (!workspaceRoot || !isAbsoluteWindowsPath(workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute Windows path');
  }
  return sourceClosureRowsFromRoots(fs, workspaceRoot, sourceRoots, reparseGuard);
}

function readJsonFixture(fs, workspaceRoot, relativePath, { reparseGuard, alreadyGuarded = false } = {}) {
  const absolutePath = workspacePath(workspaceRoot, relativePath);
  try {
    requireFile(fs, workspaceRoot, relativePath, 'fixture', { reparseGuard, alreadyGuarded });
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`fixture is not valid JSON: ${relativePath} (${error.message})`);
  }
}

function fixtureRelativePath(workspaceRoot, value) {
  return relativeWorkspacePath(workspaceRoot, resolveFixturePath({ workspaceRoot, fixtureRoot: FIXTURE_ROOT, value }));
}

function fixtureRowsFromEntry(fs, workspaceRoot, reparseGuard) {
  const publicationPath = `${FIXTURE_ENTRY}.publication.json`;
  const rawPath = `${FIXTURE_ENTRY}.raw.json`;
  if (reparseGuard) {
    reparseGuard.assertSafeMany([FIXTURE_ENTRY, publicationPath].map(relativePath => workspacePath(workspaceRoot, relativePath)));
  }
  const fixtureReadOptions = { reparseGuard, alreadyGuarded: Boolean(reparseGuard) };
  const decision = readJsonFixture(fs, workspaceRoot, FIXTURE_ENTRY, fixtureReadOptions);
  const publication = readJsonFixture(fs, workspaceRoot, publicationPath, fixtureReadOptions);
  const publicationArtifactPath = fixtureRelativePath(workspaceRoot, publication.artifactPath);
  const publicationRawPath = fixtureRelativePath(workspaceRoot, publication.rawPath);
  if (reparseGuard) {
    reparseGuard.assertSafeMany([publicationArtifactPath, publicationRawPath].map(relativePath => workspacePath(workspaceRoot, relativePath)));
  }
  const publishedArtifact = readJsonFixture(fs, workspaceRoot, publicationArtifactPath, fixtureReadOptions);
  const rawEvidencePaths = [
    ...(decision.rawEvidencePaths ?? []),
    ...(publishedArtifact.rawEvidencePaths ?? []),
  ];
  if (!Array.isArray(rawEvidencePaths) || rawEvidencePaths.some(entry => typeof entry !== 'string')) {
    throw new Error('fixture rawEvidencePaths must be an array of literal paths');
  }
  const paths = new Set([
    FIXTURE_ENTRY,
    publicationPath,
    rawPath,
    publicationArtifactPath,
    publicationRawPath,
    ...rawEvidencePaths.map(value => fixtureRelativePath(workspaceRoot, value)),
  ]);
  const fixturePaths = [...paths];
  if (reparseGuard) reparseGuard.assertSafeMany(fixturePaths.map(relativePath => workspacePath(workspaceRoot, relativePath)));
  return stableRows(fixturePaths.map(relativePath => requireFile(
    fs,
    workspaceRoot,
    relativePath,
    'fixture',
    { reparseGuard, alreadyGuarded: Boolean(reparseGuard) },
  )));
}

function readGitLines(workspaceRoot, args) {
  const result = execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return normalizeLf(result).split('\n').filter(Boolean);
}

function gitProtectedInput(workspaceRoot, protectedPaths) {
  const statusLines = readGitLines(workspaceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', ...protectedPaths]);
  const indexLines = readGitLines(workspaceRoot, ['ls-files', '--stage', '--', ...protectedPaths]);
  const statusRows = statusLines.map(line => {
    if (line.length < 4 || !/^(?:[ MADRCU?!][ MADRCU?!]) /.test(line)) throw new Error(`unparseable Git status row: ${line}`);
    const row = { xy: line.slice(0, 2), path: normalizePath(line.slice(3)) };
    if (!row.path || row.path.includes(' -> ') || row.path.includes('../')) throw new Error(`ambiguous Git status row: ${line}`);
    return row;
  });
  const indexRows = indexLines.map(line => {
    const match = /^(\d+) ([0-9a-f]{40}) (\d)\t(.+)$/.exec(line);
    if (!match) throw new Error(`unparseable Git index row: ${line}`);
    return { mode: match[1], object: match[2], stage: match[3], path: normalizePath(match[4]) };
  });
  const duplicate = rows => new Set(rows.map(row => canonicalJson(row))).size !== rows.length;
  if (duplicate(statusRows) || duplicate(indexRows)) throw new Error('duplicate Git protected-input rows');
  const configStatusRows = statusRows.filter(row => row.path === 'server/config.json5');
  const configIndexRows = indexRows.filter(row => row.path === 'server/config.json5');
  validateConfigLockRows({ statusRows: configStatusRows, indexRows: configIndexRows });
  return {
    commandPrefix: ['git', '-c', 'core.longpaths=true'],
    head: readGitLines(workspaceRoot, ['rev-parse', 'HEAD'])[0],
    protectedRepoPaths: [...protectedPaths].sort(),
    statusRows,
    indexRows,
    diagnostics: [],
  };
}

function selectedCommands(contract) {
  const isWindows = process.platform === 'win32';
  return contract.commandFamilies.map(({ id, cwd, posixArgv, windowsArgv, environment }) => ({
    id,
    cwd,
    argv: isWindows ? windowsArgv : posixArgv,
    ...(environment ? { environment } : {}),
  }));
}

function runtimeRecord(fs, execFile) {
  const absolute = nodePath.resolve(execFile);
  return {
    path: normalizePath(absolute),
    sha256: hashFile(fs, absolute),
    versionStdoutLf: normalizeLf(process.version.endsWith('\n') ? process.version : `${process.version}\n`),
  };
}

function assertManifestDestination(workspaceRoot, manifestPath, fs, reparseGuard) {
  const analysisRoot = workspacePath(workspaceRoot, ANALYSIS_DIRECTORY);
  const destination = nodePath.resolve(manifestPath);
  if (!isWithinPath(destination, analysisRoot) || nodePath.dirname(destination) !== analysisRoot || nodePath.extname(destination).toLowerCase() !== '.json') {
    throw new Error(`manifest must be a JSON leaf in ${ANALYSIS_DIRECTORY}`);
  }
  assertPathHasNoLinkOrReparsePoint(fs, destination, 'manifest destination', reparseGuard, { forceFresh: true });
  if (fs.existsSync(destination)) throw new Error(`manifest already exists: ${destination}`);
  return { analysisRoot, destination };
}

export function captureFrozenProvenance(options) {
  assertPlainObject(options, 'capture options');
  if (Object.hasOwn(options, 'testOnlyInputs') || Object.hasOwn(options, 'sourceRoots')) {
    throw new Error('frozen capture inputs reject test-only or source-root overrides');
  }
  const {
    workspaceRoot,
    manifestPath,
    phase,
    execFile = fileURLToPath(import.meta.url),
    fs = nodeFs,
  } = options;
  const reparseGuard = createSegmentReparseGuard({
    fs,
    probeBatch: paths => probeWindowsReparsePoints({ paths }),
  });
  const contract = validateFrozenContract({ workspaceRoot, contract: FROZEN_CONTRACT, fs, reparseGuard });
  const { analysisRoot, destination } = assertManifestDestination(workspaceRoot, manifestPath, fs, reparseGuard);
  reparseGuard.assertSafeMany(CONFIG_LOCK_PATHS.map(relativePath => workspacePath(workspaceRoot, relativePath)));
  const { sourceClosureRows, externalSpecifierRows } = collectSourceClosureWithGuard({
    workspaceRoot,
    sourceRoots: SOURCE_ROOTS,
    fs,
    reparseGuard,
  });
  const fixtureRows = fixtureRowsFromEntry(fs, workspaceRoot, reparseGuard);
  const configLockRows = CONFIG_LOCK_PATHS.map(relativePath => hashConfigLockFile({
    fs,
    workspaceRoot,
    relativePath,
    reparseGuard,
  }));
  reparseGuard.assertSafeMany([execFile, process.execPath].map(candidate => nodePath.resolve(candidate)));
  const protectedPaths = [...new Set([...sourceClosureRows, ...fixtureRows, ...configLockRows].map(row => row.path))].sort();
  const git = gitProtectedInput(workspaceRoot, protectedPaths);
  const manifest = buildCanonicalManifest({
    contract,
    phase,
    collector: { path: relativeWorkspacePath(workspaceRoot, execFile), sha256: hashFile(fs, execFile) },
    nodeRuntime: runtimeRecord(fs, process.execPath),
    selectedCommands: selectedCommands(contract),
    sourceClosureRows,
    fixtureRows,
    configLockRows,
    externalSpecifierRows,
    git,
  });
  fs.mkdirSync(analysisRoot, { recursive: true });
  assertPathHasNoLinkOrReparsePoint(fs, destination, 'manifest destination', reparseGuard, { forceFresh: true });
  fs.writeFileSync(destination, `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
  return manifest;
}

function parseCaptureArguments(argv) {
  if (argv[0] !== 'capture') throw new Error('usage: capture --phase <phase> --manifest <path>');
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1]) throw new Error('usage: capture --phase <phase> --manifest <path>');
    values.set(argv[index], argv[index + 1]);
  }
  if (values.size !== 2 || !values.has('--phase') || !values.has('--manifest')) {
    throw new Error('usage: capture --phase <phase> --manifest <path>');
  }
  return { phase: values.get('--phase'), manifestPath: values.get('--manifest') };
}

function runCli() {
  try {
    const { phase, manifestPath } = parseCaptureArguments(process.argv.slice(2));
    const manifest = captureFrozenProvenance({ workspaceRoot: process.cwd(), manifestPath, phase });
    process.stdout.write(`${canonicalJson({ schemaVersion: manifest.schemaVersion, phase: manifest.phase, sha256: manifest.protectedInput.sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`fair-readmission closure-v3: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && nodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}

// @req 2026-07-27.pm.fair-readmission-closure-v3
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  'frontend/src/components/Terminal/TerminalView.css',
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

function assertExternalOutputPath({ workspaceRoot, outputDir, fs }) {
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

  const parts = normalizedOutput.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = parts.slice(0, index + 1).join('/');
    if (ancestor === normalizedOutput) continue;
    let stat;
    try {
      stat = fs.lstatSync(ancestor);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`cannot inspect Playwright output ancestor: ${ancestor}`);
    }
    if (stat?.isSymbolicLink?.() || stat?.isReparsePoint?.()) {
      throw new Error(`Playwright output ancestor is a reparse point or link: ${ancestor}`);
    }
  }
}

export function validateFrozenContract({ workspaceRoot, contract = FROZEN_CONTRACT, fs = nodeFs }) {
  if (!workspaceRoot || !isAbsoluteWindowsPath(workspaceRoot)) {
    throw new Error('workspaceRoot must be an absolute Windows path');
  }
  assertPlainObject(contract, 'frozen contract');
  assertPlainObject(contract.playwright, 'frozen contract playwright');
  assertExternalOutputPath({ workspaceRoot, outputDir: contract.playwright.outputDir, fs });
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

function requireFile(fs, workspaceRoot, relativePath, kind) {
  const absolutePath = workspacePath(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`missing ${kind}: ${relativePath}`);
  }
  return { kind, path: normalizePath(relativePath), sha256: hashFile(fs, absolutePath) };
}

function isCodeFile(relativePath) {
  return /\.(?:[cm]?[jt]sx?|json)$/i.test(relativePath);
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

function sourceClosureRowsFromRoots(fs, workspaceRoot) {
  const serverRequire = createRequire(workspacePath(workspaceRoot, 'server/package.json'));
  let ts;
  try {
    ts = serverRequire('typescript');
  } catch (error) {
    throw new Error(`TypeScript resolver is unavailable: ${error.message}`);
  }
  const pending = [...SOURCE_ROOTS];
  const resolved = new Set();
  const externalSpecifierRows = [];
  const compilerOptionsCache = new Map();
  while (pending.length > 0) {
    const relativePath = normalizePath(pending.pop());
    if (resolved.has(relativePath)) continue;
    if (relativePath.endsWith('.css')) {
      if (relativePath !== 'frontend/src/components/Terminal/TerminalView.css') {
        throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
      }
      const css = fs.readFileSync(workspacePath(workspaceRoot, relativePath), 'utf8');
      if (/@import\s+(?!url\(['"]?(?:https?:|\/\/))/i.test(css) || /url\(\s*['"]?(?!data:|https?:|\/\/|#)/i.test(css)) {
        throw new Error('TerminalView.css has a local @import or url dependency');
      }
      resolved.add(relativePath);
      continue;
    }
    if (!isCodeFile(relativePath)) throw new Error(`unexpected workspace-local non-code dependency: ${relativePath}`);
    const absolutePath = workspacePath(workspaceRoot, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`missing source closure input: ${relativePath}`);
    }
    resolved.add(relativePath);
    const sourceText = fs.readFileSync(absolutePath, 'utf8');
    const imported = ts.preProcessFile(sourceText, true, true).importedFiles;
    const options = compilerOptionsFor(ts, workspaceRoot, relativePath, compilerOptionsCache);
    for (const { fileName: specifier } of imported) {
      const moduleResolution = ts.resolveModuleName(specifier, absolutePath, options, ts.sys).resolvedModule;
      if (moduleResolution?.resolvedFileName) {
        const resolvedRelativePath = relativeWorkspacePath(workspaceRoot, moduleResolution.resolvedFileName);
        if (resolvedRelativePath.endsWith('.css') && relativePath !== 'frontend/src/components/Terminal/TerminalView.tsx') {
          throw new Error(`only TerminalView.tsx may reference TerminalView.css: ${relativePath}`);
        }
        if (!isCodeFile(resolvedRelativePath) && !resolvedRelativePath.endsWith('.css')) {
          throw new Error(`unexpected workspace-local non-code dependency: ${resolvedRelativePath}`);
        }
        pending.push(resolvedRelativePath);
        continue;
      }
      const configuredPaths = Object.keys(options.paths ?? {});
      const configuredAlias = configuredPaths.some(pattern => specifier.startsWith(pattern.replace(/\*$/, '')));
      if (specifier.startsWith('.') || specifier.startsWith('/') || configuredAlias) {
        throw new Error(`unresolved workspace-relative or alias import: ${relativePath} -> ${specifier}`);
      }
      externalSpecifierRows.push({
        from: relativePath,
        specifier,
        resolvedOrBuiltin: specifier.startsWith('node:') ? 'builtin' : `package:${specifier}`,
      });
    }
  }
  return {
    sourceClosureRows: stableRows([...resolved].map(relativePath => requireFile(fs, workspaceRoot, relativePath, 'source'))),
    externalSpecifierRows: stableRows(externalSpecifierRows),
  };
}

function readJsonFixture(fs, workspaceRoot, relativePath) {
  const absolutePath = workspacePath(workspaceRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`fixture is not valid JSON: ${relativePath} (${error.message})`);
  }
}

function fixtureRelativePath(value) {
  const normalized = normalizePath(value);
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`unsafe fixture path: ${value}`);
  }
  const path = `${FIXTURE_ROOT}/${normalized}`;
  if (!isWithinPath(path, FIXTURE_ROOT)) throw new Error(`fixture path escapes evidence root: ${value}`);
  return path;
}

function fixtureRowsFromEntry(fs, workspaceRoot) {
  const decision = readJsonFixture(fs, workspaceRoot, FIXTURE_ENTRY);
  const publicationPath = `${FIXTURE_ENTRY}.publication.json`;
  const rawPath = `${FIXTURE_ENTRY}.raw.json`;
  const publication = readJsonFixture(fs, workspaceRoot, publicationPath);
  const publicationArtifactPath = fixtureRelativePath(publication.artifactPath);
  const publicationRawPath = fixtureRelativePath(publication.rawPath);
  const publishedArtifact = readJsonFixture(fs, workspaceRoot, publicationArtifactPath);
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
    ...rawEvidencePaths.map(fixtureRelativePath),
  ]);
  return stableRows([...paths].map(relativePath => requireFile(fs, workspaceRoot, relativePath, 'fixture')));
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

function assertManifestDestination(workspaceRoot, manifestPath, fs) {
  const analysisRoot = workspacePath(workspaceRoot, ANALYSIS_DIRECTORY);
  const destination = nodePath.resolve(manifestPath);
  if (!isWithinPath(destination, analysisRoot) || nodePath.dirname(destination) !== analysisRoot || nodePath.extname(destination).toLowerCase() !== '.json') {
    throw new Error(`manifest must be a JSON leaf in ${ANALYSIS_DIRECTORY}`);
  }
  if (fs.existsSync(destination)) throw new Error(`manifest already exists: ${destination}`);
  return { analysisRoot, destination };
}

export function captureFrozenProvenance({
  workspaceRoot,
  manifestPath,
  phase,
  execFile = fileURLToPath(import.meta.url),
  fs = nodeFs,
}) {
  const contract = validateFrozenContract({ workspaceRoot, contract: FROZEN_CONTRACT, fs });
  const { analysisRoot, destination } = assertManifestDestination(workspaceRoot, manifestPath, fs);
  const { sourceClosureRows, externalSpecifierRows } = sourceClosureRowsFromRoots(fs, workspaceRoot);
  const fixtureRows = fixtureRowsFromEntry(fs, workspaceRoot);
  const configLockRows = CONFIG_LOCK_PATHS.map(relativePath => requireFile(fs, workspaceRoot, relativePath, 'config_lock'));
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

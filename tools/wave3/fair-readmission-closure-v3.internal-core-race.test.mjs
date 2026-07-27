import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const analysisRoot = path.join(workspaceRoot, 'docs', 'analysis', 'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
const collectorUrl = new URL('./fair-readmission-closure-v3.mjs', import.meta.url).href;
const internalCoreUrl = new URL('./internal/fair-readmission-closure-v3-internal-core.mjs', import.meta.url).href;
const analysisRootRelativePath = path.join('docs', 'analysis', 'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3');
const WX_RACE_PROTOCOL = 'fair-readmission-wx-race-v1';
const WX_RACE_TIMEOUT_MS = 45_000;
const FIXTURE_SUPPORT_INPUTS = Object.freeze([
  'tools/wave3/internal/fair-readmission-closure-v3-internal-core.mjs',
]);
let protectedFixtureSeedPromise;

const wxRacePreloaderSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const actor = process.env.WAVE3_NATIVE_RACE_ACTOR;
const suppliedTarget = process.env.WAVE3_NATIVE_RACE_TARGET;
const fault = process.env.WAVE3_NATIVE_RACE_FAULT || 'none';
if (actor !== 'A' || typeof suppliedTarget !== 'string' || suppliedTarget.length === 0) {
  throw new Error('fd race preloader requires one exact A target');
}
if (!['none', 'eexist', 'replacement', 'write-failure', 'postflight-failure'].includes(fault)) {
  throw new Error('fd race preloader received an unsupported fault');
}
const target = path.resolve(suppliedTarget);
const originalOpenSync = fs.openSync;
const originalWriteFileSync = fs.writeFileSync;
const originalFstatSync = fs.fstatSync;
const originalLstatSync = fs.lstatSync;
const originalReadFileSync = fs.readFileSync;
const originalCloseSync = fs.closeSync;
let trackedFd = null;
let delegatedFdWrite = false;
let fstatObserved = false;
let postflightObserved = false;
let replacementBytes = null;
let closeCount = 0;
let allowReplacementNativeOpen = false;
let postwriteTargetLstatCount = 0;

function emit(event, extra) {
  fs.writeSync(1, JSON.stringify(Object.assign({
    protocol: 'fair-readmission-wx-race-v1',
    actor,
    event,
  }, extra || {})) + '\\n');
}

function isExactTarget(candidate) {
  return typeof candidate === 'string' && path.resolve(candidate) === target;
}

function isWxFlag(flags) {
  return flags === 'wx';
}

function missingTargetError() {
  const error = new Error('injected pre-open missing target view for actual EEXIST open');
  error.code = 'ENOENT';
  return error;
}

function releaseAfterDelegatedFdWrite() {
  const release = Buffer.alloc(1);
  if (fs.readSync(0, release, 0, 1, null) !== 1) {
    throw new Error('fd race preloader did not receive a release byte');
  }
  if (release[0] === 0x58) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      emit('replacement-blocked', { stage: 'unlink', code: error?.code ?? 'UNKNOWN' });
      emit('release');
      return;
    }
    try {
      allowReplacementNativeOpen = true;
      originalWriteFileSync.call(fs, target, replacementBytes, { flag: 'wx' });
      emit('replaced');
    } catch (error) {
      emit('replacement-partial', { stage: 'rewrite', code: error?.code ?? 'UNKNOWN' });
    } finally {
      allowReplacementNativeOpen = false;
    }
  } else if (release[0] !== 0x50 && release[0] !== 0x52) {
    throw new Error('fd race preloader received an invalid release byte');
  }
  emit('release');
}

fs.openSync = function trackExactNonceOpen(candidate, flags) {
  if (!isExactTarget(candidate) || !isWxFlag(flags) || trackedFd !== null || allowReplacementNativeOpen) {
    return originalOpenSync.apply(fs, arguments);
  }
  try {
    const fd = originalOpenSync.apply(fs, arguments);
    trackedFd = fd;
    emit('open', { fd });
    return fd;
  } catch (error) {
    if (error?.code === 'EEXIST') emit('open-eexist');
    throw error;
  }
};

fs.writeFileSync = function requireTrackedFdWrite(candidate, data, options) {
  if (isExactTarget(candidate)) {
    emit('path-write-bypass');
    throw new Error('manifest persistence must use the retained openSync wx descriptor, not a pathname writeFileSync');
  }
  if (candidate !== trackedFd) return originalWriteFileSync.apply(fs, arguments);
  const result = originalWriteFileSync.apply(fs, arguments);
  delegatedFdWrite = true;
  replacementBytes = Buffer.from(data);
  emit('fd-write', { fd: trackedFd });
  if (fault === 'write-failure') {
    emit('write-failure');
    throw new Error('injected retained-fd write failure after delegated descriptor write');
  }
  if (fault !== 'replacement') releaseAfterDelegatedFdWrite();
  return result;
};

fs.fstatSync = function trackRetainedFdPostWrite(candidate) {
  const result = originalFstatSync.apply(fs, arguments);
  if (candidate === trackedFd) {
    if (!delegatedFdWrite) {
      emit('fstat-before-fd-write', { fd: trackedFd });
    } else {
      fstatObserved = true;
      emit('fstat', { fd: trackedFd });
    }
  }
  return result;
};

fs.lstatSync = function requirePostflightAfterFstat(candidate) {
  if (fault === 'eexist' && trackedFd === null && isExactTarget(candidate)) {
    throw missingTargetError();
  }
  if (isExactTarget(candidate) && delegatedFdWrite && !fstatObserved) {
    emit('target-lstat-before-fstat');
  }
  const result = originalLstatSync.apply(fs, arguments);
  if (isExactTarget(candidate) && delegatedFdWrite && fstatObserved && !postflightObserved) {
    postwriteTargetLstatCount += 1;
    postflightObserved = true;
    emit('postflight');
    emit('guarded-postwrite-probe', { count: postwriteTargetLstatCount });
    if (fault === 'postflight-failure') {
      emit('postflight-failure');
      throw new Error('injected retained-fd postflight failure');
    }
  } else if (isExactTarget(candidate) && delegatedFdWrite && fstatObserved) {
    postwriteTargetLstatCount += 1;
    if (postwriteTargetLstatCount === 2) {
      emit('guarded-postwrite-probe-complete', { count: postwriteTargetLstatCount });
      if (fault === 'replacement') releaseAfterDelegatedFdWrite();
    } else if (postwriteTargetLstatCount === 5) {
      emit('final-leaf-identity-observation', { count: postwriteTargetLstatCount });
    }
  }
  return result;
};

fs.readFileSync = function rejectPathnameReadBeforePostflight(candidate) {
  if (isExactTarget(candidate) && trackedFd !== null && !postflightObserved) {
    emit('pathname-read-before-postflight');
    throw new Error('manifest persistence read its pathname before retained-fd postflight');
  }
  return originalReadFileSync.apply(fs, arguments);
};

fs.closeSync = function trackRetainedFdClose(candidate) {
  const result = originalCloseSync.apply(fs, arguments);
  if (candidate === trackedFd) {
    closeCount += 1;
    emit('close', { fd: trackedFd, closeCount });
  }
  return result;
};
syncBuiltinESMExports();
`;

const guardBeforeMutationPreloaderSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const actor = process.env.WAVE3_NATIVE_RACE_ACTOR;
const suppliedAnalysisRoot = process.env.WAVE3_NATIVE_RACE_ANALYSIS_ROOT;
const suppliedTarget = process.env.WAVE3_NATIVE_RACE_TARGET;
if (actor !== 'G' || typeof suppliedAnalysisRoot !== 'string' || suppliedAnalysisRoot.length === 0 || typeof suppliedTarget !== 'string' || suppliedTarget.length === 0) {
  throw new Error('guard-before-mutation preloader requires exact G analysis and manifest paths');
}
const analysisRoot = path.resolve(suppliedAnalysisRoot);
const target = path.resolve(suppliedTarget);
const originalLstatSync = fs.lstatSync;
const originalMkdirSync = fs.mkdirSync;
const originalOpenSync = fs.openSync;
const originalSpawnSync = childProcess.spawnSync;
let initialMissingLstatGated = false;
let analysisMkdirCount = 0;

function emit(event, extra) {
  fs.writeSync(1, JSON.stringify(Object.assign({
    protocol: 'fair-readmission-wx-race-v1',
    actor,
    event,
  }, extra || {})) + '\\n');
}

function isExactAnalysisRoot(candidate) {
  return typeof candidate === 'string' && path.resolve(candidate) === analysisRoot;
}

function isExactTarget(candidate) {
  return typeof candidate === 'string' && path.resolve(candidate) === target;
}

function decodeFixedProbePaths(args) {
  const environment = args[2]?.env;
  const encoded = environment?.FAIR_READMISSION_CLOSURE_V3_REPARSE_BATCH_PATHS_BASE64;
  if (typeof encoded !== 'string') return undefined;
  try {
    const paths = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (!Array.isArray(paths) || !paths.every(candidate => typeof candidate === 'string')) return undefined;
    return paths;
  } catch {
    return undefined;
  }
}

childProcess.spawnSync = function observeFixedReparseProbe() {
  const probePaths = decodeFixedProbePaths(arguments);
  const result = originalSpawnSync.apply(childProcess, arguments);
  if (probePaths?.some(candidate => isExactAnalysisRoot(candidate) || isExactTarget(candidate))) {
    emit('manifest-probe', {
      containsAnalysisRoot: probePaths.some(isExactAnalysisRoot),
      containsTarget: probePaths.some(isExactTarget),
    });
  }
  return result;
};

fs.lstatSync = function gateInitialMissingAnalysisRoot(candidate) {
  if (!initialMissingLstatGated && isExactAnalysisRoot(candidate)) {
    try {
      return originalLstatSync.apply(fs, arguments);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      initialMissingLstatGated = true;
      emit('initial-lstat-missing');
      const release = Buffer.alloc(1);
      if (fs.readSync(0, release, 0, 1, null) !== 1 || release[0] !== 0x52) {
        throw new Error('guard-before-mutation preloader did not receive the R release byte');
      }
      emit('release');
      throw error;
    }
  }
  return originalLstatSync.apply(fs, arguments);
};

fs.mkdirSync = function observeAnalysisRootMutation(candidate) {
  const result = originalMkdirSync.apply(fs, arguments);
  if (isExactAnalysisRoot(candidate)) {
    analysisMkdirCount += 1;
    emit('mkdir', { count: analysisMkdirCount });
  }
  return result;
};

fs.openSync = function observeManifestExclusiveOpen(candidate, flags) {
  const result = originalOpenSync.apply(fs, arguments);
  if (isExactTarget(candidate) && flags === 'wx') emit('open');
  return result;
};
syncBuiltinESMExports();
`;

const wxRaceRunnerSource = `import { writeSync } from 'node:fs';

const protocol = 'fair-readmission-wx-race-v1';
const actor = process.env.WAVE3_NATIVE_RACE_ACTOR;
const collectorUrl = process.env.WAVE3_NATIVE_RACE_COLLECTOR_URL;
const workspaceRoot = process.env.WAVE3_NATIVE_RACE_WORKSPACE_ROOT;
const manifestPath = process.env.WAVE3_NATIVE_RACE_MANIFEST_PATH;
const phase = process.env.WAVE3_NATIVE_RACE_PHASE;

function emit(event, extra) {
  writeSync(1, JSON.stringify(Object.assign({ protocol, actor, event }, extra || {})) + '\\n');
}

try {
  if (!['A', 'B', 'G'].includes(actor) || !collectorUrl || !workspaceRoot || !manifestPath || !phase) {
    throw new Error('wx race runner has incomplete fixed inputs');
  }
  const { captureFrozenProvenance } = await import(collectorUrl);
  const manifest = captureFrozenProvenance({ workspaceRoot, manifestPath, phase });
  emit('captured', { sha256: manifest.protectedInput.sha256 });
} catch (error) {
  emit('error', { message: error?.stack ?? error?.message ?? String(error) });
  process.exitCode = 1;
}
`;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForReadyMessages(messages, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errors = messages.filter(message => message.phase === 'error' || message.phase === 'worker-error');
    if (errors.length > 0) throw new Error(`worker failed before barrier release: ${errors.map(message => message.message).join('\n')}`);
    if (messages.filter(message => message.phase === 'ready').length === expected) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for every ready message');
}

function assertOwnedLeaf(candidate, prefix) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = `${path.resolve(analysisRoot)}${path.sep}`;
  assert.equal(normalizedCandidate.startsWith(normalizedRoot), true, 'cleanup stays within the analysis directory');
  assert.equal(path.basename(normalizedCandidate).startsWith(prefix), true, 'cleanup targets only this test-owned nonce');
}

function removeOwnedLeaf(candidate, prefix) {
  assertOwnedLeaf(candidate, prefix);
  if (existsSync(candidate)) unlinkSync(candidate);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function observeNativeRootDiscovery(run) {
  const originalSpawnSync = childProcess.spawnSync;
  let nativeProbeCount = 0;
  childProcess.spawnSync = function observeDelegatedNativeProbe(executable) {
    if (typeof executable === 'string' && executable.toLowerCase().includes('powershell')) nativeProbeCount += 1;
    return originalSpawnSync.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    return { result: await run(), nativeProbeCount };
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
}

async function withSyntheticRootSourceDrift(relativePath, run) {
  const originalReadFileSync = readFileSync;
  const sourcePath = path.resolve(workspaceRoot, assertFixtureRelativePath(relativePath, 'synthetic root source drift path'));
  const changedBytes = Buffer.from(`${originalReadFileSync(sourcePath)}\n`, 'utf8');
  const nodeFs = await import('node:fs');
  nodeFs.default.readFileSync = function synthesizeRootSourceDrift(candidate) {
    if (typeof candidate === 'string' && path.resolve(candidate) === sourcePath) return Buffer.from(changedBytes);
    return originalReadFileSync.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    nodeFs.default.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}

async function withPostCopySyntheticRootSourceDrift(relativePath, run) {
  const originalReadFileSync = readFileSync;
  const sourcePath = path.resolve(workspaceRoot, assertFixtureRelativePath(relativePath, 'post-copy synthetic root source drift path'));
  const changedBytes = Buffer.from(`${originalReadFileSync(sourcePath)}\n`, 'utf8');
  const nodeFs = await import('node:fs');
  let sourceReadCount = 0;
  nodeFs.default.readFileSync = function synthesizePostCopyRootSourceDrift(candidate) {
    if (typeof candidate === 'string' && path.resolve(candidate) === sourcePath) {
      sourceReadCount += 1;
      if (sourceReadCount > 1) return Buffer.from(changedBytes);
    }
    return originalReadFileSync.apply(this, arguments);
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    nodeFs.default.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}

function assertFixtureRelativePath(relativePath, label) {
  assert.equal(typeof relativePath, 'string', `${label} is a string`);
  assert.equal(relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.includes('..') && !relativePath.startsWith('.git/'), true, `${label} stays within the minimal fixture payload`);
  return relativePath.replaceAll('/', path.sep);
}

function readCurrentProtectedFixtureSource(relativePath, label) {
  const relativeNativePath = assertFixtureRelativePath(relativePath, label);
  const sourcePath = path.resolve(workspaceRoot, relativeNativePath);
  const sourceStat = lstatSync(sourcePath);
  assert.equal(sourceStat.isFile(), true, `${label} is a regular file: ${relativePath}`);
  assert.equal(isLinkOrReparsePoint(sourceStat), false, `${label} is not a link or reparse point: ${relativePath}`);
  return readFileSync(sourcePath);
}

function assertCurrentProtectedFixtureSeedSource(seedInput) {
  const currentBytes = readCurrentProtectedFixtureSource(seedInput.path, 'protected fixture source manifest input');
  assert.equal(
    sha256Bytes(currentBytes),
    seedInput.sha256,
    `protected fixture source manifest input SHA-256 matches the closed seed: ${seedInput.path}`,
  );
}

function copyFixtureRegularFile({ fixtureRoot, seedInput }) {
  const { path: relativePath, sha256 } = seedInput;
  const relativeNativePath = assertFixtureRelativePath(relativePath, 'protected fixture input');
  const destinationPath = path.resolve(fixtureRoot, relativeNativePath);
  assertOwnedWorkspaceDescendant(destinationPath, fixtureRoot, 'protected fixture destination');
  assert.equal(Buffer.isBuffer(seedInput.bytes), true, `protected fixture seed bytes are a Buffer: ${relativePath}`);
  const bytes = Buffer.from(seedInput.bytes);
  assert.notStrictEqual(bytes, seedInput.bytes, `fixture receives an independent Buffer instance: ${relativePath}`);
  assert.equal(sha256Bytes(bytes), sha256, `protected fixture seed bytes match their SHA-256: ${relativePath}`);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, bytes, { flag: 'wx' });
  assert.deepEqual(readFileSync(destinationPath), bytes, `protected fixture input is byte-identical: ${relativePath}`);
  const destinationStat = lstatSync(destinationPath);
  assert.equal(destinationStat.isFile(), true, `protected fixture input is copied as a regular file: ${relativePath}`);
  assert.equal(isLinkOrReparsePoint(destinationStat), false, `protected fixture input is copied without a link or reparse point: ${relativePath}`);
  return Object.freeze({ path: relativePath.replaceAll(path.sep, '/'), bytes: bytes.length, sha256 });
}

function addProtectedFixtureSeedRow(rowsByPath, row, label) {
  const relativePath = row?.path;
  const sha256 = row?.sha256;
  const relativeNativePath = assertFixtureRelativePath(relativePath, label);
  assert.match(sha256, /^[a-f0-9]{64}$/i, `${label} has a SHA-256`);
  const normalizedPath = relativeNativePath.replaceAll(path.sep, '/');
  const existing = rowsByPath.get(normalizedPath);
  if (existing) {
    assert.equal(existing.sha256, sha256, `${label} has one stable SHA-256 per protected path: ${normalizedPath}`);
    return;
  }
  rowsByPath.set(normalizedPath, Object.freeze({ path: normalizedPath, sha256 }));
}

async function captureProtectedFixtureSeed() {
  const prefix = `minimal-native-fixture-seed-${process.pid}-${randomBytes(6).toString('hex')}`;
  const manifestPath = path.join(analysisRoot, `${prefix}.json`);
  try {
    const { captureFrozenProvenance } = await import(collectorUrl);
    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath,
      phase: 'minimal-native-fixture-protected-input-seed',
    });
    const protectedValue = manifest?.protectedInput?.value;
    assert.ok(protectedValue && typeof protectedValue === 'object', 'normal seed capture returns its protected manifest value');
    const protectedRows = [
      ...(protectedValue.sourceClosureRows ?? []),
      ...(protectedValue.fixtureRows ?? []),
      ...(protectedValue.configLockRows ?? []),
      protectedValue.collector,
    ];
    const rowsByPath = new Map();
    for (const row of protectedRows) {
      addProtectedFixtureSeedRow(rowsByPath, row, 'protected root manifest row');
    }
    for (const relativePath of FIXTURE_SUPPORT_INPUTS) {
      if (rowsByPath.has(relativePath)) continue;
      const bytes = readCurrentProtectedFixtureSource(relativePath, 'fixture support input');
      rowsByPath.set(relativePath, Object.freeze({ path: relativePath, sha256: sha256Bytes(bytes) }));
    }
    return Object.freeze([...rowsByPath.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path: relativePath, sha256 }) => {
        const bytes = readCurrentProtectedFixtureSource(relativePath, 'protected root manifest input');
        assert.equal(sha256Bytes(bytes), sha256, `protected root manifest input bytes match the manifest SHA-256: ${relativePath}`);
        return Object.freeze({ path: relativePath, bytes: Buffer.from(bytes), sha256 });
      }));
  } finally {
    removeOwnedLeaf(manifestPath, prefix);
  }
}

function protectedCaptureManifestInputs() {
  if (!protectedFixtureSeedPromise) {
    const seedPromise = captureProtectedFixtureSeed();
    protectedFixtureSeedPromise = seedPromise;
    seedPromise.catch(() => {
      if (protectedFixtureSeedPromise === seedPromise) protectedFixtureSeedPromise = undefined;
    });
  }
  return protectedFixtureSeedPromise;
}

function initializeMinimalFixtureGit(fixtureRoot) {
  writeFileSync(path.join(fixtureRoot, '.gitignore'), 'server/config.json5\n', { encoding: 'utf8', flag: 'wx' });
  runFixtureGit(fixtureRoot, ['init', '--quiet']);
  runFixtureGit(fixtureRoot, ['config', 'core.longpaths', 'true']);
  runFixtureGit(fixtureRoot, ['config', 'user.name', 'minimal-native-fixture']);
  runFixtureGit(fixtureRoot, ['config', 'user.email', 'minimal-native-fixture@example.invalid']);
  runFixtureGit(fixtureRoot, ['add', '--all']);
  runFixtureGit(fixtureRoot, ['commit', '--quiet', '--no-gpg-sign', '-m', 'minimal native fixture']);
}

async function createOwnedWorkspaceWithoutAnalysisParent() {
  const ownedRoot = mkdtempSync(path.join(tmpdir(), 'fair-readmission-missing-parent-'));
  const fixtureRoot = path.join(ownedRoot, 'workspace');
  try {
    mkdirSync(fixtureRoot, { recursive: true });
    const protectedSeed = await protectedCaptureManifestInputs();
    for (const seedInput of protectedSeed) assertCurrentProtectedFixtureSeedSource(seedInput);
    const protectedFiles = Object.freeze(protectedSeed.map(seedInput => copyFixtureRegularFile({ fixtureRoot, seedInput })));
    initializeMinimalFixtureGit(fixtureRoot);
    const inventory = fixtureRegularFileInventory(fixtureRoot);
    const fixture = Object.freeze({
      ownedRoot,
      fixtureRoot,
      protectedFiles,
      inventory,
      payloadFileCount: protectedFiles.length,
      payloadByteCount: protectedFiles.reduce((total, file) => total + file.bytes, 0),
    });
    assertMinimalNativeFixtureParity(fixture);
    for (const seedInput of protectedSeed) assertCurrentProtectedFixtureSeedSource(seedInput);
    return fixture;
  } catch (error) {
    rmSync(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeOwnedWorkspace(ownedRoot) {
  const normalizedRoot = path.resolve(ownedRoot);
  const normalizedTemp = `${path.resolve(tmpdir())}${path.sep}`;
  assert.equal(normalizedRoot.startsWith(normalizedTemp), true, 'fixture cleanup stays within the OS temporary directory');
  assert.equal(path.basename(normalizedRoot).startsWith('fair-readmission-missing-parent-'), true, 'fixture cleanup targets only its mkdtemp root');
  rmSync(normalizedRoot, { recursive: true, force: true });
}

function fixtureRegularFileInventory(fixtureRoot) {
  const normalizedRoot = path.resolve(fixtureRoot);
  const files = [];
  const visit = candidate => {
    const normalizedCandidate = path.resolve(candidate);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    assert.equal(relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), true, 'fixture inventory remains under its owned root');
    const stat = lstatSync(normalizedCandidate);
    assert.equal(isLinkOrReparsePoint(stat), false, `fixture inventory rejects link or reparse input: ${relative || '.'}`);
    if (stat.isFile()) {
      files.push(Object.freeze({ path: relative.replaceAll(path.sep, '/'), bytes: stat.size }));
      return;
    }
    assert.equal(stat.isDirectory(), true, `fixture inventory accepts only ordinary directories or regular files: ${relative || '.'}`);
    for (const name of readdirSync(normalizedCandidate, { encoding: 'utf8' }).sort()) visit(path.join(normalizedCandidate, name));
  };
  visit(normalizedRoot);
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

function runFixtureGit(fixtureRoot, args) {
  return execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      SystemDrive: process.env.SystemDrive ?? 'C:',
      ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      PATH: 'C:\\Windows\\System32;C:\\Windows',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      LANG: 'C',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function assertMinimalNativeFixtureParity({ fixtureRoot, protectedFiles = [], inventory = fixtureRegularFileInventory(fixtureRoot) }) {
  const fixtureCollector = path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs');
  const fixtureCore = path.join(fixtureRoot, 'tools', 'wave3', 'internal', 'fair-readmission-closure-v3-internal-core.mjs');
  const protectedFileByPath = new Map(protectedFiles.map(file => [file.path, file]));
  for (const [fixturePath, protectedPath, label] of [
    [fixtureCollector, 'tools/wave3/fair-readmission-closure-v3.mjs', 'fixture collector'],
    [fixtureCore, 'tools/wave3/internal/fair-readmission-closure-v3-internal-core.mjs', 'fixture internal core'],
  ]) {
    const protectedFile = protectedFileByPath.get(protectedPath);
    if (protectedFile) {
      assert.equal(sha256Bytes(readFileSync(fixturePath)), protectedFile.sha256, `${label} bytes remain identical to the immutable seed`);
    } else {
      assert.deepEqual(readFileSync(fixturePath), readFileSync(path.join(workspaceRoot, protectedPath)), `${label} bytes remain identical to the source module`);
    }
  }
  const expectedPayloadPaths = protectedFiles.map(file => file.path).sort((left, right) => left.localeCompare(right));
  if (expectedPayloadPaths.length > 0) {
    assert.deepEqual(
      inventory.filter(file => !file.path.startsWith('.git/')).map(file => file.path),
      ['.gitignore', ...expectedPayloadPaths].sort((left, right) => left.localeCompare(right)),
      'fixture payload contains only the protected capture manifest inputs and its config-lock ignore rule',
    );
    for (const { path: relativePath, bytes, sha256 } of protectedFiles) {
      const fixturePath = path.join(fixtureRoot, assertFixtureRelativePath(relativePath, 'protected fixture parity input'));
      assert.equal(sha256Bytes(readFileSync(fixturePath)), sha256, `protected fixture bytes match the immutable seed: ${relativePath}`);
      assert.equal(lstatSync(fixturePath).size, bytes, `protected fixture byte count remains exact: ${relativePath}`);
    }
  }
  for (const pathName of ['.agents', '.claude', '.codex', 'docs/memory', 'docs/plans', 'kiwi', 'node_modules', 'AGENTS.md', 'CLAUDE.md']) {
    assert.equal(existsSync(path.join(fixtureRoot, pathName)), false, `fixture excludes unrelated root/log/build payload: ${pathName}`);
  }
  const sourceHead = runFixtureGit(workspaceRoot, ['rev-parse', 'HEAD']).trim();
  const fixtureHead = runFixtureGit(fixtureRoot, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(fixtureHead, sourceHead, 'fixture Git HEAD is independently initialized rather than copied from the worktree');
  assert.deepEqual(
    runFixtureGit(fixtureRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', 'server/config.json5']).trim().split('\n').filter(Boolean),
    ['!! server/config.json5'],
    'fixture config lock remains the exact ignored-untracked Git status row',
  );
  assert.deepEqual(
    runFixtureGit(fixtureRoot, ['ls-files', '--stage', '--', 'server/config.json5']).trim().split('\n').filter(Boolean),
    [],
    'fixture config lock remains absent from the Git index',
  );
  return inventory;
}

function assertOwnedWorkspaceDescendant(candidate, ownedRoot, label) {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = `${path.resolve(ownedRoot)}${path.sep}`;
  assert.equal(normalizedCandidate.startsWith(normalizedRoot), true, `${label} stays within the test-owned workspace root`);
}

function isLinkOrReparsePoint(stat) {
  return stat.isSymbolicLink() || stat.isReparsePoint?.() === true;
}

function assertFixedFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, label) {
  const normalizedFixtureRoot = path.resolve(fixtureRoot);
  const normalizedAnalysisRoot = path.resolve(fixtureAnalysisRoot);
  assertOwnedWorkspaceDescendant(normalizedAnalysisRoot, normalizedFixtureRoot, label);
  assert.equal(path.relative(normalizedFixtureRoot, normalizedAnalysisRoot), analysisRootRelativePath, `${label} is the copied workspace's exact fixed analysis root`);
  return normalizedAnalysisRoot;
}

function removeFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, previousManifestPath) {
  const normalizedAnalysisRoot = assertFixedFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, 'analysis root reset cleanup');
  assertOwnedWorkspaceDescendant(previousManifestPath, normalizedAnalysisRoot, 'previous manifest reset cleanup');
  if (existsSync(normalizedAnalysisRoot)) rmSync(normalizedAnalysisRoot, { recursive: true, force: true });
  assert.equal(existsSync(normalizedAnalysisRoot), false, 'the reset removes only the copied fixed analysis root');
  assert.equal(existsSync(previousManifestPath), false, 'the reset removes the previous nonce-owned manifest leaf');
}

function assertRealFixtureDocs(fixtureDocs, label) {
  const stat = lstatSync(fixtureDocs);
  assert.equal(stat.isDirectory(), true, `${label} is a real directory`);
  assert.equal(isLinkOrReparsePoint(stat), false, `${label} is neither a symbolic link nor a reparse point`);
}

function restoreFixtureDocsAndRemoveExternalRoot({ fixtureDocs, renamedFixtureDocs, externalDocs, ownedRoot }) {
  assertOwnedWorkspaceDescendant(fixtureDocs, ownedRoot, 'fixture docs restore destination');
  assertOwnedWorkspaceDescendant(renamedFixtureDocs, ownedRoot, 'fixture docs restore backup');
  assertOwnedWorkspaceDescendant(externalDocs, ownedRoot, 'fixture external cleanup root');
  assert.equal(path.dirname(path.resolve(externalDocs)), path.resolve(ownedRoot), 'junction cleanup removes only the fixture external root');
  if (existsSync(renamedFixtureDocs)) {
    if (existsSync(fixtureDocs)) {
      assert.equal(isLinkOrReparsePoint(lstatSync(fixtureDocs)), true, 'only the test-installed docs junction is removed before restoring the backup');
      unlinkSync(fixtureDocs);
    }
    renameSync(renamedFixtureDocs, fixtureDocs);
  }
  assertRealFixtureDocs(fixtureDocs, 'fixture docs after junction cleanup');
  if (existsSync(externalDocs)) rmSync(externalDocs, { recursive: true, force: true });
  assert.equal(existsSync(renamedFixtureDocs), false, 'junction cleanup restores the original docs backup');
  assert.equal(existsSync(externalDocs), false, 'junction cleanup removes only the fixture external root');
}

function createOwnedWxRaceHarness() {
  const ownedRoot = mkdtempSync(path.join(tmpdir(), 'fair-readmission-wx-race-'));
  const preloaderPath = path.join(ownedRoot, 'wx-race-preloader.cjs');
  const guardPreloaderPath = path.join(ownedRoot, 'guard-before-mutation-preloader.cjs');
  const runnerPath = path.join(ownedRoot, 'wx-race-runner.mjs');
  try {
    writeFileSync(preloaderPath, wxRacePreloaderSource, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(guardPreloaderPath, guardBeforeMutationPreloaderSource, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(runnerPath, wxRaceRunnerSource, { encoding: 'utf8', flag: 'wx' });
    return Object.freeze({ ownedRoot, preloaderPath, guardPreloaderPath, runnerPath });
  } catch (error) {
    rmSync(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeOwnedWxRaceHarness(ownedRoot) {
  const normalizedRoot = path.resolve(ownedRoot);
  const normalizedTemp = `${path.resolve(tmpdir())}${path.sep}`;
  assert.equal(normalizedRoot.startsWith(normalizedTemp), true, 'wx-race harness cleanup stays within the OS temporary directory');
  assert.equal(path.basename(normalizedRoot).startsWith('fair-readmission-wx-race-'), true, 'wx-race harness cleanup targets only its mkdtemp root');
  rmSync(normalizedRoot, { recursive: true, force: true });
}

function wxRaceChildEnvironment({
  actor,
  manifestPath,
  phase,
  fault = 'none',
  collectorSourceUrl = collectorUrl,
  childWorkspaceRoot = workspaceRoot,
  guardAnalysisRoot = undefined,
}) {
  const environment = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    WAVE3_NATIVE_RACE_ACTOR: actor,
    WAVE3_NATIVE_RACE_COLLECTOR_URL: collectorSourceUrl,
    WAVE3_NATIVE_RACE_WORKSPACE_ROOT: childWorkspaceRoot,
    WAVE3_NATIVE_RACE_MANIFEST_PATH: manifestPath,
    WAVE3_NATIVE_RACE_PHASE: phase,
    WAVE3_NATIVE_RACE_TARGET: manifestPath,
    WAVE3_NATIVE_RACE_FAULT: fault,
    ...(guardAnalysisRoot === undefined ? {} : { WAVE3_NATIVE_RACE_ANALYSIS_ROOT: guardAnalysisRoot }),
  };
  assert.equal(Object.hasOwn(environment, 'NODE_OPTIONS'), false, 'child environment must scrub inherited NODE_OPTIONS rather than forwarding ambient preload state');
  return environment;
}

function spawnWxRaceChild({
  harness,
  actor,
  manifestPath,
  phase,
  preload,
  fault = 'none',
  timeline,
  preloaderPath = harness.preloaderPath,
  collectorSourceUrl = collectorUrl,
  childWorkspaceRoot = workspaceRoot,
  guardAnalysisRoot = undefined,
}) {
  const args = preload
    ? ['--require', preloaderPath, harness.runnerPath]
    : [harness.runnerPath];
  const child = spawn(process.execPath, args, {
    cwd: childWorkspaceRoot,
    env: wxRaceChildEnvironment({
      actor,
      manifestPath,
      phase,
      fault,
      collectorSourceUrl,
      childWorkspaceRoot,
      guardAnalysisRoot,
    }),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const transcript = [];
  let stdoutRemainder = '';
  let stderr = '';
  let exitState;
  let spawnError;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutRemainder += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutRemainder.indexOf('\n')) >= 0) {
      const line = stdoutRemainder.slice(0, newlineIndex);
      stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        transcript.push(event);
        timeline.push({ sequence: timeline.length, ...event });
      } catch (error) {
        transcript.push({ protocol: WX_RACE_PROTOCOL, actor, event: 'protocol-error', message: `${error.message}: ${line}` });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.once('error', error => {
    spawnError = error;
  });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      exitState = { code, signal };
      resolve(exitState);
    });
  });
  return {
    actor,
    child,
    transcript,
    exited,
    get stderr() { return stderr; },
    get exitState() { return exitState; },
    get spawnError() { return spawnError; },
    released: false,
  };
}

async function waitForWxRaceEvent(actor, event, label, timeoutMs = WX_RACE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (actor.spawnError) throw new Error(`${label} failed to spawn: ${actor.spawnError.message}`);
    const matched = actor.transcript.find(candidate => candidate.protocol === WX_RACE_PROTOCOL && candidate.actor === actor.actor && candidate.event === event);
    if (matched) return matched;
    const childError = actor.transcript.find(candidate => candidate.event === 'error' || candidate.event === 'protocol-error');
    if (childError) throw new Error(`${label} reported ${childError.message ?? childError.event}`);
    if (actor.exitState) throw new Error(`${label} exited before ${event}: ${JSON.stringify(actor.exitState)}\n${actor.stderr}`);
    await sleep(5);
  }
  throw new Error(`${label} timed out waiting for ${event}`);
}

async function waitForOneOfWxRaceEvents(actor, events, label, timeoutMs = WX_RACE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (actor.spawnError) throw new Error(`${label} failed to spawn: ${actor.spawnError.message}`);
    const matched = actor.transcript.find(candidate => candidate.protocol === WX_RACE_PROTOCOL
      && candidate.actor === actor.actor
      && events.includes(candidate.event));
    if (matched) return matched;
    const childError = actor.transcript.find(candidate => candidate.event === 'error' || candidate.event === 'protocol-error');
    if (childError) throw new Error(`${label} reported ${childError.message ?? childError.event}`);
    if (actor.exitState) throw new Error(`${label} exited before ${events.join(' or ')}: ${JSON.stringify(actor.exitState)}\n${actor.stderr}`);
    await sleep(5);
  }
  throw new Error(`${label} timed out waiting for ${events.join(' or ')}`);
}

async function waitForWxRaceExit(actor, label, timeoutMs = WX_RACE_TIMEOUT_MS) {
  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} did not exit after release`)), timeoutMs);
  });
  try {
    return await Promise.race([actor.exited, deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitForWxRaceTerminalEvent(actor, label, timeoutMs = WX_RACE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (actor.spawnError) throw new Error(`${label} failed to spawn: ${actor.spawnError.message}`);
    const terminal = actor.transcript.find(candidate => ['captured', 'error', 'protocol-error'].includes(candidate.event));
    if (terminal) return terminal;
    if (actor.exitState) throw new Error(`${label} exited without a terminal transcript: ${JSON.stringify(actor.exitState)}\n${actor.stderr}`);
    await sleep(5);
  }
  throw new Error(`${label} timed out waiting for a terminal transcript`);
}

function releaseWxRaceChild(actor, releaseByte) {
  if (actor.released) return;
  actor.released = true;
  assert.equal(actor.child.stdin.destroyed, false, 'the gated child stdin remains available for one controlled release byte');
  actor.child.stdin.end(Buffer.from([releaseByte]));
}

function transcriptIndex(timeline, actor, event) {
  const index = timeline.findIndex(candidate => candidate.actor === actor && candidate.event === event);
  assert.notEqual(index, -1, `missing transcript event ${actor}.${event}`);
  return index;
}

function actorTranscriptIndex(actor, event) {
  const index = actor.transcript.findIndex(candidate => candidate.event === event);
  assert.notEqual(index, -1, `missing child transcript event ${actor.actor}.${event}`);
  return index;
}

async function runNativeWorker() {
  const {
    controlBuffer,
    index,
    leaf,
    collectorUrl: workerCollectorUrl = collectorUrl,
    internalCoreUrl: workerInternalCoreUrl = internalCoreUrl,
    workspaceRoot: workerWorkspaceRoot = workspaceRoot,
    analysisRoot: workerAnalysisRoot = analysisRoot,
    phase: workerPhase = `internal-core-native-worker-${index}`,
  } = workerData;
  const control = new Int32Array(controlBuffer);
  try {
    await Promise.all([import(workerCollectorUrl), import(workerInternalCoreUrl)]);
    parentPort.postMessage({
      phase: 'ready',
      index,
      collectorUrl: workerCollectorUrl,
      internalCoreUrl: workerInternalCoreUrl,
      workspaceRoot: workerWorkspaceRoot,
      analysisRoot: workerAnalysisRoot,
    });
    Atomics.wait(control, 0, 0);
    const { captureFrozenProvenance } = await import(workerCollectorUrl);
    const manifest = captureFrozenProvenance({
      workspaceRoot: workerWorkspaceRoot,
      manifestPath: leaf,
      phase: workerPhase,
    });
    parentPort.postMessage({ phase: 'captured', index, leaf, sha256: manifest.protectedInput.sha256 });
  } catch (error) {
    parentPort.postMessage({ phase: 'error', index, message: error?.stack ?? error?.message ?? String(error) });
    process.exitCode = 1;
  }
}

if (!isMainThread && workerData?.kind === 'fair-readmission-internal-core-race') {
  await runNativeWorker();
} else {
  test('SDS-AC-1 and SDS-AC-2 derive one immutable manifest-bound root seed across independent minimal fixture roots', { timeout: 115_000 }, async () => {
    let firstFixture;
    let secondFixture;
    try {
      const firstDiscovery = await observeNativeRootDiscovery(() => createOwnedWorkspaceWithoutAnalysisParent());
      firstFixture = firstDiscovery.result;
      assert.equal(firstDiscovery.nativeProbeCount > 0, true, 'the first minimal fixture derives its seed through delegated native fresh probes');

      const secondDiscovery = await observeNativeRootDiscovery(() => createOwnedWorkspaceWithoutAnalysisParent());
      secondFixture = secondDiscovery.result;
      assert.equal(secondDiscovery.nativeProbeCount, 0, 'a second independent fixture reuses the one private root protected-input discovery instead of recapturing the worktree');
      assert.notEqual(firstFixture.ownedRoot, secondFixture.ownedRoot, 'each fixture still owns an independent temporary root');
      assert.notEqual(firstFixture.fixtureRoot, secondFixture.fixtureRoot, 'each fixture still owns an independent workspace root');
      assertMinimalNativeFixtureParity(firstFixture);
      assertMinimalNativeFixtureParity(secondFixture);
      assert.deepEqual(firstFixture.protectedFiles, secondFixture.protectedFiles, 'independent fixtures receive the same immutable protected-input seed metadata');
      for (const file of firstFixture.protectedFiles) {
        assert.match(file.sha256, /^[a-f0-9]{64}$/i, `protected fixture seed records the captured manifest SHA-256: ${file.path}`);
        const fixturePath = path.join(firstFixture.fixtureRoot, assertFixtureRelativePath(file.path, 'protected fixture seed path'));
        assert.equal(sha256Bytes(readFileSync(fixturePath)), file.sha256, `fixture bytes remain bound to the seed manifest SHA-256: ${file.path}`);
      }
    } finally {
      if (secondFixture) removeOwnedWorkspace(secondFixture.ownedRoot);
      if (firstFixture) removeOwnedWorkspace(firstFixture.ownedRoot);
    }
  });

  test('SDS-AC-1 rejects root source drift before a cached protected-input seed can publish a stale fixture', { timeout: 115_000 }, async () => {
    let baselineFixture;
    try {
      baselineFixture = await createOwnedWorkspaceWithoutAnalysisParent();
      assertMinimalNativeFixtureParity(baselineFixture);
      await assert.rejects(
        () => withSyntheticRootSourceDrift('server/package.json', () => createOwnedWorkspaceWithoutAnalysisParent()),
        /protected fixture bytes match|source manifest input|seed|sha-?256|parity/i,
        'root source drift after seed discovery must reject rather than create a fixture from a stale protected-input seed',
      );
    } finally {
      if (baselineFixture) removeOwnedWorkspace(baselineFixture.ownedRoot);
    }
  });

  test('SDS-AC-1 rejects root source drift after byte copy and independent fixture Git setup before return', { timeout: 115_000 }, async () => {
    let baselineFixture;
    try {
      baselineFixture = await createOwnedWorkspaceWithoutAnalysisParent();
      assertMinimalNativeFixtureParity(baselineFixture);
      await assert.rejects(
        () => withPostCopySyntheticRootSourceDrift('server/package.json', () => createOwnedWorkspaceWithoutAnalysisParent()),
        /protected fixture bytes match|source manifest input|seed|sha-?256|parity/i,
        'root source drift that starts after the pre-copy source check must reject before the fixture can return',
      );
    } finally {
      if (baselineFixture) removeOwnedWorkspace(baselineFixture.ownedRoot);
    }
  });

  test('SDS-AC-1 requires the native race fixture to exclude copied worktree payload while preserving independent Git parity', { timeout: 115_000 }, async () => {
    const { ownedRoot, fixtureRoot } = await createOwnedWorkspaceWithoutAnalysisParent();
    try {
      assertMinimalNativeFixtureParity({ fixtureRoot });
    } finally {
      removeOwnedWorkspace(ownedRoot);
    }
  });

  test('SDS-AC-1 fails normal closed capture when a protected minimal-fixture input is absent instead of falling back to the worktree', { timeout: 115_000 }, async () => {
    const { ownedRoot, fixtureRoot } = await createOwnedWorkspaceWithoutAnalysisParent();
    const fixtureAnalysisRoot = path.join(fixtureRoot, analysisRootRelativePath);
    const manifestPath = path.join(fixtureAnalysisRoot, 'missing-protected-input.json');
    try {
      unlinkSync(path.join(fixtureRoot, 'server', 'package.json'));
      const { captureFrozenProvenance } = await import(pathToFileURL(path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs')).href);
      assert.throws(
        () => captureFrozenProvenance({ workspaceRoot: fixtureRoot, manifestPath, phase: 'minimal-fixture-missing-protected-input' }),
        /missing config_lock|server[\\/]package\.json|ENOENT/i,
        'fixture capture must fail from its own missing protected file and never resolve a worktree fallback',
      );
      assert.equal(existsSync(manifestPath), false, 'a missing protected fixture input publishes no fallback manifest');
    } finally {
      removeOwnedWorkspace(ownedRoot);
    }
  });

  test('SDS-AC-1 and SDS-AC-3 create an absent fixed analysis parent only after fresh native guard probes at manifest boundaries, then serially reset the fixture for junction admission', { timeout: 115_000 }, async t => {
    const fixture = await createOwnedWorkspaceWithoutAnalysisParent();
    const { ownedRoot, fixtureRoot } = fixture;
    const harness = createOwnedWxRaceHarness();
    const fixtureDocs = path.join(fixtureRoot, 'docs');
    const renamedFixtureDocs = path.join(ownedRoot, 'docs-before-guard-junction');
    const externalDocs = path.join(ownedRoot, 'external-docs');
    const fixtureAnalysisRoot = path.join(fixtureRoot, analysisRootRelativePath);
    const fixtureCollectorUrl = pathToFileURL(path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs')).href;
    const firstManifestPrefix = `missing-parent-first-capture-${process.pid}-${randomBytes(6).toString('hex')}`;
    const firstManifestPath = path.join(fixtureAnalysisRoot, `${firstManifestPrefix}.json`);
    try {
      await t.test('SDS-AC-1 and SDS-AC-3 create an absent fixed analysis parent only after fresh native guard probes at manifest boundaries', async () => {
        const timeline = [];
        let actorGuard;
        try {
          assert.equal(existsSync(fixtureAnalysisRoot), false, 'the copied workspace starts with the fixed analysis parent absent');
          actorGuard = spawnWxRaceChild({
            harness,
            actor: 'G',
            manifestPath: firstManifestPath,
            phase: 'internal-core-missing-parent-first-capture',
            preload: true,
            preloaderPath: harness.guardPreloaderPath,
            collectorSourceUrl: fixtureCollectorUrl,
            childWorkspaceRoot: fixtureRoot,
            guardAnalysisRoot: fixtureAnalysisRoot,
            timeline,
          });
          await waitForWxRaceEvent(actorGuard, 'initial-lstat-missing', 'guarded initial missing analysis lstat');
          releaseWxRaceChild(actorGuard, 0x52);
          const terminal = await waitForWxRaceTerminalEvent(actorGuard, 'guarded missing-parent capture');
          assert.equal(terminal.event, 'captured', `the owned missing parent capture must succeed after its guard release; transcript=${JSON.stringify(actorGuard.transcript)}`);
          assert.deepEqual(await waitForWxRaceExit(actorGuard, 'guarded missing-parent capture'), { code: 0, signal: null });
          assert.equal(existsSync(fixtureAnalysisRoot), true, 'first capture creates only its fixed analysis parent');
          assert.equal(existsSync(firstManifestPath), true, 'first capture writes its requested fixed manifest leaf after parent creation');
          assert.equal(JSON.parse(readFileSync(firstManifestPath, 'utf8')).protectedInput.sha256, terminal.sha256);
          const mkdirIndexes = actorGuard.transcript
            .map((candidate, index) => candidate.event === 'mkdir' ? index : -1)
            .filter(index => index >= 0);
          assert.equal(mkdirIndexes.length, 2, 'native capture mutates the fixed parent once during admission and once during its private manifest write path');
          const openIndex = actorTranscriptIndex(actorGuard, 'open');
          assert.equal(mkdirIndexes[1] < openIndex, true, 'the private manifest parent boundary precedes exclusive create');
          const freshProbesAfterPrivateParentBoundary = actorGuard.transcript
            .slice(mkdirIndexes[1] + 1, openIndex)
            .filter(candidate => candidate.event === 'manifest-probe' && candidate.containsAnalysisRoot);
          assert.equal(freshProbesAfterPrivateParentBoundary.length > 0, true, 'the same-identity cached manifest parent must be native-probed again after the private parent boundary and before exclusive create');
        } finally {
          if (actorGuard && !actorGuard.released && !actorGuard.exitState) releaseWxRaceChild(actorGuard, 0x52);
          await Promise.allSettled([actorGuard?.exited].filter(Boolean));
          if (actorGuard) assert.notEqual(actorGuard.exitState, undefined, 'the first gated child exits before the shared fixture resets');
          removeFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, firstManifestPath);
        }
      });

      await t.test('SDS-AC-1 rejects a swapped docs junction before any missing analysis parent mutation', async () => {
        const externalAnalysisRoot = path.join(externalDocs, path.relative('docs', analysisRootRelativePath));
        const manifestPath = path.join(fixtureAnalysisRoot, 'guard-before-mutation.json');
        const timeline = [];
        let actorGuard;
        try {
          assert.equal(existsSync(fixtureAnalysisRoot), false, 'the reset leaves the copied fixed analysis parent absent before the junction case');
          assert.equal(existsSync(firstManifestPath), false, 'the reset leaves the previous nonce-owned manifest absent before the junction case');
          assertOwnedWorkspaceDescendant(fixtureDocs, ownedRoot, 'fixture docs swap source');
          assertOwnedWorkspaceDescendant(renamedFixtureDocs, ownedRoot, 'fixture docs swap backup');
          assertOwnedWorkspaceDescendant(externalDocs, ownedRoot, 'external junction target');
          assertOwnedWorkspaceDescendant(fixtureAnalysisRoot, ownedRoot, 'guarded fixture analysis root');
          assertOwnedWorkspaceDescendant(externalAnalysisRoot, ownedRoot, 'observed external analysis root');
          assertRealFixtureDocs(fixtureDocs, 'fixture docs before controlled junction swap');
          actorGuard = spawnWxRaceChild({
            harness,
            actor: 'G',
            manifestPath,
            phase: 'internal-core-guard-before-mutation',
            preload: true,
            preloaderPath: harness.guardPreloaderPath,
            collectorSourceUrl: fixtureCollectorUrl,
            childWorkspaceRoot: fixtureRoot,
            guardAnalysisRoot: fixtureAnalysisRoot,
            timeline,
          });
          await waitForWxRaceEvent(actorGuard, 'initial-lstat-missing', 'guarded initial missing analysis lstat');
          assert.equal(existsSync(externalAnalysisRoot), false, 'the external junction target is untouched before the controlled docs swap');
          renameSync(fixtureDocs, renamedFixtureDocs);
          mkdirSync(externalDocs, { recursive: true });
          symlinkSync(externalDocs, fixtureDocs, 'junction');
          releaseWxRaceChild(actorGuard, 0x52);

          const terminal = await waitForWxRaceTerminalEvent(actorGuard, 'guard-before-mutation capture');
          assert.equal(terminal.event, 'error', `the swapped docs junction must reject during a later reparse guard; transcript=${JSON.stringify(actorGuard.transcript)}`);
          assert.match(terminal.message, /reparse|link|manifest path/i);
          assert.deepEqual(await waitForWxRaceExit(actorGuard, 'guard-before-mutation capture'), { code: 1, signal: null });
          assert.equal(transcriptIndex(timeline, 'G', 'initial-lstat-missing') < transcriptIndex(timeline, 'G', 'release'), true, 'the parent swaps only after the initial missing analysis lstat is gated');
          assert.deepEqual(
            [
              actorGuard.transcript.some(candidate => candidate.event === 'mkdir'),
              existsSync(externalAnalysisRoot),
            ],
            [false, false],
            'the reparse guard must reject before recursive parent creation can mutate the external junction target',
          );
        } finally {
          if (actorGuard && !actorGuard.released && !actorGuard.exitState) releaseWxRaceChild(actorGuard, 0x52);
          await Promise.allSettled([actorGuard?.exited].filter(Boolean));
          restoreFixtureDocsAndRemoveExternalRoot({ fixtureDocs, renamedFixtureDocs, externalDocs, ownedRoot });
        }
      });

      await t.test('SDS-AC-4 proves sibling native capture completes between A retained-fd write and postflight without a collector test mode', async () => {
        const prefix = `fixture-wx-sibling-${process.pid}-${randomBytes(6).toString('hex')}`;
        const leafA = path.join(fixtureAnalysisRoot, `${prefix}-a.json`);
        const leafB = path.join(fixtureAnalysisRoot, `${prefix}-b.json`);
        const timeline = [];
        let actorA;
        let actorB;
        try {
          assert.equal(existsSync(fixtureAnalysisRoot), false, 'the serial fixture reset leaves the fixed analysis parent absent before the sibling race');
          assert.equal(existsSync(leafA), false, 'A starts with an absent nonce-owned target leaf');
          assert.equal(existsSync(leafB), false, 'B starts with an absent distinct nonce-owned sibling leaf');
          actorA = spawnWxRaceChild({
            harness,
            actor: 'A',
            manifestPath: leafA,
            phase: 'fixture-wx-sibling-a',
            preload: true,
            collectorSourceUrl: fixtureCollectorUrl,
            childWorkspaceRoot: fixtureRoot,
            timeline,
          });
          await waitForWxRaceEvent(actorA, 'open', 'A retained-fd open');
          await waitForWxRaceEvent(actorA, 'fd-write', 'A retained-fd write gate');
          actorB = spawnWxRaceChild({
            harness,
            actor: 'B',
            manifestPath: leafB,
            phase: 'fixture-wx-sibling-b',
            preload: false,
            collectorSourceUrl: fixtureCollectorUrl,
            childWorkspaceRoot: fixtureRoot,
            timeline,
          });
          await waitForWxRaceEvent(actorB, 'captured', 'B sibling capture');
          assert.equal(actorA.transcript.some(candidate => candidate.event === 'release' || candidate.event === 'captured'), false, 'A remains blocked after the delegated retained-fd write before postflight while B completes');

          releaseWxRaceChild(actorA, 0x52);
          await waitForWxRaceEvent(actorA, 'release', 'A controlled release');
          await waitForWxRaceEvent(actorA, 'fstat', 'A retained-fd fstat');
          await waitForWxRaceEvent(actorA, 'postflight', 'A retained-fd postflight');
          await waitForWxRaceEvent(actorA, 'close', 'A retained-fd close');
          await waitForWxRaceEvent(actorA, 'captured', 'A postflight capture');
          const [exitA, exitB] = await Promise.all([
            waitForWxRaceExit(actorA, 'A sibling capture'),
            waitForWxRaceExit(actorB, 'B sibling capture'),
          ]);
          assert.deepEqual(exitA, { code: 0, signal: null }, `A must succeed after permitted sibling timestamp churn\n${actorA.stderr}`);
          assert.deepEqual(exitB, { code: 0, signal: null }, `B must complete its native sibling capture\n${actorB.stderr}`);
          assert.equal(transcriptIndex(timeline, 'A', 'open') < transcriptIndex(timeline, 'A', 'fd-write'), true, 'A opens the nonce leaf before it writes through the retained descriptor');
          assert.equal(transcriptIndex(timeline, 'A', 'fd-write') < transcriptIndex(timeline, 'B', 'captured'), true, 'B capture begins only after A has completed the delegated descriptor write');
          assert.equal(transcriptIndex(timeline, 'B', 'captured') < transcriptIndex(timeline, 'A', 'release'), true, 'B preflight/write/postflight completes while A remains gated');
          assert.equal(transcriptIndex(timeline, 'A', 'release') < transcriptIndex(timeline, 'A', 'captured'), true, 'A postflight can only occur after the explicit release');
          assert.equal(transcriptIndex(timeline, 'A', 'fd-write') < transcriptIndex(timeline, 'A', 'fstat'), true, 'the retained descriptor is written before its identity is sampled');
          assert.equal(transcriptIndex(timeline, 'A', 'fstat') < transcriptIndex(timeline, 'A', 'postflight'), true, 'the retained descriptor identity is checked before pathname postflight');
          assert.equal(transcriptIndex(timeline, 'A', 'postflight') < transcriptIndex(timeline, 'A', 'close'), true, 'postflight finishes before the retained descriptor is closed');
          assert.equal(actorA.transcript.filter(candidate => candidate.event === 'close').length, 1, 'the successful retained descriptor closes exactly once');
          assert.equal(actorA.transcript.some(candidate => candidate.event === 'path-write-bypass' || candidate.event === 'pathname-read-before-postflight' || candidate.event === 'target-lstat-before-fstat' || candidate.event === 'fstat-before-fd-write'), false, 'the successful path never falls back to a target pathname write/read or premature identity/postflight probe');
          assert.equal(JSON.parse(readFileSync(leafA, 'utf8')).phase, 'fixture-wx-sibling-a');
          assert.equal(JSON.parse(readFileSync(leafB, 'utf8')).phase, 'fixture-wx-sibling-b');
        } finally {
          if (actorA && !actorA.released && !actorA.exitState) releaseWxRaceChild(actorA, 0x52);
          await Promise.allSettled([actorA?.exited, actorB?.exited].filter(Boolean));
          for (const leaf of [leafA, leafB]) assertOwnedWorkspaceDescendant(leaf, fixtureAnalysisRoot, 'fixture sibling manifest leaf cleanup');
          removeFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, leafA);
          for (const leaf of [leafA, leafB]) assert.equal(existsSync(leaf), false, 'serial fixture reset removes every sibling-owned fixture leaf');
          assertMinimalNativeFixtureParity({ fixtureRoot, protectedFiles: fixture.protectedFiles });
        }
      });
    } finally {
      removeOwnedWxRaceHarness(harness.ownedRoot);
      removeOwnedWorkspace(ownedRoot);
    }
  });

  test('SDS-AC-3 runs both native barrier workers only through one owned fixture collector and resets its analysis root', { timeout: 115_000 }, async () => {
    const { ownedRoot, fixtureRoot } = await createOwnedWorkspaceWithoutAnalysisParent();
    const fixtureAnalysisRoot = path.join(fixtureRoot, analysisRootRelativePath);
    const fixtureCollectorUrl = pathToFileURL(path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs')).href;
    const fixtureInternalCoreUrl = pathToFileURL(path.join(fixtureRoot, 'tools', 'wave3', 'internal', 'fair-readmission-closure-v3-internal-core.mjs')).href;
    const prefix = `fixture-native-worker-${process.pid}-${randomBytes(6).toString('hex')}`;
    const leaves = [
      path.join(fixtureAnalysisRoot, `${prefix}-first.json`),
      path.join(fixtureAnalysisRoot, `${prefix}-second.json`),
    ];
    const originalRootLeaves = leaves.map(leaf => path.join(analysisRoot, path.basename(leaf)));
    const messages = [];
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const workers = leaves.map((leaf, index) => new Worker(new URL(import.meta.url), {
      workerData: {
        kind: 'fair-readmission-internal-core-race',
        controlBuffer: control.buffer,
        index,
        leaf,
        collectorUrl: fixtureCollectorUrl,
        internalCoreUrl: fixtureInternalCoreUrl,
        workspaceRoot: fixtureRoot,
        analysisRoot: fixtureAnalysisRoot,
        phase: `fixture-native-worker-${index}`,
      },
    }));
    const exits = workers.map(worker => new Promise(resolve => {
      worker.on('message', message => messages.push(message));
      worker.once('error', error => messages.push({ phase: 'worker-error', message: error?.stack ?? error?.message ?? String(error) }));
      worker.once('exit', code => resolve(code));
    }));

    try {
      assert.equal(existsSync(fixtureAnalysisRoot), false, 'the serial fixture worker scenario starts with an absent fixture analysis root');
      for (const leaf of leaves) assertOwnedWorkspaceDescendant(leaf, fixtureRoot, 'fixture worker manifest leaf');
      for (const leaf of originalRootLeaves) assertOwnedLeaf(leaf, prefix);
      await waitForReadyMessages(messages, workers.length);
      assert.deepEqual(
        messages.filter(message => message.phase === 'ready').map(message => ({
          index: message.index,
          collectorUrl: message.collectorUrl,
          internalCoreUrl: message.internalCoreUrl,
          workspaceRoot: message.workspaceRoot,
          analysisRoot: message.analysisRoot,
        })).sort((left, right) => left.index - right.index),
        leaves.map((_, index) => ({
          index,
          collectorUrl: fixtureCollectorUrl,
          internalCoreUrl: fixtureInternalCoreUrl,
          workspaceRoot: fixtureRoot,
          analysisRoot: fixtureAnalysisRoot,
        })),
        'each worker proves it imported only the fixture collector/internal core and owns the fixture workspace/analysis root',
      );
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);

      assert.deepEqual(await Promise.all(exits), [0, 0], 'both fixture-bound native workers must exit successfully after the barrier release');
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'fixture-bound worker errors remain surfaced and empty');
      assert.equal(messages.filter(message => message.phase === 'captured').length, workers.length, 'each fixture-bound worker captures after the message barrier release');
      for (const [index, leaf] of leaves.entries()) {
        const manifest = JSON.parse(readFileSync(leaf, 'utf8'));
        assert.equal(manifest.phase, `fixture-native-worker-${index}`);
        assert.equal(manifest.protectedInput.value.collector.sha256, sha256Bytes(readFileSync(path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs'))), 'fixture worker manifest records the fixture collector bytes');
      }
      for (const leaf of originalRootLeaves) assert.equal(existsSync(leaf), false, 'the worker must never publish its fixture manifest in the original workspace');
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);
      await Promise.allSettled(exits);
      removeFixtureAnalysisRoot(fixtureRoot, fixtureAnalysisRoot, leaves[0]);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'serial fixture reset removes every worker-owned fixture leaf');
      for (const leaf of originalRootLeaves) removeOwnedLeaf(leaf, prefix);
      removeOwnedWorkspace(ownedRoot);
    }
  });

  test('SDS-AC-4 awaits two ready messages before native sibling capture release, surfaces errors, and cleans owned leaves', { timeout: 115_000 }, async () => {
    const prefix = `internal-core-race-${process.pid}-${randomBytes(6).toString('hex')}`;
    const leaves = [
      path.join(analysisRoot, `${prefix}-first.json`),
      path.join(analysisRoot, `${prefix}-second.json`),
    ];
    const messages = [];
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const workers = leaves.map((leaf, index) => new Worker(new URL(import.meta.url), {
      workerData: { kind: 'fair-readmission-internal-core-race', controlBuffer: control.buffer, index, leaf },
    }));
    const exits = workers.map(worker => new Promise(resolve => {
      worker.on('message', message => messages.push(message));
      worker.once('error', error => messages.push({ phase: 'worker-error', message: error?.stack ?? error?.message ?? String(error) }));
      worker.once('exit', code => resolve(code));
    }));

    try {
      await waitForReadyMessages(messages, workers.length);
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'no worker error is hidden before release');
      assert.deepEqual(messages.filter(message => message.phase === 'ready').map(message => message.index).sort(), [0, 1], 'each worker must report readiness before either writes');
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);

      assert.deepEqual(await Promise.all(exits), [0, 0], 'both native workers must exit successfully');
      assert.deepEqual(messages.filter(message => message.phase === 'error' || message.phase === 'worker-error'), [], 'all post-release worker errors are surfaced');
      assert.equal(messages.filter(message => message.phase === 'captured').length, workers.length, 'each worker must capture after the message barrier release');
      assert.equal(new Set(leaves.map(leaf => path.resolve(leaf))).size, workers.length, 'workers use distinct sibling leaves');
      for (const [index, leaf] of leaves.entries()) {
        assert.equal(JSON.parse(readFileSync(leaf, 'utf8')).phase, `internal-core-native-worker-${index}`);
      }
    } finally {
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0, workers.length);
      await Promise.allSettled(exits);
      for (const leaf of leaves) removeOwnedLeaf(leaf, prefix);
      for (const leaf of leaves) assert.equal(existsSync(leaf), false, 'creator-owned cleanup removes every test leaf');
    }
  });

  test('SDS-AC-3 distinguishes the guarded postwrite probe from final leaf identity observation during same-byte replacement', { timeout: 115_000 }, async () => {
    const harness = createOwnedWxRaceHarness();
    const prefix = `wx-replacement-${process.pid}-${randomBytes(6).toString('hex')}`;
    const leafA = path.join(analysisRoot, `${prefix}-a.json`);
    const timeline = [];
    let actorA;
    try {
      assert.equal(existsSync(leafA), false, 'A starts with an absent nonce-owned target leaf');
      actorA = spawnWxRaceChild({
        harness,
        actor: 'A',
        manifestPath: leafA,
        phase: 'internal-core-wx-replacement-a',
        preload: true,
        fault: 'replacement',
        timeline,
      });
      await waitForWxRaceEvent(actorA, 'open', 'A replacement retained-fd open');
      await waitForWxRaceEvent(actorA, 'fd-write', 'A replacement retained-fd write gate');
      await waitForWxRaceEvent(actorA, 'fstat', 'A replacement retained-fd fstat');
      await waitForWxRaceEvent(actorA, 'guarded-postwrite-probe', 'A guarded postwrite target probe');
      await waitForWxRaceEvent(actorA, 'guarded-postwrite-probe-complete', 'A completed guarded postwrite target probe');
      releaseWxRaceChild(actorA, 0x58);
      const replacement = await waitForOneOfWxRaceEvents(actorA, ['replacement-blocked', 'replaced', 'replacement-partial'], 'A same-byte replacement result');
      await waitForWxRaceEvent(actorA, 'release', 'A replacement release');
      const terminal = await waitForWxRaceTerminalEvent(actorA, 'A replacement capture');
      const finalLeafIdentity = replacement.event === 'replacement-partial'
        ? undefined
        : await waitForWxRaceEvent(actorA, 'final-leaf-identity-observation', 'A final leaf identity observation');
      await waitForWxRaceEvent(actorA, 'postflight', 'A replacement retained-fd postflight');
      await waitForWxRaceEvent(actorA, 'close', 'A replacement retained-fd close');
      if (replacement.event === 'replacement-blocked') {
        assert.equal(terminal.event, 'captured', `an OS-blocked replacement keeps the original manifest eligible for acceptance; transcript=${JSON.stringify(actorA.transcript)}`);
        assert.equal(JSON.parse(readFileSync(leafA, 'utf8')).phase, 'internal-core-wx-replacement-a');
        assert.deepEqual(await waitForWxRaceExit(actorA, 'A blocked replacement capture'), { code: 0, signal: null });
      } else {
        assert.equal(terminal.event, 'error', `a same-byte swapped or partially swapped leaf must reject before manifest acceptance; transcript=${JSON.stringify(actorA.transcript)}`);
        assert.match(terminal.message, /manifest|leaf|identity|replacement|postflight|changed|missing/i);
        assert.equal(actorA.transcript.some(candidate => candidate.event === 'captured'), false, 'a swapped leaf must never reach accepted capture output');
        assert.deepEqual(await waitForWxRaceExit(actorA, 'A replacement capture'), { code: 1, signal: null });
      }
      assert.equal(transcriptIndex(timeline, 'A', 'open') < transcriptIndex(timeline, 'A', 'fd-write'), true);
      assert.equal(transcriptIndex(timeline, 'A', 'fd-write') < transcriptIndex(timeline, 'A', 'fstat'), true);
      assert.equal(transcriptIndex(timeline, 'A', 'fstat') < transcriptIndex(timeline, 'A', 'guarded-postwrite-probe'), true, 'the first target lstat after retained-fd fstat is the guarded postwrite probe');
      assert.equal(transcriptIndex(timeline, 'A', 'guarded-postwrite-probe') < transcriptIndex(timeline, 'A', 'guarded-postwrite-probe-complete'), true, 'the guarded postwrite probe completes before replacement is released');
      assert.equal(transcriptIndex(timeline, 'A', 'guarded-postwrite-probe-complete') < transcriptIndex(timeline, 'A', replacement.event), true, 'same-byte replacement begins only after the guard has completed its postwrite target probe');
      assert.equal(transcriptIndex(timeline, 'A', replacement.event) < transcriptIndex(timeline, 'A', 'release'), true);
      if (finalLeafIdentity) {
        assert.equal(transcriptIndex(timeline, 'A', 'release') < transcriptIndex(timeline, 'A', 'final-leaf-identity-observation'), true, 'the later final leaf identity observation occurs only after the replacement attempt');
        assert.equal(transcriptIndex(timeline, 'A', 'final-leaf-identity-observation') < transcriptIndex(timeline, 'A', 'close'), true, 'the final leaf identity observation precedes retained descriptor cleanup');
      }
      assert.equal(actorA.transcript.filter(candidate => candidate.event === 'close').length, 1, 'the replacement run closes its retained descriptor exactly once');
      assert.equal(actorA.transcript.some(candidate => candidate.event === 'path-write-bypass' || candidate.event === 'pathname-read-before-postflight' || candidate.event === 'target-lstat-before-fstat' || candidate.event === 'fstat-before-fd-write'), false, 'replacement handling keeps the security-sensitive write and identity sequence on the retained descriptor');
    } finally {
      if (actorA && !actorA.released && !actorA.exitState) releaseWxRaceChild(actorA, 0x52);
      await Promise.allSettled([actorA?.exited].filter(Boolean));
      removeOwnedLeaf(leafA, prefix);
      removeOwnedWxRaceHarness(harness.ownedRoot);
    }
  });

  test('SDS-AC-2 closes every acquired retained descriptor exactly once across write and postflight failures, and never closes an EEXIST non-descriptor', { timeout: 115_000 }, async () => {
    const harness = createOwnedWxRaceHarness();
    const prefix = `fd-lifecycle-${process.pid}-${randomBytes(6).toString('hex')}`;
    const existingLeaf = path.join(analysisRoot, `${prefix}-eexist.json`);
    const writeLeaf = path.join(analysisRoot, `${prefix}-write.json`);
    const postflightLeaf = path.join(analysisRoot, `${prefix}-postflight.json`);
    const timeline = [];
    let actorExisting;
    let actorWrite;
    let actorPostflight;
    try {
      const existingBytes = Buffer.from('{"already":"exists"}\n');
      writeFileSync(existingLeaf, existingBytes, { flag: 'wx' });
      actorExisting = spawnWxRaceChild({
        harness,
        actor: 'A',
        manifestPath: existingLeaf,
        phase: 'internal-core-fd-eexist',
        preload: true,
        fault: 'eexist',
        timeline,
      });
      actorWrite = spawnWxRaceChild({
        harness,
        actor: 'A',
        manifestPath: writeLeaf,
        phase: 'internal-core-fd-write-failure',
        preload: true,
        fault: 'write-failure',
        timeline,
      });
      actorPostflight = spawnWxRaceChild({
        harness,
        actor: 'A',
        manifestPath: postflightLeaf,
        phase: 'internal-core-fd-postflight-failure',
        preload: true,
        fault: 'postflight-failure',
        timeline,
      });

      await Promise.all([
        waitForWxRaceEvent(actorExisting, 'open-eexist', 'EEXIST retained-fd open'),
        waitForWxRaceEvent(actorWrite, 'open', 'write-failure retained-fd open'),
        waitForWxRaceEvent(actorWrite, 'fd-write', 'write-failure delegated retained-fd write'),
        waitForWxRaceEvent(actorWrite, 'write-failure', 'write-failure injection'),
        waitForWxRaceEvent(actorPostflight, 'open', 'postflight-failure retained-fd open'),
        waitForWxRaceEvent(actorPostflight, 'fd-write', 'postflight-failure retained-fd write gate'),
      ]);
      releaseWxRaceChild(actorPostflight, 0x50);
      await Promise.all([
        waitForWxRaceEvent(actorPostflight, 'fstat', 'postflight-failure retained-fd fstat'),
        waitForWxRaceEvent(actorPostflight, 'postflight-failure', 'postflight-failure injection'),
        waitForWxRaceEvent(actorWrite, 'close', 'write-failure retained-fd close'),
        waitForWxRaceEvent(actorPostflight, 'close', 'postflight-failure retained-fd close'),
      ]);

      const [existingTerminal, writeTerminal, postflightTerminal] = await Promise.all([
        waitForWxRaceTerminalEvent(actorExisting, 'EEXIST retained-fd failure'),
        waitForWxRaceTerminalEvent(actorWrite, 'write retained-fd failure'),
        waitForWxRaceTerminalEvent(actorPostflight, 'postflight retained-fd failure'),
      ]);
      assert.deepEqual([existingTerminal.event, writeTerminal.event, postflightTerminal.event], ['error', 'error', 'error']);
      assert.match(existingTerminal.message, /EEXIST|exist/i);
      assert.match(writeTerminal.message, /retained-fd write failure/i);
      assert.match(postflightTerminal.message, /retained-fd postflight failure/i);
      assert.equal(actorExisting.transcript.filter(candidate => candidate.event === 'close').length, 0, 'EEXIST returns no retained descriptor to close');
      assert.deepEqual(readFileSync(existingLeaf), existingBytes, 'an actual wx EEXIST collision preserves the pre-existing target bytes');
      assert.equal(actorWrite.transcript.filter(candidate => candidate.event === 'close').length, 1, 'a retained descriptor closes once after write failure');
      assert.equal(actorPostflight.transcript.filter(candidate => candidate.event === 'close').length, 1, 'a retained descriptor closes once after postflight failure');
      assert.equal(actorTranscriptIndex(actorPostflight, 'fd-write') < actorTranscriptIndex(actorPostflight, 'fstat'), true, 'the postflight failure first writes and samples the retained descriptor');
      assert.equal(actorWrite.transcript.some(candidate => candidate.event === 'path-write-bypass' || candidate.event === 'pathname-read-before-postflight' || candidate.event === 'fstat-before-fd-write'), false, 'write failure occurs through the retained descriptor before any pathname fallback or premature identity probe');
      assert.equal(actorPostflight.transcript.some(candidate => candidate.event === 'path-write-bypass' || candidate.event === 'pathname-read-before-postflight' || candidate.event === 'target-lstat-before-fstat' || candidate.event === 'fstat-before-fd-write'), false, 'postflight failure occurs only after the retained descriptor identity check');
      assert.deepEqual(await Promise.all([
        waitForWxRaceExit(actorExisting, 'EEXIST retained-fd failure'),
        waitForWxRaceExit(actorWrite, 'write retained-fd failure'),
        waitForWxRaceExit(actorPostflight, 'postflight retained-fd failure'),
      ]), [
        { code: 1, signal: null },
        { code: 1, signal: null },
        { code: 1, signal: null },
      ]);
    } finally {
      if (actorPostflight && !actorPostflight.released && !actorPostflight.exitState) releaseWxRaceChild(actorPostflight, 0x52);
      await Promise.allSettled([actorExisting?.exited, actorWrite?.exited, actorPostflight?.exited].filter(Boolean));
      removeOwnedLeaf(existingLeaf, prefix);
      removeOwnedLeaf(writeLeaf, prefix);
      removeOwnedLeaf(postflightLeaf, prefix);
      removeOwnedWxRaceHarness(harness.ownedRoot);
    }
  });
}

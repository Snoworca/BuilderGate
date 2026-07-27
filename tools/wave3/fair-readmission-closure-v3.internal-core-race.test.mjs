import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

const wxRacePreloaderSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const actor = process.env.WAVE3_NATIVE_RACE_ACTOR;
const suppliedTarget = process.env.WAVE3_NATIVE_RACE_TARGET;
if (actor !== 'A' || typeof suppliedTarget !== 'string' || suppliedTarget.length === 0) {
  throw new Error('wx race preloader requires one exact A target');
}
const target = path.resolve(suppliedTarget);
const originalWriteFileSync = fs.writeFileSync;
let intercepted = false;

function emit(event, extra) {
  fs.writeSync(1, JSON.stringify(Object.assign({
    protocol: 'fair-readmission-wx-race-v1',
    actor,
    event,
  }, extra || {})) + '\\n');
}

fs.writeFileSync = function writeNonceTargetThenGate(candidate, data, options) {
  const result = originalWriteFileSync.apply(fs, arguments);
  const matchesExactWxTarget = !intercepted
    && typeof candidate === 'string'
    && path.resolve(candidate) === target
    && options !== null
    && typeof options === 'object'
    && options.flag === 'wx';
  if (!matchesExactWxTarget) return result;

  intercepted = true;
  try {
    emit('wx');
    const release = Buffer.alloc(1);
    if (fs.readSync(0, release, 0, 1, null) !== 1) {
      throw new Error('wx race preloader did not receive a release byte');
    }
    if (release[0] === 0x58) {
      const current = fs.lstatSync(target);
      if (!current.isFile() || current.isSymbolicLink?.() || current.isReparsePoint?.()) {
        throw new Error('wx race preloader target stopped being an owned regular file');
      }
      fs.unlinkSync(target);
      originalWriteFileSync.call(fs, target, '{"replacement":"owned"}\\n', { encoding: 'utf8', flag: 'wx' });
      emit('replaced');
    } else if (release[0] !== 0x52) {
      throw new Error('wx race preloader received an invalid release byte');
    }
    emit('release');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
  }
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
  if (!['A', 'B'].includes(actor) || !collectorUrl || !workspaceRoot || !manifestPath || !phase) {
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

function createOwnedWorkspaceWithoutAnalysisParent() {
  const ownedRoot = mkdtempSync(path.join(tmpdir(), 'fair-readmission-missing-parent-'));
  const fixtureRoot = path.join(ownedRoot, 'workspace');
  const excludedRoot = path.resolve(analysisRoot);
  try {
    cpSync(workspaceRoot, fixtureRoot, {
      recursive: true,
      filter(source) {
        const resolvedSource = path.resolve(source);
        if (resolvedSource === excludedRoot || resolvedSource.startsWith(`${excludedRoot}${path.sep}`)) return false;
        return !path.relative(workspaceRoot, resolvedSource).split(path.sep).includes('node_modules');
      },
    });
    return Object.freeze({ ownedRoot, fixtureRoot });
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

function createOwnedWxRaceHarness() {
  const ownedRoot = mkdtempSync(path.join(tmpdir(), 'fair-readmission-wx-race-'));
  const preloaderPath = path.join(ownedRoot, 'wx-race-preloader.cjs');
  const runnerPath = path.join(ownedRoot, 'wx-race-runner.mjs');
  try {
    writeFileSync(preloaderPath, wxRacePreloaderSource, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(runnerPath, wxRaceRunnerSource, { encoding: 'utf8', flag: 'wx' });
    return Object.freeze({ ownedRoot, preloaderPath, runnerPath });
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

function wxRaceChildEnvironment({ actor, manifestPath, phase }) {
  const environment = {
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    WAVE3_NATIVE_RACE_ACTOR: actor,
    WAVE3_NATIVE_RACE_COLLECTOR_URL: collectorUrl,
    WAVE3_NATIVE_RACE_WORKSPACE_ROOT: workspaceRoot,
    WAVE3_NATIVE_RACE_MANIFEST_PATH: manifestPath,
    WAVE3_NATIVE_RACE_PHASE: phase,
    WAVE3_NATIVE_RACE_TARGET: manifestPath,
  };
  assert.equal(Object.hasOwn(environment, 'NODE_OPTIONS'), false, 'child environment must scrub inherited NODE_OPTIONS rather than forwarding ambient preload state');
  return environment;
}

function spawnWxRaceChild({ harness, actor, manifestPath, phase, preload, timeline }) {
  const args = preload
    ? ['--require', harness.preloaderPath, harness.runnerPath]
    : [harness.runnerPath];
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    env: wxRaceChildEnvironment({ actor, manifestPath, phase }),
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

async function runNativeWorker() {
  const { controlBuffer, index, leaf } = workerData;
  const control = new Int32Array(controlBuffer);
  try {
    await Promise.all([import(collectorUrl), import(internalCoreUrl)]);
    parentPort.postMessage({ phase: 'ready', index });
    Atomics.wait(control, 0, 0);
    const { captureFrozenProvenance } = await import(collectorUrl);
    const manifest = captureFrozenProvenance({
      workspaceRoot,
      manifestPath: leaf,
      phase: `internal-core-native-worker-${index}`,
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
  test('SDS-AC-3 creates an absent fixed analysis parent in an owned workspace before capture preflight', { timeout: 115_000 }, async () => {
    const { ownedRoot, fixtureRoot } = createOwnedWorkspaceWithoutAnalysisParent();
    const fixtureAnalysisRoot = path.join(fixtureRoot, analysisRootRelativePath);
    const manifestPath = path.join(fixtureAnalysisRoot, 'missing-parent-first-capture.json');
    try {
      assert.equal(existsSync(fixtureAnalysisRoot), false, 'the copied workspace starts with the fixed analysis parent absent');
      const fixtureCollectorUrl = pathToFileURL(path.join(fixtureRoot, 'tools', 'wave3', 'fair-readmission-closure-v3.mjs')).href;
      const { captureFrozenProvenance } = await import(fixtureCollectorUrl);
      const manifest = captureFrozenProvenance({
        workspaceRoot: fixtureRoot,
        manifestPath,
        phase: 'internal-core-missing-parent-first-capture',
      });
      assert.equal(existsSync(fixtureAnalysisRoot), true, 'first capture creates only its fixed analysis parent');
      assert.equal(existsSync(manifestPath), true, 'first capture writes its requested fixed manifest leaf after parent creation');
      assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).protectedInput.sha256, manifest.protectedInput.sha256);
    } finally {
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

  test('SDS-AC-4 proves sibling native capture completes between A wx and A postflight without a collector test mode', { timeout: 115_000 }, async () => {
    const harness = createOwnedWxRaceHarness();
    const prefix = `wx-sibling-${process.pid}-${randomBytes(6).toString('hex')}`;
    const leafA = path.join(analysisRoot, `${prefix}-a.json`);
    const leafB = path.join(analysisRoot, `${prefix}-b.json`);
    const timeline = [];
    let actorA;
    let actorB;
    try {
      assert.equal(existsSync(leafA), false, 'A starts with an absent nonce-owned target leaf');
      assert.equal(existsSync(leafB), false, 'B starts with an absent distinct nonce-owned sibling leaf');
      actorA = spawnWxRaceChild({
        harness,
        actor: 'A',
        manifestPath: leafA,
        phase: 'internal-core-wx-sibling-a',
        preload: true,
        timeline,
      });
      await waitForWxRaceEvent(actorA, 'wx', 'A wx gate');
      actorB = spawnWxRaceChild({
        harness,
        actor: 'B',
        manifestPath: leafB,
        phase: 'internal-core-wx-sibling-b',
        preload: false,
        timeline,
      });
      await waitForWxRaceEvent(actorB, 'captured', 'B sibling capture');
      assert.equal(actorA.transcript.some(candidate => candidate.event === 'release' || candidate.event === 'captured'), false, 'A remains blocked after its exclusive wx before postflight while B completes');

      releaseWxRaceChild(actorA, 0x52);
      await waitForWxRaceEvent(actorA, 'release', 'A controlled release');
      await waitForWxRaceEvent(actorA, 'captured', 'A postflight capture');
      const [exitA, exitB] = await Promise.all([
        waitForWxRaceExit(actorA, 'A sibling capture'),
        waitForWxRaceExit(actorB, 'B sibling capture'),
      ]);
      assert.deepEqual(exitA, { code: 0, signal: null }, `A must succeed after permitted sibling timestamp churn\n${actorA.stderr}`);
      assert.deepEqual(exitB, { code: 0, signal: null }, `B must complete its native sibling capture\n${actorB.stderr}`);
      assert.equal(transcriptIndex(timeline, 'A', 'wx') < transcriptIndex(timeline, 'B', 'captured'), true, 'B capture begins only after A exclusive wx returned');
      assert.equal(transcriptIndex(timeline, 'B', 'captured') < transcriptIndex(timeline, 'A', 'release'), true, 'B preflight/write/postflight completes while A remains gated');
      assert.equal(transcriptIndex(timeline, 'A', 'release') < transcriptIndex(timeline, 'A', 'captured'), true, 'A postflight can only occur after the explicit release');
      assert.equal(JSON.parse(readFileSync(leafA, 'utf8')).phase, 'internal-core-wx-sibling-a');
      assert.equal(JSON.parse(readFileSync(leafB, 'utf8')).phase, 'internal-core-wx-sibling-b');
    } finally {
      if (actorA && !actorA.released && !actorA.exitState) releaseWxRaceChild(actorA, 0x52);
      await Promise.allSettled([actorA?.exited, actorB?.exited].filter(Boolean));
      removeOwnedLeaf(leafA, prefix);
      removeOwnedLeaf(leafB, prefix);
      removeOwnedWxRaceHarness(harness.ownedRoot);
    }
  });

  test('SDS-AC-3 rejects an owned post-wx regular-leaf replacement before A can accept its manifest', { timeout: 115_000 }, async () => {
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
        timeline,
      });
      await waitForWxRaceEvent(actorA, 'wx', 'A replacement wx gate');
      releaseWxRaceChild(actorA, 0x58);
      await waitForWxRaceEvent(actorA, 'replaced', 'A owned regular-leaf replacement');
      await waitForWxRaceEvent(actorA, 'release', 'A replacement release');
      const terminal = await waitForWxRaceTerminalEvent(actorA, 'A replacement capture');
      assert.equal(terminal.event, 'error', `post-wx replacement must reject before manifest acceptance; transcript=${JSON.stringify(actorA.transcript)}`);
      assert.match(terminal.message, /manifest|leaf|identity|replacement|postflight|changed/i);
      assert.equal(actorA.transcript.some(candidate => candidate.event === 'captured'), false, 'a replaced leaf must never reach accepted capture output');
      assert.deepEqual(await waitForWxRaceExit(actorA, 'A replacement capture'), { code: 1, signal: null });
      assert.equal(transcriptIndex(timeline, 'A', 'wx') < transcriptIndex(timeline, 'A', 'replaced'), true);
      assert.equal(transcriptIndex(timeline, 'A', 'replaced') < transcriptIndex(timeline, 'A', 'release'), true);
    } finally {
      if (actorA && !actorA.released && !actorA.exitState) releaseWxRaceChild(actorA, 0x52);
      await Promise.allSettled([actorA?.exited].filter(Boolean));
      removeOwnedLeaf(leafA, prefix);
      removeOwnedWxRaceHarness(harness.ownedRoot);
    }
  });
}

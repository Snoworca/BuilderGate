import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const analysisRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const artifactPath = `${analysisRoot}/canary-admission-evidence.json`;
const greenEvidencePath = `${analysisRoot}/ph-002/green-evidence.json`;
const redEvidencePath = `${analysisRoot}/ph-002/red-evidence-iteration10.json`;
const trustedManifestPath = `${analysisRoot}/terminal-resource-consumer-manifest.json`;
const evidenceToolPath = 'tools/wave3/canary-admission-evidence.test.mjs';
const sealedRedSha256 = '4ebd24ac98bcce70e75013344c47cacd423bfa38838792abdd7641e2e2832859';
const regenerateGreen = process.argv.includes('--regenerate-green');

const testSourcePaths = Object.freeze([
  'server/src/services/TerminalResourcePolicyCanary.test.ts',
  'server/src/ws/WsRouterSendPriority.test.ts',
  'server/src/ws/WsRouterRestoreMetadata.test.ts',
  'server/src/ws/wsSendPolicyRestoreMetadata.test.ts',
  'frontend/tests/unit/terminalOutputScheduler.test.ts',
  'frontend/tests/unit/terminalViewRecoveryContract.test.ts',
  'frontend/tests/unit/terminalContainerRecoveryContract.test.ts',
  'frontend/tests/unit/visibleOutputRecovery.test.ts',
]);

const requirementBearingTestSourcePaths = Object.freeze([
  'server/src/services/TerminalResourcePolicyCanary.test.ts',
  'server/src/ws/WsRouterSendPriority.test.ts',
  'frontend/tests/unit/terminalOutputScheduler.test.ts',
  'frontend/tests/unit/terminalViewRecoveryContract.test.ts',
  'frontend/tests/unit/terminalContainerRecoveryContract.test.ts',
]);

const productionSourcePaths = Object.freeze([
  'server/src/index.ts',
  'server/src/services/TerminalResourcePolicyRuntime.ts',
  'server/src/services/TerminalResourcePolicyCanary.ts',
  'server/src/services/TerminalResourcePolicy.ts',
  'server/src/services/RuntimeConfigStore.ts',
  'server/src/services/SessionManager.ts',
  'server/src/utils/boundedByteDeque.ts',
  'server/src/utils/headlessOutputQueue.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/ws/wsSendPolicy.ts',
  'server/src/types/ws-protocol.ts',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/types/ws-protocol.ts',
  'frontend/src/components/Terminal/TerminalRuntimeContext.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/utils/terminalOutputScheduler.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
]);

const focusedCommands = Object.freeze({
  server: Object.freeze({
    cwd: 'server',
    value: 'npx tsx --test src/services/TerminalResourcePolicyCanary.test.ts src/ws/WsRouterSendPriority.test.ts src/ws/WsRouterRestoreMetadata.test.ts src/ws/wsSendPolicyRestoreMetadata.test.ts',
    executable: process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx',
    args: Object.freeze(process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npx tsx --test src/services/TerminalResourcePolicyCanary.test.ts src/ws/WsRouterSendPriority.test.ts src/ws/WsRouterRestoreMetadata.test.ts src/ws/wsSendPolicyRestoreMetadata.test.ts']
      : ['tsx', '--test', 'src/services/TerminalResourcePolicyCanary.test.ts', 'src/ws/WsRouterSendPriority.test.ts', 'src/ws/WsRouterRestoreMetadata.test.ts', 'src/ws/wsSendPolicyRestoreMetadata.test.ts']),
  }),
  frontend: Object.freeze({
    cwd: 'frontend',
    value: 'node --experimental-strip-types --test tests/unit/terminalOutputScheduler.test.ts tests/unit/terminalViewRecoveryContract.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/visibleOutputRecovery.test.ts',
    executable: process.execPath,
    args: Object.freeze([
      '--experimental-strip-types', '--test',
      'tests/unit/terminalOutputScheduler.test.ts',
      'tests/unit/terminalViewRecoveryContract.test.ts',
      'tests/unit/terminalContainerRecoveryContract.test.ts',
      'tests/unit/visibleOutputRecovery.test.ts',
    ]),
  }),
});

const runtimeInspectionCommands = Object.freeze({
  server: Object.freeze({
    cwd: 'server',
    value: 'npx tsx --eval <runtime registry inspection>',
    executable: process.execPath,
    args: Object.freeze([
      'node_modules/tsx/dist/cli.mjs', '--eval',
      "import { getTerminalResourcePolicyRuntimeAssemblySnapshot, terminalResourcePolicyRuntimeAuthority } from './src/services/TerminalResourcePolicyRuntime.ts'; const target={kind:'ws',clientId:'evidence-client'}; const selection=terminalResourcePolicyRuntimeAuthority.issue({contractId:'not-registered',target,selectedTarget:target,resource:'resourceLimits.ws.perClientOutputQueueMaxBytes',consumer:'server.ws.router',capability:{version:7,compilerSchemaVersion:'terminal-resource-policy/v1'}}); process.stdout.write(JSON.stringify({...getTerminalResourcePolicyRuntimeAssemblySnapshot(),selectedProfileCount:selection.mode==='candidate'?1:0,mode:selection.mode,reason:selection.reason}))",
    ]),
  }),
  frontend: Object.freeze({
    cwd: 'frontend',
    value: 'node --experimental-strip-types --input-type=module --eval <zero-profile coordinator inspection>',
    executable: process.execPath,
    args: Object.freeze([
      '--experimental-strip-types', '--input-type=module', '--eval',
      "import { createHash } from 'node:crypto'; import { createTerminalOutputPolicySelectionCoordinator, createTerminalOutputPolicyRuntime, TERMINAL_OUTPUT_POLICY_SELECTION_ID } from './src/utils/terminalOutputScheduler.ts'; const target={viewId:'evidence-view',connectionId:'evidence-connection',reconnectGeneration:0}; const selection=createTerminalOutputPolicySelectionCoordinator().select({selectionId:TERMINAL_OUTPUT_POLICY_SELECTION_ID,policyGeneration:1,target}); const runtime=createTerminalOutputPolicyRuntime({target,selection}); process.stdout.write(JSON.stringify({...runtime.getSnapshot(),registryHash:createHash('sha256').update(JSON.stringify(selection.profiles)).digest('hex')}))",
    ]),
  }),
});

const requiredServerRelTestNames = Object.freeze([
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-1',
  'REL-BGSTAB-010 production assembly shares one registry-derived lease authority',
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-2',
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-3',
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-4',
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-5',
  'REL-BGSTAB-010 headless finalizer revokes the old epoch and isolates same-ID recreation',
  'REL-BGSTAB-010 headless maxChunks admits exact N and rejects N+1 without bypass',
  'REL-BGSTAB-010 headless write failure settles the candidate to target-scoped legacy recovery',
  'REL-BGSTAB-010 valid but inactive leases cannot preview admit or rollback active WS and headless targets',
  'REL-BGSTAB-010 production PTY path uses target-scoped non-destructive headless policy and restores legacy limit',
  'REL-BGSTAB-010 headless rollback closes only after the actual write chain drains',
  'REL-BGSTAB-010 headless rollback fences every pre-boundary policy generation',
  'Non-loss policy canary infrastructure RED contract — REL-BGSTAB-010 AC-6',
  'REL-BGSTAB-010 coalescing preserves every admission identity and lifetime fence',
  'REL-BGSTAB-010 AC-6 RED — policy rollback does not direct-flush queued output past an in-flight callback',
  'REL-BGSTAB-010 AC-6 RED — target rollback isolates client B and drains client A callback-by-callback',
  'REL-BGSTAB-010 WS rollback blocks fresh activation until the old callback fence closes',
  'REL-BGSTAB-010 WS rollback fences every pre-boundary generation before closing',
  'REL-BGSTAB-010 production route grandfathers preserved backlog above a smaller candidate cap',
  'REL-BGSTAB-010 explicit admission flushes in direct and observe modes without a permanent queue',
  'REL-BGSTAB-010 direct and observe candidate send failures settle to legacy without forced reconnect',
  'REL-BGSTAB-010 enforce candidate synchronous failure settles only the canary target',
  'REL-BGSTAB-010 candidate callback failure automatically resumes the preserved queue in every mode',
  'REL-BGSTAB-010 persistent candidate callback failure holds the complete boundary without a retry loop',
  'REL-BGSTAB-010 persistent candidate synchronous failure holds the complete boundary without a retry loop',
  'REL-BGSTAB-010 rollback-boundary send failures preserve queued transport in direct and observe modes',
  'REL-BGSTAB-010 enforce rollback callback failure preserves the remaining pre-boundary queue',
  'REL-BGSTAB-010 legacy overflow records rejection before bounded target close cleanup',
  'REL-BGSTAB-010 direct and observe admission overflow fences only the target without reconnect',
  'REL-BGSTAB-010 disconnect cleanup uses measured registries and bounds retained ledgers',
]);

const serverLineageTestNames = Object.freeze([
  'server RED — real output sequence and ready authority tokens',
  'server fresh replay request is token-fenced and supersedes the pending snapshot',
  'server recovery refresh requires both replay and repair ownership tokens',
  'server RED — normal identified output coalesces while preserving source segment boundaries',
  'server RED — three identity-less output frames remain coalescible',
  'server RED — split surrogate chunks never produce invalid UTF-8 source offsets',
]);

const requiredFrontendRelTestNames = Object.freeze([
  'REL-BGSTAB-010 AC-3 RED — explicit canary transition preserves below/at/above-cap retained FIFO',
  'REL-BGSTAB-010 frontend canary rejects stale and duplicate policy generations state-preservingly',
  'REL-BGSTAB-010 frontend canary fallback preserves retained FIFO and uses a separate new-admission budget',
  'REL-BGSTAB-010 frontend canary rollback fences admissions and closes at the pre-boundary FIFO',
  'REL-BGSTAB-010 frontend canary ledger is bounded immutable and records exact transition decisions',
  'REL-BGSTAB-010 production scheduler wires an inactive runtime and supports future stable injection',
  'REL-BGSTAB-010 rejected compaction does not leave a rollback sequence hole',
  'REL-BGSTAB-010 compaction preserves the rollback pre-boundary completion',
  'REL-BGSTAB-010 rollback ledger records the actual fallback decision through closure',
  'REL-BGSTAB-010 production binding uses real connection identity and the same selected-profile path',
  'REL-BGSTAB-010 selected profiles bind approved decisions and fail closed on ambiguity',
  'REL-BGSTAB-010 reset and repair explicitly abort active and draining canaries',
  'REL-BGSTAB-010 fallback gives grandfathered backlog a separate new-admission budget',
  'REL-BGSTAB-010 production component tree carries the zero or injected selection coordinator to TerminalView',
  'REL-BGSTAB-010 duplicate rollback is idempotent and cannot move the drain boundary',
  'REL-BGSTAB-010 bounded ingress retry queue drains two fenced outputs with one FIFO barrier',
  'REL-BGSTAB-010 oversized or saturated canary ingress settles to bounded target-local legacy without recovery',
  'REL-BGSTAB-010 legacy handoff bounds active plus 2L+1/N+2 burst without false written settlement',
  'REL-BGSTAB-010 legacy retry during rollback preserves boundary through rollback-closed',
  'REL-BGSTAB-010 restore-buffer flush retains ownership until write or observable rejection settlement',
  'REL-BGSTAB-010 restore-buffer ownership helper commits once and fails closed on identity mismatch',
  'REL-BGSTAB-010 restore-buffer helper waits for actual legacy callback and rejects contradictory sync admission',
  'REL-BGSTAB-010 restore attempt identity fences a superseded identical-string callback',
  'REL-BGSTAB-010 restore release is single-flight per attempt and supersedes exactly once',
  'REL-BGSTAB-010 authoritative coverage proves sequence, replay token, and failed-attempt ownership',
  'REL-BGSTAB-010 stable server authority covers tokenless normal live output across replacement connections',
  'REL-BGSTAB-010 authoritative coverage rollback restores exact ownership after partial drain',
  'REL-BGSTAB-010 rollback provenance allows a fresh checkpoint to complete and ACK',
  'REL-BGSTAB-010 delayed same-data restore A cannot release or drain restore B',
]);

const frontendLineageTestNames = Object.freeze([
  'TerminalContainer never ACKs a TerminalView restore-buffer rejection as an applied snapshot',
  'TerminalView propagates restore-buffer failure as FAILED_HELD without allowing live-output overtake',
  'TerminalView refuses FAILED_HELD convergence when coverage identity is unproven',
  'TerminalView leaves FAILED_HELD ownership untouched on reset throw or replay-probe timeout',
  'TerminalView restore replay is fenced by exact attempt epoch and xterm identity',
  'TerminalView resets scheduler and ingress retry ownership on terminal identity change and cleanup',
  'restore-needed and snapshot authority proof is exact and fail-closed',
  'coalesced UTF-8 output expands to exact recovery chunks without losing identity',
  'coalesced recovery output rejects the whole batch before a later stale segment can partially apply',
]);

const consumerAcMatrixSpecs = Object.freeze([
  { consumer: 'server.ws.router', ac: 'AC-1', testNames: [requiredServerRelTestNames[0], requiredServerRelTestNames[1], requiredServerRelTestNames[9]] },
  { consumer: 'server.ws.router', ac: 'AC-2', testNames: [requiredServerRelTestNames[2], requiredServerRelTestNames[19], requiredServerRelTestNames[20]] },
  { consumer: 'server.ws.router', ac: 'AC-3', testNames: [requiredServerRelTestNames[3], requiredServerRelTestNames[21], requiredServerRelTestNames[29]] },
  { consumer: 'server.ws.router', ac: 'AC-4', testNames: [requiredServerRelTestNames[4], requiredServerRelTestNames[28], requiredServerRelTestNames[30]] },
  { consumer: 'server.ws.router', ac: 'AC-5', testNames: [requiredServerRelTestNames[5], ...requiredServerRelTestNames.slice(22, 28)] },
  { consumer: 'server.ws.router', ac: 'AC-6', testNames: [requiredServerRelTestNames[13], requiredServerRelTestNames[14], ...requiredServerRelTestNames.slice(15, 19), ...serverLineageTestNames] },
  { consumer: 'server.pty.headless-model', ac: 'AC-1', testNames: [requiredServerRelTestNames[0], requiredServerRelTestNames[1], requiredServerRelTestNames[9]] },
  { consumer: 'server.pty.headless-model', ac: 'AC-2', testNames: [requiredServerRelTestNames[2], requiredServerRelTestNames[7], requiredServerRelTestNames[10]] },
  { consumer: 'server.pty.headless-model', ac: 'AC-3', testNames: [requiredServerRelTestNames[3]] },
  { consumer: 'server.pty.headless-model', ac: 'AC-4', testNames: [requiredServerRelTestNames[4], requiredServerRelTestNames[7]] },
  { consumer: 'server.pty.headless-model', ac: 'AC-5', testNames: [requiredServerRelTestNames[5], requiredServerRelTestNames[6], requiredServerRelTestNames[8]] },
  { consumer: 'server.pty.headless-model', ac: 'AC-6', testNames: [requiredServerRelTestNames[6], requiredServerRelTestNames[11], requiredServerRelTestNames[12], requiredServerRelTestNames[13]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-1', testNames: [requiredFrontendRelTestNames[5], requiredFrontendRelTestNames[9], requiredFrontendRelTestNames[10], requiredFrontendRelTestNames[13]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-2', testNames: [requiredFrontendRelTestNames[0], requiredFrontendRelTestNames[1], requiredFrontendRelTestNames[2], requiredFrontendRelTestNames[6], requiredFrontendRelTestNames[7], requiredFrontendRelTestNames[12], requiredFrontendRelTestNames[17]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-3', testNames: [requiredFrontendRelTestNames[0], requiredFrontendRelTestNames[11], requiredFrontendRelTestNames[16], requiredFrontendRelTestNames[19], frontendLineageTestNames[0], frontendLineageTestNames[1], frontendLineageTestNames[6]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-4', testNames: [requiredFrontendRelTestNames[4], requiredFrontendRelTestNames[8], requiredFrontendRelTestNames[24], requiredFrontendRelTestNames[25]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-5', testNames: [requiredFrontendRelTestNames[1], requiredFrontendRelTestNames[10], requiredFrontendRelTestNames[16], requiredFrontendRelTestNames[20], requiredFrontendRelTestNames[21], frontendLineageTestNames[2], frontendLineageTestNames[3], frontendLineageTestNames[8]] },
  { consumer: 'frontend.output-scheduler', ac: 'AC-6', testNames: [requiredFrontendRelTestNames[3], ...requiredFrontendRelTestNames.slice(6, 9), ...requiredFrontendRelTestNames.slice(14, 16), ...requiredFrontendRelTestNames.slice(18, 29), ...frontendLineageTestNames.slice(4, 6), frontendLineageTestNames[7]] },
]);

function absolute(repositoryPath) {
  assert.equal(isAbsolute(repositoryPath), false, `expected repository-relative path: ${repositoryPath}`);
  assert.doesNotMatch(repositoryPath, /\\/, `expected POSIX repository path: ${repositoryPath}`);
  const resolved = resolve(repositoryRoot, repositoryPath);
  assert.equal(relative(repositoryRoot, resolved).startsWith('..'), false, `path escapes repository: ${repositoryPath}`);
  return resolved;
}

function readBytes(repositoryPath) {
  const path = absolute(repositoryPath);
  assert.equal(existsSync(path), true, `required evidence path is missing: ${repositoryPath}`);
  return readFileSync(path);
}

function readUtf8(repositoryPath) {
  return readBytes(repositoryPath).toString('utf8').replace(/^\uFEFF/, '');
}

function readJson(repositoryPath) {
  return JSON.parse(readUtf8(repositoryPath));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function decodeOutput(value) {
  if (!value) return '';
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const looksUtf16Le = (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0);
  return bytes.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

function runCommand(command) {
  const result = spawnSync(command.executable, [...command.args], {
    cwd: absolute(command.cwd),
    windowsHide: true,
  });
  const stdout = decodeOutput(result.stdout).replace(/\r\n/g, '\n');
  const stderr = decodeOutput(result.stderr).replace(/\r\n/g, '\n');
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command.value} terminated by signal ${result.signal}`);
  assert.equal(result.status, 0, `${command.value} failed\n${stdout}\n${stderr}`);
  return Object.freeze({ stdout, stderr, exitCode: result.status });
}

function parseTapCount(output, key) {
  const matches = [...output.matchAll(new RegExp(`(?:^|\\n)(?:#|ℹ)?\\s*${key}\\s+(\\d+)\\s*(?:\\n|$)`, 'gu'))];
  assert.equal(matches.length, 1, `focused TAP output must contain exactly one ${key} count`);
  const value = Number.parseInt(matches[0][1], 10);
  assert.equal(Number.isSafeInteger(value) && value >= 0, true, `focused TAP ${key} count is not a non-negative safe integer`);
  return value;
}

function summarizeFocused(result, requiredRelNames, lineageNames) {
  const executedTests = new Map();
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/gu, '');
    const tapMatch = line.match(/^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/u);
    const specMatch = line.match(/^(✔|✖)\s+(.+?)\s+\([^)]*ms\)$/u);
    const match = tapMatch
      ? { status: tapMatch[1] === 'ok' ? 'pass' : 'fail', name: tapMatch[2] }
      : specMatch
        ? { status: specMatch[1] === '✔' ? 'pass' : 'fail', name: specMatch[2] }
        : undefined;
    if (!match) continue;
    assert.equal(executedTests.has(match.name), false, `focused output contains duplicate test name: ${match.name}`);
    executedTests.set(match.name, match.status);
  }
  const summary = Object.freeze({
    total: parseTapCount(result.stdout, 'tests'),
    passed: parseTapCount(result.stdout, 'pass'),
    failed: parseTapCount(result.stdout, 'fail'),
    cancelled: parseTapCount(result.stdout, 'cancelled'),
    skipped: parseTapCount(result.stdout, 'skipped'),
    todo: parseTapCount(result.stdout, 'todo'),
  });
  assert.equal(summary.total, summary.passed + summary.failed + summary.cancelled + summary.skipped + summary.todo,
    'focused TAP integer structure is inconsistent');
  assert.equal(executedTests.size, summary.total, 'focused TAP named test count differs from summary total');
  assert.equal(summary.failed + summary.cancelled + summary.skipped + summary.todo, 0,
    'focused TAP must be all-pass with no skipped/cancelled/todo tests');
  const discoveredRelNames = sorted([...executedTests.keys()].filter(name => name.includes('REL-BGSTAB-010')));
  assert.deepEqual(discoveredRelNames, sorted(requiredRelNames),
    'the focused REL-BGSTAB-010 named-test union differs from the exact registry');
  const registeredNames = [...requiredRelNames, ...lineageNames];
  for (const testName of registeredNames) {
    assert.equal(executedTests.get(testName), 'pass', `focused TAP did not pass registered test: ${testName}`);
  }
  const passedTestNames = sorted([...executedTests.keys()]);
  const excludedPassingTestNames = passedTestNames.filter(name => !registeredNames.includes(name));
  return Object.freeze({
    ...summary,
    requiredRelTestNames: [...requiredRelNames],
    lineageTestNames: [...lineageNames],
    registeredTestNames: registeredNames,
    passedTestNames,
    excludedPassingTestNames,
    semanticResultSha256: canonicalSha256({ summary, passedTestNames, excludedPassingTestNames }),
  });
}

function discoverRequirementBearingTests() {
  const discovered = [];
  const visit = (root) => {
    for (const entry of readdirSync(absolute(root), { withFileTypes: true })) {
      const path = `${root}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:test|spec)\.tsx?$/u.test(entry.name) && readUtf8(path).includes('REL-BGSTAB-010')) discovered.push(path);
    }
  };
  visit('server');
  visit('frontend');
  return sorted(discovered);
}

function inspectRuntime(command) {
  const result = runCommand(command);
  const nonempty = result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  assert.ok(nonempty.length > 0, `${command.value} returned no JSON snapshot`);
  const snapshot = JSON.parse(nonempty.at(-1));
  assert.equal(Number.isSafeInteger(snapshot.stableProfileCount) && snapshot.stableProfileCount >= 0, true,
    `${command.value} returned an invalid stableProfileCount`);
  assert.match(snapshot.registryHash, /^[a-f0-9]{64}$/u, `${command.value} returned an invalid registryHash`);
  return Object.freeze({ command: command.value, cwd: command.cwd, snapshot, stdoutSha256: sha256(result.stdout) });
}

function hashesFor(paths) {
  return Object.fromEntries(paths.map(path => [path, sha256(readBytes(path))]));
}

function matrixFromPassingTests(focused) {
  const passed = new Set([...focused.server.passedTestNames, ...focused.frontend.passedTestNames]);
  const requiredCorpus = new Set([
    ...requiredServerRelTestNames, ...serverLineageTestNames,
    ...requiredFrontendRelTestNames, ...frontendLineageTestNames,
  ]);
  const registered = new Set();
  const expectedKeys = new Set();
  for (const consumer of ['server.ws.router', 'server.pty.headless-model', 'frontend.output-scheduler']) {
    for (const ac of ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6']) expectedKeys.add(`${consumer}::${ac}`);
  }
  const matrix = consumerAcMatrixSpecs.map(spec => {
    const key = `${spec.consumer}::${spec.ac}`;
    assert.equal(expectedKeys.delete(key), true, `duplicate or unexpected consumer×AC matrix key: ${key}`);
    assert.ok(spec.testNames.length > 0, `consumer×AC matrix cell has no tests: ${key}`);
    for (const testName of spec.testNames) {
      assert.equal(requiredCorpus.has(testName), true, `${key} registers a test outside the exact corpus: ${testName}`);
      assert.equal(passed.has(testName), true, `${key} test did not pass: ${testName}`);
      registered.add(testName);
    }
    return Object.freeze({
      consumer: spec.consumer,
      acceptanceCriterion: spec.ac,
      status: 'pass',
      testNames: [...spec.testNames],
      evidenceSha256: canonicalSha256({ consumer: spec.consumer, ac: spec.ac, testNames: spec.testNames }),
    });
  });
  assert.deepEqual([...expectedKeys], [], 'consumer×AC matrix is incomplete');
  assert.deepEqual(sorted(registered), sorted(requiredCorpus),
    'consumer×AC matrix must be the exact union of the registered REL and authority-lineage corpus');
  return Object.freeze(matrix);
}

const activationThresholds = Object.freeze({
  serverFocused: Object.freeze({ exactTests: 42, maximumFailures: 0 }),
  frontendFocused: Object.freeze({ exactTests: 133, maximumFailures: 0 }),
  consumerAcMatrix: Object.freeze({ exactCells: 18, maximumFailed: 0 }),
  inputHashMismatches: Object.freeze({ maximum: 0 }),
  productionStableProfiles: Object.freeze({ minimumPerConsumer: 1 }),
});

function evaluateActivation({ thresholds, focused, matrix, inputHashMismatches, runtimeRegistry }) {
  const required = [
    thresholds?.serverFocused?.exactTests,
    thresholds?.serverFocused?.maximumFailures,
    thresholds?.frontendFocused?.exactTests,
    thresholds?.frontendFocused?.maximumFailures,
    thresholds?.consumerAcMatrix?.exactCells,
    thresholds?.consumerAcMatrix?.maximumFailed,
    thresholds?.inputHashMismatches?.maximum,
    thresholds?.productionStableProfiles?.minimumPerConsumer,
  ];
  if (required.some(value => !Number.isSafeInteger(value) || value < 0)) return Object.freeze({ eligible: false, reason: 'threshold-missing' });
  if (inputHashMismatches > thresholds.inputHashMismatches.maximum) return Object.freeze({ eligible: false, reason: 'input-hash-threshold-failed' });
  if (
    focused.server.total !== thresholds.serverFocused.exactTests
    || focused.server.failed > thresholds.serverFocused.maximumFailures
    || focused.frontend.total !== thresholds.frontendFocused.exactTests
    || focused.frontend.failed > thresholds.frontendFocused.maximumFailures
  ) return Object.freeze({ eligible: false, reason: 'focused-test-threshold-failed' });
  const failedCells = matrix.filter(cell => cell.status !== 'pass').length;
  if (matrix.length !== thresholds.consumerAcMatrix.exactCells || failedCells > thresholds.consumerAcMatrix.maximumFailed) {
    return Object.freeze({ eligible: false, reason: 'consumer-ac-matrix-threshold-failed' });
  }
  if (
    runtimeRegistry.server.stableProfileCount < thresholds.productionStableProfiles.minimumPerConsumer
    || runtimeRegistry.frontend.stableProfileCount < thresholds.productionStableProfiles.minimumPerConsumer
  ) return Object.freeze({ eligible: false, reason: 'candidate-unavailable' });
  return Object.freeze({ eligible: true, reason: 'all-activation-thresholds-passed' });
}

if (regenerateGreen) rmSync(absolute(artifactPath), { force: true });
assert.equal(sha256(readBytes(redEvidencePath)), sealedRedSha256, 'sealed historical RED artifact changed');
const redEvidence = readJson(redEvidencePath);
assert.equal(redEvidence.schemaVersion, 'kiwi-tdd-red-evidence/v1');
assert.equal(redEvidence.requirementId, 'REL-BGSTAB-010');
assert.equal(redEvidence.phaseId, 'PH-002');
assert.equal(redEvidence.iteration, 10);
assert.deepEqual(discoverRequirementBearingTests(), sorted(requirementBearingTestSourcePaths),
  'REL-BGSTAB-010 appears in an unregistered test source or a registered source disappeared');

const serverRun = runCommand(focusedCommands.server);
const frontendRun = runCommand(focusedCommands.frontend);
const focused = Object.freeze({
  server: summarizeFocused(serverRun, requiredServerRelTestNames, serverLineageTestNames),
  frontend: summarizeFocused(frontendRun, requiredFrontendRelTestNames, frontendLineageTestNames),
});
const consumerAcMatrix = matrixFromPassingTests(focused);
const runtimeInspections = Object.freeze({
  server: inspectRuntime(runtimeInspectionCommands.server),
  frontend: inspectRuntime(runtimeInspectionCommands.frontend),
});
assert.deepEqual(runtimeInspections.frontend.snapshot, {
  stableProfileCount: 0,
  selectedProfileCount: 0,
  mode: 'legacy',
  reason: 'candidate-unavailable',
  registryHash: runtimeInspections.frontend.snapshot.registryHash,
});
const runtimeRegistry = Object.freeze({
  server: runtimeInspections.server.snapshot,
  frontend: runtimeInspections.frontend.snapshot,
});
assert.deepEqual(runtimeRegistry.server, {
  stableProfileCount: 0,
  registryHash: runtimeRegistry.server.registryHash,
  selectedProfileCount: 0,
  mode: 'legacy',
  reason: 'candidate-unavailable',
});
const trustedManifestSha256 = sha256(readBytes(trustedManifestPath));
const testHashes = hashesFor(testSourcePaths);
const productionHashes = hashesFor(productionSourcePaths);

for (const path of testSourcePaths) {
  assert.doesNotMatch(readUtf8(path), /candidate failure closes (?:the )?transport/u,
    `obsolete forced-reconnect evidence remains in ${path}`);
}

const acceptanceEvidence = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'].map(ac => ({
  ac,
  status: 'pass',
  matrixCells: consumerAcMatrix
    .filter(cell => cell.acceptanceCriterion === ac)
    .map(cell => `${cell.consumer}::${cell.acceptanceCriterion}`),
}));

const expectedGreen = {
  schemaVersion: 'kiwi-tdd-green-evidence/v3',
  runId: '2026-07-16.projectmaster.wave3-authority',
  requirementId: 'REL-BGSTAB-010',
  phaseId: 'PH-002',
  taskIds: ['T-PH002-02', 'T-PH002-03', 'T-PH002-04', 'T-PH002-05', 'T-PH002-06'],
  capturedAt: regenerateGreen ? new Date().toISOString() : undefined,
  commands: [
    { cwd: focusedCommands.server.cwd, value: focusedCommands.server.value, exitCode: 0, result: { total: focused.server.total, passed: focused.server.passed, failed: focused.server.failed, cancelled: focused.server.cancelled, skipped: focused.server.skipped, todo: focused.server.todo } },
    { cwd: focusedCommands.frontend.cwd, value: focusedCommands.frontend.value, exitCode: 0, result: { total: focused.frontend.total, passed: focused.frontend.passed, failed: focused.frontend.failed, cancelled: focused.frontend.cancelled, skipped: focused.frontend.skipped, todo: focused.frontend.todo } },
    { cwd: runtimeInspections.server.cwd, value: runtimeInspections.server.command, exitCode: 0, result: runtimeInspections.server.snapshot },
    { cwd: runtimeInspections.frontend.cwd, value: runtimeInspections.frontend.command, exitCode: 0, result: runtimeInspections.frontend.snapshot },
  ],
  historicalRedBaseline: {
    source: redEvidencePath,
    artifactSha256: sealedRedSha256,
    currentCorpusClaim: 'superseded-by-reviewed-regression-corpus',
    testInputs: redEvidence.inputs.map(entry => ({ path: entry.path, sha256: entry.sha256 })),
  },
  reviewRegressionCorpus: {
    stage: 'green-after-exact-no-findings',
    files: testSourcePaths.map(path => ({ path, sha256: testHashes[path] })),
    requirementBearingFiles: [...requirementBearingTestSourcePaths],
    requiredRelTestNames: { server: [...requiredServerRelTestNames], frontend: [...requiredFrontendRelTestNames] },
    authorityLineageTestNames: { server: [...serverLineageTestNames], frontend: [...frontendLineageTestNames] },
    excludedPassingTests: {
      server: focused.server.excludedPassingTestNames,
      frontend: focused.frontend.excludedPassingTestNames,
      reason: 'focused-file regression context outside REL-BGSTAB-010 and the explicitly registered authority-lineage corpus',
    },
  },
  implementationInputs: productionSourcePaths.map(path => ({ path, sha256: productionHashes[path] })),
  trustedObservationManifest: {
    path: trustedManifestPath,
    sha256: trustedManifestSha256,
    requirementId: 'OBS-BGSTAB-005',
    status: 'implemented',
  },
  productionRuntimeRegistry: {
    source: 'executed-runtime-modules',
    server: runtimeInspections.server,
    frontend: runtimeInspections.frontend,
  },
  evidenceTool: { path: evidenceToolPath, sha256: sha256(readBytes(evidenceToolPath)) },
  consumerAcMatrix,
  acceptanceEvidence,
  activationBoundary: {
    productionStableProfiles: {
      server: runtimeRegistry.server.stableProfileCount,
      frontend: runtimeRegistry.frontend.stableProfileCount,
    },
    registryHashes: {
      server: runtimeRegistry.server.registryHash,
      frontend: runtimeRegistry.frontend.registryHash,
    },
    defaultMode: 'legacy',
    defaultReason: 'candidate-unavailable',
    userSettingsChanged: false,
    uiWiringChanged: false,
  },
  verdict: 'GREEN_EXACT_CONSUMER_AC_MATRIX_CONFIRMED',
};

if (regenerateGreen) {
  writeFileSync(absolute(greenEvidencePath), `${JSON.stringify(expectedGreen, null, 2)}\n`, 'utf8');
} else {
  const greenEvidence = readJson(greenEvidencePath);
  const recordedCapturedAt = greenEvidence.capturedAt;
  assert.equal(typeof recordedCapturedAt, 'string');
  assert.deepEqual(greenEvidence, { ...expectedGreen, capturedAt: recordedCapturedAt },
    'GREEN evidence drifted from the executable corpus, runtime registry, or production source set');
}

const greenEvidence = readJson(greenEvidencePath);
const actualActivation = evaluateActivation({
  thresholds: activationThresholds,
  focused,
  matrix: consumerAcMatrix,
  inputHashMismatches: 0,
  runtimeRegistry,
});
assert.deepEqual(actualActivation, { eligible: false, reason: 'candidate-unavailable' });
const failedFocused = evaluateActivation({
  thresholds: activationThresholds,
  focused: { ...focused, server: { ...focused.server, total: focused.server.total - 1 } },
  matrix: consumerAcMatrix,
  inputHashMismatches: 0,
  runtimeRegistry: { server: { ...runtimeRegistry.server, stableProfileCount: 1 }, frontend: { ...runtimeRegistry.frontend, stableProfileCount: 1 } },
});
assert.deepEqual(failedFocused, { eligible: false, reason: 'focused-test-threshold-failed' });
const failedMatrix = evaluateActivation({
  thresholds: activationThresholds,
  focused,
  matrix: consumerAcMatrix.slice(1),
  inputHashMismatches: 0,
  runtimeRegistry: { server: { ...runtimeRegistry.server, stableProfileCount: 1 }, frontend: { ...runtimeRegistry.frontend, stableProfileCount: 1 } },
});
assert.deepEqual(failedMatrix, { eligible: false, reason: 'consumer-ac-matrix-threshold-failed' });
const failedHash = evaluateActivation({
  thresholds: activationThresholds,
  focused,
  matrix: consumerAcMatrix,
  inputHashMismatches: 1,
  runtimeRegistry: { server: { ...runtimeRegistry.server, stableProfileCount: 1 }, frontend: { ...runtimeRegistry.frontend, stableProfileCount: 1 } },
});
assert.deepEqual(failedHash, { eligible: false, reason: 'input-hash-threshold-failed' });

const rawEvidencePaths = Object.freeze([
  greenEvidencePath,
  redEvidencePath,
  trustedManifestPath,
  evidenceToolPath,
  ...testSourcePaths,
]);
const rawInputHashes = hashesFor(rawEvidencePaths);
const recordedArtifact = regenerateGreen ? undefined : readJson(artifactPath);
const artifactCapturedAt = regenerateGreen ? new Date().toISOString() : recordedArtifact?.capturedAt;
assert.equal(typeof artifactCapturedAt, 'string', 'recorded admission artifact is missing capturedAt');
const artifact = {
  schemaVersion: 'terminal-resource-policy-canary-admission-evidence/v3',
  requirementId: 'REL-BGSTAB-010',
  phaseId: 'PH-002',
  taskId: 'T-PH002-06',
  capturedAt: artifactCapturedAt,
  invocation: 'node tools/wave3/canary-admission-evidence.test.mjs',
  historicalRedBaseline: { path: redEvidencePath, sealedSha256: sealedRedSha256 },
  trustedObservationManifest: greenEvidence.trustedObservationManifest,
  productionRuntimeRegistry: greenEvidence.productionRuntimeRegistry,
  rawEvidencePaths: [...rawEvidencePaths],
  inputHashes: { files: rawInputHashes, sourceSetSha256: canonicalSha256(rawInputHashes), mismatches: 0 },
  productionSourceHashes: { files: productionHashes, sourceSetSha256: canonicalSha256(productionHashes) },
  focusedRuns: {
    server: { cwd: focusedCommands.server.cwd, command: focusedCommands.server.value, exitCode: 0, ...focused.server },
    frontend: { cwd: focusedCommands.frontend.cwd, command: focusedCommands.frontend.value, exitCode: 0, ...focused.frontend },
  },
  consumerAcMatrix,
  acceptanceEvidence,
  activationGate: {
    thresholds: activationThresholds,
    actual: actualActivation,
    failClosedProofs: { failedFocused, failedMatrix, failedHash },
    stableCandidateRegistered: false,
    enforcementAvailable: false,
    defaultMode: 'legacy',
    defaultReason: 'candidate-unavailable',
  },
  verdict: 'PASS_FAIL_CLOSED_CANDIDATE_UNAVAILABLE',
};

if (regenerateGreen) {
  writeFileSync(absolute(artifactPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  assert.deepEqual(readJson(artifactPath), artifact, 'recorded canary admission artifact failed round-trip validation');
} else {
  assert.deepEqual(recordedArtifact, artifact,
    'recorded canary admission artifact drifted from the current read-only validation result');
}
process.stdout.write(`${JSON.stringify({
  requirementId: artifact.requirementId,
  phaseId: artifact.phaseId,
  taskId: artifact.taskId,
  serverFocused: { total: focused.server.total, passed: focused.server.passed, failed: focused.server.failed },
  frontendFocused: { total: focused.frontend.total, passed: focused.frontend.passed, failed: focused.frontend.failed },
  exactRelNamedTests: requiredServerRelTestNames.length + requiredFrontendRelTestNames.length,
  registeredAuthorityLineageTests: serverLineageTestNames.length + frontendLineageTestNames.length,
  consumerAcMatrixCells: consumerAcMatrix.length,
  productionStableProfiles: greenEvidence.activationBoundary.productionStableProfiles,
  activation: actualActivation,
  verdict: artifact.verdict,
  artifactPath,
}, null, 2)}\n`);

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
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

// Test sources naming REL-BGSTAB-010 that THIS guard executes through its focused commands.
const executedRequirementBearingTestSourcePaths = Object.freeze([
  'server/src/services/TerminalResourcePolicyCanary.test.ts',
  'server/src/ws/WsRouterSendPriority.test.ts',
  'frontend/tests/unit/terminalOutputScheduler.test.ts',
  'frontend/tests/unit/terminalViewRecoveryContract.test.ts',
  'frontend/tests/unit/terminalContainerRecoveryContract.test.ts',
]);

// Test sources naming REL-BGSTAB-010 that this guard does NOT execute. Declaring a path here is
// not free: each entry must say why it is verified elsewhere, so the cheapest way to clear a
// future red is an argued line rather than a pasted path. `discoverRequirementBearingTests`
// walks the tree, so a new REL-BGSTAB-010 suite that nobody declares still reddens this guard.
const declaredElsewhereRequirementBearingTestSources = Object.freeze([
  Object.freeze({
    path: 'frontend/tests/unit/terminalOutputAckCompletion.test.ts',
    reason: 'Added by REL-BGSTAB-009 (commit 5abfc4c) for stale output-completion ACK suppression. '
      + 'It cites REL-BGSTAB-010 as the neighbouring authority contract rather than asserting one '
      + 'of its acceptance criteria, and it owns no consumer x AC matrix cell.',
  }),
  Object.freeze({
    path: 'server/src/services/TerminalResourcePolicyConsumerRegistry.test.ts',
    reason: 'REL-BGSTAB-010 AC-7 consumer registration contract. AC-7 is not a per-consumer '
      + 'transition criterion and owns no cell in the AC-1..AC-6 consumer x AC matrix this guard '
      + 'computes; it is carried by its own named suite and its own verification evidence row.',
  }),
]);

const requirementBearingTestSourcePaths = Object.freeze([
  ...executedRequirementBearingTestSourcePaths,
  ...declaredElsewhereRequirementBearingTestSources.map(entry => entry.path),
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
  'TerminalContainer keeps restore-buffer failure non-ACKable while acknowledging only a checkpoint takeover',
  'TerminalView propagates restore-buffer failure as FAILED_HELD without allowing live-output overtake',
  'TerminalView refuses FAILED_HELD convergence when coverage identity is unproven',
  'TerminalView leaves FAILED_HELD ownership untouched on reset throw or sole-writer rejection',
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
    // What may be SEALED. `total`, `passed`, `passedTestNames`, `excludedPassingTestNames` and
    // the hash over them all move whenever any other lane adds a sibling test to one of these
    // shared files, so sealing them makes --regenerate-green the cheapest route through a red and
    // re-blesses whatever else moved at the same time. The corpus identity is already pinned
    // exactly by the deepEquals above; what is sealed here is only what this requirement owns.
    //
    // What this seal is and is not. `registeredResultSha256` hashes the OBSERVED status of each
    // registered name as read out of this run's TAP. On any run that REACHES this line, that
    // observed status is provably the constant 'pass' for every registered name, because five
    // assertions have already fired and none of them can be satisfied otherwise:
    //   1. `runCommand` asserts the child's exit status is 0, so a lane with any failing test
    //      throws before its output is ever summarized;
    //   2. `summarizeFocused` asserts failed + cancelled + skipped + todo === 0 over the TAP
    //      counts, so no non-pass status survives into the map;
    //   3. `summarizeFocused` asserts executedTests.size === summary.total, so a registered name
    //      cannot be absent from the map while the summary still accounts for it;
    //   4. `summarizeFocused` asserts `discoveredRelNames` deepEquals the exact required REL
    //      registry, so a REL-named test going absent throws;
    //   5. `summarizeFocused` asserts executedTests.get(name) === 'pass' for every registered
    //      name, so an absent or non-passing registered name throws.
    // This value therefore differs from one computed off the literal name lists with every status
    // forced to 'pass' IF ANY ONE of those five assertions is weakened -- a disjunction, not a
    // conjunction. Assertion 5 alone suffices: a registered AUTHORITY-LINEAGE name going absent is
    // caught by neither the summary counts (they stay internally consistent) nor the
    // `discoveredRelNames` deepEqual, which filters on names containing REL-BGSTAB-010 and so does
    // not cover the lineage names at all. It is a tripwire against that future weakening, and it
    // is NOT evidence that a run occurred.
    // The run-derived evidence in the artifact that is falsifiable TODAY lives in `inputHashes`,
    // `productionSourceHashes` and `productionRuntimeRegistry.*.stdoutSha256`, not in this block.
    sealedProjection: Object.freeze({
      failed: summary.failed,
      cancelled: summary.cancelled,
      skipped: summary.skipped,
      todo: summary.todo,
      registeredTestNames: registeredNames.length,
      registeredResultSha256: canonicalSha256({
        observed: sorted(registeredNames).map(name => [name, executedTests.get(name) ?? 'absent']),
      }),
    }),
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

// Derived, not transcribed. An exact total over these four shared files pinned every sibling
// test another lane happens to add to them, which is not a property of REL-BGSTAB-010: the pins
// 42 and 133 rotted to 106 and 168 without anyone noticing, and the cheapest repair was always to
// retype a number nobody owns. What this requirement actually needs is that the run contained at
// least its whole registered corpus and that none of it failed, skipped or went todo. Corpus
// IDENTITY is pinned exactly and independently, by the `discoveredRelNames` deepEqual and by the
// `registered === requiredCorpus` deepEqual in the matrix, so a registered test that disappears
// or is renamed still reddens. What this no longer catches, stated plainly: the deletion of an
// UNREGISTERED sibling test from one of these four files.
const registeredCorpusSize = Object.freeze({
  server: requiredServerRelTestNames.length + serverLineageTestNames.length,
  frontend: requiredFrontendRelTestNames.length + frontendLineageTestNames.length,
});

const activationThresholds = Object.freeze({
  serverFocused: Object.freeze({ minimumTests: registeredCorpusSize.server, maximumFailures: 0 }),
  frontendFocused: Object.freeze({ minimumTests: registeredCorpusSize.frontend, maximumFailures: 0 }),
  consumerAcMatrix: Object.freeze({ exactCells: 18, maximumFailed: 0 }),
  inputHashMismatches: Object.freeze({ maximum: 0 }),
  productionStableProfiles: Object.freeze({ minimumPerConsumer: 1 }),
});

function evaluateActivation({ thresholds, focused, matrix, inputHashMismatches, runtimeRegistry }) {
  const required = [
    thresholds?.serverFocused?.minimumTests,
    thresholds?.serverFocused?.maximumFailures,
    thresholds?.frontendFocused?.minimumTests,
    thresholds?.frontendFocused?.maximumFailures,
    thresholds?.consumerAcMatrix?.exactCells,
    thresholds?.consumerAcMatrix?.maximumFailed,
    thresholds?.inputHashMismatches?.maximum,
    thresholds?.productionStableProfiles?.minimumPerConsumer,
  ];
  if (required.some(value => !Number.isSafeInteger(value) || value < 0)) return Object.freeze({ eligible: false, reason: 'threshold-missing' });
  if (inputHashMismatches > thresholds.inputHashMismatches.maximum) return Object.freeze({ eligible: false, reason: 'input-hash-threshold-failed' });
  if (
    focused.server.total < thresholds.serverFocused.minimumTests
    || focused.server.failed > thresholds.serverFocused.maximumFailures
    || focused.frontend.total < thresholds.frontendFocused.minimumTests
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
for (const entry of declaredElsewhereRequirementBearingTestSources) {
  assert.ok(entry.reason.trim().length > 0,
    `a test source declared as verified elsewhere carries no reason: ${entry.path}`);
  assert.equal(executedRequirementBearingTestSourcePaths.includes(entry.path), false,
    `${entry.path} is declared as verified elsewhere and also executed here`);
}
// `executedRequirementBearingTestSourcePaths` is otherwise an unaudited label: nothing tied its
// entries to what the focused commands actually run. Without this, listing a new suite as
// "executed" and never adding it to focusedCommands is a cheaper way to hide a suite from
// verification than the declared-elsewhere route, which at least costs a written reason.
// The focused command args are cwd-relative, so the leading `server/` or `frontend/` is stripped.
//
// The check is POSITIONAL, and identical in strength on both platforms. A bare membership test
// over every token accepted a path that appeared anywhere on the command line -- as the value of
// a flag such as `--test-name-pattern`, or after an exclusion flag -- which is not execution.
// Only the tokens AFTER `--test` are node's test-file operands.
//
// RESIDUAL, stated rather than papered over: this audit inspects only the tokens AFTER `--test`.
// The prefix is UNCONSTRAINED, so a flag placed before `--test` -- `--test-skip-pattern=.`,
// `--test-name-pattern='^$'` -- would leave the operand set identical while running nothing. This
// audit therefore establishes MEMBERSHIP, not execution. Execution is established downstream and
// independently, by `summarizeFocused` asserting that every registered REL and authority-lineage
// name was observed as `pass` in the lane's TAP: a suppressed lane produces an empty TAP and every
// one of those names is then absent. The prefix is deliberately left unpinned here because pinning
// the full token list would re-create exactly the transcription problem removed just below.
//
// No counter compares this loop's own increment to the length of the array it iterates: that
// comparison is a tautology and cannot detect an empty enumeration, which is the defect this
// commit removes elsewhere. Non-emptiness is asserted up front instead.
assert.ok(executedRequirementBearingTestSourcePaths.length > 0,
  'no requirement-bearing test source is declared as executed by this guard');

// Operands a lane runs that name NO requirement id. The expected operand set is no longer
// transcribed: `focusedLaneTestOperands` restated the very paths already written into
// `focusedCommands` several hundred lines above in this same file, so its deepEqual compared two
// copies of one author's intent and was anchored to nothing outside that intent. The operand set
// is derived from `focusedCommands[lane].args` instead -- that is what actually runs -- and
// reconciled against two things that are not copies of it: the tree walk in
// `discoverRequirementBearingTests`, which decides `requirementBearingTestSourcePaths`, and this
// explicit, reasoned list. Adding a file to a lane therefore still costs an argued line, but
// removing one from the transcription no longer silently relaxes anything.
const focusedLaneSupportingTestOperands = Object.freeze({
  server: Object.freeze([
    Object.freeze({
      path: 'src/ws/WsRouterRestoreMetadata.test.ts',
      reason: 'Carries authority-lineage tests registered in serverLineageTestNames, whose pass '
        + 'status this guard asserts. It names no REL-BGSTAB-010 requirement id, so the tree walk '
        + 'does not classify it as requirement-bearing.',
    }),
    Object.freeze({
      path: 'src/ws/wsSendPolicyRestoreMetadata.test.ts',
      reason: 'Carries authority-lineage tests registered in serverLineageTestNames, whose pass '
        + 'status this guard asserts. It names no REL-BGSTAB-010 requirement id, so the tree walk '
        + 'does not classify it as requirement-bearing.',
    }),
  ]),
  frontend: Object.freeze([
    Object.freeze({
      path: 'tests/unit/visibleOutputRecovery.test.ts',
      reason: 'Carries authority-lineage tests registered in frontendLineageTestNames, whose pass '
        + 'status this guard asserts. It names no REL-BGSTAB-010 requirement id, so the tree walk '
        + 'does not classify it as requirement-bearing.',
    }),
  ]),
});

const laneTestOperands = new Map();
for (const lane of ['server', 'frontend']) {
  // On win32 the server lane passes one joined `cmd /c` string, so tokenize it; elsewhere the
  // args array is already the token list.
  const tokens = process.platform === 'win32'
    ? focusedCommands[lane].args.flatMap(arg => arg.split(/\s+/u)).filter(Boolean)
    : [...focusedCommands[lane].args];
  const testFlagIndex = tokens.indexOf('--test');
  assert.notEqual(testFlagIndex, -1,
    `the ${lane} focused command carries no --test flag, so it names no test-file operands`);
  const operands = tokens.slice(testFlagIndex + 1);
  assert.deepEqual(operands.filter(token => token.startsWith('-')), [],
    `the ${lane} focused command mixes flags in among its test-file operands`);
  // Counted before the reconciliation below: a universal claim over an empty operand list is true.
  assert.ok(operands.length > 0, `the ${lane} focused command names no test-file operands`);
  assert.equal(new Set(operands).size, operands.length,
    `the ${lane} focused command names the same test-file operand twice`);

  const supporting = focusedLaneSupportingTestOperands[lane];
  const supportingPaths = supporting.map(entry => entry.path);
  for (const entry of supporting) {
    assert.ok(entry.reason.trim().length > 0,
      `a supporting operand of the ${lane} lane carries no reason: ${entry.path}`);
    assert.equal(operands.includes(entry.path), true,
      `${entry.path} is declared as a supporting operand of the ${lane} lane but the lane does not run it`);
  }
  const requirementBearingInLane = requirementBearingTestSourcePaths
    .filter(path => path.startsWith(`${lane}/`))
    .map(path => path.slice(`${lane}/`.length));
  for (const operand of operands) {
    const requirementBearing = requirementBearingInLane.includes(operand);
    const declaredSupporting = supportingPaths.includes(operand);
    assert.equal(requirementBearing || declaredSupporting, true,
      `the ${lane} focused command runs ${operand}, which is neither a requirement-bearing source `
      + 'nor a declared supporting file');
    assert.equal(requirementBearing && declaredSupporting, false,
      `${operand} is declared as a supporting file of the ${lane} lane and is also requirement-bearing`);
  }
  laneTestOperands.set(lane, new Set(operands));
}
assert.deepEqual(sorted([...laneTestOperands.keys()]), ['frontend', 'server'],
  'the focused-lane operand audit did not check both lanes');

for (const path of executedRequirementBearingTestSourcePaths) {
  const lane = path.startsWith('server/') ? 'server' : path.startsWith('frontend/') ? 'frontend' : undefined;
  assert.notEqual(lane, undefined, `executed requirement-bearing path is in no focused lane: ${path}`);
  const relative = path.slice(`${lane}/`.length);
  assert.equal(laneTestOperands.get(lane).has(relative), true,
    `${path} is declared as executed here but is not a test-file operand of the ${lane} focused command`);
}
assert.equal(new Set(requirementBearingTestSourcePaths).size, requirementBearingTestSourcePaths.length,
  'a requirement-bearing test source is declared twice');
assert.deepEqual(discoverRequirementBearingTests(), sorted(requirementBearingTestSourcePaths),
  'REL-BGSTAB-010 appears in an unregistered test source or a registered source disappeared');

// The sealed `value` must describe the command that is actually SPAWNED. `runCommand` spawns
// `executable` with `args`, while the green evidence and the admission artifact seal `value`, a
// separately hand-written string. Nothing compared them, so the artifact's record of what produced
// the evidence could drift arbitrarily from what ran, and nothing would redden.
//
// For the FOCUSED commands the reconstruction is literal, so the check is exact:
//   * win32 server lane: `executable` is the shell and `args` is ['/d','/s','/c', <one string>];
//     the joined string IS the value.
//   * everywhere else: value === <interpreter name> + ' ' + args.join(' '), where the interpreter
//     name is the executable's basename with any .exe suffix removed ('npx', 'node').
function interpreterName(executablePath) {
  return basename(executablePath).replace(/\.exe$/iu, '');
}

for (const [lane, command] of Object.entries(focusedCommands)) {
  if (process.platform === 'win32' && command.executable !== process.execPath) {
    assert.deepEqual(command.args.slice(0, 3), ['/d', '/s', '/c'],
      `the ${lane} focused command is spawned through a shell with unexpected shell flags`);
    assert.equal(command.args.length, 4,
      `the ${lane} focused command passes more than one shell command string`);
    assert.equal(command.args[3], command.value,
      `the ${lane} focused command's sealed value is not the string handed to the shell`);
    continue;
  }
  assert.equal(`${interpreterName(command.executable)} ${command.args.join(' ')}`, command.value,
    `the ${lane} focused command's sealed value does not reconstruct from executable + args`);
}

// For the RUNTIME INSPECTION commands a literal reconstruction is NOT possible: `value` elides a
// multi-kilobyte `--eval` script behind an angle-bracket placeholder, and the server lane declares
// the conventional invocation (`npx tsx --eval ...`) while it actually spawns node directly on
// tsx's cli entry point so the child is a single process this guard can account for. What IS
// checkable is asserted; what is not is named.
//
// CHECKED: the placeholder is exactly one angle-bracket group and it terminates the value, so the
// elision is visible rather than silent; `--eval` appears exactly once in args; exactly one
// argument follows it, so the placeholder stands for exactly one argument and no further operand
// is hidden behind it; and every flag written in the declared value's prefix is genuinely present
// in args, so a flag cannot be advertised without being passed.
//
// NOT CHECKED, stated plainly: the interpreter words at the head of the value (`npx tsx` vs the
// spawned `node node_modules/tsx/dist/cli.mjs`) are a human description and are not reconstructed;
// and the elided script body is not compared to anything. A change to the eval script therefore
// does not move `value`. That script's OUTPUT is separately pinned -- `inspectRuntime` hashes the
// child's stdout into `productionRuntimeRegistry.*.stdoutSha256` and the snapshot shape is
// asserted -- so a behavioural change in the script surfaces there, not here.
for (const [lane, command] of Object.entries(runtimeInspectionCommands)) {
  const placeholders = [...command.value.matchAll(/<[^<>]*>/gu)];
  assert.equal(placeholders.length, 1,
    `the ${lane} runtime inspection command's value must elide its script behind exactly one placeholder`);
  assert.equal(command.value.endsWith('>'), true,
    `the ${lane} runtime inspection command's placeholder must terminate its value`);
  const evalIndex = command.args.indexOf('--eval');
  assert.notEqual(evalIndex, -1, `the ${lane} runtime inspection command passes no --eval`);
  assert.equal(command.args.filter(arg => arg === '--eval').length, 1,
    `the ${lane} runtime inspection command passes --eval more than once`);
  assert.equal(command.args.length - evalIndex - 1, 1,
    `the ${lane} runtime inspection command's placeholder stands for more than one argument`);
  const declaredFlags = command.value.slice(0, placeholders[0].index).split(/\s+/u)
    .filter(token => token.startsWith('--'));
  assert.ok(declaredFlags.includes('--eval'),
    `the ${lane} runtime inspection command's value does not declare --eval`);
  for (const flag of declaredFlags) {
    assert.equal(command.args.includes(flag), true,
      `the ${lane} runtime inspection command declares ${flag} in its sealed value but does not pass it`);
  }
}

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
    { cwd: focusedCommands.server.cwd, value: focusedCommands.server.value, exitCode: 0, result: focused.server.sealedProjection },
    { cwd: focusedCommands.frontend.cwd, value: focusedCommands.frontend.value, exitCode: 0, result: focused.frontend.sealedProjection },
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
    executedRequirementBearingFiles: [...executedRequirementBearingTestSourcePaths],
    requirementBearingFilesVerifiedElsewhere: declaredElsewhereRequirementBearingTestSources
      .map(entry => ({ path: entry.path, reason: entry.reason })),
    requiredRelTestNames: { server: [...requiredServerRelTestNames], frontend: [...requiredFrontendRelTestNames] },
    authorityLineageTestNames: { server: [...serverLineageTestNames], frontend: [...frontendLineageTestNames] },
    excludedPassingTests: {
      sealed: false,
      reason: 'Sibling tests in the focused files outside REL-BGSTAB-010 and the registered '
        + 'authority-lineage corpus. Their names and count belong to other requirements and move '
        + 'independently of this one, so they are printed on every run and never sealed.',
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
  // One below the registered corpus, not one below the live total: under a minimum the
  // live-total-minus-one fixture would stay eligible and this proof would assert nothing.
  focused: { ...focused, server: { ...focused.server, total: registeredCorpusSize.server - 1 } },
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
    server: { cwd: focusedCommands.server.cwd, command: focusedCommands.server.value, exitCode: 0, ...focused.server.sealedProjection },
    frontend: { cwd: focusedCommands.frontend.cwd, command: focusedCommands.frontend.value, exitCode: 0, ...focused.frontend.sealedProjection },
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
  serverFocused: { total: focused.server.total, passed: focused.server.passed, failed: focused.server.failed, minimumTests: activationThresholds.serverFocused.minimumTests },
  frontendFocused: { total: focused.frontend.total, passed: focused.frontend.passed, failed: focused.frontend.failed, minimumTests: activationThresholds.frontendFocused.minimumTests },
  unsealedSiblingTests: { server: focused.server.excludedPassingTestNames.length, frontend: focused.frontend.excludedPassingTestNames.length },
  exactRelNamedTests: requiredServerRelTestNames.length + requiredFrontendRelTestNames.length,
  registeredAuthorityLineageTests: serverLineageTestNames.length + frontendLineageTestNames.length,
  consumerAcMatrixCells: consumerAcMatrix.length,
  productionStableProfiles: greenEvidence.activationBoundary.productionStableProfiles,
  activation: actualActivation,
  verdict: artifact.verdict,
  artifactPath,
}, null, 2)}\n`);

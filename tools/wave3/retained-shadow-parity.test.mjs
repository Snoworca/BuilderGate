import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('../../server/node_modules/typescript/lib/typescript.js');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const analysisRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const artifactPath = `${analysisRoot}/retained-shadow-parity.json`;
const evidenceToolPath = 'tools/wave3/retained-shadow-parity.test.mjs';
const invocation = 'node tools/wave3/retained-shadow-parity.test.mjs';

const testSourcePaths = Object.freeze([
  'server/src/services/RetainedTerminalAuthority.test.ts',
  'server/src/services/SessionManagerPartialEscapeTail.test.ts',
  'server/src/ws/WsRouterRestoreMetadata.test.ts',
  'server/src/ws/WsRouterCheckpointProtocol.test.ts',
]);

const inputPaths = Object.freeze([
  'docs/plans/2026-07-16.projectmaster.wave3-authority.plan.md',
  'docs/spec/00.index.md',
  'docs/spec/30.buildergate-stability.srs.md',
  ...testSourcePaths,
  'frontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts',
]);

const configPaths = Object.freeze([
  'server/config.json5.example',
  'server/src/schemas/config.schema.ts',
  'server/src/types/config.types.ts',
  'server/src/utils/config.ts',
]);

const productionSourcePaths = Object.freeze([
  'server/src/services/SessionManager.ts',
  'server/src/utils/headlessTerminal.ts',
  'server/src/types/ws-protocol.ts',
  'server/src/ws/WsRouter.ts',
]);

const focusedCommandValue = 'npx tsx --test src/services/RetainedTerminalAuthority.test.ts src/services/SessionManagerPartialEscapeTail.test.ts src/ws/WsRouterRestoreMetadata.test.ts src/ws/WsRouterCheckpointProtocol.test.ts';
const focusedCommand = Object.freeze({
  cwd: 'server',
  value: focusedCommandValue,
  executable: process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx',
  args: Object.freeze(process.platform === 'win32'
    ? ['/d', '/s', '/c', focusedCommandValue]
    : [
        'tsx', '--test',
        'src/services/RetainedTerminalAuthority.test.ts',
        'src/services/SessionManagerPartialEscapeTail.test.ts',
        'src/ws/WsRouterRestoreMetadata.test.ts',
        'src/ws/WsRouterCheckpointProtocol.test.ts',
      ]),
});

const retained = Object.freeze({
  ac1: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-1',
  ac2: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-2',
  ac3: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-3',
  ac4: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-4',
  ac5: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-5',
  ac6: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-6',
  ac7: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-7',
  ac8: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-8',
  ac9: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-9',
  rel7ac6: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-6',
  rel7ac7: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-7',
  rel7ac9: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-9',
  rel7ac10: 'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-10',
  restart: 'REL_BGSTAB_007_AC10_server_restart_is_authority_unavailable',
  exit: 'REL_BGSTAB_007_AC10_pty_exit_is_session_terminated',
  independentComparer: 'RED reviewer — production comparer requires an independent roundtrip baseline before principal-axis match',
  splitSemantic: 'RED reviewer — split semantic facts preserve record-local OSC BEL/ST, DSR, and repeated BEL occurrences',
  softWrap: 'RED reviewer — newline-free soft-wrap and reflow eviction advance exact oldest retained source',
  actualTwoClient: 'RED reviewer — actual input, resize, and query paths reject stale lease identity for two clients',
  actualEightClient: 'RED reviewer — actual input path rejects every stale lease identity with eight clients',
  missingIdentity: 'RED reviewer — missing actual mutation identity stays legacy-compatible but blocks shadow canary',
  replacementFence: 'RED reviewer — old authority identity cannot mutate replacement PTY through actual paths',
  resizeIdentity: 'RED reviewer — resize advances snapshot identity without consuming PTY source sequence',
  degradation: 'RED reviewer — actual headless write degradation is typed and blocks authority canary',
  websocketLease: 'RED reviewer — negotiated retained lease fences actual websocket input and resize mutations',
  populatedRollover: 'RED reviewer — populated Ordinal64 rollover keeps oldest retained marker epoch-qualified',
  failedContender: 'RED reviewer — failed competing mutation lease rolls back only its newly registered view',
  globalIdleComparer: 'RED reviewer — shadow comparer samples only at global headless idle and enforces a low-duty interval',
  boundedLedger: 'RED reviewer — retained operation and fact evidence ledgers stay policy-bounded',
  degradedSemanticFallback: 'RED reviewer — degraded, overflow, and commit-failure OSC status records reject facts without empty delivery',
  overflowSettlement: 'RED reviewer — queue overflow settles every previously accepted semantic record in ingest order',
  writeFailureSettlement: 'RED reviewer — headless write failure settles failed and later queued semantic records exactly once',
  routerDestroy: 'RED reviewer — router destroy unregisters retained views before terminating sockets',
  incrementalLedgerAccounting: 'RED reviewer — retained ledger byte accounting never rescans the full evidence arrays on commit',
  throwingSettlerIsolation: 'RED reviewer — throwing policy settler cannot abort degradation settlement or current legacy delivery',
  observerFencingRebind: 'RED reviewer — negotiated observer stays registered, cannot mutate, and rebinds after driver disconnect',
});

const expectedFocusedTestNames = Object.freeze([
  'RED reviewer — actual headless write degradation is typed and blocks authority canary',
  'RED reviewer — actual input path rejects every stale lease identity with eight clients',
  'RED reviewer — actual input, resize, and query paths reject stale lease identity for two clients',
  'RED reviewer — degraded, overflow, and commit-failure OSC status records reject facts without empty delivery',
  'RED reviewer — failed competing mutation lease rolls back only its newly registered view',
  'RED reviewer — headless write failure settles failed and later queued semantic records exactly once',
  'RED reviewer — missing actual mutation identity stays legacy-compatible but blocks shadow canary',
  'RED reviewer — negotiated observer stays registered, cannot mutate, and rebinds after driver disconnect',
  'RED reviewer — negotiated retained lease fences actual websocket input and resize mutations',
  'RED reviewer — newline-free soft-wrap and reflow eviction advance exact oldest retained source',
  'RED reviewer — old authority identity cannot mutate replacement PTY through actual paths',
  'RED reviewer — parser-tail and eviction comparer axes fail closed without an independent baseline',
  'RED reviewer — populated Ordinal64 rollover keeps oldest retained marker epoch-qualified',
  'RED reviewer — production comparer requires an independent roundtrip baseline before principal-axis match',
  'RED reviewer — pure OSC 133 status is retained as a semantic-only source record',
  'RED reviewer — queue overflow settles every previously accepted semantic record in ingest order',
  'RED reviewer — resize advances snapshot identity without consuming PTY source sequence',
  'RED reviewer — retained ledger byte accounting never rescans the full evidence arrays on commit',
  'RED reviewer — retained operation and fact evidence ledgers stay policy-bounded',
  'RED reviewer — router destroy unregisters retained views before terminating sockets',
  'RED reviewer — sampled shadow comparer never blocks legacy delivery or mutates a replacement generation',
  'RED reviewer — shadow comparer samples only at global headless idle and enforces a low-duty interval',
  'RED reviewer — split semantic facts preserve record-local OSC BEL/ST, DSR, and repeated BEL occurrences',
  'RED reviewer — throwing policy settler cannot abort degradation settlement or current legacy delivery',
  'RED reviewer — view removal renegotiates release and resize lease rejection is observable',
  'REL_BGSTAB_007_AC10_pty_exit_is_session_terminated',
  'REL_BGSTAB_007_AC10_server_restart_is_authority_unavailable',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-1',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-10',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-2',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-3',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-6',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-7',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-9',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-1',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-2',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-3',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-4',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-5',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-6',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-7',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-8',
  'Retained server model shadow and driver lease RED contract — REL-BGSTAB-011 AC-9',
  'checkpoint negotiation is request-only and keeps legacy authority inactive',
  'lazy test-created SessionData keeps legacy resize compatibility without retained state',
  'server RED — atomic authority revision race',
  'server RED — degraded pending output preserves partial-escape authority',
  'server RED — incomplete OSC emoji cap uses UTF-8 code point bytes at N-1/N/N+1',
  'server RED — parser-tail overflow remains sticky across degraded output',
  'server RED — pending tail sequence attachment',
  'server RED — real output sequence and ready authority tokens',
  'server RED — split C1 CSI OSC and DCS stay incomplete until final ST CAN or SUB',
  'server RED — split surrogate remains lossless and conservatively incomplete until OSC terminator',
  'server RED — split terminal escape ingest',
  'server RED — unstable pending-write authority',
  'server fresh replay request is token-fenced and supersedes the pending snapshot',
  'server recovery refresh requires both replay and repair ownership tokens',
]);
const expectedFocusedTestNamesSha256 = '1e7da1ab816128c69d68e7e9e2922acdc324b65a91038429e9a0c6d8c7ba1a0f';

const retainedTestPath = testSourcePaths[0];
const partialEscapeTestPath = testSourcePaths[1];
const checkpointRouterTestPath = testSourcePaths[3];

// Each executable axis is mapped to a named semantic test. A source hash makes
// the evidence stale when that test changes. Browser retained-authority reload
// remains deliberately not-proven until PH005 activates delivery.
const coverageRegistry = Object.freeze([
  { id: 'ascii', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ['styled-normal', 'RESTORED'] },
  { id: 'cjk', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ['wide中', 'alt-screen 中'] },
  { id: 'combining', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ['e\\u0301', 'normal.cellHash'] },
  { id: 'emoji', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ['🙂', 'alternate.cellHash'] },
  { id: 'split-ansi', testName: 'server RED — split terminal escape ingest', sourcePath: partialEscapeTestPath, anchors: ["name: 'OSC+ST'", 'pendingEscapeTailAnsi'] },
  { id: 'alternate-buffer', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ["activeBuffer, 'alternate'", "activeBuffer, 'normal'"] },
  { id: 'resize-reflow', testName: retained.ac2, sourcePath: retainedTestPath, anchors: ['beforeReflow.checkpoint.normal.cellHash', 'resizeStatesAtPty'] },
  { id: 'commit-before-delivery', testName: retained.ac1, sourcePath: retainedTestPath, anchors: ['deliveryCreatedAfterCommit', "['output', 'resize']"] },
  { id: 'fact-dedup', testName: retained.ac5, sourcePath: retainedTestPath, anchors: ["['title', 'retained-title', 'committed']", "['query-request', 'DSR-6', 'rejected']"] },
  { id: 'driver-lease', testName: retained.ac6, sourcePath: retainedTestPath, anchors: ['handoffRetainedTerminalDriverLease', 'unregistered-driver-revoked'] },
  { id: 'shadow-fault-isolation', testName: retained.ac7, sourcePath: retainedTestPath, anchors: ['shadow-comparer-mismatch', 'model-degradation', 'driver-lease-failure'] },
  { id: 'ai-tui-idle-invariant', testName: retained.ac8, sourcePath: retainedTestPath, anchors: ['ai-tui-idle-invariant', 'substantive-agent-output'] },
  { id: 'typed-budget-separation', testName: retained.rel7ac6, sourcePath: retainedTestPath, anchors: ['aggregateModelMemory', 'perClientInflight', 'browserWriteSlice'] },
  { id: 'slow-client-eviction-gap', testName: retained.rel7ac7, sourcePath: retainedTestPath, anchors: ['fast-view', 'slow-view', 'retention-limit'] },
  { id: 'one-client', testName: retained.rel7ac10, sourcePath: retainedTestPath, anchors: ['browser-a', 'viewGeneration, 2'] },
  { id: 'two-client', testName: retained.ac6, sourcePath: retainedTestPath, anchors: ['client-a', 'client-b'] },
  { id: 'eight-client', testName: retained.rel7ac9, sourcePath: retainedTestPath, anchors: ['index < 8', 'client-7'] },
  {
    id: 'no-local-cache-retained-authority-reload',
    status: 'not-proven',
    sourcePath: 'frontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts',
    reason: 'legacy hard-refresh characterization exists, but retained checkpoint delivery is inactive until PH005',
  },
  { id: 'server-restart-unavailable', testName: retained.restart, sourcePath: retainedTestPath, anchors: ['server-restart-or-session-missing', 'freshManager'] },
  { id: 'pty-exit-terminated', testName: retained.exit, sourcePath: retainedTestPath, anchors: ['process-exit', 'emitExit(23)'] },
  { id: 'lifecycle-cleanup', testName: retained.ac9, sourcePath: retainedTestPath, anchors: ['rejectedLateMessages: 4', 'cleanup-generation-replace', 'tab-restart'] },
  { id: 'independent-roundtrip-comparer', testName: retained.independentComparer, sourcePath: retainedTestPath, anchors: ['independentBaselineMatches', 'independent-baseline-unavailable'] },
  { id: 'stateful-split-semantic-facts', testName: retained.splitSemantic, sourcePath: retainedTestPath, anchors: ['split-st-title', 'sameRecordBells'] },
  { id: 'newline-free-soft-wrap-reflow', testName: retained.softWrap, sourcePath: retainedTestPath, anchors: ['expectedOldestSourceSeq', 'reflowAdvancedEviction'] },
  { id: 'actual-two-client-mutation-fence', testName: retained.actualTwoClient, sourcePath: retainedTestPath, anchors: ['staleInputResults', 'staleResizeResults'] },
  { id: 'actual-eight-client-mutation-fence', testName: retained.actualEightClient, sourcePath: retainedTestPath, anchors: ['staleResults', 'ptyWrites: 0'] },
  { id: 'missing-identity-fail-closed', testName: retained.missingIdentity, sourcePath: retainedTestPath, anchors: ['mutation-identity-missing', 'eligible: false'] },
  { id: 'replacement-authority-fence', testName: retained.replacementFence, sourcePath: retainedTestPath, anchors: ['late-old-generation-input', 'replacementWrites: 0'] },
  { id: 'resize-snapshot-identity', testName: retained.resizeIdentity, sourcePath: retainedTestPath, anchors: ['snapshotsMonotonic', 'uniqueSnapshotIdentities: 3'] },
  { id: 'typed-model-degradation', testName: retained.degradation, sourcePath: retainedTestPath, anchors: ["availability: 'authority-degraded'", "phase: 'write'"] },
  { id: 'websocket-mutation-lease', testName: retained.websocketLease, sourcePath: checkpointRouterTestPath, anchors: ['mutationLeases', 'checkpoint-client'] },
  { id: 'populated-ordinal64-rollover', testName: retained.populatedRollover, sourcePath: retainedTestPath, anchors: ['oldestRetainedStreamEpoch', 'cross-epoch-retention-unavailable', "retainedRecords: [['8', '0']]"] },
  { id: 'failed-contender-view-rollback', testName: retained.failedContender, sourcePath: retainedTestPath, anchors: ['fresh-contender', 'pre-registered-contender', 'driver-owned-by-other-client'] },
  { id: 'global-idle-low-duty-comparer', testName: retained.globalIdleComparer, sourcePath: retainedTestPath, anchors: ['busy-comparer-sibling', 'comparer ran while a sibling session was busy', 'minimum sampling interval'] },
  { id: 'oversized-semantic-key-bounded', testName: retained.boundedLedger, sourcePath: retainedTestPath, anchors: ['64 * 1024', 'bytes=65536', 'semanticKeyMaxBytes'] },
  { id: 'degraded-semantic-fallback-settlement', testName: retained.degradedSemanticFallback, sourcePath: retainedTestPath, anchors: ['semantic-only-already-degraded', "rejectionReason: 'model-degraded'", 'emptyDeliveries: 0'] },
  { id: 'pending-overflow-semantic-settlement', testName: retained.overflowSettlement, sourcePath: retainedTestPath, anchors: ['pending-semantic-overflow-settlement', "['4', false, 'queue-overflow']", "['4', 'command-end', 'rejected']"] },
  { id: 'queued-write-failure-semantic-settlement', testName: retained.writeFailureSettlement, sourcePath: retainedTestPath, anchors: ['pending-semantic-write-settlement', "['4', false, 'commit-failed']", "['4', 'command-end', 'rejected']"] },
  { id: 'router-destroy-view-cleanup', testName: retained.routerDestroy, sourcePath: checkpointRouterTestPath, anchors: ['unregister:destroy-session:destroy-client:9', "'terminate'", 'internals.clients.size'] },
  { id: 'incremental-ledger-byte-accounting', testName: retained.incrementalLedgerAccounting, sourcePath: retainedTestPath, anchors: ['fullArrayStringifyCalls', 'state.ledger.encodedBytes', 'incremental byte count was not exact'] },
  { id: 'throwing-settler-isolation', testName: retained.throwingSettlerIsolation, sourcePath: retainedTestPath, anchors: ['forced first settler failure', 'settlerAttempts: 2', 'currentLegacyDelivered: true'] },
  { id: 'negotiated-observer-fencing-rebind', testName: retained.observerFencingRebind, sourcePath: checkpointRouterTestPath, anchors: ['observerCapability.mutationLeases', "ownerClientId, 'driver-client'", 'accepted-after-rebind'] },
]);

const expectedCoverageAxisIds = Object.freeze([
  'actual-eight-client-mutation-fence',
  'actual-two-client-mutation-fence',
  'ai-tui-idle-invariant',
  'alternate-buffer',
  'ascii',
  'cjk',
  'combining',
  'commit-before-delivery',
  'degraded-semantic-fallback-settlement',
  'driver-lease',
  'eight-client',
  'emoji',
  'fact-dedup',
  'failed-contender-view-rollback',
  'global-idle-low-duty-comparer',
  'incremental-ledger-byte-accounting',
  'independent-roundtrip-comparer',
  'lifecycle-cleanup',
  'missing-identity-fail-closed',
  'negotiated-observer-fencing-rebind',
  'newline-free-soft-wrap-reflow',
  'no-local-cache-retained-authority-reload',
  'one-client',
  'oversized-semantic-key-bounded',
  'pending-overflow-semantic-settlement',
  'populated-ordinal64-rollover',
  'pty-exit-terminated',
  'queued-write-failure-semantic-settlement',
  'replacement-authority-fence',
  'resize-reflow',
  'resize-snapshot-identity',
  'router-destroy-view-cleanup',
  'server-restart-unavailable',
  'shadow-fault-isolation',
  'slow-client-eviction-gap',
  'split-ansi',
  'stateful-split-semantic-facts',
  'throwing-settler-isolation',
  'two-client',
  'typed-budget-separation',
  'typed-model-degradation',
  'websocket-mutation-lease',
]);
const expectedCoverageAxisIdsSha256 = 'e45cb0525ad44a3b2b22e02439efaefd3eba0744b9fe582206675babec912573';

const thresholds = Object.freeze({
  focused: Object.freeze({ exactTests: 57, maximumFailures: 0, maximumSkipped: 0 }),
  coverage: Object.freeze({
    exactAxes: 42,
    axisIdsSha256: expectedCoverageAxisIdsSha256,
    maximumFailed: 0,
    maximumMissing: 0,
  }),
  inputHashes: Object.freeze({ maximumMissing: 0, maximumMismatches: 0 }),
});

function absolute(repositoryPath) {
  assert.equal(isAbsolute(repositoryPath), false, `expected repository-relative path: ${repositoryPath}`);
  assert.doesNotMatch(repositoryPath, /\\/u, `expected POSIX repository path: ${repositoryPath}`);
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
  return readBytes(repositoryPath).toString('utf8').replace(/^\uFEFF/u, '');
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

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashesFor(paths) {
  return Object.fromEntries([...new Set(paths)].sort((left, right) => left.localeCompare(right))
    .map(path => [path, sha256(readBytes(path))]));
}

function decodeOutput(value) {
  if (!value) return '';
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const looksUtf16Le = (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0);
  return bytes.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
}

function runFocused(command) {
  const result = spawnSync(command.executable, [...command.args], {
    cwd: absolute(command.cwd),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command.value} terminated by signal ${result.signal}`);
  assert.equal(result.status, 0, `${command.value} failed\n${stdout}\n${stderr}`);
  return Object.freeze({ stdout, stderr, exitCode: result.status });
}

function parseTapCount(output, key) {
  const matches = [...output.matchAll(new RegExp(`(?:^|\\n)(?:#|ℹ)?\\s*${key}\\s+(\\d+)\\s*(?:\\n|$)`, 'gu'))];
  assert.equal(matches.length, 1, `focused TAP output must contain exactly one ${key} count`);
  const value = Number.parseInt(matches[0][1], 10);
  assert.equal(Number.isSafeInteger(value) && value >= 0, true, `focused TAP ${key} is invalid`);
  return value;
}

function summarizeFocused(result) {
  const executed = new Map();
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/gu, '');
    const tap = line.match(/^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/u);
    const spec = line.match(/^(✔|✖)\s+(.+?)\s+\([^)]*ms\)$/u);
    const match = tap
      ? { status: tap[1] === 'ok' ? 'pass' : 'fail', name: tap[2] }
      : spec
        ? { status: spec[1] === '✔' ? 'pass' : 'fail', name: spec[2] }
        : undefined;
    if (!match) continue;
    assert.equal(executed.has(match.name), false, `duplicate focused test name: ${match.name}`);
    executed.set(match.name, match.status);
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
    'focused TAP summary is internally inconsistent');
  assert.equal(executed.size, summary.total, 'focused TAP named-test count differs from total');
  return Object.freeze({ summary, executed });
}

function extractNamedTestBody(source, testName, sourcePath = 'inline-evidence-self-test.ts') {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.equal(sourceFile.parseDiagnostics.length, 0,
    `coverage source must parse before named test extraction: ${sourcePath}`);
  const bodies = [];
  const visit = node => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'test'
      && node.arguments.length > 0) {
      const name = node.arguments[0];
      if ((ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
        && name.text === testName) {
        const callback = node.arguments.find(argument => ts.isArrowFunction(argument)
          || ts.isFunctionExpression(argument));
        assert.notEqual(callback, undefined, `named test callback is missing: ${sourcePath}: ${testName}`);
        assert.equal(ts.isBlock(callback.body), true,
          `named test callback must use a block body: ${sourcePath}: ${testName}`);
        bodies.push(source.slice(callback.body.getStart(sourceFile), callback.body.end));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.equal(bodies.length, 1,
    `coverage source must contain exactly one named test body: ${sourcePath}: ${testName}`);
  return bodies[0];
}

function assertExactFocusedTestIdentity(executed, expectedNames = expectedFocusedTestNames) {
  const sortedExpected = [...expectedNames].sort(compareCodeUnits);
  assert.deepEqual([...expectedNames], sortedExpected, 'focused test allowlist must stay sorted');
  assert.equal(new Set(expectedNames).size, expectedNames.length, 'focused test allowlist contains duplicates');
  const actualNames = [...executed.keys()].sort(compareCodeUnits);
  assert.deepEqual(actualNames, sortedExpected, 'focused test identity mismatch');
  return Object.freeze({
    names: Object.freeze(actualNames),
    sha256: canonicalSha256(actualNames),
  });
}

function assertExactCoverageAxisIdentity(axisIds, expectedIds = expectedCoverageAxisIds) {
  const sortedExpected = [...expectedIds].sort(compareCodeUnits);
  assert.deepEqual([...expectedIds], sortedExpected, 'coverage axis allowlist must stay sorted');
  assert.equal(new Set(expectedIds).size, expectedIds.length, 'coverage axis allowlist contains duplicates');
  const actualIds = [...axisIds].sort(compareCodeUnits);
  assert.equal(new Set(actualIds).size, actualIds.length, 'coverage output contains duplicate axis IDs');
  assert.deepEqual(actualIds, sortedExpected, 'coverage axis identity mismatch');
  return Object.freeze({
    axisIds: Object.freeze(actualIds),
    sha256: canonicalSha256(actualIds),
  });
}

function runEvidenceToolSelfTests() {
  const fixture = [
    "test('target test', () => { const localAnchor = 'inside-target'; });",
    "test('other test', () => { const displacedAnchor = 'outside-target-only'; });",
  ].join('\n');
  const targetBody = extractNamedTestBody(fixture, 'target test');
  assert.equal(targetBody.includes('inside-target'), true);
  assert.equal(targetBody.includes('outside-target-only'), false,
    'a coverage anchor from another named test must not satisfy the target test');
  assert.throws(
    () => assertExactFocusedTestIdentity(new Map([['replacement test', 'pass']]), ['target test']),
    /focused test identity mismatch/u,
  );
  assert.equal(canonicalSha256(expectedFocusedTestNames), expectedFocusedTestNamesSha256,
    'focused test allowlist hash changed without an explicit evidence contract update');
  assert.equal(expectedCoverageAxisIds.length, 42, 'coverage axis allowlist literal count changed');
  assert.equal(canonicalSha256(expectedCoverageAxisIds), expectedCoverageAxisIdsSha256,
    'coverage axis allowlist hash changed without an explicit evidence contract update');
  assert.equal(thresholds.coverage.exactAxes, 42,
    'coverage threshold must remain an independent literal count');
  assert.equal(thresholds.coverage.axisIdsSha256, expectedCoverageAxisIdsSha256,
    'coverage threshold must pin the independent axis allowlist hash');
  const registeredTestPasses = new Map(coverageRegistry
    .filter(spec => spec.testName)
    .map(spec => [spec.testName, 'pass']));
  const boundCoverage = buildCoverage(registeredTestPasses);
  assert.equal(boundCoverage.length, 42,
    'every registered coverage axis must pass named-test body binding self-validation');
  const boundIdentity = assertExactCoverageAxisIdentity(boundCoverage.map(row => row.axis));
  assert.equal(boundIdentity.sha256, expectedCoverageAxisIdsSha256,
    'coverage registry differs from the exact axis allowlist hash');
  assert.throws(
    () => assertExactCoverageAxisIdentity(boundCoverage.slice(1).map(row => row.axis)),
    /coverage axis identity mismatch/u,
    'removing a coverage axis must fail the exact identity contract',
  );
  const replacementAxisIds = boundCoverage.map(row => row.axis);
  replacementAxisIds[0] = 'replacement-axis-id';
  assert.throws(
    () => assertExactCoverageAxisIdentity(replacementAxisIds),
    /coverage axis identity mismatch/u,
    'replacing a coverage axis ID must fail even when the total count is unchanged',
  );
}

function buildCoverage(executed) {
  const sourceCache = new Map();
  const bodyCache = new Map();
  return coverageRegistry.map(spec => {
    if (spec.status === 'not-proven') {
      const source = sourceCache.get(spec.sourcePath) ?? readUtf8(spec.sourcePath);
      sourceCache.set(spec.sourcePath, source);
      return Object.freeze({
        axis: spec.id,
        status: 'not-proven',
        reason: spec.reason,
        rawEvidencePath: spec.sourcePath,
        rawEvidenceSha256: sha256(Buffer.from(source, 'utf8')),
      });
    }
    assert.equal(executed.get(spec.testName), 'pass', `coverage test did not pass: ${spec.testName}`);
    const source = sourceCache.get(spec.sourcePath) ?? readUtf8(spec.sourcePath);
    sourceCache.set(spec.sourcePath, source);
    const bodyKey = `${spec.sourcePath}\u0000${spec.testName}`;
    const testBody = bodyCache.get(bodyKey)
      ?? extractNamedTestBody(source, spec.testName, spec.sourcePath);
    bodyCache.set(bodyKey, testBody);
    for (const anchor of spec.anchors) {
      assert.equal(testBody.includes(anchor), true,
        `coverage named-test body anchor missing: ${spec.id}: ${spec.testName}: ${anchor}`);
    }
    return Object.freeze({
      axis: spec.id,
      status: 'pass',
      testName: spec.testName,
      rawEvidencePath: spec.sourcePath,
      rawEvidenceSha256: sha256(Buffer.from(source, 'utf8')),
      namedTestBodySha256: sha256(Buffer.from(testBody, 'utf8')),
      assertionAnchorsSha256: canonicalSha256(spec.anchors),
    });
  });
}

function evaluateGate({ candidateThresholds, focused, coverage, missingInputs, hashMismatches }) {
  const required = [
    candidateThresholds?.focused?.exactTests,
    candidateThresholds?.focused?.maximumFailures,
    candidateThresholds?.focused?.maximumSkipped,
    candidateThresholds?.coverage?.exactAxes,
    candidateThresholds?.coverage?.maximumFailed,
    candidateThresholds?.coverage?.maximumMissing,
    candidateThresholds?.inputHashes?.maximumMissing,
    candidateThresholds?.inputHashes?.maximumMismatches,
  ];
  if (required.some(value => !Number.isSafeInteger(value) || value < 0)) {
    return Object.freeze({ eligible: false, reason: 'threshold-missing' });
  }
  if (!/^[a-f0-9]{64}$/u.test(candidateThresholds?.coverage?.axisIdsSha256 ?? '')) {
    return Object.freeze({ eligible: false, reason: 'threshold-missing' });
  }
  if (missingInputs > candidateThresholds.inputHashes.maximumMissing
    || hashMismatches > candidateThresholds.inputHashes.maximumMismatches) {
    return Object.freeze({ eligible: false, reason: 'input-hash-threshold-failed' });
  }
  if (focused.total !== candidateThresholds.focused.exactTests
    || focused.failed > candidateThresholds.focused.maximumFailures
    || focused.cancelled + focused.skipped + focused.todo > candidateThresholds.focused.maximumSkipped) {
    return Object.freeze({ eligible: false, reason: 'focused-test-threshold-failed' });
  }
  const registeredAxisIds = coverage.map(row => row.axis);
  const registeredAxes = new Set(registeredAxisIds);
  const expectedAxes = new Set(expectedCoverageAxisIds);
  const missingAxes = expectedCoverageAxisIds.filter(id => !registeredAxes.has(id)).length;
  const unexpectedAxes = registeredAxisIds.filter(id => !expectedAxes.has(id)).length;
  const axisIdsSha256 = canonicalSha256([...registeredAxisIds].sort(compareCodeUnits));
  if (coverage.length !== candidateThresholds.coverage.exactAxes
    || registeredAxes.size !== coverage.length
    || missingAxes > candidateThresholds.coverage.maximumMissing
    || unexpectedAxes > 0
    || axisIdsSha256 !== candidateThresholds.coverage.axisIdsSha256) {
    return Object.freeze({ eligible: false, reason: 'coverage-threshold-failed' });
  }
  if (coverage.some(row => row.axis === 'no-local-cache-retained-authority-reload'
    && row.status === 'not-proven')) {
    return Object.freeze({ eligible: false, reason: 'no-local-cache-retained-authority-unproven' });
  }
  const failedAxes = coverage.filter(row => row.status !== 'pass').length;
  if (failedAxes > candidateThresholds.coverage.maximumFailed) {
    return Object.freeze({ eligible: false, reason: 'coverage-threshold-failed' });
  }
  return Object.freeze({ eligible: true, reason: 'all-retained-shadow-parity-thresholds-passed' });
}

runEvidenceToolSelfTests();
if (process.argv.includes('--self-test')) {
  process.stdout.write(`${JSON.stringify({ selfTest: 'pass', evidenceToolPath })}\n`);
  process.exit(0);
}

const focusedRun = runFocused(focusedCommand);
const { summary: focusedSummary, executed } = summarizeFocused(focusedRun);
const focusedIdentity = assertExactFocusedTestIdentity(executed);
assert.equal(focusedIdentity.sha256, expectedFocusedTestNamesSha256,
  'focused test execution hash differs from the exact allowlist hash');
const coverage = Object.freeze(buildCoverage(executed));
const coverageIdentity = assertExactCoverageAxisIdentity(coverage.map(row => row.axis));
assert.equal(coverageIdentity.sha256, expectedCoverageAxisIdsSha256,
  'coverage execution hash differs from the exact axis allowlist hash');

const inputHashes = hashesFor(inputPaths);
const configHashes = hashesFor(configPaths);
const productionSourceHashes = hashesFor(productionSourcePaths);
const rawEvidencePaths = Object.freeze([...new Set([...testSourcePaths, ...inputPaths, ...configPaths, ...productionSourcePaths])]
  .sort((left, right) => left.localeCompare(right)));

const actualGate = evaluateGate({
  candidateThresholds: thresholds,
  focused: focusedSummary,
  coverage,
  missingInputs: 0,
  hashMismatches: 0,
});
assert.deepEqual(actualGate, {
  eligible: false,
  reason: 'no-local-cache-retained-authority-unproven',
});

const failClosedProofs = Object.freeze({
  missingThreshold: evaluateGate({
    candidateThresholds: { ...thresholds, coverage: { ...thresholds.coverage, exactAxes: undefined } },
    focused: focusedSummary, coverage, missingInputs: 0, hashMismatches: 0,
  }),
  failedFocusedTest: evaluateGate({
    candidateThresholds: thresholds,
    focused: { ...focusedSummary, passed: focusedSummary.passed - 1, failed: 1 },
    coverage, missingInputs: 0, hashMismatches: 0,
  }),
  missingCoverageAxis: evaluateGate({
    candidateThresholds: thresholds,
    focused: focusedSummary,
    coverage: coverage.slice(1),
    missingInputs: 0, hashMismatches: 0,
  }),
  replacedCoverageAxisId: evaluateGate({
    candidateThresholds: thresholds,
    focused: focusedSummary,
    coverage: coverage.map((row, index) => index === 0
      ? Object.freeze({ ...row, axis: 'replacement-axis-id' })
      : row),
    missingInputs: 0, hashMismatches: 0,
  }),
  inputHashMismatch: evaluateGate({
    candidateThresholds: thresholds,
    focused: focusedSummary, coverage, missingInputs: 0, hashMismatches: 1,
  }),
});
assert.deepEqual(failClosedProofs, {
  missingThreshold: { eligible: false, reason: 'threshold-missing' },
  failedFocusedTest: { eligible: false, reason: 'focused-test-threshold-failed' },
  missingCoverageAxis: { eligible: false, reason: 'coverage-threshold-failed' },
  replacedCoverageAxisId: { eligible: false, reason: 'coverage-threshold-failed' },
  inputHashMismatch: { eligible: false, reason: 'input-hash-threshold-failed' },
});

const artifact = {
  schemaVersion: 'retained-shadow-parity-evidence/v1',
  requirementIds: ['REL-BGSTAB-011', 'REL-BGSTAB-007'],
  phaseId: 'PH-004',
  taskIds: ['T-PH004-03', 'T-PH004-04'],
  capturedAt: new Date().toISOString(),
  invocation,
  focusedRun: {
    cwd: focusedCommand.cwd,
    command: focusedCommand.value,
    exitCode: focusedRun.exitCode,
    ...focusedSummary,
    stdoutSha256: sha256(Buffer.from(focusedRun.stdout, 'utf8')),
    stderrSha256: sha256(Buffer.from(focusedRun.stderr, 'utf8')),
    passedTestNames: focusedIdentity.names,
    passedTestNamesSha256: focusedIdentity.sha256,
    expectedTestNamesSha256: expectedFocusedTestNamesSha256,
  },
  rawEvidencePaths,
  inputHashes: { files: inputHashes, sourceSetSha256: canonicalSha256(inputHashes), missing: 0, mismatches: 0 },
  configHashes: { files: configHashes, sourceSetSha256: canonicalSha256(configHashes), missing: 0, mismatches: 0 },
  productionSourceHashes: { files: productionSourceHashes, sourceSetSha256: canonicalSha256(productionSourceHashes), missing: 0, mismatches: 0 },
  evidenceTool: { path: evidenceToolPath, sha256: sha256(readBytes(evidenceToolPath)) },
  coverageIdentity: {
    axisIds: coverageIdentity.axisIds,
    axisIdsSha256: coverageIdentity.sha256,
    expectedAxisIdsSha256: expectedCoverageAxisIdsSha256,
  },
  coverage,
  activationGate: { thresholds, actual: actualGate, failClosedProofs },
  verdict: 'PASS_FAIL_CLOSED',
};

mkdirSync(dirname(absolute(artifactPath)), { recursive: true });
writeFileSync(absolute(artifactPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
assert.deepEqual(JSON.parse(readUtf8(artifactPath)), artifact, 'retained shadow parity artifact round-trip failed');

process.stdout.write(`${JSON.stringify({
  phaseId: artifact.phaseId,
  taskIds: artifact.taskIds,
  focused: { total: focusedSummary.total, passed: focusedSummary.passed, failed: focusedSummary.failed },
  coverageAxes: coverage.length,
  activationGate: actualGate,
  artifactPath,
  verdict: artifact.verdict,
})}\n`);

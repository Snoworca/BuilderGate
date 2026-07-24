import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { queryProcessInfo } = require('../daemon/process-info.js');
const analysisRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const artifactPath = `${analysisRoot}/authority-promotion-decision.json`;
const rawExecutionRoot = `${analysisRoot}/authority-promotion-raw`;
const retainedShadowBaselinePath = `${analysisRoot}/retained-shadow-parity.json`;
const retainedShadowBaselineExpectedSha256 =
  '9914e22418e315184ef7cdc315b95b57d693efbe6ad6f84da144ac59a248e265';
const evidenceToolPath = 'tools/wave3/authority-promotion-evidence.test.mjs';
const daemonStatePath = 'runtime/buildergate.daemon.json';
const redTestSourceManifestPath = 'tools/wave3/authority-promotion-red-test-sources.json';
const schemaVersion = 'authority-promotion-evidence/v2';
const sidecarPath = 'docs/plans/2026-07-16.projectmaster.wave3-authority.sidecar.json';
const e2eAggregateTestSymbol =
  'PH005 authority promotion E2E exact six-case contract and fail-closed artifact writer';
const e2eAggregateFailureSignature =
  'MIG-BGSTAB-002 PH005 exact six-case E2E contract missing';
const liveRequestAttemptLog = [];

const testSourcePaths = Object.freeze([
  'server/src/services/TerminalAuthorityController.test.ts',
  'server/src/types/wsCheckpointProtocol.test.ts',
  'server/src/utils/terminalQueryResponder.test.ts',
  'server/src/ws/WsRouterRestoreMetadata.test.ts',
  'frontend/tests/unit/terminalCheckpointRuntime.test.ts',
  'frontend/tests/unit/terminalInputSequencer.test.ts',
  'frontend/tests/unit/terminalQueryReply.test.ts',
  'frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts',
  'server/src/services/TerminalAuthorityDebugService.test.ts',
  'server/src/services/SessionManagerTerminalAuthorityRuntimePorts.test.ts',
  'server/src/ws/WsRouterSplitHandshake.test.ts',
]);

const rawEvidenceDependencyPaths = Object.freeze([
  'tools/daemon/process-info.js',
  'frontend/tests/e2e/helpers.ts',
]);

const guardTestSourcePath = 'server/src/routes/terminalAuthorityDebugRoutes.guard.test.ts';
const guardTestNames = sorted([
  'terminal authority debug routes register the exact three mutation paths with one fixed guard chain',
  'terminal authority debug route authentication rejection short-circuits locality session and handler',
  'terminal authority debug route remote rejection short-circuits session lookup and handler',
  'terminal authority debug route runs session guard before handler and rejects a missing session',
  'terminal authority debug route invokes the handler only after auth locality and existing-session guards',
]);

const inputPaths = Object.freeze([
  'docs/plans/2026-07-16.projectmaster.wave3-authority.plan.md',
  'docs/plans/2026-07-16.projectmaster.wave3-authority.sidecar.json',
  'docs/spec/00.index.md',
  'docs/spec/30.buildergate-stability.srs.md',
  redTestSourceManifestPath,
]);

const configPaths = Object.freeze([
  'server/package.json',
  'server/package-lock.json',
  'server/config.json5.example',
  'server/src/schemas/config.schema.ts',
  'server/src/types/config.types.ts',
  'server/src/utils/config.ts',
  'frontend/playwright.config.ts',
  'frontend/package.json',
  'frontend/package-lock.json',
]);

const productionSourcePaths = Object.freeze([
  'server/src/index.ts',
  'server/src/middleware/debugCaptureGuards.ts',
  'server/src/routes/terminalAuthorityDebugRoutes.ts',
  'server/src/services/TerminalAuthorityController.ts',
  'server/src/services/TerminalAuthorityDebugService.ts',
  'server/src/services/TerminalAuthorityProductionAdapter.ts',
  'server/src/services/SessionManager.ts',
  'server/src/utils/headlessTerminal.ts',
  'server/src/utils/terminalPartialEscapeTail.ts',
  'server/src/utils/terminalQueryResponder.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/types/ws-protocol.ts',
  'frontend/src/utils/terminalCheckpointRuntime.ts',
  'frontend/src/utils/terminalDebugCapture.ts',
  'frontend/src/utils/terminalQueryReply.ts',
  'frontend/src/utils/terminalRetainedState.ts',
  'frontend/src/utils/terminalSnapshot.ts',
  'frontend/src/utils/terminalWriteCoordinator.ts',
  'frontend/src/utils/terminalWriteCoordinatorRuntime.ts',
  'frontend/src/utils/terminalRawMutationAdapter.ts',
  'frontend/src/utils/terminalReplayGuard.ts',
  'frontend/src/utils/terminalInputSequencer.ts',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/types/ws-protocol.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
]);

const newProductionPathsExpectedAbsentInRed = Object.freeze([
  'server/src/routes/terminalAuthorityDebugRoutes.ts',
  'server/src/services/TerminalAuthorityController.ts',
  'server/src/services/TerminalAuthorityProductionAdapter.ts',
  'server/src/utils/terminalQueryResponder.ts',
  'frontend/src/utils/terminalQueryReply.ts',
]);

const redFrontendSourceBaseline = Object.freeze({
  'frontend/src/utils/terminalCheckpointRuntime.ts': '362ba768d570452c8dcfaa8b8e1802bb770d86d0c2beabdcd36da9a42c2b8a66',
  'frontend/src/utils/terminalDebugCapture.ts': 'f96077cf34154de216afe5be63f7715db6a508d51062f677445285f1d5cc97a6',
  'frontend/src/utils/terminalInputSequencer.ts': '44169c99afe643d9f6e0f0cd13ae5d31a5422d9a62db90614f1f65e15af45f98',
  'frontend/src/utils/terminalRetainedState.ts': 'd66710856c229b0cc1f5099fa54a10fc785ea69d9be1050d91fcd57703058f23',
  'frontend/src/utils/terminalSnapshot.ts': '75f7d8e1aebfcdbf41692780bce1d9acd1ca893c2b3b34eaa73c1ec4f27b98ca',
  'frontend/src/utils/terminalWriteCoordinatorRuntime.ts': '822e2d4f37f7db9e6bd082ca5ca315865ed4be4aed413d75c3c002e5bcbb55e2',
  'frontend/src/contexts/WebSocketContext.tsx': '5f2adc9176c77a8149f5804134694dce59cb73a346e006370ea94e5fe4eb8ca5',
  'frontend/src/components/Terminal/TerminalView.tsx': '1ba5256b852d5f37ac6e6ef9a1a21f0a65c483398018361b66ecf4f515cccd64',
  'frontend/src/components/Terminal/TerminalContainer.tsx': 'a43d90902c12577527c8624b1dce626458901426e4651a11f486175841f07f42',
  'frontend/src/types/ws-protocol.ts': '19c562ac5c550eaf8464ebadfcfdfab1deaaf580563d2631a9bdda8ff905ec6c',
  'frontend/src/utils/visibleOutputRecovery.ts': '447eb2eb50c95f3b7cd4a36150aa9f6119701ff3a14c69c6151428903f82113b',
});

const redAdditionalServerSourceBaseline = Object.freeze({
  'server/src/index.ts': 'c01462baf96394d5c11dc125f8f34822abe6c53531f4ffa5780d2d12c94bcdf9',
});

const redExpectedProductionGitStatusLines = Object.freeze([
  ' M frontend/src/components/Terminal/TerminalContainer.tsx',
  ' M frontend/src/components/Terminal/TerminalView.tsx',
  ' M frontend/src/contexts/WebSocketContext.tsx',
  ' M frontend/src/types/ws-protocol.ts',
  ' M frontend/src/utils/terminalDebugCapture.ts',
  ' M frontend/src/utils/visibleOutputRecovery.ts',
  ' M server/src/services/SessionManager.ts',
  ' M server/src/index.ts',
  ' M server/src/types/ws-protocol.ts',
  ' M server/src/utils/headlessTerminal.ts',
  ' M server/src/ws/WsRouter.ts',
  '?? frontend/src/utils/terminalCheckpointRuntime.ts',
  '?? frontend/src/utils/terminalRetainedState.ts',
  '?? frontend/src/utils/terminalWriteCoordinatorRuntime.ts',
]);

const serverCommand = Object.freeze({
  cwd: 'server',
  value: 'npx tsx --test --test-reporter=tap src/ws/WsRouterRestoreMetadata.test.ts src/services/TerminalAuthorityController.test.ts src/types/wsCheckpointProtocol.test.ts src/utils/terminalQueryResponder.test.ts',
  executable: process.execPath,
  args: Object.freeze([
    absolute('server/node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    'src/ws/WsRouterRestoreMetadata.test.ts',
    'src/services/TerminalAuthorityController.test.ts',
    'src/types/wsCheckpointProtocol.test.ts',
    'src/utils/terminalQueryResponder.test.ts',
  ]),
});

const frontendCommand = Object.freeze({
  cwd: 'frontend',
  value: 'node --experimental-strip-types --test --test-reporter=tap tests/unit/terminalCheckpointRuntime.test.ts tests/unit/terminalInputSequencer.test.ts tests/unit/terminalQueryReply.test.ts',
  executable: process.execPath,
  args: Object.freeze([
    '--experimental-strip-types',
    '--test',
    '--test-reporter=tap',
    'tests/unit/terminalCheckpointRuntime.test.ts',
    'tests/unit/terminalInputSequencer.test.ts',
    'tests/unit/terminalQueryReply.test.ts',
  ]),
});

const guardCommand = Object.freeze({
  cwd: 'server',
  value: 'npx tsx --test --test-reporter=tap src/routes/terminalAuthorityDebugRoutes.guard.test.ts',
  executable: process.execPath,
  args: Object.freeze([
    absolute('server/node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    'src/routes/terminalAuthorityDebugRoutes.guard.test.ts',
  ]),
});

const extendedRegressionCommand = Object.freeze({
  cwd: 'server',
  value: 'npx tsx --test --test-reporter=tap src/services/TerminalAuthorityDebugService.test.ts src/services/SessionManagerTerminalAuthorityRuntimePorts.test.ts',
  executable: process.execPath,
  args: Object.freeze([
    absolute('server/node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    'src/services/TerminalAuthorityDebugService.test.ts',
    'src/services/SessionManagerTerminalAuthorityRuntimePorts.test.ts',
  ]),
});

const stalePredecessorTopologyTestName =
  'MIG-BGSTAB-002 responder topology selects only the newest open hard-reload control socket';
const stalePredecessorCommand = Object.freeze({
  cwd: 'server',
  value: `npx tsx --test --test-reporter=tap --test-name-pattern "${stalePredecessorTopologyTestName}" src/ws/WsRouterSplitHandshake.test.ts`,
  executable: process.execPath,
  args: Object.freeze([
    absolute('server/node_modules/tsx/dist/cli.mjs'),
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern',
    `^${stalePredecessorTopologyTestName}$`,
    'src/ws/WsRouterSplitHandshake.test.ts',
  ]),
});

const e2eCommand = Object.freeze({
  cwd: 'frontend',
  value: 'npx playwright test tests/e2e/wave3-terminal-authority-promotion.spec.ts --project "Desktop Chrome" --grep "(positional all-view handoff|query byte parity and seed silence|poisoned no-cache reload|compatibility-drain rollback|stale reconnect no-replay|fault PTY/AI idle)" --reporter=json --workers=1 --retries=0',
  executable: process.execPath,
  args: Object.freeze([
    absolute('frontend/node_modules/@playwright/test/cli.js'),
    'test',
    'tests/e2e/wave3-terminal-authority-promotion.spec.ts',
    '--project',
    'Desktop Chrome',
    '--grep',
    '(positional all-view handoff|query byte parity and seed silence|poisoned no-cache reload|compatibility-drain rollback|stale reconnect no-replay|fault PTY/AI idle)',
    '--reporter=json',
    '--workers=1',
    '--retries=0',
  ]),
  environment: Object.freeze({ PLAYWRIGHT_BASE_URL: 'https://localhost:2222' }),
});

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values) {
  return Object.freeze([...values].sort(compareCodeUnits));
}

const serverRestoreCompatibilityNames = sorted([
  'server RED — real output sequence and ready authority tokens',
  'server fresh replay request is token-fenced and supersedes the pending snapshot',
  'server recovery refresh requires both replay and repair ownership tokens',
]);

const serverCheckpointProtocolNames = sorted([
  'checkpoint client contract accepts negotiate and apply/drain/failure ACK frames',
  'checkpoint ACK contract rejects number, noncanonical, out-of-range and inconsistent ordinals',
]);

const serverCompatibilityNames = sorted([
  ...serverRestoreCompatibilityNames,
  ...serverCheckpointProtocolNames,
]);

const frontendCompatibilityNames = sorted([
  'production terminal digest is real SHA-256, not the characterization FNV digest',
  'server validates negotiated view registrations and explicit recovery requests',
  'mode rehydrate uses a deterministic supported escape prefix in the checkpoint physical write',
  'dispatcher remains dormant for passive capability and never mutates or success-ACKs',
  'per-session dispatcher replacement fail-closes the old active generation',
  'active per-session ingress submits start/chunk/commit/output and input to one coordinator',
  'capability withdrawal atomically rolls recovery into a clean legacy generation',
  'explicit runtime rollback and null capability are idempotent legacy transitions',
  'runtime replacement rehydrates legacy recovery without duplicating an in-flight reconnect',
  'active capability is scoped to its negotiated session view generation',
  'unsupported checkpoint mode fails before coordinator begin can reset or resize',
  'coordinator apply/drain lifecycle emits actual gated ACKs in order',
  'session-scoped asynchronous ACK rejection is routed back into recovery',
  'capability withdrawal advertises the clean rollback generation on reconnect',
  'malformed active session frame installs fail-closed recovery instead of leaving a pending barrier',
  'malformed session failure is isolated to its registered active view',
  'malformed start preserves parseable offending generation and epoch in the recovery fence',
  'global capability and negotiate rejection scope wins over an injected sessionId',
  'higher malformed boundary monotonically supersedes an in-flight recovery request',
  'unexpected higher valid start also advances an in-flight recovery boundary',
  'stale rejected start cannot lower the last accepted recovery epoch fence',
  'reentrant coordinator rejection preserves the maximum offending epoch fence',
  'coordinator-originated failure sends checkpoint recovery request even without manual repair',
  'ACK send failure fails closed and a newer epoch installs a new view generation before recovery',
  'stale-generation or wrong-session ingress is rejected without polluting fresh authority',
  'production wiring registers the dormant dispatcher and isolates raw xterm mutation construction',
  'real coordinator lifecycle sends apply then drain ACK before releasing queued input',
  'real active-to-passive rollback settles input and admits a fresh legacy snapshot stream',
  'TerminalInputSequencer splits printable runs at the server sequence span limit',
  'TerminalInputSequencer keeps control input as an ordered boundary after printable coalescing',
  'TerminalInputSequencer reuses provided client-observed metadata when coalescing printable input',
  'terminal input debug payload reuses module codec singletons and can skip high-cost details when capture is disabled',
  'TerminalInputSequencer preserves debug-disabled metadata without recomputing expensive metrics',
  'terminal input debug payload resolver does not rebuild when client metadata already exists',
]);

const frontendNonGateRegressionNames = sorted([
  'MIG-BGSTAB-002 rollback-start installs a same-view replacement boundary before the next checkpoint',
  'resize lease rejection remains observable without failing checkpoint recovery',
]);

const frontendRuntimeNonGateRegressionNames = sorted([
  'MIG-BGSTAB-002 accepts an initial compatibility snapshot completion for the prepared generation',
  'MIG-BGSTAB-002 admits a prepared checkpoint after its snapshot drained before the capability arrived',
  'MIG-BGSTAB-002 blocked current mount reports the latest gate reason without retaining the event tape',
  'MIG-BGSTAB-002 capability view attributes are generated by the control plane without a mounted renderer',
  'MIG-BGSTAB-002 capability view-attributes response is owned by WebSocketContext rather than TerminalView',
  'MIG-BGSTAB-002 cleanup E2E disables the request helper internal transient retry',
  'MIG-BGSTAB-002 cleanup attempt sequence never retries a timed-out or rejected first cleanup',
  'MIG-BGSTAB-002 cleanup attempt sequence probes idempotency only after first cleanup succeeds',
  'MIG-BGSTAB-002 cleanup retries only the exact legacy-settle sentinel before idempotency proof',
  'MIG-BGSTAB-002 compatibility drain coalesces concurrent cumulative watermarks',
  'MIG-BGSTAB-002 configured checkpoint failure preserves generation lineage',
  'MIG-BGSTAB-002 configured failure diagnostic excludes runtime secrets and has a byte ceiling',
  'MIG-BGSTAB-002 deferred future capability publishes attributes when dispatcher registration catches up',
  'MIG-BGSTAB-002 does not send or latch prepared ready across a replaced control socket',
  'MIG-BGSTAB-002 does not send prepared checkpoint-ready from an unproven clean runtime',
  'MIG-BGSTAB-002 drained ordered rollback consumes passive capability without rotating the view',
  'MIG-BGSTAB-002 empty server capability remains an authoritative fail-closed withdrawal',
  'MIG-BGSTAB-002 final dispatcher replacement accepts a legitimate lower generation after lifetime reset',
  'MIG-BGSTAB-002 final release clears cached authority after transient same-turn replacement',
  'MIG-BGSTAB-002 ignores a delayed ACK rejection whose checkpoint identity predates the active transaction',
  'MIG-BGSTAB-002 ignores a delayed pre-rollback ACK rejection after installing its replacement boundary',
  'MIG-BGSTAB-002 isolates an ACK rejection that omits the active connection identity',
  'MIG-BGSTAB-002 isolates an uncorrelatable ACK rejection after a fresh checkpoint starts',
  'MIG-BGSTAB-002 isolates an uncorrelatable ACK rejection before a checkpoint starts',
  'MIG-BGSTAB-002 observes a prepared ready blocked before a control receipt exists',
  'MIG-BGSTAB-002 ordered rollback completion releases the real coordinator checkpoint authority',
  'MIG-BGSTAB-002 oversized configured diagnostics preserve bounded client churn evidence',
  'MIG-BGSTAB-002 passive rollback observer releases only after its own snapshot drain',
  'MIG-BGSTAB-002 poisoned configured failure emits bounded redacted authority diagnostics',
  'MIG-BGSTAB-002 poisoned reload E2E cannot synthesize its capability response',
  'MIG-BGSTAB-002 poisoned reload failure preserves replay transaction evidence',
  'MIG-BGSTAB-002 poisoned reload re-enables client recovery diagnostics after navigation',
  'MIG-BGSTAB-002 post-snapshot test dispatch preserves the server checkpoint decision',
  'MIG-BGSTAB-002 production client pairs split output before same-view renegotiation',
  'MIG-BGSTAB-002 reacquires a missing same-socket ready receipt after compatibility recovery completes',
  'MIG-BGSTAB-002 recovery-pending user input uses the bounded transport queue and releases once with current identity',
  'MIG-BGSTAB-002 registration stabilization preserves the last capability rejection evidence',
  'MIG-BGSTAB-002 registration stabilization reuses an accepted idempotent view-attributes challenge',
  'MIG-BGSTAB-002 reload-safe input readiness reads the current gate without mutating transport overrides',
  'MIG-BGSTAB-002 same-session dispatcher replacement cancels its transient empty negotiation',
  'MIG-BGSTAB-002 sends one prepared checkpoint-ready only after compatibility recovery completes',
  'MIG-BGSTAB-002 sends prepared ready after a same-socket view-attributes control message',
  'MIG-BGSTAB-002 stale ready gate cannot authorize a replacement terminal runtime',
  'MIG-BGSTAB-002 stale scoped capability cannot replace the current generation or restart rollback',
  'MIG-BGSTAB-002 write-pipeline probe preserves pending checkpoint mode rehydrate bytes',
  'MIG-BGSTAB-002 zero-attached producer waits for an open focused input gate',
]);

const frontendInputNonGateRegressionNames = sorted([
  'same-session xterm recreation retains pending input while session lifetime cleanup settles it once',
]);

const targetFailureSignatures = Object.freeze(new Map([
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-1',
    'MIG-BGSTAB-002 AC-1 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-2',
    'MIG-BGSTAB-002 AC-2 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-3',
    'MIG-BGSTAB-002 AC-3 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-4',
    'MIG-BGSTAB-002 AC-4 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-5',
    'MIG-BGSTAB-002 AC-5 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-6',
    'MIG-BGSTAB-002 AC-6 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'Single-authority promotion and rollback epoch RED contract — REL-BGSTAB-007 AC-12',
    'REL-BGSTAB-007 AC-12 Single-authority promotion and rollback epoch 계약 부재 때문에 실패',
  ],
  [
    'terminal query responder matches Orca static and model-state replies with ConPTY override and seed silence',
    'MIG-BGSTAB-002 AC-3 query responder byte parity contract missing',
  ],
  [
    'terminalCheckpointRuntime promotion disables parser replies before positional disable ACK while preserving user input',
    'MIG-BGSTAB-002 AC-2 positional parser disable barrier 계약 부재 때문에 실패',
  ],
  [
    'terminalCheckpointRuntime rollback enables legacy parser replies only after fresh compatibility drain',
    'MIG-BGSTAB-002 AC-5 typed legacy-responder-enabled protocol parser missing',
  ],
  [
    'terminal query responder stays silent before driver view attributes and matches OSC color and DSR 996 replies after push',
    'MIG-BGSTAB-002 AC-3 view attribute reply contract missing',
  ],
  [
    'query reply input kind bypasses user sequencer and outbox and rejects stale responder identity',
    'MIG-BGSTAB-002 AC-2 query reply routing contract missing',
  ],
]));

const targetUnitNames = sorted(targetFailureSignatures.keys());

const nonGateRegressionNames = sorted([
  'MIG-BGSTAB-002 ACK success released after deadline cannot revive accepted readiness',
  'MIG-BGSTAB-002 AC-5 locks the first proven compatibility drain target while PTY output continues',
  'MIG-BGSTAB-002 accepted ACK retries one fresh owner when manager identity changes before settlement',
  'MIG-BGSTAB-002 authority-ready recovery retries after transient empty router projection',
  'MIG-BGSTAB-002 binding replacement recovers an active checkpoint live-output settlement failure',
  'MIG-BGSTAB-002 bounds checkpoint-ready retries for an unresponsive current view',
  'MIG-BGSTAB-002 exhausted checkpoint-ready retries roll back the unready server authority',
  'MIG-BGSTAB-002 checkpoint identity follows the committed authority source across reserved ordinal gaps',
  'MIG-BGSTAB-002 checkpoint pump cannot deliver queued stale frames to a successor socket with the same logical connection',
  'MIG-BGSTAB-002 checkpoint pump waits for each physical send settlement before admitting the next chunk',
  'MIG-BGSTAB-002 checkpoint send callback failure revokes server authority and starts fresh rollback',
  'MIG-BGSTAB-002 checkpoint-ready deadline begins only after the control preparation settles',
  'MIG-BGSTAB-002 configured corpus recreation refreshes the replacement runtime before promotion',
  'MIG-BGSTAB-002 destructive split output change fences a generation-retargeted refresh',
  'MIG-BGSTAB-002 explicit legacy capability refresh fails closed after a bounded permanent topology gap',
  'MIG-BGSTAB-002 explicit legacy capability refresh waits for a transient empty responder topology',
  'MIG-BGSTAB-002 explicit refresh retargets one successor challenge across view-generation churn',
  'MIG-BGSTAB-002 explicit refresh waits for a held identity-changed rebind before fresh capability enqueue',
  'MIG-BGSTAB-002 explicit rollback refreshes the authority-ready view after a zero-view reconnect',
  'MIG-BGSTAB-002 explicit recovery resumes an existing rollback with the current compatibility view',
  'MIG-BGSTAB-002 hard reload waits for exact control-lane readiness before its atomic checkpoint batch and PTY tail',
  'MIG-BGSTAB-002 headless runtime recreation restores a fresh legacy browser mutation lease',
  'MIG-BGSTAB-002 held successor rebind resumes the latest generation with one bounded wake',
  'MIG-BGSTAB-002 follower response is reject-only and cannot rotate the owner handshake',
  'MIG-BGSTAB-002 follower split lane replacement and unpair preserve the exact owner handshake',
  'MIG-BGSTAB-002 generation retarget does not consume the later manager-identity recovery',
  'MIG-BGSTAB-002 generation retarget preserves the immutable driver client anchor',
  'MIG-BGSTAB-002 legacy capability refresh follows the suspended browser driver instead of view order',
  'MIG-BGSTAB-002 legacy compatibility responder identity rebinds to a replacement view',
  'MIG-BGSTAB-002 legacy driver ownership transfers to the remaining capable view after disconnect',
  'MIG-BGSTAB-002 legacy output with no authority-capable view does not enter an epochless rollback',
  'MIG-BGSTAB-002 output-replaced fences the initially selected owner during a held legacy rebind',
  'MIG-BGSTAB-002 output-unpaired fences the initially selected owner during a held legacy rebind',
  'MIG-BGSTAB-002 overlapping legacy capability refreshes do not piggyback an older challenge',
  'MIG-BGSTAB-002 pending challenge rejects a same-view client identity replacement',
  'MIG-BGSTAB-002 pending challenge rejects a same-view driver lease identity replacement',
  'MIG-BGSTAB-002 pending handshake does not amplify a capability into a blind retry queue',
  'MIG-BGSTAB-002 pending view-attributes handshake stays pending without a reply then fails at its deadline',
  'MIG-BGSTAB-002 production promotion deadline follows the configured browser ACK contract exactly once',
  'MIG-BGSTAB-002 production destroy all-settles runtime map and factory ownership after responder detach failure',
  'MIG-BGSTAB-002 rollback cannot interleave or reactivate an in-flight hard-reload checkpoint',
  'MIG-BGSTAB-002 rollback lease renewal on the same responder identity does not restart recovery',
  'MIG-BGSTAB-002 rollback query hold ledger fails closed at the configured chunk bound',
  'MIG-BGSTAB-002 rollback topology rejects a projected generation outside the active stream epoch',
  'MIG-BGSTAB-002 failed compatibility query transfer keeps rollback retryable and uncommitted',
  'MIG-BGSTAB-002 refresh resolves only after manager acceptance and accepted ACK settlement',
  'MIG-BGSTAB-002 rejected ACK settlement invalidates its challenge before a late duplicate',
  'MIG-BGSTAB-002 replacement view supersedes a stale checkpoint-ready preparation before stale disconnect',
  'MIG-BGSTAB-002 replacement challenge reply after the original deadline cannot revive readiness',
  'MIG-BGSTAB-002 retries a single failed authority-send rollback without another callback',
  'MIG-BGSTAB-002 rollback cancels a pending checkpoint-ready deadline before it can retry',
  'MIG-BGSTAB-002 runtime recreation invalidates an old pending refresh before a new runtime refresh succeeds',
  'MIG-BGSTAB-002 same-generation hard reload replaces the live server-authority view',
  'MIG-BGSTAB-002 same-view runtime recreation rejects the old challenge before accepting the replacement',
  'MIG-BGSTAB-002 send failure waits for same-turn hard-reload topology settlement',
  'MIG-BGSTAB-002 split control advertises view attributes only after its output lane pairs',
  'MIG-BGSTAB-002 split output close invalidates pending handshake and re-pair requires a fresh exact identity',
  'MIG-BGSTAB-002 stale driver attributes rotate once and only the fresh exact identity settles true',
  'MIG-BGSTAB-002 production rollback overflow coalesces one fresh compatibility recovery',
  'MIG-BGSTAB-002 promotion admission fence owns output queued while the legacy prefix is unresolved',
  'MIG-BGSTAB-002 promotion admission fence rejects a concurrent begin transaction',
  'MIG-BGSTAB-002 promotion revalidates the frozen responder topology after its legacy prefix drains',
  'MIG-BGSTAB-002 promotion begin accepts a boundary ACK that wins the send-callback race',
  'MIG-BGSTAB-002 recovery ACK miss preserves bootstrap replay until the refreshed model is acknowledged',
  'MIG-BGSTAB-002 session finalization disposes authority timer and settles queued delivery exactly once',
  'MIG-BGSTAB-002 attachment destroy detaches active authority runtime and clears its owned factory',
  'MIG-BGSTAB-002 stale hard-reload checkpoint settlement cannot roll back a live replacement view',
  'MIG-BGSTAB-002 stale promotion deadline cannot roll back a replacement authority runtime',
  'MIG-BGSTAB-002 topology replacement during rollback does not reset the fresh parser again',
  'MIG-BGSTAB-002 unready checkpoint preparation expires without admitting an authoritative checkpoint',
  'MIG-BGSTAB-002 zero-view rollback recovery wakes when a replacement view becomes authority-ready',
  'MIG-BGSTAB-002 zero-view hard reload retains PTY output for the replacement checkpoint',
  'MIG-BGSTAB-002 ANSI-colored substantive draft prefix remains observable as running output',
  'MIG-BGSTAB-002 ANSI-only PowerShell repaint does not demote an active Codex foreground session',
  'MIG-BGSTAB-002 CRLF-terminated substantive draft prefix remains observable as running output',
  'MIG-BGSTAB-002 CWD prompt refresh preserves an active unsubmitted draft until its delayed echo settles',
  'MIG-BGSTAB-002 CWD prompt refresh without an active draft keeps normal prompt reset behavior',
  'MIG-BGSTAB-002 Ctrl+C cancels a deferred bare echo candidate',
  'MIG-BGSTAB-002 Ctrl+C cursor-only repaint does not suppress later semantic shell output',
  'MIG-BGSTAB-002 Ctrl+C cursor-positioned echo and PowerShell prompt redraw stays idle',
  'MIG-BGSTAB-002 Ctrl+C prompt return expires an unmatched interrupted draft correlation',
  'MIG-BGSTAB-002 Ctrl+C prompt-only shell return remains idle',
  'MIG-BGSTAB-002 Ctrl+C prompt-return suppression is consumed before later semantic prompt output',
  'MIG-BGSTAB-002 Ctrl+C retains an already-observed bare echo prefix for its matching suffix',
  'MIG-BGSTAB-002 Ctrl+C settles one already-pending delayed local echo before later semantic output',
  'MIG-BGSTAB-002 Enter clears delayed local-echo correlation',
  'MIG-BGSTAB-002 PSReadLine rewrite replaces an earlier partial local-echo prefix with a longer current draft prefix',
  'MIG-BGSTAB-002 PowerShell redraw retains the unsubmitted draft for later Codex detection',
  'MIG-BGSTAB-002 PowerShell-shaped semantic output does not demote an active Codex foreground session',
  'MIG-BGSTAB-002 SGR-only split local echo remains idle when its matching suffix arrives',
  'MIG-BGSTAB-002 a CSI-split SGR local echo remains idle across PTY chunks',
  'MIG-BGSTAB-002 a PSReadLine partial echo prefix does not suppress nonmatching semantic output',
  'MIG-BGSTAB-002 a bare draft prefix with a nonmatching suffix runs immediately',
  'MIG-BGSTAB-002 a control-only repaint does not cancel the bounded bare echo deadline',
  'MIG-BGSTAB-002 a replacement draft cancels a deferred bare echo candidate',
  'MIG-BGSTAB-002 a shell prompt redraw cancels an in-flight bare echo candidate',
  'MIG-BGSTAB-002 an OSC-133 active Codex bare prefix deadline runs and clears its candidate',
  'MIG-BGSTAB-002 an OSC-133 active Codex bare prefix with a nonmatching suffix runs and clears its candidate',
  'MIG-BGSTAB-002 an OSC-133 active Codex delayed exact echo stays idle',
  'MIG-BGSTAB-002 an active Codex CSI-split local echo stays idle across PTY chunks',
  'MIG-BGSTAB-002 an active Codex bare draft prefix times out to running without a suffix',
  'MIG-BGSTAB-002 an active Codex bare prefix with a nonmatching suffix runs immediately',
  'MIG-BGSTAB-002 an observed exact local echo is not revived as an interrupted draft',
  'MIG-BGSTAB-002 bare PowerShell prompt without an active draft does not mask later substantive output',
  'MIG-BGSTAB-002 bare split local echo remains idle when its matching suffix arrives',
  'MIG-BGSTAB-002 delayed ANSI echo of a backspace-edited local draft stays idle after a prompt redraw',
  'MIG-BGSTAB-002 delayed ANSI echo of a superseded pre-edit draft remains running',
  'MIG-BGSTAB-002 delayed ANSI local echo split across PTY chunks stays idle until its matching suffix arrives',
  'MIG-BGSTAB-002 delayed ANSI-colored local echo stays idle after the debug correlation window expires',
  'MIG-BGSTAB-002 delayed ANSI-colored local echo stays idle after the pending input buffer is cleared',
  'MIG-BGSTAB-002 delayed ANSI-colored nonmatching output remains running after the pending input buffer is cleared',
  'MIG-BGSTAB-002 delayed Ctrl+C clear-line and cursor repaint stays idle when foreground detection is stale',
  'MIG-BGSTAB-002 delayed Ctrl+C clear-line › prompt repaint stays idle when foreground detection is stale',
  'MIG-BGSTAB-002 delayed Ctrl+C semantic output remains running when foreground detection is stale',
  'MIG-BGSTAB-002 delayed active-draft echo prefix survives an intervening control-only repaint',
  'MIG-BGSTAB-002 delayed local-input cursor visibility repaint stays idle when foreground detection is stale',
  'MIG-BGSTAB-002 delayed local-input semantic output remains running when foreground detection is stale',
  'MIG-BGSTAB-002 immediate Ctrl+C SGR-reset and cursor-hide repaint stays idle',
  'MIG-BGSTAB-002 immediate Ctrl+C prompt repaint consumes its allowance before later semantic prompt output',
  'MIG-BGSTAB-002 immediate semantic output after Ctrl+C remains running',
  'MIG-BGSTAB-002 immediate semantic output after unsent printable input remains running',
  'MIG-BGSTAB-002 interrupted-draft echo prefix survives an intervening control-only repaint',
  'MIG-BGSTAB-002 repeated ambiguous bare chunks do not rearm the deferred echo deadline',
  'MIG-BGSTAB-002 replacement local input invalidates the prior delayed local-echo correlation',
  'MIG-BGSTAB-002 semantic output before a prompt-prefixed local draft remains running',
  'MIG-BGSTAB-002 semantic output clears delayed local-echo correlation',
  'MIG-BGSTAB-002 session teardown cancels the deferred bare echo timer',
  'MIG-BGSTAB-002 session teardown safely discards a deferred bare echo candidate',
  'MIG-BGSTAB-002 stale bare PowerShell prompt preserves an unsent draft through a split PSReadLine redraw',
  'MIG-BGSTAB-002 unadorned exact delayed draft echo remains idle',
  'MIG-BGSTAB-002 unadorned substantive draft prefix remains observable as running output',
]);

const protocolNonGateRegressionNames = sorted([
  'MIG-BGSTAB-002 checkpoint delivery ready accepts only the prepared canonical control identity',
]);

const e2eFailureSignatures = Object.freeze(new Map([
  ['positional all-view handoff', 'MIG-BGSTAB-002 AC-2 positional all-view disable ACK contract is absent'],
  ['query byte parity and seed silence', 'MIG-BGSTAB-002 AC-3 query reply identity contract is absent'],
  ['poisoned no-cache reload', 'MIG-BGSTAB-002 AC-4 authoritative no-cache checkpoint contract is absent'],
  ['compatibility-drain rollback', 'MIG-BGSTAB-002 AC-5 compatibility-drain responder barrier is absent'],
  ['stale reconnect no-replay', 'MIG-BGSTAB-002 AC-2 query replies lack stale responder identity and replay bypass'],
  ['fault PTY/AI idle', 'MIG-BGSTAB-002 AC-6 fault abort/PTY continuity/AI idle contract is absent'],
]));

const e2eNames = sorted(e2eFailureSignatures.keys());

const e2eNonGateRegressionNames = sorted([
  'connection replacement retargets output policy without recreating xterm',
]);

const expectedNamesBySource = Object.freeze(new Map([
  ['server/src/services/TerminalAuthorityController.test.ts', sorted([
    ...targetUnitNames.filter(name => name.startsWith('Single-authority promotion and rollback epoch RED contract')),
    ...nonGateRegressionNames,
  ])],
  ['server/src/utils/terminalQueryResponder.test.ts', sorted([
    'terminal query responder matches Orca static and model-state replies with ConPTY override and seed silence',
  ])],
  ['server/src/types/wsCheckpointProtocol.test.ts', sorted([
    ...serverCheckpointProtocolNames,
    ...protocolNonGateRegressionNames,
  ])],
  ['server/src/ws/WsRouterRestoreMetadata.test.ts', serverRestoreCompatibilityNames],
  ['frontend/tests/unit/terminalCheckpointRuntime.test.ts', sorted([
    ...frontendCompatibilityNames.filter(name => !name.startsWith('TerminalInputSequencer')
      && !name.startsWith('terminal input debug payload')
      && name !== 'terminal input debug payload resolver does not rebuild when client metadata already exists'),
    'terminalCheckpointRuntime promotion disables parser replies before positional disable ACK while preserving user input',
    'terminalCheckpointRuntime rollback enables legacy parser replies only after fresh compatibility drain',
    ...frontendNonGateRegressionNames,
    ...frontendRuntimeNonGateRegressionNames,
  ])],
  ['frontend/tests/unit/terminalInputSequencer.test.ts', sorted([
    ...frontendCompatibilityNames.filter(name => name.startsWith('TerminalInputSequencer')
      || name.startsWith('terminal input debug payload')),
    'query reply input kind bypasses user sequencer and outbox and rejects stale responder identity',
    ...frontendInputNonGateRegressionNames,
  ])],
  ['frontend/tests/unit/terminalQueryReply.test.ts', sorted([
    'terminal query responder stays silent before driver view attributes and matches OSC color and DSR 996 replies after push',
  ])],
  ['frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts', sorted([
    ...e2eNames,
    ...e2eNonGateRegressionNames,
  ])],
]));

const thresholds = Object.freeze({
  compatibility: Object.freeze({ exactTests: 39, maximumFailures: 0, maximumSkipped: 0 }),
  extendedRegression: Object.freeze({ exactTests: 59, maximumFailures: 0, maximumSkipped: 0 }),
  targetUnit: Object.freeze({ exactTests: 12, maximumUnexpectedPasses: 0, maximumUnexpectedFailures: 0 }),
  routeGuards: Object.freeze({ exactTests: 5, maximumFailures: 0, maximumSkipped: 0 }),
  e2e: Object.freeze({ exactTests: 6, maximumSetupFatals: 0, maximumUnexpectedStatuses: 0 }),
  registeredAssertions: Object.freeze({ exactAssertions: 13 }),
  inputHashes: Object.freeze({ maximumMissing: 0, maximumMismatches: 0 }),
  rollout: Object.freeze({
    capabilityNegotiated: true,
    limitedSessionScope: true,
    productDefaultChanged: false,
    uiChanged: false,
    legacyPhysicalDeletion: false,
  }),
});

function integrationAcceptReason() {
  return `exact-unit-${thresholds.targetUnit.exactTests}-extended-regression-${thresholds.extendedRegression.exactTests}-and-https-e2e-${thresholds.e2e.exactTests}-passed-with-unified-and-split-live-coverage`;
}

function buildTransportCoverage(split) {
  return Object.freeze({
    verifiedLiveModes: Object.freeze(['unified', ...(split.verified ? ['split'] : [])]),
    split: Object.freeze({ ...split }),
  });
}

const selfTestSplitEvidence = Object.freeze({
  verified: true,
  activationAllowed: true,
  fixture: 'actual-websocket-named-pipe',
  physicalConnectionCount: 2,
  controlLaneFrameTypes: Object.freeze(['terminal-authority:query-fixture']),
  outputLaneFrameTypes: Object.freeze([
    'terminal-checkpoint:start',
    'terminal-checkpoint:chunk',
    'terminal-checkpoint:commit',
  ]),
  noOutputLaneInterleave: true,
  chunkBytes: 20,
  chunkSha256: sha256(Buffer.from('split-physical-chunk', 'utf8')),
});

function absolute(path) {
  const resolved = resolve(repositoryRoot, path);
  const fromRoot = relative(repositoryRoot, resolved);
  assert.equal(fromRoot.startsWith('..'), false, `evidence path escapes repository: ${path}`);
  return resolved;
}

function readBytes(path) {
  const resolved = absolute(path);
  assert.equal(existsSync(resolved), true, `required evidence path is missing: ${path}`);
  return readFileSync(resolved);
}

function readUtf8(path) {
  return readBytes(path).toString('utf8').replace(/^\uFEFF/u, '');
}

function invalidateDecisionArtifact(resolvedPath) {
  rmSync(resolvedPath, { force: true });
  assert.equal(existsSync(resolvedPath), false, 'stale authority promotion decision artifact survived invalidation');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function canonicalSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function hashesFor(paths) {
  const files = Object.fromEntries(sorted(new Set(paths))
    .map(path => [path, sha256(readBytes(path))]));
  return Object.freeze({
    files: Object.freeze(files),
    sourceSetSha256: canonicalSha256(files),
    missing: 0,
    mismatches: 0,
  });
}

function captureExecutionInputIdentity() {
  return Object.freeze({
    inputHashes: hashesFor(inputPaths),
    configHashes: hashesFor(configPaths),
    testHashes: hashesFor([...testSourcePaths, guardTestSourcePath]),
    sourceHashes: hashesFor(productionSourcePaths),
    evidenceDependencyHashes: hashesFor(rawEvidenceDependencyPaths),
    evidenceTool: Object.freeze({
      path: evidenceToolPath,
      sha256: sha256(readBytes(evidenceToolPath)),
    }),
  });
}

function assertExecutionInputIdentityUnchanged(before, after) {
  assert.deepEqual(after, before,
    'evidence inputs changed while verification was running; results are not attributable to one source state');
}

function verifyHashManifest(actualFiles, expectedFiles, label) {
  const actualPaths = sorted(Object.keys(actualFiles));
  const expectedPaths = sorted(Object.keys(expectedFiles));
  assert.deepEqual(actualPaths, expectedPaths, `${label} path identity mismatch`);
  const mismatches = actualPaths.filter(path => actualFiles[path] !== expectedFiles[path]);
  assert.deepEqual(mismatches, [], `${label} hash mismatch`);
  return Object.freeze({
    files: Object.freeze({ ...actualFiles }),
    sourceSetSha256: canonicalSha256(actualFiles),
    missing: 0,
    mismatches: 0,
  });
}

function readCurrentHashes(paths) {
  return Object.fromEntries(sorted(paths).map(path => [path, sha256(readBytes(path))]));
}

function validateRedTestSourceManifest() {
  const manifest = JSON.parse(readUtf8(redTestSourceManifestPath));
  assert.equal(manifest?.schemaVersion, 'authority-promotion-red-test-sources/v1',
    'RED test source manifest schema changed');
  const expectedPaths = sorted([...testSourcePaths, evidenceToolPath]);
  assert.deepEqual(sorted(Object.keys(manifest.files ?? {})), expectedPaths,
    'RED test source manifest path identity changed');
  const verification = verifyHashManifest(
    readCurrentHashes(expectedPaths),
    manifest.files,
    'PH005 RED test source manifest',
  );
  return Object.freeze({
    path: redTestSourceManifestPath,
    manifestSha256: sha256(readBytes(redTestSourceManifestPath)),
    ...verification,
  });
}

function readProductionGitStatus() {
  const paths = sorted(new Set(productionSourcePaths));
  const result = spawnSync('git', ['status', '--porcelain=v1', '--', ...paths], {
    cwd: repositoryRoot,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `git status terminated by signal ${result.signal}`);
  assert.equal(result.status, 0, `git status failed: ${decodeOutput(result.stderr)}`);
  return sorted(decodeOutput(result.stdout).split('\n').filter(Boolean));
}

function verifyRedProductionUnchanged() {
  const retainedBaselineBytes = readBytes(retainedShadowBaselinePath);
  const retainedShadowBaselineSha256 = sha256(retainedBaselineBytes);
  assert.equal(
    retainedShadowBaselineSha256,
    retainedShadowBaselineExpectedSha256,
    'PH004 retained-shadow parity artifact identity changed',
  );
  const retainedBaseline = JSON.parse(retainedBaselineBytes.toString('utf8').replace(/^\uFEFF/u, ''));
  const retainedFiles = retainedBaseline?.productionSourceHashes?.files;
  assert.equal(retainedFiles !== null && typeof retainedFiles === 'object', true,
    'PH004 retained production source baseline is missing');
  const retainedPaths = sorted(Object.keys(retainedFiles));
  assert.deepEqual(retainedPaths, sorted([
    'server/src/services/SessionManager.ts',
    'server/src/types/ws-protocol.ts',
    'server/src/utils/headlessTerminal.ts',
    'server/src/ws/WsRouter.ts',
  ]), 'PH004 retained production baseline identity changed');
  const retained = verifyHashManifest(
    readCurrentHashes(retainedPaths),
    retainedFiles,
    'PH004 retained production baseline',
  );
  const frontend = verifyHashManifest(
    readCurrentHashes(Object.keys(redFrontendSourceBaseline)),
    redFrontendSourceBaseline,
    'PH005 RED frontend production baseline',
  );
  const additionalServer = verifyHashManifest(
    readCurrentHashes(Object.keys(redAdditionalServerSourceBaseline)),
    redAdditionalServerSourceBaseline,
    'PH005 RED additional server production baseline',
  );
  const unexpectedlyPresent = newProductionPathsExpectedAbsentInRed
    .filter(path => existsSync(absolute(path)));
  assert.deepEqual(unexpectedlyPresent, [], 'PH005 RED found a new production module');
  const gitStatusLines = readProductionGitStatus();
  assert.deepEqual(
    gitStatusLines,
    sorted(redExpectedProductionGitStatusLines),
    'PH005 RED production git status differs from the admission baseline',
  );
  return Object.freeze({
    retainedShadowBaselinePath,
    retainedShadowBaselineSha256,
    retained,
    frontend,
    additionalServer,
    newProductionPathsExpectedAbsent: newProductionPathsExpectedAbsentInRed,
    unexpectedlyPresent: Object.freeze(unexpectedlyPresent),
    gitStatusLines: Object.freeze(gitStatusLines),
    gitStatusSha256: canonicalSha256(gitStatusLines),
  });
}

function decodeOutput(value) {
  if (!value) return '';
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const looksUtf16Le = (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0);
  return bytes.toString(looksUtf16Le ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/gu, '\n');
}

function runCommand(command) {
  const options = {
    cwd: absolute(command.cwd),
    env: { ...process.env, ...(command.environment ?? {}) },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  };
  const result = spawnSync(command.executable, [...command.args], options);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command.value} terminated by signal ${result.signal}`);
  return Object.freeze({
    command: command.value,
    cwd: command.cwd,
    exitCode: result.status,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr),
  });
}

function waitForSocketMessage(messages, predicate, timeoutMs = 5_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const match = messages.find(predicate);
      if (match) {
        resolvePromise(match);
        return;
      }
      if (Date.now() >= deadline) {
        rejectPromise(new Error('split physical-lane fixture message timed out'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function evaluateSplitPhysicalLaneEvidence(input) {
  assert.equal(input.fixture, 'actual-websocket-named-pipe',
    'split fixture must use actual WebSocket connections over a local named pipe');
  assert.equal(input.physicalConnectionCount, 2,
    'split fixture must establish exactly two physical WebSocket connections');
  assert.deepEqual(input.controlLaneFrameTypes, ['terminal-authority:query-fixture'],
    'split control lane did not preserve the query frame');
  assert.deepEqual(input.outputLaneFrameTypes, [
    'terminal-checkpoint:start',
    'terminal-checkpoint:chunk',
    'terminal-checkpoint:commit',
  ], 'split output lane did not preserve the exact checkpoint transaction');
  assert.equal(input.noOutputLaneInterleave, true,
    'split output checkpoint transaction contains an interleaving frame');
  assert.equal(input.chunkBytes, Buffer.byteLength('split-physical-chunk', 'utf8'),
    'split fixture chunk byte count differs from its actual payload');
  assert.equal(input.chunkSha256, sha256(Buffer.from('split-physical-chunk', 'utf8')),
    'split fixture chunk digest differs from its actual payload');
  return buildTransportCoverage({
    ...input,
    verified: true,
    activationAllowed: true,
  });
}

async function validateSplitPhysicalLanes() {
  const [{ WsRouter }, wsModule] = await Promise.all([
    import(pathToFileURL(absolute('server/dist/ws/WsRouter.js')).href),
    import(pathToFileURL(absolute('server/node_modules/ws/wrapper.mjs')).href),
  ]);
  const WebSocketClient = wsModule.WebSocket;
  const authService = { verifyToken: () => ({ valid: true, payload: { sub: 'ph005-fixture' } }) };
  const sessionManager = {};
  const router = new WsRouter(authService, sessionManager, {
    realtime: { wsTransportMode: 'split' },
    stabilityModes: { wsSendMode: 'safe-send-enforce' },
  });
  const server = http.createServer();
  const pipePath = `\\\\.\\pipe\\buildergate-ph005-split-${process.pid}-${randomUUID()}`;
  const sockets = [];
  server.on('upgrade', (request, socket, head) => router.handleUpgrade(request, socket, head));
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(pipePath, () => {
        server.off('error', rejectPromise);
        resolvePromise();
      });
    });
    const connectSocket = async url => {
      const messages = [];
      const socket = new WebSocketClient(url, {
        createConnection: () => net.connect(pipePath),
      });
      sockets.push(socket);
      socket.on('message', raw => messages.push(JSON.parse(raw.toString('utf8'))));
      await once(socket, 'open');
      return { socket, messages };
    };
    const control = await connectSocket(
      'ws://buildergate.local/ws?token=fixture&wsTransportMode=split&channel=control',
    );
    const controlConnected = await waitForSocketMessage(
      control.messages,
      message => message.type === 'connected' && message.channel === 'control',
    );
    const output = await connectSocket(
      'ws://buildergate.local/ws?token=fixture&wsTransportMode=split&channel=output'
        + `&clientGroupId=${encodeURIComponent(controlConnected.clientGroupId)}`
        + `&pairToken=${encodeURIComponent(controlConnected.pairToken)}`,
    );
    await waitForSocketMessage(
      output.messages,
      message => message.type === 'connected' && message.channel === 'output',
    );
    const send = (message, lane) => new Promise((resolvePromise, rejectPromise) => {
      const result = router.sendTerminalAuthorityFrameToConnection(
        controlConnected.connectionId,
        message,
        lane,
        error => error ? rejectPromise(error) : resolvePromise(result),
      );
      if (!result.sent) rejectPromise(new Error(`split fixture ${lane} frame was not admitted`));
    });
    const chunkData = 'split-physical-chunk';
    await send({ type: 'terminal-checkpoint:start', fixtureId: 'ph005-split' }, 'terminal');
    await send({ type: 'terminal-authority:query-fixture', fixtureId: 'ph005-split' }, 'control');
    await send({ type: 'terminal-checkpoint:chunk', fixtureId: 'ph005-split', data: chunkData }, 'terminal');
    await send({ type: 'terminal-checkpoint:commit', fixtureId: 'ph005-split' }, 'terminal');
    await waitForSocketMessage(output.messages, message => message.type === 'terminal-checkpoint:commit');
    await waitForSocketMessage(control.messages, message => message.type === 'terminal-authority:query-fixture');
    const outputFrameTypes = output.messages
      .filter(message => message.fixtureId === 'ph005-split')
      .map(message => message.type);
    const controlFrameTypes = control.messages
      .filter(message => message.fixtureId === 'ph005-split')
      .map(message => message.type);
    return evaluateSplitPhysicalLaneEvidence({
      fixture: 'actual-websocket-named-pipe',
      physicalConnectionCount: 2,
      controlLaneFrameTypes: controlFrameTypes,
      outputLaneFrameTypes: outputFrameTypes,
      noOutputLaneInterleave: outputFrameTypes.every(type => type.startsWith('terminal-checkpoint:')),
      chunkBytes: Buffer.byteLength(chunkData, 'utf8'),
      chunkSha256: sha256(Buffer.from(chunkData, 'utf8')),
    });
  } finally {
    router.destroy();
    for (const socket of sockets) {
      if (socket.readyState === WebSocketClient.OPEN || socket.readyState === WebSocketClient.CONNECTING) {
        socket.terminate();
      }
    }
    await new Promise(resolvePromise => server.close(() => resolvePromise()));
  }
}

function requestLiveBytesOnce(baseUrl, path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(new URL(path, baseUrl), {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: 5_000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolvePromise({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('live health request timed out')));
    request.on('error', rejectPromise);
    request.end();
  });
}

function isTransientLiveRequestError(error) {
  return error?.code === 'ECONNABORTED' || error?.code === 'ECONNRESET';
}

async function requestLiveBytes(baseUrl, path) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await requestLiveBytesOnce(baseUrl, path);
      liveRequestAttemptLog.push(Object.freeze({ path, attempt, outcome: 'success', statusCode: response.statusCode }));
      return response;
    } catch (error) {
      liveRequestAttemptLog.push(Object.freeze({
        path,
        attempt,
        outcome: isTransientLiveRequestError(error) && attempt < 3 ? 'retry' : 'terminal-failure',
        errorCode: typeof error?.code === 'string' ? error.code : null,
        failureReason: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
      }));
      if (!isTransientLiveRequestError(error) || attempt === 3) throw error;
      await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 100));
    }
  }
  throw new Error('live request retry loop exited unexpectedly');
}

async function requestLiveHealth(baseUrl) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await requestLiveBytes(baseUrl, '/health');
      return { ...response, body: JSON.parse(response.body.toString('utf8')) };
    } catch (cause) {
      if (cause?.code !== 'ECONNRESET' || attempt === 3) {
        if (cause instanceof SyntaxError) {
          throw new Error('live health response is not valid JSON', { cause });
        }
        throw cause;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, attempt * 100));
    }
  }
  throw new Error('live health retry loop exited unexpectedly');
}

function serverBuildPairs() {
  return productionSourcePaths
    .filter(path => path.startsWith('server/src/') && path.endsWith('.ts'))
    .map(sourcePath => ({
      sourcePath,
      buildPath: sourcePath.replace(/^server\/src\//u, 'server/dist/').replace(/\.ts$/u, '.js'),
    }));
}

function assertLoadedBuildFreshness(records, processStartMs) {
  assert.equal(Number.isFinite(processStartMs), true, 'live backend process start time is unavailable');
  for (const record of records) {
    assert.equal(
      record.buildMtimeMs >= record.sourceMtimeMs,
      true,
      `live build output predates current source: ${record.sourcePath}`,
    );
  }
  const newestBuildMtimeMs = Math.max(...records.map(record => record.buildMtimeMs));
  assert.equal(
    processStartMs >= newestBuildMtimeMs,
    true,
    'live backend process predates the current compiled authority build; reload is required',
  );
  return newestBuildMtimeMs;
}

function assertExpectedServerEntry(commandLine) {
  const expectedEntry = absolute('server/dist/index.js');
  const normalizedExpectedEntry = expectedEntry.replace(/\\/gu, '/').toLowerCase();
  const normalizedCommandLine = commandLine.replace(/\\/gu, '/').toLowerCase();
  assert.equal(
    normalizedCommandLine.includes(normalizedExpectedEntry),
    true,
    `live health pid is not executing this checkout's absolute server entry: ${expectedEntry}`,
  );
  return expectedEntry;
}

function normalizedWindowsPath(value) {
  return resolve(String(value ?? '')).replace(/\\/gu, '/').toLowerCase();
}

function validateDaemonStateHealthBinding(healthBody, baseUrl, state, nowMs = Date.now()) {
  const expectedEntry = absolute('server/dist/index.js');
  const expectedServerCwd = absolute('server');
  const expectedLauncher = absolute('tools/start-runtime.js');
  const expectedConfig = absolute('server/config.json5');
  const expectedPort = Number(new URL(baseUrl).port);
  assert.equal(state?.mode, 'daemon', 'live daemon state mode is not daemon');
  assert.equal(state?.status, 'running', 'live daemon state is not running');
  assert.equal(state?.appPid, Number(healthBody?.pid), 'live health/daemon state pid mismatch');
  assert.equal(state?.startAttemptId, healthBody?.startAttemptId,
    'live health/daemon state start attempt mismatch');
  assert.equal(state?.stateGeneration, healthBody?.stateGeneration,
    'live health/daemon state generation mismatch');
  assert.equal(state?.port, expectedPort, 'live daemon state port mismatch');
  assert.equal(normalizedWindowsPath(state?.serverEntryPath), normalizedWindowsPath(expectedEntry),
    'live daemon state server entry is not from this checkout');
  assert.equal(normalizedWindowsPath(state?.serverCwd), normalizedWindowsPath(expectedServerCwd),
    'live daemon state server cwd is not from this checkout');
  assert.equal(normalizedWindowsPath(state?.launcherPath), normalizedWindowsPath(expectedLauncher),
    'live daemon state launcher is not from this checkout');
  assert.equal(normalizedWindowsPath(state?.configPath), normalizedWindowsPath(expectedConfig),
    'live daemon state config is not from this checkout');
  const processStartMs = Date.parse(String(state?.appProcessStartedAt ?? ''));
  assert.equal(Number.isFinite(processStartMs), true, 'live daemon process start time is unavailable');
  assert.equal(processStartMs <= nowMs + 5_000, true, 'live daemon process start time is in the future');
  const heartbeatMs = Date.parse(String(state?.heartbeatAt ?? ''));
  assert.equal(Number.isFinite(heartbeatMs), true, 'live daemon heartbeat is unavailable');
  assert.equal(nowMs - heartbeatMs <= 30_000, true, 'live daemon heartbeat is stale');
  assert.equal(heartbeatMs <= nowMs + 5_000, true, 'live daemon heartbeat is in the future');
  return Object.freeze({
    expectedEntry,
    processStartTime: new Date(processStartMs).toISOString(),
    identityValue: `${state.serverEntryPath}\n${state.appPid}\n${state.startAttemptId}\n${state.stateGeneration}`,
    identitySource: 'daemon-state-health-binding',
  });
}

function frontendAssetPaths(indexBytes) {
  const html = indexBytes.toString('utf8');
  const paths = sorted(new Set(
    [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/gu)].map(match => match[1]),
  ));
  assert.equal(paths.some(path => path.endsWith('.js')), true,
    'live frontend index does not identify a JavaScript asset');
  return paths;
}

async function validateServedFrontendIdentity(baseUrl) {
  const indexPath = 'frontend/dist/index.html';
  const localIndex = readBytes(indexPath);
  const liveIndex = await requestLiveBytes(baseUrl, '/');
  assert.equal(liveIndex.statusCode, 200, `live frontend index returned ${liveIndex.statusCode}`);
  assert.deepEqual(liveIndex.body, localIndex,
    'live frontend index is not the current checkout frontend/dist/index.html');
  const assetPaths = frontendAssetPaths(localIndex);
  const assets = [];
  for (const assetUrlPath of assetPaths) {
    const localPath = `frontend/dist${assetUrlPath}`;
    const localBytes = readBytes(localPath);
    const live = await requestLiveBytes(baseUrl, assetUrlPath);
    assert.equal(live.statusCode, 200, `live frontend asset returned ${live.statusCode}: ${assetUrlPath}`);
    assert.deepEqual(live.body, localBytes,
      `live frontend asset is not from the current checkout: ${assetUrlPath}`);
    assets.push(Object.freeze({
      urlPath: assetUrlPath,
      localPath,
      sha256: sha256(localBytes),
      mtimeMs: statSync(absolute(localPath)).mtimeMs,
    }));
  }
  const newestFrontendSourceMtimeMs = Math.max(...productionSourcePaths
    .filter(path => path.startsWith('frontend/src/'))
    .map(path => statSync(absolute(path)).mtimeMs));
  const oldestJavaScriptAssetMtimeMs = Math.min(...assets
    .filter(asset => asset.urlPath.endsWith('.js'))
    .map(asset => asset.mtimeMs));
  assert.equal(oldestJavaScriptAssetMtimeMs >= newestFrontendSourceMtimeMs, true,
    'live frontend bundle predates a current production frontend source; rebuild is required');
  return Object.freeze({
    index: Object.freeze({ path: indexPath, sha256: sha256(localIndex) }),
    assets: Object.freeze(assets),
    newestFrontendSourceMtime: new Date(newestFrontendSourceMtimeMs).toISOString(),
    oldestJavaScriptAssetMtime: new Date(oldestJavaScriptAssetMtimeMs).toISOString(),
  });
}

async function validateLoadedBuildIdentity() {
  const baseUrl = e2eCommand.environment.PLAYWRIGHT_BASE_URL;
  const health = await requestLiveHealth(baseUrl);
  assert.equal(health.statusCode, 200, `live health returned ${health.statusCode}`);
  assert.equal(health.body?.status, 'ok', 'live health status is not ok');
  const pid = Number(health.body?.pid);
  assert.equal(Number.isSafeInteger(pid) && pid > 0, true, 'live health pid is invalid');
  assert.equal(String(health.headers['x-buildergate-pid'] ?? ''), String(pid),
    'live health body/header pid identity mismatch');

  let processIdentity;
  if (existsSync(absolute(daemonStatePath))) {
    const daemonState = JSON.parse(readUtf8(daemonStatePath));
    processIdentity = validateDaemonStateHealthBinding(health.body, baseUrl, daemonState);
  } else {
    const processInfo = queryProcessInfo(pid, { processInfoTimeoutMs: 10_000 });
    assert.equal(processInfo?.running, true, 'live health process is no longer running');
    assert.equal(typeof processInfo?.commandLine, 'string', 'live backend command line is unavailable');
    processIdentity = Object.freeze({
      expectedEntry: assertExpectedServerEntry(processInfo.commandLine),
      processStartTime: processInfo.startTime,
      identityValue: processInfo.commandLine,
      identitySource: 'process-command-line',
    });
  }
  const processStartMs = Date.parse(String(processIdentity.processStartTime ?? ''));

  const records = serverBuildPairs().map(({ sourcePath, buildPath }) => {
    const source = statSync(absolute(sourcePath));
    const build = statSync(absolute(buildPath));
    return Object.freeze({
      sourcePath,
      buildPath,
      sourceMtimeMs: source.mtimeMs,
      buildMtimeMs: build.mtimeMs,
      sourceSha256: sha256(readBytes(sourcePath)),
      buildSha256: sha256(readBytes(buildPath)),
    });
  });
  const newestBuildMtimeMs = assertLoadedBuildFreshness(records, processStartMs);
  const servedFrontend = await validateServedFrontendIdentity(baseUrl);
  return Object.freeze({
    baseUrl,
    pid,
    startAttemptId: typeof health.body?.startAttemptId === 'string' ? health.body.startAttemptId : null,
    stateGeneration: Number.isSafeInteger(health.body?.stateGeneration)
      ? health.body.stateGeneration
      : null,
    processStartTime: processIdentity.processStartTime,
    commandLineSha256: sha256(Buffer.from(processIdentity.identityValue, 'utf8')),
    processIdentitySource: processIdentity.identitySource,
    expectedEntry: processIdentity.expectedEntry,
    expectedEntryObserved: true,
    newestBuildMtime: new Date(newestBuildMtimeMs).toISOString(),
    sourceBuildPairs: Object.freeze(records),
    servedFrontend,
  });
}

function parseTapCount(output, key) {
  const matches = [...output.matchAll(new RegExp(`(?:^|\\n)#\\s+${key}\\s+(\\d+)\\s*(?:\\n|$)`, 'gu'))];
  assert.equal(matches.length, 1, `TAP output must contain exactly one ${key} count`);
  const value = Number.parseInt(matches[0][1], 10);
  assert.equal(Number.isSafeInteger(value) && value >= 0, true, `invalid TAP ${key} count`);
  return value;
}

function parseTapReport(run) {
  const output = run.stdout;
  assert.match(output, /^TAP version 13(?:\n|$)/u, 'Node test output is not TAP version 13');
  const statusMatches = [...output.matchAll(/^(ok|not ok)\s+\d+\s+-\s+(.+)$/gmu)];
  const records = new Map();
  for (let index = 0; index < statusMatches.length; index += 1) {
    const match = statusMatches[index];
    const rawName = match[2];
    const directive = rawName.match(/\s+#\s*(SKIP|TODO)\b.*$/iu);
    const name = directive ? rawName.slice(0, directive.index).trimEnd() : rawName;
    assert.equal(records.has(name), false, `duplicate TAP test name: ${name}`);
    const nextIndex = statusMatches[index + 1]?.index ?? output.search(/^1\.\.\d+$/mu);
    const bodyEnd = nextIndex >= 0 ? nextIndex : output.length;
    records.set(name, Object.freeze({
      name,
      status: directive ? 'other' : match[1] === 'ok' ? 'pass' : 'fail',
      directive: directive?.[1]?.toUpperCase() ?? null,
      body: output.slice(match.index, bodyEnd),
    }));
  }
  const summary = Object.freeze({
    total: parseTapCount(output, 'tests'),
    passed: parseTapCount(output, 'pass'),
    failed: parseTapCount(output, 'fail'),
    cancelled: parseTapCount(output, 'cancelled'),
    skipped: parseTapCount(output, 'skipped'),
    todo: parseTapCount(output, 'todo'),
  });
  assert.equal(
    summary.total,
    summary.passed + summary.failed + summary.cancelled + summary.skipped + summary.todo,
    'TAP summary is internally inconsistent',
  );
  assert.equal(records.size, summary.total, 'TAP named test count differs from total');
  return Object.freeze({ run, summary, records });
}

function flattenPlaywrightSpecs(suites, records) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      assert.equal(records.has(spec.title), false, `duplicate Playwright test name: ${spec.title}`);
      const projectTests = spec.tests ?? [];
      assert.equal(projectTests.length, 1, `Playwright test must execute in exactly one project: ${spec.title}`);
      const results = projectTests[0].results ?? [];
      assert.equal(results.length, 1, `Playwright retries must be zero: ${spec.title}`);
      const status = results[0].status;
      const normalizedStatus = status === 'passed'
        ? 'pass'
        : status === 'failed' || status === 'timedOut'
          ? 'fail'
          : status;
      const errors = [results[0].error, ...(results[0].errors ?? [])]
        .filter(Boolean)
        .map(error => `${error.message ?? ''}\n${error.stack ?? ''}\n${error.snippet ?? ''}`)
        .join('\n');
      records.set(spec.title, Object.freeze({
        name: spec.title,
        status: normalizedStatus,
        rawStatus: status,
        errors,
        file: spec.file,
        attachments: Object.freeze(results[0].attachments ?? []),
      }));
    }
    flattenPlaywrightSpecs(suite.suites, records);
  }
}

function decodePlaywrightAttachment(attachment) {
  assert.equal(attachment?.contentType, 'application/json',
    `retry evidence attachment has the wrong content type: ${attachment?.name ?? 'unknown'}`);
  if (typeof attachment.body === 'string') {
    return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
  }
  assert.equal(typeof attachment.path, 'string',
    `retry evidence attachment body/path is missing: ${attachment?.name ?? 'unknown'}`);
  return JSON.parse(readFileSync(attachment.path, 'utf8'));
}

function validatePreparationOperationLedger(ledger, testName) {
  assert.equal(ledger.schemaVersion, 'ph005-preparation-operation-ledger/v1',
    `preparation ledger schema differs: ${testName}`);
  assert.equal(Array.isArray(ledger.operations), true,
    `preparation ledger operations are missing: ${testName}`);
  const expectedOperationNames = [
    'cache-valid-stale',
    'cache-malformed',
    'cache-tombstone',
    'cache-absent',
    'configured-range',
    'partial-escape',
    'alternate-buffer',
  ];
  assert.equal(ledger.operations.length, expectedOperationNames.length,
    `preparation ledger operation count differs: ${testName}`);
  assert.deepEqual(ledger.operations.map(operation => operation.name), expectedOperationNames,
    `preparation ledger has missing, duplicate, or reordered operations: ${testName}`);
  assert.equal(new Set(ledger.operations.map(operation => operation.name)).size, expectedOperationNames.length,
    `preparation ledger has duplicate operations: ${testName}`);
  for (const operation of ledger.operations) {
    assert.deepEqual(
      { attempt: operation.attempt, outcome: operation.outcome, httpStatus: operation.httpStatus },
      { attempt: 1, outcome: 'success', httpStatus: 200 },
      `preparation ledger operation did not fail-fast and succeed exactly once: ${operation.name}`,
    );
  }
  return ledger;
}

function validateRetryAttemptEvidence(e2eReport) {
  const required = Object.freeze({
    'positional all-view handoff': Object.freeze({
      attachmentName: 'ph005-positional-retry-evidence',
      operation: 'canary-selection',
      maxAttempts: 8,
    }),
  });
  const records = {};
  for (const [testName, expected] of Object.entries(required)) {
    const testRecord = e2eReport.records.get(testName);
    assert.notEqual(testRecord, undefined, `retry evidence test did not execute: ${testName}`);
    const matching = testRecord.attachments.filter(attachment => attachment.name === expected.attachmentName);
    assert.equal(matching.length, 1, `retry evidence attachment count differs: ${testName}`);
    const evidence = decodePlaywrightAttachment(matching[0]);
    assert.equal(evidence.schemaVersion, 'ph005-retry-evidence/v1',
      `retry evidence schema differs: ${testName}`);
    assert.equal(evidence.operation, expected.operation, `retry evidence operation differs: ${testName}`);
    assert.equal(evidence.maxAttempts, expected.maxAttempts, `retry evidence maximum differs: ${testName}`);
    assert.equal(Array.isArray(evidence.attempts), true, `retry evidence attempts are missing: ${testName}`);
    assert.equal(evidence.attempts.length >= 1 && evidence.attempts.length <= expected.maxAttempts, true,
      `retry evidence attempt count is out of bounds: ${testName}`);
    assert.deepEqual(
      evidence.attempts.map(attempt => attempt.attempt),
      Array.from({ length: evidence.attempts.length }, (_, index) => index + 1),
      `retry evidence attempt ordinals are not contiguous: ${testName}`,
    );
    for (const attempt of evidence.attempts) {
      assert.equal(['success', 'retry', 'terminal-failure'].includes(attempt.outcome), true,
        `retry evidence outcome is invalid: ${testName}`);
      if (attempt.outcome !== 'success') {
        assert.equal(typeof attempt.failureReason === 'string' && attempt.failureReason.length > 0, true,
          `retry failure reason is missing: ${testName}`);
      }
    }
    assert.equal(evidence.attempts.at(-1)?.outcome, 'success',
      `successful E2E must record a terminal successful retry attempt: ${testName}`);
    records[testName] = evidence;
  }
  const poisonedTestName = 'poisoned no-cache reload';
  const poisonedRecord = e2eReport.records.get(poisonedTestName);
  assert.notEqual(poisonedRecord, undefined, `preparation ledger test did not execute: ${poisonedTestName}`);
  const ledgerAttachments = poisonedRecord.attachments.filter(
    attachment => attachment.name === 'ph005-preparation-operation-ledger',
  );
  assert.equal(ledgerAttachments.length, 1, `preparation ledger attachment count differs: ${poisonedTestName}`);
  const ledger = decodePlaywrightAttachment(ledgerAttachments[0]);
  records[poisonedTestName] = validatePreparationOperationLedger(ledger, poisonedTestName);
  return Object.freeze(records);
}

function runCompositeDiagnosticSelfTestChild() {
  validateRetryAttemptEvidence({
    records: new Map([[
      'positional all-view handoff',
      Object.freeze({
        name: 'positional all-view handoff',
        status: 'fail',
        errors: 'fixture positional body/setup failure',
        attachments: Object.freeze([]),
      }),
    ]]),
  });
}

function parsePlaywrightReport(run) {
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch (cause) {
    throw new Error('Playwright JSON reporter output is malformed', { cause });
  }
  assert.equal(report !== null && typeof report === 'object', true, 'Playwright report must be an object');
  const records = new Map();
  flattenPlaywrightSpecs(report.suites, records);
  const globalErrors = Array.isArray(report.errors) ? report.errors : [];
  const setupFatalPatterns = /E2E precondition failed|E2E cleanup failed|afterEach|teardown|ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError|TypeError:.*(?:undefined|null)/iu;
  const recordSetupFatals = [...records.values()]
    .filter(record => record.status === 'fail' && setupFatalPatterns.test(record.errors));
  return Object.freeze({
    run,
    report,
    records,
    globalErrors,
    setupFatalCount: globalErrors.length + recordSetupFatals.length,
    setupFatalNames: Object.freeze(recordSetupFatals.map(record => record.name)),
  });
}

function assertExactIdentity(records, expectedNames, label) {
  assert.equal(new Set(expectedNames).size, expectedNames.length, `${label} allowlist contains duplicates`);
  const actualNames = sorted(records.keys());
  assert.deepEqual(actualNames, sorted(expectedNames), `${label} test identity mismatch`);
  return Object.freeze({
    names: actualNames,
    sha256: canonicalSha256(actualNames),
  });
}

function selectRecords(records, names) {
  return new Map(names.map(name => {
    const record = records.get(name);
    assert.notEqual(record, undefined, `registered test did not execute: ${name}`);
    return [name, record];
  }));
}

function summarizeStatuses(records) {
  const values = [...records.values()];
  return Object.freeze({
    total: values.length,
    passed: values.filter(record => record.status === 'pass').length,
    failed: values.filter(record => record.status === 'fail').length,
    other: values.filter(record => record.status !== 'pass' && record.status !== 'fail').length,
  });
}

function tapExecutionSummaryIsExact(report) {
  const records = summarizeStatuses(report.records);
  return report.summary.cancelled === 0
    && report.summary.skipped === 0
    && report.summary.todo === 0
    && records.total === report.summary.total
    && records.passed === report.summary.passed
    && records.failed === report.summary.failed
    && records.other === 0;
}

function mergeDisjointRecords(left, right, label) {
  const duplicates = [...left.keys()].filter(name => right.has(name));
  assert.deepEqual(duplicates, [], `${label} contains cross-report duplicate test names`);
  return new Map([...left, ...right]);
}

function evaluateNodeReports(serverReport, frontendReport, mode) {
  const allRecords = mergeDisjointRecords(serverReport.records, frontendReport.records, 'Node focused');
  const allExpectedNames = sorted([
    ...serverCompatibilityNames,
    ...frontendCompatibilityNames,
    ...targetUnitNames,
    ...nonGateRegressionNames,
    ...protocolNonGateRegressionNames,
    ...frontendNonGateRegressionNames,
    ...frontendRuntimeNonGateRegressionNames,
    ...frontendInputNonGateRegressionNames,
  ]);
  const identity = assertExactIdentity(allRecords, allExpectedNames, 'Node focused');
  const expectedServerTotal = [...expectedNamesBySource]
    .filter(([path]) => path.startsWith('server/'))
    .reduce((total, [, names]) => total + names.length, 0);
  const expectedFrontendTotal = [...expectedNamesBySource]
    .filter(([path]) => path.startsWith('frontend/tests/unit/'))
    .reduce((total, [, names]) => total + names.length, 0);
  assert.equal(serverReport.summary.total, expectedServerTotal, 'server TAP total differs from source registration');
  assert.equal(frontendReport.summary.total, expectedFrontendTotal, 'frontend TAP total differs from source registration');
  const compatibilityRecords = selectRecords(allRecords, [
    ...serverCompatibilityNames,
    ...frontendCompatibilityNames,
  ]);
  const targetRecords = selectRecords(allRecords, targetUnitNames);
  const compatibility = summarizeStatuses(compatibilityRecords);
  const target = summarizeStatuses(targetRecords);
  const missingFailureSignatures = mode === 'red'
    ? [...targetRecords].filter(([name, record]) => (
        record.status !== 'fail'
        || !record.body.includes(targetFailureSignatures.get(name))
      )).map(([name]) => name)
    : [];
  const importModuleSetupFatalCount = [...allRecords.values()].filter(record => (
    !allExpectedNames.includes(record.name)
    && record.status === 'fail'
    && /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/u.test(record.body)
  )).length;
  const unexpectedPasses = mode === 'red' ? target.passed : 0;
  const unexpectedTargetFailures = mode === 'green' ? target.failed : 0;
  const unexpectedCompatibilityFailures = compatibility.failed + compatibility.other;
  const unexpectedRunExitCodes = [serverReport.run, frontendReport.run]
    .filter(run => run.exitCode !== (mode === 'red' ? 1 : 0)).length;
  const tapExecutionSummariesValid = [serverReport, frontendReport]
    .every(tapExecutionSummaryIsExact);
  const accepted = compatibility.total === thresholds.compatibility.exactTests
    && compatibility.failed <= thresholds.compatibility.maximumFailures
    && compatibility.other <= thresholds.compatibility.maximumSkipped
    && target.total === thresholds.targetUnit.exactTests
    && (mode === 'red' ? target.failed === target.total : target.passed === target.total)
    && unexpectedPasses <= thresholds.targetUnit.maximumUnexpectedPasses
    && unexpectedTargetFailures <= thresholds.targetUnit.maximumUnexpectedFailures
    && unexpectedCompatibilityFailures === 0
    && missingFailureSignatures.length === 0
    && importModuleSetupFatalCount === 0
    && tapExecutionSummariesValid
    && unexpectedRunExitCodes === 0;
  return Object.freeze({
    accepted,
    identity,
    compatibility,
    target,
    missingFailureSignatures: Object.freeze(missingFailureSignatures),
    importModuleSetupFatalCount,
    tapExecutionSummariesValid,
    unexpectedPasses,
    unexpectedTargetFailures,
    unexpectedCompatibilityFailures,
    unexpectedRunExitCodes,
  });
}

function evaluateGuardReport(report) {
  const identity = assertExactIdentity(report.records, guardTestNames, 'terminal authority debug route guards');
  const summary = summarizeStatuses(report.records);
  const exactExecutionSummary = tapExecutionSummaryIsExact(report);
  const accepted = summary.total === thresholds.routeGuards.exactTests
    && summary.passed === summary.total
    && summary.failed <= thresholds.routeGuards.maximumFailures
    && summary.other <= thresholds.routeGuards.maximumSkipped
    && exactExecutionSummary
    && report.run.exitCode === 0;
  return Object.freeze({ accepted, identity, ...summary, exactExecutionSummary });
}

function evaluateExtendedRegressionReport(report) {
  const statuses = summarizeStatuses(report.records);
  const exactExecutionSummary = tapExecutionSummaryIsExact(report);
  const accepted = statuses.total === thresholds.extendedRegression.exactTests
    && statuses.passed === statuses.total
    && statuses.failed <= thresholds.extendedRegression.maximumFailures
    && statuses.other <= thresholds.extendedRegression.maximumSkipped
    && exactExecutionSummary
    && report.run.exitCode === 0;
  return Object.freeze({ accepted, ...statuses, exactExecutionSummary });
}

function evaluateStalePredecessorReport(report) {
  const record = report.records.get(stalePredecessorTopologyTestName);
  assert.notEqual(record, undefined, 'stale predecessor topology regression did not execute');
  const accepted = record.status === 'pass' && report.run.exitCode === 0;
  return Object.freeze({
    accepted,
    name: stalePredecessorTopologyTestName,
    status: record.status,
    sourcePath: 'server/src/ws/WsRouterSplitHandshake.test.ts',
    sourceSha256: sha256(readBytes('server/src/ws/WsRouterSplitHandshake.test.ts')),
  });
}

function evaluateE2eReport(e2eReport, mode) {
  const identity = assertExactIdentity(e2eReport.records, e2eNames, 'PH005 E2E');
  const summary = summarizeStatuses(e2eReport.records);
  const unexpectedFiles = [...e2eReport.records.values()]
    .filter(record => record.file !== 'wave3-terminal-authority-promotion.spec.ts')
    .map(record => `${record.name}:${record.file ?? 'missing-file'}`);
  const unexpectedStatuses = mode === 'red'
    ? summary.passed + summary.other
    : summary.failed + summary.other;
  const expectedExitCode = mode === 'red' ? 1 : 0;
  const missingFailureSignatures = mode === 'red'
    ? [...e2eReport.records].filter(([name, record]) => (
        record.status !== 'fail'
        || !record.errors.includes(e2eFailureSignatures.get(name))
      )).map(([name]) => name)
    : [];
  const accepted = summary.total === thresholds.e2e.exactTests
    && (mode === 'red' ? summary.failed === summary.total : summary.passed === summary.total)
    && e2eReport.setupFatalCount <= thresholds.e2e.maximumSetupFatals
    && unexpectedStatuses <= thresholds.e2e.maximumUnexpectedStatuses
    && unexpectedFiles.length === 0
    && missingFailureSignatures.length === 0
    && e2eReport.run.exitCode === expectedExitCode;
  return Object.freeze({
    accepted,
    identity,
    ...summary,
    setupFatalCount: e2eReport.setupFatalCount,
    setupFatalNames: e2eReport.setupFatalNames,
    unexpectedStatuses,
    unexpectedFiles: Object.freeze(unexpectedFiles),
    missingFailureSignatures: Object.freeze(missingFailureSignatures),
    unexpectedRunExitCode: e2eReport.run.exitCode === expectedExitCode ? 0 : 1,
  });
}

function extractLiteralTestNames(source) {
  const names = [];
  const expression = /^\s*test\(\s*(['"`])(.+?)\1\s*,/gmu;
  for (const match of source.matchAll(expression)) names.push(match[2]);
  return sorted(names);
}

function validateSourceIdentity() {
  const identities = {};
  for (const [path, expectedNames] of expectedNamesBySource) {
    const names = extractLiteralTestNames(readUtf8(path));
    assert.equal(new Set(names).size, names.length, `source contains duplicate test names: ${path}`);
    assert.deepEqual(names, sorted(expectedNames), `source test identity mismatch: ${path}`);
    identities[path] = Object.freeze({ names, sha256: canonicalSha256(names) });
  }
  return Object.freeze(identities);
}

function validateGuardTestSourceIdentity() {
  const names = extractLiteralTestNames(readUtf8(guardTestSourcePath));
  assert.equal(new Set(names).size, names.length, `source contains duplicate test names: ${guardTestSourcePath}`);
  assert.deepEqual(names, guardTestNames, `source test identity mismatch: ${guardTestSourcePath}`);
  return Object.freeze({
    path: guardTestSourcePath,
    names,
    sha256: canonicalSha256(names),
  });
}

function validateSidecarRegistration() {
  const sidecar = JSON.parse(readUtf8(sidecarPath));
  const task = sidecar.tasks?.find(candidate => candidate.id === 'T-PH005-01');
  assert.notEqual(task, undefined, 'T-PH005-01 is missing from the plan sidecar');
  const cases = task.tdd?.test_cases;
  assert.equal(Array.isArray(cases), true, 'T-PH005-01 sidecar test cases are missing');
  assert.equal(cases.length, thresholds.registeredAssertions.exactAssertions,
    'T-PH005-01 sidecar must register exactly 13 assertions');
  const unitCases = cases.filter(candidate => candidate.kind !== 'e2e');
  const e2eCases = cases.filter(candidate => candidate.kind === 'e2e');
  assert.deepEqual(
    sorted(unitCases.map(candidate => candidate.test_symbol)),
    targetUnitNames,
    'sidecar unit registration differs from the exact unit allowlist',
  );
  const unitFailureRegistrations = unitCases
    .map(candidate => ({
      testSymbol: candidate.test_symbol,
      expectedFailureSignature: candidate.expected_failure_signature,
    }))
    .sort((left, right) => compareCodeUnits(left.testSymbol, right.testSymbol));
  const expectedUnitFailureRegistrations = [...targetFailureSignatures]
    .map(([testSymbol, expectedFailureSignature]) => ({ testSymbol, expectedFailureSignature }))
    .sort((left, right) => compareCodeUnits(left.testSymbol, right.testSymbol));
  assert.deepEqual(
    unitFailureRegistrations,
    expectedUnitFailureRegistrations,
    'sidecar unit failure signatures differ from the exact unit allowlist',
  );
  assert.equal(e2eCases.length, 1, 'sidecar must register one E2E aggregate assertion');
  assert.deepEqual(e2eCases[0], {
    id: 'TC-REQ-MIG-BGSTAB-002-AC4-04',
    req_id: 'MIG-BGSTAB-002',
    ac_refs: ['AC-4'],
    test_file: 'frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts',
    test_symbol: e2eAggregateTestSymbol,
    kind: 'e2e',
    expected_failure_signature: e2eAggregateFailureSignature,
  }, 'sidecar E2E aggregate registration changed');
  const e2eSource = readUtf8('frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts');
  assert.equal(e2eSource.split(e2eAggregateTestSymbol).length - 1, 1,
    'E2E aggregate describe symbol must occur exactly once');
  return Object.freeze({
    registeredAssertions: cases.length,
    unitAssertions: unitCases.length,
    e2eAggregateAssertions: e2eCases.length,
    e2eAggregateCases: e2eNames.length,
    e2eAggregateTestSymbol,
    e2eAggregateFailureSignature,
    sha256: canonicalSha256(cases),
  });
}

function tapFixture(records) {
  const lines = ['TAP version 13'];
  records.forEach((record, index) => {
    lines.push(`# Subtest: ${record.name}`);
    lines.push(`${record.status === 'pass' ? 'ok' : 'not ok'} ${index + 1} - ${record.name}`);
    if (record.body) lines.push('  ---', `  error: '${record.body}'`, '  ...');
  });
  const passed = records.filter(record => record.status === 'pass').length;
  const failed = records.length - passed;
  lines.push(`1..${records.length}`);
  lines.push(`# tests ${records.length}`);
  lines.push(`# pass ${passed}`);
  lines.push(`# fail ${failed}`);
  lines.push('# cancelled 0', '# skipped 0', '# todo 0');
  return `${lines.join('\n')}\n`;
}

function tapDirectiveFixture(directive) {
  const normalized = directive.toUpperCase();
  const skipped = normalized === 'SKIP' ? 1 : 0;
  const todo = normalized === 'TODO' ? 1 : 0;
  return [
    'TAP version 13',
    '# Subtest: target',
    `ok 1 - target # ${normalized} fail-closed fixture`,
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 0',
    '# cancelled 0',
    `# skipped ${skipped}`,
    `# todo ${todo}`,
    '',
  ].join('\n');
}

function runEvidenceToolSelfTests() {
  assert.equal(isTransientLiveRequestError(Object.assign(new Error('aborted'), { code: 'ECONNABORTED' })), true);
  assert.equal(isTransientLiveRequestError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientLiveRequestError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), false);
  const goodTap = parseTapReport({
    stdout: tapFixture([
      { name: 'compatibility', status: 'pass' },
      { name: 'target', status: 'fail', body: 'expected-contract-signature' },
    ]),
    stderr: '',
    exitCode: 1,
    command: 'fixture',
    cwd: '.',
  });
  assertExactIdentity(goodTap.records, ['compatibility', 'target'], 'self-test');
  for (const directive of ['SKIP', 'TODO']) {
    const directiveTap = parseTapReport({
      ...goodTap.run,
      stdout: tapDirectiveFixture(directive),
    });
    assert.equal(directiveTap.records.get('target')?.status, 'other',
      `TAP ${directive} directive must not normalize to pass`);
    assert.equal(tapExecutionSummaryIsExact(directiveTap), false,
      `TAP ${directive} directive must fail the exact execution summary gate`);
  }
  assert.throws(
    () => assertExactIdentity(new Map([['target', goodTap.records.get('target')]]), ['compatibility', 'target'], 'self-test'),
    /test identity mismatch/u,
    'missing test identity must fail closed',
  );
  assert.throws(
    () => assertExactIdentity(new Map([
      ['compatibility', goodTap.records.get('compatibility')],
      ['replacement', { ...goodTap.records.get('target'), name: 'replacement' }],
    ]), ['compatibility', 'target'], 'self-test'),
    /test identity mismatch/u,
    'replaced test identity must fail closed',
  );
  assert.throws(
    () => parseTapReport({
      ...goodTap.run,
      stdout: tapFixture([
        { name: 'duplicate', status: 'pass' },
        { name: 'duplicate', status: 'fail' },
      ]),
    }),
    /duplicate TAP test name/u,
    'duplicate TAP identity must fail closed',
  );
  assert.throws(
    () => mergeDisjointRecords(
      new Map([['duplicate-across-reports', { name: 'duplicate-across-reports' }]]),
      new Map([['duplicate-across-reports', { name: 'duplicate-across-reports' }]]),
      'self-test',
    ),
    /cross-report duplicate test names/u,
    'server/frontend duplicate identity must fail closed before merge',
  );

  const fatalPlaywright = parsePlaywrightReport({
    stdout: JSON.stringify({
      suites: [{
        specs: [{
          title: 'target-e2e',
          file: 'target.spec.ts',
          tests: [{ results: [{
            status: 'failed',
            error: { message: 'E2E precondition failed: module setup did not complete' },
          }] }],
        }],
      }],
      errors: [],
    }),
    stderr: '',
    exitCode: 1,
    command: 'fixture',
    cwd: '.',
  });
  assert.equal(fatalPlaywright.setupFatalCount, 1, 'setup fatal must be distinguished from contract failure');
  const validE2eRecords = new Map(e2eNames.map(name => [name, Object.freeze({
    name,
    status: 'fail',
    rawStatus: 'failed',
    errors: e2eFailureSignatures.get(name),
    file: 'wave3-terminal-authority-promotion.spec.ts',
  })]));
  const validE2eFixture = {
    run: { exitCode: 1 },
    records: validE2eRecords,
    setupFatalCount: 0,
    setupFatalNames: Object.freeze([]),
  };
  assert.equal(evaluateE2eReport(validE2eFixture, 'red').accepted, true,
    'exact E2E failure signatures must satisfy RED');
  const wrongReasonRecords = new Map(validE2eRecords);
  const wrongReasonName = e2eNames[0];
  wrongReasonRecords.set(wrongReasonName, Object.freeze({
    ...wrongReasonRecords.get(wrongReasonName),
    errors: 'page.goto: navigation timeout because the server is unavailable',
  }));
  const wrongReason = evaluateE2eReport({ ...validE2eFixture, records: wrongReasonRecords }, 'red');
  assert.equal(wrongReason.accepted, false, 'wrong-reason E2E failures must fail closed');
  assert.deepEqual(wrongReason.missingFailureSignatures, [wrongReasonName]);
  const mixedCleanupReport = parsePlaywrightReport({
    stdout: JSON.stringify({
      suites: [{
        specs: e2eNames.map((name, index) => ({
          title: name,
          file: 'wave3-terminal-authority-promotion.spec.ts',
          tests: [{ results: [{
            status: 'failed',
            error: {
              message: index === 0
                ? `${e2eFailureSignatures.get(name)}\nE2E cleanup failed: authority mode leaked`
                : e2eFailureSignatures.get(name),
            },
          }] }],
        })),
      }],
      errors: [],
    }),
    stderr: '',
    exitCode: 1,
    command: 'fixture',
    cwd: '.',
  });
  assert.equal(mixedCleanupReport.setupFatalCount, 1,
    'expected contract signature combined with cleanup failure must be classified fatal');
  assert.equal(evaluateE2eReport(mixedCleanupReport, 'red').accepted, false,
    'expected contract signature must not mask cleanup corruption');
  assert.throws(
    () => parsePlaywrightReport({ ...fatalPlaywright.run, stdout: '{not-json' }),
    /Playwright JSON reporter output is malformed/u,
    'malformed reporter output must fail closed',
  );

  const duplicatePlaywright = {
    suites: [{ specs: [
      { title: 'duplicate', tests: [{ results: [{ status: 'failed' }] }] },
      { title: 'duplicate', tests: [{ results: [{ status: 'failed' }] }] },
    ] }],
    errors: [],
  };
  assert.throws(
    () => parsePlaywrightReport({
      ...fatalPlaywright.run,
      stdout: JSON.stringify(duplicatePlaywright),
    }),
    /duplicate Playwright test name/u,
    'duplicate Playwright identity must fail closed',
  );
  assert.throws(
    () => verifyHashManifest({ 'source.ts': 'actual' }, { 'source.ts': 'expected' }, 'self-test'),
    /hash mismatch/u,
    'production source hash mismatch must fail closed',
  );

  const staleArtifactFixtureRoot = mkdtempSync(join(tmpdir(), 'buildergate-ph005-artifact-'));
  const staleArtifactFixture = join(staleArtifactFixtureRoot, 'authority-promotion-decision.json');
  try {
    writeFileSync(staleArtifactFixture, '{"decision":"STALE_ACCEPT"}\n', 'utf8');
    assert.equal(existsSync(staleArtifactFixture), true, 'stale artifact self-test fixture was not created');
    invalidateDecisionArtifact(staleArtifactFixture);
    assert.equal(existsSync(staleArtifactFixture), false, 'green stale artifact invalidation did not remove fixture');
  } finally {
    rmSync(staleArtifactFixtureRoot, { recursive: true, force: true });
  }

  assert.equal(targetUnitNames.length, 12, 'target unit allowlist literal count changed');
  assert.equal(e2eNames.length, 6, 'E2E allowlist literal count changed');
  assert.equal(serverCompatibilityNames.length, 5, 'server compatibility allowlist literal count changed');
  assert.equal(
    thresholds.compatibility.exactTests,
    serverCompatibilityNames.length + frontendCompatibilityNames.length,
    'compatibility threshold must equal the exact server and frontend allowlists',
  );
  assert.equal(frontendCompatibilityNames.length, 34, 'frontend compatibility allowlist literal count changed');
  assert.equal(thresholds.extendedRegression.exactTests, 59,
    'extended regression exact count must match the two registered production authority suites');
  assert.equal(
    integrationAcceptReason(),
    `exact-unit-${thresholds.targetUnit.exactTests}-extended-regression-${thresholds.extendedRegression.exactTests}-and-https-e2e-${thresholds.e2e.exactTests}-passed-with-unified-and-split-live-coverage`,
    'integration ACCEPT reason must state the exact registered unit, regression, and E2E counts',
  );
  assert.equal(guardTestNames.length, 5, 'debug route guard allowlist literal count changed');
  assert.equal(
    productionSourcePaths.includes('server/src/services/TerminalAuthorityDebugService.ts'),
    true,
    'production source identity omits the terminal authority debug service',
  );
  assert.equal(
    productionSourcePaths.includes('server/src/middleware/debugCaptureGuards.ts'),
    true,
    'production source identity omits the debug capture guards',
  );
  for (const requiredPath of [
    'server/src/utils/terminalPartialEscapeTail.ts',
    'frontend/src/utils/terminalWriteCoordinator.ts',
    'frontend/src/utils/terminalRawMutationAdapter.ts',
    'frontend/src/utils/terminalReplayGuard.ts',
  ]) {
    assert.equal(productionSourcePaths.includes(requiredPath), true,
      `production source identity omits checkpoint dependency: ${requiredPath}`);
  }
  assert.equal(thresholds.registeredAssertions.exactAssertions, 13,
    'registered assertion threshold must remain independent from unit and E2E totals');
  const selfTestTransportCoverage = evaluateSplitPhysicalLaneEvidence(selfTestSplitEvidence);
  assert.equal(selfTestTransportCoverage.split.verified, true,
    'integration ACCEPT requires a dedicated live split physical-lane fixture');
  assert.equal(selfTestTransportCoverage.split.activationAllowed, true,
    'verified split physical lanes must be eligible for the limited-session activation gate');
  for (const requiredRegressionPath of [
    'server/src/services/TerminalAuthorityDebugService.test.ts',
    'server/src/services/SessionManagerTerminalAuthorityRuntimePorts.test.ts',
  ]) {
    assert.equal(testSourcePaths.includes(requiredRegressionPath), true,
      `latest authority regression execution omits ${requiredRegressionPath}`);
  }
  for (const requiredDependencyPath of [
    'tools/daemon/process-info.js',
    'frontend/tests/e2e/helpers.ts',
  ]) {
    assert.equal(rawEvidenceDependencyPaths.includes(requiredDependencyPath), true,
      `evidence dependency hash coverage omits ${requiredDependencyPath}`);
  }
  const promotionE2eSource = readUtf8('frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts');
  for (const requiredZeroViewAnchor of [
    'server-output-retained-without-attached-view',
    'buildEchoSafeZeroViewProducerCommand',
    'zeroAttachedOutputIdentityMatch',
    'zeroAttachedReplacementCheckpoint',
    'zeroAttachedFullRetainedStateParity',
  ]) {
    assert.equal(promotionE2eSource.includes(requiredZeroViewAnchor), true,
      `poisoned no-cache E2E omits zero-attached recovery evidence: ${requiredZeroViewAnchor}`);
  }
  assert.equal(typeof validateRetryAttemptEvidence, 'function',
    'bounded retry attempt/failure provenance validator is missing');
  const validPreparationLedger = {
    schemaVersion: 'ph005-preparation-operation-ledger/v1',
    operations: [
      'cache-valid-stale',
      'cache-malformed',
      'cache-tombstone',
      'cache-absent',
      'configured-range',
      'partial-escape',
      'alternate-buffer',
    ].map(name => ({ name, attempt: 1, outcome: 'success', httpStatus: 200 })),
  };
  assert.equal(validatePreparationOperationLedger(validPreparationLedger, 'self-test'), validPreparationLedger,
    'valid preparation operation ledger must be returned unchanged');
  const validRetryEvidence = {
    schemaVersion: 'ph005-retry-evidence/v1',
    operation: 'canary-selection',
    maxAttempts: 8,
    attempts: [
      { attempt: 1, outcome: 'retry', failureReason: 'fixture transient failure' },
      { attempt: 2, outcome: 'success' },
    ],
  };
  const jsonAttachment = (name, value, overrides = {}) => ({
    name,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
    ...overrides,
  });
  const retryReportFixture = retryAttachments => ({
    records: new Map([
      ['positional all-view handoff', Object.freeze({
        name: 'positional all-view handoff',
        status: 'pass',
        errors: '',
        attachments: Object.freeze(retryAttachments),
      })],
      ['poisoned no-cache reload', Object.freeze({
        name: 'poisoned no-cache reload',
        status: 'pass',
        errors: '',
        attachments: Object.freeze([
          jsonAttachment('ph005-preparation-operation-ledger', validPreparationLedger),
        ]),
      })],
    ]),
  });
  const validRetryAttachment = jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence);
  assert.doesNotThrow(
    () => validateRetryAttemptEvidence(retryReportFixture([validRetryAttachment])),
    'valid retry attachment body must pass',
  );
  const retryAttachmentFixtureRoot = mkdtempSync(join(tmpdir(), 'buildergate-ph006-retry-'));
  try {
    const validRetryAttachmentPath = join(retryAttachmentFixtureRoot, 'valid.json');
    const malformedRetryAttachmentPath = join(retryAttachmentFixtureRoot, 'malformed.json');
    writeFileSync(validRetryAttachmentPath, JSON.stringify(validRetryEvidence), 'utf8');
    writeFileSync(malformedRetryAttachmentPath, '{', 'utf8');
    assert.doesNotThrow(
      () => validateRetryAttemptEvidence(retryReportFixture([
        jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          body: undefined,
          path: validRetryAttachmentPath,
        }),
      ])),
      'valid retry attachment path must pass',
    );
    const invalidRetryFixtures = [
      {
        name: 'missing selected retry record',
        report: { records: new Map() },
        error: /retry evidence test did not execute/u,
      },
      {
        name: 'missing retry attachment',
        report: retryReportFixture([]),
        error: /retry evidence attachment count differs/u,
      },
      {
        name: 'duplicate retry attachment',
        report: retryReportFixture([validRetryAttachment, validRetryAttachment]),
        error: /retry evidence attachment count differs/u,
      },
      {
        name: 'wrong retry attachment content type',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          contentType: 'text/plain',
        })]),
        error: /wrong content type/u,
      },
      {
        name: 'malformed retry attachment body',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          body: Buffer.from('{', 'utf8').toString('base64'),
        })]),
        error: /(Unexpected token|Expected property)/u,
      },
      {
        name: 'missing retry attachment body and path',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          body: undefined,
        })]),
        error: /body\/path is missing/u,
      },
      {
        name: 'missing retry attachment path',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          body: undefined,
          path: join(retryAttachmentFixtureRoot, 'missing.json'),
        })]),
        error: /ENOENT/u,
      },
      {
        name: 'malformed retry attachment path',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', validRetryEvidence, {
          body: undefined,
          path: malformedRetryAttachmentPath,
        })]),
        error: /(Unexpected token|Expected property)/u,
      },
      {
        name: 'wrong retry evidence schema',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          schemaVersion: 'wrong-schema',
        })]),
        error: /retry evidence schema differs/u,
      },
      {
        name: 'wrong retry evidence operation',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          operation: 'wrong-operation',
        })]),
        error: /retry evidence operation differs/u,
      },
      {
        name: 'wrong retry maximum attempts',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          maxAttempts: 7,
        })]),
        error: /retry evidence maximum differs/u,
      },
      {
        name: 'missing retry attempts array',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: null,
        })]),
        error: /retry evidence attempts are missing/u,
      },
      {
        name: 'empty retry attempts array',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [],
        })]),
        error: /retry evidence attempt count is out of bounds/u,
      },
      {
        name: 'too many retry attempts',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: Array.from({ length: 9 }, (_, index) => ({
            attempt: index + 1,
            outcome: index === 8 ? 'success' : 'retry',
            ...(index === 8 ? {} : { failureReason: 'fixture retry' }),
          })),
        })]),
        error: /retry evidence attempt count is out of bounds/u,
      },
      {
        name: 'noncontiguous retry attempt ordinal',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [
            { attempt: 1, outcome: 'retry', failureReason: 'fixture retry' },
            { attempt: 3, outcome: 'success' },
          ],
        })]),
        error: /retry evidence attempt ordinals are not contiguous/u,
      },
      {
        name: 'invalid retry attempt outcome',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [{ attempt: 1, outcome: 'unknown' }],
        })]),
        error: /retry evidence outcome is invalid/u,
      },
      {
        name: 'missing retry failure reason',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [
            { attempt: 1, outcome: 'retry' },
            { attempt: 2, outcome: 'success' },
          ],
        })]),
        error: /retry failure reason is missing/u,
      },
      {
        name: 'empty retry failure reason',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [
            { attempt: 1, outcome: 'retry', failureReason: '' },
            { attempt: 2, outcome: 'success' },
          ],
        })]),
        error: /retry failure reason is missing/u,
      },
      {
        name: 'retry evidence without terminal success',
        report: retryReportFixture([jsonAttachment('ph005-positional-retry-evidence', {
          ...validRetryEvidence,
          attempts: [{ attempt: 1, outcome: 'terminal-failure', failureReason: 'fixture terminal failure' }],
        })]),
        error: /terminal successful retry attempt/u,
      },
    ];
    for (const fixture of invalidRetryFixtures) {
      assert.throws(
        () => validateRetryAttemptEvidence(fixture.report),
        fixture.error,
        `${fixture.name} must fail closed`,
      );
    }
  } finally {
    rmSync(retryAttachmentFixtureRoot, { recursive: true, force: true });
  }
  const compositeDiagnosticChild = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--self-test-composite-fixture'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(compositeDiagnosticChild.error, undefined,
    'composite diagnostic child must start without a process error');
  assert.equal(compositeDiagnosticChild.signal, null,
    'composite diagnostic child must terminate without a signal');
  assert.equal(compositeDiagnosticChild.status, 1,
    'composite diagnostic child must reject the invalid retry evidence');
  assert.equal(compositeDiagnosticChild.stderr.trim().length > 0, true,
    'composite diagnostic child must write its rejected error to stderr');
  const compositeDiagnosticLines = compositeDiagnosticChild.stdout.trimEnd().split(/\r?\n/u);
  assert.equal(compositeDiagnosticLines.length, 1,
    'composite diagnostic child must emit exactly one JSON stdout line');
  const compositeDiagnostic = JSON.parse(compositeDiagnosticLines[0]);
  assert.equal(compositeDiagnostic.contractSatisfied, false,
    'composite diagnostic child must preserve a rejected contract result');
  assert.match(compositeDiagnostic.error, /positional all-view handoff/u,
    'composite diagnostic error must preserve the failed positional record name');
  assert.match(compositeDiagnostic.error, /fixture positional body\/setup failure/u,
    'composite diagnostic error must preserve the failed positional body/setup error');
  assert.match(compositeDiagnostic.error, /retry evidence attachment count differs/u,
    'composite diagnostic error must preserve the retry attachment validation error');
  assert.throws(
    () => validatePreparationOperationLedger({
      ...validPreparationLedger,
      operations: [
        ...validPreparationLedger.operations.slice(0, -1),
        validPreparationLedger.operations[0],
      ],
    }, 'self-test'),
    /missing, duplicate, or reordered operations/u,
    'duplicate preparation operation must fail closed',
  );
  assert.throws(
    () => validatePreparationOperationLedger({
      ...validPreparationLedger,
      operations: validPreparationLedger.operations.slice(0, -1),
    }, 'self-test'),
    /operation count differs/u,
    'missing preparation operation must fail closed',
  );
  assert.throws(
    () => validatePreparationOperationLedger({
      ...validPreparationLedger,
      operations: validPreparationLedger.operations.map((operation, index) => (
        index === 0 ? { ...operation, attempt: 2 } : operation
      )),
    }, 'self-test'),
    /did not fail-fast and succeed exactly once/u,
    'retried preparation operation must fail closed',
  );
  assert.throws(
    () => validatePreparationOperationLedger({
      ...validPreparationLedger,
      operations: validPreparationLedger.operations.map((operation, index) => (
        index === 0 ? { ...operation, httpStatus: 202 } : operation
      )),
    }, 'self-test'),
    /did not fail-fast and succeed exactly once/u,
    'non-200 preparation operation must fail closed',
  );
  assert.equal(typeof persistRawExecutionEvidence, 'function',
    'raw stdout/stderr persistence is missing');
  const freshBuildFixture = [{
    sourcePath: 'source.ts',
    sourceMtimeMs: 1_000,
    buildMtimeMs: 1_100,
  }];
  assert.equal(assertLoadedBuildFreshness(freshBuildFixture, 1_200), 1_100,
    'fresh loaded-build fixture must pass');
  assert.throws(
    () => assertLoadedBuildFreshness([{ ...freshBuildFixture[0], buildMtimeMs: -2_000 }], 1_200),
    /build output predates current source/u,
    'stale compiled output must fail closed',
  );
  assert.throws(
    () => assertLoadedBuildFreshness(freshBuildFixture, -2_000),
    /process predates the current compiled authority build/u,
    'a live process older than the current build must fail closed',
  );
  assert.equal(
    assertExpectedServerEntry(`node.exe "${absolute('server/dist/index.js')}"`),
    absolute('server/dist/index.js'),
    'absolute current-checkout server entry must pass',
  );
  assert.throws(
    () => assertExpectedServerEntry('node.exe server/dist/index.js'),
    /absolute server entry/u,
    'relative or other-checkout server entry must fail closed',
  );
  const identityNow = Date.parse('2026-07-18T12:00:10.000Z');
  const boundHealth = Object.freeze({
    pid: 41_001,
    startAttemptId: 'attempt-bound-to-health',
    stateGeneration: 17,
  });
  const boundState = Object.freeze({
    mode: 'daemon',
    status: 'running',
    appPid: boundHealth.pid,
    startAttemptId: boundHealth.startAttemptId,
    stateGeneration: boundHealth.stateGeneration,
    port: 2222,
    serverEntryPath: absolute('server/dist/index.js'),
    serverCwd: absolute('server'),
    launcherPath: absolute('tools/start-runtime.js'),
    configPath: absolute('server/config.json5'),
    appProcessStartedAt: '2026-07-18T12:00:00.000Z',
    heartbeatAt: '2026-07-18T12:00:09.000Z',
  });
  assert.equal(
    validateDaemonStateHealthBinding(boundHealth, 'https://localhost:2222', boundState, identityNow)
      .identitySource,
    'daemon-state-health-binding',
    'health-bound daemon identity fixture must pass',
  );
  assert.throws(
    () => validateDaemonStateHealthBinding(
      boundHealth,
      'https://localhost:2222',
      { ...boundState, appPid: 41_002 },
      identityNow,
    ),
    /pid mismatch/u,
    'daemon state belonging to another pid must fail closed',
  );
  assert.throws(
    () => validateDaemonStateHealthBinding(
      boundHealth,
      'https://localhost:2222',
      { ...boundState, serverEntryPath: absolute('server/dist/not-index.js') },
      identityNow,
    ),
    /server entry/u,
    'daemon state belonging to another server entry must fail closed',
  );
  const stableIdentity = Object.freeze({ files: Object.freeze({ 'source.ts': 'same' }) });
  assert.doesNotThrow(() => assertExecutionInputIdentityUnchanged(stableIdentity, stableIdentity));
  assert.throws(
    () => assertExecutionInputIdentityUnchanged(
      stableIdentity,
      Object.freeze({ files: Object.freeze({ 'source.ts': 'changed' }) }),
    ),
    /changed while verification was running/u,
    'execution-time source mutation must fail closed',
  );
}

function compactRun(report, raw) {
  return Object.freeze({
    cwd: report.run.cwd,
    command: report.run.command,
    exitCode: report.run.exitCode,
    stdoutSha256: sha256(Buffer.from(report.run.stdout, 'utf8')),
    stderrSha256: sha256(Buffer.from(report.run.stderr, 'utf8')),
    stdoutPath: raw.stdoutPath,
    stderrPath: raw.stderrPath,
  });
}

function persistRawExecutionEvidence(reports, supplemental) {
  const root = absolute(rawExecutionRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const runs = {};
  const rawEvidencePaths = [];
  for (const [name, report] of Object.entries(reports)) {
    const stdoutPath = `${rawExecutionRoot}/${name}.stdout.txt`;
    const stderrPath = `${rawExecutionRoot}/${name}.stderr.txt`;
    writeFileSync(absolute(stdoutPath), report.run.stdout, 'utf8');
    writeFileSync(absolute(stderrPath), report.run.stderr, 'utf8');
    rawEvidencePaths.push(stdoutPath, stderrPath);
    runs[name] = Object.freeze({
      stdoutPath,
      stderrPath,
      stdoutSha256: sha256(readBytes(stdoutPath)),
      stderrSha256: sha256(readBytes(stderrPath)),
    });
  }
  const supplementalPath = `${rawExecutionRoot}/supplemental-evidence.json`;
  writeFileSync(absolute(supplementalPath), `${JSON.stringify(supplemental, null, 2)}\n`, 'utf8');
  rawEvidencePaths.push(supplementalPath);
  return Object.freeze({
    root: rawExecutionRoot,
    paths: sorted(rawEvidencePaths),
    runs: Object.freeze(runs),
    supplemental: Object.freeze({
      path: supplementalPath,
      sha256: sha256(readBytes(supplementalPath)),
    }),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const knownArgs = new Set(['--expect-red', '--expect-green', '--self-test', '--self-test-composite-fixture']);
  assert.equal(args.every(arg => knownArgs.has(arg)), true, `unknown argument: ${args.join(' ')}`);
  assert.equal(args.filter(arg => arg === '--expect-red' || arg === '--expect-green').length <= 1, true,
    'choose only one expectation mode');
  assert.equal(!args.includes('--self-test') || args.length === 1, true,
    '--self-test cannot be combined with an execution mode');
  assert.equal(!args.includes('--self-test-composite-fixture') || args.length === 1, true,
    '--self-test-composite-fixture cannot be combined with an execution mode');

  if (args.includes('--self-test-composite-fixture')) {
    runCompositeDiagnosticSelfTestChild();
    return;
  }

  const selfTestOnly = args.includes('--self-test');
  const executionMode = args.includes('--expect-red')
    ? 'red'
    : args.includes('--expect-green')
      ? 'focused-green'
      : 'integration';
  const mode = args.includes('--expect-red') ? 'red' : 'green';
  const shouldWriteDecisionArtifact = !selfTestOnly && executionMode === 'integration';
  if (shouldWriteDecisionArtifact) {
    invalidateDecisionArtifact(absolute(artifactPath));
  }

  runEvidenceToolSelfTests();
  const selfTestTransportCoverage = selfTestOnly ? await validateSplitPhysicalLanes() : null;
  const sourceIdentity = validateSourceIdentity();
  const guardTestSourceIdentity = validateGuardTestSourceIdentity();
  const redTestSourceIdentity = executionMode === 'red'
    ? validateRedTestSourceManifest()
    : null;
  const sidecarRegistration = validateSidecarRegistration();
  if (args.includes('--self-test')) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion,
      selfTest: 'pass',
      evidenceToolPath,
      sourceIdentitySha256: canonicalSha256(sourceIdentity),
      guardTestSourceIdentity,
      redTestSourceIdentity,
      sidecarRegistration,
      transportCoverage: selfTestTransportCoverage,
      failClosedProofs: [
        'missing',
        'replaced',
        'duplicate',
        'cross-report-duplicate',
        'fatal',
        'wrong-failure-reason',
        'malformed-report',
        'tap-skip-todo',
        'cleanup-failure-cannot-hide-behind-expected-signature',
        'red-test-source-hash-mismatch',
        'green-stale-artifact-invalidated-before-verification',
        'live-build-source-process-identity-freshness',
        'split-transport-activation-requires-and-passes-live-physical-lane-fixture',
        'auth-locality-session-handler-route-guard-order',
      ],
    })}\n`);
    return;
  }

  if (mode === 'red') {
    assert.equal(existsSync(absolute(artifactPath)), false,
      'RED evidence must not run while an authority promotion decision artifact exists');
  } else if (executionMode === 'focused-green') {
    assert.equal(existsSync(absolute(artifactPath)), false,
      'focused GREEN evidence must not run with or create a final decision artifact');
  }

  const redProductionUnchanged = mode === 'red' ? verifyRedProductionUnchanged() : null;
  const executionInputIdentity = mode === 'green' ? captureExecutionInputIdentity() : null;
  const loadedBuildIdentity = mode === 'green' ? await validateLoadedBuildIdentity() : null;
  const transportCoverage = mode === 'green'
    ? await validateSplitPhysicalLanes()
    : buildTransportCoverage({
        verified: false,
        activationAllowed: false,
        reason: 'RED-does-not-claim-live-split-coverage',
      });

  const serverReport = parseTapReport(runCommand(serverCommand));
  const frontendReport = parseTapReport(runCommand(frontendCommand));
  const guardReport = mode === 'green' ? parseTapReport(runCommand(guardCommand)) : null;
  const extendedRegressionReport = mode === 'green'
    ? parseTapReport(runCommand(extendedRegressionCommand))
    : null;
  const stalePredecessorReport = mode === 'green'
    ? parseTapReport(runCommand(stalePredecessorCommand))
    : null;
  const e2eReport = parsePlaywrightReport(runCommand(e2eCommand));
  const postRunLoadedBuildIdentity = mode === 'green' ? await validateLoadedBuildIdentity() : null;
  if (loadedBuildIdentity && postRunLoadedBuildIdentity) {
    assert.deepEqual(postRunLoadedBuildIdentity, loadedBuildIdentity,
      'live backend/frontend build identity changed while verification was running');
  }
  if (executionInputIdentity) {
    assertExecutionInputIdentityUnchanged(executionInputIdentity, captureExecutionInputIdentity());
  }
  const nodeEvaluation = evaluateNodeReports(serverReport, frontendReport, mode);
  const guardEvaluation = guardReport ? evaluateGuardReport(guardReport) : null;
  const extendedRegressionEvaluation = extendedRegressionReport
    ? evaluateExtendedRegressionReport(extendedRegressionReport)
    : null;
  const stalePredecessorEvaluation = stalePredecessorReport
    ? evaluateStalePredecessorReport(stalePredecessorReport)
    : null;
  const e2eEvaluation = evaluateE2eReport(e2eReport, mode);
  const retryAttemptEvidence = mode === 'green' ? validateRetryAttemptEvidence(e2eReport) : null;
  const e2eAggregatePassed = e2eEvaluation.accepted && (mode === 'red'
    ? e2eEvaluation.failed === thresholds.e2e.exactTests
    : e2eEvaluation.passed === thresholds.e2e.exactTests);
  const registeredAssertions = Object.freeze({
    total: targetUnitNames.length + 1,
    passed: mode === 'green' ? nodeEvaluation.target.passed + (e2eAggregatePassed ? 1 : 0) : 0,
    failed: mode === 'red' ? nodeEvaluation.target.failed + (e2eAggregatePassed ? 1 : 0) : 0,
    e2eAggregateCases: e2eEvaluation.total,
  });
  const accepted = nodeEvaluation.accepted
    && (mode === 'red' || guardEvaluation?.accepted === true)
    && (mode === 'red' || extendedRegressionEvaluation?.accepted === true)
    && (mode === 'red' || stalePredecessorEvaluation?.accepted === true)
    && (mode === 'red' || transportCoverage.split.verified === true)
    && e2eEvaluation.accepted
    && registeredAssertions.total === thresholds.registeredAssertions.exactAssertions
    && (mode === 'red'
      ? registeredAssertions.failed === registeredAssertions.total
      : registeredAssertions.passed === registeredAssertions.total);

  const summary = {
    schemaVersion,
    phaseId: 'PH-005',
    taskId: mode === 'red'
      ? 'T-PH005-01'
      : executionMode === 'focused-green'
        ? 'T-PH005-02'
        : 'T-PH005-03',
    mode: mode === 'red'
      ? 'expect-red'
      : executionMode === 'focused-green'
        ? 'expect-green'
        : 'integration-accept',
    compatibility: nodeEvaluation.compatibility,
    targetUnit: nodeEvaluation.target,
    routeGuards: guardEvaluation,
    extendedRegression: extendedRegressionEvaluation,
    stalePredecessorTopology: stalePredecessorEvaluation,
    e2e: {
      total: e2eEvaluation.total,
      passed: e2eEvaluation.passed,
      failed: e2eEvaluation.failed,
      other: e2eEvaluation.other,
      setupFatalCount: e2eEvaluation.setupFatalCount,
    },
    registeredAssertions,
    importModuleSetupFatalCount: nodeEvaluation.importModuleSetupFatalCount
      + e2eEvaluation.setupFatalCount,
    unexpected: {
      nodePasses: nodeEvaluation.unexpectedPasses,
      nodeTargetFailures: nodeEvaluation.unexpectedTargetFailures,
      compatibilityFailures: nodeEvaluation.unexpectedCompatibilityFailures,
      nodeExitCodes: nodeEvaluation.unexpectedRunExitCodes,
      e2eStatuses: e2eEvaluation.unexpectedStatuses,
      e2eFiles: e2eEvaluation.unexpectedFiles,
      e2eExitCode: e2eEvaluation.unexpectedRunExitCode,
      missingFailureSignatures: nodeEvaluation.missingFailureSignatures,
      missingE2eFailureSignatures: e2eEvaluation.missingFailureSignatures,
    },
    exactIdentity: {
      nodeSha256: nodeEvaluation.identity.sha256,
      e2eSha256: e2eEvaluation.identity.sha256,
      sourceSha256: canonicalSha256(sourceIdentity),
      redTestSourceSha256: redTestSourceIdentity?.sourceSetSha256 ?? null,
      sidecarRegistrationSha256: sidecarRegistration.sha256,
    },
    decisionArtifact: {
      path: artifactPath,
      written: false,
      exists: existsSync(absolute(artifactPath)),
    },
    productionUnchanged: redProductionUnchanged,
    loadedBuildIdentity,
    transportCoverage,
    contractSatisfied: accepted,
  };

  const contractDiagnostics = {
    nodeAccepted: nodeEvaluation.accepted,
    routeGuardsAccepted: mode === 'red' || guardEvaluation?.accepted === true,
    extendedRegressionAccepted: mode === 'red' || extendedRegressionEvaluation?.accepted === true,
    stalePredecessorAccepted: mode === 'red' || stalePredecessorEvaluation?.accepted === true,
    routeGuards: guardEvaluation,
    compatibility: nodeEvaluation.compatibility,
    targetUnit: nodeEvaluation.target,
    nodeImportModuleSetupFatalCount: nodeEvaluation.importModuleSetupFatalCount,
    nodeTapExecutionSummariesValid: nodeEvaluation.tapExecutionSummariesValid,
    nodeUnexpectedRunExitCodes: nodeEvaluation.unexpectedRunExitCodes,
    nodeMissingFailureSignatures: nodeEvaluation.missingFailureSignatures,
    nodeFailedRecords: [...serverReport.records.values(), ...frontendReport.records.values()]
      .filter(record => record.status === 'fail')
      .map(record => ({ name: record.name, errors: record.errors })),
    e2eAccepted: e2eEvaluation.accepted,
    e2e: summary.e2e,
    e2eSetupFatalNames: e2eEvaluation.setupFatalNames,
    e2eUnexpectedStatuses: e2eEvaluation.unexpectedStatuses,
    e2eUnexpectedFiles: e2eEvaluation.unexpectedFiles,
    e2eUnexpectedRunExitCode: e2eEvaluation.unexpectedRunExitCode,
    e2eMissingFailureSignatures: e2eEvaluation.missingFailureSignatures,
    e2eFailedRecords: [...e2eReport.records.values()]
      .filter(record => record.status === 'fail')
      .map(record => ({ name: record.name, errors: record.errors })),
    registeredAssertions,
    splitPhysicalLaneVerified: mode === 'red' || transportCoverage.split.verified === true,
    retryAttemptEvidence,
  };
  assert.equal(
    accepted,
    true,
    `authority promotion ${summary.mode} evidence contract failed: ${JSON.stringify(contractDiagnostics)}`,
  );

  if (mode === 'red') {
    assert.equal(existsSync(absolute(artifactPath)), false, 'RED evidence created a forbidden decision artifact');
    process.stdout.write(`${JSON.stringify({ ...summary, intendedExitCode: 1 })}\n`);
    process.exitCode = 1;
    return;
  }

  if (!shouldWriteDecisionArtifact) {
    assert.equal(existsSync(absolute(artifactPath)), false,
      'focused GREEN evidence created a forbidden final decision artifact');
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  assert.notEqual(executionInputIdentity, null, 'integration ACCEPT requires a pre-run input identity');
  const {
    inputHashes,
    configHashes,
    testHashes,
    sourceHashes,
    evidenceDependencyHashes,
    evidenceTool,
  } = executionInputIdentity;
  const evidenceInputPaths = sorted(new Set([
    evidenceToolPath,
    ...inputPaths,
    ...configPaths,
    ...testSourcePaths,
    guardTestSourcePath,
    ...productionSourcePaths,
    ...rawEvidenceDependencyPaths,
  ]));
  assert.notEqual(extendedRegressionReport, null, 'integration ACCEPT requires extended regressions');
  assert.notEqual(stalePredecessorReport, null, 'integration ACCEPT requires stale predecessor regression');
  const rawExecutionEvidence = persistRawExecutionEvidence({
    server: serverReport,
    frontend: frontendReport,
    guardRoutes: guardReport,
    extendedRegression: extendedRegressionReport,
    stalePredecessor: stalePredecessorReport,
    e2e: e2eReport,
  }, {
    transportCoverage,
    retryAttemptEvidence,
    liveRequestAttempts: liveRequestAttemptLog,
  });
  const artifact = {
    schemaVersion,
    requirementIds: ['MIG-BGSTAB-002', 'REL-BGSTAB-007'],
    phaseId: 'PH-005',
    taskIds: ['T-PH005-03', 'T-PH005-04'],
    runCapturedAt: new Date().toISOString(),
    invocation: 'node tools/wave3/authority-promotion-evidence.test.mjs',
    decision: {
      verdict: 'ACCEPT',
      reason: integrationAcceptReason(),
      scope: 'capability-negotiated-limited-session-promotion-unified-and-split-live-coverage',
      capabilityNegotiated: true,
      limitedSessionScope: true,
      productDefaultChanged: false,
      uiChanged: false,
      legacyPhysicalDeletion: false,
      splitTransportActivationAllowed: true,
    },
    thresholds,
    results: {
      compatibility: nodeEvaluation.compatibility,
      extendedRegression: extendedRegressionEvaluation,
      stalePredecessorTopology: stalePredecessorEvaluation,
      targetUnit: nodeEvaluation.target,
      e2e: {
        total: e2eEvaluation.total,
        passed: e2eEvaluation.passed,
        failed: e2eEvaluation.failed,
        other: e2eEvaluation.other,
        setupFatalCount: e2eEvaluation.setupFatalCount,
      },
      registeredAssertions,
      importModuleSetupFatalCount: 0,
      unexpectedPassesOrFailures: 0,
    },
    identities: {
      nodeTestNames: nodeEvaluation.identity.names,
      nodeTestNamesSha256: nodeEvaluation.identity.sha256,
      e2eTestNames: e2eEvaluation.identity.names,
      e2eTestNamesSha256: e2eEvaluation.identity.sha256,
      sourceIdentity,
      sourceIdentitySha256: canonicalSha256(sourceIdentity),
      guardTestSourceIdentity,
      sidecarRegistration,
      loadedBuildIdentity,
      transportCoverage,
    },
    runs: {
      server: compactRun(serverReport, rawExecutionEvidence.runs.server),
      frontend: compactRun(frontendReport, rawExecutionEvidence.runs.frontend),
      guardRoutes: compactRun(guardReport, rawExecutionEvidence.runs.guardRoutes),
      extendedRegression: compactRun(
        extendedRegressionReport,
        rawExecutionEvidence.runs.extendedRegression,
      ),
      stalePredecessor: compactRun(
        stalePredecessorReport,
        rawExecutionEvidence.runs.stalePredecessor,
      ),
      e2e: compactRun(e2eReport, rawExecutionEvidence.runs.e2e),
    },
    rawEvidencePaths: rawExecutionEvidence.paths,
    rawExecutionEvidence,
    evidenceInputPaths,
    inputHashes,
    configHashes,
    testHashes,
    sourceHashes,
    evidenceDependencyHashes,
    evidenceTool,
  };
  mkdirSync(dirname(absolute(artifactPath)), { recursive: true });
  const temporaryArtifactPath = `${artifactPath}.tmp-${process.pid}`;
  assert.equal(existsSync(absolute(temporaryArtifactPath)), false,
    'authority promotion artifact temporary path already exists');
  try {
    writeFileSync(absolute(temporaryArtifactPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    renameSync(absolute(temporaryArtifactPath), absolute(artifactPath));
  } finally {
    rmSync(absolute(temporaryArtifactPath), { force: true });
  }
  assert.deepEqual(JSON.parse(readUtf8(artifactPath)), artifact,
    'authority promotion decision artifact round-trip failed');
  summary.decisionArtifact = { path: artifactPath, written: true, exists: true };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch(cause => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  process.stdout.write(`${JSON.stringify({
    schemaVersion,
    contractSatisfied: false,
    error: error.message,
  })}\n`);
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, ResourceLimitsConfig } from '../types/config.types.js';
import { resourceLimitsSchema } from '../schemas/config.schema.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { loadConfigFromPath, loadConfigFromPathStrict } from '../utils/config.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMA_VERSION = 'terminal-resource-policy/v1';
const PROFILE_VERSION = 'legacy-effective/v1';
const MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/terminal-resource-consumer-manifest.current.json',
);
const KNOWN_STABLE_PROFILE = {
  policyId: 'rel-bgstab-007-legacy-equivalent',
  profileVersion: '1.0.0',
} as const;
const KNOWN_NON_STABLE_PROFILE = {
  policyId: 'wave3-experimental',
  profileVersion: '0.1.0',
} as const;
const EXPECTED_CATEGORIES = [
  'server-config-schema-store',
  'pty-headless-model',
  'websocket-router-send-policy',
  'snapshot-replay-repair',
  'browser-runtime-residency-hidden-output',
  'terminal-write-recovery-scheduler',
  'persisted-snapshot-storage',
] as const;
const EXPECTED_POLICY_CONSUMER_IDS = [
  'server.config.schema',
  'server.config.runtime-store',
  'server.pty.headless-model',
  'server.ws.router',
  'server.ws.send-policy',
  'server.snapshot.replay-repair',
  'browser.runtime.residency',
  'browser.hidden-output',
  'browser.terminal.write-scheduler',
  'browser.terminal.recovery-scheduler',
  'browser.snapshot.persisted-storage',
] as const;
const EXPECTED_RESOURCE_KEYS = [
  'resourceLimits.clientWs.hardReconnectBytes',
  'resourceLimits.clientWs.inputBackpressureBytes',
  'resourceLimits.headless.overflowPolicy',
  'resourceLimits.headless.pendingOutputMaxBytes',
  'resourceLimits.headless.pendingOutputMaxChunks',
  'resourceLimits.headless.writeBatchMaxBytes',
  'resourceLimits.headless.writeLagWarnMs',
  'resourceLimits.snapshots.maxEntries',
  'resourceLimits.snapshots.perSnapshotMaxChars',
  'resourceLimits.snapshots.tombstoneTtlMs',
  'resourceLimits.snapshots.totalStorageBudgetChars',
  'resourceLimits.terminal.checkpointMaxBytes',
  'resourceLimits.terminal.hiddenOutputPolicy',
  'resourceLimits.terminal.hiddenOutputTailBytes',
  'resourceLimits.terminal.inputQueueMaxBytes',
  'resourceLimits.terminal.inputQueueTtlMs',
  'resourceLimits.terminal.scrollbackLines',
  'resourceLimits.terminal.transportOutboxMaxBytes',
  'resourceLimits.terminal.transportOutboxTtlMs',
  'resourceLimits.terminal.visibleFlushBudgetBytes',
  'resourceLimits.terminal.visibleOutputMaxChunks',
  'resourceLimits.terminal.visibleOutputQueueMaxBytes',
  'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs',
  'resourceLimits.workspaceRuntime.maxLiveTerminals',
  'resourceLimits.workspaceRuntime.maxLiveWorkspaces',
  'resourceLimits.ws.outputCoalesceWindowMs',
  'resourceLimits.ws.perClientControlQueueMaxBytes',
  'resourceLimits.ws.perClientOutputQueueMaxBytes',
  'resourceLimits.ws.serverBufferedHardLimitBytes',
  'resourceLimits.ws.serverBufferedHighWaterBytes',
] as const;
const EXPECTED_TRACE_PATHS = [
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/hooks/useTerminalRuntimeResidency.ts',
  'frontend/src/services/tokenStorage.ts',
  'frontend/src/utils/inputReliabilityMode.ts',
  'frontend/src/utils/terminalHiddenOutput.ts',
  'frontend/src/utils/terminalOutputHotPath.ts',
  'frontend/src/utils/terminalOutputScheduler.ts',
  'frontend/src/utils/terminalSnapshot.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
  'server/src/schemas/config.schema.ts',
  'server/src/services/ConfigFileRepository.ts',
  'server/src/services/RuntimeConfigStore.ts',
  'server/src/services/SessionManager.ts',
  'server/src/services/SettingsService.ts',
  'server/src/types/config.types.ts',
  'server/src/utils/headlessOutputQueue.ts',
  'server/src/utils/headlessTerminal.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/ws/wsSendPolicy.ts',
] as const;

type ContractModule = typeof import('./TerminalResourcePolicy.js');
type InventoryContractModule = typeof import('./TerminalResourcePolicyInventory.js');

const EXPECTED_FAILURES = {
  'AC-1': 'OBS-BGSTAB-005 AC-1 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-2': 'OBS-BGSTAB-005 AC-2 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-3': 'OBS-BGSTAB-005 AC-3 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-4': 'OBS-BGSTAB-005 AC-4 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-5': 'OBS-BGSTAB-005 AC-5 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-6': 'OBS-BGSTAB-005 AC-6 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
  'AC-7': 'OBS-BGSTAB-005 AC-7 Observe-only TerminalResourcePolicy 계약 부재 때문에 실패',
} as const;

async function loadContract(ac: keyof typeof EXPECTED_FAILURES): Promise<ContractModule> {
  try {
    return await import('./TerminalResourcePolicy.js');
  } catch (cause) {
    const expectedUrl = new URL('./TerminalResourcePolicy.js', import.meta.url).href;
    const isExpectedMissingContract = typeof cause === 'object'
      && cause !== null
      && 'code' in cause
      && cause.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in cause
      && cause.url === expectedUrl;
    if (isExpectedMissingContract) {
      throw new Error(EXPECTED_FAILURES[ac], { cause });
    }
    throw cause;
  }
}

async function loadInventoryContract(): Promise<InventoryContractModule> {
  return import('./TerminalResourcePolicyInventory.js');
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertSortedUnique(values: string[]): void {
  assert.deepEqual(values, [...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

// AC-1 requires the manifest to name each key's REAL consumer path, and existsSync cannot tell the
// difference between "the consuming expression lives here" and "it used to". That gap is not
// hypothetical: REL-BGSTAB-009 moved the grace lane from WebSocketProvider#bufferGraceMessage into
// terminalGraceBuffer#applyGraceBufferedMessage, and AC-1 stayed green over four entries pointing
// at a file whose named symbol no longer consumes anything, because the file still existed. The
// evidence signature is the consuming expression itself, so its absence at the named path is the
// cheapest condition the mere presence of the file cannot satisfy.
//
// What this does NOT establish, deliberately: a textual hit does not prove the expression is owned
// by the named symbol, is reachable, or is anything but a comment or an import. AC-6's AST scan is
// what carries ownership and liveness. This is a second, independent condition on the same claim,
// not a substitute for that one.
function assertEvidenceSignaturePresentAt(path: string, evidenceSignature: string, consumerSymbol: string): true {
  assert.ok(evidenceSignature.length > 0, `expected a non-empty evidence signature for ${path}#${consumerSymbol}`);
  const source = readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
  assert.ok(
    source.includes(evidenceSignature),
    `manifest names ${path}#${consumerSymbol} as the consumer, but its evidence signature ${JSON.stringify(evidenceSignature)} does not occur in that file`,
  );
  // Returned so the caller's tally counts helper COMPLETIONS. Incrementing in the caller's loop
  // body instead makes the count a tautology over the array it is compared against: gutting this
  // function's body would leave the tally at manifest.consumers.length and AC-1 green.
  return true;
}

function assertRepositoryPath(path: string): void {
  assert.equal(isAbsolute(path), false);
  assert.doesNotMatch(path, /\\/);
  const absolute = resolve(REPOSITORY_ROOT, path);
  const fromRoot = relative(REPOSITORY_ROOT, absolute);
  assert.equal(fromRoot.startsWith('..'), false);
  assert.equal(existsSync(absolute), true, `expected repository path to exist: ${path}`);
}

function createConfigFixture(scrollbackLines = 10_000): Config {
  return {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      scrollbackLines: 1_000,
      maxSnapshotBytes: 65_536,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    resourceLimits: resourceLimitsSchema.parse({ terminal: { scrollbackLines } }),
    stabilityModes: {
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'bounded',
    },
  };
}

function createCompileInput(
  canonicalScrollbackLines: unknown,
  legacyPtyScrollbackLines: unknown = 1_000,
): {
  rawConfig: { resourceLimits?: { terminal?: { scrollbackLines?: unknown } }; pty?: { scrollbackLines?: unknown } };
  effectiveResourceLimits: ResourceLimitsConfig;
  schemaVersion: string;
  profileVersion: string;
} {
  const rawConfig = {
    resourceLimits: canonicalScrollbackLines === undefined
      ? undefined
      : { terminal: { scrollbackLines: canonicalScrollbackLines } },
    pty: { scrollbackLines: legacyPtyScrollbackLines },
  };
  const effectiveScrollback = typeof canonicalScrollbackLines === 'number'
    && Number.isInteger(canonicalScrollbackLines)
    && canonicalScrollbackLines >= 0
    && canonicalScrollbackLines <= 50_000
      ? canonicalScrollbackLines
      : 10_000;

  return {
    rawConfig,
    effectiveResourceLimits: resourceLimitsSchema.parse({
      terminal: { scrollbackLines: effectiveScrollback },
    }),
    schemaVersion: SCHEMA_VERSION,
    profileVersion: PROFILE_VERSION,
  };
}

function expectedLegacyConsumerDecisions(store: RuntimeConfigStore): Record<string, unknown> {
  const editable = store.getEditableValues();
  const publicConfig = store.getPublicRuntimeConfig('queue');

  return {
    admission: {
      headlessQueueMode: editable.stabilityModes.headlessQueueMode,
      wsSendMode: editable.stabilityModes.wsSendMode,
    },
    cap: {
      headlessPendingOutputMaxBytes: editable.resourceLimits.headless.pendingOutputMaxBytes,
      headlessPendingOutputMaxChunks: editable.resourceLimits.headless.pendingOutputMaxChunks,
      serverBufferedHighWaterBytes: editable.resourceLimits.ws.serverBufferedHighWaterBytes,
      serverBufferedHardLimitBytes: editable.resourceLimits.ws.serverBufferedHardLimitBytes,
      perClientOutputQueueMaxBytes: editable.resourceLimits.ws.perClientOutputQueueMaxBytes,
      visibleOutputQueueMaxBytes: publicConfig.resourceLimits.terminal.visibleOutputQueueMaxBytes,
      visibleOutputMaxChunks: publicConfig.resourceLimits.terminal.visibleOutputMaxChunks,
    },
    expiry: {
      inputQueueTtlMs: publicConfig.resourceLimits.terminal.inputQueueTtlMs,
      transportOutboxTtlMs: publicConfig.resourceLimits.terminal.transportOutboxTtlMs,
      tombstoneTtlMs: publicConfig.resourceLimits.snapshots.tombstoneTtlMs,
      hiddenRuntimeTtlMs: publicConfig.resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs,
    },
    drop: {
      hiddenOutputPolicy: publicConfig.resourceLimits.terminal.hiddenOutputPolicy,
      hiddenOutputTailBytes: publicConfig.resourceLimits.terminal.hiddenOutputTailBytes,
    },
    reconnect: {
      inputBackpressureBytes: publicConfig.resourceLimits.clientWs.inputBackpressureBytes,
      hardReconnectBytes: publicConfig.resourceLimits.clientWs.hardReconnectBytes,
    },
    recovery: {
      perSnapshotMaxChars: publicConfig.resourceLimits.snapshots.perSnapshotMaxChars,
      totalStorageBudgetChars: publicConfig.resourceLimits.snapshots.totalStorageBudgetChars,
      maxEntries: publicConfig.resourceLimits.snapshots.maxEntries,
      scrollbackLines: publicConfig.resourceLimits.terminal.scrollbackLines,
    },
    bytes: {
      visibleFlushBudgetBytes: publicConfig.resourceLimits.terminal.visibleFlushBudgetBytes,
      inputQueueMaxBytes: publicConfig.resourceLimits.terminal.inputQueueMaxBytes,
      transportOutboxMaxBytes: publicConfig.resourceLimits.terminal.transportOutboxMaxBytes,
    },
    order: 'legacy-fifo',
    generation: 'runtime-config-snapshot',
  };
}

function expectedAppliedPolicyIds(legacyPolicyId: string): Record<string, string> {
  return Object.fromEntries(EXPECTED_POLICY_CONSUMER_IDS.map((consumerId) => [consumerId, legacyPolicyId]));
}

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-1', async () => {
  const { loadTerminalResourceConsumerManifest } = await loadInventoryContract();
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const categories = new Set(manifest.consumers.map((entry) => entry.category));
  let signaturesChecked = 0;

  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.profileVersion, PROFILE_VERSION);
  assert.deepEqual([...EXPECTED_CATEGORIES].filter((category) => !categories.has(category)), []);
  assert.ok(manifest.consumers.length >= EXPECTED_CATEGORIES.length);
  for (const entry of manifest.consumers) {
    assert.match(entry.resourceKey, /^resourceLimits\.|^pty\./);
    assert.ok(entry.unit.length > 0);
    assert.ok(entry.source.length > 0);
    assert.ok(entry.schemaVersion.length > 0);
    assert.ok(entry.profileVersion.length > 0);
    assert.ok(Array.isArray(entry.legacyAliases));
    assert.ok(entry.applyBoundary.length > 0);
    assertRepositoryPath(entry.consumerPath);
    signaturesChecked += assertEvidenceSignaturePresentAt(
      entry.consumerPath,
      entry.evidenceSignature,
      entry.consumerSymbol,
    ) ? 1 : 0;
  }
  // Exact, and local to this test rather than module scope. `> 0` on a module-global counter was
  // both already implied by the length assertion above and survivable by a future change that
  // checked one entry of eighty-one; it would also have carried across a re-entry of this file in
  // one process. This says every entry was examined, which is the claim AC-1 rests on.
  assert.equal(
    signaturesChecked,
    manifest.consumers.length,
    'AC-1 must check the evidence signature of every manifest entry',
  );
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-2', async () => {
  const { compileTerminalResourcePolicy } = await loadContract('AC-2');
  const baselineStore = new RuntimeConfigStore(createConfigFixture(12_345), 'linux');
  const observeStore = new RuntimeConfigStore(createConfigFixture(12_345), 'linux');
  const baselinePublic = baselineStore.getPublicRuntimeConfig('queue');
  const observation = observeStore.getTerminalResourcePolicyObservation();
  const compiledFirst = compileTerminalResourcePolicy(createCompileInput(12_345));
  const compiledSecond = compileTerminalResourcePolicy(structuredClone(createCompileInput(12_345)));

  assert.deepEqual(compiledFirst, compiledSecond);
  assert.equal(compiledFirst.mode, 'observe');
  assert.equal(compiledFirst.appliedPolicyId, compiledFirst.legacyPolicy.policyId);
  assert.equal(Object.keys(compiledFirst.legacyPolicy.resources).length, 30);
  assert.equal(observation.decisionEvidence.runtimeApplicationClaimed, false);
  assert.equal(observation.decisionStackHash, stableHash(observation.decisionStack));
  assert.equal(observation.decisionStack.scrollback.serverHeadless.source, 'resourceLimits.terminal.scrollbackLines');
  assert.equal(
    observation.decisionStack.scrollback.browserXterm.value,
    observation.decisionStack.scrollback.serverHeadless.value,
    'both consumers must apply one decision',
  );
  assert.deepEqual(observeStore.getPublicRuntimeConfig('queue'), baselinePublic);
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-3', async () => {
  const { TerminalResourcePolicyInputError, compileTerminalResourcePolicy } = await loadContract('AC-3');
  for (const valid of [0, 1, 49_999, 50_000]) {
    const result = compileTerminalResourcePolicy(createCompileInput(valid));
    assert.equal(result.legacyPolicy.terminal.scrollbackLines.value, valid);
    assert.equal(result.legacyPolicy.terminal.scrollbackLines.source, 'resourceLimits.terminal.scrollbackLines');
  }

  for (const invalid of [-1, 50_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => compileTerminalResourcePolicy(createCompileInput(invalid)),
      (error: unknown) => error instanceof TerminalResourcePolicyInputError
        && error.resource === 'terminal.scrollbackLines'
        && error.reason === 'invalid-source-value',
    );
  }

  for (const validLegacy of [0, 1, 49_999, 50_000]) {
    const fallback = compileTerminalResourcePolicy(createCompileInput(undefined, validLegacy));
    assert.equal(fallback.legacyPolicy.terminal.scrollbackLines.value, validLegacy);
    assert.equal(fallback.legacyPolicy.terminal.scrollbackLines.source, 'pty.scrollbackLines');
  }
  for (const invalidLegacy of [-1, 50_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => compileTerminalResourcePolicy(createCompileInput(undefined, invalidLegacy)),
      (error: unknown) => error instanceof TerminalResourcePolicyInputError
        && error.resource === 'terminal.scrollbackLines'
        && error.reason === 'invalid-source-value',
    );
  }

  const conflict = compileTerminalResourcePolicy(createCompileInput(9_999, 1_000));
  assert.equal(conflict.legacyPolicy.terminal.scrollbackLines.value, 9_999);
  assert.deepEqual(conflict.diagnostics, [{
    code: 'source-conflict',
    resource: 'terminal.scrollbackLines',
    canonicalSource: 'resourceLimits.terminal.scrollbackLines',
    legacySource: 'pty.scrollbackLines',
  }]);
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-4', async () => {
  const { compileTerminalResourcePolicy, getRegisteredTerminalResourcePolicyProfiles } = await loadContract('AC-4');
  const registry = getRegisteredTerminalResourcePolicyProfiles();
  assert.deepEqual(registry, []);

  const selections = [KNOWN_STABLE_PROFILE, KNOWN_NON_STABLE_PROFILE, {
    policyId: 'self-declared-stable',
    profileVersion: 'v1',
  }];

  for (const selection of selections) {
    const result = compileTerminalResourcePolicy({
      ...createCompileInput(10_000),
      candidateSelection: selection,
    } as never);
    assert.equal(result.candidate.status, 'unavailable');
    assert.equal(result.candidate.reason, 'candidate-policy-not-registered');
    assert.equal(result.appliedPolicyId, result.legacyPolicy.policyId);
    assert.equal(result.comparison, undefined);
  }
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-5', async () => {
  const { compileTerminalResourcePolicy, createTerminalResourcePolicyObserver } = await loadContract('AC-5');
    const observer = createTerminalResourcePolicyObserver({ capacity: 2 });
    const compiled = compileTerminalResourcePolicy(createCompileInput(10_000));

    observer.record({ consumer: 'browser.terminal.write-scheduler', resource: 'resourceLimits.terminal.visibleFlushBudgetBytes', compiled, differenceReason: 'legacy-only' });
    observer.record({ consumer: 'server.pty.headless-model', resource: 'resourceLimits.terminal.scrollbackLines', compiled, differenceReason: 'runtime-divergence' });
    observer.record({ consumer: 'browser.snapshot.persisted-storage', resource: 'resourceLimits.snapshots.perSnapshotMaxChars', compiled, differenceReason: 'legacy-only' });

    const snapshot = observer.snapshot();
    assert.equal(snapshot.length, 2);
    assert.deepEqual(snapshot.map((entry) => entry.consumer), ['server.pty.headless-model', 'browser.snapshot.persisted-storage']);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET TERMINAL OUTPUT|token-value/);
    assert.deepEqual(Object.keys(snapshot[0]).sort(), [
      'candidateDecision',
      'consumer',
      'differenceReason',
      'legacyDecision',
      'profileVersion',
      'resource',
      'schemaVersion',
      'source',
      'unit',
    ]);
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-6', async () => {
  const {
    discoverTerminalResourceInventory,
    loadTerminalResourceConsumerManifest,
    validateTerminalResourceConsumerManifest,
  } = await loadInventoryContract();
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const firstInventory = await discoverTerminalResourceInventory({ repositoryRoot: REPOSITORY_ROOT });
  const secondInventory = await discoverTerminalResourceInventory({ repositoryRoot: REPOSITORY_ROOT });
  const runtimePolicySource = await readFile(
    join(REPOSITORY_ROOT, 'server/src/services/TerminalResourcePolicy.ts'),
    'utf8',
  );
  const runtimeStoreSource = await readFile(
    join(REPOSITORY_ROOT, 'server/src/services/RuntimeConfigStore.ts'),
    'utf8',
  );

  assert.deepEqual(secondInventory, firstInventory);
  assert.equal(stableHash(secondInventory), stableHash(firstInventory));
  assertSortedUnique(firstInventory.resourceKeys);
  assertSortedUnique(firstInventory.consumerPaths);
  assertSortedUnique(firstInventory.gettersOrCallSites.map((entry) => `${entry.path}#${entry.symbol}`));
  for (const path of firstInventory.consumerPaths) assertRepositoryPath(path);
  for (const entry of firstInventory.gettersOrCallSites) assertRepositoryPath(entry.path);
  assert.deepEqual(firstInventory.resourceKeys, [...EXPECTED_RESOURCE_KEYS]);
  assert.equal(firstInventory.tuples.length, manifest.consumers.length);
  assert.deepEqual(firstInventory.unregisteredCallSites, []);
  assert.ok(firstInventory.evidenceSourcePaths.includes('server/src/services/TerminalResourcePolicy.test.ts'));
  assert.ok(firstInventory.evidenceSourcePaths.includes('server/src/services/RuntimeConfigStore.test.ts'));
  assert.doesNotMatch(runtimePolicySource, /CONSUMER_CATALOG|discoverTerminalResourceInventory|import\('typescript'\)/);
  assert.doesNotMatch(runtimeStoreSource, /TerminalResourcePolicyInventory/);

  const compactDecisions = (await loadContract('AC-6'))
    .getRegisteredTerminalResourcePolicyObservationDecisions();
  const catalogDecisions = new Map<string, typeof compactDecisions[number]>();
  for (const entry of firstInventory.tuples) {
    const key = `${entry.consumerId}|${entry.resourceKey}`;
    const current = catalogDecisions.get(key);
    catalogDecisions.set(key, {
      consumer: entry.consumerId,
      resource: entry.resourceKey,
      source: current?.source ?? entry.source,
      state: current?.state === 'divergent-legacy' || entry.state === 'divergent-legacy'
        ? 'divergent-legacy'
        : current?.state === 'reserved-unapplied' || entry.state === 'reserved-unapplied'
          ? 'reserved-unapplied'
          : 'consumed',
    });
  }
  assert.deepEqual(
    compactDecisions,
    [...catalogDecisions.values()].sort((left, right) => (
      `${left.consumer}|${left.resource}`.localeCompare(`${right.consumer}|${right.resource}`)
    )),
  );

  assert.equal(validateTerminalResourceConsumerManifest(manifest, firstInventory).ok, true);
  const removed = structuredClone(manifest);
  removed.consumers.splice(0, 1);
  assert.ok(validateTerminalResourceConsumerManifest(removed, firstInventory).errors
    .some((error) => error.code === 'missing-tuple'));

  const mutated = structuredClone(manifest);
  mutated.consumers[0].unit = `${mutated.consumers[0].unit}-wrong`;
  mutated.consumers.push({
    ...structuredClone(mutated.consumers[0]),
    consumerPath: 'frontend/src/utils/nonexistent-terminal-consumer.ts',
  });
  mutated.consumers.push(structuredClone(mutated.consumers[1]));
  const errorCodes = new Set(validateTerminalResourceConsumerManifest(mutated, firstInventory)
    .errors.map((error) => error.code));
  assert.equal(errorCodes.has('unit-mismatch'), true);
  assert.equal(errorCodes.has('orphan-tuple'), true);
  assert.equal(errorCodes.has('duplicate-source'), true);

  const emptyRoot = await mkdtemp(join(tmpdir(), 'buildergate-empty-policy-inventory-'));
  const partialRoot = await mkdtemp(join(tmpdir(), 'buildergate-partial-policy-inventory-'));
  try {
    await assert.rejects(
      discoverTerminalResourceInventory({ repositoryRoot: emptyRoot }),
      /required terminal resource source/i,
    );
    const partialConfigPath = join(partialRoot, 'server/src/types/config.types.ts');
    await mkdir(dirname(partialConfigPath), { recursive: true });
    await writeFile(partialConfigPath, 'export interface ResourceLimitsConfig {}\n', 'utf8');
    await assert.rejects(
      discoverTerminalResourceInventory({ repositoryRoot: partialRoot }),
      /required terminal resource source/i,
    );
  } finally {
    await Promise.all([
      rm(emptyRoot, { recursive: true, force: true }),
      rm(partialRoot, { recursive: true, force: true }),
    ]);
  }
});

test('Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-7', async () => {
  await loadContract('AC-7');
  const baselineStore = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const observeStore = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const beforeSnapshotBytes = JSON.stringify(baselineStore.getSnapshot());
  const beforeEditableBytes = JSON.stringify(baselineStore.getEditableValues());
  const beforePublicBytes = JSON.stringify(baselineStore.getPublicRuntimeConfig('strict'));
  const beforeStorageShapeBytes = JSON.stringify({ values: baselineStore.getSnapshot().values });
  const defaultResourceBytes = JSON.stringify(resourceLimitsSchema.parse(undefined));
  const observation = observeStore.getTerminalResourcePolicyObservation();

  assert.equal(JSON.stringify(observeStore.getSnapshot()), beforeSnapshotBytes);
  assert.equal(JSON.stringify(observeStore.getEditableValues()), beforeEditableBytes);
  assert.equal(JSON.stringify(observeStore.getPublicRuntimeConfig('strict')), beforePublicBytes);
  assert.equal(JSON.stringify({ values: observeStore.getSnapshot().values }), beforeStorageShapeBytes);
  assert.equal(JSON.stringify(resourceLimitsSchema.parse(undefined)), defaultResourceBytes);
  assert.equal('terminalResourcePolicy' in observeStore.getPublicRuntimeConfig('strict'), false);
  assert.equal(observation.decisionEvidence.runtimeApplicationClaimed, false);
  assert.equal(observation.decisionStackHash, stableHash(observation.decisionStack));
  assert.equal(observation.appliedPolicyId, observation.legacyPolicy.policyId);
});

function renderLoaderFixture(options: {
  canonical?: unknown;
  includeCanonical?: boolean;
  legacy?: unknown;
  includeLegacy?: boolean;
}): string {
  const terminal = options.includeCanonical
    ? `resourceLimits: { terminal: { scrollbackLines: ${JSON.stringify(options.canonical)} } },`
    : '';
  const pty = options.includeLegacy
    ? `pty: { scrollbackLines: ${JSON.stringify(options.legacy)} },`
    : '';
  return `{ server: { port: 4242 }, session: { idleDelayMs: 200 }, ${pty} ${terminal} }\n`;
}

async function loadPolicyThroughBothProductionLoaders(
  raw: string,
): Promise<Array<{ loader: string; observation: ReturnType<RuntimeConfigStore['getTerminalResourcePolicyObservation']> }>> {
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-policy-provenance-'));
  const strictPath = join(directory, 'strict.json5');
  const fallbackPath = join(directory, 'fallback.json5');
  try {
    await Promise.all([
      writeFile(strictPath, raw, 'utf8'),
      writeFile(fallbackPath, raw, 'utf8'),
    ]);
    return [
      {
        loader: 'loadConfigFromPathStrict',
        observation: new RuntimeConfigStore(loadConfigFromPathStrict(strictPath, 'linux'), 'linux')
          .getTerminalResourcePolicyObservation(),
      },
      {
        loader: 'loadConfigFromPath',
        observation: new RuntimeConfigStore(loadConfigFromPath(fallbackPath, 'linux'), 'linux')
          .getTerminalResourcePolicyObservation(),
      },
    ];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('OBS-BGSTAB-005 review regression — raw provenance survives production loaders and replacements', async () => {
  const scrollbackKey = 'resourceLimits.terminal.scrollbackLines';
  const cases = [
    {
      name: 'legacy-only',
      raw: renderLoaderFixture({ includeLegacy: true, legacy: 2_345 }),
      value: 2_345,
      source: 'pty.scrollbackLines',
      sourceKind: 'legacy-explicit',
      conflicts: 0,
    },
    {
      name: 'canonical-only-zero',
      raw: renderLoaderFixture({ includeCanonical: true, canonical: 0 }),
      value: 0,
      source: scrollbackKey,
      sourceKind: 'canonical-explicit',
      conflicts: 0,
    },
    {
      name: 'both-absent',
      raw: renderLoaderFixture({}),
      value: 10_000,
      source: scrollbackKey,
      sourceKind: 'schema-default',
      conflicts: 0,
    },
    {
      name: 'both-equal',
      raw: renderLoaderFixture({ includeCanonical: true, canonical: 4_000, includeLegacy: true, legacy: 4_000 }),
      value: 4_000,
      source: scrollbackKey,
      sourceKind: 'canonical-explicit',
      conflicts: 0,
    },
    {
      name: 'conflict',
      raw: renderLoaderFixture({ includeCanonical: true, canonical: 5_000, includeLegacy: true, legacy: 4_000 }),
      value: 5_000,
      source: scrollbackKey,
      sourceKind: 'canonical-explicit',
      conflicts: 1,
    },
  ] as const;

  for (const fixture of cases) {
    const loaded = await loadPolicyThroughBothProductionLoaders(fixture.raw);
    for (const result of loaded) {
      const value = result.observation.legacyPolicy.resources[scrollbackKey];
      assert.equal(value.value, fixture.value, `${fixture.name}/${result.loader}`);
      assert.equal(value.source, fixture.source, `${fixture.name}/${result.loader}`);
      assert.equal(value.sourceKind, fixture.sourceKind, `${fixture.name}/${result.loader}`);
      assert.equal(result.observation.diagnostics.length, fixture.conflicts, `${fixture.name}/${result.loader}`);
      assert.doesNotMatch(JSON.stringify(result.observation.provenance), /password|secret|token/i);
    }
  }

  const store = new RuntimeConfigStore(createConfigFixture(9_000), 'linux');
  const replacement = store.getEditableValues();
  replacement.resourceLimits.terminal.scrollbackLines = 7_777;
  store.replaceValues(replacement);
  const replaced = store.getTerminalResourcePolicyObservation();
  assert.equal(replaced.legacyPolicy.resources[scrollbackKey].value, 7_777);
  assert.equal(replaced.legacyPolicy.resources[scrollbackKey].sourceKind, 'runtime-replacement');

  const reloaded = (await loadPolicyThroughBothProductionLoaders(
    renderLoaderFixture({ includeLegacy: true, legacy: 6_666 }),
  ))[0].observation;
  assert.equal(reloaded.legacyPolicy.resources[scrollbackKey].value, 6_666);
});

test('OBS-BGSTAB-005 second review regression — explicit non-scrollback keys retain truthful loader provenance', async () => {
  const raw = [
    '{',
    '  server: { port: 4242 },',
    '  session: { idleDelayMs: 200 },',
    '  resourceLimits: {',
    '    ws: { serverBufferedHighWaterBytes: 12345 },',
    '  },',
    '}',
    '',
  ].join('\n');
  const loaded = await loadPolicyThroughBothProductionLoaders(raw);
  for (const result of loaded) {
    assert.equal(
      result.observation.legacyPolicy.resources['resourceLimits.ws.serverBufferedHighWaterBytes'].sourceKind,
      'canonical-explicit',
      result.loader,
    );
    assert.equal(
      result.observation.legacyPolicy.resources['resourceLimits.ws.serverBufferedHardLimitBytes'].sourceKind,
      'schema-default',
      result.loader,
    );
    assert.equal(
      result.observation.provenance.canonicalResources?.['resourceLimits.ws.serverBufferedHighWaterBytes']?.presence,
      'present-valid',
      result.loader,
    );
  }
});

test('OBS-BGSTAB-005 review regression — ConfigFileRepository previous/next provenance survives settings reload and rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buildergate-policy-settings-provenance-'));
  const configPath = join(directory, 'config.json5');
  try {
    await writeFile(
      configPath,
      [
        '{',
        '  server: { port: 4242 },',
        '  session: {',
        '    idleDelayMs: 200,',
        '  },',
        '  pty: {',
        '    scrollbackLines: 4321,',
        '  },',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const initial = loadConfigFromPathStrict(configPath, 'linux');
    const values = new RuntimeConfigStore(initial, 'linux').getEditableValues();
    values.session.idleDelayMs += 1;
    const repository = new ConfigFileRepository(configPath, 'linux');
    const persisted = repository.persistEditableValues(values, {}, {
      dryRun: true,
      changedKeys: ['session.idleDelayMs'],
    });
    const store = new RuntimeConfigStore(persisted.previousConfig, 'linux');
    assert.equal(
      store.getTerminalResourcePolicyObservation().legacyPolicy.resources['resourceLimits.terminal.scrollbackLines'].value,
      4_321,
    );
    store.replaceFromConfig(persisted.nextConfig);
    assert.equal(
      store.getTerminalResourcePolicyObservation().legacyPolicy.resources['resourceLimits.terminal.scrollbackLines'].value,
      4_321,
    );
    store.replaceFromConfig(persisted.previousConfig);
    assert.equal(
      store.getTerminalResourcePolicyObservation().legacyPolicy.resources['resourceLimits.terminal.scrollbackLines'].sourceKind,
      'legacy-explicit',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OBS-BGSTAB-005 review regression — invalid raw provenance is sanitized and never silently falls through', async () => {
  const { captureTerminalResourceConfigProvenance, compileTerminalResourcePolicy } = await loadContract('AC-3');
  for (const invalid of [-1, 50_001, 1.5, null, 'SECRET-VALUE', { secret: 'SECRET-OBJECT' }]) {
    const rawConfig = { resourceLimits: { terminal: { scrollbackLines: invalid } }, pty: { scrollbackLines: 1_234 } };
    const provenance = captureTerminalResourceConfigProvenance(rawConfig);
    assert.doesNotMatch(JSON.stringify(provenance), /SECRET-VALUE|SECRET-OBJECT/);
    assert.throws(
      () => compileTerminalResourcePolicy({
        provenance,
        effectiveResourceLimits: resourceLimitsSchema.parse(undefined),
        schemaVersion: SCHEMA_VERSION,
        profileVersion: PROFILE_VERSION,
      }),
      (error: unknown) => error instanceof Error && error.name === 'TerminalResourcePolicyInputError',
    );
  }

  const directory = await mkdtemp(join(tmpdir(), 'buildergate-policy-fallback-'));
  const configPath = join(directory, 'config.json5');
  try {
    await writeFile(configPath, renderLoaderFixture({ includeCanonical: true, canonical: 'SECRET-VALUE' }), 'utf8');
    assert.throws(
      () => loadConfigFromPath(configPath, 'linux'),
      (error: unknown) => error instanceof Error
        && /configuration validation failed/i.test(error.message)
        && !error.message.includes('SECRET-VALUE'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OBS-BGSTAB-005 review regression — compiler owns all 30 typed resources and records real legacy divergence', async () => {
  const { TERMINAL_RESOURCE_KEYS, compileTerminalResourcePolicy } = await loadContract('AC-2');
  assert.deepEqual([...TERMINAL_RESOURCE_KEYS].sort(), [...EXPECTED_RESOURCE_KEYS]);
  const compiled = compileTerminalResourcePolicy({
    provenance: {
      origin: 'test-explicit',
      canonicalScrollback: { presence: 'present-valid', value: 12_345 },
      legacyScrollback: { presence: 'present-valid', value: 2_345 },
    },
    effectiveResourceLimits: resourceLimitsSchema.parse({ terminal: { scrollbackLines: 12_345 } }),
    schemaVersion: SCHEMA_VERSION,
    profileVersion: PROFILE_VERSION,
    candidateSelection: { policyId: 'known-looking-stable', profileVersion: '1.0.0' },
  });
  assert.deepEqual(Object.keys(compiled.legacyPolicy.resources).sort(), [...EXPECTED_RESOURCE_KEYS]);
  for (const key of EXPECTED_RESOURCE_KEYS) {
    assert.equal(compiled.legacyPolicy.resources[key].source, key);
    assert.ok(compiled.legacyPolicy.resources[key].unit.length > 0);
    assert.ok(compiled.legacyPolicy.resources[key].applyBoundary.length > 0);
  }
  assert.equal(compiled.legacyPolicy.resources['resourceLimits.snapshots.perSnapshotMaxChars'].unit, 'chars');
  assert.equal(compiled.legacyPolicy.resources['resourceLimits.snapshots.totalStorageBudgetChars'].unit, 'chars');
  assert.equal(compiled.candidate.status, 'unavailable');
  assert.equal(compiled.comparison, undefined);

  const store = new RuntimeConfigStore(createConfigFixture(12_345), 'linux', {
    terminalResourcePolicy: {
      observation: 'observe',
      candidateSelection: { policyId: 'known-looking-stable', profileVersion: '1.0.0' },
    },
  });
  const observation = store.getTerminalResourcePolicyObservation();
  assert.equal(observation.candidate.reason, 'candidate-policy-not-registered');
  assert.equal(observation.decisionEvidence.runtimeApplicationClaimed, false);
  assert.equal(observation.decisionStack.scrollback.serverHeadless.source, 'resourceLimits.terminal.scrollbackLines');
  assert.equal(observation.decisionStack.scrollback.browserXterm.source, 'resourceLimits.terminal.scrollbackLines');
  assert.equal(
    observation.decisionStack.scrollback.browserXterm.value,
    observation.decisionStack.scrollback.canonical.value,
  );
  assert.equal(observation.decisionStack.scrollback.canonical.appliedByKnownRuntimeConsumer, true);
  assert.deepEqual(observation.decisionStack.reservedUnapplied, [
    'resourceLimits.headless.writeBatchMaxBytes',
    'resourceLimits.headless.writeLagWarnMs',
  ]);
});

test('OBS-BGSTAB-005 review regression — no candidate profile is available without a registered stable contract', async () => {
  const { compileTerminalResourcePolicy, getRegisteredTerminalResourcePolicyProfiles } = await loadContract('AC-4');
  assert.deepEqual(getRegisteredTerminalResourcePolicyProfiles(), []);
  for (const candidateSelection of [
    { policyId: 'rel-bgstab-007-legacy-equivalent', profileVersion: '1.0.0' },
    { policyId: 'self-declared-stable', profileVersion: 'stable' },
    { policyId: 'wave3-experimental', profileVersion: '0.1.0' },
  ]) {
    const compiled = compileTerminalResourcePolicy({
      provenance: {
        origin: 'test-explicit',
        canonicalScrollback: { presence: 'present-valid', value: 10_000 },
        legacyScrollback: { presence: 'absent' },
      },
      effectiveResourceLimits: resourceLimitsSchema.parse(undefined),
      schemaVersion: SCHEMA_VERSION,
      profileVersion: PROFILE_VERSION,
      candidateSelection,
    });
    assert.equal(compiled.candidate.status, 'unavailable');
    assert.equal(compiled.candidate.reason, 'candidate-policy-not-registered');
    assert.equal(compiled.appliedPolicyId, compiled.legacyPolicy.policyId);
    assert.equal(compiled.comparison, undefined);
  }
});

test('OBS-BGSTAB-005 review regression — telemetry is allowlisted, payload-free, bounded, and read-only on snapshot', async () => {
  const { compileTerminalResourcePolicy, createTerminalResourcePolicyObserver } = await loadContract('AC-5');
  const compiled = compileTerminalResourcePolicy({
    provenance: {
      origin: 'test-explicit',
      canonicalScrollback: { presence: 'present-valid', value: 10_000 },
      legacyScrollback: { presence: 'absent' },
    },
    effectiveResourceLimits: resourceLimitsSchema.parse(undefined),
    schemaVersion: SCHEMA_VERSION,
    profileVersion: PROFILE_VERSION,
  });
  const observer = createTerminalResourcePolicyObserver({ capacity: 2 });
  assert.deepEqual(observer.snapshot(), []);
  assert.deepEqual(observer.snapshot(), []);

  for (const unsafe of [
    { consumer: 'server.config.runtime-store\nSECRET', resource: EXPECTED_RESOURCE_KEYS[0], differenceReason: 'legacy-only' },
    { consumer: 'server.config.runtime-store', resource: `${EXPECTED_RESOURCE_KEYS[0]}\nSECRET`, differenceReason: 'legacy-only' },
    { consumer: 'server.config.runtime-store', resource: EXPECTED_RESOURCE_KEYS[0], differenceReason: 'legacy-only\nSECRET' },
  ]) {
    assert.throws(() => observer.record({ ...unsafe, compiled } as never), /allowlist/i);
  }
  assert.throws(() => observer.record({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.headless.writeBatchMaxBytes',
    compiled,
    differenceReason: 'reserved-unapplied',
    actualDecision: { legacyDecision: null, source: 'SECRET-source' },
  } as never), /allowlist/i);
  assert.throws(() => observer.record({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.headless.writeBatchMaxBytes',
    compiled,
    differenceReason: 'legacy-only',
    actualDecision: { legacyDecision: null, source: 'resourceLimits.headless.writeBatchMaxBytes' },
  }), /reserved-unapplied/i);
  assert.throws(() => observer.record({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.headless.writeBatchMaxBytes',
    compiled,
    differenceReason: 'reserved-unapplied',
    actualDecision: { legacyDecision: 1, source: 'resourceLimits.headless.writeBatchMaxBytes' },
  }), /reserved-unapplied/i);
  assert.throws(() => observer.record({
    consumer: 'browser.hidden-output',
    resource: 'resourceLimits.terminal.hiddenOutputPolicy',
    compiled,
    differenceReason: 'legacy-only',
    actualDecision: {
      legacyDecision: 'SECRET TERMINAL OUTPUT',
      source: 'resourceLimits.terminal.hiddenOutputPolicy',
    },
  }), /compiled resource decision/i);

  observer.record({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.terminal.scrollbackLines',
    compiled,
    differenceReason: 'legacy-only',
  });
  observer.record({
    consumer: 'server.pty.headless-model',
    resource: 'resourceLimits.headless.pendingOutputMaxBytes',
    compiled,
    differenceReason: 'legacy-only',
  });
  observer.record({
    consumer: 'browser.snapshot.persisted-storage',
    resource: 'resourceLimits.snapshots.perSnapshotMaxChars',
    compiled,
    differenceReason: 'legacy-only',
  });
  const first = observer.snapshot();
  const second = observer.snapshot();
  assert.deepEqual(second, first);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((entry) => entry.consumer), [
    'server.pty.headless-model',
    'browser.snapshot.persisted-storage',
  ]);
  assert.equal(first[0].legacyDecision, compiled.legacyPolicy.resources[first[0].resource].value);
  assert.equal(first[0].source, compiled.legacyPolicy.resources[first[0].resource].source);
  assert.equal(first[0].unit, compiled.legacyPolicy.resources[first[0].resource].unit);
  assert.equal(first[0].candidateDecision, null);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|password|token|rawTerminalPayload/i);
});

async function copyInventorySources(paths: readonly string[], targetRoot: string): Promise<void> {
  for (const path of paths) {
    const destination = join(targetRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(REPOSITORY_ROOT, path), destination);
  }
}

test('OBS-BGSTAB-005 review regression — exact repository tuples validate bidirectionally and detect new callsites', async () => {
  const {
    discoverTerminalResourceInventory,
    loadTerminalResourceConsumerManifest,
    validateTerminalResourceConsumerManifest,
  } = await loadInventoryContract();
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const inventory = await discoverTerminalResourceInventory({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(inventory.resourceKeys, [...EXPECTED_RESOURCE_KEYS]);
  assert.deepEqual(inventory.unregisteredCallSites, []);
  assert.deepEqual(
    [...new Set([...inventory.tuples.map((tuple) => tuple.consumerPath), ...inventory.classifications.map((item) => item.path)])]
      .filter((path) => EXPECTED_TRACE_PATHS.includes(path as never))
      .sort(),
    [...EXPECTED_TRACE_PATHS].sort(),
  );
  assert.equal(validateTerminalResourceConsumerManifest(manifest, inventory).ok, true);

  const mutations = [
    ['consumerId', 'server.ws.router'],
    ['category', 'fake-category'],
    ['resourceKey', 'resourceLimits.ws.serverBufferedHighWaterBytes'],
    ['source', 'resourceLimits.fake.source'],
    ['schemaVersion', 'terminal-resource-policy/fake'],
    ['profileVersion', 'fake-profile'],
    ['legacyAliases', ['fake.alias']],
    ['applyBoundary', 'fake-boundary'],
    ['unit', 'fake-unit'],
    ['consumerSymbol', 'fakeSymbol'],
    ['evidenceSignature', 'fake evidence signature'],
    ['evidenceRole', 'control-guard'],
    ['evidenceRole', undefined],
    ['evidenceAstSha256', '0'.repeat(64)],
    ['state', 'reserved-unapplied'],
  ] as const;
  for (const [field, value] of mutations) {
    const mutated = structuredClone(manifest);
    (mutated.consumers[0] as unknown as Record<string, unknown>)[field] = value;
    const result = validateTerminalResourceConsumerManifest(mutated, inventory);
    assert.equal(result.ok, false, `mutation should fail: ${field}`);
    assert.ok(result.errors.some((error) => error.code === 'missing-tuple' || error.code === 'orphan-tuple'));
  }
  const mutatedClassification = structuredClone(manifest);
  mutatedClassification.classifications[0].accessEvidenceSha256 = '0'.repeat(64);
  const classificationResult = validateTerminalResourceConsumerManifest(mutatedClassification, inventory);
  assert.equal(classificationResult.ok, false);
  assert.ok(classificationResult.errors.some((error) => (
    error.code === 'missing-classification' || error.code === 'orphan-classification'
  )));
  const mutatedEvidenceVersion = structuredClone(manifest);
  const fingerprint = mutatedEvidenceVersion.evidence?.consumerAstFingerprint as Record<string, unknown>;
  fingerprint.schemaVersion = 'terminal-resource-evidence-ast/fake';
  assert.ok(validateTerminalResourceConsumerManifest(mutatedEvidenceVersion, inventory).errors.some(
    (error) => error.code === 'evidence-version-mismatch',
  ));
  const mutatedSourceHash = structuredClone(manifest);
  const sourceHashes = mutatedSourceHash.evidence?.sourceHashes as Record<string, string>;
  sourceHashes['server/src/services/TerminalResourcePolicy.test.ts'] = '0'.repeat(64);
  const sourceHashResult = validateTerminalResourceConsumerManifest(mutatedSourceHash, inventory);
  assert.ok(sourceHashResult.errors.some((error) => error.code === 'source-hash-mismatch'));

  const targetRoot = await mkdtemp(join(tmpdir(), 'buildergate-policy-inventory-mutation-'));
  try {
    await copyInventorySources(
      inventory.evidenceSourcePaths,
      targetRoot,
    );
    const newPath = join(targetRoot, 'frontend/src/utils/newUnregisteredTerminalConsumer.ts');
    const aliasPath = join(targetRoot, 'frontend/src/utils/newAliasedTerminalConsumer.ts');
    const transitiveAliasPath = join(targetRoot, 'frontend/src/utils/newTransitiveAliasedTerminalConsumer.ts');
    const destructuredAliasPath = join(targetRoot, 'frontend/src/utils/newDestructuredTerminalConsumer.ts');
    const elementAliasPath = join(targetRoot, 'frontend/src/utils/newElementTerminalConsumer.ts');
    const nestedRootPath = join(targetRoot, 'frontend/src/utils/newNestedRootTerminalConsumer.ts');
    const nestedElementRootPath = join(targetRoot, 'frontend/src/utils/newNestedElementRootTerminalConsumer.ts');
    const shadowedAliasPath = join(targetRoot, 'frontend/src/utils/newShadowedTerminalAlias.ts');
    const importedGetterAliasPath = join(targetRoot, 'frontend/src/utils/newImportedGetterAliasConsumer.ts');
    const assignedGetterAliasPath = join(targetRoot, 'frontend/src/utils/newAssignedGetterAliasConsumer.ts');
    const shadowedGetterNamePath = join(targetRoot, 'frontend/src/utils/newShadowedGetterName.ts');
    await mkdir(dirname(newPath), { recursive: true });
    await writeFile(newPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'export const unsafeLimit = getTerminalResourceLimits().visibleOutputQueueMaxBytes;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(aliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const limits = getTerminalResourceLimits();',
      'export const unsafeAliasedLimit = limits.hiddenOutputTailBytes;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(transitiveAliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const first = getTerminalResourceLimits();',
      'const second = first;',
      'export const unsafeTransitiveAliasedLimit = second.hiddenOutputTailBytes;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(destructuredAliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const { hiddenOutputTailBytes: unsafeDestructuredLimit } = getTerminalResourceLimits();',
      'export { unsafeDestructuredLimit };',
      '',
    ].join('\n'), 'utf8');
    await writeFile(elementAliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const limits = getTerminalResourceLimits();',
      "export const unsafeElementLimit = limits['visibleOutputMaxChunks'];",
      '',
    ].join('\n'), 'utf8');
    await writeFile(nestedRootPath, [
      'export function consume(config: { resourceLimits: { terminal: { scrollbackLines: number } } }): number {',
      '  const terminalLimits = config.resourceLimits.terminal;',
      '  return terminalLimits.scrollbackLines;',
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(nestedElementRootPath, [
      'export function consumeElement(config: { resourceLimits: { terminal: { scrollbackLines: number } } }): number {',
      "  const root = config['resourceLimits'];",
      "  const terminalLimits = root['terminal'];",
      "  return terminalLimits['scrollbackLines'];",
      '}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(shadowedAliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const limits = getTerminalResourceLimits();',
      'function parameterShadow(limits: { hiddenOutputTailBytes: number }): number {',
      '  return limits.hiddenOutputTailBytes;',
      '}',
      'function localAndDestructuredShadow(input: { limits: { hiddenOutputTailBytes: number } }): number {',
      '  const limits = { hiddenOutputTailBytes: 1 };',
      '  {',
      '    const { limits } = input;',
      '    return limits.hiddenOutputTailBytes;',
      '  }',
      '}',
      'try { parameterShadow({ hiddenOutputTailBytes: 1 }); } catch (limits) {',
      '  void limits.hiddenOutputTailBytes;',
      '}',
      'export const safeShadowedTotal = parameterShadow({ hiddenOutputTailBytes: 1 }) + localAndDestructuredShadow({ limits: { hiddenOutputTailBytes: 1 } });',
      '',
    ].join('\n'), 'utf8');
    await writeFile(importedGetterAliasPath, [
      "import { getTerminalResourceLimits as loadLimits } from './inputReliabilityMode';",
      'export const unsafeImportedGetterAlias = loadLimits().hiddenOutputTailBytes;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(assignedGetterAliasPath, [
      "import { getTerminalResourceLimits } from './inputReliabilityMode';",
      'const loadLimits = getTerminalResourceLimits;',
      'export const unsafeAssignedGetterAlias = loadLimits().hiddenOutputTailBytes;',
      '',
    ].join('\n'), 'utf8');
    await writeFile(shadowedGetterNamePath, [
      'export function safeShadowedGetterName(',
      '  getTerminalResourceLimits: () => { hiddenOutputTailBytes: number },',
      '): number {',
      '  return getTerminalResourceLimits().hiddenOutputTailBytes;',
      '}',
      '',
    ].join('\n'), 'utf8');
    const mutatedInventory = await discoverTerminalResourceInventory({ repositoryRoot: targetRoot });
    assert.deepEqual(mutatedInventory.unregisteredCallSites.map((entry) => entry.path).sort(), [
      'frontend/src/utils/newAliasedTerminalConsumer.ts',
      'frontend/src/utils/newAssignedGetterAliasConsumer.ts',
      'frontend/src/utils/newDestructuredTerminalConsumer.ts',
      'frontend/src/utils/newElementTerminalConsumer.ts',
      'frontend/src/utils/newImportedGetterAliasConsumer.ts',
      'frontend/src/utils/newNestedElementRootTerminalConsumer.ts',
      'frontend/src/utils/newNestedRootTerminalConsumer.ts',
      'frontend/src/utils/newTransitiveAliasedTerminalConsumer.ts',
      'frontend/src/utils/newUnregisteredTerminalConsumer.ts',
    ]);
    const result = validateTerminalResourceConsumerManifest(manifest, mutatedInventory);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'unregistered-callsite'));
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }

  const knownPathRoot = await mkdtemp(join(tmpdir(), 'buildergate-policy-known-path-mutation-'));
  try {
    await copyInventorySources(
      inventory.evidenceSourcePaths,
      knownPathRoot,
    );
    const terminalViewPath = join(knownPathRoot, 'frontend/src/components/Terminal/TerminalView.tsx');
    const inputReliabilityPath = join(knownPathRoot, 'frontend/src/utils/inputReliabilityMode.ts');
    const wsRouterPath = join(knownPathRoot, 'server/src/ws/WsRouter.ts');
    const configRepositoryPath = join(knownPathRoot, 'server/src/services/ConfigFileRepository.ts');
    await writeFile(
      terminalViewPath,
      `${await readFile(terminalViewPath, 'utf8')}\nconst __knownBrowserLimits = getTerminalResourceLimits();\nconst __unregisteredKnownBrowserLimit = __knownBrowserLimits.hiddenOutputTailBytes;\n`,
      'utf8',
    );
    await writeFile(
      inputReliabilityPath,
      `${await readFile(inputReliabilityPath, 'utf8')}\nconst __hybridLimits = getTerminalResourceLimits();\nconst __unregisteredHybridLimit = __hybridLimits.hiddenOutputTailBytes;\n`,
      'utf8',
    );
    await writeFile(
      wsRouterPath,
      `${await readFile(wsRouterPath, 'utf8')}\nconst __unregisteredKnownServerLimit = resourceLimits.ws.serverBufferedHighWaterBytes;\nconst __nestedKnownWsLimits = ({ resourceLimits }).resourceLimits.ws;\nconst __unregisteredNestedKnownLimit = __nestedKnownWsLimits.serverBufferedHardLimitBytes;\n`,
      'utf8',
    );
    await writeFile(
      configRepositoryPath,
      `${await readFile(configRepositoryPath, 'utf8')}\nconst __newPersistenceConsumer = ({ resourceLimits }).resourceLimits.terminal.scrollbackLines;\n`,
      'utf8',
    );
    const mutatedInventory = await discoverTerminalResourceInventory({ repositoryRoot: knownPathRoot });
    assert.deepEqual(
      mutatedInventory.unregisteredCallSites.map((entry) => entry.path).sort(),
      [
        'frontend/src/components/Terminal/TerminalView.tsx',
        'frontend/src/utils/inputReliabilityMode.ts',
        'server/src/services/ConfigFileRepository.ts',
        'server/src/ws/WsRouter.ts',
      ],
    );
    assert.equal(validateTerminalResourceConsumerManifest(manifest, mutatedInventory).ok, false);
  } finally {
    await rm(knownPathRoot, { recursive: true, force: true });
  }
});

// Mutation fixtures locate their insertion point by a run of trimmed lines rather than by a
// verbatim substring. A verbatim marker carries the checkout's line endings and the source file's
// indentation, both of which drift without changing any behaviour this suite is about: the
// reserved-copy-option-decoy marker pinned a CRLF that server/src/services/SessionManager.ts no
// longer has, so the fixture could not pose its question at all and failed on its own setup. The
// count assertion below is what keeps that from degrading into a silent no-op instead.
function insertBeforeMarkerLines(source: string, marker: string, inserted: string, name: string): string {
  assert.ok(marker.trim().length > 0, `${name}: marker must not be blank`);
  // FND-009's other half: this function rejoins the WHOLE file, so a mixed-ending target would have
  // every line ending rewritten by a helper whose job is to insert a few lines - and the target's
  // own template literals carry whitespace as content. Refuse mixed endings rather than normalise
  // them silently. All current targets are pure LF.
  const crlfCount = (source.match(/\r\n/g) ?? []).length;
  const lfCount = (source.match(/\n/g) ?? []).length;
  assert.ok(
    crlfCount === 0 || crlfCount === lfCount,
    `${name}: refusing to rewrite a mixed-line-ending file (${crlfCount} CRLF of ${lfCount} LF)`,
  );
  const newline = crlfCount > 0 ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const markerLines = marker.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim());
  const hits: number[] = [];
  for (let index = 0; index + markerLines.length <= lines.length; index += 1) {
    if (markerLines.every((expected, offset) => lines[index + offset].trim() === expected)) hits.push(index);
  }
  assert.equal(
    hits.length,
    1,
    `${name}: expected exactly one occurrence of the ${markerLines.length}-line marker ${JSON.stringify(markerLines)}, found ${hits.length}`,
  );
  const target = lines[hits[0]];
  const indent = target.slice(0, target.length - target.trimStart().length);
  const insertedLines = inserted
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `${indent}${line.trim()}`);
  assert.ok(insertedLines.length > 0, `${name}: inserted text produced no lines`);
  // Each inserted line is re-indented to the marker's indent. For JavaScript that is
  // meaning-preserving - line breaks are kept, so ASI is unaffected, and only leading whitespace
  // changes - with one exception: whitespace inside a template literal is content. Refuse those
  // rather than rewrite them silently. Multi-line block inserts are fine and several fixtures use
  // them, so this deliberately does NOT require each line to be a complete statement; an earlier
  // draft did and false-reddened same-owner-dead-code-decoy, whose first line is `if (false) {`.
  for (const line of insertedLines) {
    assert.doesNotMatch(line, /`/, `${name}: inserted lines must not contain a template literal, because they are re-indented`);
  }
  lines.splice(hits[0], 0, ...insertedLines);
  return lines.join(newline);
}

test('OBS-BGSTAB-005 third review regression — catalog evidence must be executable and remain in the intended symbol scope', async () => {
  const {
    discoverTerminalResourceInventory,
    loadTerminalResourceConsumerManifest,
    validateTerminalResourceConsumerManifest,
  } = await loadInventoryContract();
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const inventory = await discoverTerminalResourceInventory({ repositoryRoot: REPOSITORY_ROOT });
  const requiredPaths = inventory.evidenceSourcePaths;
  const mutations = [
    {
      name: 'comment-only-enforcement',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '\n// queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes\n',
    },
    {
      name: 'moved-outside-symbol',
      path: 'frontend/src/utils/terminalHiddenOutput.ts',
      from: "hiddenOutputPolicy === 'write-hidden'",
      to: "hiddenOutputPolicy === 'snapshot-restore'",
      suffix: "\nconst __movedEvidence = hiddenOutputPolicy === 'write-hidden';\n",
    },
    {
      name: 'same-name-wrong-owner',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '\nfunction enqueue(config: TerminalOutputSchedulerConfig, queuedBytes: number, bytes: Uint8Array): boolean {\n  return queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes;\n}\n',
    },
    {
      name: 'nested-anonymous-wrong-owner',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: '(() => queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes)()',
      suffix: '',
    },
    {
      name: 'same-owner-dead-code-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      if (false) {\n        void (queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes);\n      }\n\n',
    },
    {
      name: 'same-owner-reachable-void-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      void (queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes);\n\n',
    },
    {
      name: 'same-owner-variable-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      const __reviewDecision = queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes;\n\n',
    },
    {
      name: 'unchanged-guard-after-constant-return',
      driftMechanism: 'seal-only' as const,
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      if (true) return;\n',
      manifestDrift: true,
    },
    {
      name: 'unchanged-guard-after-try-finally-return',
      driftMechanism: 'seal-only' as const,
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      try { return; } finally {}\n',
      manifestDrift: true,
    },
    {
      name: 'object-option-discarded-decoy',
      path: 'server/src/services/SessionManager.ts',
      from: 'maxBytes: limits.pendingOutputMaxBytes',
      to: 'maxBytes: Number.MAX_SAFE_INTEGER',
      suffix: '',
      insertBefore: '    return createHeadlessOutputQueue({',
      inserted: '    ({ maxBytes: limits.pendingOutputMaxBytes });\n',
    },
    {
      name: 'object-option-noop-callee-decoy',
      driftMechanism: 'tuple' as const,
      path: 'server/src/services/SessionManager.ts',
      from: 'maxBytes: limits.pendingOutputMaxBytes',
      to: 'maxBytes: Number.MAX_SAFE_INTEGER',
      suffix: '',
      insertBefore: '    return createHeadlessOutputQueue({',
      inserted: '    noopReview({ maxBytes: limits.pendingOutputMaxBytes });\n',
      manifestDrift: true,
    },
    {
      name: 'reserved-copy-option-decoy',
      path: 'server/src/services/SessionManager.ts',
      from: 'writeLagWarnMs: source.writeLagWarnMs',
      to: 'writeLagWarnMs: 0',
      suffix: '',
      insertBefore: '  return {\r\n    pendingOutputMaxBytes: source.pendingOutputMaxBytes,',
      inserted: '  consumeReview({ writeLagWarnMs: source.writeLagWarnMs });\n',
    },
    {
      name: 'call-input-array-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'config.visibleFlushBudgetBytes,',
      to: 'Number.MAX_SAFE_INTEGER,',
      suffix: '',
      insertBefore: '      let sliceEnd = findUtf8SliceEnd(',
      inserted: '      const __callInputDecoy = [config.visibleFlushBudgetBytes,];\n',
    },
    {
      name: 'call-input-noop-callee-decoy',
      driftMechanism: 'tuple' as const,
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'config.visibleFlushBudgetBytes,',
      to: 'Number.MAX_SAFE_INTEGER,',
      suffix: '',
      insertBefore: '      let sliceEnd = findUtf8SliceEnd(',
      inserted: '      const __reviewSliceEnd = noopReview(config.visibleFlushBudgetBytes,);\n      if (__reviewSliceEnd) return;\n',
      manifestDrift: true,
    },
    {
      name: 'derived-control-direct-guard-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          if (current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes) return;\n',
    },
    {
      name: 'control-guard-noop-call-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      if (queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes) noopReview();\n',
    },
    {
      name: 'control-guard-wrong-return-decoy',
      driftMechanism: 'tuple' as const,
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      if (queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes) return { ok: true };\n',
      manifestDrift: true,
    },
    {
      name: 'control-guard-conditional-noop-decoy',
      path: 'frontend/src/utils/terminalOutputScheduler.ts',
      from: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes',
      to: 'Number.MAX_SAFE_INTEGER > config.visibleOutputQueueMaxBytes',
      suffix: '',
      insertBefore: '      const allowSingleOversizedIdle = !inFlight && activeChunkCount() === 0;',
      inserted: '      const __conditionalDecoy = queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes ? noopReview() : noopReview();\n',
    },
    {
      name: 'derived-control-shadowed-use-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          { const __reviewDecision = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes; }\n          { const __reviewDecision = true; if (__reviewDecision) return; }\n',
    },
    {
      name: 'derived-control-noop-guard-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          const __reviewDecision = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;\n          if (__reviewDecision) noopReview();\n',
    },
    {
      name: 'derived-control-call-input-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          const __reviewDecision = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;\n          noopReview(__reviewDecision);\n',
    },
    {
      name: 'derived-control-return-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          const __reviewDecision = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;\n          return __reviewDecision;\n',
    },
    {
      name: 'derived-control-for-of-shadow-decoy',
      path: 'frontend/src/utils/terminalGraceBuffer.ts',
      from: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes',
      to: 'false',
      suffix: '',
      insertBefore: '          const byteOverflow = false;',
      inserted: '          const __reviewDecision = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;\n          for (const __reviewDecision of [true]) { if (__reviewDecision) return; }\n',
    },
    {
      name: 'split-owner-does-not-share-evidence',
      path: 'server/src/ws/WsRouter.ts',
      from: 'limits.serverBufferedHighWaterBytes',
      to: 'Number.MAX_SAFE_INTEGER',
      suffix: '',
      // 3, one per occurrence: two in WsRouter.sendTransportMessage and one in
      // WsRouter.flushTransportQueue. It was 2 when the file held two, and stayed 2 when a third
      // was added, so the tail occurrence stopped being mutated.
      //
      // RESIDUAL, and it is larger than the count fix suggests: discovery throws on the FIRST
      // catalog entry with a missing signature, and the catalog lists sendTransportMessage before
      // flushTransportQueue, so this fixture rejects on the first owner whether the second is
      // mutated or not. It therefore proves the first owner must carry evidence and CANNOT observe
      // the second at all - it does not prove what its name says, that one owner's evidence is not
      // counted for the other. Doing that needs two fixtures each mutating one owner's occurrences
      // by offset and asserting the throw names that owner's consumerSymbol, which this harness
      // cannot express. What replaceCount 3 plus the exact-count assertion buys is a tripwire: the
      // next time the occurrence count moves, this goes red instead of quietly narrowing.
      replaceCount: 3,
    },
  ] as const;
  for (const mutation of mutations) {
    const targetRoot = await mkdtemp(join(tmpdir(), `buildergate-policy-${mutation.name}-`));
    try {
      await copyInventorySources(requiredPaths, targetRoot);
      const targetPath = join(targetRoot, mutation.path);
      const source = await readFile(targetPath, 'utf8');
      const replacements = 'replaceCount' in mutation ? mutation.replaceCount : 1;
      const available = source.split(mutation.from).length - 1;
      // Exact, not >=. String.replace takes the first match each iteration, so a fixture whose
      // target gains an occurrence quietly stops mutating the tail of its own target set: with
      // `>=`, split-owner-does-not-share-evidence kept replaceCount 2 after WsRouter.ts grew a
      // third occurrence, so both replacements landed in sendTransportMessage and
      // flushTransportQueue was never mutated at all - while the fixture stayed green.
      assert.equal(
        available,
        replacements,
        `${mutation.name}: expected exactly ${replacements} occurrence(s) of ${JSON.stringify(mutation.from)} in ${mutation.path}, found ${available}`,
      );
      let mutatedSource = source;
      for (let index = 0; index < replacements; index += 1) {
        mutatedSource = mutatedSource.replace(mutation.from, mutation.to);
      }
      if ('insertBefore' in mutation) {
        mutatedSource = insertBeforeMarkerLines(mutatedSource, mutation.insertBefore, mutation.inserted, mutation.name);
      }
      await writeFile(targetPath, `${mutatedSource}${mutation.suffix}`, 'utf8');
      if ('manifestDrift' in mutation && mutation.manifestDrift) {
        const mutatedInventory = await discoverTerminalResourceInventory({ repositoryRoot: targetRoot });
        const result = validateTerminalResourceConsumerManifest(manifest, mutatedInventory);
        assert.equal(result.ok, false, mutation.name);
        // The old form accepted missing-tuple OR orphan-tuple OR source-hash-mismatch. Every mutated
        // file is in evidenceSourcePaths, so source-hash-mismatch is emitted for ANY byte-level
        // change - a stray space satisfies it - which means the disjunction could not tell a
        // discriminated decoy from an undiscriminated one, and reported both as the same pass.
        //
        // Measured, rather than assumed: three of these fixtures do produce tuple drift and three do
        // not need the seal at all. The two `unchanged-guard-after-*` fixtures produce ONLY source
        // errors, which matches what PH-001 declared about them - inserting `if (true) return` ahead
        // of an unchanged guard is caught by the coarse source seal, not by the AST losing the
        // tuple. So the mechanism is now declared per fixture and asserted, instead of one
        // disjunction covering both and hiding which is which.
        const tupleDrift = result.errors.filter((error) => (
          error.code === 'missing-tuple' || error.code === 'orphan-tuple'
        ));
        const codes = JSON.stringify(result.errors.map((error) => error.code));
        if (mutation.driftMechanism === 'tuple') {
          assert.ok(
            tupleDrift.length > 0,
            `${mutation.name}: declared tuple drift, but the decoy changed no tuple; got ${codes}`,
          );
        } else {
          // Seal-only, and that is a weaker thing to be: this fixture cannot distinguish its named
          // decoy from a stray whitespace edit, because both trip the same source hash. Asserting
          // the absence of tuple drift is what keeps the label honest - if the AST ever does learn
          // to see this decoy, this goes red and the fixture gets promoted rather than silently
          // staying in the weaker class.
          assert.equal(
            tupleDrift.length,
            0,
            `${mutation.name}: declared seal-only, but the decoy now produces tuple drift; promote it to driftMechanism 'tuple'. Got ${codes}`,
          );
          assert.ok(
            result.errors.some((error) => error.code === 'source-hash-mismatch'),
            `${mutation.name}: declared seal-only but produced no source-hash-mismatch; got ${codes}`,
          );
        }
      } else {
        await assert.rejects(
          () => discoverTerminalResourceInventory({ repositoryRoot: targetRoot }),
          /consumer signature missing|consumer scope mismatch/i,
          mutation.name,
        );
      }
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  }
});

test('OBS-BGSTAB-005 second review regression — production observe mode seeds bounded decisions on every config generation', async () => {
  const contract = await loadContract('AC-5');
  const registered = contract.getRegisteredTerminalResourcePolicyObservationDecisions();
  assert.ok(registered.length > 0);
  const observed = new RuntimeConfigStore(createConfigFixture(12_345), 'linux', {
    terminalResourcePolicy: { observation: 'observe' },
  });
  const disabled = new RuntimeConfigStore(createConfigFixture(12_345), 'linux', {
    terminalResourcePolicy: { observation: 'disabled' },
  });
  const expectedPairs = registered.map((entry) => `${entry.consumer}|${entry.resource}`).sort();
  const readPairs = () => observed.getTerminalResourcePolicyObservation().recentObservations
    .map((entry) => `${entry.consumer}|${entry.resource}`).sort();
  assert.deepEqual(readPairs(), expectedPairs);
  assert.deepEqual(readPairs(), expectedPairs, 'getter must remain read-only');
  assert.deepEqual(disabled.getTerminalResourcePolicyObservation().recentObservations, []);

  const initialObservations = observed.getTerminalResourcePolicyObservation().recentObservations;
  const serverScrollback = initialObservations.find((entry) => entry.consumer === 'server.pty.headless-model'
    && entry.resource === 'resourceLimits.terminal.scrollbackLines');
  const browserScrollback = initialObservations.find((entry) => entry.consumer === 'browser.terminal.write-scheduler'
    && entry.resource === 'resourceLimits.terminal.scrollbackLines');
  const decided = { value: 12_345, source: 'resourceLimits.terminal.scrollbackLines', reason: 'legacy-only' };
  assert.deepEqual(
    { value: serverScrollback?.legacyDecision, source: serverScrollback?.source, reason: serverScrollback?.differenceReason },
    decided,
  );
  assert.deepEqual(
    { value: browserScrollback?.legacyDecision, source: browserScrollback?.source, reason: browserScrollback?.differenceReason },
    decided,
    'the browser must observe the same decision as the server model',
  );
  for (const resource of [
    'resourceLimits.headless.writeBatchMaxBytes',
    'resourceLimits.headless.writeLagWarnMs',
  ] as const) {
    const reserved = initialObservations.find((entry) => entry.resource === resource);
    assert.equal(reserved?.legacyDecision, null);
    assert.equal(reserved?.differenceReason, 'reserved-unapplied');
  }

  const next = observed.getEditableValues();
  next.session.idleDelayMs += 1;
  next.resourceLimits.terminal.scrollbackLines = 22_222;
  next.resourceLimits.ws.serverBufferedHighWaterBytes = 12_345;
  observed.replaceValues(next);
  assert.deepEqual(readPairs(), expectedPairs, 'replaceValues must seed the next generation');
  const replacedServer = observed.getTerminalResourcePolicyObservation().recentObservations.find(
    (entry) => entry.consumer === 'server.pty.headless-model'
      && entry.resource === 'resourceLimits.terminal.scrollbackLines',
  );
  assert.equal(replacedServer?.legacyDecision, 22_222, 'the headless model follows a runtime replacement of the canonical key');
  const replacedWs = observed.getTerminalResourcePolicyObservation().recentObservations.find(
    (entry) => entry.consumer === 'server.ws.router'
      && entry.resource === 'resourceLimits.ws.serverBufferedHighWaterBytes',
  );
  assert.equal(replacedWs?.legacyDecision, 12_345, 'ordinary consumed resources use the compiled replacement value');
  const reloadedConfig = createConfigFixture(12_346);
  reloadedConfig.pty.scrollbackLines = 3_456;
  observed.replaceFromConfig(reloadedConfig);
  assert.deepEqual(readPairs(), expectedPairs, 'replaceFromConfig must seed the next generation');
  const reloadedServer = observed.getTerminalResourcePolicyObservation().recentObservations.find(
    (entry) => entry.consumer === 'server.pty.headless-model'
      && entry.resource === 'resourceLimits.terminal.scrollbackLines',
  );
  assert.equal(reloadedServer?.legacyDecision, 12_346, 'a canonical key outranks the legacy pty alias on reload');
  assert.doesNotMatch(JSON.stringify(observed.getTerminalResourcePolicyObservation().recentObservations), /password|secret|token|rawTerminalPayload/i);
});

test('OBS-BGSTAB-005 second review regression — differential executes actual server and browser consumer helpers', () => {
  const cliPath = join(REPOSITORY_ROOT, 'server/node_modules/tsx/dist/cli.mjs');
  const scriptPath = join(REPOSITORY_ROOT, 'tools/wave3/terminal-resource-policy-differential.ts');
  const output = execFileSync(process.execPath, [cliPath, scriptPath], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  const jsonStart = output.lastIndexOf('\n{');
  const parsed = JSON.parse(output.slice(jsonStart >= 0 ? jsonStart + 1 : 0)) as {
    actualConsumers?: {
      byteForByteEqual?: boolean;
      coverage?: Record<string, boolean>;
      harnessIds?: string[];
    };
  };
  assert.equal(parsed.actualConsumers?.byteForByteEqual, true);
  assert.deepEqual(parsed.actualConsumers?.coverage, {
    admission: true,
    cap: true,
    drop: true,
    reconnect: true,
    recovery: true,
    bytes: true,
    order: true,
    generation: true,
  });
  assert.deepEqual(parsed.actualConsumers?.harnessIds, [
    'server.headless-output-queue',
    'server.ws-send-policy',
    'browser.websocket-backpressure',
    'browser.output-scheduler',
    'browser.hidden-output',
    'browser.visible-output-recovery',
    'browser.snapshot-storage',
    'browser.runtime-residency',
  ]);
});

test('OBS-BGSTAB-005 review regression — observer differential preserves actual serialized legacy paths', async () => {
  const fixture = createConfigFixture(12_345);
  const disabled = new RuntimeConfigStore(structuredClone(fixture), 'linux', {
    terminalResourcePolicy: { observation: 'disabled' },
  });
  const observed = new RuntimeConfigStore(structuredClone(fixture), 'linux', {
    terminalResourcePolicy: { observation: 'observe' },
  });
  const serializeRuntime = (store: RuntimeConfigStore) => ({
    snapshot: JSON.stringify(store.getSnapshot()),
    editable: JSON.stringify(store.getEditableValues()),
    public: JSON.stringify(store.getPublicRuntimeConfig('strict')),
    storage: JSON.stringify({ values: store.getSnapshot().values }),
    defaults: JSON.stringify(resourceLimitsSchema.parse(undefined)),
    decisionStack: JSON.stringify(store.getTerminalResourcePolicyObservation().decisionStack),
  });
  const baseline = serializeRuntime(disabled);
  const candidate = serializeRuntime(observed);
  assert.deepEqual(candidate, baseline);
  assert.equal(stableHash(candidate), stableHash(baseline));

  const before = observed.getTerminalResourcePolicyObservation();
  const readAgain = observed.getTerminalResourcePolicyObservation();
  assert.deepEqual(readAgain.recentObservations, before.recentObservations);
  assert.equal(observed.recordTerminalResourcePolicyDecision({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.terminal.scrollbackLines',
    differenceReason: 'legacy-only',
  }), true);
  assert.equal(disabled.recordTerminalResourcePolicyDecision({
    consumer: 'server.config.runtime-store',
    resource: 'resourceLimits.terminal.scrollbackLines',
    differenceReason: 'legacy-only',
  }), false);
  assert.equal(observed.getTerminalResourcePolicyObservation().recentObservations.length, before.recentObservations.length + 1);
  assert.equal(disabled.getTerminalResourcePolicyObservation().recentObservations.length, 0);
});

test('PERF-BGSTAB-010 AC-4 fair delivery policy projection is derived from typed WS resource limits', async () => {
  const policy = await import('./TerminalResourcePolicy.js') as typeof import('./TerminalResourcePolicy.js') & {
    resolveFairTerminalDeliveryPolicy?: (limits: {
      serverBufferedHighWaterBytes: number;
      perClientOutputQueueMaxBytes: number;
      perClientControlQueueMaxBytes: number;
      outputCoalesceWindowMs: number;
    }) => Record<string, { value: number | string; source: string }>;
  };
  const signature = 'PERF-BGSTAB-010 AC-4 fair delivery policy projection 계약 부재 때문에 실패';
  assert.equal(typeof policy.resolveFairTerminalDeliveryPolicy, 'function', signature);
  const projection = policy.resolveFairTerminalDeliveryPolicy!({
    serverBufferedHighWaterBytes: 12_288,
    perClientOutputQueueMaxBytes: 4_096,
    perClientControlQueueMaxBytes: 1_024,
    outputCoalesceWindowMs: 16,
  });
  assert.deepEqual(
    {
      strategy: projection.strategy.value,
      socketSoftGateBytes: projection.socketSoftGateBytes.value,
      bulkSliceBytes: projection.bulkSliceBytes.value,
      smallOutputBypassBytes: projection.smallOutputBypassBytes.value,
      visibilityWeight: projection.visibilityWeight.value,
      driverWeight: projection.driverWeight.value,
      creditWindowBytes: projection.creditWindowBytes.value,
      queueMaxBytes: projection.queueMaxBytes.value,
      ackTimeoutMs: projection.ackTimeoutMs.value,
    },
    {
      strategy: 'deficit-round-robin',
      socketSoftGateBytes: 12_288,
      bulkSliceBytes: 256,
      smallOutputBypassBytes: 128,
      visibilityWeight: 8,
      driverWeight: 16,
      creditWindowBytes: 4_096,
      queueMaxBytes: 4_096,
      ackTimeoutMs: 5_000,
    },
    signature,
  );
  // AC-4 는 아홉 키가 전부 파생될 것을 요구한다. 키가 늘거나 줄면 red 여야 한다.
  assert.deepEqual(
    Object.keys(projection).sort(),
    [
      'ackTimeoutMs',
      'bulkSliceBytes',
      'creditWindowBytes',
      'driverWeight',
      'queueMaxBytes',
      'smallOutputBypassBytes',
      'socketSoftGateBytes',
      'strategy',
      'visibilityWeight',
    ],
    signature,
  );
  // AC-4 가 요구하는 것은 source 가 빈 문자열이 아니라는 것이 아니라, 어느 필드에서
  // 파생되었는지다. 리터럴로 대조한다.
  assert.deepEqual(
    Object.fromEntries(Object.entries(projection).map(([key, value]) => [key, value.source])),
    {
      strategy: 'fair-scheduler-decision.json#candidate',
      socketSoftGateBytes: 'resourceLimits.ws.serverBufferedHighWaterBytes',
      bulkSliceBytes: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
      smallOutputBypassBytes: 'resourceLimits.ws.perClientControlQueueMaxBytes',
      visibilityWeight: 'resourceLimits.ws.perClientControlQueueMaxBytes',
      driverWeight: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
      creditWindowBytes: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
      ackTimeoutMs: 'ws.terminal-delivery.ack-timeout',
      queueMaxBytes: 'resourceLimits.ws.perClientOutputQueueMaxBytes',
    },
    signature,
  );
});

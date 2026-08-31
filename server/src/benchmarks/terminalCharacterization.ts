import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as waitForImmediate, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  aggregateBenchmarkSamples,
  BENCHMARK_MODES,
  canonicalJson,
  type BenchmarkExecutionManifest,
  type BenchmarkMode,
  type BenchmarkModeDescriptor,
  type BenchmarkRawSample,
  type BenchmarkWorkload,
  validateExecutionManifest,
} from './benchmarkStatistics.js';
import {
  createWsTransportMessage,
  createWsTransportQueueState,
  dequeueNextTransportMessage,
  pushTransportMessage,
} from '../ws/wsSendPolicy.js';
import { SessionManager } from '../services/SessionManager.js';
import { WsRouter } from '../ws/WsRouter.js';

export interface TerminalMetricSnapshot {
  sequence: number;
  eventLoopDelayMeanMs: number;
  eventLoopDelayP99Ms: number;
  processCpuPercentOfOneCore: number;
  headlessWriteCumulativeMs: number;
}

export interface TerminalClientObservation {
  clientId: string;
  role: 'pressure-baseline' | 'slow' | 'normal';
  isolationEvidence: boolean;
  streamDigest: string;
  peerClientId?: string;
  pressureApplied: boolean;
  bufferedAmountBefore: number;
  deliveryBeforeDrainCount: number;
  deliveryAfterDrainCount: number;
}

export interface TerminalFixtureEvidenceReference {
  fixtureExecutionId: string;
  fixtureResultDigest: string;
  ingressDigest: string;
  source: string;
}

export interface TerminalSemanticAnalyzerEvidence {
  actualOnDataPath: true;
  controlInvocationCount: number;
  bypassInvocationCount: number;
  controlDeliveryDigest: string;
  bypassDeliveryDigest: string;
}

export interface TerminalCharacterizationCase {
  mode: BenchmarkMode;
  sessionCount: number;
  clientCount: number;
  viewMix: { active: number; hidden: number };
  ingressDigest: string;
  analyzerInvocationCount: number;
  networkSendCount: number;
  inProcessDeliveryCount: number;
  clientObservations: TerminalClientObservation[];
  workloadExecutionId: string;
  fixtureEvidence?: TerminalFixtureEvidenceReference;
  semanticAnalyzerEvidence?: TerminalSemanticAnalyzerEvidence;
}

export interface TerminalRawSample extends BenchmarkRawSample {
  metricSource: string;
  interval: {
    sequenceStart: number;
    sequenceEnd: number;
    deltaValue: number;
    unit: string;
    durationMs: number;
    valueSemantics: string;
  };
  workloadExecutionRef: string;
  fixtureEvidenceRef?: Pick<TerminalFixtureEvidenceReference, 'fixtureExecutionId' | 'fixtureResultDigest'>;
}

export interface TerminalCharacterizationResult {
  manifest: BenchmarkExecutionManifest;
  cases: TerminalCharacterizationCase[];
  rawSamples: TerminalRawSample[];
  fixtureEvidence: TerminalNoRenderEvidence[];
  executionOrder: ['manifest', 'raw-samples'];
}

interface TerminalNoRenderEvidence {
  schemaVersion: 1;
  artifactType: 'terminal-no-render-fixture-evidence';
  fixtureExecutionId: string;
  source: string;
  mode: BenchmarkModeDescriptor;
  ingressDigest: string;
  control: {
    ingressDigest: string;
    rendererWriteCount: number;
    writeConsumerInvocationCount: number;
  };
  observation: {
    ingressDigest: string;
    rendererWriteCount: number;
    accountingConsumerInvocationCount: number;
    consumedBytes: number;
  };
  contentDigest: string;
}

interface TerminalMetricIntervalObservation {
  before: TerminalMetricSnapshot;
  after: TerminalMetricSnapshot;
  durationMs: number;
  actual: boolean;
}

const TERMINAL_MODES: readonly BenchmarkModeDescriptor[] = [
  {
    id: 'NO_RENDER',
    disabledLayers: ['terminal-renderer'],
    replacedLayers: ['terminal-write-consumer->benchmark-accounting-sink'],
    retainedLayers: ['seeded-pty-ingress', 'terminal-output-scheduler', 'queue-accounting'],
    controlComparator: 'CONTROL_RENDER',
    fixture: 'frontend/tests/benchmarks/terminalNoRenderFixture.ts',
  },
  {
    id: 'NO_ANALYZER',
    disabledLayers: ['semantic-analyzer'],
    replacedLayers: ['semantic-analyzer->counting-bypass'],
    retainedLayers: ['seeded-pty-ingress', 'headless-delivery', 'ws-send-policy'],
    controlComparator: 'CONTROL_ALL_LAYERS',
    fixture: 'seeded-pty-analyzer-bypass-v1',
  },
  {
    id: 'NO_NETWORK',
    disabledLayers: ['network-socket-send'],
    replacedLayers: ['network-socket-send->in-process-fake-transport'],
    retainedLayers: ['seeded-pty-ingress', 'semantic-analyzer', 'ws-send-policy-queue'],
    controlComparator: 'CONTROL_ALL_LAYERS',
    fixture: 'ws-send-policy-in-process-transport-v1',
  },
  {
    id: 'ONE_CLIENT_SLOW',
    disabledLayers: ['normal-drain-for-client-1'],
    replacedLayers: ['client-1-socket-drain->controlled-pressure-gate'],
    retainedLayers: ['same-session-stream', 'normal-peer-delivery', 'ws-send-policy'],
    controlComparator: 'NORMAL_CLIENT_PEER',
    fixture: 'controlled-buffered-amount-client-isolation-v1',
  },
];

const METRIC_SOURCES = [
  {
    metricName: 'event_loop_delay_mean',
    source: 'SessionManager.getObservabilitySnapshot.eventLoopDelay.mean',
    unit: 'ms',
    intervalDelta: false,
  },
  {
    metricName: 'event_loop_delay_p99',
    source: 'SessionManager.getObservabilitySnapshot.eventLoopDelay.p99',
    unit: 'ms',
    intervalDelta: false,
  },
  {
    metricName: 'process_cpu_one_core_percent',
    source: 'SessionManager.getObservabilitySnapshot.processCpuPercentOfOneCore',
    unit: 'percent_one_core',
    intervalDelta: true,
  },
  {
    metricName: 'headless_write_cumulative_ms',
    source: 'SessionManager.getObservabilitySnapshot.headlessWriteCumulativeMs',
    unit: 'ms',
    intervalDelta: true,
  },
  {
    metricName: 'client_delivery_before_drain_count',
    source: 'WsRouter.routeSessionOutput.mutable-bufferedAmount.before-drain',
    unit: 'messages',
    intervalDelta: false,
  },
  {
    metricName: 'client_delivery_after_drain_count',
    source: 'WsRouter.flushTransportQueue.mutable-bufferedAmount.after-drain',
    unit: 'messages',
    intervalDelta: false,
  },
] as const;

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_RANDOM_SEED = 7008;
const DEFAULT_TRIAL_COUNT = 3;
const DEFAULT_TRIAL_DURATION_MS = 250;

// @req PERF-BGSTAB-008
export function getTerminalCharacterizationModes(): BenchmarkModeDescriptor[] {
  return TERMINAL_MODES.map(mode => ({
    ...mode,
    disabledLayers: [...mode.disabledLayers],
    replacedLayers: [...mode.replacedLayers],
    retainedLayers: [...mode.retainedLayers],
  }));
}

// @req PERF-BGSTAB-008
export function createTerminalWorkloadCorpus(): BenchmarkWorkload[] {
  const workloads: BenchmarkWorkload[] = [];
  for (const sessions of [1, 8, 32, 54] as const) {
    for (const clients of [1, 2, 8] as const) {
      workloads.push({
        sessions,
        clients,
        viewMix: { active: 1, hidden: sessions - 1 },
      });
    }
  }
  return workloads;
}

// @req PERF-BGSTAB-008
export function createTerminalCharacterizationManifest(
  randomSeed = DEFAULT_RANDOM_SEED,
  modeIds: BenchmarkMode[] = [...BENCHMARK_MODES],
  workloads: BenchmarkWorkload[] = createTerminalWorkloadCorpus(),
): BenchmarkExecutionManifest {
  const payload = generateTerminalPayload(randomSeed);
  const commit = readGitCommit();
  const cpuList = cpus();
  const manifest: BenchmarkExecutionManifest = {
    schemaVersion: 1,
    runId: `wave1-terminal-characterization-${randomSeed}`,
    randomSeed,
    payload: {
      generator: 'seeded-terminal-mixed-v1',
      digest: digestUtf8(payload),
      size: Buffer.byteLength(payload, 'utf8'),
      unit: 'bytes',
    },
    warmup: { kind: 'iterations', value: 1 },
    trials: { count: DEFAULT_TRIAL_COUNT, durationMs: DEFAULT_TRIAL_DURATION_MS },
    build: {
      identifier: `buildergate-${commit.slice(0, 12)}`,
      commit,
    },
    environment: {
      hardware: {
        architecture: arch(),
        cpuModel: cpuList[0]?.model ?? 'unknown-cpu',
        logicalCores: Math.max(1, cpuList.length),
        memoryBytes: totalmem(),
      },
      os: { platform: platform(), release: release() },
      browser: {
        name: process.env.BUILDERGATE_BENCHMARK_BROWSER_NAME ?? 'none-node-characterization',
        version: process.env.BUILDERGATE_BENCHMARK_BROWSER_VERSION ?? process.version,
      },
    },
    config: {
      serverDigest: digestFileOrLabel(resolve(PROJECT_ROOT, 'server', 'config.json5'), 'missing-server-config'),
      frontendDigest: digestFileOrLabel(
        resolve(PROJECT_ROOT, 'frontend', 'package.json'),
        'missing-frontend-runtime-config',
      ),
    },
    workloadManifestId: 'wave1-terminal-workload-corpus-v1',
    workloads: workloads.map(workload => ({
      ...workload,
      viewMix: { ...workload.viewMix },
    })),
    metricSources: METRIC_SOURCES.map(source => ({ ...source })),
    modes: getTerminalCharacterizationModes().filter(mode => modeIds.includes(mode.id)),
    sampleInterval: {
      durationMs: DEFAULT_TRIAL_DURATION_MS,
      deltaSemantics: 'after-minus-before for cumulative metrics; interval statistic for mean/p99/CPU',
    },
  };
  validateExecutionManifest(manifest);
  return manifest;
}

// @req PERF-BGSTAB-008
export async function runTerminalCharacterization(
  input: {
    deterministicMetrics?: boolean;
    randomSeed?: number;
    modes?: string[];
    workloads?: BenchmarkWorkload[];
  } = {},
): Promise<TerminalCharacterizationResult> {
  const selectedModes = validateSelectedModes(input.modes);
  const selectedWorkloads = validateSelectedWorkloads(input.workloads);
  const manifest = createTerminalCharacterizationManifest(
    input.randomSeed ?? DEFAULT_RANDOM_SEED,
    selectedModes,
    selectedWorkloads,
  );
  const payload = generateTerminalPayload(manifest.randomSeed);
  const deterministicMetricSampler = input.deterministicMetrics
    ? createDeterministicMetricSampler(manifest.randomSeed)
    : null;
  const cases: TerminalCharacterizationCase[] = [];
  const rawSamples: TerminalRawSample[] = [];
  const fixtureEvidence = selectedModes.includes('NO_RENDER')
    ? [readExternalNoRenderEvidence(payload)]
    : [];
  const noRenderEvidence = fixtureEvidence[0];

  for (const mode of selectedModes) {
    for (const workload of manifest.workloads) {
      const caseObservation = await executeTerminalCase(mode, workload, payload, noRenderEvidence);
      cases.push(caseObservation);
      for (let trial = 1; trial <= manifest.trials.count; trial += 1) {
        const metricInterval = deterministicMetricSampler
          ? createDeterministicMetricInterval(deterministicMetricSampler, manifest.trials.durationMs)
          : await runActualSessionMetricInterval(mode, workload, payload, manifest.trials.durationMs);
        rawSamples.push(...createMetricSamples(
          manifest,
          caseObservation,
          `trial-${trial}`,
          metricInterval,
        ));
      }
    }
  }

  return {
    manifest,
    cases,
    rawSamples,
    fixtureEvidence,
    executionOrder: ['manifest', 'raw-samples'],
  };
}

// @req PERF-BGSTAB-008
export async function writeTerminalCharacterizationArtifacts(outputDirectory: string): Promise<{
  rawPath: string;
  summaryPath: string;
  rawDigest: string;
  summaryDigest: string;
  fixtureEvidencePaths: string[];
}> {
  const result = await runTerminalCharacterization();
  const rawWithoutDigest = {
    schemaVersion: 1,
    artifactType: 'benchmark-raw-samples',
    manifest: result.manifest,
    fixtureEvidence: result.fixtureEvidence,
    cases: result.cases,
    executionOrder: result.executionOrder,
    rawSamples: result.rawSamples,
  };
  const rawDigest = digestCanonical(rawWithoutDigest);
  const rawArtifact = { ...rawWithoutDigest, contentDigest: rawDigest };
  mkdirSync(outputDirectory, { recursive: true });
  const fixtureEvidencePaths = result.fixtureEvidence.map((evidence) => {
    const path = resolve(outputDirectory, `${evidence.fixtureExecutionId}.json`);
    writeJsonAtomically(path, evidence);
    return path;
  });
  const rawPath = resolve(outputDirectory, 'benchmark-raw-samples.json');
  writeJsonAtomically(rawPath, rawArtifact);

  const summaries = aggregateBenchmarkSamples(result.manifest, result.rawSamples);
  const recalculated = aggregateBenchmarkSamples(result.manifest, [...result.rawSamples].reverse());
  if (canonicalJson(summaries) !== canonicalJson(recalculated)) {
    throw new Error('Benchmark summary independent recalculation mismatch');
  }
  const summaryWithoutDigest = {
    schemaVersion: 1,
    artifactType: 'benchmark-summary',
    rawArtifactDigest: rawDigest,
    fixtureEvidenceDigests: result.fixtureEvidence.map(evidence => evidence.contentDigest),
    manifestDigest: digestCanonical(result.manifest),
    calculation: {
      percentiles: ['p50', 'p95', 'p99'],
      confidenceInterval: 'seeded-bootstrap-median-percentile',
      independentlyRecalculated: true,
    },
    summaries,
  };
  const summaryDigest = digestCanonical(summaryWithoutDigest);
  const summaryPath = resolve(outputDirectory, 'benchmark-summary.json');
  writeJsonAtomically(summaryPath, { ...summaryWithoutDigest, contentDigest: summaryDigest });
  return { rawPath, summaryPath, rawDigest, summaryDigest, fixtureEvidencePaths };
}

// @req PERF-BGSTAB-008
async function executeTerminalCase(
  mode: BenchmarkMode,
  workload: BenchmarkWorkload,
  payload: string,
  noRenderEvidence?: TerminalNoRenderEvidence,
): Promise<TerminalCharacterizationCase> {
  const ingressDigest = digestUtf8(payload);
  let analyzerInvocationCount = 0;
  let networkSendCount = 0;
  let inProcessDeliveryCount = 0;
  const queue = createWsTransportQueueState();

  for (let session = 1; session <= workload.sessions; session += 1) {
    if (mode !== 'NO_ANALYZER') {
      inspectTerminalPayload(payload);
      analyzerInvocationCount += 1;
    }
    pushTransportMessage(queue, createWsTransportMessage({
      type: 'output',
      sessionId: `session-${session}`,
      data: payload,
    }, session));
  }
  let message = dequeueNextTransportMessage(queue);
  while (message) {
    if (mode === 'NO_NETWORK') {
      inProcessDeliveryCount += 1;
    } else {
      networkSendCount += workload.clients;
    }
    message = dequeueNextTransportMessage(queue);
  }

  const workloadExecutionId = createWorkloadExecutionId(mode, workload, ingressDigest);
  const semanticAnalyzerEvidence = mode === 'NO_ANALYZER'
    ? await observeActualSemanticAnalyzerBypass(workload.sessions, payload, ingressDigest)
    : undefined;
  const actualIngress = mode === 'NO_ANALYZER'
    ? null
    : await executeActualSessionIngress(workload.sessions, payload, false);
  if (actualIngress && actualIngress.deliveryDigest !== ingressDigest) {
    throw new Error(`${mode} actual SessionManager onData delivery digest drifted from ingress`);
  }
  const clientObservations = mode === 'ONE_CLIENT_SLOW'
    ? observeActualSlowClientPressure(workload.clients, payload, ingressDigest)
    : createNormalClientObservations(workload.clients, ingressDigest);
  const fixtureEvidence = mode === 'NO_RENDER'
    ? createNoRenderEvidenceReference(noRenderEvidence, ingressDigest)
    : undefined;

  return {
    mode,
    sessionCount: workload.sessions,
    clientCount: workload.clients,
    viewMix: { ...workload.viewMix },
    ingressDigest,
    analyzerInvocationCount,
    networkSendCount,
    inProcessDeliveryCount,
    clientObservations,
    workloadExecutionId,
    ...(fixtureEvidence ? { fixtureEvidence } : {}),
    ...(semanticAnalyzerEvidence ? { semanticAnalyzerEvidence } : {}),
  };
}

// @req PERF-BGSTAB-008
function createNormalClientObservations(
  clientCount: number,
  streamDigest: string,
): TerminalClientObservation[] {
  return Array.from({ length: clientCount }, (_, index) => ({
    clientId: `client-${index + 1}`,
    role: 'normal',
    isolationEvidence: false,
    streamDigest,
    pressureApplied: false,
    bufferedAmountBefore: 0,
    deliveryBeforeDrainCount: 1,
    deliveryAfterDrainCount: 1,
  }));
}

// @req PERF-BGSTAB-008
function observeActualSlowClientPressure(
  clientCount: number,
  payload: string,
  ingressDigest: string,
): TerminalClientObservation[] {
  const sessionId = 'benchmark-session';
  const sessionManagerStub = {
    getSession: (id: string) => id === sessionId ? { id, status: 'running' } : null,
    getLastCwd: () => undefined,
    isSessionReady: () => true,
    getScreenSnapshot: () => null,
    getReplayQueueLimit: () => 64,
    writeInput: () => true,
    resize: () => true,
  } as unknown as SessionManager;
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'benchmark' } }),
  };
  const router = new WsRouter(authServiceStub as never, sessionManagerStub, {
    inputReliabilityMode: 'queue',
    resourceLimits: {
      ws: {
        serverBufferedHighWaterBytes: 1024,
        serverBufferedHardLimitBytes: 8192,
        perClientOutputQueueMaxBytes: 1024 * 1024,
        perClientControlQueueMaxBytes: 64 * 1024,
        outputCoalesceWindowMs: 1,
      } as never,
    },
    stabilityModes: { wsSendMode: 'safe-send-enforce' },
  });
  const clients = Array.from({ length: clientCount }, (_, index) => (
    createBenchmarkFakeWebSocket(index === 0 ? 1500 : 0)
  ));

  try {
    const sockets = new Set<import('ws').WebSocket>();
    clients.forEach((client, index) => {
      sockets.add(client.ws);
      (router as unknown as { clients: Map<import('ws').WebSocket, unknown> }).clients.set(client.ws, {
        clientId: `client-${index + 1}`,
        isAlive: true,
        subscribedSessions: new Set([sessionId]),
        replayPendingSessions: new Map(),
        screenRepairPendingSessions: new Map(),
      });
    });
    (router as unknown as { sessionSubscribers: Map<string, Set<import('ws').WebSocket>> })
      .sessionSubscribers.set(sessionId, sockets);

    router.routeSessionOutput(sessionId, payload);
    const beforeCounts = clients.map(client => countDeliveredPayloads(client.sent, payload));
    clients[0].setBufferedAmount(0);
    (router as unknown as { flushTransportQueue: (ws: import('ws').WebSocket) => void })
      .flushTransportQueue(clients[0].ws);
    const afterCounts = clients.map(client => countDeliveredPayloads(client.sent, payload));

    if (beforeCounts[0] !== 0 || afterCounts[0] < 1) {
      throw new Error('ONE_CLIENT_SLOW pressure socket did not queue and drain through WsRouter');
    }
    if (clients.slice(1).some((_client, index) => beforeCounts[index + 1] < 1)) {
      throw new Error('ONE_CLIENT_SLOW normal peer was blocked by the pressured socket');
    }

    const hasNormalPeer = clientCount >= 2;
    return clients.map((client, index) => ({
      clientId: `client-${index + 1}`,
      role: index === 0 ? (hasNormalPeer ? 'slow' : 'pressure-baseline') : 'normal',
      isolationEvidence: hasNormalPeer,
      streamDigest: ingressDigest,
      ...(hasNormalPeer ? { peerClientId: index === 0 ? 'client-2' : 'client-1' } : {}),
      pressureApplied: index === 0,
      bufferedAmountBefore: client.initialBufferedAmount,
      deliveryBeforeDrainCount: beforeCounts[index],
      deliveryAfterDrainCount: afterCounts[index],
    }));
  } finally {
    router.destroy();
  }
}

function createBenchmarkFakeWebSocket(initialBufferedAmount: number): {
  ws: import('ws').WebSocket;
  sent: Array<Record<string, unknown>>;
  initialBufferedAmount: number;
  setBufferedAmount: (value: number) => void;
} {
  const sent: Array<Record<string, unknown>> = [];
  let bufferedAmount = initialBufferedAmount;
  const ws = {
    readyState: 1,
    get bufferedAmount() {
      return bufferedAmount;
    },
    send(serialized: string, callback?: (error?: Error) => void) {
      sent.push(JSON.parse(serialized) as Record<string, unknown>);
      callback?.();
    },
    ping() {},
    close() {
      (this as { readyState: number }).readyState = 3;
    },
    terminate() {
      (this as { readyState: number }).readyState = 3;
    },
    on() {
      return this;
    },
  } as unknown as import('ws').WebSocket;
  return {
    ws,
    sent,
    initialBufferedAmount,
    setBufferedAmount(value: number) {
      bufferedAmount = value;
    },
  };
}

function countDeliveredPayloads(sent: Array<Record<string, unknown>>, payload: string): number {
  const output = sent.filter(message => message.type === 'output');
  if (output.some(message => message.data !== payload)) {
    throw new Error('WsRouter delivered a stream that differs from benchmark ingress');
  }
  return output.length;
}

interface ActualSessionHarness {
  manager: SessionManager;
  runBatch: (payload: string) => Promise<void>;
  analyzerInvocationCount: () => number;
  deliveryDigest: () => string;
  dispose: () => void;
}

// @req PERF-BGSTAB-008
function createActualSessionHarness(sessionCount: number, bypassSemanticAnalyzer: boolean): ActualSessionHarness {
  const handlers: Array<(data: string) => void> = [];
  const sessionIds: string[] = [];
  const delivered: string[] = [];
  let analyzerInvocationCount = 0;
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      scrollbackLines: 1000,
      maxSnapshotBytes: 1024 * 1024,
      shell: 'bash',
    },
    session: { idleDelayMs: 1000, runningDelayMs: 1000 },
  }, {
    platform: 'linux',
    readProcessStartIdentityFn: async () => null,
    spawnPty: ((_shell: string, _args: string[], options: { cols?: number; rows?: number }) => ({
      pid: 1,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      process: 'bash',
      handleFlowControl: false,
      onData(callback: (data: string) => void) {
        handlers.push(callback);
        return { dispose() {} };
      },
      onExit() {
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill() {},
    })) as never,
  });
  (manager as unknown as { isCommandAvailable: (command: string) => boolean }).isCommandAvailable = () => true;
  manager.setWsRouter({
    routeSessionOutput(_sessionId: string, data: string) {
      delivered.push(data);
    },
    sendSessionEvent() {},
    clearSessionState() {},
    disableDebugReplayCapture() {},
    clearReplayEvents() {},
  } as unknown as WsRouter);

  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = `benchmark-session-${index + 1}`;
    manager.createSession(`Benchmark ${index + 1}`, 'bash', process.cwd(), { sessionId });
    sessionIds.push(sessionId);
    const data = (manager as unknown as { sessions: Map<string, Record<string, any>> }).sessions.get(sessionId);
    if (!data) {
      throw new Error(`SessionManager benchmark session ${sessionId} was not registered`);
    }
    if (bypassSemanticAnalyzer) {
      data.terminalTitleDetector.process = () => {};
      data.terminalTitleSignalDetector.process = () => {};
      data.terminalTitleSignalDetector.getSignalData = () => '';
    } else {
      for (const detector of [data.terminalTitleDetector, data.terminalTitleSignalDetector]) {
        const originalProcess = detector.process.bind(detector);
        detector.process = (chunk: string) => {
          analyzerInvocationCount += 1;
          return originalProcess(chunk);
        };
      }
    }
  }
  if (handlers.length !== sessionCount) {
    throw new Error('Fake PTY did not register one actual onData handler per benchmark session');
  }

  return {
    manager,
    async runBatch(payload: string) {
      const deliveredBefore = delivered.length;
      handlers.forEach(handler => handler(payload));
      const sessions = (manager as unknown as { sessions: Map<string, Record<string, any>> }).sessions;
      await Promise.all(sessionIds.map(sessionId => sessions.get(sessionId)?.headlessWriteChain));
      const batch = delivered.slice(deliveredBefore);
      if (batch.length !== sessionCount || batch.some(value => value !== payload)) {
        throw new Error('Actual SessionManager onData/headless delivery did not preserve every session payload');
      }
    },
    analyzerInvocationCount: () => analyzerInvocationCount,
    deliveryDigest: () => delivered.length > 0 ? digestUtf8(delivered[0]) : digestUtf8(''),
    dispose() {
      for (const sessionId of sessionIds) {
        manager.deleteSession(sessionId);
      }
    },
  };
}

async function executeActualSessionIngress(
  sessionCount: number,
  payload: string,
  bypassSemanticAnalyzer: boolean,
): Promise<{ analyzerInvocationCount: number; deliveryDigest: string }> {
  const harness = createActualSessionHarness(sessionCount, bypassSemanticAnalyzer);
  try {
    await harness.runBatch(payload);
    return {
      analyzerInvocationCount: harness.analyzerInvocationCount(),
      deliveryDigest: harness.deliveryDigest(),
    };
  } finally {
    harness.dispose();
  }
}

async function observeActualSemanticAnalyzerBypass(
  sessionCount: number,
  payload: string,
  ingressDigest: string,
): Promise<TerminalSemanticAnalyzerEvidence> {
  const control = await executeActualSessionIngress(sessionCount, payload, false);
  const bypass = await executeActualSessionIngress(sessionCount, payload, true);
  if (control.deliveryDigest !== ingressDigest || bypass.deliveryDigest !== ingressDigest) {
    throw new Error('NO_ANALYZER control/bypass did not preserve identical actual onData ingress');
  }
  return {
    actualOnDataPath: true,
    controlInvocationCount: control.analyzerInvocationCount,
    bypassInvocationCount: bypass.analyzerInvocationCount,
    controlDeliveryDigest: control.deliveryDigest,
    bypassDeliveryDigest: bypass.deliveryDigest,
  };
}

function createNoRenderEvidenceReference(
  evidence: TerminalNoRenderEvidence | undefined,
  ingressDigest: string,
): TerminalFixtureEvidenceReference {
  if (!evidence) {
    throw new Error('NO_RENDER requires external frontend fixture evidence');
  }
  if (evidence.ingressDigest !== ingressDigest) {
    throw new Error('NO_RENDER external fixture ingress digest does not match server workload');
  }
  return {
    fixtureExecutionId: evidence.fixtureExecutionId,
    fixtureResultDigest: evidence.contentDigest,
    ingressDigest: evidence.ingressDigest,
    source: evidence.source,
  };
}

// @req PERF-BGSTAB-008
function readExternalNoRenderEvidence(payload: string): TerminalNoRenderEvidence {
  const exporterPath = resolve(
    PROJECT_ROOT,
    'frontend',
    'tests',
    'benchmarks',
    'terminalNoRenderFixtureEvidence.ts',
  );
  const stdout = execFileSync(process.execPath, [
    '--experimental-strip-types',
    exporterPath,
    '--stdin-base64',
    Buffer.from(payload, 'utf8').toString('base64'),
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NO_RENDER external fixture evidence must be a JSON object');
  }
  const evidence = parsed as Record<string, unknown>;
  const contentDigest = evidence.contentDigest;
  const withoutDigest = { ...evidence };
  delete withoutDigest.contentDigest;
  if (
    evidence.schemaVersion !== 1
    || evidence.artifactType !== 'terminal-no-render-fixture-evidence'
    || typeof evidence.fixtureExecutionId !== 'string'
    || evidence.source !== 'frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts'
    || typeof evidence.ingressDigest !== 'string'
    || typeof contentDigest !== 'string'
    || digestCanonical(withoutDigest) !== contentDigest
  ) {
    throw new Error('NO_RENDER external fixture evidence failed schema or canonical digest validation');
  }
  const control = evidence.control as Record<string, unknown> | undefined;
  const observation = evidence.observation as Record<string, unknown> | undefined;
  const mode = evidence.mode as Record<string, unknown> | undefined;
  if (
    !control
    || !observation
    || !mode
    || mode.id !== 'NO_RENDER'
    || control.ingressDigest !== evidence.ingressDigest
    || observation.ingressDigest !== evidence.ingressDigest
    || observation.rendererWriteCount !== 0
    || typeof observation.consumedBytes !== 'number'
  ) {
    throw new Error('NO_RENDER external fixture evidence did not prove renderer bypass ingress parity');
  }
  return parsed as TerminalNoRenderEvidence;
}

function validateSelectedModes(values?: string[]): BenchmarkMode[] {
  if (values === undefined) {
    return [...BENCHMARK_MODES];
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one benchmark mode must be selected');
  }
  const selected: BenchmarkMode[] = [];
  for (const value of values) {
    if (!BENCHMARK_MODES.includes(value as BenchmarkMode)) {
      throw new Error(`Unsupported benchmark mode: ${String(value)}`);
    }
    if (!selected.includes(value as BenchmarkMode)) {
      selected.push(value as BenchmarkMode);
    }
  }
  return selected;
}

function validateSelectedWorkloads(values?: BenchmarkWorkload[]): BenchmarkWorkload[] {
  if (values === undefined) {
    return createTerminalWorkloadCorpus();
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one benchmark workload must be selected');
  }
  const allowed = new Set(createTerminalWorkloadCorpus().map(workload => (
    `${workload.sessions}:${workload.clients}:${workload.viewMix.active}:${workload.viewMix.hidden}`
  )));
  return values.map((workload) => {
    const key = `${workload.sessions}:${workload.clients}:${workload.viewMix.active}:${workload.viewMix.hidden}`;
    if (!allowed.has(key)) {
      throw new Error(`Unsupported benchmark workload: ${key}`);
    }
    return { ...workload, viewMix: { ...workload.viewMix } };
  });
}

function createWorkloadExecutionId(
  mode: BenchmarkMode,
  workload: BenchmarkWorkload,
  ingressDigest: string,
): string {
  return `workload-${digestCanonical({ mode, workload, ingressDigest }).slice('sha256:'.length, 'sha256:'.length + 20)}`;
}

// @req PERF-BGSTAB-008
function createMetricSamples(
  manifest: BenchmarkExecutionManifest,
  caseObservation: TerminalCharacterizationCase,
  trialId: string,
  observation: TerminalMetricIntervalObservation,
): TerminalRawSample[] {
  const { before, after } = observation;
  const values = [
    {
      metric: METRIC_SOURCES[0],
      value: after.eventLoopDelayMeanMs,
      delta: after.eventLoopDelayMeanMs,
      semantics: 'session-manager-observability-interval-statistic',
    },
    {
      metric: METRIC_SOURCES[1],
      value: after.eventLoopDelayP99Ms,
      delta: after.eventLoopDelayP99Ms,
      semantics: 'session-manager-observability-interval-statistic',
    },
    {
      metric: METRIC_SOURCES[2],
      value: after.processCpuPercentOfOneCore,
      delta: after.processCpuPercentOfOneCore,
      semantics: 'windowed-rate-value',
    },
    {
      metric: METRIC_SOURCES[3],
      value: Math.max(0, after.headlessWriteCumulativeMs - before.headlessWriteCumulativeMs),
      delta: after.headlessWriteCumulativeMs - before.headlessWriteCumulativeMs,
      semantics: 'after-minus-before-cumulative',
    },
  ];
  const comparators = caseObservation.mode === 'ONE_CLIENT_SLOW'
    ? caseObservation.clientObservations
    : [undefined];
  const samples: TerminalRawSample[] = [];
  for (const item of values) {
    for (const comparator of comparators) {
      const roleSuffix = comparator ? `-${comparator.clientId}-${comparator.role}` : '';
      samples.push({
        sampleId: [
          caseObservation.mode,
          `s${caseObservation.sessionCount}`,
          `c${caseObservation.clientCount}`,
          trialId,
          item.metric.metricName,
          roleSuffix || 'aggregate',
        ].join(':'),
        workloadManifestRef: manifest.workloadManifestId,
        mode: caseObservation.mode,
        sessionCount: caseObservation.sessionCount,
        clientCount: caseObservation.clientCount,
        viewMix: { ...caseObservation.viewMix },
        trialId,
        metricName: item.metric.metricName,
        value: item.value,
        unit: item.metric.unit,
        timingPhase: 'measurement',
        metricSource: item.metric.source,
        workloadExecutionRef: caseObservation.workloadExecutionId,
        interval: {
          sequenceStart: before.sequence,
          sequenceEnd: after.sequence,
          deltaValue: item.delta,
          unit: item.metric.unit,
          durationMs: observation.durationMs,
          valueSemantics: item.semantics,
        },
        ...(caseObservation.fixtureEvidence ? {
          fixtureEvidenceRef: {
            fixtureExecutionId: caseObservation.fixtureEvidence.fixtureExecutionId,
            fixtureResultDigest: caseObservation.fixtureEvidence.fixtureResultDigest,
          },
        } : {}),
        ...(comparator ? {
          comparator: {
            clientId: comparator.clientId,
            clientRole: comparator.role,
            isolationEvidence: comparator.isolationEvidence,
            ...(comparator.peerClientId ? { peerClientId: comparator.peerClientId } : {}),
          },
        } : {}),
      });
    }
  }
  if (caseObservation.mode === 'ONE_CLIENT_SLOW') {
    for (const comparator of caseObservation.clientObservations) {
      for (const delivery of [
        { metric: METRIC_SOURCES[4], value: comparator.deliveryBeforeDrainCount },
        { metric: METRIC_SOURCES[5], value: comparator.deliveryAfterDrainCount },
      ]) {
        samples.push({
          sampleId: [
            caseObservation.mode,
            `s${caseObservation.sessionCount}`,
            `c${caseObservation.clientCount}`,
            trialId,
            delivery.metric.metricName,
            comparator.clientId,
            comparator.role,
          ].join(':'),
          workloadManifestRef: manifest.workloadManifestId,
          mode: caseObservation.mode,
          sessionCount: caseObservation.sessionCount,
          clientCount: caseObservation.clientCount,
          viewMix: { ...caseObservation.viewMix },
          trialId,
          metricName: delivery.metric.metricName,
          value: delivery.value,
          unit: delivery.metric.unit,
          timingPhase: 'measurement',
          metricSource: delivery.metric.source,
          workloadExecutionRef: caseObservation.workloadExecutionId,
          interval: {
            sequenceStart: before.sequence,
            sequenceEnd: after.sequence,
            deltaValue: delivery.value,
            unit: delivery.metric.unit,
            durationMs: observation.durationMs,
            valueSemantics: 'transport-delivery-count',
          },
          comparator: {
            clientId: comparator.clientId,
            clientRole: comparator.role,
            isolationEvidence: comparator.isolationEvidence,
            ...(comparator.peerClientId ? { peerClientId: comparator.peerClientId } : {}),
          },
        });
      }
    }
  }
  return samples;
}

// @req PERF-BGSTAB-008
function createDeterministicMetricSampler(seed: number): () => TerminalMetricSnapshot {
  let sequence = 0;
  let headlessCumulative = 0;
  return () => {
    sequence += 1;
    const jitter = ((seed * 31 + sequence * 17) % 101) / 100;
    headlessCumulative += 0.05 + jitter / 10;
    return {
      sequence,
      eventLoopDelayMeanMs: 0.5 + jitter,
      eventLoopDelayP99Ms: 1.5 + jitter * 2,
      processCpuPercentOfOneCore: 3 + jitter * 5,
      headlessWriteCumulativeMs: headlessCumulative,
    };
  };
}

// @req PERF-BGSTAB-008
function createDeterministicMetricInterval(
  sampler: () => TerminalMetricSnapshot,
  durationMs: number,
): TerminalMetricIntervalObservation {
  const before = sampler();
  const after = sampler();
  return {
    before,
    after,
    durationMs,
    actual: false,
  };
}

let actualMetricSequence = 0;

// @req PERF-BGSTAB-008
async function runActualSessionMetricInterval(
  mode: BenchmarkMode,
  workload: BenchmarkWorkload,
  payload: string,
  minimumDurationMs: number,
): Promise<TerminalMetricIntervalObservation> {
  const harness = createActualSessionHarness(workload.sessions, mode === 'NO_ANALYZER');
  try {
    // Advance SessionManager's throttled CPU baseline before opening the measured
    // window. The production sampler only refreshes at >=250ms.
    await delay(Math.max(250, minimumDurationMs));
    harness.manager.getObservabilitySnapshot();
    const beforeSnapshot = harness.manager.getObservabilitySnapshot();
    const before = toTerminalMetricSnapshot(++actualMetricSequence, beforeSnapshot);
    const startedAt = performance.now();
    do {
      await harness.runBatch(payload);
      await waitForImmediate();
    } while (performance.now() - startedAt < minimumDurationMs);
    const durationMs = performance.now() - startedAt;
    const afterSnapshot = harness.manager.getObservabilitySnapshot();
    const after = toTerminalMetricSnapshot(++actualMetricSequence, afterSnapshot);
    return {
      before,
      after,
      durationMs,
      actual: true,
    };
  } finally {
    harness.dispose();
  }
}

function toTerminalMetricSnapshot(
  sequence: number,
  snapshot: ReturnType<SessionManager['getObservabilitySnapshot']>,
): TerminalMetricSnapshot {
  return {
    sequence,
    eventLoopDelayMeanMs: snapshot.eventLoopDelay.mean,
    eventLoopDelayP99Ms: snapshot.eventLoopDelay.p99,
    processCpuPercentOfOneCore: snapshot.processCpuPercentOfOneCore,
    headlessWriteCumulativeMs: snapshot.headlessWriteCumulativeMs,
  };
}

// @req PERF-BGSTAB-008
function inspectTerminalPayload(payload: string): number {
  const oscCount = payload.match(/\u001b\]/g)?.length ?? 0;
  const ansiCount = payload.match(/\u001b\[[0-9;]*[A-Za-z]/g)?.length ?? 0;
  return oscCount + ansiCount;
}

// @req PERF-BGSTAB-008
function generateTerminalPayload(seed: number): string {
  return [
    `seed=${seed}\r\n`,
    '\u001b]0;BuilderGate benchmark\u0007',
    '\u001b[31mred\u001b[0m ',
    'ASCII CJK=한글 wide=界 combining=e\u0301 emoji=🙂\r\n',
    'prompt> ',
  ].join('');
}

// @req PERF-BGSTAB-008
function digestUtf8(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

// @req PERF-BGSTAB-008
function digestCanonical(value: unknown): string {
  return digestUtf8(canonicalJson(value));
}

// @req PERF-BGSTAB-008
function digestFileOrLabel(path: string, fallback: string): string {
  return existsSync(path)
    ? `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    : digestUtf8(fallback);
}

// @req PERF-BGSTAB-008
function readGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return 'unavailable-working-tree';
  }
}

// @req PERF-BGSTAB-008
function writeJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

const cliFlagIndex = process.argv.indexOf('--write-artifacts');
if (cliFlagIndex >= 0) {
  const outputDirectory = process.argv[cliFlagIndex + 1];
  if (!outputDirectory) {
    throw new Error('--write-artifacts requires an output directory');
  }
  const written = await writeTerminalCharacterizationArtifacts(resolve(outputDirectory));
  process.stdout.write(`${JSON.stringify(written)}\n`);
}

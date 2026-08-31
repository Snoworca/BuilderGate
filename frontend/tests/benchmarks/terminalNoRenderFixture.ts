import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { arch, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { createTerminalOutputScheduler } from '../../src/utils/terminalOutputScheduler.ts';

const WAVE1_BASELINE_IMPLEMENTATION: TerminalOutputSchedulerBenchmarkImplementation = Object.freeze({
  role: 'baseline',
  implementationId: 'wave1-string-scheduler-reference-v1',
  sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
  sourceRevision: 'ca111fef3b5a5a25d3aa488415c929e90ade46fd',
  sourceDigest: 'sha256:dc1edf2acaf16f57b6e517fb1499cd67e579508d12238b3a561aaada647ac1c3',
  frozen: true,
});

const SEGMENTED_CANDIDATE_IMPLEMENTATION: TerminalOutputSchedulerBenchmarkImplementation = Object.freeze({
  role: 'candidate',
  implementationId: 'wave2-integrated-segmented-byte-deque-v2',
  sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
  sourceRevision: 'S4-C4@dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9-worktree',
  sourceDigest: 'sha256:a1e88cf04e689f38c1a734b9795a93fafae8dbb71299c583f4398e4762fcb3e6',
  frozen: true,
});

export interface TerminalSchedulerInstrumentation {
  acceptedIngressCount: number;
  encodeCallCount: number;
  encoderResultAllocationCount: number;
  ingressEncodeCallCount: number;
  maxEncodeCallsPerAcceptedIngress: number;
  prefixLoopEncodeCallCount: number;
  prefixTemporaryAllocationCount: number;
}

export interface TerminalOutputSchedulerBenchmarkImplementation {
  role: 'baseline' | 'candidate';
  implementationId: string;
  sourcePath: string;
  sourceRevision: string;
  sourceDigest: `sha256:${string}`;
  frozen: true;
}

export interface TerminalOutputSchedulerBenchmarkManifest {
  randomSeed: number;
  warmupIterations: number;
  trialCount: number;
  trialDurationMs: number;
  bootstrapIterations: number;
  confidenceLevel: 0.95;
  regressionToleranceRatio: 0.05;
  toleranceClassification: 'measurement-noise-regression-tolerance';
  productSlo: false;
}

export interface TerminalOutputSchedulerPairedBenchmarkInput {
  manifest: TerminalOutputSchedulerBenchmarkManifest;
  mixedIngress: string[];
  boundaryIngress: string[];
}

export interface TerminalOutputSchedulerPairedRawSample {
  runId: string;
  pairIndex: number;
  phase: 'warmup' | 'measurement';
  randomSeed: number;
  calibrationTargetDurationMs: number;
  baselineElapsedMs: number;
  candidateElapsedMs: number;
  baselineOperations: number;
  candidateOperations: number;
  baselineImplementationId: string;
  baselineSourceDigest: `sha256:${string}`;
  baselineExecutableDigest: `sha256:${string}`;
  candidateImplementationId: string;
  candidateSourceDigest: `sha256:${string}`;
  candidateExecutableDigest: `sha256:${string}`;
  timingMode: 'native-encoder-no-probe';
  timingOrder: 'baseline-first' | 'candidate-first';
  baselineTimedOutputDigestParity: boolean;
  candidateTimedOutputDigestParity: boolean;
  baselineInstrumentation: TerminalOutputSchedulerBenchmarkVariantInstrumentation;
  candidateInstrumentation: TerminalOutputSchedulerBenchmarkVariantInstrumentation;
  process: {
    pid: number;
    nodeVersion: string;
  };
  hardware: {
    architecture: string;
    cpuModel: string;
    logicalCores: number;
  };
}

export interface TerminalOutputSchedulerBenchmarkVariantInstrumentation {
  implementationId: string;
  sourceDigest: `sha256:${string}`;
  executableDigest: `sha256:${string}`;
  workloadDigest: `sha256:${string}`;
  workloadBytesPerOperation: number;
  outputDigestParity: boolean;
  acceptedIngressCount: number;
  encoderResultAllocationCount: number;
  maxEncodeCallsPerAcceptedIngress: number;
  prefixLoopEncodeCallCount: number;
  prefixTemporaryAllocationCount: number;
  collectionMode: 'untimed-companion-counter-pass';
  linkedPairIndex: number;
  operations: number;
}

export interface TerminalOutputSchedulerPairedBenchmarkResult {
  manifest: TerminalOutputSchedulerBenchmarkManifest;
  provenance: {
    runId: string;
    baseline: TerminalOutputSchedulerBenchmarkImplementation;
    candidate: TerminalOutputSchedulerBenchmarkImplementation;
    calibration: {
      implementationId: string;
      targetDurationMs: number;
      elapsedMs: number;
      operationsPerTrial: number;
    };
    execution: {
      baseline: {
        loader: 'git-show-typescript-data-url';
        derivedFromSourceDigest: `sha256:${string}`;
        executableDigest: `sha256:${string}`;
        timingModule: 'native-text-encoder';
        instrumentationModule: 'probed-text-encoder';
      };
      candidate: {
        loader: 'node-strip-types-module-import';
        derivedFromSourceDigest: `sha256:${string}`;
        executableDigest: `sha256:${string}`;
        timingModule: 'production-default-text-encoder';
        instrumentationModule: 'injected-probed-text-encoder';
      };
    };
  };
  exactGates: {
    outputDigestParity: boolean;
    mixedByteLength: number;
    mixedControlInvocations: number;
    mixedObservationInvocations: number;
    boundaryByteLength: number;
    boundaryControlInvocations: number;
    boundaryObservationInvocations: number;
    baselineAcceptedIngressCount: number;
    baselineEncoderResultAllocationCount: number;
    baselinePrefixLoopEncodeCount: number;
    baselinePrefixTemporaryAllocationCount: number;
    candidateAcceptedIngressCount: number;
    candidateEncoderResultAllocationCount: number;
    candidateAcceptedIngressMaxEncodeCount: number;
    candidatePrefixLoopEncodeCount: number;
    candidatePrefixTemporaryAllocationCount: number;
  };
  rawSamples: TerminalOutputSchedulerPairedRawSample[];
  summary: {
    baselineP95Ms: number;
    candidateP95Ms: number;
    pairedP95UpperDeltaMs: number;
    toleranceMs: number;
    toleranceRatio: 0.05;
    toleranceClassification: 'measurement-noise-regression-tolerance';
    productSlo: false;
    passes: boolean;
    bootstrap: {
      method: 'paired-bootstrap-p95-delta';
      confidenceLevel: 0.95;
      iterations: number;
      randomSeed: number;
    };
  };
}

export interface TerminalNoRenderFixtureResult {
  mode: {
    id: 'NO_RENDER';
    disabledLayers: ['terminal-renderer'];
    replacedLayers: ['terminal-write-consumer->benchmark-accounting-sink'];
    retainedLayers: ['utf8-ingress', 'terminal-output-scheduler', 'queue-accounting'];
    controlComparator: 'CONTROL_RENDER';
    fixture: 'injected-terminal-write-consumer-v1';
  };
  ingressDigest: string;
  control: {
    ingressDigest: string;
    rendererWriteCount: number;
    writeConsumerInvocationCount: number;
    output: string;
  };
  observation: {
    ingressDigest: string;
    rendererWriteCount: number;
    accountingConsumerInvocationCount: number;
    consumedBytes: number;
  };
  instrumentation: {
    control: TerminalSchedulerInstrumentation;
    observation: TerminalSchedulerInstrumentation;
  };
}

interface SchedulerRunResult {
  rendererWriteCount: number;
  consumerInvocationCount: number;
  output: string;
  consumedBytes: number;
  consumerDigest: string;
  instrumentation: TerminalSchedulerInstrumentation;
}

interface MeasuredVariant {
  elapsedMs: number;
  operations: number;
  timedOutputDigestParity: boolean;
  instrumentation: TerminalOutputSchedulerBenchmarkVariantInstrumentation;
}

interface TimedVariant {
  elapsedMs: number;
  outputDigestParity: boolean;
}

interface FrozenBaselineRuntime {
  timingFactory: FrozenBaselineFactory;
  instrumentationFactory: FrozenBaselineFactory;
  executableDigest: `sha256:${string}`;
}

type FrozenBaselineFactory = (options: {
    visibleOutputQueueMaxBytes: number;
    visibleOutputMaxChunks: number;
    visibleFlushBudgetBytes: number;
    visibleFlushFrameBudgetMs: number;
    write: (data: string, onWritten: () => void) => void;
    schedule: (drain: () => void) => void;
    shouldYield: () => boolean;
    now: () => number;
  }) => {
    enqueue: (data: string) => { ok: boolean; droppedBytes?: number };
    isIdle: () => boolean;
  };

interface FrozenBaselineEncoderProbe extends TerminalSchedulerInstrumentation {
  activeIngressIndex: number;
  encodeCallsByIngress: number[];
}

const NativeTextEncoder = TextEncoder;
let activeFrozenBaselineEncoderProbe: FrozenBaselineEncoderProbe | null = null;
let frozenBaselineRuntimePromise: Promise<FrozenBaselineRuntime> | null = null;

export async function runNoRenderFixture(
  input: { ingress: string[] },
): Promise<TerminalNoRenderFixtureResult> {
  if (!Array.isArray(input.ingress) || input.ingress.some(chunk => typeof chunk !== 'string')) {
    throw new TypeError('ingress must be an array of strings');
  }
  if (input.ingress.some(chunk => Buffer.byteLength(chunk, 'utf8') === 0)) {
    throw new RangeError('ingress chunks must each contain at least one UTF-8 byte');
  }
  const ingressByteLength = input.ingress.reduce(
    (total, chunk) => total + Buffer.byteLength(chunk, 'utf8'),
    0,
  );
  if (ingressByteLength === 0) {
    throw new RangeError('ingress must contain at least one UTF-8 byte');
  }

  const ingressDigest = digestIngress(input.ingress);
  const expectedOutput = input.ingress.join('');
  const control = runScheduler(input.ingress, true);
  const observation = runScheduler(input.ingress, false);

  if (
    control.output !== expectedOutput
    || control.consumerDigest !== ingressDigest
    || observation.consumerDigest !== ingressDigest
    || observation.consumedBytes !== ingressByteLength
  ) {
    throw new Error('NO_RENDER fixture did not preserve terminal ingress bytes');
  }

  return {
    mode: {
      id: 'NO_RENDER',
      disabledLayers: ['terminal-renderer'],
      replacedLayers: ['terminal-write-consumer->benchmark-accounting-sink'],
      retainedLayers: ['utf8-ingress', 'terminal-output-scheduler', 'queue-accounting'],
      controlComparator: 'CONTROL_RENDER',
      fixture: 'injected-terminal-write-consumer-v1',
    },
    ingressDigest,
    control: {
      ingressDigest: control.consumerDigest,
      rendererWriteCount: control.rendererWriteCount,
      writeConsumerInvocationCount: control.consumerInvocationCount,
      output: control.output,
    },
    observation: {
      ingressDigest: observation.consumerDigest,
      rendererWriteCount: observation.rendererWriteCount,
      accountingConsumerInvocationCount: observation.consumerInvocationCount,
      consumedBytes: observation.consumedBytes,
    },
    instrumentation: {
      control: control.instrumentation,
      observation: observation.instrumentation,
    },
  };
}

export async function runPairedTerminalOutputSchedulerBenchmark(
  input: TerminalOutputSchedulerPairedBenchmarkInput,
): Promise<TerminalOutputSchedulerPairedBenchmarkResult> {
  validateBenchmarkInput(input);
  const frozenBaseline = await loadFrozenBaselineRuntime();
  const workload = [...input.mixedIngress, ...input.boundaryIngress];
  const workloadDigest = digestIngress(workload) as `sha256:${string}`;
  const workloadBytesPerOperation = workload.reduce(
    (total, chunk) => total + Buffer.byteLength(chunk, 'utf8'),
    0,
  );
  const mixedFixture = await runNoRenderFixture({ ingress: input.mixedIngress });
  const boundaryFixture = await runNoRenderFixture({ ingress: input.boundaryIngress });
  const baselineExact = runFrozenBaselineScheduler(frozenBaseline, workload, true);
  const candidateExact = runScheduler(workload, false);
  const calibration = calibrateBaseline(
    frozenBaseline,
    workload,
    workloadDigest,
    workloadBytesPerOperation,
    input.manifest.trialDurationMs,
  );
  const runId = [
    'terminal-output-scheduler',
    process.pid,
    input.manifest.randomSeed,
    calibration.operationsPerTrial,
  ].join('-');
  const cpuList = cpus();
  const hardware = {
    architecture: arch(),
    cpuModel: cpuList[0]?.model || 'unknown-cpu',
    logicalCores: Math.max(1, cpuList.length),
  };
  const rawSamples: TerminalOutputSchedulerPairedRawSample[] = [];
  const pairCount = input.manifest.warmupIterations + input.manifest.trialCount;

  for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
    const baselineFirst = (pairIndex + input.manifest.randomSeed) % 2 === 0;
    let baselineTiming: TimedVariant;
    let candidateTiming: TimedVariant;
    if (baselineFirst) {
      baselineTiming = timeVariant(
        'baseline',
        frozenBaseline,
        workload,
        calibration.operationsPerTrial,
        workloadDigest,
        workloadBytesPerOperation,
      );
      candidateTiming = timeVariant(
        'candidate',
        frozenBaseline,
        workload,
        calibration.operationsPerTrial,
        workloadDigest,
        workloadBytesPerOperation,
      );
    } else {
      candidateTiming = timeVariant(
        'candidate',
        frozenBaseline,
        workload,
        calibration.operationsPerTrial,
        workloadDigest,
        workloadBytesPerOperation,
      );
      baselineTiming = timeVariant(
        'baseline',
        frozenBaseline,
        workload,
        calibration.operationsPerTrial,
        workloadDigest,
        workloadBytesPerOperation,
      );
    }
    const baseline = measureVariant(
      'baseline',
      frozenBaseline,
      workload,
      calibration.operationsPerTrial,
      workloadDigest,
      workloadBytesPerOperation,
      pairIndex,
      baselineTiming,
    );
    const candidate = measureVariant(
      'candidate',
      frozenBaseline,
      workload,
      calibration.operationsPerTrial,
      workloadDigest,
      workloadBytesPerOperation,
      pairIndex,
      candidateTiming,
    );

    rawSamples.push({
      runId,
      pairIndex,
      phase: pairIndex < input.manifest.warmupIterations ? 'warmup' : 'measurement',
      randomSeed: input.manifest.randomSeed,
      calibrationTargetDurationMs: input.manifest.trialDurationMs,
      baselineElapsedMs: baseline.elapsedMs,
      candidateElapsedMs: candidate.elapsedMs,
      baselineOperations: baseline.operations,
      candidateOperations: candidate.operations,
      baselineImplementationId: WAVE1_BASELINE_IMPLEMENTATION.implementationId,
      baselineSourceDigest: WAVE1_BASELINE_IMPLEMENTATION.sourceDigest,
      baselineExecutableDigest: frozenBaseline.executableDigest,
      candidateImplementationId: SEGMENTED_CANDIDATE_IMPLEMENTATION.implementationId,
      candidateSourceDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
      candidateExecutableDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
      timingMode: 'native-encoder-no-probe',
      timingOrder: baselineFirst ? 'baseline-first' : 'candidate-first',
      baselineTimedOutputDigestParity: baseline.timedOutputDigestParity,
      candidateTimedOutputDigestParity: candidate.timedOutputDigestParity,
      baselineInstrumentation: baseline.instrumentation,
      candidateInstrumentation: candidate.instrumentation,
      process: {
        pid: process.pid,
        nodeVersion: process.version,
      },
      hardware,
    });
  }

  const measurements = rawSamples.filter(sample => sample.phase === 'measurement');
  const baselineP95Ms = percentile95(measurements.map(sample => sample.baselineElapsedMs));
  const candidateP95Ms = percentile95(measurements.map(sample => sample.candidateElapsedMs));
  const pairedP95UpperDeltaMs = pairedBootstrapP95UpperDelta(
    measurements,
    input.manifest.bootstrapIterations,
    input.manifest.randomSeed,
  );
  const toleranceMs = baselineP95Ms * input.manifest.regressionToleranceRatio;

  return {
    manifest: { ...input.manifest },
    provenance: {
      runId,
      baseline: { ...WAVE1_BASELINE_IMPLEMENTATION },
      candidate: { ...SEGMENTED_CANDIDATE_IMPLEMENTATION },
      calibration: {
        implementationId: WAVE1_BASELINE_IMPLEMENTATION.implementationId,
        targetDurationMs: input.manifest.trialDurationMs,
        elapsedMs: calibration.elapsedMs,
        operationsPerTrial: calibration.operationsPerTrial,
      },
      execution: {
        baseline: {
          loader: 'git-show-typescript-data-url',
          derivedFromSourceDigest: WAVE1_BASELINE_IMPLEMENTATION.sourceDigest,
          executableDigest: frozenBaseline.executableDigest,
          timingModule: 'native-text-encoder',
          instrumentationModule: 'probed-text-encoder',
        },
        candidate: {
          loader: 'node-strip-types-module-import',
          derivedFromSourceDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
          executableDigest: SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
          timingModule: 'production-default-text-encoder',
          instrumentationModule: 'injected-probed-text-encoder',
        },
      },
    },
    exactGates: {
      outputDigestParity: mixedFixture.ingressDigest === mixedFixture.control.ingressDigest
        && mixedFixture.ingressDigest === mixedFixture.observation.ingressDigest
        && boundaryFixture.ingressDigest === boundaryFixture.control.ingressDigest
        && boundaryFixture.ingressDigest === boundaryFixture.observation.ingressDigest
        && baselineExact.consumerDigest === workloadDigest
        && candidateExact.consumerDigest === workloadDigest,
      mixedByteLength: mixedFixture.observation.consumedBytes,
      mixedControlInvocations: mixedFixture.control.writeConsumerInvocationCount,
      mixedObservationInvocations: mixedFixture.observation.accountingConsumerInvocationCount,
      boundaryByteLength: boundaryFixture.observation.consumedBytes,
      boundaryControlInvocations: boundaryFixture.control.writeConsumerInvocationCount,
      boundaryObservationInvocations: boundaryFixture.observation.accountingConsumerInvocationCount,
      baselineAcceptedIngressCount: baselineExact.instrumentation.acceptedIngressCount,
      baselineEncoderResultAllocationCount:
        baselineExact.instrumentation.encoderResultAllocationCount,
      baselinePrefixLoopEncodeCount: baselineExact.instrumentation.prefixLoopEncodeCallCount,
      baselinePrefixTemporaryAllocationCount:
        baselineExact.instrumentation.prefixTemporaryAllocationCount,
      candidateAcceptedIngressCount: candidateExact.instrumentation.acceptedIngressCount,
      candidateEncoderResultAllocationCount:
        candidateExact.instrumentation.encoderResultAllocationCount,
      candidateAcceptedIngressMaxEncodeCount:
        candidateExact.instrumentation.maxEncodeCallsPerAcceptedIngress,
      candidatePrefixLoopEncodeCount: candidateExact.instrumentation.prefixLoopEncodeCallCount,
      candidatePrefixTemporaryAllocationCount:
        candidateExact.instrumentation.prefixTemporaryAllocationCount,
    },
    rawSamples,
    summary: {
      baselineP95Ms,
      candidateP95Ms,
      pairedP95UpperDeltaMs,
      toleranceMs,
      toleranceRatio: input.manifest.regressionToleranceRatio,
      toleranceClassification: input.manifest.toleranceClassification,
      productSlo: input.manifest.productSlo,
      passes: pairedP95UpperDeltaMs <= toleranceMs,
      bootstrap: {
        method: 'paired-bootstrap-p95-delta',
        confidenceLevel: input.manifest.confidenceLevel,
        iterations: input.manifest.bootstrapIterations,
        randomSeed: input.manifest.randomSeed,
      },
    },
  };
}

function runScheduler(
  ingress: string[],
  rendererEnabled: boolean,
  instrumentationEnabled = true,
): SchedulerRunResult {
  const output: string[] = [];
  let rendererWriteCount = 0;
  let consumerInvocationCount = 0;
  let consumedBytes = 0;
  const consumerHash = createHash('sha256');
  const scheduled: Array<() => void> = [];
  const nativeEncoder = new TextEncoder();
  const encodeCallsByIngress = ingress.map(() => 0);
  let activeIngressIndex = -1;
  let encodeCallCount = 0;
  let encoderResultAllocationCount = 0;
  let ingressEncodeCallCount = 0;
  let prefixLoopEncodeCallCount = 0;
  let prefixTemporaryAllocationCount = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 4 * 1024 * 1024,
    visibleOutputMaxChunks: Math.max(16, ingress.length + 1),
    visibleFlushBudgetBytes: 64 * 1024,
    visibleFlushFrameBudgetMs: 7,
    ...(instrumentationEnabled
      ? {
          textEncoder: {
            encode(value = '') {
              encodeCallCount += 1;
              const encoded = nativeEncoder.encode(value);
              encoderResultAllocationCount += 1;
              if (activeIngressIndex >= 0 && value === ingress[activeIngressIndex]) {
                encodeCallsByIngress[activeIngressIndex] += 1;
                ingressEncodeCallCount += 1;
              } else {
                prefixLoopEncodeCallCount += 1;
                prefixTemporaryAllocationCount += 1;
              }
              return encoded;
            },
          },
        }
      : {}),
    write: (data, onWritten) => {
      const encoded = typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : Buffer.from(data);
      consumerInvocationCount += 1;
      consumedBytes += encoded.length;
      consumerHash.update(encoded);
      if (rendererEnabled) {
        output.push(encoded.toString('utf8'));
        rendererWriteCount += 1;
      }
      onWritten();
    },
    schedule: drain => scheduled.push(drain),
    shouldYield: () => false,
    now: () => 0,
  });

  for (let index = 0; index < ingress.length; index += 1) {
    activeIngressIndex = index;
    const decision = scheduler.enqueue(ingress[index]);
    activeIngressIndex = -1;
    if (!decision.ok) {
      throw new Error(`NO_RENDER fixture overflowed by ${decision.droppedBytes} bytes`);
    }
  }
  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }
  if (!scheduler.isIdle()) {
    throw new Error('NO_RENDER fixture scheduler did not reach idle');
  }
  return {
    rendererWriteCount,
    consumerInvocationCount,
    output: output.join(''),
    consumedBytes,
    consumerDigest: `sha256:${consumerHash.digest('hex')}`,
    instrumentation: {
      acceptedIngressCount: ingress.length,
      encodeCallCount,
      encoderResultAllocationCount,
      ingressEncodeCallCount,
      maxEncodeCallsPerAcceptedIngress: Math.max(0, ...encodeCallsByIngress),
      prefixLoopEncodeCallCount,
      prefixTemporaryAllocationCount,
    },
  };
}

class FrozenBaselineInstrumentedTextEncoder {
  readonly encoding = 'utf-8';
  private readonly nativeEncoder = new NativeTextEncoder();

  encode(value = ''): Uint8Array {
    const encoded = this.nativeEncoder.encode(value);
    const probe = activeFrozenBaselineEncoderProbe;
    if (probe) {
      probe.encodeCallCount += 1;
      probe.encoderResultAllocationCount += 1;
      if (probe.activeIngressIndex >= 0) {
        probe.ingressEncodeCallCount += 1;
        probe.encodeCallsByIngress[probe.activeIngressIndex] += 1;
      } else {
        probe.prefixLoopEncodeCallCount += 1;
        probe.prefixTemporaryAllocationCount += 1;
      }
    }
    return encoded;
  }

  encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
    return this.nativeEncoder.encodeInto(source, destination);
  }
}

async function loadFrozenBaselineRuntime(): Promise<FrozenBaselineRuntime> {
  frozenBaselineRuntimePromise ??= (async () => {
    const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const source = execFileSync(
      'git',
      [
        'show',
        `${WAVE1_BASELINE_IMPLEMENTATION.sourceRevision}:${WAVE1_BASELINE_IMPLEMENTATION.sourcePath}`,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    ).replace(/\r\n/g, '\n');
    const sourceDigest = `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
    if (sourceDigest !== WAVE1_BASELINE_IMPLEMENTATION.sourceDigest) {
      throw new Error(`Frozen Wave-1 source digest mismatch: ${sourceDigest}`);
    }
    const executableSource = transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    }).outputText;
    const executableDigest = `sha256:${createHash('sha256')
      .update(executableSource, 'utf8')
      .digest('hex')}` as `sha256:${string}`;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(executableSource, 'utf8').toString('base64')}`;
    const timingModule = await import(`${dataUrl}#timing`) as {
      createTerminalOutputScheduler?: FrozenBaselineFactory;
    };
    if (typeof timingModule.createTerminalOutputScheduler !== 'function') {
      throw new TypeError('Frozen Wave-1 timing module has no scheduler factory');
    }
    const originalTextEncoder = globalThis.TextEncoder;
    globalThis.TextEncoder = FrozenBaselineInstrumentedTextEncoder as typeof TextEncoder;
    try {
      const instrumentationModule = await import(`${dataUrl}#instrumentation`) as {
        createTerminalOutputScheduler?: FrozenBaselineFactory;
      };
      if (typeof instrumentationModule.createTerminalOutputScheduler !== 'function') {
        throw new TypeError('Frozen Wave-1 instrumentation module has no scheduler factory');
      }
      return {
        timingFactory: timingModule.createTerminalOutputScheduler,
        instrumentationFactory: instrumentationModule.createTerminalOutputScheduler,
        executableDigest,
      };
    } finally {
      globalThis.TextEncoder = originalTextEncoder;
    }
  })();
  return frozenBaselineRuntimePromise;
}

function runFrozenBaselineScheduler(
  runtime: FrozenBaselineRuntime,
  ingress: string[],
  instrumentationEnabled: boolean,
): SchedulerRunResult {
  const consumerHash = createHash('sha256');
  const scheduled: Array<() => void> = [];
  let consumerInvocationCount = 0;
  let consumedBytes = 0;
  const probe: FrozenBaselineEncoderProbe = {
    acceptedIngressCount: ingress.length,
    encodeCallCount: 0,
    encoderResultAllocationCount: 0,
    ingressEncodeCallCount: 0,
    maxEncodeCallsPerAcceptedIngress: 0,
    prefixLoopEncodeCallCount: 0,
    prefixTemporaryAllocationCount: 0,
    activeIngressIndex: -1,
    encodeCallsByIngress: ingress.map(() => 0),
  };
  activeFrozenBaselineEncoderProbe = instrumentationEnabled ? probe : null;
  try {
    const schedulerFactory = instrumentationEnabled
      ? runtime.instrumentationFactory
      : runtime.timingFactory;
    const scheduler = schedulerFactory({
      visibleOutputQueueMaxBytes: 4 * 1024 * 1024,
      visibleOutputMaxChunks: Math.max(16, ingress.length + 1),
      visibleFlushBudgetBytes: 64 * 1024,
      visibleFlushFrameBudgetMs: 7,
      write: (data, onWritten) => {
        const encoded = Buffer.from(data, 'utf8');
        consumerHash.update(encoded);
        consumerInvocationCount += 1;
        consumedBytes += encoded.length;
        onWritten();
      },
      schedule: drain => scheduled.push(drain),
      shouldYield: () => false,
      now: () => 0,
    });
    for (let index = 0; index < ingress.length; index += 1) {
      probe.activeIngressIndex = index;
      const decision = scheduler.enqueue(ingress[index]);
      probe.activeIngressIndex = -1;
      if (!decision.ok) {
        throw new Error(`Frozen Wave-1 fixture overflowed by ${decision.droppedBytes ?? 0} bytes`);
      }
    }
    while (scheduled.length > 0) {
      scheduled.shift()?.();
    }
    if (!scheduler.isIdle()) {
      throw new Error('Frozen Wave-1 scheduler did not reach idle');
    }
  } finally {
    probe.activeIngressIndex = -1;
    activeFrozenBaselineEncoderProbe = null;
  }
  probe.maxEncodeCallsPerAcceptedIngress = Math.max(0, ...probe.encodeCallsByIngress);

  return {
    rendererWriteCount: 0,
    consumerInvocationCount,
    output: '',
    consumedBytes,
    consumerDigest: `sha256:${consumerHash.digest('hex')}`,
    instrumentation: probe,
  };
}

function calibrateBaseline(
  frozenBaseline: FrozenBaselineRuntime,
  workload: string[],
  workloadDigest: `sha256:${string}`,
  workloadBytesPerOperation: number,
  targetDurationMs: number,
): { elapsedMs: number; operationsPerTrial: number } {
  let operationsPerTrial = 1;
  for (;;) {
    const measurement = timeVariant(
      'baseline',
      frozenBaseline,
      workload,
      operationsPerTrial,
      workloadDigest,
      workloadBytesPerOperation,
    );
    if (measurement.elapsedMs >= targetDurationMs) {
      return {
        elapsedMs: measurement.elapsedMs,
        operationsPerTrial,
      };
    }
    const scale = measurement.elapsedMs > 0
      ? Math.ceil((targetDurationMs / measurement.elapsedMs) * operationsPerTrial * 1.05)
      : operationsPerTrial * 2;
    operationsPerTrial = Math.max(operationsPerTrial + 1, scale);
    if (!Number.isSafeInteger(operationsPerTrial) || operationsPerTrial > 1_000_000) {
      throw new RangeError('Wave-1 baseline calibration exceeded the safe operation bound');
    }
  }
}

function measureVariant(
  variant: 'baseline' | 'candidate',
  frozenBaseline: FrozenBaselineRuntime,
  workload: string[],
  operations: number,
  workloadDigest: `sha256:${string}`,
  workloadBytesPerOperation: number,
  pairIndex: number,
  timing: TimedVariant,
): MeasuredVariant {
  const implementation = variant === 'baseline'
    ? WAVE1_BASELINE_IMPLEMENTATION
    : SEGMENTED_CANDIDATE_IMPLEMENTATION;
  const aggregate: TerminalSchedulerInstrumentation = {
    acceptedIngressCount: 0,
    encodeCallCount: 0,
    encoderResultAllocationCount: 0,
    ingressEncodeCallCount: 0,
    maxEncodeCallsPerAcceptedIngress: 0,
    prefixLoopEncodeCallCount: 0,
    prefixTemporaryAllocationCount: 0,
  };
  let instrumentationOutputDigestParity = true;
  for (let operation = 0; operation < operations; operation += 1) {
    const result = variant === 'baseline'
      ? runFrozenBaselineScheduler(frozenBaseline, workload, true)
      : runScheduler(workload, false, true);
    instrumentationOutputDigestParity &&= result.consumerDigest === workloadDigest
      && result.consumedBytes === workloadBytesPerOperation;
    aggregate.acceptedIngressCount += result.instrumentation.acceptedIngressCount;
    aggregate.encodeCallCount += result.instrumentation.encodeCallCount;
    aggregate.encoderResultAllocationCount +=
      result.instrumentation.encoderResultAllocationCount;
    aggregate.ingressEncodeCallCount += result.instrumentation.ingressEncodeCallCount;
    aggregate.maxEncodeCallsPerAcceptedIngress = Math.max(
      aggregate.maxEncodeCallsPerAcceptedIngress,
      result.instrumentation.maxEncodeCallsPerAcceptedIngress,
    );
    aggregate.prefixLoopEncodeCallCount +=
      result.instrumentation.prefixLoopEncodeCallCount;
    aggregate.prefixTemporaryAllocationCount +=
      result.instrumentation.prefixTemporaryAllocationCount;
  }
  return {
    elapsedMs: timing.elapsedMs,
    operations,
    timedOutputDigestParity: timing.outputDigestParity,
    instrumentation: {
      implementationId: implementation.implementationId,
      sourceDigest: implementation.sourceDigest,
      executableDigest: variant === 'baseline'
        ? frozenBaseline.executableDigest
        : SEGMENTED_CANDIDATE_IMPLEMENTATION.sourceDigest,
      workloadDigest,
      workloadBytesPerOperation,
      outputDigestParity: instrumentationOutputDigestParity,
      acceptedIngressCount: aggregate.acceptedIngressCount,
      encoderResultAllocationCount: aggregate.encoderResultAllocationCount,
      maxEncodeCallsPerAcceptedIngress: aggregate.maxEncodeCallsPerAcceptedIngress,
      prefixLoopEncodeCallCount: aggregate.prefixLoopEncodeCallCount,
      prefixTemporaryAllocationCount: aggregate.prefixTemporaryAllocationCount,
      collectionMode: 'untimed-companion-counter-pass',
      linkedPairIndex: pairIndex,
      operations,
    },
  };
}

function timeVariant(
  variant: 'baseline' | 'candidate',
  frozenBaseline: FrozenBaselineRuntime,
  workload: string[],
  operations: number,
  workloadDigest: `sha256:${string}`,
  workloadBytesPerOperation: number,
): TimedVariant {
  let outputDigestParity = true;
  const startedAt = performance.now();
  for (let operation = 0; operation < operations; operation += 1) {
    const result = variant === 'baseline'
      ? runFrozenBaselineScheduler(frozenBaseline, workload, false)
      : runScheduler(workload, false, false);
    outputDigestParity &&= result.consumerDigest === workloadDigest
      && result.consumedBytes === workloadBytesPerOperation;
  }
  return {
    elapsedMs: performance.now() - startedAt,
    outputDigestParity,
  };
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    throw new RangeError('p95 requires at least one measurement');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pairedBootstrapP95UpperDelta(
  samples: TerminalOutputSchedulerPairedRawSample[],
  iterations: number,
  randomSeed: number,
): number {
  if (samples.length === 0) {
    throw new RangeError('paired bootstrap requires measurement pairs');
  }
  const random = createSeededRandom(randomSeed);
  const deltas: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const baseline: number[] = [];
    const candidate: number[] = [];
    for (let pair = 0; pair < samples.length; pair += 1) {
      const sampled = samples[Math.floor(random() * samples.length)];
      baseline.push(sampled.baselineElapsedMs);
      candidate.push(sampled.candidateElapsedMs);
    }
    deltas.push(percentile95(candidate) - percentile95(baseline));
  }
  return percentile95(deltas);
}

function validateBenchmarkInput(input: TerminalOutputSchedulerPairedBenchmarkInput): void {
  if (!input || !Array.isArray(input.mixedIngress) || !Array.isArray(input.boundaryIngress)) {
    throw new TypeError('paired benchmark requires mixed and boundary ingress arrays');
  }
  if (
    input.mixedIngress.length === 0
    || input.boundaryIngress.length === 0
    || [...input.mixedIngress, ...input.boundaryIngress].some(chunk => typeof chunk !== 'string')
  ) {
    throw new RangeError('paired benchmark ingress corpora must contain strings');
  }
  const { manifest } = input;
  if (
    !manifest
    || !Number.isInteger(manifest.randomSeed)
    || !Number.isInteger(manifest.warmupIterations)
    || manifest.warmupIterations < 0
    || !Number.isInteger(manifest.trialCount)
    || manifest.trialCount <= 0
    || !Number.isFinite(manifest.trialDurationMs)
    || manifest.trialDurationMs <= 0
    || !Number.isInteger(manifest.bootstrapIterations)
    || manifest.bootstrapIterations <= 0
    || manifest.confidenceLevel !== 0.95
    || manifest.regressionToleranceRatio !== 0.05
    || manifest.toleranceClassification !== 'measurement-noise-regression-tolerance'
    || manifest.productSlo !== false
  ) {
    throw new RangeError('paired benchmark manifest violates the Wave-1 regression contract');
  }
}

function digestIngress(ingress: string[]): string {
  const digest = createHash('sha256');
  for (const chunk of ingress) {
    digest.update(Buffer.from(chunk, 'utf8'));
  }
  return `sha256:${digest.digest('hex')}`;
}

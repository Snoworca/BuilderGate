import { createHash } from 'node:crypto';
import {
  runNoRenderFixture,
  type TerminalOutputSchedulerBenchmarkImplementation,
  type TerminalOutputSchedulerBenchmarkManifest,
} from './terminalNoRenderFixture.ts';

export const WAVE1_SCHEDULER_BENCHMARK_MANIFEST: TerminalOutputSchedulerBenchmarkManifest = Object.freeze({
  randomSeed: 7008,
  warmupIterations: 1,
  trialCount: 3,
  trialDurationMs: 250,
  bootstrapIterations: 512,
  confidenceLevel: 0.95,
  regressionToleranceRatio: 0.05,
  toleranceClassification: 'measurement-noise-regression-tolerance',
  productSlo: false,
});

export const WAVE1_BASELINE_IMPLEMENTATION: TerminalOutputSchedulerBenchmarkImplementation = Object.freeze({
  role: 'baseline',
  implementationId: 'wave1-string-scheduler-reference-v1',
  sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
  sourceRevision: 'ca111fef3b5a5a25d3aa488415c929e90ade46fd',
  sourceDigest: 'sha256:dc1edf2acaf16f57b6e517fb1499cd67e579508d12238b3a561aaada647ac1c3',
  frozen: true,
});

export const SEGMENTED_CANDIDATE_IMPLEMENTATION: TerminalOutputSchedulerBenchmarkImplementation = Object.freeze({
  role: 'candidate',
  implementationId: 'wave2-integrated-segmented-byte-deque-v2',
  sourcePath: 'frontend/src/utils/terminalOutputScheduler.ts',
  sourceRevision: 'S4-C4@dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9-worktree',
  sourceDigest: 'sha256:a1e88cf04e689f38c1a734b9795a93fafae8dbb71299c583f4398e4762fcb3e6',
  frozen: true,
});

export const WAVE1_MIXED_CORPUS = Object.freeze({
  byteLength: 110,
  digest: 'sha256:ac7ded97bf86b799f8668a5e205c8202647012dbe237934232f658c44bf6f7ec',
  controlInvocations: 1,
  observationInvocations: 1,
});

export const WAVE1_BOUNDARY_CORPUS = Object.freeze({
  byteLength: 65_542,
  digest: 'sha256:82c494b45874f6fab554bd63d898daffcafe3529d5bfe8303c4225cbe2f9b187',
  controlInvocations: 2,
  observationInvocations: 2,
});

export const WAVE1_PAIRED_WORKLOAD = Object.freeze({
  byteLengthPerOperation: 65_652,
  digest: 'sha256:efba03d68d63c7f0c9701ef365eec7ec07417d9b1b4b6776ed1f94744be8439b',
});

export function createWave1MixedCorpus(): string[] {
  const seed = WAVE1_SCHEDULER_BENCHMARK_MANIFEST.randomSeed;
  return [[
    `seed=${seed}\r\n`,
    '\u001b]0;BuilderGate benchmark\u0007',
    '\u001b[31mred\u001b[0m ',
    'ASCII CJK=한글 wide=界 combining=e\u0301 emoji=🙂\r\n',
    'prompt> ',
  ].join('')];
}

export function createWave1BoundaryCorpus(): string[] {
  return [`${'a'.repeat(64 * 1024 - 1)}한🙂`];
}

export interface TerminalNoRenderFixtureEvidence {
  schemaVersion: 1;
  artifactType: 'terminal-no-render-fixture-evidence';
  fixtureExecutionId: string;
  source: 'frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts';
  mode: Awaited<ReturnType<typeof runNoRenderFixture>>['mode'];
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

/** @req PERF-BGSTAB-008 */
export async function createTerminalNoRenderFixtureEvidence(
  ingress: string[],
): Promise<TerminalNoRenderFixtureEvidence> {
  const result = await runNoRenderFixture({ ingress });
  const evidenceWithoutDigest = {
    schemaVersion: 1 as const,
    artifactType: 'terminal-no-render-fixture-evidence' as const,
    fixtureExecutionId: `no-render-${result.ingressDigest.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    source: 'frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts' as const,
    mode: result.mode,
    ingressDigest: result.ingressDigest,
    control: {
      ingressDigest: result.control.ingressDigest,
      rendererWriteCount: result.control.rendererWriteCount,
      writeConsumerInvocationCount: result.control.writeConsumerInvocationCount,
    },
    observation: {
      ingressDigest: result.observation.ingressDigest,
      rendererWriteCount: result.observation.rendererWriteCount,
      accountingConsumerInvocationCount: result.observation.accountingConsumerInvocationCount,
      consumedBytes: result.observation.consumedBytes,
    },
  };
  return {
    ...evidenceWithoutDigest,
    contentDigest: digestCanonical(evidenceWithoutDigest),
  };
}

function digestCanonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(sortJsonValue(value)), 'utf8').digest('hex')}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}

const stdinBase64Index = process.argv.indexOf('--stdin-base64');
if (stdinBase64Index >= 0) {
  const encoded = process.argv[stdinBase64Index + 1];
  if (!encoded) {
    throw new Error('--stdin-base64 requires one base64-encoded UTF-8 payload');
  }
  const payload = Buffer.from(encoded, 'base64').toString('utf8');
  const evidence = await createTerminalNoRenderFixtureEvidence([payload]);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

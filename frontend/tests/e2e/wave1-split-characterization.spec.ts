import { expect, test, type WebSocket as PlaywrightWebSocket } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { login } from './helpers';
import * as characterizationArtifacts from './wave1-characterization-artifacts';
import type { WsTransportMode } from '../../src/types/ws-protocol';

const VERIFICATION_COMMAND =
  'npx playwright test tests/e2e/wave1-split-characterization.spec.ts --project "Desktop Chrome"';
const SERVER_BUILD_COMMAND = 'npm run build';
const SPLIT_HANDSHAKE_COMMAND =
  'node --test --test-reporter=tap dist/ws/WsRouterSplitHandshake.test.js';
const TRANSPORT_MODE_COMMAND =
  'node --test --test-reporter=tap dist/ws/wsTransportMode.test.js';

type BrowserSocketTransportMode = Extract<WsTransportMode, 'unified' | 'split'>;

interface ProductionPathEvidence {
  browserLocation: string;
  browserSocketUrl: string;
  actualUpgradePath?: string;
  runtimeConfigWsTransportMode: WsTransportMode;
  browserSocketTransportMode: BrowserSocketTransportMode;
  serverConstructionSource: string;
  browserUrlSource: string;
  authenticatedRouterDispatchObserved: boolean;
}

interface SplitCharacterizationCompletionCandidate {
  observations: characterizationArtifacts.SplitObservation[];
  productionPathEvidence?: ProductionPathEvidence;
}

type AssertSplitCharacterizationCompletion = (
  candidate: SplitCharacterizationCompletionCandidate,
) => void;

interface CapturedProductionSocket {
  url: string;
  connectedClientId: string | null;
  pongCount: number;
  /** `06 §S3` — frames this capture could not read. Must stay 0. */
  undecodableFrames: number;
}

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL('../../../server/', import.meta.url));
const ARTIFACT_PATH = fileURLToPath(
  new URL(
    '../../../docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/split-characterization.json',
    import.meta.url,
  ),
);
const execFileAsync = promisify(execFile);

interface FocusedTestResult {
  exitCode: number;
  tests: number;
  passed: number;
  failed: number;
}

interface SplitCharacterizationPayload {
  schemaVersion: '1.0.0';
  requirementId: 'REL-BGSTAB-006';
  gitCommit: string;
  workingTreeDirty: boolean;
  disposition: 'unresolved';
  splitActivationEnabled: false;
  mutatesExistingSrs: false;
  observations: characterizationArtifacts.SplitObservation[];
  mismatches: characterizationArtifacts.MismatchRow[];
  verdictSummary: characterizationArtifacts.MismatchVerdictSummary;
}

interface SplitCharacterizationArtifact extends SplitCharacterizationPayload {
  digestAlgorithm: 'sha256';
  contentDigest: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Canonical payload must be JSON-serializable');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => (
    `${JSON.stringify(key)}:${canonicalize(item)}`
  )).join(',')}}`;
}

function computePayloadDigest(payload: SplitCharacterizationPayload): string {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

function readNodeTestCount(output: string, label: string): number {
  const match = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => line.match(new RegExp(`^# ${label}\\s+(\\d+)$`, 'u')))
    .find((candidate) => candidate !== null);
  if (!match) {
    throw new Error(`Focused node test output is missing ${label} count`);
  }
  return Number(match[1]);
}

function runFocusedNodeTest(filePath: string): Promise<FocusedTestResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--test', '--test-reporter=tap', filePath],
      {
        cwd: SERVER_ROOT,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        const output = `${String(stdout)}\n${String(stderr)}`;
        try {
          resolve({
            exitCode: typeof error?.code === 'number' ? error.code : 0,
            tests: readNodeTestCount(output, 'tests'),
            passed: readNodeTestCount(output, 'pass'),
            failed: readNodeTestCount(output, 'fail'),
          });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

async function runStandaloneComparators(): Promise<{
  buildExitCode: 0;
  splitHandshake: FocusedTestResult;
  transportMode: FocusedTestResult;
  authoritativeRunnerIncludesSplitHandshake: boolean;
  authoritativeRunnerIncludesTransportMode: boolean;
}> {
  const npmExecPath = process.env.npm_execpath;
  if (process.platform === 'win32' && !npmExecPath) {
    throw new Error('npm_execpath is required for the Windows server build');
  }
  const npmExecutable = process.platform === 'win32' ? process.execPath : 'npm';
  const npmArguments = process.platform === 'win32'
    ? [npmExecPath!, 'run', 'build']
    : ['run', 'build'];
  await execFileAsync(npmExecutable, npmArguments, {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const [splitHandshake, transportMode, authoritativeRunnerSource] =
    await Promise.all([
      runFocusedNodeTest('dist/ws/WsRouterSplitHandshake.test.js'),
      runFocusedNodeTest('dist/ws/wsTransportMode.test.js'),
      readFile(`${SERVER_ROOT}/src/test-runner.ts`, 'utf8'),
    ]);
  return {
    buildExitCode: 0,
    splitHandshake,
    transportMode,
    authoritativeRunnerIncludesSplitHandshake:
      authoritativeRunnerSource.includes('WsRouterSplitHandshake.test'),
    authoritativeRunnerIncludesTransportMode:
      authoritativeRunnerSource.includes('wsTransportMode.test'),
  };
}

async function readGitBuildIdentity(): Promise<{
  gitCommit: string;
  workingTreeDirty: boolean;
}> {
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }),
    execFileAsync('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    }),
  ]);
  const gitCommit = commitOutput.trim();
  if (!/^[0-9a-f]{40}$/u.test(gitCommit)) {
    throw new Error('Git build identity is not a full commit hash');
  }
  return {
    gitCommit,
    workingTreeDirty: statusOutput.trim().length > 0,
  };
}

async function writeCharacterizationArtifact(
  payload: SplitCharacterizationPayload,
): Promise<SplitCharacterizationArtifact> {
  const artifact: SplitCharacterizationArtifact = {
    ...payload,
    digestAlgorithm: 'sha256',
    contentDigest: computePayloadDigest(payload),
  };
  const temporaryPath = `${ARTIFACT_PATH}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, ARTIFACT_PATH);

  const persisted = JSON.parse(
    await readFile(ARTIFACT_PATH, 'utf8'),
  ) as SplitCharacterizationArtifact;
  const {
    digestAlgorithm,
    contentDigest,
    ...persistedPayload
  } = persisted;
  expect(digestAlgorithm).toBe('sha256');
  expect(contentDigest).toBe(computePayloadDigest(persistedPayload));
  expect(contentDigest).toBe(artifact.contentDigest);
  return persisted;
}

function getCompletionAssertion(
  expectedFailureSignature: string,
): AssertSplitCharacterizationCompletion {
  const candidate = (
    characterizationArtifacts as typeof characterizationArtifacts & {
      assertSplitCharacterizationCompletion?: AssertSplitCharacterizationCompletion;
    }
  ).assertSplitCharacterizationCompletion;

  if (typeof candidate !== 'function') {
    throw new Error(expectedFailureSignature);
  }
  return candidate;
}

function isProductionSocket(socketUrl: string): boolean {
  const parsed = new URL(socketUrl);
  return parsed.protocol === 'wss:' && parsed.host === 'localhost:2222' && parsed.pathname === '/ws';
}

function sanitizeSocketUrl(socketUrl: string): string {
  const parsed = new URL(socketUrl);
  parsed.searchParams.delete('token');
  return parsed.toString();
}

function readBrowserSocketTransportMode(
  socketUrl: URL,
): BrowserSocketTransportMode {
  const mode = socketUrl.searchParams.get('mode');
  const channel = socketUrl.searchParams.get('channel');
  if (mode === null && channel === null) {
    return 'unified';
  }
  if (mode === 'split' && channel === 'control') {
    return 'split';
  }
  throw new Error('Production WebSocket URL has unsupported transport metadata');
}

async function readRuntimeConfigWsTransportMode(
  page: Parameters<typeof login>[0],
): Promise<WsTransportMode> {
  const value = await page.evaluate(async () => {
    const response = await fetch('/api/runtime-config', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Runtime config request failed: HTTP ${response.status}`);
    }
    const payload = await response.json() as { wsTransportMode?: unknown };
    return payload.wsTransportMode;
  });
  if (value !== 'unified' && value !== 'split-shadow' && value !== 'split') {
    throw new Error('Runtime config returned an unsupported wsTransportMode');
  }
  return value;
}

function captureCompletionFailure(
  assertCompletion: AssertSplitCharacterizationCompletion,
  candidate: SplitCharacterizationCompletionCandidate,
): string | null {
  try {
    assertCompletion(candidate);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readProductionSourceEvidence(): Promise<{
  serverConstructionSource: string;
  browserUrlSource: string;
}> {
  const serverIndexPath = fileURLToPath(
    new URL('../../../server/src/index.ts', import.meta.url),
  );
  const browserContextPath = fileURLToPath(
    new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
  );
  const [serverIndexSource, browserContextSource] = await Promise.all([
    readFile(serverIndexPath, 'utf8'),
    readFile(browserContextPath, 'utf8'),
  ]);

  expect(serverIndexSource).toContain('const wsRouter = new WsRouter(');
  expect(serverIndexSource).toContain("if (pathname === '/ws') {");
  expect(serverIndexSource).toContain('wsRouter.handleUpgrade(req, socket, head);');
  expect(browserContextSource).toContain('return `${protocol}//${host}/ws?token=');
  expect(browserContextSource).toContain('const url = getWsUrl();');
  expect(browserContextSource).toContain('const ws = new WebSocket(url);');

  return {
    serverConstructionSource: relative(PROJECT_ROOT, serverIndexPath).replaceAll('\\', '/'),
    browserUrlSource: relative(PROJECT_ROOT, browserContextPath).replaceAll('\\', '/'),
  };
}

function createStandaloneObservation(): characterizationArtifacts.SplitObservation {
  return characterizationArtifacts.createSplitObservation({
    observationKind: 'test_observed',
    buildId: 'wave1-red-contract',
    effectiveWsTransportMode: 'split',
    caseId: 'standalone-injected-split-handshake',
    sourceReference: 'server/src/ws/WsRouterSplitHandshake.test.ts:50-121',
    command: 'node --test server/src/ws/WsRouterSplitHandshake.test.ts',
    observedResult: {
      connectionPath: "wss.emit('connection', ...)",
      transportMetadataInjected: true,
    },
  });
}

test.describe('Wave 1 split characterization RED contracts', () => {
  test.describe.configure({ retries: 0 });

  test('REL-BGSTAB-006 AC-2 RED contract', async ({ page }) => {
    test.setTimeout(120_000);
    const capturedSockets: CapturedProductionSocket[] = [];

    await page.addInitScript(() => {
      const targetWindow = window as typeof window & {
        __wave1ProductionSockets?: WebSocket[];
      };
      const NativeWebSocket = WebSocket;
      targetWindow.__wave1ProductionSockets = [];

      const CapturingWebSocket = function capturingWebSocket(
        this: WebSocket,
        url: string | URL,
        protocols?: string | string[],
      ) {
        const socket = protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
        const parsed = new URL(socket.url);
        if (
          parsed.protocol === 'wss:'
          && parsed.host === 'localhost:2222'
          && parsed.pathname === '/ws'
        ) {
          targetWindow.__wave1ProductionSockets?.push(socket);
        }
        return socket;
      };
      CapturingWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(CapturingWebSocket, NativeWebSocket);
      window.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;
    });

    page.on('websocket', (socket: PlaywrightWebSocket) => {
      const captured = {
        url: socket.url(),
        connectedClientId: null,
        pongCount: 0,
        // `06 §S3` — the comment below used to say non-JSON output "is not
        // production-path evidence". That premise dies the moment the wire
        // carries frames, so the drop is counted and asserted instead.
        undecodableFrames: 0,
      };
      capturedSockets.push(captured);
      socket.on('framereceived', (frame) => {
        if (typeof frame.payload !== 'string') {
          captured.undecodableFrames += 1;
          return;
        }
        try {
          const message = JSON.parse(frame.payload) as {
            type?: unknown;
            clientId?: unknown;
          };
          if (
            message.type === 'connected'
            && typeof message.clientId === 'string'
            && message.clientId.length > 0
          ) {
            captured.connectedClientId = message.clientId;
          }
          if (message.type === 'pong') {
            captured.pongCount += 1;
          }
        } catch {
          captured.undecodableFrames += 1;
        }
      });
    });

    await login(page);

    // `06 §S3` — a frame the capture could not read is why this poll would time
    // out, so the count is named before the timeout is reported. Without this the
    // failure reads as "no production socket" and points at the wrong thing.
    try {
      await expect.poll(() => {
        return capturedSockets.some((candidate) => (
          isProductionSocket(candidate.url) && candidate.connectedClientId !== null
        ));
      }, { timeout: 15_000 }).toBe(true);
    } catch (error) {
      expect(
        capturedSockets.map(candidate => candidate.undecodableFrames),
        'a ws frame could not be read; the socket identification below is unsound',
      ).toEqual(capturedSockets.map(() => 0));
      throw error;
    }

    const pongCountsBeforeProbe = new Map(
      capturedSockets
        .filter((candidate) => (
          isProductionSocket(candidate.url) && candidate.connectedClientId !== null
        ))
        .map((candidate) => [candidate, candidate.pongCount]),
    );

    const pingedSocketUrl = await page.evaluate(() => {
      const targetWindow = window as typeof window & {
        __wave1ProductionSockets?: WebSocket[];
      };
      const socket = [...(targetWindow.__wave1ProductionSockets ?? [])]
        .reverse()
        .find((candidate) => {
          const parsed = new URL(candidate.url);
          return candidate.readyState === WebSocket.OPEN
            && parsed.protocol === 'wss:'
            && parsed.host === 'localhost:2222'
            && parsed.pathname === '/ws';
        });
      if (!socket) {
        throw new Error('No open production WebSocket available for router probe');
      }
      socket.send(JSON.stringify({ type: 'ping' }));
      return socket.url;
    });

    await expect.poll(() => {
      return capturedSockets.some((candidate) => (
        candidate.url === pingedSocketUrl
        && isProductionSocket(candidate.url)
        && candidate.connectedClientId !== null
        && pongCountsBeforeProbe.has(candidate)
        && candidate.pongCount > pongCountsBeforeProbe.get(candidate)!
      ));
    }, { timeout: 15_000 }).toBe(true);

    const browserLocation = new URL(page.url());
    expect(browserLocation.protocol).toBe('https:');
    expect(browserLocation.host).toBe('localhost:2222');

    const productionSocket = capturedSockets.find((candidate) => (
      candidate.url === pingedSocketUrl
      && isProductionSocket(candidate.url)
      && candidate.connectedClientId !== null
      && pongCountsBeforeProbe.has(candidate)
      && candidate.pongCount > pongCountsBeforeProbe.get(candidate)!
    ));
    expect(productionSocket).toBeDefined();
    // `06 §S3` — the socket above is identified by `connected` and `pong`
    // frames. A frame the capture could not read would leave those counters
    // short and pick a different socket, or none, without saying why.
    expect(
      capturedSockets.map(candidate => candidate.undecodableFrames),
      'a ws frame could not be read; the socket identification above is unsound',
    ).toEqual(capturedSockets.map(() => 0));

    const productionSocketUrl = sanitizeSocketUrl(productionSocket!.url);
    const socketUrl = new URL(productionSocketUrl);
    const runtimeConfigWsTransportMode = await readRuntimeConfigWsTransportMode(page);
    const browserSocketTransportMode = readBrowserSocketTransportMode(socketUrl);
    const sourceEvidence = await readProductionSourceEvidence();
    const productionObservation = characterizationArtifacts.createSplitObservation({
      observationKind: 'production_runtime_observed',
      buildId: 'wave1-red-contract',
      effectiveWsTransportMode: runtimeConfigWsTransportMode,
      caseId: 'production-https-ws-upgrade',
      sourceReference:
        `${sourceEvidence.serverConstructionSource}; ${sourceEvidence.browserUrlSource}`,
      command: VERIFICATION_COMMAND,
      observedResult: {
        browserLocation: browserLocation.origin,
        browserSocketUrl: productionSocketUrl,
        actualUpgradePath: socketUrl.pathname,
        runtimeConfigWsTransportMode,
        browserSocketTransportMode,
        authenticatedConnectedClientId: productionSocket!.connectedClientId,
        routerPongObservedAfterProbe: true,
      },
    });

    const evidenceWithoutActualUpgrade: ProductionPathEvidence = {
      browserLocation: browserLocation.origin,
      browserSocketUrl: productionSocketUrl,
      runtimeConfigWsTransportMode,
      browserSocketTransportMode,
      serverConstructionSource: sourceEvidence.serverConstructionSource,
      browserUrlSource: sourceEvidence.browserUrlSource,
      authenticatedRouterDispatchObserved:
        productionSocket!.connectedClientId !== null
        && productionSocket!.pongCount > pongCountsBeforeProbe.get(productionSocket!)!,
    };
    const validProductionEvidence: ProductionPathEvidence = {
      ...evidenceWithoutActualUpgrade,
      actualUpgradePath: socketUrl.pathname,
    };

    await page.goto('about:blank');

    const assertCompletion = getCompletionAssertion(
      'REL-BGSTAB-006 AC-2 contract not implemented',
    );
    const observations = [productionObservation, createStandaloneObservation()];
    expect(() => {
      assertCompletion({
        observations,
        productionPathEvidence: evidenceWithoutActualUpgrade,
      });
    }).toThrow('production actual HTTPS /ws upgrade evidence is required');
    expect(() => {
      assertCompletion({
        observations,
        productionPathEvidence: validProductionEvidence,
      });
    }).not.toThrow();

    const otherRuntimeMode: WsTransportMode =
      runtimeConfigWsTransportMode === 'unified' ? 'split' : 'unified';
    const mismatchProductionObservation = characterizationArtifacts.createSplitObservation({
      observationKind: 'production_runtime_observed',
      buildId: productionObservation.buildId,
      effectiveWsTransportMode: otherRuntimeMode,
      caseId: productionObservation.caseId,
      sourceReference: productionObservation.sourceReference,
      command: productionObservation.command,
      observedResult: {
        browserLocation: browserLocation.origin,
        browserSocketUrl: productionSocketUrl,
        actualUpgradePath: socketUrl.pathname,
        runtimeConfigWsTransportMode: otherRuntimeMode,
        browserSocketTransportMode,
        authenticatedConnectedClientId: productionSocket!.connectedClientId,
        routerPongObservedAfterProbe: true,
      },
    });
    const unrelatedStandaloneObservation = characterizationArtifacts.createSplitObservation({
      observationKind: 'test_observed',
      buildId: 'wave1-red-contract',
      effectiveWsTransportMode: runtimeConfigWsTransportMode,
      caseId: 'unrelated-test-observation',
      sourceReference: 'frontend/tests/e2e/unrelated.spec.ts',
      command: 'not-run',
      observedResult: 'irrelevant',
    });
    const expectedRepairContracts = [
      {
        signature: 'runtime config and browser wire mode must remain independent',
        actual: captureCompletionFailure(assertCompletion, {
          observations: [mismatchProductionObservation, createStandaloneObservation()],
          productionPathEvidence: {
            ...validProductionEvidence,
            runtimeConfigWsTransportMode: otherRuntimeMode,
          },
        }),
        expectFailure: false,
      },
      {
        signature: 'production runtime config mode provenance is required',
        actual: captureCompletionFailure(assertCompletion, {
          observations,
          productionPathEvidence: {
            ...validProductionEvidence,
            runtimeConfigWsTransportMode: 'unsupported' as WsTransportMode,
          },
        }),
        expectFailure: true,
      },
      {
        signature: 'standalone injected observation evidence is required',
        actual: captureCompletionFailure(assertCompletion, {
          observations: [productionObservation, unrelatedStandaloneObservation],
          productionPathEvidence: validProductionEvidence,
        }),
        expectFailure: true,
      },
    ];
    const missingRepairFailures = expectedRepairContracts
      .filter(({ signature, actual, expectFailure }) => (
        expectFailure ? !actual?.includes(signature) : actual !== null
      ))
      .map(({ signature }) => signature);
    if (missingRepairFailures.length > 0) {
      throw new Error(missingRepairFailures.join('; '));
    }

    const [buildIdentity, standaloneComparators] = await Promise.all([
      readGitBuildIdentity(),
      runStandaloneComparators(),
    ]);
    const srsSource = await readFile(
      `${PROJECT_ROOT}/docs/spec/30.buildergate-stability.srs.md`,
      'utf8',
    );
    expect(srsSource).toContain('### FR-BGSTAB-006');
    expect(srsSource).toContain('### FR-BGSTAB-007');
    expect(srsSource).toContain('### REL-BGSTAB-006');
    const buildId = `git:${buildIdentity.gitCommit}`;
    const artifactProductionObservation =
      characterizationArtifacts.createSplitObservation({
        observationKind: 'production_runtime_observed',
        buildId,
        effectiveWsTransportMode: runtimeConfigWsTransportMode,
        caseId: 'production-https-ws-upgrade',
        sourceReference:
          `${sourceEvidence.serverConstructionSource}; ${sourceEvidence.browserUrlSource}`,
        command: VERIFICATION_COMMAND,
        observedResult: {
          browserLocation: browserLocation.origin,
          browserSocketUrl: productionSocketUrl,
          actualUpgradePath: socketUrl.pathname,
          runtimeConfigWsTransportMode,
          browserSocketTransportMode,
          authenticatedConnectionObserved: true,
          routerPongObservedAfterProbe: true,
        },
      });
    const srsExpectedObservation =
      characterizationArtifacts.createSplitObservation({
        observationKind: 'srs_expected',
        buildId,
        effectiveWsTransportMode: 'split',
        caseId: 'srs-split-contract-expectation',
        sourceReference:
          'docs/spec/30.buildergate-stability.srs.md#FR-BGSTAB-006; docs/spec/30.buildergate-stability.srs.md#FR-BGSTAB-007; docs/spec/30.buildergate-stability.srs.md#REL-BGSTAB-006',
        command:
          'readFile docs/spec/30.buildergate-stability.srs.md (FR-BGSTAB-006/007, REL-BGSTAB-006)',
        observedResult: {
          expectedControlOutputSeparation: true,
          expectedTransportMode: 'split',
          disposition: 'unresolved',
        },
      });
    const standaloneTestObservation =
      characterizationArtifacts.createSplitObservation({
        observationKind: 'test_observed',
        buildId,
        effectiveWsTransportMode: 'split',
        caseId: 'standalone-injected-split-handshake',
        sourceReference:
          'server/src/ws/WsRouterSplitHandshake.test.ts; server/src/ws/wsTransportMode.test.ts; server/src/test-runner.ts',
        command:
          `${SERVER_BUILD_COMMAND}; ${SPLIT_HANDSHAKE_COMMAND}; ${TRANSPORT_MODE_COMMAND}`,
        observedResult: {
          connectionPath: "wss.emit('connection', ...)",
          transportMetadataInjected: true,
          build: {
            command: SERVER_BUILD_COMMAND,
            exitCode: standaloneComparators.buildExitCode,
          },
          splitHandshake: {
            command: SPLIT_HANDSHAKE_COMMAND,
            ...standaloneComparators.splitHandshake,
          },
          transportMode: {
            command: TRANSPORT_MODE_COMMAND,
            ...standaloneComparators.transportMode,
          },
          authoritativeRunner: {
            sourceReference: 'server/src/test-runner.ts',
            includesSplitHandshake:
              standaloneComparators.authoritativeRunnerIncludesSplitHandshake,
            includesTransportMode:
              standaloneComparators.authoritativeRunnerIncludesTransportMode,
          },
        },
      });

    for (const result of [
      standaloneComparators.splitHandshake,
      standaloneComparators.transportMode,
    ]) {
      expect(result.tests).toBeGreaterThan(0);
      expect(result.passed + result.failed).toBe(result.tests);
      expect(result.exitCode === 0).toBe(result.failed === 0);
    }

    const mismatches = [
      characterizationArtifacts.createMismatchRow({
        comparisonTarget: 'FR-BGSTAB-006',
        productionObservation: 'production-https-ws-upgrade',
        verdict: runtimeConfigWsTransportMode === 'split'
          ? 'match'
          : 'not_exercised',
        reproductionCaseId: 'srs-vs-production-runtime-mode',
        evidenceReference:
          'observations:srs-split-contract-expectation,production-https-ws-upgrade',
      }),
      characterizationArtifacts.createMismatchRow({
        comparisonTarget: 'REL-BGSTAB-006',
        productionObservation: 'production-https-ws-upgrade',
        verdict: runtimeConfigWsTransportMode === browserSocketTransportMode
          ? 'match'
          : 'mismatch',
        reproductionCaseId: 'production-config-vs-browser-wire-mode',
        evidenceReference: 'observations:production-https-ws-upgrade',
      }),
      characterizationArtifacts.createMismatchRow({
        comparisonTarget:
          'server/src/ws/WsRouterSplitHandshake.test.ts#standalone-injected-split-handshake',
        productionObservation: 'production-https-ws-upgrade',
        verdict: standaloneComparators.splitHandshake.failed === 0
          ? 'match'
          : 'mismatch',
        reproductionCaseId: 'srs-vs-standalone-split-handshake',
        evidenceReference:
          'observations:srs-split-contract-expectation,production-https-ws-upgrade,standalone-injected-split-handshake',
      }),
      characterizationArtifacts.createMismatchRow({
        comparisonTarget:
          'server/src/ws/WsRouterSplitHandshake.test.ts#standalone-injected-split-handshake',
        productionObservation: 'production-https-ws-upgrade',
        verdict: 'not_exercised',
        reproductionCaseId: 'standalone-vs-production-path-authority',
        evidenceReference:
          'observations:production-https-ws-upgrade,standalone-injected-split-handshake; server/src/ws/WsRouterSplitHandshake.test.ts; server/src/index.ts',
      }),
    ];
    const payload: SplitCharacterizationPayload = {
      schemaVersion: '1.0.0',
      requirementId: 'REL-BGSTAB-006',
      gitCommit: buildIdentity.gitCommit,
      workingTreeDirty: buildIdentity.workingTreeDirty,
      disposition: 'unresolved',
      splitActivationEnabled: false,
      mutatesExistingSrs: false,
      observations: [
        srsExpectedObservation,
        artifactProductionObservation,
        standaloneTestObservation,
      ],
      mismatches,
      verdictSummary:
        characterizationArtifacts.summarizeMismatchVerdicts(mismatches),
    };
    characterizationArtifacts.assertObservationOnlyCharacterization(payload);

    const artifact = await writeCharacterizationArtifact(payload);
    const productionCaseIds = new Set(
      artifact.observations
        .filter(({ observationKind }) => (
          observationKind === 'production_runtime_observed'
        ))
        .map(({ caseId }) => caseId),
    );
    expect(artifact.mismatches.every(({ productionObservation: caseId }) => (
      productionCaseIds.has(caseId)
    ))).toBe(true);
    expect(new Set(artifact.observations.map(({ observationKind }) => observationKind)))
      .toEqual(new Set(characterizationArtifacts.SPLIT_OBSERVATION_KINDS));
    expect(artifact.observations.every(({ buildId: actualBuildId }) => (
      actualBuildId === buildId
    ))).toBe(true);
    expect(artifact.verdictSummary)
      .toEqual(characterizationArtifacts.summarizeMismatchVerdicts(artifact.mismatches));
    expect(artifact.disposition).toBe('unresolved');

    const serializedArtifact = JSON.stringify(artifact);
    const rawConnectedClientId = productionSocket!.connectedClientId;
    expect(rawConnectedClientId).not.toBeNull();
    expect(serializedArtifact).not.toContain(rawConnectedClientId!);
    expect(serializedArtifact).not.toContain('authenticatedConnectedClientId');
    expect(serializedArtifact).not.toContain('token=');
    expect(serializedArtifact).not.toContain('1234');
    console.log(`SPLIT_CHARACTERIZATION_DIGEST=${artifact.contentDigest}`);
    console.log(
      `SPLIT_CHARACTERIZATION_VERDICTS=${JSON.stringify(artifact.verdictSummary)}`,
    );
  });

  test('REL-BGSTAB-006 AC-3 RED contract', () => {
    const assertCompletion = getCompletionAssertion(
      'REL-BGSTAB-006 AC-3 contract not implemented',
    );

    expect(() => {
      assertCompletion({ observations: [createStandaloneObservation()] });
    }).toThrow('production runtime observation and actual HTTPS /ws evidence are required');
  });
});

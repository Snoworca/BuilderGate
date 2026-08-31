import type { WsTransportMode } from '../../src/types/ws-protocol.ts';
import { buildControlWebSocketUrl } from '../../src/utils/webSocketUrl.ts';

export const SPLIT_OBSERVATION_KINDS = [
  'srs_expected',
  'production_runtime_observed',
  'test_observed',
] as const;

export type SplitObservationKind =
  (typeof SPLIT_OBSERVATION_KINDS)[number];

export interface SplitObservation {
  observationKind: SplitObservationKind;
  buildId: string;
  effectiveWsTransportMode: WsTransportMode;
  caseId: string;
  sourceReference: string;
  command: string;
  observedResult: JsonValue;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const MISMATCH_VERDICTS = [
  'match',
  'mismatch',
  'not_exercised',
] as const;

export type MismatchVerdict = (typeof MISMATCH_VERDICTS)[number];

export interface MismatchRow {
  comparisonTarget: string;
  productionObservation: string;
  verdict: MismatchVerdict;
  reproductionCaseId: string;
  evidenceReference: string;
}

export interface MismatchVerdictSummary {
  match: number;
  mismatch: number;
  not_exercised: number;
}

export interface ObservationOnlyCharacterizationGuard {
  disposition: string;
  splitActivationEnabled: boolean;
  mutatesExistingSrs: boolean;
}

export interface ProductionPathEvidence {
  browserLocation: string;
  browserSocketUrl: string;
  actualUpgradePath?: string;
  runtimeConfigWsTransportMode: WsTransportMode;
  browserSocketTransportMode: BrowserSocketTransportMode;
  serverConstructionSource: string;
  browserUrlSource: string;
  authenticatedRouterDispatchObserved: boolean;
}

export type BrowserSocketTransportMode = Extract<
  WsTransportMode,
  'unified' | 'split'
>;

export interface SplitCharacterizationCompletionCandidate {
  observations: readonly SplitObservation[];
  productionPathEvidence?: ProductionPathEvidence;
}

const OBSERVATION_STRING_FIELDS = [
  'buildId',
  'effectiveWsTransportMode',
  'caseId',
  'sourceReference',
  'command',
] as const satisfies readonly (keyof SplitObservation)[];

const MISMATCH_STRING_FIELDS = [
  'comparisonTarget',
  'productionObservation',
  'reproductionCaseId',
  'evidenceReference',
] as const satisfies readonly (keyof MismatchRow)[];

const VALID_WS_TRANSPORT_MODES: ReadonlySet<WsTransportMode> = new Set([
  'unified',
  'split-shadow',
  'split',
]);

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }
}

function cloneJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('observedResult must be JSON-serializable');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('observedResult must be JSON-serializable');
  }
  if (ancestors.has(value)) {
    throw new TypeError('observedResult must be JSON-serializable');
  }

  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('observedResult must be JSON-serializable');
    }
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError('observedResult must be JSON-serializable');
      }
      return Array.from(value, (item) => cloneJsonValue(item, ancestors));
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError('observedResult must be JSON-serializable');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneJsonValue(item, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function cloneNonEmptyResult(value: unknown): JsonValue {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  ) {
    throw new TypeError('observedResult must be non-empty');
  }
  return cloneJsonValue(value);
}

function isSplitObservationKind(
  value: unknown,
): value is SplitObservationKind {
  return (SPLIT_OBSERVATION_KINDS as readonly unknown[]).includes(value);
}

function isMismatchVerdict(value: unknown): value is MismatchVerdict {
  return (MISMATCH_VERDICTS as readonly unknown[]).includes(value);
}

function isWsTransportMode(value: unknown): value is WsTransportMode {
  return (
    typeof value === 'string' &&
    VALID_WS_TRANSPORT_MODES.has(value as WsTransportMode)
  );
}

function isBrowserSocketTransportMode(
  value: unknown,
): value is BrowserSocketTransportMode {
  return value === 'unified' || value === 'split';
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProductionUrl(value: string, field: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new TypeError(`${field} must be an absolute URL`);
  }
}

export function createSplitObservation(
  input: Record<string, unknown>,
): SplitObservation {
  if (!isSplitObservationKind(input.observationKind)) {
    throw new TypeError('unsupported observation kind');
  }

  for (const field of OBSERVATION_STRING_FIELDS) {
    assertNonEmptyString(input[field], field);
  }
  if (!isWsTransportMode(input.effectiveWsTransportMode)) {
    throw new TypeError('unsupported ws transport mode');
  }
  const observedResult = cloneNonEmptyResult(input.observedResult);

  return {
    observationKind: input.observationKind,
    buildId: input.buildId as string,
    effectiveWsTransportMode: input.effectiveWsTransportMode,
    caseId: input.caseId as string,
    sourceReference: input.sourceReference as string,
    command: input.command as string,
    observedResult,
  };
}

export function createMismatchRow(input: Record<string, unknown>): MismatchRow {
  for (const field of MISMATCH_STRING_FIELDS) {
    assertNonEmptyString(input[field], field);
  }
  if (!isMismatchVerdict(input.verdict)) {
    throw new TypeError('unsupported mismatch verdict');
  }

  return {
    comparisonTarget: input.comparisonTarget as string,
    productionObservation: input.productionObservation as string,
    verdict: input.verdict,
    reproductionCaseId: input.reproductionCaseId as string,
    evidenceReference: input.evidenceReference as string,
  };
}

export function summarizeMismatchVerdicts(
  rows: readonly Record<string, unknown>[],
): MismatchVerdictSummary {
  const summary: MismatchVerdictSummary = {
    match: 0,
    mismatch: 0,
    not_exercised: 0,
  };

  for (const candidate of rows) {
    const row = createMismatchRow(candidate);
    summary[row.verdict] += 1;
  }

  return summary;
}

export function assertObservationOnlyCharacterization(
  guard: ObservationOnlyCharacterizationGuard,
): void {
  if (guard.disposition !== 'unresolved') {
    throw new Error('disposition must remain unresolved');
  }
  if (guard.splitActivationEnabled !== false) {
    throw new Error('split activation must remain disabled');
  }
  if (guard.mutatesExistingSrs !== false) {
    throw new Error('existing SRS mutation is forbidden');
  }
}

export function assertSplitCharacterizationCompletion(
  candidate: SplitCharacterizationCompletionCandidate,
): void {
  const productionObservation = candidate.observations.find(
    (observation) => observation.observationKind === 'production_runtime_observed',
  );
  const standaloneObservation = candidate.observations.find(
    (observation) => observation.observationKind === 'test_observed',
  );
  const evidence = candidate.productionPathEvidence;

  if (!productionObservation || !standaloneObservation || !evidence) {
    throw new Error(
      'production runtime observation and actual HTTPS /ws evidence are required',
    );
  }

  const browserLocation = parseProductionUrl(
    evidence.browserLocation,
    'browserLocation',
  );
  const browserSocketUrl = parseProductionUrl(
    evidence.browserSocketUrl,
    'browserSocketUrl',
  );
  if (
    browserLocation.protocol !== 'https:'
    || browserLocation.host !== 'localhost:2222'
    || browserSocketUrl.protocol !== 'wss:'
    || browserSocketUrl.host !== browserLocation.host
    || browserSocketUrl.pathname !== '/ws'
    || evidence.actualUpgradePath !== '/ws'
    || evidence.authenticatedRouterDispatchObserved !== true
  ) {
    throw new Error('production actual HTTPS /ws upgrade evidence is required');
  }

  assertNonEmptyString(
    evidence.serverConstructionSource,
    'serverConstructionSource',
  );
  assertNonEmptyString(evidence.browserUrlSource, 'browserUrlSource');
  if (
    !productionObservation.sourceReference.includes(
      evidence.serverConstructionSource,
    )
    || !productionObservation.sourceReference.includes(evidence.browserUrlSource)
  ) {
    throw new Error('production source references must match actual path evidence');
  }

  if (!isWsTransportMode(evidence.runtimeConfigWsTransportMode)) {
    throw new Error('production runtime config mode provenance is required');
  }

  const expectedSocketUrl = new URL(buildControlWebSocketUrl({
    token: null,
    location: {
      protocol: browserLocation.protocol,
      host: browserLocation.host,
    },
    transportMode: evidence.browserSocketTransportMode,
  }));
  if (
    !isBrowserSocketTransportMode(evidence.browserSocketTransportMode)
    || expectedSocketUrl.protocol !== browserSocketUrl.protocol
    || expectedSocketUrl.host !== browserSocketUrl.host
    || expectedSocketUrl.pathname !== browserSocketUrl.pathname
    || expectedSocketUrl.searchParams.get('mode')
      !== browserSocketUrl.searchParams.get('mode')
    || expectedSocketUrl.searchParams.get('channel')
      !== browserSocketUrl.searchParams.get('channel')
  ) {
    throw new Error('browser production WebSocket URL evidence is inconsistent');
  }
  if (
    productionObservation.effectiveWsTransportMode
      !== evidence.runtimeConfigWsTransportMode
  ) {
    throw new Error('production observation must preserve runtime config mode');
  }

  const observedResult = productionObservation.observedResult;
  if (
    !isJsonRecord(observedResult)
    || observedResult.browserLocation !== browserLocation.origin
    || observedResult.browserSocketUrl !== evidence.browserSocketUrl
    || observedResult.actualUpgradePath !== evidence.actualUpgradePath
    || observedResult.runtimeConfigWsTransportMode
      !== evidence.runtimeConfigWsTransportMode
    || observedResult.browserSocketTransportMode
      !== evidence.browserSocketTransportMode
    || observedResult.routerPongObservedAfterProbe !== true
    || typeof observedResult.authenticatedConnectedClientId !== 'string'
    || observedResult.authenticatedConnectedClientId.length === 0
  ) {
    throw new Error('production observation must preserve authenticated router evidence');
  }

  const standaloneResult = standaloneObservation.observedResult;
  if (
    standaloneObservation.caseId !== 'standalone-injected-split-handshake'
    || !standaloneObservation.sourceReference.includes(
      'server/src/ws/WsRouterSplitHandshake.test.ts',
    )
    || standaloneObservation.sourceReference === productionObservation.sourceReference
    || standaloneObservation.command === productionObservation.command
    || !isJsonRecord(standaloneResult)
    || standaloneResult.connectionPath !== "wss.emit('connection', ...)"
    || standaloneResult.transportMetadataInjected !== true
  ) {
    throw new Error('standalone injected observation evidence is required');
  }
}

import {
  analyzeTerminalRetainedState,
  canonicalizeTerminalRetainedState,
  type CanonicalTerminalRetainedState,
  type RetainedStateCauseSignal,
  type TerminalBufferType,
  type TerminalRetainedLine,
  type TerminalRetainedStateAnalysis,
} from '../../src/utils/terminalRetainedState.ts';

export const RETAINED_STATE_AXIS_VALUES = {
  localCache: ['valid', 'absent', 'poisoned'],
  view: ['active', 'hidden'],
  text: ['ASCII', 'CJK-wide', 'combining', 'emoji'],
  terminalBuffer: ['normal', 'alternate'],
} as const;

export type LocalCacheAxis = (typeof RETAINED_STATE_AXIS_VALUES.localCache)[number];
export type ViewAxis = (typeof RETAINED_STATE_AXIS_VALUES.view)[number];
export type TextAxis = (typeof RETAINED_STATE_AXIS_VALUES.text)[number];

export interface RetainedStateAxes {
  localCache: LocalCacheAxis;
  view: ViewAxis;
  text: TextAxis;
  terminalBuffer: TerminalBufferType;
}

export interface RetainedStateCaseDefinition {
  caseId: string;
  axes: RetainedStateAxes;
  logicalLineSeed?: number;
  legacySerializedPayloadSeed?: {
    position: 'before' | 'at' | 'after';
    bytes: number;
  };
}

export interface RetainedStateCaseManifest {
  schemaVersion: '1.0.0';
  requirementId: 'OBS-BGSTAB-004';
  seedRole: 'current_behavior_characterization_only';
  logicalLineSeeds: [24, 1000, 10000];
  legacySerializedPayloadSeeds: [
    { position: 'before'; bytes: number },
    { position: 'at'; bytes: number },
    { position: 'after'; bytes: number },
  ];
  axes: typeof RETAINED_STATE_AXIS_VALUES;
  cases: RetainedStateCaseDefinition[];
}

interface RuntimeConfigSubset {
  resourceLimits?: {
    terminal?: { scrollbackLines?: unknown };
    snapshots?: { perSnapshotMaxChars?: unknown };
  };
}

export interface RetainedStateCaseResult {
  caseId: string;
  executionKind: 'deterministic_boundary_fixture';
  browserOrigin: string;
  axes: RetainedStateAxes;
  seed: {
    logicalLines: number;
    serializedPayloadBytes: number | null;
    legacyBoundaryPosition: 'before' | 'at' | 'after' | null;
  };
  effectiveRuntimeBoundary: {
    scrollbackLines: number;
    perSnapshotMaxChars: number;
    snapshotScope: 'viewport-only';
    snapshotViewportRows: 24;
    preRetainedLineStart: number;
    postRetainedLineStart: number;
    source: '/api/runtime-config';
  };
  pre: CanonicalTerminalRetainedState;
  post: CanonicalTerminalRetainedState;
  analysis: TerminalRetainedStateAnalysis;
}

export interface Tc7004CurrentBehaviorRecord {
  evidenceKind: 'separate_current_behavior';
  testId: 'TC-7004';
  command: string;
  exitCode: number;
  snapshotScope: 'viewport-only';
  oldMarkerAfterReload: 'absent';
  latestMarkerAfterReload: 'present';
  targetRetainedStateParity: false;
  futureRetentionPromise: false;
}

export interface ObservationOnlyGuard {
  setsProductRetainedRows: false;
  setsAggregateMemoryBudget: false;
  setsCheckpointChunkSize: false;
  setsCheckpointInFlightBudget: false;
  setsRecoverySlo: false;
  promotesAuthority: false;
}

export interface RetainedStateCharacterizationPayload {
  schemaVersion: '1.0.0';
  requirementId: 'OBS-BGSTAB-004';
  browserOrigin: string;
  manifest: RetainedStateCaseManifest;
  results: RetainedStateCaseResult[];
  tc7004: Tc7004CurrentBehaviorRecord;
  evidenceScope: {
    liveCurrentBehaviorCaseIds: ['TC-7004'];
    deterministicBoundaryFixtureCaseIds: string[];
    matrixExecutesLiveRefresh: false;
    fixtureObservedLossIsNotRuntimeIncidence: true;
  };
  nonPromotionGuard: ObservationOnlyGuard;
}

const TEXT_VALUES: Record<TextAxis, { chars: string; width: number }> = {
  ASCII: { chars: 'A', width: 1 },
  'CJK-wide': { chars: '한', width: 2 },
  combining: { chars: 'e\u0301', width: 1 },
  emoji: { chars: '😀', width: 2 },
};

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

export function createRetainedStateCaseManifest(input: {
  legacyBoundaryBytes: number;
}): RetainedStateCaseManifest {
  assertPositiveInteger(input.legacyBoundaryBytes, 'legacyBoundaryBytes');
  const before = input.legacyBoundaryBytes - 1;
  const at = input.legacyBoundaryBytes;
  const after = input.legacyBoundaryBytes + 1;
  const cases: RetainedStateCaseDefinition[] = [
    {
      caseId: 'logical-lines-24',
      axes: { localCache: 'valid', view: 'active', text: 'ASCII', terminalBuffer: 'normal' },
      logicalLineSeed: 24,
    },
    {
      caseId: 'logical-lines-1000',
      axes: { localCache: 'absent', view: 'hidden', text: 'CJK-wide', terminalBuffer: 'alternate' },
      logicalLineSeed: 1000,
    },
    {
      caseId: 'logical-lines-10000',
      axes: { localCache: 'poisoned', view: 'active', text: 'combining', terminalBuffer: 'normal' },
      logicalLineSeed: 10000,
    },
    {
      caseId: 'legacy-2mib-before',
      axes: { localCache: 'valid', view: 'hidden', text: 'emoji', terminalBuffer: 'alternate' },
      legacySerializedPayloadSeed: { position: 'before', bytes: before },
    },
    {
      caseId: 'legacy-2mib-at',
      axes: { localCache: 'absent', view: 'active', text: 'ASCII', terminalBuffer: 'normal' },
      legacySerializedPayloadSeed: { position: 'at', bytes: at },
    },
    {
      caseId: 'legacy-2mib-after',
      axes: { localCache: 'poisoned', view: 'hidden', text: 'CJK-wide', terminalBuffer: 'alternate' },
      legacySerializedPayloadSeed: { position: 'after', bytes: after },
    },
  ];

  return {
    schemaVersion: '1.0.0',
    requirementId: 'OBS-BGSTAB-004',
    seedRole: 'current_behavior_characterization_only',
    logicalLineSeeds: [24, 1000, 10000],
    legacySerializedPayloadSeeds: [
      { position: 'before', bytes: before },
      { position: 'at', bytes: at },
      { position: 'after', bytes: after },
    ],
    axes: RETAINED_STATE_AXIS_VALUES,
    cases,
  };
}

function readRuntimeBoundary(runtimeConfig: RuntimeConfigSubset) {
  const scrollbackLines = runtimeConfig.resourceLimits?.terminal?.scrollbackLines;
  const perSnapshotMaxChars = runtimeConfig.resourceLimits?.snapshots?.perSnapshotMaxChars;
  assertPositiveInteger(scrollbackLines, 'runtimeConfig.resourceLimits.terminal.scrollbackLines');
  assertPositiveInteger(perSnapshotMaxChars, 'runtimeConfig.resourceLimits.snapshots.perSnapshotMaxChars');
  return { scrollbackLines, perSnapshotMaxChars };
}

function createLine(index: number, textAxis: TextAxis): TerminalRetainedLine {
  const text = TEXT_VALUES[textAxis];
  return {
    index,
    isWrapped: false,
    text: `${index.toString().padStart(6, '0')}:${text.chars}`,
    cells: [
      {
        column: 0,
        chars: text.chars,
        code: text.chars.codePointAt(0) ?? 0,
        width: text.width,
        fgMode: index % 2,
        bgMode: 0,
        fg: index % 16,
        bg: 0,
        bold: index % 7 === 0,
        italic: false,
        dim: false,
        underline: index % 11 === 0,
        blink: false,
        inverse: false,
        invisible: false,
        strikethrough: false,
        overline: false,
      },
    ],
  };
}

function resolveLogicalLineCount(definition: RetainedStateCaseDefinition): number {
  if (definition.logicalLineSeed !== undefined) return definition.logicalLineSeed;
  const payloadBytes = definition.legacySerializedPayloadSeed?.bytes;
  if (payloadBytes === undefined) throw new TypeError('case requires a corpus seed');
  return Math.ceil(payloadBytes / 80);
}

function createCauseSignals(
  definition: RetainedStateCaseDefinition,
  runtimeBoundary: { scrollbackLines: number; perSnapshotMaxChars: number },
  logicalLineCount: number,
  preRetainedLineStart: number,
  postRetainedLineStart: number,
): RetainedStateCauseSignal[] {
  const rawReference = `case://${definition.caseId}/raw-boundary-signals`;
  const payloadBytes = definition.legacySerializedPayloadSeed?.bytes ?? null;
  return [
    {
      kind: 'snapshot_truncation',
      status: postRetainedLineStart > preRetainedLineStart
        ? 'observed'
        : payloadBytes !== null
          ? 'candidate'
          : 'not_observed',
      evidenceReferences: [`${rawReference}#snapshot`],
      details: {
        logicalLineCount,
        configuredScrollbackLines: runtimeBoundary.scrollbackLines,
        configuredSnapshotLimit: runtimeBoundary.perSnapshotMaxChars,
        configuredSnapshotLimitUnit: 'characters',
        preRetainedLineStart,
        postRetainedLineStart,
        ...(payloadBytes === null
          ? {}
          : {
              legacySerializedPayloadSeedBytes: payloadBytes,
              unitComparison: 'not_comparable',
            }),
      },
    },
    {
      kind: 'fallback',
      status: definition.axes.localCache === 'valid' ? 'not_observed' : 'candidate',
      evidenceReferences: [`${rawReference}#fallback`],
      details: { localCache: definition.axes.localCache },
    },
    {
      kind: 'replay_tail_truncation',
      status: 'candidate',
      evidenceReferences: [`${rawReference}#replay-tail`],
      details: { conclusion: 'not asserted by deterministic boundary fixture' },
    },
    {
      kind: 'remount_handoff',
      status: 'candidate',
      evidenceReferences: [`${rawReference}#remount`],
      details: { view: definition.axes.view },
    },
    {
      kind: 'local_cache_decision',
      status: 'observed',
      evidenceReferences: [`${rawReference}#local-cache`],
      details: { decisionInput: definition.axes.localCache },
    },
    {
      kind: 'visible_hidden_overflow_repair',
      status: 'not_observed',
      evidenceReferences: [`${rawReference}#visibility-repair`],
      details: {
        view: definition.axes.view,
        conclusion: 'no overflow outcome inferred by deterministic boundary fixture',
      },
    },
  ];
}

function createCaseResult(input: {
  definition: RetainedStateCaseDefinition;
  runtimeBoundary: { scrollbackLines: number; perSnapshotMaxChars: number };
  browserOrigin: string;
}): RetainedStateCaseResult {
  const logicalLineCount = resolveLogicalLineCount(input.definition);
  const viewportRows = 24;
  const preCapacity = input.definition.axes.terminalBuffer === 'alternate'
    ? viewportRows
    : input.runtimeBoundary.scrollbackLines + viewportRows;
  const preRetainedLineStart = Math.max(0, logicalLineCount - preCapacity);
  const postRetainedLineStart = Math.max(0, logicalLineCount - viewportRows);
  const lines = Array.from(
    { length: logicalLineCount },
    (_, index) => createLine(index, input.definition.axes.text),
  );
  const modes = {
    applicationCursorKeysMode: false,
    applicationKeypadMode: false,
    bracketedPasteMode: true,
    insertMode: false,
    mouseTrackingMode: 'none' as const,
    originMode: false,
    reverseWraparoundMode: false,
    sendFocusMode: false,
    synchronizedOutputMode: false,
    wraparoundMode: true,
  };
  const pre = canonicalizeTerminalRetainedState({
    schemaVersion: 1,
    activeBuffer: input.definition.axes.terminalBuffer,
    geometry: { rows: 24, cols: 80 },
    cursor: { x: 0, y: 23, absoluteY: logicalLineCount - 1 },
    savedCursor: { available: false },
    modes,
    lines: lines.slice(preRetainedLineStart),
  });
  const retainedLines = lines.slice(postRetainedLineStart);
  if (input.definition.axes.localCache === 'poisoned' && retainedLines.length > 0) {
    retainedLines[retainedLines.length - 1] = {
      ...retainedLines[retainedLines.length - 1],
      text: `${retainedLines[retainedLines.length - 1].text}:poisoned-cache-observation`,
    };
  }
  const post = canonicalizeTerminalRetainedState({
    schemaVersion: 1,
    activeBuffer: input.definition.axes.terminalBuffer,
    geometry: { rows: 24, cols: 80 },
    ...(input.definition.axes.localCache === 'absent'
      ? {}
      : { cursor: { x: 0, y: 23, absoluteY: logicalLineCount - 1 } }),
    savedCursor: { available: false },
    modes,
    lines: retainedLines,
  });
  const causeSignals = createCauseSignals(
    input.definition,
    input.runtimeBoundary,
    logicalLineCount,
    preRetainedLineStart,
    postRetainedLineStart,
  );
  const analysis = analyzeTerminalRetainedState({
    pre,
    post,
    effectiveBoundary: {
      retainedLineStart: postRetainedLineStart,
      retainedLineEnd: logicalLineCount - 1,
      serializedPayloadBoundary: input.definition.legacySerializedPayloadSeed
        ? {
            value: input.definition.legacySerializedPayloadSeed.bytes,
            unit: 'bytes',
            provenance: 'legacy-2MiB-characterization-seed',
          }
        : {
            value: input.runtimeBoundary.perSnapshotMaxChars,
            unit: 'characters',
            provenance: '/api/runtime-config#resourceLimits.snapshots.perSnapshotMaxChars',
          },
    },
    causeSignals,
  });

  return {
    caseId: input.definition.caseId,
    executionKind: 'deterministic_boundary_fixture',
    browserOrigin: input.browserOrigin,
    axes: { ...input.definition.axes },
    seed: {
      logicalLines: logicalLineCount,
      serializedPayloadBytes: input.definition.legacySerializedPayloadSeed?.bytes ?? null,
      legacyBoundaryPosition: input.definition.legacySerializedPayloadSeed?.position ?? null,
    },
    effectiveRuntimeBoundary: {
      ...input.runtimeBoundary,
      snapshotScope: 'viewport-only',
      snapshotViewportRows: viewportRows,
      preRetainedLineStart,
      postRetainedLineStart,
      source: '/api/runtime-config',
    },
    pre,
    post,
    analysis,
  };
}

export function runDeterministicRetainedStateCases(input: {
  manifest: RetainedStateCaseManifest;
  runtimeConfig: RuntimeConfigSubset;
  browserOrigin: string;
}): RetainedStateCaseResult[] {
  if (input.browserOrigin !== 'https://localhost:2222') {
    throw new Error('characterization browser origin must be https://localhost:2222');
  }
  const runtimeBoundary = readRuntimeBoundary(input.runtimeConfig);
  return input.manifest.cases.map((definition) => createCaseResult({
    definition,
    runtimeBoundary,
    browserOrigin: input.browserOrigin,
  }));
}

export function assertRetainedStateCaseCoverage(
  manifest: RetainedStateCaseManifest,
  results: readonly RetainedStateCaseResult[],
): void {
  const resultCaseIds = new Set(results.map((result) => result.caseId));
  if (resultCaseIds.size !== manifest.cases.length
      || manifest.cases.some((definition) => !resultCaseIds.has(definition.caseId))) {
    throw new Error('every retained-state manifest case requires exactly one result');
  }
  const lineSeeds = new Set(results
    .filter((result) => result.seed.legacyBoundaryPosition === null)
    .map((result) => result.seed.logicalLines));
  for (const seed of manifest.logicalLineSeeds) {
    if (!lineSeeds.has(seed)) throw new Error(`missing logical-line seed result: ${seed}`);
  }
  const payloadPositions = new Set(results.map((result) => result.seed.legacyBoundaryPosition));
  for (const position of ['before', 'at', 'after'] as const) {
    if (!payloadPositions.has(position)) throw new Error(`missing legacy boundary result: ${position}`);
  }
  for (const [axis, values] of Object.entries(manifest.axes)) {
    const observed = new Set(results.map((result) => result.axes[axis as keyof RetainedStateAxes]));
    for (const value of values) {
      if (!observed.has(value)) throw new Error(`missing ${axis} axis value: ${value}`);
    }
  }
}

export function createTc7004CurrentBehaviorRecord(input: {
  testId: string;
  command: string;
  exitCode: number;
  oldMarkerAfterReload: string;
  latestMarkerAfterReload: string;
}): Tc7004CurrentBehaviorRecord {
  if (input.testId !== 'TC-7004') throw new TypeError('TC-7004 must remain separate');
  if (!input.command.trim()) throw new TypeError('TC-7004 command is required');
  if (input.exitCode !== 0) throw new Error('TC-7004 current-behavior execution did not pass');
  if (input.oldMarkerAfterReload !== 'absent' || input.latestMarkerAfterReload !== 'present') {
    throw new Error('TC-7004 viewport-only marker behavior is inconsistent');
  }
  return {
    evidenceKind: 'separate_current_behavior',
    testId: 'TC-7004',
    command: input.command,
    exitCode: input.exitCode,
    snapshotScope: 'viewport-only',
    oldMarkerAfterReload: 'absent',
    latestMarkerAfterReload: 'present',
    targetRetainedStateParity: false,
    futureRetentionPromise: false,
  };
}

export function assertObservationOnlyRetainedStatePayload(
  payload: RetainedStateCharacterizationPayload,
): void {
  const guard = payload.nonPromotionGuard as ObservationOnlyGuard & Record<string, unknown>;
  if (guard.promotesAuthority !== false) {
    throw new Error('authority promotion is forbidden');
  }
  for (const [key, value] of Object.entries(guard)) {
    if (value !== false) throw new Error(`${key} must remain false`);
  }
  assertRetainedStateCaseCoverage(payload.manifest, payload.results);
  if (payload.tc7004.evidenceKind !== 'separate_current_behavior') {
    throw new Error('TC-7004 must remain a separate current-behavior record');
  }
}

export function createRetainedStateCharacterizationPayload(input: {
  manifest: RetainedStateCaseManifest;
  runtimeConfig: RuntimeConfigSubset;
  browserOrigin: string;
  tc7004: Tc7004CurrentBehaviorRecord;
}): RetainedStateCharacterizationPayload {
  const payload: RetainedStateCharacterizationPayload = {
    schemaVersion: '1.0.0',
    requirementId: 'OBS-BGSTAB-004',
    browserOrigin: input.browserOrigin,
    manifest: input.manifest,
    results: runDeterministicRetainedStateCases(input),
    tc7004: input.tc7004,
    evidenceScope: {
      liveCurrentBehaviorCaseIds: ['TC-7004'],
      deterministicBoundaryFixtureCaseIds: input.manifest.cases.map((candidate) => candidate.caseId),
      matrixExecutesLiveRefresh: false,
      fixtureObservedLossIsNotRuntimeIncidence: true,
    },
    nonPromotionGuard: {
      setsProductRetainedRows: false,
      setsAggregateMemoryBudget: false,
      setsCheckpointChunkSize: false,
      setsCheckpointInFlightBudget: false,
      setsRecoverySlo: false,
      promotesAuthority: false,
    },
  };
  assertObservationOnlyRetainedStatePayload(payload);
  return payload;
}

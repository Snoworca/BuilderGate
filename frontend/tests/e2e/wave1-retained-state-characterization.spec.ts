import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  analyzeTerminalRetainedStateEvidence,
  type TerminalRetainedStateBoundary,
  TerminalRetainedStateEvidence,
} from '../../src/utils/terminalRetainedState.ts';
import { login, sendVisibleTerminalCommand, waitForTerminal } from './helpers.ts';

const CONTRACT_MODULE_PATH = './wave1-retained-state-characterization.ts';
const LEGACY_BOUNDARY_BYTES = 2 * 1024 * 1024;
const LIVE_RESULTS_PATH = path.resolve(
  process.cwd(),
  '../docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/retained-state-live-cases.json',
);
const AUTHORITY_RECOVERY_OBSERVATION_KEY = '__buildergate_authority_recovery_observation_v1';
const AUTHORITY_RECOVERY_TRACE_SESSION_KEY = '__buildergate_authority_recovery_trace_session_v1';

async function loadContract(expectedFailureSignature: string) {
  try {
    return await import(CONTRACT_MODULE_PATH);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !('code' in error)
      || error.code !== 'ERR_MODULE_NOT_FOUND'
      || !error.message.includes('wave1-retained-state-characterization.ts')
    ) {
      throw error;
    }
    throw new Error(expectedFailureSignature, { cause: error });
  }
}

interface LiveCaseDefinition {
  caseId: string;
  axes: {
    localCache: 'valid' | 'absent' | 'poisoned';
    view: 'active' | 'hidden';
    text: 'ASCII' | 'CJK-wide' | 'combining' | 'emoji';
    terminalBuffer: 'normal' | 'alternate';
  };
  logicalLineSeed?: number;
  legacySerializedPayloadSeed?: {
    position: 'before' | 'at' | 'after';
    bytes: number;
  };
}

interface OwnedLiveWorkspace {
  workspaceId: string;
  targetSessionId: string;
  hiddenSessionId: string;
  previousWorkspaceId: string | null;
  ownerToken: string;
}

interface ExactPayloadEvidence {
  raw: string;
  utf8Bytes: number;
  sha256: string;
  contentUtf16CodeUnits: number;
  targetBytes: number;
}

interface LiveRuntimeConfig {
  resourceLimits: {
    terminal: { scrollbackLines: number };
    snapshots: { perSnapshotMaxChars: number };
  };
}

interface AuthorityRecoveryFrame {
  ordinal: number;
  direction: 'in' | 'out';
  type: string;
  sessionId?: string;
  viewGeneration?: number;
  visibilityGeneration?: string;
  isVisible?: boolean;
  streamEpoch?: string;
  checkpointEpoch?: string;
  connectionId?: string;
  lastDeliveredSeq?: string;
  screenSeq?: number;
  deliverySeq?: number;
  deliveryKind?: string;
  outputByteLength?: number;
  outputContainsFinalMarker?: boolean;
  outputContainsHiddenMarker?: boolean;
  sourceSegments?: Array<{ screenSeq?: number; chunkId?: string }>;
  continuityAuthority?: string;
  deliveryInterestRefCount?: number;
  authoritativeModelCommitted?: boolean;
  terminalFactsCommitted?: boolean;
  inputByteLength?: number;
  sourceSeq?: string;
  snapshotSeq?: string;
  oldestRetainedSeq?: string;
  retentionPolicyId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  encodedByteTotal?: number;
  encodedBytes?: number;
  appliedThroughSeq?: string;
  drainedThroughSeq?: string;
  authorityMode?: 'legacy' | 'checkpoint';
  mode?: 'authoritative' | 'compatibility';
  source?: 'server-retained-authority';
  localCacheUsed?: boolean;
  checkpointDeliveryActive?: boolean;
  contentDigest?: string;
  digest?: { algorithm?: string; hex?: string };
  retainedStateDigest?: string;
  sourceGeometry?: { cols: number; rows: number };
  modes?: Record<string, boolean>;
  parserTail?: { encoding?: string; encodedBytes?: number };
  parserTailData?: string;
  retainedActiveBuffer?: 'normal' | 'alternate';
  retainedCursor?: { x: number; y: number };
  retainedSavedCursor?: { buffer: 'normal'; x: number; y: number } | null;
  checkpointDeliveryPreparation?: { streamEpoch: string; viewGeneration: number };
  chunkData?: string;
  registeredViews?: Array<{ sessionId: string; viewGeneration: number }>;
}

interface LocalCacheMutation {
  operation: 'setItem' | 'removeItem' | 'clear';
  key: string;
  presentBefore: boolean;
  valueBytes?: number;
}

interface AuthorityRecoveryObservation {
  frames: AuthorityRecoveryFrame[];
  corpusMarkers: CheckpointCorpusMarkers | null;
  localCacheMutations: LocalCacheMutation[];
  inputGateTimeline: Array<{
    phase: 'after-reload-before-reveal' | 'before-checkpoint-start' | 'after-checkpoint-start' | 'before-drain-ack';
    sessionId: string;
    viewGeneration: number | null;
    streamEpoch: string | null;
    checkpointEpoch: string | null;
    inputReady: boolean | null;
    captureState: string | null;
    restorePending: boolean | null;
    barrierReason: string | null;
    frameOrdinal: number;
    lastGateEventId: number | null;
  }>;
  inputGateTransitions: Array<{
    eventId: number;
    inputReady: boolean | null;
    captureState: string | null;
    barrierReason: string | null;
    restorePending: boolean | null;
  }>;
  checkpointPayloadIntegrity: Array<{
    sessionId: string;
    viewGeneration: number;
    streamEpoch: string;
    checkpointEpoch: string;
    payloadCaptured: boolean;
    decodedByteTotal: number | null;
    decodedSha256: string | null;
    includesFinalMarker: boolean | null;
    includesHiddenMarker: boolean | null;
    parserTailSha256: string | null;
    recomputedRetainedStateDigest: string | null;
    chunks: Array<{ chunkIndex: number; decodedBytes: number; sha256: string }>;
  }>;
  postRecoveryInputReady: boolean | null;
  postRecoveryCaptureState: string | null;
  postRecoveryBarrierReason: string | null;
  postRecoveryRestorePending: boolean | null;
  /** `06 §S3` — frames this capture could not read. Must stay 0. */
  undecodableFrames: number;
}

interface CheckpointCorpusMarkers {
  finalMarker: string;
  hiddenMarker: string;
}

interface SelectedAuthorityRecovery {
  sessionId: string;
  viewGeneration: number;
  streamEpoch: string;
  checkpointEpoch: string;
  checkpointStartOrdinal: number;
  visibilityGeneration: string;
  dataGapOrdinal: number;
}

const LIVE_TEXT_SAMPLE = {
  ASCII: 'A',
  'CJK-wide': '한',
  combining: 'e\u0301',
  emoji: '😀',
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function containsFingerprintSubsequence(
  recovered: TerminalRetainedStateEvidence['lineFingerprints'],
  expected: TerminalRetainedStateEvidence['lineFingerprints'],
): boolean {
  let expectedIndex = 0;
  for (const candidate of recovered) {
    const expectedFingerprint = expected[expectedIndex];
    if (
      expectedFingerprint
      && candidate.logicalLineHash === expectedFingerprint.logicalLineHash
      && candidate.cellContentAttributeHash === expectedFingerprint.cellContentAttributeHash
    ) {
      expectedIndex += 1;
    }
  }
  return expectedIndex === expected.length;
}

function buildExactSnapshotPayload(input: {
  sessionId: string;
  targetBytes: number;
  text: keyof typeof LIVE_TEXT_SAMPLE;
  terminalBuffer: 'normal' | 'alternate';
  cols: number;
  rows: number;
}): ExactPayloadEvidence {
  const prefix = input.terminalBuffer === 'alternate' ? '\u001b[?1049h' : '';
  const envelope = {
    schemaVersion: 2,
    payloadKind: 'viewport-only',
    sessionId: input.sessionId,
    content: prefix,
    cols: input.cols,
    rows: input.rows,
    bufferType: input.terminalBuffer,
    savedAt: '2026-07-15T00:00:00.000Z',
  };
  const encoder = new TextEncoder();
  const baseBytes = encoder.encode(JSON.stringify(envelope)).length;
  const remainingBytes = input.targetBytes - baseBytes;
  if (remainingBytes < 0) {
    throw new Error(`payload target is smaller than its envelope: ${input.targetBytes}`);
  }
  const sample = LIVE_TEXT_SAMPLE[input.text];
  const sampleBytes = encoder.encode(sample).length;
  const content = prefix
    + sample.repeat(Math.floor(remainingBytes / sampleBytes))
    + 'A'.repeat(remainingBytes % sampleBytes);
  const raw = JSON.stringify({ ...envelope, content });
  const utf8Bytes = encoder.encode(raw).length;
  if (utf8Bytes !== input.targetBytes) {
    throw new Error(`exact serialized payload mismatch: expected ${input.targetBytes}, received ${utf8Bytes}`);
  }
  return {
    raw,
    utf8Bytes,
    sha256: sha256(raw),
    contentUtf16CodeUnits: content.length,
    targetBytes: input.targetBytes,
  };
}

async function createOwnedLiveWorkspace(
  page: Page,
  caseId: string,
): Promise<OwnedLiveWorkspace> {
  const ownerToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return page.evaluate(async ({ caseId: requestedCaseId, ownerToken: tokenValue }) => {
    const authToken = localStorage.getItem('cws_auth_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
    const previousWorkspaceId = localStorage.getItem('active_workspace_id');
    const workspaceName = `PW-RL-${requestedCaseId.slice(0, 12)}-${tokenValue.slice(-8)}`;
    const createResponse = await fetch('/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: workspaceName }),
    });
    if (!createResponse.ok) {
      throw new Error(`live workspace create failed without cleanup fallback: ${createResponse.status}`);
    }
    const workspace = await createResponse.json();
    const sessions: string[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ shell: 'powershell' }),
        });
        if (!tabResponse.ok) throw new Error(`live tab create failed: ${tabResponse.status}`);
        const tab = await tabResponse.json();
        sessions.push(tab.sessionId);
      }
    } catch (error) {
      await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE', headers });
      throw error;
    }
    localStorage.setItem('active_workspace_id', workspace.id);
    localStorage.setItem(`__bg_retained_live_owner_${workspace.id}`, tokenValue);
    return {
      workspaceId: workspace.id,
      targetSessionId: sessions[0],
      hiddenSessionId: sessions[1],
      previousWorkspaceId,
      ownerToken: tokenValue,
    };
  }, { caseId, ownerToken });
}

async function cleanupOwnedLiveWorkspace(page: Page, owned: OwnedLiveWorkspace): Promise<void> {
  const result = await page.evaluate(async (input) => {
    const storedOwner = localStorage.getItem(`__bg_retained_live_owner_${input.workspaceId}`);
    if (storedOwner !== input.ownerToken) {
      throw new Error('live workspace cleanup refused: owner token mismatch');
    }
    const authToken = localStorage.getItem('cws_auth_token');
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const response = await fetch(`/api/workspaces/${input.workspaceId}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`live workspace cleanup failed: ${response.status}`);
    }
    const stateResponse = await fetch('/api/workspaces', { headers });
    if (!stateResponse.ok) throw new Error(`workspace verification failed: ${stateResponse.status}`);
    const state = await stateResponse.json();
    const ownedStillExists = state.workspaces.some(
      (workspace: { id: string }) => workspace.id === input.workspaceId,
    );
    if (ownedStillExists) throw new Error('exact owned live workspace remained after cleanup');
    const previousStillExists = input.previousWorkspaceId !== null && state.workspaces.some(
      (workspace: { id: string }) => workspace.id === input.previousWorkspaceId,
    );
    if (previousStillExists) {
      localStorage.setItem('active_workspace_id', input.previousWorkspaceId!);
    } else {
      localStorage.removeItem('active_workspace_id');
    }
    localStorage.removeItem(`__bg_retained_live_owner_${input.workspaceId}`);
    return {
      ownedStillExists,
      restoredWorkspaceId: previousStillExists ? input.previousWorkspaceId : null,
      activeWorkspaceBeforeReload: localStorage.getItem('active_workspace_id'),
    };
  }, owned);
  expect(result.ownedStillExists).toBe(false);
  expect(result.activeWorkspaceBeforeReload).toBe(result.restoredWorkspaceId);
}

async function selectSessionTab(page: Page, sessionId: string): Promise<void> {
  const tab = page.locator(`[role="tab"][aria-controls="terminal-${sessionId}"]`);
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await waitForTerminal(page);
}


function buildCorpusCommand(definition: LiveCaseDefinition): {
  command: string;
  finalMarker: string;
  hiddenMarker: string;
} {
  const lineCount = definition.logicalLineSeed ?? 48;
  const finalMarker = `W1-${definition.caseId}-FINAL`;
  const hiddenMarker = `W1-${definition.caseId}-HIDDEN-PTY-OUTPUT`;
  const source = [
    `const count=${lineCount};`,
    `const sample=${JSON.stringify(LIVE_TEXT_SAMPLE[definition.axes.text])};`,
    `const prefix=${JSON.stringify(`W1-${definition.caseId}-`)};`,
    definition.axes.terminalBuffer === 'alternate'
      ? "process.stdout.write('\\x1b[?1049h');"
      : '',
    "for(let index=0;index<count;index+=1){",
    `const line=index===count-1?${JSON.stringify(finalMarker)}:prefix+String(index).padStart(6,'0')+'-'+sample;`,
    "process.stdout.write(line+'\\n');",
    '}',
  ].join('');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  return {
    command: `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`,
    finalMarker,
    hiddenMarker,
  };
}

async function captureLiveRetainedState(
  page: Page,
  sessionId: string,
): Promise<TerminalRetainedStateEvidence> {
  const deadline = Date.now() + 30_000;
  let diagnostic: { hasMethod: boolean; registeredSessionIds: string[] } | null = null;
  while (Date.now() < deadline) {
    const capture = await page.evaluate((requestedSessionId) => {
      const debug = (window as unknown as {
        __buildergateTerminalDebug?: {
          captureRetainedState?: (id: string) => TerminalRetainedStateEvidence | null;
          retainedStateCaptureHandlers?: Map<string, unknown>;
        };
      }).__buildergateTerminalDebug;
      return {
        evidence: debug?.captureRetainedState?.(requestedSessionId) ?? null,
        hasMethod: typeof debug?.captureRetainedState === 'function',
        registeredSessionIds: debug?.retainedStateCaptureHandlers
          ? [...debug.retainedStateCaptureHandlers.keys()]
          : [],
      };
    }, sessionId);
    if (capture.evidence) return capture.evidence;
    diagnostic = {
      hasMethod: capture.hasMethod,
      registeredSessionIds: capture.registeredSessionIds,
    };
    await page.waitForTimeout(100);
  }
  throw new Error(`live retained-state capture unavailable: ${JSON.stringify(diagnostic)}`);
}

async function setLocalCacheBoundary(
  page: Page,
  definition: LiveCaseDefinition,
  sessionId: string,
  pre: TerminalRetainedStateEvidence,
  exactPayload: ExactPayloadEvidence | null,
) {
  return page.evaluate(async ({ definition: liveDefinition, sessionId: id, pre: before, exactRaw }) => {
    const key = `terminal_snapshot_${id}`;
    let raw: string | null = null;
    if (liveDefinition.axes.localCache === 'valid') {
      raw = exactRaw ?? JSON.stringify({
        schemaVersion: 2,
        payloadKind: 'viewport-only',
        sessionId: id,
        content: `W1-${liveDefinition.caseId}-CACHE`,
        cols: before.geometry.cols,
        rows: before.geometry.rows,
        bufferType: liveDefinition.axes.terminalBuffer,
        savedAt: '2026-07-15T00:00:00.000Z',
      });
      localStorage.setItem(key, raw);
    } else if (liveDefinition.axes.localCache === 'absent') {
      localStorage.removeItem(key);
    } else {
      raw = `{"schemaVersion":2,"caseId":${JSON.stringify(liveDefinition.caseId)},`;
      localStorage.setItem(key, raw);
    }
    const stored = localStorage.getItem(key);
    const storedSha256 = stored === null
      ? null
      : Array.from(new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(stored),
      ))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    return {
      requested: liveDefinition.axes.localCache,
      present: stored !== null,
      utf8Bytes: stored === null ? 0 : new TextEncoder().encode(stored).length,
      sha256: storedSha256,
      parseable: stored === null ? false : (() => {
        try { JSON.parse(stored); return true; } catch { return false; }
      })(),
    };
  }, { definition, sessionId, pre, exactRaw: exactPayload?.raw ?? null });
}

async function readLocalCacheAfterReload(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const stored = localStorage.getItem(`terminal_snapshot_${id}`);
    const storedSha256 = stored === null
      ? null
      : Array.from(new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(stored),
      ))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    return {
      present: stored !== null,
      utf8Bytes: stored === null ? 0 : new TextEncoder().encode(stored).length,
      sha256: storedSha256,
      parseable: stored === null ? false : (() => {
        try { JSON.parse(stored); return true; } catch { return false; }
      })(),
    };
  }, sessionId);
}

async function installAuthorityRecoveryObservation(page: Page): Promise<void> {
  const install = (storageKey: string) => {
    const maxObservedCheckpointBase64Bytes = 4 * 1024 * 1024;
    const observedWindow = window as typeof window & {
      __buildergateAuthorityRecoveryObservationInstalled?: boolean;
      __buildergateAuthorityRecoveryCaptureGate?: (sessionId: string) => void;
      __buildergateAuthorityRecoverySendInput?: (sessionId: string, data: string) => void;
      __buildergateAuthorityRecoverySetCorpusMarkers?: (markers: CheckpointCorpusMarkers) => void;
    };
    if (observedWindow.__buildergateAuthorityRecoveryObservationInstalled) return;
    observedWindow.__buildergateAuthorityRecoveryObservationInstalled = true;

    const readObservation = (): AuthorityRecoveryObservation => {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return {
        frames: [], corpusMarkers: null, localCacheMutations: [], inputGateTimeline: [], inputGateTransitions: [], checkpointPayloadIntegrity: [], postRecoveryInputReady: null,
        postRecoveryCaptureState: null, postRecoveryBarrierReason: null, postRecoveryRestorePending: null,
        undecodableFrames: 0,
      };
      try {
        const parsed = JSON.parse(raw) as Partial<AuthorityRecoveryObservation>;
        return {
          frames: Array.isArray(parsed.frames) ? parsed.frames : [],
          corpusMarkers: parsed.corpusMarkers
            && typeof parsed.corpusMarkers.finalMarker === 'string'
            && typeof parsed.corpusMarkers.hiddenMarker === 'string'
            ? parsed.corpusMarkers
            : null,
          localCacheMutations: Array.isArray(parsed.localCacheMutations)
            ? parsed.localCacheMutations
            : [],
          inputGateTimeline: Array.isArray(parsed.inputGateTimeline)
            ? parsed.inputGateTimeline
            : [],
          inputGateTransitions: [],
          checkpointPayloadIntegrity: [],
          postRecoveryInputReady: null,
          postRecoveryCaptureState: null,
          postRecoveryBarrierReason: null,
          postRecoveryRestorePending: null,
          // Preserved across reloads: a frame dropped before the reload is
          // exactly the one the assertions after it would go vacuous on.
          undecodableFrames: typeof parsed.undecodableFrames === 'number'
            ? parsed.undecodableFrames
            : 0,
        };
      } catch {
        return {
          frames: [], corpusMarkers: null, localCacheMutations: [], inputGateTimeline: [], inputGateTransitions: [], checkpointPayloadIntegrity: [], postRecoveryInputReady: null,
          postRecoveryCaptureState: null, postRecoveryBarrierReason: null, postRecoveryRestorePending: null,
          undecodableFrames: 0,
        };
      }
    };
    const writeObservation = (observation: AuthorityRecoveryObservation): void => {
      sessionStorage.setItem(storageKey, JSON.stringify(observation));
    };
    const isTerminalSnapshotKey = (key: string): boolean => key.startsWith('terminal_snapshot_');
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    const originalClear = Storage.prototype.clear;
    Storage.prototype.setItem = function observedSetItem(key: string, value: string): void {
      if (this === localStorage && isTerminalSnapshotKey(key)) {
        const observation = readObservation();
        observation.localCacheMutations.push({
          operation: 'setItem',
          key,
          presentBefore: localStorage.getItem(key) !== null,
          valueBytes: new TextEncoder().encode(value).length,
        });
        writeObservation(observation);
      }
      originalSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function observedRemoveItem(key: string): void {
      if (this === localStorage && isTerminalSnapshotKey(key)) {
        const observation = readObservation();
        observation.localCacheMutations.push({
          operation: 'removeItem',
          key,
          presentBefore: localStorage.getItem(key) !== null,
        });
        writeObservation(observation);
      }
      originalRemoveItem.call(this, key);
    };
    Storage.prototype.clear = function observedClear(): void {
      if (this === localStorage) {
        const observation = readObservation();
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key && isTerminalSnapshotKey(key)) {
            observation.localCacheMutations.push({
              operation: 'clear',
              key,
              presentBefore: true,
            });
          }
        }
        writeObservation(observation);
      }
      originalClear.call(this);
    };

    const captureInputGate = (
      phase: 'after-reload-before-reveal' | 'before-checkpoint-start' | 'after-checkpoint-start' | 'before-drain-ack',
      frame: Pick<AuthorityRecoveryFrame, 'sessionId' | 'viewGeneration' | 'streamEpoch' | 'checkpointEpoch'>,
    ): void => {
      if (typeof frame.sessionId !== 'string') return;
      const snapshot = window.__buildergateTerminalDebug?.readInputGateSnapshot(frame.sessionId) ?? null;
      const lastGateEventId = (window.__buildergateTerminalDebug?.getEvents?.(frame.sessionId) ?? [])
        .filter(event => event.kind === 'input_transport_state_synced')
        .at(-1)?.eventId ?? null;
      const observation = readObservation();
      observation.inputGateTimeline.push({
        phase,
        sessionId: frame.sessionId,
        viewGeneration: frame.viewGeneration ?? null,
        streamEpoch: frame.streamEpoch ?? null,
        checkpointEpoch: frame.checkpointEpoch ?? null,
        inputReady: snapshot?.inputReady ?? null,
        captureState: snapshot?.captureState ?? null,
        restorePending: snapshot?.restorePending ?? null,
        barrierReason: snapshot?.barrierReason ?? null,
        frameOrdinal: observation.frames.at(-1)?.ordinal ?? -1,
        lastGateEventId,
      });
      writeObservation(observation);
    };
    observedWindow.__buildergateAuthorityRecoveryCaptureGate = (sessionId: string): void => {
      captureInputGate('after-reload-before-reveal', { sessionId });
    };
    observedWindow.__buildergateAuthorityRecoverySetCorpusMarkers = (markers: CheckpointCorpusMarkers): void => {
      const observation = readObservation();
      observation.corpusMarkers = { ...markers };
      writeObservation(observation);
    };

    // `06 §S3` — the `'output'` filter below turns a dropped frame into a
    // vacuous assertion rather than a failure, so an unreadable frame is
    // counted on the observation instead of being discarded.
    const countUndecodable = (): void => {
      const current = readObservation();
      current.undecodableFrames += 1;
      writeObservation(current);
    };
    const captureFrame = (direction: 'in' | 'out', raw: unknown): void => {
      if (typeof raw !== 'string') {
        countUndecodable();
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        countUndecodable();
        return;
      }
      if (
        typeof message.type !== 'string'
        || (
          !message.type.startsWith('terminal-checkpoint:')
          && message.type !== 'terminal-delivery:visibility'
          && message.type !== 'terminal-delivery:data-gap'
          && message.type !== 'output'
          && message.type !== 'input'
        )
      ) {
        return;
      }
      const observation = readObservation();
      const frame: AuthorityRecoveryFrame = {
        ordinal: observation.frames.length,
        direction,
        type: message.type,
      };
      for (const key of [
        'sessionId', 'viewGeneration', 'streamEpoch', 'checkpointEpoch', 'sourceSeq',
        'snapshotSeq', 'oldestRetainedSeq', 'retentionPolicyId', 'chunkIndex', 'chunkCount',
        'encodedByteTotal', 'encodedBytes', 'appliedThroughSeq', 'drainedThroughSeq',
        'retainedStateDigest', 'visibilityGeneration', 'isVisible', 'authorityMode',
        'mode', 'source', 'localCacheUsed', 'checkpointDeliveryActive', 'contentDigest', 'retainedActiveBuffer',
        'connectionId', 'lastDeliveredSeq', 'continuityAuthority', 'deliveryInterestRefCount',
        'authoritativeModelCommitted', 'terminalFactsCommitted', 'screenSeq', 'deliverySeq', 'deliveryKind',
      ]) {
        const value = message[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          Object.assign(frame, { [key]: value });
        }
      }
      if (frame.type === 'input' && typeof message.data === 'string') {
        frame.inputByteLength = new TextEncoder().encode(message.data).length;
      }
      if (frame.type === 'output' && typeof message.data === 'string') {
        frame.outputByteLength = new TextEncoder().encode(message.data).length;
        frame.outputContainsFinalMarker = observation.corpusMarkers === null
          ? false
          : message.data.includes(observation.corpusMarkers.finalMarker);
        frame.outputContainsHiddenMarker = observation.corpusMarkers === null
          ? false
          : message.data.includes(observation.corpusMarkers.hiddenMarker);
      }
      if (Array.isArray(message.sourceSegments)) {
        frame.sourceSegments = message.sourceSegments.flatMap(value => {
          if (!value || typeof value !== 'object') return [];
          const segment = value as Record<string, unknown>;
          return [
            {
              ...(typeof segment.screenSeq === 'number' ? { screenSeq: segment.screenSeq } : {}),
              ...(typeof segment.chunkId === 'string' ? { chunkId: segment.chunkId } : {}),
            },
          ];
        });
      }
      const registeredViews = Array.isArray(message.views)
        ? message.views
        : Array.isArray(message.registeredViews)
          ? message.registeredViews
          : null;
      if (registeredViews) {
        frame.registeredViews = registeredViews.flatMap(value => {
          if (!value || typeof value !== 'object') return [];
          const view = value as Record<string, unknown>;
          return typeof view.sessionId === 'string' && typeof view.viewGeneration === 'number'
            ? [{ sessionId: view.sessionId, viewGeneration: view.viewGeneration }]
            : [];
        });
      }
      if (message.digest && typeof message.digest === 'object') {
        const digest = message.digest as Record<string, unknown>;
        frame.digest = {
          ...(typeof digest.algorithm === 'string' ? { algorithm: digest.algorithm } : {}),
          ...(typeof digest.hex === 'string' ? { hex: digest.hex } : {}),
        };
      }
      if (message.sourceGeometry && typeof message.sourceGeometry === 'object') {
        const geometry = message.sourceGeometry as Record<string, unknown>;
        if (typeof geometry.cols === 'number' && typeof geometry.rows === 'number') {
          frame.sourceGeometry = { cols: geometry.cols, rows: geometry.rows };
        }
      }
      if (message.modes && typeof message.modes === 'object' && !Array.isArray(message.modes)) {
        frame.modes = Object.fromEntries(Object.entries(message.modes as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>;
      }
      if (message.parserTail && typeof message.parserTail === 'object') {
        const parserTail = message.parserTail as Record<string, unknown>;
        frame.parserTail = {
          ...(typeof parserTail.encoding === 'string' ? { encoding: parserTail.encoding } : {}),
          ...(typeof parserTail.encodedBytes === 'number' ? { encodedBytes: parserTail.encodedBytes } : {}),
        };
        if (typeof parserTail.data === 'string') frame.parserTailData = parserTail.data;
      }
      if (message.retainedCursor && typeof message.retainedCursor === 'object') {
        const cursor = message.retainedCursor as Record<string, unknown>;
        if (typeof cursor.x === 'number' && typeof cursor.y === 'number') {
          frame.retainedCursor = { x: cursor.x, y: cursor.y };
        }
      }
      if (message.retainedSavedCursor === null) {
        frame.retainedSavedCursor = null;
      } else if (message.retainedSavedCursor && typeof message.retainedSavedCursor === 'object') {
        const savedCursor = message.retainedSavedCursor as Record<string, unknown>;
        if (
          savedCursor.buffer === 'normal'
          && typeof savedCursor.x === 'number'
          && typeof savedCursor.y === 'number'
        ) {
          frame.retainedSavedCursor = {
            buffer: 'normal', x: savedCursor.x, y: savedCursor.y,
          };
        }
      }
      if (message.checkpointDeliveryPreparation && typeof message.checkpointDeliveryPreparation === 'object') {
        const preparation = message.checkpointDeliveryPreparation as Record<string, unknown>;
        if (typeof preparation.streamEpoch === 'string' && typeof preparation.viewGeneration === 'number') {
          frame.checkpointDeliveryPreparation = {
            streamEpoch: preparation.streamEpoch,
            viewGeneration: preparation.viewGeneration,
          };
        }
      }
      if (frame.type === 'terminal-checkpoint:chunk' && typeof message.data === 'string') {
        const observedBase64Bytes = observation.frames.reduce((total, candidate) => (
          total + (candidate.chunkData?.length ?? 0)
        ), 0);
        if (observedBase64Bytes + message.data.length <= maxObservedCheckpointBase64Bytes) {
          frame.chunkData = message.data;
        }
      }
      observation.frames.push(frame);
      writeObservation(observation);
      if (typeof frame.sessionId === 'string' && frame.type === 'terminal-checkpoint:start') {
        captureInputGate('before-checkpoint-start', frame);
        window.setTimeout(() => captureInputGate('after-checkpoint-start', frame), 0);
      }
    };

    const OriginalWebSocket = WebSocket;
    let latestOpenSocket: WebSocket | null = null;
    const originalSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function observedSend(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ): void {
      captureFrame('out', data);
      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          if (
            message.type === 'terminal-checkpoint:drain-ack'
            && typeof message.sessionId === 'string'
          ) {
            captureInputGate('before-drain-ack', {
              sessionId: message.sessionId,
              viewGeneration: typeof message.viewGeneration === 'number' ? message.viewGeneration : undefined,
              streamEpoch: typeof message.streamEpoch === 'string' ? message.streamEpoch : undefined,
              checkpointEpoch: typeof message.checkpointEpoch === 'string' ? message.checkpointEpoch : undefined,
            });
          }
        } catch {
          // Non-JSON browser WebSocket sends are outside terminal checkpoint observation.
        }
      }
      originalSend.call(this, data);
    };
    const ObservedWebSocket = function observedWebSocket(
      this: WebSocket,
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      socket.addEventListener('message', event => captureFrame('in', event.data));
      socket.addEventListener('open', () => { latestOpenSocket = socket; });
      if (socket.readyState === OriginalWebSocket.OPEN) latestOpenSocket = socket;
      return socket;
    };
    ObservedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(ObservedWebSocket, OriginalWebSocket);
    window.WebSocket = ObservedWebSocket as unknown as typeof WebSocket;
    observedWindow.__buildergateAuthorityRecoverySendInput = (sessionId: string, data: string): void => {
      if (!latestOpenSocket || latestOpenSocket.readyState !== OriginalWebSocket.OPEN) {
        throw new Error('live production websocket is unavailable for hidden PTY input');
      }
      latestOpenSocket.send(JSON.stringify({ type: 'input', sessionId, data }));
    };

    const traceSessionId = sessionStorage.getItem('__buildergate_authority_recovery_trace_session_v1');
    if (traceSessionId) {
      let attempts = 0;
      const traceTimer = window.setInterval(() => {
        attempts += 1;
        const debug = window.__buildergateTerminalDebug;
        if (!debug?.start) {
          if (attempts >= 500) window.clearInterval(traceTimer);
          return;
        }
        window.clearInterval(traceTimer);
        void debug.start(traceSessionId);
      }, 0);
    }
  };

  await page.addInitScript(install, AUTHORITY_RECOVERY_OBSERVATION_KEY);
  await page.evaluate(install, AUTHORITY_RECOVERY_OBSERVATION_KEY);
}

async function armAuthorityRecoveryInputTrace(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(({ storageKey, id }) => {
    sessionStorage.setItem(storageKey, id);
  }, { storageKey: AUTHORITY_RECOVERY_TRACE_SESSION_KEY, id: sessionId });
}

async function registerAuthorityRecoveryCorpusMarkers(
  page: Page,
  markers: CheckpointCorpusMarkers,
): Promise<void> {
  await page.evaluate((corpusMarkers) => {
    const observedWindow = window as typeof window & {
      __buildergateAuthorityRecoverySetCorpusMarkers?: (markers: CheckpointCorpusMarkers) => void;
    };
    if (!observedWindow.__buildergateAuthorityRecoverySetCorpusMarkers) {
      throw new Error('authority recovery corpus marker observation seam is unavailable');
    }
    observedWindow.__buildergateAuthorityRecoverySetCorpusMarkers(corpusMarkers);
  }, markers);
}

async function capturePostReloadHiddenInputGate(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const observedWindow = window as typeof window & {
      __buildergateAuthorityRecoveryCaptureGate?: (requestedSessionId: string) => void;
    };
    if (!observedWindow.__buildergateAuthorityRecoveryCaptureGate) {
      throw new Error('authority recovery input-gate observation seam is unavailable');
    }
    observedWindow.__buildergateAuthorityRecoveryCaptureGate(id);
  }, sessionId);
}

async function sendHiddenPtyOutputThroughLiveWebSocket(
  page: Page,
  sessionId: string,
  hiddenMarker: string,
): Promise<{ marker: string; expectedUtf8Bytes: number; inputUtf8Bytes: number }> {
  const command = `node -e "process.stdout.write(${JSON.stringify(`${hiddenMarker}\n`)})"\n`;
  await page.evaluate(({ id, data }) => {
    const observedWindow = window as typeof window & {
      __buildergateAuthorityRecoverySendInput?: (sessionId: string, input: string) => void;
    };
    if (!observedWindow.__buildergateAuthorityRecoverySendInput) {
      throw new Error('authority recovery live websocket input seam is unavailable');
    }
    observedWindow.__buildergateAuthorityRecoverySendInput(id, data);
  }, { id: sessionId, data: command });
  return {
    marker: hiddenMarker,
    expectedUtf8Bytes: Buffer.byteLength(`${hiddenMarker}\n`, 'utf8'),
    inputUtf8Bytes: Buffer.byteLength(command, 'utf8'),
  };
}

async function awaitHiddenAuthorityRecoveryBoundary(
  page: Page,
  sessionId: string,
  recoveryStartOrdinal: number,
  markers: CheckpointCorpusMarkers,
): Promise<AuthorityRecoveryObservation> {
  const deadline = Date.now() + 5_000;
  let observation = await readAuthorityRecoveryObservation(page, sessionId, markers);
  while (Date.now() < deadline) {
    const completed = observation.frames.some(frame => (
      frame.direction === 'out'
      && frame.type === 'terminal-checkpoint:drain-ack'
      && frame.ordinal > recoveryStartOrdinal
    ));
    const authorityUnavailable = observation.frames.some(frame => (
      frame.direction === 'in'
      && frame.type === 'terminal-checkpoint:fresh-checkpoint-required'
      && frame.ordinal > recoveryStartOrdinal
    ));
    if (completed || authorityUnavailable) return observation;
    await page.waitForTimeout(50);
    observation = await readAuthorityRecoveryObservation(page, sessionId, markers);
  }
  return observation;
}

async function waitForHiddenVisibilityDelivery(page: Page, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const observation = await readAuthorityRecoveryObservation(page, sessionId);
    return observation.frames.some(frame => (
      frame.direction === 'out'
      && frame.type === 'terminal-delivery:visibility'
      && frame.isVisible === false
      && typeof frame.visibilityGeneration === 'string'
    ));
  }, { timeout: 5_000 }).toBe(true);
}

async function readAuthorityRecoveryObservation(
  page: Page,
  sessionId: string,
  markers?: CheckpointCorpusMarkers,
): Promise<AuthorityRecoveryObservation> {
  const observation = await readAuthorityRecoveryObservationRaw(page, sessionId, markers);
  // `06 §S3` — every assertion below filters frames by `type`, so a frame the
  // capture could not read makes them pass on a smaller set instead of failing.
  expect(
    observation.undecodableFrames,
    'the ws capture could not read a frame; the frame-type assertions below are vacuous',
  ).toBe(0);
  return observation;
}

async function readAuthorityRecoveryObservationRaw(
  page: Page,
  sessionId: string,
  markers?: CheckpointCorpusMarkers,
): Promise<AuthorityRecoveryObservation> {
  return page.evaluate(async ({ storageKey, expectedSessionId, expectedMarkers }) => {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return {
      frames: [], corpusMarkers: null, localCacheMutations: [], inputGateTimeline: [], inputGateTransitions: [], checkpointPayloadIntegrity: [], postRecoveryInputReady: null,
      postRecoveryCaptureState: null, postRecoveryBarrierReason: null, postRecoveryRestorePending: null,
      undecodableFrames: 0,
    };
    const observation = JSON.parse(raw) as AuthorityRecoveryObservation;
    const cacheKey = `terminal_snapshot_${expectedSessionId}`;
    const postRecoveryGate = window.__buildergateTerminalDebug
      ?.readInputGateSnapshot(expectedSessionId) ?? null;
    const inputGateTransitions = (window.__buildergateTerminalDebug?.getEvents?.(expectedSessionId) ?? [])
      .filter(event => event.kind === 'input_transport_state_synced')
      .flatMap(event => {
        const details = event.details ?? {};
        return [{
          eventId: event.eventId,
          inputReady: typeof details.inputReady === 'boolean' ? details.inputReady : null,
          captureState: typeof details.captureState === 'string' ? details.captureState : null,
          barrierReason: typeof details.barrierReason === 'string' ? details.barrierReason : null,
          restorePending: typeof details.restorePending === 'boolean' ? details.restorePending : null,
        }];
      });
    const frames = observation.frames.filter(frame => (
        frame.sessionId === expectedSessionId
        || frame.registeredViews?.some(view => view.sessionId === expectedSessionId)
      ));
    const checkpointPayloadIntegrity = await Promise.all(frames
      .filter(frame => (
        frame.direction === 'in'
        && frame.type === 'terminal-checkpoint:start'
        && typeof frame.sessionId === 'string'
        && typeof frame.viewGeneration === 'number'
        && typeof frame.streamEpoch === 'string'
        && typeof frame.checkpointEpoch === 'string'
      ))
      .map(async start => {
        const sha256Hex = async (bytes: Uint8Array): Promise<string> => (
          Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map(byte => byte.toString(16).padStart(2, '0')).join('')
        );
        const parserTailBytes = typeof start.parserTailData === 'string'
          ? Uint8Array.from(atob(start.parserTailData), character => character.charCodeAt(0))
          : null;
        const parserTailSha256 = parserTailBytes === null
          ? null
          : await sha256Hex(parserTailBytes);
        const savedCursor = start.retainedSavedCursor === null
          ? null
          : start.retainedSavedCursor === undefined
            ? undefined
            : { x: start.retainedSavedCursor.x, y: start.retainedSavedCursor.y };
        const recomputedRetainedStateDigest = (
          typeof start.contentDigest === 'string'
          && typeof start.parserTailData === 'string'
          && start.sourceGeometry !== undefined
          && start.modes !== undefined
          && start.retainedActiveBuffer !== undefined
          && start.retainedCursor !== undefined
          && savedCursor !== undefined
        )
          // IR-BGSTAB-002: the parser tail enters as a hash of the bytes it stands for,
          // so decode the transport representation before hashing it.
          ? await (async () => {
            const tailBytes = Uint8Array.from(atob(start.parserTailData), character => character.charCodeAt(0));
            const parserTailDigest = `sha256:${await sha256Hex(tailBytes)}`;
            return `sha256:${await sha256Hex(new TextEncoder().encode(JSON.stringify({
              version: 2,
              dataDigest: start.contentDigest,
              parserTailDigest,
              cols: start.sourceGeometry.cols,
              rows: start.sourceGeometry.rows,
              modes: start.modes,
              activeBuffer: start.retainedActiveBuffer,
              cursor: { x: start.retainedCursor.x, y: start.retainedCursor.y },
              savedCursor,
            })))}`;
          })()
          : null;
        const chunks = frames.filter(frame => (
          frame.direction === 'in'
          && frame.type === 'terminal-checkpoint:chunk'
          && frame.sessionId === start.sessionId
          && frame.viewGeneration === start.viewGeneration
          && frame.streamEpoch === start.streamEpoch
          && frame.checkpointEpoch === start.checkpointEpoch
        )).sort((left, right) => (left.chunkIndex ?? -1) - (right.chunkIndex ?? -1));
        const payloadCaptured = chunks.length === start.chunkCount
          && chunks.every(chunk => typeof chunk.chunkData === 'string');
        if (!payloadCaptured) {
          return {
            sessionId: start.sessionId!,
            viewGeneration: start.viewGeneration!,
            streamEpoch: start.streamEpoch!,
            checkpointEpoch: start.checkpointEpoch!,
            payloadCaptured: false,
            decodedByteTotal: null,
            decodedSha256: null,
            includesFinalMarker: null,
            includesHiddenMarker: null,
            parserTailSha256,
            recomputedRetainedStateDigest,
            chunks: [],
          };
        }
        const decodedChunks = chunks.map(chunk => Uint8Array.from(
          atob(chunk.chunkData!), character => character.charCodeAt(0),
        ));
        const chunkIntegrity = await Promise.all(decodedChunks.map(async (bytes, index) => ({
          chunkIndex: chunks[index]!.chunkIndex!,
          decodedBytes: bytes.byteLength,
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map(byte => byte.toString(16).padStart(2, '0')).join(''),
        })));
        const decodedByteTotal = decodedChunks.reduce((total, bytes) => total + bytes.byteLength, 0);
        const payload = new Uint8Array(decodedByteTotal);
        let offset = 0;
        for (const bytes of decodedChunks) {
          payload.set(bytes, offset);
          offset += bytes.byteLength;
        }
        return {
          sessionId: start.sessionId!,
          viewGeneration: start.viewGeneration!,
          streamEpoch: start.streamEpoch!,
          checkpointEpoch: start.checkpointEpoch!,
          payloadCaptured: true,
          decodedByteTotal,
          decodedSha256: await sha256Hex(payload),
          includesFinalMarker: expectedMarkers
            ? new TextDecoder().decode(payload).includes(expectedMarkers.finalMarker)
            : null,
          includesHiddenMarker: expectedMarkers
            ? new TextDecoder().decode(payload).includes(expectedMarkers.hiddenMarker)
            : null,
          parserTailSha256,
          recomputedRetainedStateDigest,
          chunks: chunkIntegrity,
        };
      }));
    return {
      frames: frames.map(({ chunkData: _chunkData, parserTailData: _parserTailData, ...frame }) => frame),
      corpusMarkers: null,
      localCacheMutations: observation.localCacheMutations.filter(mutation => mutation.key === cacheKey),
      inputGateTimeline: observation.inputGateTimeline.filter(entry => entry.sessionId === expectedSessionId),
      inputGateTransitions,
      checkpointPayloadIntegrity,
      postRecoveryInputReady: postRecoveryGate?.inputReady ?? null,
      postRecoveryCaptureState: postRecoveryGate?.captureState ?? null,
      postRecoveryBarrierReason: postRecoveryGate?.barrierReason ?? null,
      postRecoveryRestorePending: postRecoveryGate?.restorePending ?? null,
      undecodableFrames: observation.undecodableFrames ?? 0,
    };
  }, {
    storageKey: AUTHORITY_RECOVERY_OBSERVATION_KEY,
    expectedSessionId: sessionId,
    expectedMarkers: markers ?? null,
  });
}

function assertActualServerCheckpoint(
  observation: AuthorityRecoveryObservation,
  cacheVariant: LiveCaseDefinition['axes']['localCache'],
  recoveryStartOrdinal: number,
  hiddenRecoveryBoundaryOrdinal: number,
  hiddenPtyOutput: { marker: string; expectedUtf8Bytes: number; inputUtf8Bytes: number },
  retainedStateBeforeHiddenOutput: TerminalRetainedStateEvidence,
  recoveredRetainedState: TerminalRetainedStateEvidence,
): SelectedAuthorityRecovery {
  const starts = observation.frames.filter(frame => (
    frame.direction === 'in'
    && frame.type === 'terminal-checkpoint:start'
    && frame.ordinal > recoveryStartOrdinal
    && frame.ordinal <= hiddenRecoveryBoundaryOrdinal
  ));
  expect(starts, `${cacheVariant} cache must recover while the browser view is hidden, not independently make ready or clear stale state`).not.toHaveLength(0);
  const start = starts.at(-1)!;
  expect(start).toMatchObject({
    mode: 'authoritative',
    source: 'server-retained-authority',
    localCacheUsed: false,
    sessionId: expect.any(String),
    viewGeneration: expect.any(Number),
    streamEpoch: expect.stringMatching(/^\d+$/u),
    checkpointEpoch: expect.stringMatching(/^\d+$/u),
    sourceSeq: expect.stringMatching(/^\d+$/u),
    snapshotSeq: expect.stringMatching(/^\d+$/u),
    oldestRetainedSeq: expect.stringMatching(/^\d+$/u),
    retentionPolicyId: expect.any(String),
    chunkCount: expect.any(Number),
    encodedByteTotal: expect.any(Number),
    digest: { algorithm: 'sha256', hex: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    retainedStateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    sourceGeometry: { cols: expect.any(Number), rows: expect.any(Number) },
    modes: expect.any(Object),
    parserTail: { encoding: 'base64', encodedBytes: expect.any(Number) },
    retainedActiveBuffer: expect.stringMatching(/^(?:normal|alternate)$/u),
    retainedCursor: { x: expect.any(Number), y: expect.any(Number) },
  });
  const capability = observation.frames.find(frame => (
    frame.direction === 'in'
    && frame.type === 'terminal-checkpoint:capability'
    && frame.ordinal > recoveryStartOrdinal
    && frame.ordinal < start.ordinal
    && frame.authorityMode === 'checkpoint'
    && frame.checkpointDeliveryActive === true
    && frame.checkpointDeliveryPreparation?.streamEpoch === start.streamEpoch
    && frame.checkpointDeliveryPreparation?.viewGeneration === start.viewGeneration
    && frame.registeredViews?.some(view => (
      view.sessionId === start.sessionId && view.viewGeneration === start.viewGeneration
    ))
  ));
  expect(capability, `${cacheVariant} cache recovery must use an active server checkpoint authority`).toBeDefined();
  expect(
    observation.frames.some(frame => (
      frame.direction === 'out'
      && frame.type === 'terminal-checkpoint:negotiate'
      && frame.ordinal > recoveryStartOrdinal
      && frame.ordinal < start.ordinal
      && frame.registeredViews?.some(view => (
        view.sessionId === start.sessionId && view.viewGeneration === start.viewGeneration
      ))
    )),
    `${cacheVariant} cache recovery must bind the recovered checkpoint to the browser's registered view generation`,
  ).toBe(true);
  const sameTransaction = (frame: AuthorityRecoveryFrame): boolean => (
    frame.sessionId === start.sessionId
    && frame.viewGeneration === start.viewGeneration
    && frame.streamEpoch === start.streamEpoch
    && frame.checkpointEpoch === start.checkpointEpoch
  );
  const hiddenVisibility = observation.frames.filter(frame => (
    frame.direction === 'out'
    && frame.type === 'terminal-delivery:visibility'
    && frame.sessionId === start.sessionId
    && frame.isVisible === false
    && frame.ordinal > recoveryStartOrdinal
    && frame.ordinal < start.ordinal
  )).at(-1);
  expect(hiddenVisibility, `${cacheVariant} cache recovery must retain its actual hidden visibility generation`).toMatchObject({
    visibilityGeneration: expect.stringMatching(/^\d+$/u),
    viewGeneration: start.viewGeneration,
  });
  const dataGap = observation.frames.find(frame => (
    frame.direction === 'in'
    && frame.type === 'terminal-delivery:data-gap'
    && sameTransaction(frame)
    && frame.visibilityGeneration === hiddenVisibility!.visibilityGeneration
    && frame.ordinal > hiddenVisibility!.ordinal
    && frame.ordinal < start.ordinal
  ));
  const hiddenPtyInput = observation.frames.filter(frame => (
    frame.direction === 'out'
    && frame.type === 'input'
    && frame.sessionId === start.sessionId
    && frame.ordinal <= recoveryStartOrdinal
  )).at(-1);
  expect(hiddenPtyInput, `${cacheVariant} cache recovery must have a live production WebSocket witness for the hidden PTY output`).toMatchObject({
    inputByteLength: hiddenPtyOutput.inputUtf8Bytes,
  });
  expect(dataGap, `${cacheVariant} cache recovery must bind its hidden view to an authoritative data gap`).toMatchObject({
    sessionId: start.sessionId,
    viewGeneration: start.viewGeneration,
    visibilityGeneration: hiddenVisibility!.visibilityGeneration,
    streamEpoch: start.streamEpoch,
    checkpointEpoch: start.checkpointEpoch,
    connectionId: expect.any(String),
    lastDeliveredSeq: expect.stringMatching(/^\d+$/u),
    continuityAuthority: 'server-issued',
    deliveryInterestRefCount: expect.any(Number),
    authoritativeModelCommitted: true,
    terminalFactsCommitted: true,
    snapshotSeq: start.snapshotSeq,
    oldestRetainedSeq: start.oldestRetainedSeq,
    retentionPolicyId: start.retentionPolicyId,
  });
  expect(dataGap!.ordinal, `${cacheVariant} authoritative data gap must follow the hidden PTY output witness`).toBeGreaterThan(
    hiddenPtyInput!.ordinal,
  );
  expect(
    BigInt(dataGap!.lastDeliveredSeq!) < BigInt(start.sourceSeq!),
    `${cacheVariant} hidden PTY output must advance the authoritative checkpoint beyond the last delivered sequence`,
  ).toBe(true);
  expect(hiddenPtyOutput.expectedUtf8Bytes).toBeGreaterThan(0);
  const chunks = observation.frames.filter(frame => (
    frame.direction === 'in'
    && frame.type === 'terminal-checkpoint:chunk'
    && sameTransaction(frame)
  ));
  expect(chunks, `${cacheVariant} cache recovery must receive every authoritative checkpoint chunk`).toHaveLength(
    start.chunkCount!,
  );
  expect(chunks.map(chunk => chunk.chunkIndex)).toEqual(
    Array.from({ length: start.chunkCount! }, (_, index) => index),
  );
  expect(chunks.every(chunk => (
    chunk.ordinal > start.ordinal && chunk.ordinal <= hiddenRecoveryBoundaryOrdinal
  ))).toBe(true);
  const payloadIntegrity = observation.checkpointPayloadIntegrity.find(integrity => (
    integrity.sessionId === start.sessionId
    && integrity.viewGeneration === start.viewGeneration
    && integrity.streamEpoch === start.streamEpoch
    && integrity.checkpointEpoch === start.checkpointEpoch
  ));
  expect(payloadIntegrity, `${cacheVariant} cache recovery must retain bounded payload integrity evidence for every checkpoint chunk`).toMatchObject({
    payloadCaptured: true,
    decodedByteTotal: expect.any(Number),
    decodedSha256: start.digest!.hex,
    includesFinalMarker: true,
    includesHiddenMarker: true,
    parserTailSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    recomputedRetainedStateDigest: start.retainedStateDigest,
    chunks: expect.arrayContaining(chunks.map(chunk => expect.objectContaining({
      chunkIndex: chunk.chunkIndex,
      decodedBytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }))),
  });
  expect(`sha256:${payloadIntegrity!.decodedSha256}`).toBe(start.contentDigest);
  expect(
    payloadIntegrity!.decodedByteTotal,
    `${cacheVariant} checkpoint payload must include both retained corpus markers, not merely matching metadata`,
  ).toBeGreaterThan(hiddenPtyOutput.expectedUtf8Bytes);
  const commit = observation.frames.find(frame => (
    frame.direction === 'in'
    && frame.type === 'terminal-checkpoint:commit'
    && sameTransaction(frame)
  ));
  expect(commit).toMatchObject({
    chunkCount: start.chunkCount,
    encodedByteTotal: start.encodedByteTotal,
    digest: start.digest,
    retainedStateDigest: start.retainedStateDigest,
  });
  expect(commit!.ordinal, `${cacheVariant} cache recovery must commit after all checkpoint chunks`).toBeGreaterThan(
    chunks.at(-1)!.ordinal,
  );
  expect(commit!.ordinal, `${cacheVariant} cache recovery must commit before the hidden view is revealed`).toBeLessThanOrEqual(
    hiddenRecoveryBoundaryOrdinal,
  );
  const applyAck = observation.frames.find(frame => (
    frame.direction === 'out'
    && frame.type === 'terminal-checkpoint:apply-ack'
    && sameTransaction(frame)
  ));
  const drainAck = observation.frames.find(frame => (
    frame.direction === 'out'
    && frame.type === 'terminal-checkpoint:drain-ack'
    && sameTransaction(frame)
  ));
  expect(applyAck, `${cacheVariant} cache recovery must apply an actual checkpoint before ready`).toBeDefined();
  expect(drainAck, `${cacheVariant} cache recovery must drain the actual checkpoint before ready`).toBeDefined();
  expect(applyAck!.ordinal, `${cacheVariant} cache recovery must acknowledge apply after commit`).toBeGreaterThan(
    commit!.ordinal,
  );
  expect(drainAck!.ordinal, `${cacheVariant} cache recovery must acknowledge drain after apply`).toBeGreaterThan(
    applyAck!.ordinal,
  );
  expect(applyAck!.ordinal, `${cacheVariant} cache recovery must apply before the hidden view is revealed`).toBeLessThanOrEqual(
    hiddenRecoveryBoundaryOrdinal,
  );
  expect(drainAck!.ordinal, `${cacheVariant} cache recovery must drain before the hidden view is revealed`).toBeLessThanOrEqual(
    hiddenRecoveryBoundaryOrdinal,
  );
  const recoveryOutputs = observation.frames.filter(frame => (
    frame.direction === 'in'
    && frame.type === 'output'
    && frame.sessionId === start.sessionId
    && frame.ordinal > recoveryStartOrdinal
    && frame.ordinal <= drainAck!.ordinal
  ));
  const snapshotSequence = BigInt(start.snapshotSeq!);
  expect(
    recoveryOutputs.every(output => {
      const outputSequences = [
        output.screenSeq,
        ...(output.sourceSegments ?? []).map(segment => segment.screenSeq),
      ];
      return output.outputContainsFinalMarker === false
        && output.outputContainsHiddenMarker === false
        && typeof output.outputByteLength === 'number'
        && outputSequences.length > 0
        && outputSequences.every(sequence => (
          Number.isSafeInteger(sequence) && BigInt(sequence!) > snapshotSequence
        ));
    }),
    `${cacheVariant} recovery must not replay pre-snapshot or hidden-marker corpus outside the selected checkpoint; only explicitly sequenced post-snapshot output may follow it`,
  ).toBe(true);
  const gateFor = (phase: AuthorityRecoveryObservation['inputGateTimeline'][number]['phase']) => (
    observation.inputGateTimeline.find(entry => (
      entry.phase === phase
      && entry.sessionId === start.sessionId
      && entry.viewGeneration === start.viewGeneration
      && entry.streamEpoch === start.streamEpoch
      && entry.checkpointEpoch === start.checkpointEpoch
    ))
  );
  const expectAuthorityBarrier = (
    entry: AuthorityRecoveryObservation['inputGateTimeline'][number] | undefined,
    message: string,
  ): void => {
    expect(entry, message).toMatchObject({
      inputReady: false,
      captureState: 'transient-blocked',
      barrierReason: expect.stringMatching(/^(?:checkpoint-pending|restore-pending|replay-pending)$/u),
      restorePending: true,
    });
  };
  const gateBeforeStart = gateFor('before-checkpoint-start');
  expectAuthorityBarrier(
    gateBeforeStart,
    `${cacheVariant} cache recovery must remain authority-blocked before the authoritative checkpoint starts`,
  );
  const gateAfterReloadBeforeReveal = observation.inputGateTimeline.find(entry => (
    entry.phase === 'after-reload-before-reveal'
    && entry.sessionId === start.sessionId
    && entry.frameOrdinal <= start.ordinal
  ));
  expectAuthorityBarrier(
    gateAfterReloadBeforeReveal,
    `${cacheVariant} cache recovery must be stale immediately after reconnect while the target remains hidden`,
  );
  const gateAfterStart = gateFor('after-checkpoint-start');
  expectAuthorityBarrier(
    gateAfterStart,
    `${cacheVariant} cache recovery must publish an actual stale authority barrier`,
  );
  const gateBeforeDrainAck = gateFor('before-drain-ack');
  expectAuthorityBarrier(
    gateBeforeDrainAck,
    `${cacheVariant} cache recovery must remain authority-blocked until drain acknowledgement`,
  );
  expect(gateAfterReloadBeforeReveal!.lastGateEventId).not.toBeNull();
  expect(gateBeforeDrainAck!.lastGateEventId).not.toBeNull();
  const gateTransitionsBeforeDrain = observation.inputGateTransitions.filter(transition => (
    transition.eventId >= gateAfterReloadBeforeReveal!.lastGateEventId!
    && transition.eventId <= gateBeforeDrainAck!.lastGateEventId!
  ));
  expect(gateTransitionsBeforeDrain, `${cacheVariant} cache recovery must emit a production input-gate trace through drain`).not.toHaveLength(0);
  expect(gateTransitionsBeforeDrain.every(transition => (
    transition.inputReady === false
    && transition.captureState === 'transient-blocked'
    && /^(?:checkpoint-pending|restore-pending|replay-pending)$/u.test(transition.barrierReason ?? '')
    && transition.restorePending === true
  ))).toBe(true);
  expect(
    observation.postRecoveryInputReady,
    `${cacheVariant} cache recovery must become input-ready only after the authoritative drain completes`,
  ).toBe(true);
  expect(observation.postRecoveryCaptureState).toBe('open');
  expect(observation.postRecoveryBarrierReason).toBe('none');
  expect(observation.postRecoveryRestorePending).toBe(false);
  expect(
    recoveredRetainedState.digest,
    `${cacheVariant} retained state must advance beyond the cache-era corpus when hidden PTY output is checkpoint-recovered`,
  ).not.toBe(retainedStateBeforeHiddenOutput.digest);
  expect(recoveredRetainedState.activeBuffer).toBe(retainedStateBeforeHiddenOutput.activeBuffer);
  expect(recoveredRetainedState.geometry).toEqual(retainedStateBeforeHiddenOutput.geometry);
  expect(recoveredRetainedState.modes).toEqual(retainedStateBeforeHiddenOutput.modes);
  expect(recoveredRetainedState.activeBuffer).toBe(start.retainedActiveBuffer);
  expect(recoveredRetainedState.geometry).toEqual(start.sourceGeometry);
  expect(recoveredRetainedState.cursor).toMatchObject(start.retainedCursor!);
  for (const [mode, enabled] of Object.entries(start.modes!)) {
    expect(
      recoveredRetainedState.modes?.[mode as keyof NonNullable<TerminalRetainedStateEvidence['modes']>],
      `${cacheVariant} post-recovery ${mode} mode must come from the selected authoritative checkpoint`,
    ).toBe(enabled);
  }
  expect(
    containsFingerprintSubsequence(
      recoveredRetainedState.lineFingerprints,
      retainedStateBeforeHiddenOutput.lineFingerprints.slice(1),
    ),
    `${cacheVariant} checkpoint recovery must retain the ordered pre-hidden corpus except for the one viewport line displaced by hidden PTY output`,
  ).toBe(true);
  return {
    sessionId: start.sessionId!,
    viewGeneration: start.viewGeneration!,
    streamEpoch: start.streamEpoch!,
    checkpointEpoch: start.checkpointEpoch!,
    checkpointStartOrdinal: start.ordinal,
    visibilityGeneration: hiddenVisibility!.visibilityGeneration!,
    dataGapOrdinal: dataGap!.ordinal,
  };
}

async function collectDebugKinds(page: Page, sessionId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const events = (window as unknown as {
      __buildergateTerminalDebug?: {
        getEvents?: (requestedId?: string) => Array<{ kind: string }>;
      };
    }).__buildergateTerminalDebug?.getEvents?.(id) ?? [];
    return [...new Set(events.map((event) => event.kind))].sort();
  }, sessionId);
}

async function enableDebugCapture(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const debug = (window as unknown as {
      __buildergateTerminalDebug?: { start?: (requestedId: string) => Promise<void> };
    }).__buildergateTerminalDebug;
    if (!debug?.start) throw new Error('terminal debug capture seam is unavailable');
    await debug.start(id);
  }, sessionId);
}

async function runLiveRefreshCase(
  page: Page,
  definition: LiveCaseDefinition,
  runtimeConfig: LiveRuntimeConfig,
  options: { observeAuthorityRecovery?: boolean } = {},
) {
  const owned = await createOwnedLiveWorkspace(page, definition.caseId);
  try {
    await page.reload();
    await waitForTerminal(page);
    await selectSessionTab(page, owned.targetSessionId);
    await enableDebugCapture(page, owned.targetSessionId);
    const corpus = buildCorpusCommand(definition);
    if (options.observeAuthorityRecovery) {
      await registerAuthorityRecoveryCorpusMarkers(page, {
        finalMarker: corpus.finalMarker,
        hiddenMarker: corpus.hiddenMarker,
      });
    }
    await sendVisibleTerminalCommand(page, corpus.command);
    await expect.poll(async () => (
      await page.locator('.terminal-view:visible .xterm-rows').first().textContent()
    ) ?? '', { timeout: 120_000 }).toContain(corpus.finalMarker);
    const pre = await captureLiveRetainedState(page, owned.targetSessionId);
    const preDebugKinds = await collectDebugKinds(page, owned.targetSessionId);
    const exactPayload = definition.legacySerializedPayloadSeed
      ? buildExactSnapshotPayload({
          sessionId: owned.targetSessionId,
          targetBytes: definition.legacySerializedPayloadSeed.bytes,
          text: definition.axes.text,
          terminalBuffer: definition.axes.terminalBuffer,
          cols: pre.geometry.cols,
          rows: pre.geometry.rows,
        })
      : null;
    if (exactPayload) {
      expect(exactPayload.utf8Bytes).toBe(definition.legacySerializedPayloadSeed!.bytes);
    }
    if (definition.axes.view === 'hidden') {
      await selectSessionTab(page, owned.hiddenSessionId);
    }
    const targetHiddenAtReload = definition.axes.view === 'hidden'
      && await page.locator(`[role="tab"][aria-controls="terminal-${owned.targetSessionId}"]`)
        .getAttribute('aria-selected') === 'false';
    if (options.observeAuthorityRecovery && targetHiddenAtReload) {
      await waitForHiddenVisibilityDelivery(page, owned.targetSessionId);
    }
    const hiddenPtyOutput = definition.axes.view === 'hidden'
      ? await sendHiddenPtyOutputThroughLiveWebSocket(page, owned.targetSessionId, corpus.hiddenMarker)
      : null;
    const localCacheBeforeReload = await setLocalCacheBoundary(
      page,
      definition,
      owned.targetSessionId,
      pre,
      exactPayload,
    );
    const preReloadAuthorityRecoveryObservation = options.observeAuthorityRecovery
      ? await readAuthorityRecoveryObservation(page, owned.targetSessionId)
      : null;
    const recoveryStartOrdinal = preReloadAuthorityRecoveryObservation
      ? Math.max(-1, ...preReloadAuthorityRecoveryObservation.frames.map(frame => frame.ordinal))
      : -1;
    const postReloadLocalCacheMutationStart = preReloadAuthorityRecoveryObservation
      ? preReloadAuthorityRecoveryObservation.localCacheMutations.length
      : 0;
    if (options.observeAuthorityRecovery) {
      await armAuthorityRecoveryInputTrace(page, owned.targetSessionId);
    }
    await page.reload();
    await waitForTerminal(page);
    const targetHiddenAfterReconnect = definition.axes.view === 'hidden'
      && await page.locator(`[role="tab"][aria-controls="terminal-${owned.targetSessionId}"]`)
        .getAttribute('aria-selected') === 'false';
    if (options.observeAuthorityRecovery) {
      await capturePostReloadHiddenInputGate(page, owned.targetSessionId);
    }
    const authorityRecoveryObservationBeforeReveal = options.observeAuthorityRecovery
      ? await awaitHiddenAuthorityRecoveryBoundary(page, owned.targetSessionId, recoveryStartOrdinal, {
          finalMarker: corpus.finalMarker,
          hiddenMarker: corpus.hiddenMarker,
        })
      : null;
    const hiddenRecoveryBoundaryOrdinal = authorityRecoveryObservationBeforeReveal
      ? Math.max(-1, ...authorityRecoveryObservationBeforeReveal.frames.map(frame => frame.ordinal))
      : -1;
    if (definition.axes.view === 'hidden') {
      await selectSessionTab(page, owned.targetSessionId);
    }
    const post = await captureLiveRetainedState(page, owned.targetSessionId);
    const postDebugKinds = await collectDebugKinds(page, owned.targetSessionId);
    const localCacheAfterReload = await readLocalCacheAfterReload(page, owned.targetSessionId);
    const authorityRecoveryObservation = options.observeAuthorityRecovery
      ? await readAuthorityRecoveryObservation(page, owned.targetSessionId, {
          finalMarker: corpus.finalMarker,
          hiddenMarker: corpus.hiddenMarker,
        })
      : null;
    const postVisibleHasFinalMarker = options.observeAuthorityRecovery
      ? (((await page.locator('.terminal-view:visible .xterm-rows').first().textContent()) ?? '')
        .includes(corpus.finalMarker))
      : null;
    const evidenceRef = `live-case://${definition.caseId}`;
    const firstPreLine = pre.lineFingerprints[0]?.index ?? 0;
    const lastPreLine = pre.lineFingerprints.at(-1)?.index ?? firstPreLine;
    const effectiveBoundary: TerminalRetainedStateBoundary = {
      retainedLineStart: Math.max(firstPreLine, lastPreLine - pre.geometry.rows + 1),
      retainedLineEnd: lastPreLine,
      serializedPayloadBoundary: {
        value: runtimeConfig.resourceLimits.snapshots.perSnapshotMaxChars,
        unit: 'characters',
        provenance: 'https://localhost:2222/api/runtime-config#resourceLimits.snapshots.perSnapshotMaxChars',
      },
    };
    const causeSignals = [
      { kind: 'snapshot_truncation' as const, status: 'candidate' as const, evidenceReferences: [`${evidenceRef}#pre-post`], details: { effectiveBoundary } },
      { kind: 'fallback' as const, status: definition.axes.localCache === 'valid' ? 'not_observed' as const : 'candidate' as const, evidenceReferences: [`${evidenceRef}#local-cache`], details: { localCache: definition.axes.localCache } },
      { kind: 'replay_tail_truncation' as const, status: 'candidate' as const, evidenceReferences: [`${evidenceRef}#debug-events`], details: { postDebugKinds } },
      { kind: 'remount_handoff' as const, status: 'observed' as const, evidenceReferences: [`${evidenceRef}#refresh`], details: { refreshed: true } },
      { kind: 'local_cache_decision' as const, status: 'observed' as const, evidenceReferences: [`${evidenceRef}#local-cache`], details: { before: localCacheBeforeReload, after: localCacheAfterReload } },
      { kind: 'visible_hidden_overflow_repair' as const, status: definition.axes.view === 'hidden' ? 'candidate' as const : 'not_observed' as const, evidenceReferences: [`${evidenceRef}#visibility`], details: { view: definition.axes.view } },
    ];
    const analysis = analyzeTerminalRetainedStateEvidence({
      pre,
      post,
      effectiveBoundary,
      causeSignals,
    });
    return {
      caseId: definition.caseId,
      executionKind: 'live_browser_refresh',
      browserOrigin: 'https://localhost:2222',
      axes: definition.axes,
      input: {
        logicalLineSeed: definition.logicalLineSeed ?? null,
        legacySerializedPayloadSeed: definition.legacySerializedPayloadSeed ?? null,
        clientLocalStorageJsonBoundary: exactPayload ? {
          targetBytes: exactPayload.targetBytes,
          measuredUtf8Bytes: exactPayload.utf8Bytes,
          sha256: exactPayload.sha256,
          contentUtf16CodeUnits: exactPayload.contentUtf16CodeUnits,
          evidenceRole: 'client-boundary-only-not-server-serializer',
          appliedToLocalCache: definition.axes.localCache === 'valid',
          rawOmitted: true,
        } : null,
      },
      isolation: {
        workspaceId: owned.workspaceId,
        ownerTokenSha256: sha256(owned.ownerToken),
        deletionScope: 'exact-created-workspace-id-only',
      },
      refresh: {
        performed: true,
        requestedView: definition.axes.view,
        targetHiddenAtReload,
        targetHiddenAfterReconnect,
        revealedForPostCapture: definition.axes.view === 'hidden',
      },
      localCache: {
        beforeReload: localCacheBeforeReload,
        afterReload: localCacheAfterReload,
      },
      ...(authorityRecoveryObservation ? {
        preReloadAuthorityRecoveryObservation,
        authorityRecoveryObservationBeforeReveal,
        authorityRecoveryObservation,
        recoveryStartOrdinal,
        postReloadLocalCacheMutationStart,
        hiddenRecoveryBoundaryOrdinal,
        postVisibleHasFinalMarker,
        postVisibleHasHiddenMarker: (((await page.locator('.terminal-view:visible .xterm-rows').first().textContent()) ?? '')
          .includes(corpus.hiddenMarker)),
      } : {}),
      pre,
      hiddenPtyOutput,
      post,
      effectiveRuntimeBoundary: {
        ...effectiveBoundary,
        snapshotScope: 'viewport-only',
        viewportRows: pre.geometry.rows,
        configuredScrollbackLines: runtimeConfig.resourceLimits.terminal.scrollbackLines,
        source: 'https://localhost:2222/api/runtime-config',
      },
      analysis,
      causeSignals,
      debugEventKinds: {
        preRefresh: preDebugKinds,
        postRefresh: postDebugKinds,
      },
    };
  } finally {
    await cleanupOwnedLiveWorkspace(page, owned);
    await page.reload();
  }
}

async function writeLiveResultsArtifact(
  testInfo: TestInfo,
  manifest: { cases: LiveCaseDefinition[] },
  cases: unknown[],
): Promise<void> {
  const payloadWithoutDigest = {
    schemaVersion: '1.0.0',
    requirementId: 'OBS-BGSTAB-004',
    evidenceKind: 'live_browser_refresh_matrix',
    generatedAt: new Date().toISOString(),
    browserOrigin: 'https://localhost:2222',
    testIdentity: {
      file: 'tests/e2e/wave1-retained-state-characterization.spec.ts',
      title: 'AC-1~7 executes the six-case matrix through real browser refresh',
      project: testInfo.project.name,
      retry: testInfo.retry,
    },
    manifestCaseIds: manifest.cases.map((candidate) => candidate.caseId),
    cases,
    nonPromotionGuard: {
      setsProductRetainedRows: false,
      setsAggregateMemoryBudget: false,
      setsCheckpointChunkSize: false,
      setsCheckpointInFlightBudget: false,
      setsRecoverySlo: false,
      promotesAuthority: false,
    },
  };
  const canonical = JSON.stringify(payloadWithoutDigest);
  const payload = {
    ...payloadWithoutDigest,
    contentDigest: { algorithm: 'sha256', value: sha256(canonical) },
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(path.dirname(LIVE_RESULTS_PATH), { recursive: true });
  await writeFile(LIVE_RESULTS_PATH, serialized, 'utf8');
  await testInfo.attach('retained-state-live-cases', {
    body: Buffer.from(serialized, 'utf8'),
    contentType: 'application/json',
  });
}

test.describe('OBS-BGSTAB-004 refresh retained-state characterization', () => {
  test.describe.configure({ retries: 0 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/https:\/\/localhost:2222\//u);
  });

  test('AC-1 keeps TC-7004 as a separate current-behavior record', async () => {
    const contract = await loadContract(
      'OBS-BGSTAB-004 AC-1 contract not implemented',
    );
    const record = contract.createTc7004CurrentBehaviorRecord({
      testId: 'TC-7004',
      command: 'npx playwright test tests/e2e/header-context-menu-regression.spec.ts --grep TC-7004 --project "Desktop Chrome"',
      exitCode: 0,
      oldMarkerAfterReload: 'absent',
      latestMarkerAfterReload: 'present',
    });

    expect(record).toMatchObject({
      evidenceKind: 'separate_current_behavior',
      testId: 'TC-7004',
      snapshotScope: 'viewport-only',
      oldMarkerAfterReload: 'absent',
      latestMarkerAfterReload: 'present',
      targetRetainedStateParity: false,
      futureRetentionPromise: false,
    });
  });

  test('AC-2/3 enumerates every seed and manifest axis without product promotion', async () => {
    const contract = await loadContract(
      'OBS-BGSTAB-004 AC-2/3 contract not implemented',
    );
    const manifest = contract.createRetainedStateCaseManifest({
      legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
    });

    expect(manifest.logicalLineSeeds).toEqual([24, 1000, 10000]);
    expect(manifest.legacySerializedPayloadSeeds).toEqual([
      { position: 'before', bytes: LEGACY_BOUNDARY_BYTES - 1 },
      { position: 'at', bytes: LEGACY_BOUNDARY_BYTES },
      { position: 'after', bytes: LEGACY_BOUNDARY_BYTES + 1 },
    ]);
    expect(manifest.axes).toEqual({
      localCache: ['valid', 'absent', 'poisoned'],
      view: ['active', 'hidden'],
      text: ['ASCII', 'CJK-wide', 'combining', 'emoji'],
      terminalBuffer: ['normal', 'alternate'],
    });
    expect(manifest.seedRole).toBe('current_behavior_characterization_only');
    expect(manifest.productRetainedRange).toBeUndefined();
  });

  test('AC-4/6 emits same-schema pre/post hashes, field verdicts and loss classes', async ({ page }) => {
    const contract = await loadContract(
      'OBS-BGSTAB-004 AC-4/6 contract not implemented',
    );
    const runtimeConfig = await page.evaluate(async () => {
      const response = await fetch('/api/runtime-config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`runtime config failed: ${response.status}`);
      return response.json();
    });
    const manifest = contract.createRetainedStateCaseManifest({
      legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
    });
    const results = contract.runDeterministicRetainedStateCases({
      manifest,
      runtimeConfig,
      browserOrigin: page.url().replace(/\/$/u, ''),
    });

    contract.assertRetainedStateCaseCoverage(manifest, results);
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const result of results) {
      expect(result.pre.schemaVersion).toBe(result.post.schemaVersion);
      expect(result.pre.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
      expect(result.post.digest).toMatch(/^fnv1a64:[0-9a-f]{16}$/u);
      expect(Object.values(result.analysis.fieldVerdicts).every(
        (verdict) => ['equal', 'changed', 'missing'].includes(String(verdict)),
      )).toBe(true);
      expect(result.analysis.classification).toEqual(expect.objectContaining({
        expectedCurrentEviction: expect.any(Number),
        observedLoss: expect.any(Number),
      }));
      expect(result.axes).toEqual(expect.objectContaining({
        localCache: expect.any(String),
        view: expect.any(String),
        text: expect.any(String),
        terminalBuffer: expect.any(String),
      }));
    }
  });

  test('AC-5 preserves all cause surfaces and raw candidate provenance', async ({ page }) => {
    const contract = await loadContract(
      'OBS-BGSTAB-004 AC-5 contract not implemented',
    );
    const runtimeConfig = await page.evaluate(async () => {
      const response = await fetch('/api/runtime-config', { cache: 'no-store' });
      return response.json();
    });
    const results = contract.runDeterministicRetainedStateCases({
      manifest: contract.createRetainedStateCaseManifest({
        legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
      }),
      runtimeConfig,
      browserOrigin: page.url().replace(/\/$/u, ''),
    });
    const causeKinds = new Set(results.flatMap((result) =>
      result.analysis.causeSignals.map((cause) => cause.kind)));

    expect([...causeKinds].sort()).toEqual([
      'fallback',
      'local_cache_decision',
      'remount_handoff',
      'replay_tail_truncation',
      'snapshot_truncation',
      'visible_hidden_overflow_repair',
    ]);
    for (const cause of results.flatMap((result) => result.analysis.causeSignals)) {
      expect(cause.evidenceReferences.length).toBeGreaterThan(0);
      expect(cause.status).toMatch(/^(observed|candidate|not_observed)$/u);
    }
    const legacyBeforeSnapshotCause = results
      .find((result) => result.caseId === 'legacy-2mib-before')
      ?.analysis.causeSignals.find((cause) => cause.kind === 'snapshot_truncation');
    expect(legacyBeforeSnapshotCause).toMatchObject({
      status: 'candidate',
      details: { unitComparison: 'not_comparable' },
    });
  });

  test('AC-1~7 executes the six-case matrix through real browser refresh', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await login(page);
    await waitForTerminal(page);
    const contract = await loadContract('OBS-BGSTAB-004 live refresh matrix not implemented');
    const manifest = contract.createRetainedStateCaseManifest({
      legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
    }) as { cases: LiveCaseDefinition[] };
    const runtimeConfig = await page.evaluate(async () => {
      const response = await fetch('/api/runtime-config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`runtime config failed: ${response.status}`);
      return response.json() as Promise<LiveRuntimeConfig>;
    });
    expect(runtimeConfig.resourceLimits.terminal.scrollbackLines).toBeGreaterThan(0);
    expect(runtimeConfig.resourceLimits.snapshots.perSnapshotMaxChars).toBeGreaterThan(0);
    const liveCases: unknown[] = [];
    for (const definition of manifest.cases) {
      liveCases.push(await runLiveRefreshCase(page, definition, runtimeConfig));
    }
    expect(liveCases).toHaveLength(manifest.cases.length);
    expect(liveCases.every((candidate) => (
      candidate as { refresh: { performed: boolean } }
    ).refresh.performed)).toBe(true);
    for (const candidate of liveCases as Array<{
      input: { clientLocalStorageJsonBoundary: { targetBytes: number; measuredUtf8Bytes: number } | null };
    }>) {
      if (candidate.input.clientLocalStorageJsonBoundary) {
        expect(candidate.input.clientLocalStorageJsonBoundary.measuredUtf8Bytes)
          .toBe(candidate.input.clientLocalStorageJsonBoundary.targetBytes);
      }
    }
    await writeLiveResultsArtifact(testInfo, manifest, liveCases);
  });

  test('REL-BGSTAB-012 preserves local terminal snapshot cache through authority recovery', async ({ page }) => {
    test.setTimeout(360_000);
    await login(page);
    await waitForTerminal(page);
    await installAuthorityRecoveryObservation(page);
    const contract = await loadContract('REL-BGSTAB-012 live authority recovery contract not implemented');
    const manifest = contract.createRetainedStateCaseManifest({
      legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
    }) as { cases: LiveCaseDefinition[] };
    const definitions = (['valid', 'absent', 'poisoned'] as const).map(cacheVariant => (
      manifest.cases.find(candidate => (
        candidate.axes.localCache === cacheVariant && candidate.axes.view === 'hidden'
      ))
    ));
    expect(definitions, 'REL-BGSTAB-012 precondition failed: each local-cache variant requires a hidden live recovery case')
      .not.toContain(undefined);
    if (definitions.some((definition): definition is undefined => definition === undefined)) return;
    const runtimeConfig = await page.evaluate(async () => {
      const response = await fetch('/api/runtime-config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`runtime config failed: ${response.status}`);
      return response.json() as Promise<LiveRuntimeConfig>;
    });
    for (const definition of definitions) {
      const result = await runLiveRefreshCase(page, definition, runtimeConfig, {
        observeAuthorityRecovery: true,
      });

      expect(result.refresh).toMatchObject({
        performed: true,
        requestedView: definition.axes.view,
        targetHiddenAtReload: true,
        targetHiddenAfterReconnect: true,
      });
      const selectedRecovery = assertActualServerCheckpoint(
        result.authorityRecoveryObservation!,
        definition.axes.localCache,
        result.recoveryStartOrdinal!,
        result.hiddenRecoveryBoundaryOrdinal!,
        result.hiddenPtyOutput!,
        result.pre,
        result.post,
      );
      expect(result.hiddenPtyOutput).toMatchObject({
        marker: expect.stringContaining('-HIDDEN-PTY-OUTPUT'),
        expectedUtf8Bytes: expect.any(Number),
        inputUtf8Bytes: expect.any(Number),
      });
      expect(result.hiddenPtyOutput!.expectedUtf8Bytes).toBeGreaterThan(0);
      const hiddenVisibility = result.preReloadAuthorityRecoveryObservation!.frames
        .filter(frame => (
          frame.direction === 'out'
          && frame.type === 'terminal-delivery:visibility'
          && frame.isVisible === false
        ))
        .at(-1);
      expect(
        hiddenVisibility,
        `${definition.axes.localCache} cache recovery must begin from the actual hidden browser view`,
      ).toBeDefined();
      expect(hiddenVisibility!).toMatchObject({
        visibilityGeneration: expect.stringMatching(/^\d+$/u),
        isVisible: false,
      });
      const reconnectHiddenVisibility = result.authorityRecoveryObservationBeforeReveal!.frames
        .filter(frame => (
          frame.direction === 'out'
          && frame.type === 'terminal-delivery:visibility'
          && frame.sessionId === selectedRecovery.sessionId
          && frame.isVisible === false
          && frame.ordinal > result.recoveryStartOrdinal!
          && frame.ordinal < selectedRecovery.checkpointStartOrdinal
        ))
        .at(-1);
      expect(
        reconnectHiddenVisibility,
        `${definition.axes.localCache} cache recovery must remain hidden after reconnect until the intentional reveal`,
      ).toBeDefined();
      expect(reconnectHiddenVisibility!).toMatchObject({
        visibilityGeneration: selectedRecovery.visibilityGeneration,
        isVisible: false,
        viewGeneration: selectedRecovery.viewGeneration,
      });
      expect(
        result.authorityRecoveryObservationBeforeReveal!.frames.some(frame => (
          frame.direction === 'in'
          && frame.type === 'terminal-delivery:data-gap'
          && frame.sessionId === selectedRecovery.sessionId
          && frame.viewGeneration === selectedRecovery.viewGeneration
          && frame.streamEpoch === selectedRecovery.streamEpoch
          && frame.checkpointEpoch === selectedRecovery.checkpointEpoch
          && frame.visibilityGeneration === selectedRecovery.visibilityGeneration
          && frame.ordinal === selectedRecovery.dataGapOrdinal
          && frame.ordinal > reconnectHiddenVisibility!.ordinal
          && frame.ordinal < selectedRecovery.checkpointStartOrdinal
        )),
        `${definition.axes.localCache} reconnect hidden visibility must bind to the selected authoritative checkpoint transaction`,
      ).toBe(true);
      expect(result.localCache.beforeReload).toMatchObject({
        requested: definition.axes.localCache,
        present: definition.axes.localCache !== 'absent',
        parseable: definition.axes.localCache === 'valid',
      });
      expect(
        result.authorityRecoveryObservation.localCacheMutations
          .slice(result.postReloadLocalCacheMutationStart!)
          .some(mutation => mutation.operation === 'removeItem' || mutation.operation === 'clear'),
        `${definition.axes.localCache} cache recovery must not physically delete the local snapshot key`,
      ).toBe(false);
      if (result.localCache.afterReload.present) {
        expect(result.localCache.afterReload).toMatchObject({ parseable: true });
        expect(result.localCache.afterReload.utf8Bytes).toBeLessThanOrEqual(
          runtimeConfig.resourceLimits.snapshots.perSnapshotMaxChars * 4,
        );
      }
      expect(result.post).toMatchObject({
        digest: expect.stringMatching(/^fnv1a64:[a-f0-9]{16}$/u),
        logicalLinesHash: expect.stringMatching(/^fnv1a64:[a-f0-9]{16}$/u),
        cellContentAttributeHash: expect.stringMatching(/^fnv1a64:[a-f0-9]{16}$/u),
      });
      expect(result.post.lineFingerprints.every((line, index, lines) => (
        index === 0 || lines[index - 1]!.index < line.index
      ))).toBe(true);
      expect(
        result.postVisibleHasFinalMarker,
        `${definition.axes.localCache} cache recovery must preserve the server-retained corpus marker`,
      ).toBe(true);
      expect(
        result.postVisibleHasHiddenMarker,
        `${definition.axes.localCache} cache recovery must preserve the PTY output emitted while the target was hidden`,
      ).toBe(true);
    }
  });

  test('AC-7 rejects product budget, SLO and authority-promotion claims', async ({ page }) => {
    const contract = await loadContract(
      'OBS-BGSTAB-004 AC-7 contract not implemented',
    );
    const runtimeConfig = await page.evaluate(async () => {
      const response = await fetch('/api/runtime-config', { cache: 'no-store' });
      return response.json();
    });
    const payload = contract.createRetainedStateCharacterizationPayload({
      manifest: contract.createRetainedStateCaseManifest({
        legacyBoundaryBytes: LEGACY_BOUNDARY_BYTES,
      }),
      runtimeConfig,
      browserOrigin: page.url().replace(/\/$/u, ''),
      tc7004: contract.createTc7004CurrentBehaviorRecord({
        testId: 'TC-7004',
        command: 'separate execution pending artifact export',
        exitCode: 0,
        oldMarkerAfterReload: 'absent',
        latestMarkerAfterReload: 'present',
      }),
    });

    expect(payload.nonPromotionGuard).toEqual({
      setsProductRetainedRows: false,
      setsAggregateMemoryBudget: false,
      setsCheckpointChunkSize: false,
      setsCheckpointInFlightBudget: false,
      setsRecoverySlo: false,
      promotesAuthority: false,
    });
    expect(payload.evidenceScope).toEqual({
      liveCurrentBehaviorCaseIds: ['TC-7004'],
      deterministicBoundaryFixtureCaseIds: manifestCaseIds(payload.manifest),
      matrixExecutesLiveRefresh: false,
      fixtureObservedLossIsNotRuntimeIncidence: true,
    });
    expect(() => contract.assertObservationOnlyRetainedStatePayload({
      ...payload,
      nonPromotionGuard: {
        ...payload.nonPromotionGuard,
        promotesAuthority: true,
      },
    })).toThrow(/authority promotion is forbidden/u);
  });
});

function manifestCaseIds(manifest: { cases: Array<{ caseId: string }> }) {
  return manifest.cases.map((candidate) => candidate.caseId);
}

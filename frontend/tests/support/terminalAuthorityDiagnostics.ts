import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

const DIAGNOSTIC_FRAME_TYPES = new Set([
  'terminal-checkpoint:capability',
  'terminal-checkpoint:negotiate',
  'terminal-authority:view-attributes',
  'terminal-authority:view-attributes-accepted',
]);
const DIAGNOSTIC_CLIENT_EVENT_KINDS = new Set([
  'terminal_mounted',
  'terminal_disposed',
  'terminal_runtime_recreation_required',
  'terminal_runtime_recreation_recovery_installed',
  'terminal_runtime_recreation_recovery_install_failed',
  'terminal_runtime_recreation_recovery_handoff_discarded',
  'terminal_write_coordinator_recovery_requested',
  'terminal_checkpoint_invalid_frame_rejected',
  'terminal_checkpoint_inactive_frame_rejected',
  'terminal_checkpoint_server_rejected',
  'terminal_compatibility_rollback_started',
  'terminal_legacy_responder_runtime_rebound',
  'terminal_authority_fresh_compatibility_snapshot_requested',
  'visible_output_resync_retry_attempted',
  'visible_output_resync_retry_budget_exhausted',
  'screen_repair_reconnect_required',
]);
const AUTHORITY_MODES = new Set(['legacy', 'promoting', 'server', 'rolling-back']);
const RESOURCE_INVENTORY_KEYS = [
  'retainedPolicyOverrides',
  'cleanupTokens',
  'isolationLeases',
  'retainedCorpusFixtures',
  'alternateBufferFixtures',
  'responderOverrides',
  'listeners',
  'driverLeases',
  'responderLeases',
  'timers',
  'faultStates',
  'queryEffectLedgers',
  'heldOutputQueues',
] as const;

type JsonRecord = Record<string, unknown>;

export interface TerminalInputGateDebugEvent {
  readonly eventId: number;
  readonly kind: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CurrentMountInputGateSummary {
  readonly currentMountOpen: boolean;
  readonly latestMountEventId: number | null;
  readonly latestGateEventId: number | null;
  readonly inputReady: unknown;
  readonly captureState: unknown;
  readonly barrierReason: unknown;
  readonly restorePending: unknown;
  readonly geometryReady: unknown;
  readonly serverReady: unknown;
}

export function summarizeCurrentMountInputGate(
  events: readonly TerminalInputGateDebugEvent[],
): CurrentMountInputGateSummary {
  const latestMount = [...events].reverse().find(event => event.kind === 'terminal_mounted');
  const latestGate = [...events].reverse().find(event => event.kind === 'input_gate_synced');
  const currentMountOpen = Number.isSafeInteger(latestGate?.eventId)
    && (!latestMount || latestGate!.eventId > latestMount.eventId)
    && latestGate?.details?.inputReady === true
    && latestGate.details.captureState === 'open'
    && latestGate.details.barrierReason === 'none';
  return {
    currentMountOpen,
    latestMountEventId: Number.isSafeInteger(latestMount?.eventId) ? latestMount!.eventId : null,
    latestGateEventId: Number.isSafeInteger(latestGate?.eventId) ? latestGate!.eventId : null,
    inputReady: latestGate?.details?.inputReady ?? null,
    captureState: latestGate?.details?.captureState ?? null,
    barrierReason: latestGate?.details?.barrierReason ?? null,
    restorePending: latestGate?.details?.restorePending ?? null,
    geometryReady: latestGate?.details?.geometryReady ?? null,
    serverReady: latestGate?.details?.serverReady ?? null,
  };
}

export function hasCurrentMountOpenInputGate(
  events: readonly TerminalInputGateDebugEvent[],
): boolean {
  return summarizeCurrentMountInputGate(events).currentMountOpen;
}

export interface ConfiguredAuthorityDiagnosticFrame {
  direction: unknown;
  generation: unknown;
  origin: unknown;
  message: JsonRecord | null;
}

export interface ConfiguredAuthorityFailureDiagnosticInput {
  sessionId: string;
  preparation: JsonRecord;
  frames: readonly ConfiguredAuthorityDiagnosticFrame[];
  clientEvents: readonly unknown[];
  inventory: JsonRecord;
}

export interface CleanupAttemptSequenceResult<T> {
  cleanup: T | null;
  idempotentCleanup: T | null;
  firstError: unknown | null;
  idempotentError: unknown | null;
}

export interface CleanupAttemptSequenceOptions<T> {
  readonly retryFirstResponse?: (response: T) => boolean;
  readonly maxAttempts?: number;
}

export async function runCleanupAttemptSequence<T extends { httpStatus?: unknown }>(
  request: () => Promise<T>,
  options: CleanupAttemptSequenceOptions<T> = {},
): Promise<CleanupAttemptSequenceResult<T>> {
  let cleanup: T;
  try {
    cleanup = await request();
  } catch (firstError) {
    return { cleanup: null, idempotentCleanup: null, firstError, idempotentError: null };
  }
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  for (
    let attempt = 1;
    cleanup.httpStatus !== 200
      && attempt < maxAttempts
      && options.retryFirstResponse?.(cleanup) === true;
    attempt += 1
  ) {
    cleanup = await request();
  }
  if (cleanup.httpStatus !== 200) {
    return { cleanup, idempotentCleanup: null, firstError: null, idempotentError: null };
  }
  try {
    return {
      cleanup,
      idempotentCleanup: await request(),
      firstError: null,
      idempotentError: null,
    };
  } catch (idempotentError) {
    return { cleanup, idempotentCleanup: null, firstError: null, idempotentError };
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function fingerprint(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
    : null;
}

function boundedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function summarizePreparation(preparation: JsonRecord): JsonRecord {
  const error = asRecord(preparation.error);
  return {
    httpStatus: boundedInteger(preparation.httpStatus),
    accepted: booleanOrNull(preparation.accepted),
    errorCodeFingerprint: fingerprint(error?.code),
    errorMessageFingerprint: fingerprint(error?.message),
  };
}

function summarizeFrames(
  frames: readonly ConfiguredAuthorityDiagnosticFrame[],
  sessionId: string,
): JsonRecord[] {
  return frames.flatMap((frame, frameOffset) => {
    const message = asRecord(frame.message);
    const type = typeof message?.type === 'string' && DIAGNOSTIC_FRAME_TYPES.has(message.type)
      ? message.type
      : null;
    if (!message || !type) return [];
    const candidates = type === 'terminal-checkpoint:negotiate'
      ? message.views
      : type === 'terminal-checkpoint:capability'
        ? message.registeredViews
        : [message];
    const views = Array.isArray(candidates)
      ? candidates.flatMap(candidate => {
          const view = asRecord(candidate);
          if (!view || view.sessionId !== sessionId) return [];
          return [{
            viewGeneration: boundedInteger(view.viewGeneration),
            challengeFingerprint: fingerprint(view.viewAttributesChallengeId),
            driverLeaseGenerationFingerprint: fingerprint(view.driverLeaseGeneration),
            acceptedViewAttributesGenerationFingerprint: fingerprint(
              view.acceptedViewAttributesGeneration,
            ),
          }];
        }).slice(-8)
      : [];
    if (views.length === 0 && message.sessionId !== sessionId) return [];
    return [{
      frameOffset: boundedInteger(frameOffset),
      direction: frame.direction === 'page-to-server' || frame.direction === 'server-to-page'
        ? frame.direction
        : null,
      origin: frame.origin === 'routed-page' || frame.origin === 'routed-server'
        ? frame.origin
        : null,
      connectionGeneration: boundedInteger(frame.generation),
      type,
      viewGeneration: boundedInteger(message.viewGeneration),
      challengeFingerprint: fingerprint(message.viewAttributesChallengeId),
      connectionFingerprint: fingerprint(message.connectionId),
      accepted: booleanOrNull(message.accepted),
      reasonFingerprint: fingerprint(message.reason),
      views,
    }];
  }).slice(-64);
}

function summarizeClientEvents(events: readonly unknown[]): JsonRecord[] {
  return events.flatMap((item, eventOffset) => {
    const event = asRecord(item);
    const kind = typeof event?.kind === 'string' && DIAGNOSTIC_CLIENT_EVENT_KINDS.has(event.kind)
      ? event.kind
      : null;
    if (!event || !kind) return [];
    const details = asRecord(event.details);
    return [{
      eventOffset: boundedInteger(eventOffset),
      eventId: boundedInteger(event.eventId),
      kind,
      reasonFingerprint: fingerprint(details?.reason),
      viewGeneration: boundedInteger(details?.viewGeneration),
      attempt: boundedInteger(details?.attempt),
    }];
  }).slice(-64);
}

function summarizeResourceInventory(value: unknown): JsonRecord {
  const inventory = asRecord(value);
  return Object.fromEntries(RESOURCE_INVENTORY_KEYS.map(key => [
    key,
    boundedInteger(inventory?.[key]),
  ]));
}

function summarizeInventory(inventory: JsonRecord): JsonRecord {
  const authorityState = asRecord(inventory.authorityState);
  const capabilityState = asRecord(inventory.queryResponderCapabilityState);
  const audit = Array.isArray(inventory.authorityAuditTrail)
    ? inventory.authorityAuditTrail
    : [];
  return {
    diagnosticReadErrorFingerprint: fingerprint(inventory.diagnosticReadError),
    httpStatus: boundedInteger(inventory.httpStatus),
    authoritativeModelFingerprint: fingerprint(inventory.authoritativeModelInstanceId),
    authorityState: {
      mode: typeof authorityState?.mode === 'string' && AUTHORITY_MODES.has(authorityState.mode)
        ? authorityState.mode
        : null,
      heldPostBoundaryCount: boundedInteger(authorityState?.heldPostBoundaryCount),
    },
    queryResponderCapabilityState: {
      promotionEligible: booleanOrNull(capabilityState?.promotionEligible),
      blockerFingerprint: fingerprint(capabilityState?.blocker),
      hasAcceptedViewAttributes: booleanOrNull(capabilityState?.hasAcceptedViewAttributes),
    },
    attachedResponderViewCount: boundedInteger(inventory.attachedResponderViewCount),
    resourceInventory: summarizeResourceInventory(inventory.resourceInventory),
    authorityAuditTrail: audit.slice(-32).map(item => {
      const event = asRecord(item);
      return {
        typeFingerprint: fingerprint(event?.type),
        kindFingerprint: fingerprint(event?.kind),
        connectionFingerprint: fingerprint(event?.connectionId),
        viewGeneration: boundedInteger(event?.viewGeneration),
        streamEpochFingerprint: fingerprint(event?.streamEpoch),
      };
    }),
  };
}

export function formatConfiguredAuthorityFailureDiagnostic(
  input: ConfiguredAuthorityFailureDiagnosticInput,
): string {
  const preparation = summarizePreparation(input.preparation);
  const frames = summarizeFrames(input.frames, input.sessionId);
  const clientEvents = summarizeClientEvents(input.clientEvents);
  const inventory = summarizeInventory(input.inventory);
  const diagnostic = JSON.stringify({
    schemaVersion: 'ph005-configured-authority-diagnostic/v1',
    preparation,
    frames,
    clientEvents,
    inventory,
  });
  if (Buffer.byteLength(diagnostic, 'utf8') <= CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES) {
    return diagnostic;
  }
  const reducedInventory = {
    ...inventory,
    authorityAuditTrail: Array.isArray(inventory.authorityAuditTrail)
      ? inventory.authorityAuditTrail.slice(-8)
      : [],
  };
  const reduced = JSON.stringify({
    schemaVersion: 'ph005-configured-authority-diagnostic/v1',
    truncated: true,
    preparation,
    frames: frames.slice(-16).map(frame => ({
      ...frame,
      views: Array.isArray(frame.views) ? frame.views.slice(-2) : [],
    })),
    clientEvents,
    inventory: reducedInventory,
  });
  if (Buffer.byteLength(reduced, 'utf8') <= CONFIGURED_AUTHORITY_DIAGNOSTIC_MAX_BYTES) {
    return reduced;
  }
  return JSON.stringify({
    schemaVersion: 'ph005-configured-authority-diagnostic/v1',
    truncated: true,
    preparation,
    clientEvents,
  });
}

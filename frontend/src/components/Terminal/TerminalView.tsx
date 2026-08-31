import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { usePinchZoom } from '../../hooks/usePinchZoom';
import { useResponsive } from '../../hooks/useResponsive';
import { FontSizeToast } from './FontSizeToast';
import {
  clearTerminalSnapshotRemovalRequest,
  getTerminalSnapshotKey,
  isTerminalSnapshotRemovalRequested,
  parseTerminalViewportSnapshot,
  setTerminalSnapshotWithQuotaRecovery,
  TERMINAL_SNAPSHOT_PAYLOAD_KIND,
  TERMINAL_SNAPSHOT_SCHEMA_VERSION,
  type TerminalViewportSnapshotBufferType,
  type TerminalViewportSnapshotPayload,
} from '../../utils/terminalSnapshot';
import {
  buildClientInputDebugMetadata,
  buildTerminalEventTapeDetails,
  buildTerminalInputDebugPayload,
  buildTerminalInputDebugPayloadFromMetadata,
  isTerminalDebugCaptureEnabled,
  registerInputGateSnapshotReader,
  registerInputTransportOverrideHandler,
  registerTerminalRepairLayoutHandler,
  registerTerminalRetainedStateCaptureHandler,
  registerTerminalRetainedStateStreamingCaptureHandler,
  recordTerminalDebugEvent,
} from '../../utils/terminalDebugCapture';
import {
  getInputReliabilityMode,
  getSnapshotResourceLimits,
  getTerminalResourceLimits,
} from '../../utils/inputReliabilityMode';
import {
  bindTerminalOutputPolicyRuntime,
  createTerminalOutputIngressRetryQueue,
  createTerminalOutputPolicySelectionCoordinator,
  createTerminalOutputPolicyRuntime,
  createTerminalOutputScheduler,
  createTerminalRestoreHeldOutputCoverageTransaction,
  createTerminalRestoreReleaseSingleFlight,
  flushNextTerminalRestoreBufferedOutput,
  isTerminalRestoreAttemptCurrent,
  TERMINAL_OUTPUT_POLICY_SELECTION_ID,
  type TerminalOutputFifoProbeSettlement,
  type TerminalOutputIngressRetryQueue,
  type TerminalOutputPolicyRuntime,
  type TerminalOutputPolicySelectionCoordinator,
  type TerminalOutputScheduler,
  type TerminalOutputWriteData,
  type TerminalRestoreHeldOutputCoverageTransaction,
  type TerminalRestoreHeldOutputEntry,
  type TerminalRestoreAttemptFenceIdentity,
} from '../../utils/terminalOutputScheduler';
import {
  createTerminalClipboardCoordinator,
  type TerminalClipboardActionResult,
  type TerminalClipboardSelection,
  type TerminalClipboardSource,
  type TerminalClipboardTarget,
} from '../../utils/terminalClipboardCoordinator';
import {
  resolveTerminalXtermOptions,
  TERMINAL_XTERM_THEME,
} from '../../utils/terminalViewAttributes';

type OutputFifoProbeResult = TerminalOutputFifoProbeSettlement | 'failed';
import {
  createTerminalViewRestoreAdapter,
  type BoundTerminalRestoreAdapter,
  type TerminalRestoreAdapterOptions,
} from '../../utils/visibleOutputRecovery';
import {
  getCachedTerminalOutputResourceLimits,
  getOutputUtf8ByteLength,
} from '../../utils/terminalOutputHotPath';
import {
  createTerminalReplayInputGuard,
  TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS,
  writeTerminalReplayWithFifoProbe,
  type TerminalReplayWriteLease,
} from '../../utils/terminalReplayGuard';
import {
  shouldDropStaleRepeatedTerminalKey,
} from '../../utils/terminalStaleKeyRepeat';
import {
  captureTerminalRetainedState,
  captureTerminalRetainedStateStreaming,
  createTerminalRetainedStateEvidence,
  type CanonicalTerminalRetainedState,
} from '../../utils/terminalRetainedState';
import {
  ImeTransaction,
  type ImeDeferredKind,
} from '../../utils/imeTransaction';
import {
  createTerminalWriteCoordinator,
  type TerminalWriteCoordinator,
} from '../../utils/terminalWriteCoordinator';
import {
  createTerminalCheckpointRuntime,
  createTerminalResponderHandoffRuntime,
  isTerminalCheckpointMutationLeaseReady,
  resolveTerminalCheckpointInputRoute,
  type TerminalCheckpointRuntime,
  type TerminalResponderHandoffRuntime,
} from '../../utils/terminalCheckpointRuntime';
import {
  createTerminalInputKindRouter,
  disposeTerminalPendingInputQueueLifetime,
} from '../../utils/terminalInputSequencer';
import { isTerminalQueryReply } from '../../utils/terminalQueryReply';
import {
  createTerminalWriteCoordinatorAdapter,
  digestTerminalBytes,
} from '../../utils/terminalWriteCoordinatorRuntime';
import {
  buildTerminalShortcutKeyDescriptor,
  describeTerminalShortcutKey,
  resolveTerminalShortcut,
} from '../../utils/terminalShortcutBindings';
import type { TerminalShortcutState } from '../../types';
import type {
  InputDebugMetadata,
  ReconnectState,
  ScreenRepairBufferType,
  ScreenRepairFailedReason,
  ScreenRepairMessage,
  TerminalInputBarrierReason,
  TerminalInputClosedReason,
  TerminalInputTransportOverride,
  TerminalInputTransportState,
  TerminalAuthorityQueryReplyResponderIdentity,
  TerminalAuthorityRollbackStartMessage,
  TerminalCompatibilityDrainIdentity,
  TerminalLegacyResponderEnabledMessage,
  TerminalResponderBoundaryIdentity,
  TerminalResponderDisableBoundaryMessage,
  TerminalResponderHandoffClientMessage,
  WindowsPtyInfo,
} from '../../types/ws-protocol';
import { useWebSocketActions } from '../../contexts/WebSocketContext';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';

const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 14;
const FONT_STORAGE_KEY = 'terminal_font_size';
const SNAPSHOT_SAVE_DEBOUNCE_MS = 2000;
const LARGE_WRITE_THRESHOLD = 10_000;
const MOBILE_TOUCH_PAN_THRESHOLD_PX = 12;
const INPUT_SETTLEMENT_LEDGER_MAX_ENTRIES = 4096;
const queueTextEncoder = new TextEncoder();
type TerminalCaptureState = 'open' | 'transient-blocked' | 'closed';
type InputRejectedReason =
  | 'timeout'
  | 'timeout-enter-safety'
  | 'queue-overflow'
  | 'context-changed'
  | 'unsupported-multiline-paste'
  | 'session-missing'
  | 'session-closed'
  | 'server-error'
  | 'auth-expired'
  | 'transport-closed'
  | 'checkpoint-recovery-required'
  | 'mode-observe-only';

export type TerminalInputSubmitResult =
  | { ok: true; status: 'sent' | 'queued'; source: string }
  | {
      ok: false;
      reason: InputRejectedReason;
      source: string;
      captureState: TerminalCaptureState;
      barrierReason: TerminalInputBarrierReason;
      closedReason: TerminalInputClosedReason;
    };

export type TerminalPasteInputResult = TerminalInputSubmitResult;

interface PendingTerminalInput {
  data: string;
  metadata: InputDebugMetadata;
  queuedAt: number;
  captureSeq: number;
  compositionSeq?: number;
  sessionGeneration: number;
  containsEnter: boolean;
  barrierReason: TerminalInputBarrierReason;
  byteLength: number;
  source: string;
}

function warnIfSnapshotStorageRecovered(
  result: ReturnType<typeof setTerminalSnapshotWithQuotaRecovery>,
  source: string,
): void {
  const retryRemovedCount = result.retryEviction?.removedCount ?? 0;
  if (result.eviction.removedCount === 0 && retryRemovedCount === 0 && !result.retried) {
    return;
  }

  console.warn(`[TerminalView] ${source} recovered terminal snapshot storage`, {
    retried: result.retried,
    removedCount: result.eviction.removedCount + retryRemovedCount,
    beforeChars: result.eviction.beforeChars,
    afterChars: result.retryEviction?.afterChars ?? result.eviction.afterChars,
  });
}

function getTerminalBufferType(term: Terminal): TerminalViewportSnapshotBufferType {
  return term.buffer.active.type === 'alternate' ? 'alternate' : 'normal';
}

function getInputQueueLimits(): { inputQueueMaxBytes: number; inputQueueTtlMs: number } {
  const limits = getTerminalResourceLimits();
  return {
    inputQueueMaxBytes: limits.inputQueueMaxBytes,
    inputQueueTtlMs: limits.inputQueueTtlMs,
  };
}

function hasPendingBrowserInput(): boolean {
  const scheduling = (navigator as unknown as {
    scheduling?: {
      isInputPending?: (options?: { includeContinuous?: boolean }) => boolean;
    };
  }).scheduling;
  return scheduling?.isInputPending?.({ includeContinuous: true }) === true;
}

function hasLineBreak(value: string): boolean {
  return value.includes('\r') || value.includes('\n');
}

// xterm.js v5는 방향키, Backspace 등 모든 제어 키를 네이티브로 처리.
// 커스텀 KEY_SEQUENCES 핸들러는 xterm 내부 IME/유니코드 파이프라인을 우회하여
// 한국어 등 CJK 입력 시 커서 위치 불일치 문제를 유발하므로 제거됨.

export interface TerminalHandle {
  submitOutput: (data: TerminalOutputWriteData, metadata?: TerminalOutputWriteMetadata) => void;
  writeAndWait: (data: string) => Promise<boolean>;
  writeRecoveryTailAndWait: (data: TerminalOutputWriteData) => Promise<boolean>;
  awaitOutputIdle: () => Promise<boolean>;
  probeOutputFifo: () => Promise<boolean>;
  getAuthorityViewGeneration: () => number | null;
  isCheckpointAuthorityActive: () => boolean;
  isCompatibilityRecoveryPending: () => boolean;
  bindRestoreCoordinator: (options: TerminalRestoreAdapterOptions) => BoundTerminalRestoreAdapter;
  submitClear: () => void;
  focus: (reason?: string) => void;
  hasSelection: () => boolean;
  getSelection: () => string;
  getMouseTrackingActive: () => boolean;
  clearSelection: () => void;
  copySelection: (source?: TerminalClipboardSource) => Promise<TerminalClipboardActionResult>;
  pasteClipboard: (source?: TerminalClipboardSource) => Promise<TerminalClipboardActionResult>;
  pasteText: (data: string, source?: TerminalClipboardSource) => TerminalClipboardActionResult;
  invalidateClipboardContext: () => void;
  fit: () => void;
  repairLayout: (reason?: string) => Promise<boolean>;
  requestGridRepair?: (reason?: GridRepairReason) => void;
  getScreenRepairReadiness: () => ScreenRepairReadiness;
  applyScreenRepair: (repair: ScreenRepairMessage) => Promise<ScreenRepairApplyResult>;
  clearVisibleOutputRecovery: () => void;
  sendInput: (data: string) => TerminalInputSubmitResult;
  restoreSnapshot: () => Promise<boolean>;
  replaceWithSnapshot: (
    data: string,
    shouldApply?: () => boolean,
    options?: TerminalSnapshotReplacementOptions,
  ) => Promise<boolean>;
  releasePending: () => void;
  completeCheckpointTakeover: () => void;
  setInputTransportState: (state: TerminalInputTransportState) => void;
  setServerReady: (ready: boolean) => void;
  setWindowsPty: (info?: WindowsPtyInfo) => void;
  captureRetainedState: () => CanonicalTerminalRetainedState | null;
}

export interface TerminalOutputWriteMetadata {
  readonly screenSeq?: number;
  readonly replayToken?: string;
  readonly authorityEpoch?: string;
  readonly authorityRevision?: number;
  readonly connectionGeneration?: number;
  readonly onWritten?: () => void;
  readonly onRejected?: () => void;
}

export interface TerminalSnapshotReplacementOptions {
  readonly onRejected?: (reason: string) => void;
  readonly failedHeldCoverage?: Readonly<{
    snapshotSeq: number;
    coversThroughSeq: number;
    replayToken: string;
    supersedesReplayToken?: string;
    authorityEpoch?: string;
    authorityRevision?: number;
    connectionGeneration: number;
  }>;
}

type TerminalRestoreAttemptIdentity = TerminalRestoreAttemptFenceIdentity<Terminal>;

interface ActiveTerminalRestoreCoverageTransaction {
  readonly attemptEpoch: number;
  readonly failedAttemptEpochs: readonly number[];
  readonly snapshotSeq: number;
  readonly transaction: TerminalRestoreHeldOutputCoverageTransaction;
}

interface TerminalFailedHeldProvenance {
  readonly failedAttemptEpochs: readonly number[];
  readonly minimumSnapshotSeq: number;
}

export type GridRepairReason = 'manual' | 'workspace' | 'resize';

export type ScreenRepairReadiness =
  | {
      ok: true;
      cols: number;
      rows: number;
      atBottom: boolean;
      bufferType: ScreenRepairBufferType;
    }
  | {
      ok: false;
      reason: ScreenRepairFailedReason;
      cols?: number;
      rows?: number;
      atBottom?: boolean;
      bufferType?: ScreenRepairBufferType;
    };

export type ScreenRepairApplyResult =
  | { ok: true }
  | { ok: false; reason: ScreenRepairFailedReason };

interface Props {
  sessionId: string;
  workspaceId: string;
  terminalShortcutState: TerminalShortcutState | null;
  isVisible: boolean;
  clipboardContextKey?: string | null;
  outputPolicyConnectionId: string;
  outputPolicyReconnectGeneration: number;
  outputPolicySelectionCoordinator?: TerminalOutputPolicySelectionCoordinator;
  onInput: (data: string, metadata?: InputDebugMetadata) => void;
  flushPendingUserInputBeforeQueryReply: (reason: string) => boolean;
  onResize: (cols: number, rows: number) => void;
  onManualRepair?: () => void;
  onRestorePendingSettled?: () => void;
  onCompatibilityAuthorityReady?: () => void;
  onVisibleOutputOverflow?: (info: {
    reason: string;
    droppedBytes: number;
    pendingBytes: number;
  }) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(
  ({ sessionId, workspaceId, terminalShortcutState, isVisible, clipboardContextKey, outputPolicyConnectionId, outputPolicyReconnectGeneration, outputPolicySelectionCoordinator, onInput, flushPendingUserInputBeforeQueryReply, onResize, onManualRepair, onRestorePendingSettled, onCompatibilityAuthorityReady, onVisibleOutputOverflow }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const xtermGenerationRef = useRef(0);
    const clipboardViewGenerationRef = useRef(0);
    const clipboardContextKeyRef = useRef(clipboardContextKey);
    // 우클릭 mousedown 캡처 시점에 저장 — DOM selectionchange가 xterm 선택을 지우기 전에 저장
    const savedRightClickSelRef = useRef<string>('');
    const savedRightClickSelGenerationRef = useRef(0);
    const savedRightClickSelXtermGenerationRef = useRef(0);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const [toastFontSize, setToastFontSize] = useState<number | null>(null);
    const [terminalRuntimeRevision, setTerminalRuntimeRevision] = useState(0);
    const runtimeRecreationRecoveryReasonRef = useRef<{
      sessionId: string;
      reason: string;
      recoveryRequested: boolean;
    } | null>(null);
    const legacyAuthorityReadySyncPendingRef = useRef(false);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const userActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const outputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const idleSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastSnapshotRef = useRef<string | null>(null);
    const restorePendingRef = useRef(true);
    const restoreAttemptEpochRef = useRef(1);
    const restoreReleaseSingleFlightRef = useRef(createTerminalRestoreReleaseSingleFlight());
    const inputReadyRef = useRef(false);
    const geometryReadyRef = useRef(false);
    const serverReadyRef = useRef(false);
    const captureStateRef = useRef<TerminalCaptureState>('closed');
    const captureAllowedRef = useRef(false);
    const transportReadyRef = useRef(false);
    const transportBarrierReasonRef = useRef<TerminalInputBarrierReason>('none');
    const transportClosedReasonRef = useRef<TerminalInputClosedReason>('terminal-disposed');
    const reconnectStateRef = useRef<ReconnectState>('disconnected');
    const sessionGenerationRef = useRef(1);
    const transportStateRef = useRef<TerminalInputTransportState>({
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'disconnected',
      sessionGeneration: 1,
    });
    const inputTransportOverrideRef = useRef<TerminalInputTransportOverride | null>(null);
    const pendingInputQueueRef = useRef<PendingTerminalInput[]>([]);
    const pendingInputQueueBytesRef = useRef(0);
    const inputQueueExpiryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const terminalDisposedRef = useRef(true);
    const terminalRestoreAdapterRef = useRef<BoundTerminalRestoreAdapter | null>(null);
    const replayInputGuardRef = useRef(createTerminalReplayInputGuard());
    const pendingFocusRestoreRef = useRef(false);
    const isVisibleRef = useRef(isVisible);
    const workspaceIdRef = useRef(workspaceId);
    const terminalShortcutStateRef = useRef<TerminalShortcutState | null>(terminalShortcutState);
    const previousVisibilityRef = useRef(isVisible);
    const committedVisibilityRef = useRef(isVisible);
    const bufferedOutputRef = useRef<TerminalRestoreHeldOutputEntry[]>([]);
    const bufferedOutputEntryIdRef = useRef(0);
    const bufferedOutputBytesRef = useRef(0);
    const bufferedOutputOverflowedRef = useRef(false);
    const restoreCoverageTransactionRef = useRef<ActiveTerminalRestoreCoverageTransaction | null>(null);
    const failedHeldProvenanceRef = useRef<TerminalFailedHeldProvenance | null>(null);
    const inFlightOutputRef = useRef<TerminalOutputWriteData[]>([]);
    const outputSchedulerRef = useRef<TerminalOutputScheduler | null>(null);
    const outputIngressRetryQueueRef = useRef<TerminalOutputIngressRetryQueue | null>(null);
    const outputSchedulerTermRef = useRef<Terminal | null>(null);
    const terminalWriteCoordinatorRef = useRef<TerminalWriteCoordinator | null>(null);
    const terminalCheckpointRuntimeRef = useRef<TerminalCheckpointRuntime | null>(null);
    const terminalResponderHandoffRuntimeRef = useRef<TerminalResponderHandoffRuntime | null>(null);
    const unregisterTerminalResponderRuntimeRef = useRef<(() => void) | null>(null);
    const legacyParserRepliesEnabledRef = useRef(true);
    const terminalQueryResponderIdentityRef = useRef<TerminalAuthorityQueryReplyResponderIdentity | null>(null);
    const terminalQueryReplyOrdinalRef = useRef(0);
    const pendingCompatibilityRollbackRef = useRef<Readonly<{
      message: TerminalAuthorityRollbackStartMessage;
      identity: TerminalResponderBoundaryIdentity;
    }> | null>(null);
    const checkpointInputBarrierRef = useRef(false);
    const checkpointMutationLeaseBarrierRef = useRef(false);
    const outputPolicyRuntimeRef = useRef<TerminalOutputPolicyRuntime | null>(null);
    const activeOutputPolicySelectionCoordinatorRef = useRef<TerminalOutputPolicySelectionCoordinator | null>(null);
    const defaultOutputPolicySelectionCoordinatorRef = useRef<TerminalOutputPolicySelectionCoordinator | null>(null);
    if (!defaultOutputPolicySelectionCoordinatorRef.current) {
      defaultOutputPolicySelectionCoordinatorRef.current = createTerminalOutputPolicySelectionCoordinator();
    }
    const outputPolicyConfigRef = useRef({
      connectionId: outputPolicyConnectionId,
      reconnectGeneration: outputPolicyReconnectGeneration,
      selectionCoordinator: outputPolicySelectionCoordinator,
    });
    const mobilePanStartRef = useRef<{ x: number; y: number } | null>(null);
    const mobilePanLastYRef = useRef<number | null>(null);
    const mobilePanResidualYRef = useRef(0);
    const mobilePanActiveRef = useRef(false);
    const mobilePinchActiveRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    // IME 조합 상태 추적: compositionend/keydown(Space) race condition 보조 신호
    const isComposingRef = useRef<boolean>(false);
    const captureSeqRef = useRef(0);
    const programmaticPasteRef = useRef<{
      source: string;
      captureSeq: number;
      result: TerminalInputSubmitResult | null;
    } | null>(null);
    const imeTransaction = useMemo(() => new ImeTransaction(), []);
    const imeTransactionRef = useRef<ImeTransaction | null>(imeTransaction);
    const { isMobile } = useResponsive();
    const {
      send,
      registerTerminalCheckpointDispatcher,
      refreshTerminalCheckpointRegistration,
      registerTerminalResponderHandoffView,
      registerTerminalResponderHandoffRuntime,
      getTerminalControlSocketReceipt,
      sendTerminalAuthorityControl,
    } = useWebSocketActions();
    const checkpointSendRef = useRef(send);

    useLayoutEffect(() => {
      outputPolicyConfigRef.current = {
        connectionId: outputPolicyConnectionId,
        reconnectGeneration: outputPolicyReconnectGeneration,
        selectionCoordinator: outputPolicySelectionCoordinator,
      };
    }, [
      outputPolicyConnectionId,
      outputPolicyReconnectGeneration,
      outputPolicySelectionCoordinator,
    ]);

    useLayoutEffect(() => {
      checkpointSendRef.current = send;
    }, [send]);

    const getTerminalWriteCoordinator = useCallback((term: Terminal): TerminalWriteCoordinator | null => (
      xtermRef.current === term && !terminalDisposedRef.current
        ? terminalWriteCoordinatorRef.current
        : null
    ), []);

    useLayoutEffect(() => {
      const visibilityChanged = committedVisibilityRef.current !== isVisible;
      committedVisibilityRef.current = isVisible;
      isVisibleRef.current = isVisible;
      if (visibilityChanged) {
        clipboardViewGenerationRef.current += 1;
      }
    }, [isVisible]);

    useLayoutEffect(() => {
      if (clipboardContextKeyRef.current !== clipboardContextKey) {
        clipboardContextKeyRef.current = clipboardContextKey;
        clipboardViewGenerationRef.current += 1;
      }
    }, [clipboardContextKey]);

    useEffect(() => {
      imeTransaction.configure({
        getSessionGeneration: () => sessionGenerationRef.current,
        onEvent: (kind, details) => {
          recordTerminalDebugEvent(sessionId, kind, details);
        },
        onStateChange: (snapshot) => {
          isComposingRef.current = snapshot.state !== 'idle';
        },
      });
    }, [imeTransaction, sessionId]);

    const getHelperTextarea = useCallback((): HTMLTextAreaElement | null => {
      const element = terminalRef.current?.querySelector('textarea.xterm-helper-textarea');
      return element instanceof HTMLTextAreaElement ? element : null;
    }, []);

    const nextCaptureSeq = useCallback(() => {
      captureSeqRef.current += 1;
      return captureSeqRef.current;
    }, []);

    const getEffectiveTransportState = useCallback((): TerminalInputTransportState => {
      const base = transportStateRef.current;
      const override = inputTransportOverrideRef.current;
      if (!override) {
        return base;
      }

      return {
        ...base,
        ...override,
        reconnectState: override.reconnectState ?? base.reconnectState,
        sessionGeneration: override.sessionGeneration ?? base.sessionGeneration,
      };
    }, []);

    const mapClosedReasonToRejectReason = useCallback((
      closedReason: TerminalInputClosedReason,
    ): InputRejectedReason => {
      switch (closedReason) {
        case 'session-exited':
          return 'session-closed';
        case 'session-missing':
          return 'session-missing';
        case 'server-error':
          return 'server-error';
        case 'auth-expired':
          return 'auth-expired';
        case 'ws-closed-without-reconnect':
          return 'transport-closed';
        case 'terminal-hidden':
        case 'terminal-disposed':
        case 'workspace-or-session-changed':
        case 'none':
        default:
          return 'context-changed';
      }
    }, []);

    const getQueueByteLength = useCallback((raw: string): number => {
      return queueTextEncoder.encode(raw).length;
    }, []);

    const computeInputGateSnapshot = useCallback(() => {
      const term = xtermRef.current;
      const transportState = getEffectiveTransportState();
      const closedReason: TerminalInputClosedReason =
        !term || terminalDisposedRef.current
          ? 'terminal-disposed'
          : !isVisibleRef.current
            ? 'terminal-hidden'
            : transportState.closedReason;

      let barrierReason: TerminalInputBarrierReason = 'none';
      if (closedReason === 'none') {
        if (restorePendingRef.current) {
          barrierReason = 'restore-pending';
        } else if (checkpointInputBarrierRef.current) {
          barrierReason = 'checkpoint-pending';
        } else if (checkpointMutationLeaseBarrierRef.current) {
          barrierReason = 'checkpoint-pending';
        } else if (!geometryReadyRef.current) {
          barrierReason = 'initial-geometry-pending';
        } else if (transportState.barrierReason !== 'none') {
          barrierReason = transportState.barrierReason;
        } else if (transportState.reconnectState === 'reconnecting') {
          barrierReason = 'ws-reconnecting-short';
        } else if (!transportState.serverReady) {
          barrierReason = 'repair-server-not-ready';
        }
      }

      const captureState: TerminalCaptureState =
        closedReason !== 'none'
          ? 'closed'
          : barrierReason !== 'none'
            ? 'transient-blocked'
            : 'open';
      const captureAllowed = captureState !== 'closed';
      const transportReady = Boolean(
        term
        && captureAllowed
        && barrierReason === 'none'
        && transportState.serverReady
        && geometryReadyRef.current
        && !restorePendingRef.current
        && isVisibleRef.current
      );

      return {
        term,
        transportState,
        captureState,
        captureAllowed,
        transportReady,
        barrierReason,
        closedReason,
      };
    }, [getEffectiveTransportState]);

    const focusTerminalInput = useCallback((reason: string) => {
      const term = xtermRef.current;
      const helperTextarea = getHelperTextarea();

      term?.focus();
      helperTextarea?.focus({ preventScroll: true });

      const activeElement = document.activeElement;
      const focusApplied = activeElement === helperTextarea && helperTextarea !== null;
      recordTerminalDebugEvent(sessionId, focusApplied ? 'focus_applied' : 'focus_fallback_applied', {
        reason,
        helperPresent: helperTextarea !== null,
        inputReady: inputReadyRef.current,
        transportReady: transportReadyRef.current,
        captureAllowed: captureAllowedRef.current,
        restorePending: restorePendingRef.current,
      });
    }, [getHelperTextarea, sessionId]);

    const hasTerminalFocus = useCallback(() => {
      const terminalElement = terminalRef.current;
      const helperTextarea = getHelperTextarea();
      const activeElement = document.activeElement;
      return Boolean(
        (helperTextarea && activeElement === helperTextarea)
        || (terminalElement && activeElement instanceof Node && terminalElement.contains(activeElement))
        || containerRef.current?.classList.contains('terminal-focused')
      );
    }, [getHelperTextarea]);

    const queueFocusRestoreIfFocused = useCallback((reason: string) => {
      if (!isVisibleRef.current || !hasTerminalFocus()) {
        return;
      }

      pendingFocusRestoreRef.current = true;
      containerRef.current?.classList.add('terminal-focused');
      recordTerminalDebugEvent(sessionId, 'focus_restore_queued', { reason });
    }, [hasTerminalFocus, sessionId]);

    const restoreQueuedFocus = useCallback((reason: string) => {
      if (!pendingFocusRestoreRef.current || !captureAllowedRef.current || !isVisibleRef.current) {
        return;
      }

      const helperTextarea = getHelperTextarea();
      if (!helperTextarea || helperTextarea.disabled) {
        return;
      }

      const activeElement = document.activeElement;
      const terminalElement = terminalRef.current;
      const activeIsThisTerminal = Boolean(
        activeElement
        && terminalElement
        && activeElement instanceof Node
        && terminalElement.contains(activeElement)
      );
      const activeIsNeutral = !activeElement
        || activeElement === document.body
        || activeElement === document.documentElement;

      if (!activeIsThisTerminal && !activeIsNeutral) {
        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
        recordTerminalDebugEvent(sessionId, 'focus_restore_cancelled', { reason, activeTag: activeElement?.tagName ?? null });
        return;
      }

      pendingFocusRestoreRef.current = false;
      focusTerminalInput(`restore-${reason}`);
      containerRef.current?.classList.add('terminal-focused');
      recordTerminalDebugEvent(sessionId, 'focus_restored_after_gate', { reason });
    }, [focusTerminalInput, getHelperTextarea, sessionId]);

    const rejectQueuedInput = useCallback((
      entry: PendingTerminalInput,
      reason: InputRejectedReason,
      detailReason: string = reason,
    ) => {
      const debugInput = buildTerminalInputDebugPayloadFromMetadata(entry.metadata);
      recordTerminalDebugEvent(sessionId, 'terminal_input_rejected', {
        ...debugInput.details,
        reason,
        detailReason,
        barrierReason: entry.barrierReason,
        source: entry.source,
        queuedMs: Math.max(0, Date.now() - entry.queuedAt),
        queuedSessionGeneration: entry.sessionGeneration,
        currentSessionGeneration: sessionGenerationRef.current,
      }, debugInput.preview);
    }, [sessionId]);

    const expirePendingInputQueue = useCallback(() => {
      const now = Date.now();
      const { inputQueueTtlMs } = getInputQueueLimits();
      const remaining: PendingTerminalInput[] = [];
      let remainingBytes = 0;

      for (const entry of pendingInputQueueRef.current) {
        if (now - entry.queuedAt > inputQueueTtlMs) {
          rejectQueuedInput(entry, entry.containsEnter ? 'timeout-enter-safety' : 'timeout');
          continue;
        }
        remaining.push(entry);
        remainingBytes += entry.byteLength;
      }

      pendingInputQueueRef.current = remaining;
      pendingInputQueueBytesRef.current = remainingBytes;
    }, [rejectQueuedInput]);

    const scheduleInputQueueExpiry = useCallback(() => {
      const { inputQueueTtlMs } = getInputQueueLimits();
      const timer = setTimeout(() => {
        inputQueueExpiryTimersRef.current.delete(timer);
        expirePendingInputQueue();
      }, inputQueueTtlMs + 25);
      inputQueueExpiryTimersRef.current.add(timer);
    }, [expirePendingInputQueue]);

    const rejectPendingInputQueue = useCallback((reason: InputRejectedReason, detailReason: string = reason) => {
      const entries = pendingInputQueueRef.current;
      if (entries.length === 0) {
        return;
      }
      pendingInputQueueRef.current = [];
      pendingInputQueueBytesRef.current = 0;
      for (const entry of entries) {
        rejectQueuedInput(entry, reason, detailReason);
      }
    }, [rejectQueuedInput]);

    const flushPendingInputQueue = useCallback((reason: string) => {
      if (!transportReadyRef.current || pendingInputQueueRef.current.length === 0) {
        return;
      }

      const entries = pendingInputQueueRef.current;
      pendingInputQueueRef.current = [];
      pendingInputQueueBytesRef.current = 0;
      const now = Date.now();
      const { inputQueueTtlMs } = getInputQueueLimits();

      for (const entry of entries) {
        const debugInput = buildTerminalInputDebugPayloadFromMetadata(entry.metadata);

        if (entry.sessionGeneration !== sessionGenerationRef.current) {
          rejectQueuedInput(entry, 'context-changed', 'context-changed');
          continue;
        }
        if (now - entry.queuedAt > inputQueueTtlMs) {
          rejectQueuedInput(entry, entry.containsEnter ? 'timeout-enter-safety' : 'timeout');
          continue;
        }
        if (captureStateRef.current === 'closed') {
          rejectQueuedInput(entry, mapClosedReasonToRejectReason(transportClosedReasonRef.current));
          continue;
        }

        recordTerminalDebugEvent(sessionId, 'queued_input_flushed', {
          ...debugInput.details,
          reason,
          barrierReason: entry.barrierReason,
          source: entry.source,
          queuedMs: Math.max(0, now - entry.queuedAt),
          sessionGeneration: entry.sessionGeneration,
        }, debugInput.preview);
        onInput(entry.data, entry.metadata);
      }
    }, [mapClosedReasonToRejectReason, onInput, rejectQueuedInput, sessionId]);

    const enqueuePendingInput = useCallback((
      data: string,
      debugInput: ReturnType<typeof buildTerminalInputDebugPayload>,
      source: string,
    ): TerminalInputSubmitResult => {
      const metadata = buildClientInputDebugMetadata(debugInput.details);
      const captureSeq = metadata.captureSeq ?? nextCaptureSeq();
      metadata.captureSeq = captureSeq;
      const byteLength =
        typeof debugInput.details.byteLength === 'number'
          ? debugInput.details.byteLength
          : getQueueByteLength(data);
      const { inputQueueMaxBytes } = getInputQueueLimits();
      const entry: PendingTerminalInput = {
        data,
        metadata,
        queuedAt: Date.now(),
        captureSeq,
        compositionSeq: metadata.compositionSeq,
        sessionGeneration: sessionGenerationRef.current,
        containsEnter: metadata.clientObservedHasEnter === true || debugInput.details.hasEnter === true,
        barrierReason: transportBarrierReasonRef.current,
        byteLength,
        source,
      };

      if (entry.byteLength > inputQueueMaxBytes) {
        recordTerminalDebugEvent(sessionId, 'terminal_input_queue_overflow', {
          ...debugInput.details,
          reason: 'queue-overflow',
          source,
          queuedByteBudget: inputQueueMaxBytes,
          attemptedByteLength: entry.byteLength,
          pendingQueueBytes: pendingInputQueueBytesRef.current,
        }, debugInput.preview);
        rejectQueuedInput(entry, 'queue-overflow');
        return {
          ok: false,
          reason: 'queue-overflow',
          source,
          captureState: captureStateRef.current,
          barrierReason: transportBarrierReasonRef.current,
          closedReason: transportClosedReasonRef.current,
        };
      }

      pendingInputQueueRef.current.push(entry);
      pendingInputQueueBytesRef.current += entry.byteLength;
      while (pendingInputQueueBytesRef.current > inputQueueMaxBytes && pendingInputQueueRef.current.length > 0) {
        const overflowed = pendingInputQueueRef.current.shift();
        if (!overflowed) {
          break;
        }
        pendingInputQueueBytesRef.current -= overflowed.byteLength;
        recordTerminalDebugEvent(sessionId, 'terminal_input_queue_overflow', {
          reason: 'queue-overflow',
          source: overflowed.source,
          droppedCaptureSeq: overflowed.captureSeq,
          pendingQueueBytes: pendingInputQueueBytesRef.current,
          queuedByteBudget: inputQueueMaxBytes,
        });
        rejectQueuedInput(overflowed, 'queue-overflow');
      }

      recordTerminalDebugEvent(sessionId, 'terminal_input_queued', {
        ...debugInput.details,
        source,
        barrierReason: entry.barrierReason,
        sessionGeneration: entry.sessionGeneration,
        pendingQueueDepth: pendingInputQueueRef.current.length,
        pendingQueueBytes: pendingInputQueueBytesRef.current,
      }, debugInput.preview);
      scheduleInputQueueExpiry();
      return { ok: true, status: 'queued', source };
    }, [getQueueByteLength, nextCaptureSeq, rejectQueuedInput, scheduleInputQueueExpiry, sessionId]);

    const submitCapturedInputDirect = useCallback((
      data: string,
      debugInput: ReturnType<typeof buildTerminalInputDebugPayload>,
      source: string,
    ): TerminalInputSubmitResult => {
      if (transportReadyRef.current) {
        const sentEventKind = source === 'imperative'
          ? 'imperative_input_sent'
          : source === 'shortcut-binding'
            ? 'shortcut_binding_sent'
            : source === 'command-preset-paste'
              ? 'command_preset_paste_input_sent'
              : 'xterm_data_emitted';
        recordTerminalDebugEvent(sessionId, sentEventKind, debugInput.details, debugInput.preview);
        onInput(data, buildClientInputDebugMetadata(debugInput.details));
        return { ok: true, status: 'sent', source };
      }

      const mode = getInputReliabilityMode();
      if (captureAllowedRef.current && captureStateRef.current === 'transient-blocked') {
        if (mode === 'observe') {
          recordTerminalDebugEvent(sessionId, 'terminal_input_would_queue', {
            ...debugInput.details,
            reason: 'mode-observe-only',
            source,
            barrierReason: transportBarrierReasonRef.current,
            sessionGeneration: sessionGenerationRef.current,
          }, debugInput.preview);
          return {
            ok: false,
            reason: 'mode-observe-only',
            source,
            captureState: captureStateRef.current,
            barrierReason: transportBarrierReasonRef.current,
            closedReason: transportClosedReasonRef.current,
          };
        }

        return enqueuePendingInput(data, debugInput, source);
      }

      const rejectReason = mapClosedReasonToRejectReason(transportClosedReasonRef.current);
      const eventKind = mode === 'observe' ? 'terminal_input_would_reject' : 'terminal_input_rejected';
      recordTerminalDebugEvent(sessionId, eventKind, {
        ...debugInput.details,
        reason: rejectReason,
        source,
        captureState: captureStateRef.current,
        barrierReason: transportBarrierReasonRef.current,
        closedReason: transportClosedReasonRef.current,
        sessionGeneration: sessionGenerationRef.current,
      }, debugInput.preview);
      return {
        ok: false,
        reason: rejectReason,
        source,
        captureState: captureStateRef.current,
        barrierReason: transportBarrierReasonRef.current,
        closedReason: transportClosedReasonRef.current,
      };
    }, [enqueuePendingInput, mapClosedReasonToRejectReason, onInput, sessionId]);

    const submitCapturedInput = useCallback((
      data: string,
      debugInput: ReturnType<typeof buildTerminalInputDebugPayload>,
      source: string,
    ): TerminalInputSubmitResult => {
      const runtime = terminalCheckpointRuntimeRef.current;
      if (!runtime) {
        return submitCapturedInputDirect(data, debugInput, source);
      }
      const runtimeState = runtime.getState();
      const inputRoute = resolveTerminalCheckpointInputRoute(runtimeState);
      if (inputRoute === 'direct') {
        return submitCapturedInputDirect(data, debugInput, source);
      }
      if (inputRoute === 'pending-input-queue') {
        if (captureStateRef.current === 'closed') {
          return submitCapturedInputDirect(data, debugInput, source);
        }
        return enqueuePendingInput(data, debugInput, source);
      }
      const wasReady = terminalWriteCoordinatorRef.current?.getState().ready === true;
      const result = runtime.submitInput(data);
      if (!result.accepted) {
        recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_input_rejected', {
          reason: result.reason ?? 'checkpoint-input-rejected',
          source,
        });
        return {
          ok: false,
          reason: 'checkpoint-recovery-required',
          source,
          captureState: captureStateRef.current,
          barrierReason: 'checkpoint-pending',
          closedReason: transportClosedReasonRef.current,
        };
      }
      recordTerminalDebugEvent(sessionId, wasReady
        ? 'terminal_checkpoint_input_released'
        : 'terminal_checkpoint_input_queued', {
        source,
        viewGeneration: runtime.getState().viewGeneration,
      });
      return { ok: true, status: wasReady ? 'sent' : 'queued', source };
    }, [enqueuePendingInput, sessionId, submitCapturedInputDirect]);

    const syncInputReadiness = useCallback((reason: string) => {
      const gate = computeInputGateSnapshot();
      const shouldPublishLegacyAuthorityReady = legacyAuthorityReadySyncPendingRef.current
        && gate.transportReady
        && !restorePendingRef.current;
      const effectiveReason = shouldPublishLegacyAuthorityReady
        ? 'terminal-authority-legacy'
        : reason;
      if (shouldPublishLegacyAuthorityReady) {
        legacyAuthorityReadySyncPendingRef.current = false;
      }
      const term = gate.term;
      const helperTextarea = getHelperTextarea();
      const imeSnapshot = imeTransactionRef.current?.getSnapshot() ?? null;
      const imeActive = imeSnapshot !== null && imeSnapshot.state !== 'idle';
      const previousSessionGeneration = sessionGenerationRef.current;
      const deferrableTransientBoundary =
        imeActive
        && gate.closedReason === 'none'
        && gate.captureState === 'transient-blocked';
      serverReadyRef.current = gate.transportState.serverReady;
      reconnectStateRef.current = gate.transportState.reconnectState ?? 'disconnected';
      sessionGenerationRef.current = gate.transportState.sessionGeneration;
      if (imeActive && previousSessionGeneration !== gate.transportState.sessionGeneration) {
        imeTransactionRef.current?.dispose();
        recordTerminalDebugEvent(sessionId, 'ime_transaction_cancelled', {
          reason: effectiveReason,
          previousSessionGeneration,
          currentSessionGeneration: gate.transportState.sessionGeneration,
        });
      }
      const effectiveImeSnapshot = imeTransactionRef.current?.getSnapshot() ?? imeSnapshot;
      captureStateRef.current = gate.captureState;
      captureAllowedRef.current = gate.captureAllowed;
      transportReadyRef.current = gate.transportReady;
      transportBarrierReasonRef.current = gate.barrierReason;
      transportClosedReasonRef.current = gate.closedReason;
      inputReadyRef.current = gate.transportReady;

      if (term) {
        term.options.disableStdin = !gate.captureAllowed;
      }
      if (helperTextarea) {
        helperTextarea.disabled = !gate.captureAllowed;
        helperTextarea.readOnly = false;
      }

      if (deferrableTransientBoundary) {
        recordTerminalDebugEvent(sessionId, 'ime_capture_close_deferred', {
          reason,
          imeState: effectiveImeSnapshot?.state ?? 'idle',
          compositionSeq: effectiveImeSnapshot?.compositionSeq ?? null,
          sessionGeneration: effectiveImeSnapshot?.sessionGeneration ?? gate.transportState.sessionGeneration,
          barrierReason: gate.barrierReason,
          closedReason: gate.closedReason,
        });
      }

      recordTerminalDebugEvent(sessionId, 'input_gate_synced', {
        reason: effectiveReason,
        inputReady: gate.transportReady,
        transportReady: gate.transportReady,
        captureAllowed: gate.captureAllowed,
        captureState: gate.captureState,
        barrierReason: gate.barrierReason,
        closedReason: gate.closedReason,
        reconnectState: gate.transportState.reconnectState ?? null,
        sessionGeneration: gate.transportState.sessionGeneration,
        serverReady: gate.transportState.serverReady,
        geometryReady: geometryReadyRef.current,
        restorePending: restorePendingRef.current,
        visible: isVisibleRef.current,
        helperDisabled: helperTextarea?.disabled ?? null,
        helperReadOnly: helperTextarea?.readOnly ?? null,
        disableStdin: term?.options.disableStdin ?? null,
        imeState: effectiveImeSnapshot?.state ?? 'idle',
        compositionSeq: effectiveImeSnapshot?.compositionSeq ?? null,
      });

      if (!gate.captureAllowed) {
        rejectPendingInputQueue(mapClosedReasonToRejectReason(gate.closedReason), gate.closedReason);
        return;
      }

      if (gate.transportReady) {
        flushPendingInputQueue(effectiveReason);
        restoreQueuedFocus(effectiveReason);
      }
    }, [
      computeInputGateSnapshot,
      flushPendingInputQueue,
      getHelperTextarea,
      mapClosedReasonToRejectReason,
      rejectPendingInputQueue,
      restoreQueuedFocus,
      sessionId,
    ]);

    const emitResize = useCallback((cols: number, rows: number, reason: string) => {
      recordTerminalDebugEvent(sessionId, 'resize_emitted', { cols, rows, reason });
      onResize(cols, rows);
    }, [onResize, sessionId]);

    const submitTerminalFit = useCallback((
      term: Terminal,
      onApplied?: () => void,
      onRejected?: () => void,
    ): boolean => {
      const coordinator = getTerminalWriteCoordinator(term);
      if (!coordinator) {
        onRejected?.();
        return false;
      }
      const decision = coordinator.submitCompatibility({
        type: 'fit',
        viewGeneration: xtermGenerationRef.current,
        onApplied,
        onRejected,
      });
      return decision.accepted;
    }, [getTerminalWriteCoordinator]);

    const waitForImeIdle = useCallback(async (kind: ImeDeferredKind, reason: string): Promise<boolean> => {
      const ime = imeTransactionRef.current;
      if (!ime) {
        return true;
      }

      const result = await ime.waitForIdle(kind, reason);
      if (result.status === 'ready') {
        return true;
      }

      recordTerminalDebugEvent(sessionId, 'ime_deferred_action_skipped', {
        reason,
        deferredKind: kind,
        status: result.status,
        sessionGeneration: sessionGenerationRef.current,
      });
      return false;
    }, [sessionId]);

    const requestViewportSync = useCallback((term: Terminal, fitFirst = false) => {
      let attempts = 0;

      const syncViewport = () => {
        if (xtermRef.current !== term) return;

        try {
          const container = containerRef.current;
          const isRenderable = Boolean(
            isVisibleRef.current &&
            container &&
            container.offsetWidth > 0 &&
            container.offsetHeight > 0
          );
          const scrollToBottom = () => {
            if (xtermRef.current === term && isRenderable) term.scrollToBottom();
          };
          if (fitFirst && isRenderable) {
            submitTerminalFit(term, scrollToBottom, () => {
              attempts += 1;
              if (attempts < 2) requestAnimationFrame(syncViewport);
            });
            return;
          }
          scrollToBottom();
        } catch (error) {
          attempts += 1;
          if (attempts < 2) {
            requestAnimationFrame(syncViewport);
            return;
          }
          console.warn('[TerminalView] viewport sync failed:', error);
        }
      };

      requestAnimationFrame(syncViewport);
    }, [submitTerminalFit]);

    const performRepairLayout = useCallback((reason = 'repair-layout') => new Promise<boolean>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const term = xtermRef.current;
          const container = containerRef.current;
          const fitAddon = fitAddonRef.current;
          if (!term || !fitAddon || !isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
            recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
              width: container?.offsetWidth ?? 0,
                height: container?.offsetHeight ?? 0,
                reason,
              });
            resolve(true);
            return;
          }

          submitTerminalFit(term, () => {
            recordTerminalDebugEvent(sessionId, 'fit_completed', {
              cols: term.cols,
              rows: term.rows,
              reason,
            });
            geometryReadyRef.current = true;
            syncInputReadiness(reason);
            emitResize(term.cols, term.rows, reason);
            resolve(true);
          }, () => resolve(false));
        });
      });
    }), [emitResize, sessionId, submitTerminalFit, syncInputReadiness]);

    const repairLayoutAfterIme = useCallback(async (reason = 'repair-layout') => {
      const ready = await waitForImeIdle('repair', reason);
      if (!ready) {
        return false;
      }

      return performRepairLayout(reason);
    }, [performRepairLayout, waitForImeIdle]);

    const handleFontSizeChange = useCallback((size: number) => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (term && fitAddon) {
        term.options.fontSize = size;
        requestViewportSync(term, true);
        // Show toast — always reset timer even for same size value
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToastFontSize(size);
        toastTimerRef.current = setTimeout(() => {
          setToastFontSize(null);
          toastTimerRef.current = null;
        }, 1200);
      }
    }, [requestViewportSync]);

    const { handleTouchStart, handleTouchMove, handleTouchEnd, getInitialFontSize } = usePinchZoom({
      minSize: FONT_MIN,
      maxSize: FONT_MAX,
      defaultSize: FONT_DEFAULT,
      onFontSizeChange: handleFontSizeChange,
    });

    const resetMobileTouchGesture = useCallback(() => {
      mobilePanStartRef.current = null;
      mobilePanLastYRef.current = null;
      mobilePanResidualYRef.current = 0;
      mobilePanActiveRef.current = false;
      mobilePinchActiveRef.current = false;
    }, []);

    const getTerminalCellHeight = useCallback((): number => {
      const row = terminalRef.current?.querySelector('.xterm-rows > div');
      if (row instanceof HTMLElement) {
        const height = row.getBoundingClientRect().height;
        if (height > 0) {
          return height;
        }
      }

      const term = xtermRef.current;
      const host = terminalRef.current;
      if (!term || !host || term.rows <= 0) {
        return 0;
      }

      const hostHeight = host.getBoundingClientRect().height;
      return hostHeight > 0 ? hostHeight / term.rows : 0;
    }, []);

    const handleMobileTouchStart = useCallback((event: TouchEvent) => {
      handleTouchStart(event);

      if (event.touches.length === 2) {
        mobilePinchActiveRef.current = true;
        suppressNextClickRef.current = true;
        mobilePanStartRef.current = null;
        mobilePanLastYRef.current = null;
        mobilePanResidualYRef.current = 0;
        mobilePanActiveRef.current = false;
        return;
      }

      if (event.touches.length !== 1) {
        resetMobileTouchGesture();
        return;
      }

      const touch = event.touches[0];
      mobilePinchActiveRef.current = false;
      mobilePanActiveRef.current = false;
      mobilePanResidualYRef.current = 0;
      mobilePanStartRef.current = { x: touch.clientX, y: touch.clientY };
      mobilePanLastYRef.current = touch.clientY;
    }, [handleTouchStart, resetMobileTouchGesture]);

    const handleMobileTouchMove = useCallback((event: TouchEvent) => {
      handleTouchMove(event);

      const term = xtermRef.current;
      if (!term) {
        return;
      }

      if (event.touches.length === 2) {
        mobilePinchActiveRef.current = true;
        suppressNextClickRef.current = true;
        mobilePanStartRef.current = null;
        mobilePanLastYRef.current = null;
        mobilePanResidualYRef.current = 0;
        mobilePanActiveRef.current = false;
        return;
      }

      if (event.touches.length !== 1 || mobilePinchActiveRef.current) {
        return;
      }

      const touch = event.touches[0];
      const panStart = mobilePanStartRef.current;
      if (!panStart) {
        return;
      }

      const totalDeltaX = touch.clientX - panStart.x;
      const totalDeltaY = touch.clientY - panStart.y;

      if (!mobilePanActiveRef.current) {
        if (Math.abs(totalDeltaY) < MOBILE_TOUCH_PAN_THRESHOLD_PX) {
          return;
        }

        if (Math.abs(totalDeltaY) <= Math.abs(totalDeltaX)) {
          return;
        }

        mobilePanActiveRef.current = true;
        suppressNextClickRef.current = true;
        recordTerminalDebugEvent(sessionId, 'mobile_touch_pan_started', {
          startX: Math.round(panStart.x),
          startY: Math.round(panStart.y),
          deltaY: Math.round(totalDeltaY),
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY,
        });
      }

      if (event.cancelable) {
        event.preventDefault();
      }

      const previousY = mobilePanLastYRef.current ?? touch.clientY;
      const deltaY = touch.clientY - previousY;
      mobilePanLastYRef.current = touch.clientY;
      mobilePanResidualYRef.current += deltaY;

      const cellHeight = getTerminalCellHeight();
      if (cellHeight <= 0) {
        return;
      }

      const rowDelta = Math.trunc(mobilePanResidualYRef.current / cellHeight);
      if (rowDelta === 0) {
        return;
      }

      mobilePanResidualYRef.current -= rowDelta * cellHeight;

      const viewportBefore = term.buffer.active.viewportY;
      const baseY = term.buffer.active.baseY;
      term.scrollLines(-rowDelta);
      const viewportAfter = term.buffer.active.viewportY;

      if (viewportAfter !== viewportBefore) {
        recordTerminalDebugEvent(sessionId, 'mobile_touch_scroll_applied', {
          gestureRows: rowDelta,
          scrollLines: -rowDelta,
          viewportBefore,
          viewportAfter,
          baseY,
          cellHeight: Math.round(cellHeight),
        });
      }
    }, [getTerminalCellHeight, handleTouchMove, sessionId]);

    const finishMobileTouchGesture = useCallback((reason: string) => {
      const term = xtermRef.current;
      if (mobilePanActiveRef.current && term) {
        recordTerminalDebugEvent(sessionId, 'mobile_touch_pan_ended', {
          reason,
          viewportY: term.buffer.active.viewportY,
          baseY: term.buffer.active.baseY,
        });
      }

      handleTouchEnd();
      resetMobileTouchGesture();
    }, [handleTouchEnd, resetMobileTouchGesture, sessionId]);

    const clearStoredSnapshot = useCallback(() => {
      try {
        localStorage.removeItem(getTerminalSnapshotKey(sessionId));
      } catch {
        // ignore localStorage failures
      }
      lastSnapshotRef.current = null;
    }, [sessionId]);

    const loadStoredSnapshot = useCallback((): TerminalViewportSnapshotPayload | null => {
      const snapshotLimits = getSnapshotResourceLimits();
      try {
        const raw = localStorage.getItem(getTerminalSnapshotKey(sessionId));
        const snapshot = parseTerminalViewportSnapshot(raw, sessionId, {
          maxContentLength: snapshotLimits.perSnapshotMaxChars,
        });
        if (!snapshot) {
          clearStoredSnapshot();
          return null;
        }

        return snapshot;
      } catch {
        clearStoredSnapshot();
        return null;
      }
    }, [sessionId, clearStoredSnapshot]);

    const saveSnapshot = useCallback(() => {
      const term = xtermRef.current;
      const serializeAddon = serializeAddonRef.current;
      if (!term || !serializeAddon) return;
      if (restorePendingRef.current) return;
      const snapshotLimits = getSnapshotResourceLimits();
      if (isTerminalSnapshotRemovalRequested(sessionId, { tombstoneTtlMs: snapshotLimits.tombstoneTtlMs })) return;

      try {
        const content = serializeAddon.serialize({ scrollback: 0 });
        if (!content) return;
        if (content.length > snapshotLimits.perSnapshotMaxChars) {
          console.warn('[TerminalView] snapshot too large, keeping previous snapshot');
          return;
        }
        const storedSnapshot = parseTerminalViewportSnapshot(
          localStorage.getItem(getTerminalSnapshotKey(sessionId)),
          sessionId,
          { maxContentLength: snapshotLimits.perSnapshotMaxChars },
        );
        const bufferType = getTerminalBufferType(term);
        if (
          content === lastSnapshotRef.current
          && storedSnapshot?.content === content
          && storedSnapshot.cols === term.cols
          && storedSnapshot.rows === term.rows
          && storedSnapshot.bufferType === bufferType
        ) {
          return;
        }

        const snapshot: TerminalViewportSnapshotPayload = {
          schemaVersion: TERMINAL_SNAPSHOT_SCHEMA_VERSION,
          payloadKind: TERMINAL_SNAPSHOT_PAYLOAD_KIND,
          sessionId,
          content,
          cols: term.cols,
          rows: term.rows,
          bufferType,
          savedAt: new Date().toISOString(),
        };
        const result = setTerminalSnapshotWithQuotaRecovery(sessionId, JSON.stringify(snapshot), {
          maxTotalChars: snapshotLimits.totalStorageBudgetChars,
          maxEntries: snapshotLimits.maxEntries,
        });
        if (!result.saved) {
          console.warn('[TerminalView] snapshot save failed after quota recovery:', result.error);
          return;
        }
        warnIfSnapshotStorageRecovered(result, 'snapshot save');
        lastSnapshotRef.current = content;
      } catch (error) {
        console.warn('[TerminalView] snapshot save failed:', error);
      }
    }, [sessionId]);

    const scheduleSnapshotSave = useCallback(() => {
      if (idleSnapshotTimerRef.current) clearTimeout(idleSnapshotTimerRef.current);
      idleSnapshotTimerRef.current = setTimeout(() => {
        saveSnapshot();
        idleSnapshotTimerRef.current = null;
      }, SNAPSHOT_SAVE_DEBOUNCE_MS);
    }, [saveSnapshot]);

    const writeOutputDirect = useCallback((
      term: Terminal,
      data: TerminalOutputWriteData,
      onWritten?: () => void,
      onRejected?: () => void,
    ) => {
      const coordinator = getTerminalWriteCoordinator(term);
      if (!coordinator) {
        onRejected?.();
        return;
      }
      inFlightOutputRef.current.push(data);
      let settled = false;
      const settleWrite = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        inFlightOutputRef.current.shift();
        if (data.length > LARGE_WRITE_THRESHOLD) {
          requestViewportSync(term);
        }
        scheduleSnapshotSave();
        if (accepted) onWritten?.();
        else onRejected?.();
      };
      const decision = coordinator.submitCompatibility({
        type: 'write',
        viewGeneration: xtermGenerationRef.current,
        kind: 'live',
        data,
        onWritten: () => settleWrite(true),
        onRejected: () => settleWrite(false),
      });
      if (!decision.accepted) {
        settleWrite(false);
      }

      const el = containerRef.current;
      if (el && !el.classList.contains('output-active')) {
        el.classList.add('output-active');
      }
      if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
      outputTimerRef.current = setTimeout(() => {
        containerRef.current?.classList.remove('output-active');
      }, 2000);
    }, [getTerminalWriteCoordinator, scheduleSnapshotSave, requestViewportSync]);

    const getOutputScheduler = useCallback((term: Terminal): TerminalOutputScheduler => {
      const limits = getCachedTerminalOutputResourceLimits();
      const outputPolicyConfig = outputPolicyConfigRef.current;
      const nextTarget = {
        viewId: sessionId,
        connectionId: outputPolicyConfig.connectionId,
        reconnectGeneration: outputPolicyConfig.reconnectGeneration,
      };
      const outputPolicyRuntime = outputPolicyRuntimeRef.current;
      const selectionCoordinator = outputPolicyConfig.selectionCoordinator
        ?? defaultOutputPolicySelectionCoordinatorRef.current!;
      const selectionChanged = activeOutputPolicySelectionCoordinatorRef.current !== selectionCoordinator;
      const terminalIdentityChanged = outputSchedulerTermRef.current !== term;
      const targetChanged = !outputPolicyRuntime
        || outputPolicyRuntime.target.viewId !== nextTarget.viewId
        || outputPolicyRuntime.target.connectionId !== nextTarget.connectionId
        || outputPolicyRuntime.target.reconnectGeneration !== nextTarget.reconnectGeneration;
      if (!outputSchedulerRef.current || terminalIdentityChanged || targetChanged || selectionChanged) {
        outputIngressRetryQueueRef.current?.reset();
        outputIngressRetryQueueRef.current = null;
        if (outputSchedulerRef.current) {
          if (terminalIdentityChanged) {
            outputSchedulerRef.current?.reset('terminal-identity-changed');
          } else if (targetChanged || selectionChanged) {
            outputSchedulerRef.current.reset('policy-target-changed');
          }
        }
        let outputPolicyRuntime = outputPolicyRuntimeRef.current;
        if (targetChanged || selectionChanged) {
          outputPolicyRuntime = createTerminalOutputPolicyRuntime({
            target: nextTarget,
            selection: selectionCoordinator.select({
              selectionId: TERMINAL_OUTPUT_POLICY_SELECTION_ID,
              policyGeneration: outputPolicyConfig.reconnectGeneration + 1,
              target: nextTarget,
            }),
          });
          outputPolicyRuntimeRef.current = outputPolicyRuntime;
          activeOutputPolicySelectionCoordinatorRef.current = selectionCoordinator;
        }
        if (!outputPolicyRuntime) {
          throw new Error('Terminal output policy runtime was not initialized for the active connection target');
        }
        outputSchedulerTermRef.current = term;
        const outputScheduler = createTerminalOutputScheduler({
          visibleOutputQueueMaxBytes: limits.visibleOutputQueueMaxBytes,
          visibleOutputMaxChunks: limits.visibleOutputMaxChunks,
          visibleFlushBudgetBytes: limits.visibleFlushBudgetBytes,
          write: (chunk, onWritten, onRejected) => writeOutputDirect(term, chunk, onWritten, onRejected),
          shouldYield: hasPendingBrowserInput,
          canaryTarget: outputPolicyRuntime.target,
          validateCanaryPolicyLease: outputPolicyRuntime.validate,
        });
        outputSchedulerRef.current = outputScheduler;
        outputIngressRetryQueueRef.current = createTerminalOutputIngressRetryQueue({
          maxBytes: limits.visibleOutputQueueMaxBytes,
          maxChunks: limits.visibleOutputMaxChunks,
          maxSingleIngressBytes: limits.visibleOutputQueueMaxBytes,
          attempt: (data, onWritten) => {
            const decision = typeof data === 'string'
              ? outputScheduler.enqueue(data, onWritten)
              : outputScheduler.enqueueBytes(data, onWritten);
            if (decision.ok) return 'accepted';
            return decision.reason === 'canary-admission-rejected' ? 'retryable' : 'failed';
          },
          attemptLegacy: (data, onWritten) => {
            const decision = typeof data === 'string'
              ? outputScheduler.enqueueLegacy(data, onWritten)
              : outputScheduler.enqueueBytesLegacy(data, onWritten);
            if (decision.ok) return 'accepted';
            return decision.reason === 'canary-admission-rejected' ? 'retryable' : 'failed';
          },
          isIdle: outputScheduler.isIdle,
          armBarrier: onReady => outputScheduler.enqueueBarrier(onReady).ok,
          armLegacyBarrier: onReady => outputScheduler.enqueueReliableBarrier(onReady).ok,
          onLegacyFallback: (info) => {
            recordTerminalDebugEvent(sessionId, 'visible_output_ingress_retry_legacy_fallback', {
              reason: info.reason,
              retainedBytes: info.bytes,
              retainedChunks: info.chunks,
              pendingBytes: outputScheduler.pendingBytes(),
            });
          },
          onIngressRejected: (info) => {
            recordTerminalDebugEvent(sessionId, 'visible_output_ingress_contract_rejected', info);
          },
        });
        bindTerminalOutputPolicyRuntime(outputPolicyRuntime, outputScheduler);
        return outputScheduler;
      }

      outputSchedulerRef.current.configure({
        visibleOutputQueueMaxBytes: limits.visibleOutputQueueMaxBytes,
        visibleOutputMaxChunks: limits.visibleOutputMaxChunks,
        visibleFlushBudgetBytes: limits.visibleFlushBudgetBytes,
      });
      return outputSchedulerRef.current;
    }, [
      sessionId,
      writeOutputDirect,
    ]);

    const writeOutput = useCallback((
      term: Terminal,
      data: TerminalOutputWriteData,
      onWritten?: () => void,
      completeOnOverflow = true,
      onRejected?: () => void,
    ): boolean => {
      const scheduler = getOutputScheduler(term);
      const retryQueue = outputIngressRetryQueueRef.current;
      if (!retryQueue) {
        throw new Error('Terminal output ingress retry queue was not initialized with the output scheduler');
      }
      const deferRetry = (rejectedBytes: number): boolean => {
        const deferred = retryQueue.defer({
          data,
          onWritten: onWritten ?? (() => {}),
          onRejected: onRejected ?? (() => {}),
        });
        const retrySnapshot = retryQueue.getSnapshot();
        recordTerminalDebugEvent(sessionId, 'visible_output_canary_admission_rejected', {
          reason: 'canary-admission-rejected',
          rejectedBytes,
          pendingBytes: scheduler.pendingBytes(),
          deferredBehindFifo: deferred,
          retryQueuedBytes: retrySnapshot.queuedBytes,
          retryQueuedChunks: retrySnapshot.queuedChunks,
        });
        return deferred;
      };

      if (retryQueue.getSnapshot().queuedChunks > 0) {
        return deferRetry(getOutputUtf8ByteLength(data));
      }

      const decision = typeof data === 'string'
        ? scheduler.enqueue(data, onWritten, onRejected)
        : scheduler.enqueueBytes(data, onWritten, onRejected);
      if (decision.ok) return true;
      if (decision.reason === 'canary-admission-rejected') {
        return deferRetry(decision.rejectedBytes);
      }

      recordTerminalDebugEvent(sessionId, 'visible_output_overflow', {
        reason: decision.reason,
        droppedBytes: decision.droppedBytes,
        pendingBytes: scheduler.pendingBytes(),
      });
      onVisibleOutputOverflow?.({
        reason: decision.reason,
        droppedBytes: decision.droppedBytes,
        pendingBytes: scheduler.pendingBytes(),
      });
      if (completeOnOverflow) onWritten?.();
      else onRejected?.();
      return false;
    }, [getOutputScheduler, onVisibleOutputOverflow, sessionId]);

    const retainFailedHeldProvenance = useCallback((
      additionalEpochs: readonly number[] = [],
      minimumSnapshotSeq = failedHeldProvenanceRef.current?.minimumSnapshotSeq ?? 0,
    ): TerminalFailedHeldProvenance => {
      const failedAttemptEpochs = [...new Set([
        ...(failedHeldProvenanceRef.current?.failedAttemptEpochs ?? []),
        ...additionalEpochs,
        ...bufferedOutputRef.current.map(entry => entry.attemptEpoch),
      ])];
      const provenance = Object.freeze({
        failedAttemptEpochs: Object.freeze(failedAttemptEpochs),
        minimumSnapshotSeq: Math.max(
          failedHeldProvenanceRef.current?.minimumSnapshotSeq ?? 0,
          minimumSnapshotSeq,
        ),
      });
      failedHeldProvenanceRef.current = provenance;
      return provenance;
    }, []);

    const clearBufferedOutput = useCallback((clearOverflow = true): void => {
      bufferedOutputRef.current = [];
      bufferedOutputBytesRef.current = 0;
      restoreCoverageTransactionRef.current = null;
      failedHeldProvenanceRef.current = null;
      if (clearOverflow) {
        bufferedOutputOverflowedRef.current = false;
      }
    }, []);

    const recomputeBufferedOutputBytes = useCallback((): void => {
      bufferedOutputBytesRef.current = bufferedOutputRef.current.reduce(
        (total, entry) => total + getOutputUtf8ByteLength(entry.data),
        0,
      );
    }, []);

    const rollbackRestoreCoverageTransaction = useCallback((attemptEpoch?: number): boolean => {
      const active = restoreCoverageTransactionRef.current;
      if (!active || (attemptEpoch !== undefined && active.attemptEpoch !== attemptEpoch)) {
        return false;
      }
      bufferedOutputRef.current = [...active.transaction.rollback(bufferedOutputRef.current)];
      restoreCoverageTransactionRef.current = null;
      recomputeBufferedOutputBytes();
      bufferedOutputOverflowedRef.current = true;
      retainFailedHeldProvenance(active.failedAttemptEpochs, active.snapshotSeq);
      return true;
    }, [recomputeBufferedOutputBytes, retainFailedHeldProvenance]);

    // @req REL-BGSTAB-009
    const bufferOutputWhileRestorePending = useCallback((
      data: TerminalOutputWriteData,
      metadata?: TerminalOutputWriteMetadata,
    ): boolean => {
      // Measure first and test that, rather than `.length`. For `Uint8Array`
      // `.length` happens to equal the byte count, so the old guard was right by
      // accident — but only for that one view type, and it reads as a string test.
      const byteLength = getOutputUtf8ByteLength(data);
      if (byteLength === 0) return true;
      if (bufferedOutputOverflowedRef.current) return false;

      const limits = getCachedTerminalOutputResourceLimits();
      const nextBytes = bufferedOutputBytesRef.current + byteLength;
      const nextChunks = bufferedOutputRef.current.length + 1;
      if (
        byteLength > limits.visibleOutputQueueMaxBytes
        || nextBytes > limits.visibleOutputQueueMaxBytes
        || nextChunks > limits.visibleOutputMaxChunks
      ) {
        const droppedBytes = byteLength;
        rollbackRestoreCoverageTransaction();
        bufferedOutputOverflowedRef.current = true;
        retainFailedHeldProvenance([restoreAttemptEpochRef.current]);
        recordTerminalDebugEvent(sessionId, 'restore_pending_output_overflow', {
          droppedBytes,
          retainedBytes: bufferedOutputBytesRef.current,
          retainedChunks: bufferedOutputRef.current.length,
          maxBytes: limits.visibleOutputQueueMaxBytes,
          maxChunks: limits.visibleOutputMaxChunks,
        });
        onVisibleOutputOverflow?.({
          reason: 'visible-output-overflow',
          droppedBytes,
          pendingBytes: bufferedOutputBytesRef.current,
        });
        return false;
      }

      bufferedOutputEntryIdRef.current += 1;
      bufferedOutputRef.current.push({
        id: bufferedOutputEntryIdRef.current,
        data,
        screenSeq: metadata?.screenSeq,
        replayToken: metadata?.replayToken,
        authorityEpoch: metadata?.authorityEpoch,
        authorityRevision: metadata?.authorityRevision,
        connectionGeneration: metadata?.connectionGeneration,
        onWritten: metadata?.onWritten,
        attemptEpoch: restoreAttemptEpochRef.current,
      });
      bufferedOutputBytesRef.current = nextBytes;
      return true;
    }, [onVisibleOutputOverflow, retainFailedHeldProvenance, rollbackRestoreCoverageTransaction, sessionId]);

    // @req REL-BGSTAB-008
    const writeOutputAndWait = useCallback((data: string): Promise<boolean> => {
      const term = xtermRef.current;
      if (!term || terminalDisposedRef.current || (restorePendingRef.current && data.length > 0)) {
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        if (data.length === 0) {
          const decision = getOutputScheduler(term).enqueueBarrier(() => {
            resolve(xtermRef.current === term && !terminalDisposedRef.current);
          });
          if (!decision.ok) resolve(false);
          return;
        }
        const accepted = writeOutput(term, data, () => {
          resolve(xtermRef.current === term && !terminalDisposedRef.current);
        }, false, () => resolve(false));
        if (!accepted) {
          resolve(false);
        }
      });
    }, [getOutputScheduler, writeOutput]);

    // @req REL-BGSTAB-009
    // This direct empty write is only used after a bounded scheduler callback
    // wait. Its callback proves all earlier xterm FIFO writes drained, so the
    // scheduler may safely retire a callback token that will never arrive.
    const probeOutputFifo = useCallback((): Promise<OutputFifoProbeResult> => {
      const term = xtermRef.current;
      if (!term || terminalDisposedRef.current) {
        return Promise.resolve('failed');
      }
      const scheduler = getOutputScheduler(term);
      const probeIdentity = scheduler.captureFifoProbeIdentity();
      if (!probeIdentity) {
        return Promise.resolve('failed');
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = (written: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          const current = xtermRef.current === term && !terminalDisposedRef.current;
          resolve(
            written && current
              ? scheduler.settleFifoProbe(probeIdentity)
              : 'failed',
          );
        };
        const timeoutHandle = setTimeout(
          () => settle(false),
          TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS,
        );
        const coordinator = getTerminalWriteCoordinator(term);
        if (!coordinator) {
          settle(false);
          return;
        }
        const decision = coordinator.submitCompatibility({
          type: 'write',
          viewGeneration: xtermGenerationRef.current,
          kind: 'repair',
          data: '',
          onWritten: () => settle(true),
          onRejected: () => settle(false),
        });
        if (!decision.accepted) settle(false);
      });
    }, [getOutputScheduler, getTerminalWriteCoordinator]);

    // @req REL-BGSTAB-009
    const awaitOutputIdleWithFifoProbe = useCallback((): Promise<boolean> => {
      const term = xtermRef.current;
      if (!term || terminalDisposedRef.current) {
        return Promise.resolve(false);
      }
      const scheduler = getOutputScheduler(term);
      return new Promise((resolve) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const settle = (idle: boolean): void => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(idle && xtermRef.current === term && !terminalDisposedRef.current);
        };
        const waitForIdleBarrier = (): void => {
          if (settled) return;
          let probing = false;
          const decision = scheduler.enqueueBarrier(() => {
            if (!probing) settle(true);
          });
          if (!decision.ok) {
            settle(false);
            return;
          }
          if (settled) return;
          timeoutHandle = setTimeout(() => {
            probing = true;
            timeoutHandle = null;
            void probeOutputFifo().then((probeResult) => {
              if (settled) return;
              if (probeResult === 'failed' || probeResult === 'stale') {
                settle(false);
                return;
              }
              if (scheduler.isIdle()) {
                settle(true);
                return;
              }
              waitForIdleBarrier();
            });
          }, TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS);
        };
        waitForIdleBarrier();
      });
    }, [getOutputScheduler, probeOutputFifo]);

    // @req MIG-BGSTAB-002 AC-2 AC-3
    // Parser-generated terminal query replies bypass the normal 8 ms user-input
    // coalescer, but only after synchronously flushing all older user input and
    // obtaining an exact control-socket enqueue fence.
    const routeTerminalQueryReply = useCallback((data: string): Readonly<{
      accepted: boolean;
      reason?: string;
    }> => {
      const responderIdentity = terminalQueryResponderIdentityRef.current;
      if (!responderIdentity) {
        return Object.freeze({ accepted: false, reason: 'query-responder-identity-unavailable' });
      }
      const initialReceipt = getTerminalControlSocketReceipt();
      if (!initialReceipt.ok) {
        return Object.freeze({ accepted: false, reason: initialReceipt.reason });
      }
      const router = createTerminalInputKindRouter({
        controlSocketId: initialReceipt.controlSocketId,
        getCurrentResponderIdentity: () => terminalQueryResponderIdentityRef.current,
        submitUserInput: () => undefined,
        flushPendingUserInputBeforeQueryReply: () => {
          if (!flushPendingUserInputBeforeQueryReply('query-reply-boundary')) {
            return {
              ok: false as const,
              reason: 'pending-user-input-not-drained',
              controlSocketId: initialReceipt.controlSocketId,
            };
          }
          return getTerminalControlSocketReceipt();
        },
        sendQueryReplyImmediate: input => sendTerminalAuthorityControl({
          message: {
            type: 'input',
            inputKind: 'query-reply',
            sessionId,
            data: input.data,
            replyOrdinal: input.replyOrdinal,
            responderIdentity,
          },
          expectedControlSocketId: input.expectedControlSocketId,
          afterEnqueueOrdinal: input.afterEnqueueOrdinal,
        }),
      });
      const replyOrdinal = terminalQueryReplyOrdinalRef.current;
      const result = router.route({
        inputKind: 'query-reply',
        data,
        replyOrdinal,
        responderIdentity,
      });
      if (result.accepted) {
        terminalQueryReplyOrdinalRef.current += 1;
      }
      return result;
    }, [
      flushPendingUserInputBeforeQueryReply,
      getTerminalControlSocketReceipt,
      sendTerminalAuthorityControl,
      sessionId,
    ]);

    // @req FR-BGSTAB-022 AC-5
    // Compatibility recovery must observe the coordinator's physical xterm
    // callback. The normal scheduled write path deliberately retires rejected
    // callbacks, so it cannot be used as proof that a post-ACK tail drained.
    const writeRecoveryTailAndWait = useCallback(async (data: TerminalOutputWriteData): Promise<boolean> => {
      const term = xtermRef.current;
      const authorityViewGeneration = terminalCheckpointRuntimeRef.current?.getState().viewGeneration;
      if (
        !term
        || terminalDisposedRef.current
        || restorePendingRef.current
        || authorityViewGeneration === undefined
      ) {
        return false;
      }
      const idle = await awaitOutputIdleWithFifoProbe();
      if (
        !idle
        || xtermRef.current !== term
        || terminalDisposedRef.current
        || restorePendingRef.current
        || terminalCheckpointRuntimeRef.current?.getState().viewGeneration !== authorityViewGeneration
      ) {
        return false;
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = (written: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(
            written
            && xtermRef.current === term
            && !terminalDisposedRef.current
            && terminalCheckpointRuntimeRef.current?.getState().viewGeneration
              === authorityViewGeneration,
          );
        };
        const coordinator = getTerminalWriteCoordinator(term);
        if (!coordinator) {
          settle(false);
          return;
        }
        const decision = coordinator.submitCompatibility({
          type: 'write',
          viewGeneration: authorityViewGeneration,
          kind: 'repair',
          data,
          onWritten: () => settle(true),
          onRejected: () => settle(false),
        });
        if (!decision.accepted) settle(false);
      });
    }, [awaitOutputIdleWithFifoProbe, getTerminalWriteCoordinator]);

    // @req REL-BGSTAB-009
    // A missing xterm callback is not treated as success. An empty FIFO write
    // proves that the preceding replay write drained; if that probe also
    // wedges, only this generation-bound lease is released and the caller
    // receives an observable failure while input remains behind recovery.
    const writeReplayDataWithProbe = useCallback((
      term: Terminal,
      data: string,
      existingLease?: TerminalReplayWriteLease,
    ): Promise<boolean> => writeTerminalReplayWithFifoProbe({
      data,
      guard: replayInputGuardRef.current,
      existingLease,
      write: (payload, onWritten) => {
        const coordinator = getTerminalWriteCoordinator(term);
        if (!coordinator) throw new Error('terminal-write-coordinator-unavailable');
        const decision = coordinator.submitCompatibility({
          type: 'write',
          viewGeneration: xtermGenerationRef.current,
          kind: 'repair',
          data: payload,
          onWritten,
        });
        if (!decision.accepted) {
          throw new Error(decision.reason ?? 'terminal-replay-write-rejected');
        }
      },
      isCurrent: () => (
        xtermRef.current === term
        && !terminalDisposedRef.current
      ),
      timeoutMs: TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS,
    }), [getTerminalWriteCoordinator]);

    const flushBufferedOutput = useCallback((
      attemptEpoch: number,
      onSettled?: (success: boolean) => void,
    ) => {
      const term = xtermRef.current;
      const isCurrentAttempt = () => (
        restoreAttemptEpochRef.current === attemptEpoch
        && restorePendingRef.current
        && xtermRef.current === term
        && !terminalDisposedRef.current
      );
      if (!term || !isCurrentAttempt()) {
        onSettled?.(false);
        return;
      }
      if (bufferedOutputRef.current.length === 0) {
        onSettled?.(!bufferedOutputOverflowedRef.current);
        return;
      }

      const writeNext = (): void => {
        if (!isCurrentAttempt()) {
          onSettled?.(false);
          return;
        }
        const pending = bufferedOutputRef.current[0];
        if (pending === undefined) {
          bufferedOutputBytesRef.current = 0;
          onSettled?.(!bufferedOutputOverflowedRef.current);
          return;
        }
        flushNextTerminalRestoreBufferedOutput({
          peek: () => bufferedOutputRef.current[0],
          getData: entry => entry.data,
          commit: expected => bufferedOutputRef.current[0] === expected
            && bufferedOutputRef.current.shift() === expected,
          isCurrent: isCurrentAttempt,
          write: (data, onWritten, onRejected) => writeOutput(
            term,
            data,
            onWritten,
            false,
            onRejected,
          ),
          onWritten: () => {
            const activeCoverage = restoreCoverageTransactionRef.current;
            if (activeCoverage?.attemptEpoch === attemptEpoch) {
              activeCoverage.transaction.recordDrained(pending);
            }
            bufferedOutputBytesRef.current = Math.max(
              0,
              bufferedOutputBytesRef.current - getOutputUtf8ByteLength(pending.data),
            );
            pending.onWritten?.();
          },
          onSettled: success => {
            if (success) {
              writeNext();
              return;
            }
            bufferedOutputOverflowedRef.current = true;
            retainFailedHeldProvenance([attemptEpoch]);
            recordTerminalDebugEvent(sessionId, 'restore_pending_output_admission_rejected', {
              retainedBytes: bufferedOutputBytesRef.current,
              retainedChunks: bufferedOutputRef.current.length,
            });
            onVisibleOutputOverflow?.({
              reason: 'restore-pending-output-admission-rejected',
              droppedBytes: 0,
              pendingBytes: bufferedOutputBytesRef.current,
            });
            onSettled?.(false);
          },
        });
      };
      writeNext();
    }, [onVisibleOutputOverflow, retainFailedHeldProvenance, sessionId, writeOutput]);

    const isCurrentRestoreAttempt = useCallback((attempt: TerminalRestoreAttemptIdentity): boolean => (
      isTerminalRestoreAttemptCurrent(attempt, {
        attemptEpoch: restoreAttemptEpochRef.current,
        term: xtermRef.current,
        restorePending: restorePendingRef.current,
        disposed: terminalDisposedRef.current,
      })
    ), []);

    const getCurrentRestoreAttempt = useCallback((): TerminalRestoreAttemptIdentity | null => {
      const term = xtermRef.current;
      if (!term || !restorePendingRef.current || terminalDisposedRef.current) {
        return null;
      }
      return {
        attemptEpoch: restoreAttemptEpochRef.current,
        term,
      };
    }, []);

    const beginRestoreAttempt = useCallback((
      term: Terminal,
      options?: Readonly<{ preserveFailedHeld?: boolean }>,
    ): TerminalRestoreAttemptIdentity => {
      rollbackRestoreCoverageTransaction();
      restoreReleaseSingleFlightRef.current.supersede();
      restoreAttemptEpochRef.current += 1;
      restorePendingRef.current = true;
      if (!options?.preserveFailedHeld) {
        bufferedOutputOverflowedRef.current = false;
        failedHeldProvenanceRef.current = null;
      }
      return {
        attemptEpoch: restoreAttemptEpochRef.current,
        term,
      };
    }, [rollbackRestoreCoverageTransaction]);

    const stageFailedHeldCoverage = useCallback((
      attempt: TerminalRestoreAttemptIdentity,
      provenance: TerminalFailedHeldProvenance,
      coverage: NonNullable<TerminalSnapshotReplacementOptions['failedHeldCoverage']>,
    ): boolean => {
      const transaction = createTerminalRestoreHeldOutputCoverageTransaction({
        entries: bufferedOutputRef.current,
        failedAttemptEpochs: provenance.failedAttemptEpochs,
        snapshotSeq: coverage.snapshotSeq,
        coversThroughSeq: coverage.coversThroughSeq,
        replayToken: coverage.replayToken,
        supersedesReplayToken: coverage.supersedesReplayToken,
        authorityEpoch: coverage.authorityEpoch,
        authorityRevision: coverage.authorityRevision,
        connectionGeneration: coverage.connectionGeneration,
        minimumSnapshotSeq: provenance.minimumSnapshotSeq,
      });
      if (transaction.unproven.length > 0) {
        recordTerminalDebugEvent(sessionId, 'restore_failed_held_coverage_unproven', {
          unprovenChunks: transaction.unproven.length,
          retainedBytes: bufferedOutputBytesRef.current,
          retainedChunks: bufferedOutputRef.current.length,
          snapshotSeq: coverage.snapshotSeq,
          replayToken: coverage.replayToken,
        });
        return false;
      }
      restoreCoverageTransactionRef.current = {
        attemptEpoch: attempt.attemptEpoch,
        failedAttemptEpochs: provenance.failedAttemptEpochs,
        snapshotSeq: coverage.snapshotSeq,
        transaction,
      };
      bufferedOutputRef.current = [...transaction.remaining];
      recomputeBufferedOutputBytes();
      bufferedOutputOverflowedRef.current = false;
      recordTerminalDebugEvent(sessionId, 'restore_failed_held_output_covered', {
        coveredChunks: transaction.covered.length,
        retainedBytes: bufferedOutputBytesRef.current,
        retainedChunks: bufferedOutputRef.current.length,
        snapshotSeq: coverage.snapshotSeq,
        replayToken: coverage.replayToken,
      });
      return true;
    }, [recomputeBufferedOutputBytes, sessionId]);

    const releaseRestorePending = useCallback((
      attempt: TerminalRestoreAttemptIdentity,
    ): Promise<boolean> => {
      if (!isCurrentRestoreAttempt(attempt)) {
        return Promise.resolve(false);
      }
      if (bufferedOutputOverflowedRef.current) {
        // FAILED_HELD is immutable from the public/manual release path. Only a
        // replayed and token/sequence-proven authoritative checkpoint can stage
        // a transactional coverage transition and clear this flag.
        syncInputReadiness('restore-output-admission-rejected');
        return Promise.resolve(false);
      }
      return restoreReleaseSingleFlightRef.current.run(attempt.attemptEpoch, settleRelease => {
        flushBufferedOutput(attempt.attemptEpoch, success => {
          if (!isCurrentRestoreAttempt(attempt)) {
            settleRelease(false);
            return;
          }
          if (!success || bufferedOutputOverflowedRef.current) {
            rollbackRestoreCoverageTransaction(attempt.attemptEpoch);
            bufferedOutputOverflowedRef.current = true;
            retainFailedHeldProvenance([attempt.attemptEpoch]);
            // FAILED_HELD: keep both live output and input behind the restore
            // boundary. TerminalContainer was notified synchronously and owns
            // the bounded authoritative retry/reconnect convergence.
            syncInputReadiness('restore-output-admission-rejected');
            settleRelease(false);
            return;
          }
          const activeCoverage = restoreCoverageTransactionRef.current;
          if (activeCoverage?.attemptEpoch === attempt.attemptEpoch) {
            activeCoverage.transaction.commit();
            restoreCoverageTransactionRef.current = null;
          }
          const checkpointRuntime = terminalCheckpointRuntimeRef.current;
          if (checkpointRuntime) {
            const completed = checkpointRuntime.completeLegacyRecovery({
              source: 'compatibility-snapshot',
            });
            if (!completed.accepted && completed.reason !== 'legacy-recovery-not-pending') {
              recordTerminalDebugEvent(sessionId, 'terminal_compatibility_recovery_incomplete', {
                reason: completed.reason ?? 'compatibility-recovery-drain-pending',
              });
              syncInputReadiness('legacy-recovery-incomplete');
              settleRelease(false);
              return;
            }
          }
          failedHeldProvenanceRef.current = null;
          restorePendingRef.current = false;
          syncInputReadiness('restore-complete');
          saveSnapshot();
          onRestorePendingSettled?.();
          settleRelease(true);
        });
      });
    }, [
      flushBufferedOutput,
      isCurrentRestoreAttempt,
      onRestorePendingSettled,
      rollbackRestoreCoverageTransaction,
      retainFailedHeldProvenance,
      saveSnapshot,
      sessionId,
      syncInputReadiness,
    ]);

    const persistBufferedOutput = useCallback(() => {
      const snapshotLimits = getSnapshotResourceLimits();
      if (isTerminalSnapshotRemovalRequested(sessionId, { tombstoneTtlMs: snapshotLimits.tombstoneTtlMs })) {
        return;
      }

      inFlightOutputRef.current = [];
      clearBufferedOutput();

      if (!restorePendingRef.current) {
        saveSnapshot();
      }
    }, [clearBufferedOutput, sessionId, saveSnapshot]);

    const restoreStoredSnapshot = useCallback((
      term: Terminal,
      attempt: TerminalRestoreAttemptIdentity,
    ): Promise<boolean> => {
      const snapshot = loadStoredSnapshot();
      if (!snapshot) {
        return Promise.resolve(false);
      }
      if (snapshot.cols !== term.cols || snapshot.rows !== term.rows) {
        clearStoredSnapshot();
        return Promise.resolve(false);
      }

      return writeReplayDataWithProbe(term, snapshot.content).then((written) => {
        if (!written || !isCurrentRestoreAttempt(attempt)) {
          recordTerminalDebugEvent(sessionId, 'snapshot_restore_write_failed', {
            reason: written ? 'restore-attempt-superseded' : 'write-callback-or-fifo-probe-timeout',
          });
          if (isCurrentRestoreAttempt(attempt)) {
            clearStoredSnapshot();
          }
          return false;
        }
        return releaseRestorePending(attempt).then((released) => {
          if (!released) return false;
          lastSnapshotRef.current = snapshot.content;
          requestViewportSync(term, true);
          return true;
        });
      });
    }, [
      clearStoredSnapshot,
      isCurrentRestoreAttempt,
      loadStoredSnapshot,
      releaseRestorePending,
      requestViewportSync,
      sessionId,
      writeReplayDataWithProbe,
    ]);

    const applySnapshotReplacement = useCallback((
      data: string,
      shouldApply?: () => boolean,
      options?: TerminalSnapshotReplacementOptions,
    ): Promise<boolean> => {
      const rejectSnapshotReplacement = (
        reason: string,
        details: Readonly<Record<string, unknown>> = {},
      ): false => {
        options?.onRejected?.(reason);
        recordTerminalDebugEvent(sessionId, 'snapshot_replacement_rejected', {
          reason,
          ...details,
        });
        return false;
      };
      const term = xtermRef.current;
      if (!term) {
        return Promise.resolve(rejectSnapshotReplacement('terminal-unavailable'));
      }
      if (shouldApply?.() === false) {
        return Promise.resolve(rejectSnapshotReplacement('authority-fence-rejected'));
      }
      const checkpointRuntime = terminalCheckpointRuntimeRef.current;
      const checkpointState = checkpointRuntime?.getState();
      if (
        checkpointRuntime
        && checkpointState
        && !checkpointState.active
        && checkpointState.recoveryPending
        && checkpointState.legacyRecoveryPending
        && !checkpointState.orderedRollbackPending
      ) {
        const installed = checkpointRuntime.beginLegacyRecovery('compatibility-snapshot-recovery');
        if (!installed.accepted) {
          return Promise.resolve(rejectSnapshotReplacement('compatibility-recovery-install-rejected', {
            rejectionReason: installed.reason ?? 'checkpoint-runtime-unavailable',
          }));
        }
      }
      const checkpointOwnsTerminalMutation = (): boolean => {
        const state = terminalCheckpointRuntimeRef.current?.getState();
        return state !== undefined
          && (state.active || state.recoveryPending || state.orderedRollbackPending);
      };
      if (checkpointOwnsTerminalMutation()) {
        return Promise.resolve(rejectSnapshotReplacement('checkpoint-authority-active', {
          checkpointState: terminalCheckpointRuntimeRef.current?.getState() ?? null,
        }));
      }
      const activeCoverage = restoreCoverageTransactionRef.current;
      const failedHeld = bufferedOutputOverflowedRef.current || activeCoverage !== null;
      if (failedHeld && !options?.failedHeldCoverage) {
        recordTerminalDebugEvent(sessionId, 'restore_failed_held_requires_authoritative_coverage', {
          retainedBytes: bufferedOutputBytesRef.current,
          retainedChunks: bufferedOutputRef.current.length,
        });
        return Promise.resolve(false);
      }

      queueFocusRestoreIfFocused('replace-start');
      const failedHeldProvenance = failedHeld
        ? activeCoverage
          ? Object.freeze({
              failedAttemptEpochs: activeCoverage.failedAttemptEpochs,
              minimumSnapshotSeq: activeCoverage.snapshotSeq,
            })
          : failedHeldProvenanceRef.current
            ?? retainFailedHeldProvenance([restoreAttemptEpochRef.current])
        : null;
      const attempt = beginRestoreAttempt(term, { preserveFailedHeld: failedHeld });
      const coverageProvenance = failedHeld
        ? failedHeldProvenanceRef.current ?? failedHeldProvenance
        : null;
      syncInputReadiness('replace-start');
      inFlightOutputRef.current = [];
      const replayLease = replayInputGuardRef.current.beginReplayWrite();
      const cancelSupersededLegacyReplacement = (reason: string): boolean => {
        replayLease.release();
        return rejectSnapshotReplacement(reason, {
          checkpointState: terminalCheckpointRuntimeRef.current?.getState() ?? null,
        });
      };
      const coordinator = getTerminalWriteCoordinator(term);
      if (!coordinator) {
        replayLease.release();
        return Promise.resolve(rejectSnapshotReplacement('write-coordinator-unavailable'));
      }
      if (coordinator.getState().recoveryRequired) {
        const installed = terminalCheckpointRuntimeRef.current?.beginLegacyRecovery(
          'compatibility-snapshot-recovery',
        );
        if (!installed?.accepted) {
          replayLease.release();
          return Promise.resolve(rejectSnapshotReplacement('compatibility-recovery-install-rejected', {
            rejectionReason: installed?.reason ?? 'checkpoint-runtime-unavailable',
          }));
        }
      }
      return new Promise<boolean>((resolve) => {
        let resetSettled = false;
        const rejectReset = (reason = 'compatibility-reset-rejected') => {
          if (resetSettled) return;
          resetSettled = true;
          replayLease.release();
          resolve(rejectSnapshotReplacement('compatibility-reset-rejected', { rejectionReason: reason }));
        };
        const continueAfterReset = async (): Promise<boolean> => {
          if (checkpointOwnsTerminalMutation()) {
            return cancelSupersededLegacyReplacement('checkpoint-authority-active');
          }
          if (!data) {
            replayLease.release();
            if (!isCurrentRestoreAttempt(attempt)) {
              return rejectSnapshotReplacement('replay-write-or-restore-attempt-rejected');
            }
            if (shouldApply?.() === false) {
              return rejectSnapshotReplacement('authority-fence-rejected');
            }
            if (coverageProvenance && options?.failedHeldCoverage) {
              if (!stageFailedHeldCoverage(attempt, coverageProvenance, options.failedHeldCoverage)) {
                return false;
              }
            }
            return releaseRestorePending(attempt);
          }

          const written = await new Promise<boolean>((resolveReplay) => {
            let replaySettled = false;
            const settleReplay = (didWrite: boolean): void => {
              if (replaySettled) return;
              replaySettled = true;
              replayLease.release();
              resolveReplay(didWrite);
            };
            const replayDecision = coordinator.submitCompatibility({
              type: 'write',
              viewGeneration: xtermGenerationRef.current,
              kind: 'repair',
              data,
              onWritten: () => settleReplay(true),
              onRejected: () => settleReplay(false),
            });
            if (!replayDecision.accepted) settleReplay(false);
          });
          if (checkpointOwnsTerminalMutation()) {
            return cancelSupersededLegacyReplacement('checkpoint-authority-active');
          }
          if (!written || !isCurrentRestoreAttempt(attempt)) {
            return rejectSnapshotReplacement('replay-write-or-restore-attempt-rejected', {
              written,
              currentRestoreAttempt: isCurrentRestoreAttempt(attempt),
            });
          }
          if (shouldApply?.() === false) {
            return rejectSnapshotReplacement('authority-fence-rejected');
          }
          if (coverageProvenance && options?.failedHeldCoverage) {
            if (!stageFailedHeldCoverage(attempt, coverageProvenance, options.failedHeldCoverage)) {
              return false;
            }
          }
          const released = await releaseRestorePending(attempt);
          if (!released) return rejectSnapshotReplacement('replay-write-or-restore-attempt-rejected', {
            written: true,
            currentRestoreAttempt: isCurrentRestoreAttempt(attempt),
          });
          lastSnapshotRef.current = data;
          requestViewportSync(term, true);
          return true;
        };
        const resetDecision = coordinator.submitCompatibility({
          type: 'reset',
          viewGeneration: xtermGenerationRef.current,
          onApplied: () => {
            if (resetSettled) return;
            resetSettled = true;
            void continueAfterReset().then(resolve, () => resolve(false));
          },
          onRejected: rejectReset,
        });
        if (!resetDecision.accepted) rejectReset(resetDecision.reason);
      });
    }, [
      beginRestoreAttempt,
      getTerminalWriteCoordinator,
      isCurrentRestoreAttempt,
      queueFocusRestoreIfFocused,
      releaseRestorePending,
      requestViewportSync,
      retainFailedHeldProvenance,
      syncInputReadiness,
      sessionId,
      stageFailedHeldCoverage,
    ]);

    const replaceWithSnapshot = useCallback(async (
      data: string,
      shouldApply?: () => boolean,
      options?: TerminalSnapshotReplacementOptions,
    ): Promise<boolean> => {
      const ready = await waitForImeIdle('snapshot', 'replace-with-snapshot');
      if (!ready) {
        recordTerminalDebugEvent(sessionId, 'snapshot_replacement_rejected', {
          reason: 'ime-idle-wait-rejected',
        });
        return false;
      }
      if (shouldApply?.() === false) {
        recordTerminalDebugEvent(sessionId, 'snapshot_replacement_rejected', {
          reason: 'authority-fence-rejected-before-replacement',
        });
        return false;
      }

      return applySnapshotReplacement(data, shouldApply, options);
    }, [applySnapshotReplacement, sessionId, waitForImeIdle]);

    const getScreenRepairReadiness = useCallback((): ScreenRepairReadiness => {
      const term = xtermRef.current;
      const imeSnapshot = imeTransactionRef.current?.getSnapshot() ?? null;
      if (!term || terminalDisposedRef.current || !isVisibleRef.current || restorePendingRef.current || !geometryReadyRef.current) {
        return { ok: false, reason: 'not-ready' };
      }
      if (isComposingRef.current || (imeSnapshot !== null && imeSnapshot.state !== 'idle')) {
        return {
          ok: false,
          reason: 'ime-active',
          cols: term.cols,
          rows: term.rows,
          atBottom: term.buffer.active.viewportY === term.buffer.active.baseY,
          bufferType: term.buffer.active.type,
        };
      }
      if (
        captureStateRef.current !== 'open'
        && transportBarrierReasonRef.current !== 'none'
        && transportBarrierReasonRef.current !== 'visible-output-recovery'
      ) {
        return {
          ok: false,
          reason: 'input-active',
          cols: term.cols,
          rows: term.rows,
          atBottom: term.buffer.active.viewportY === term.buffer.active.baseY,
          bufferType: term.buffer.active.type,
        };
      }

      const atBottom = term.buffer.active.viewportY === term.buffer.active.baseY;
      if (!atBottom) {
        return {
          ok: false,
          reason: 'user-scrolled',
          cols: term.cols,
          rows: term.rows,
          atBottom,
          bufferType: term.buffer.active.type,
        };
      }

      return {
        ok: true,
        cols: term.cols,
        rows: term.rows,
        atBottom,
        bufferType: term.buffer.active.type,
      };
    }, []);

    const applyScreenRepair = useCallback(async (repair: ScreenRepairMessage): Promise<ScreenRepairApplyResult> => {
      const imeReady = await waitForImeIdle('repair', 'apply-screen-repair');
      if (!imeReady) {
        return { ok: false, reason: 'ime-active' };
      }

      const term = xtermRef.current;
      if (!term) {
        return { ok: false, reason: 'not-ready' };
      }

      const readiness = getScreenRepairReadiness();
      if (!readiness.ok) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_apply_rejected', {
          reason: readiness.reason,
          repairToken: repair.repairToken,
          seq: repair.seq,
        });
        return { ok: false, reason: readiness.reason };
      }
      if (readiness.cols !== repair.cols || readiness.rows !== repair.rows) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_apply_rejected', {
          reason: 'geometry-mismatch',
          repairToken: repair.repairToken,
          seq: repair.seq,
          clientCols: readiness.cols,
          clientRows: readiness.rows,
          repairCols: repair.cols,
          repairRows: repair.rows,
        });
        return { ok: false, reason: 'geometry-mismatch' };
      }
      if (readiness.bufferType !== repair.bufferType) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_apply_rejected', {
          reason: 'buffer-mismatch',
          repairToken: repair.repairToken,
          seq: repair.seq,
          clientBufferType: readiness.bufferType,
          repairBufferType: repair.bufferType,
        });
        return { ok: false, reason: 'buffer-mismatch' };
      }

      queueFocusRestoreIfFocused('screen-repair-start');
      recordTerminalDebugEvent(sessionId, 'screen_repair_apply_started', {
        repairToken: repair.repairToken,
        seq: repair.seq,
        cols: repair.cols,
        rows: repair.rows,
        bufferType: repair.bufferType,
        rowCount: repair.viewportRows.length,
        byteLength: repair.ansiPatch.length,
      }, repair.ansiPatch);

      return writeReplayDataWithProbe(term, repair.ansiPatch).then((written): ScreenRepairApplyResult => {
        if (!written) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_apply_failed', {
            repairToken: repair.repairToken,
            seq: repair.seq,
            reason: 'write-callback-or-fifo-probe-timeout',
          });
          return { ok: false, reason: 'write-failed' };
        }

        const active = term.buffer.active;
        if (active.type !== repair.bufferType) {
          return { ok: false, reason: 'buffer-mismatch' };
        }
        if (active.viewportY !== active.baseY) {
          return { ok: false, reason: 'user-scrolled' };
        }

        scheduleSnapshotSave();
        restoreQueuedFocus('screen-repair');
        recordTerminalDebugEvent(sessionId, 'screen_repair_applied', {
          repairToken: repair.repairToken,
          seq: repair.seq,
          cols: repair.cols,
          rows: repair.rows,
          bufferType: repair.bufferType,
        });
        return { ok: true };
      });
    }, [
      getScreenRepairReadiness,
      queueFocusRestoreIfFocused,
      restoreQueuedFocus,
      scheduleSnapshotSave,
      sessionId,
      waitForImeIdle,
      writeReplayDataWithProbe,
    ]);

    const restoreSnapshotAfterIme = useCallback(async (): Promise<boolean> => {
      const ready = await waitForImeIdle('snapshot', 'restore-snapshot');
      if (!ready) {
        return false;
      }

      const term = xtermRef.current;
      if (!term) {
        return false;
      }
      if (bufferedOutputOverflowedRef.current) {
        recordTerminalDebugEvent(sessionId, 'restore_failed_held_local_snapshot_rejected', {
          retainedBytes: bufferedOutputBytesRef.current,
          retainedChunks: bufferedOutputRef.current.length,
        });
        return false;
      }
      queueFocusRestoreIfFocused('restore-start');
      const attempt = beginRestoreAttempt(term);
      syncInputReadiness('restore-start');
      return restoreStoredSnapshot(term, attempt);
    }, [beginRestoreAttempt, queueFocusRestoreIfFocused, restoreStoredSnapshot, sessionId, syncInputReadiness, waitForImeIdle]);

    const submitProgrammaticPaste = useCallback((
      data: string,
      source = 'command-preset-paste',
    ): TerminalPasteInputResult => {
      const term = xtermRef.current;
      if (!term || terminalDisposedRef.current) {
        return {
          ok: false,
          reason: 'context-changed',
          source,
          captureState: captureStateRef.current,
          barrierReason: transportBarrierReasonRef.current,
          closedReason: transportClosedReasonRef.current,
        };
      }
      if (hasLineBreak(data) && !term.modes.bracketedPasteMode) {
        const debugInput = buildTerminalInputDebugPayload(data, {
          captureSeq: nextCaptureSeq(),
        }, { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) });
        recordTerminalDebugEvent(sessionId, 'terminal_input_rejected', {
          ...debugInput.details,
          reason: 'unsupported-multiline-paste',
          source,
          captureState: captureStateRef.current,
          barrierReason: transportBarrierReasonRef.current,
          closedReason: transportClosedReasonRef.current,
        }, debugInput.preview);
        return {
          ok: false,
          reason: 'unsupported-multiline-paste',
          source,
          captureState: captureStateRef.current,
          barrierReason: transportBarrierReasonRef.current,
          closedReason: transportClosedReasonRef.current,
        };
      }

      const pendingPaste = {
        source,
        captureSeq: nextCaptureSeq(),
        result: null as TerminalInputSubmitResult | null,
      };
      programmaticPasteRef.current = pendingPaste;
      try {
        term.paste(data);
      } finally {
        if (programmaticPasteRef.current === pendingPaste) {
          programmaticPasteRef.current = null;
        }
      }

      return pendingPaste.result ?? {
        ok: false,
        reason: 'context-changed',
        source,
        captureState: captureStateRef.current,
        barrierReason: transportBarrierReasonRef.current,
        closedReason: transportClosedReasonRef.current,
      };
    }, [nextCaptureSeq, sessionId]);

    const captureClipboardTarget = useCallback((): TerminalClipboardTarget | null => {
      const term = xtermRef.current;
      if (!term || terminalDisposedRef.current || !isVisibleRef.current) {
        return null;
      }
      return {
        terminalIdentity: term,
        sessionId,
        sessionGeneration: sessionGenerationRef.current,
        viewGeneration: clipboardViewGenerationRef.current,
      };
    }, [sessionId]);

    const isClipboardTargetCurrent = useCallback((target: TerminalClipboardTarget): boolean => (
      !terminalDisposedRef.current
      && isVisibleRef.current
      && xtermRef.current === target.terminalIdentity
      && sessionId === target.sessionId
      && sessionGenerationRef.current === target.sessionGeneration
      && clipboardViewGenerationRef.current === target.viewGeneration
    ), [sessionId]);

    const captureClipboardSelection = useCallback((
      target: TerminalClipboardTarget,
    ): TerminalClipboardSelection | null => {
      if (!isClipboardTargetCurrent(target)) {
        return null;
      }
      const term = xtermRef.current;
      if (!term) {
        return null;
      }
      const liveText = term.getSelection();
      if (liveText.length > 0) {
        const position = term.getSelectionPosition();
        return {
          text: liveText,
          rangeKey: position
            ? `${position.start.x}:${position.start.y}-${position.end.x}:${position.end.y}`
            : `live:${liveText.length}`,
        };
      }
      const savedText = savedRightClickSelRef.current;
      return (
        savedText.length > 0
        && savedRightClickSelXtermGenerationRef.current === xtermGenerationRef.current
      )
        ? {
            text: savedText,
            rangeKey: `saved:${savedRightClickSelGenerationRef.current}`,
          }
        : null;
    }, [isClipboardTargetCurrent]);

    const clipboardCoordinator = useMemo(() => createTerminalClipboardCoordinator({
      captureTarget: captureClipboardTarget,
      isTargetCurrent: isClipboardTargetCurrent,
      captureSelection: captureClipboardSelection,
      isSelectionCurrent: (target, selection) => {
        const current = captureClipboardSelection(target);
        return current?.text === selection.text && current.rangeKey === selection.rangeKey;
      },
      readClipboardText: () => navigator.clipboard.readText(),
      writeClipboardText: (text) => navigator.clipboard.writeText(text),
      admitPaste: (target, text, source) => {
        if (!isClipboardTargetCurrent(target)) {
          return { ok: false, reason: 'context-changed' };
        }
        const result = submitProgrammaticPaste(
          text,
          source === 'command-preset' ? 'command-preset-paste' : source,
        );
        return result.ok ? { ok: true } : { ok: false, reason: result.reason };
      },
      clearSelection: () => {
        xtermRef.current?.clearSelection();
        savedRightClickSelRef.current = '';
        savedRightClickSelGenerationRef.current += 1;
        savedRightClickSelXtermGenerationRef.current = 0;
      },
      focus: () => focusTerminalInput('clipboard-coordinator'),
      observe: (event) => {
        recordTerminalDebugEvent(sessionId, 'terminal_clipboard_action', { ...event });
      },
    }), [
      captureClipboardSelection,
      captureClipboardTarget,
      focusTerminalInput,
      isClipboardTargetCurrent,
      sessionId,
      submitProgrammaticPaste,
    ]);

    useEffect(() => {
      clipboardCoordinator.activate();
      return () => clipboardCoordinator.dispose();
    }, [clipboardCoordinator]);

    useImperativeHandle(ref, () => ({
      submitOutput: (data: TerminalOutputWriteData, metadata?: TerminalOutputWriteMetadata) => {
        const checkpointState = terminalCheckpointRuntimeRef.current?.getState();
        if (checkpointState?.active || checkpointState?.recoveryPending) {
          terminalCheckpointRuntimeRef.current?.coordinatorRecoveryFailed(
            'legacy-output-during-checkpoint-authority',
          );
          recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_legacy_output_rejected', {
            byteLength: getOutputUtf8ByteLength(data),
            viewGeneration: checkpointState.viewGeneration,
          });
          return;
        }
        const term = xtermRef.current;
        if (!term || restorePendingRef.current) {
          bufferOutputWhileRestorePending(data, metadata);
          return;
        }

        writeOutput(
          term,
          data,
          metadata?.onWritten,
          metadata?.onWritten === undefined,
          metadata?.onRejected,
        );
      },
      writeAndWait: (data: string) => writeOutputAndWait(data),
      writeRecoveryTailAndWait: (data: TerminalOutputWriteData) => writeRecoveryTailAndWait(data),
      awaitOutputIdle: () => awaitOutputIdleWithFifoProbe(),
      probeOutputFifo: () => probeOutputFifo().then(
        result => result === 'retired' || result === 'advanced',
      ),
      getAuthorityViewGeneration: () => (
        terminalCheckpointRuntimeRef.current?.getState().viewGeneration ?? null
      ),
      isCheckpointAuthorityActive: () => (
        terminalCheckpointRuntimeRef.current?.getState().active === true
      ),
      isCompatibilityRecoveryPending: () => (
        terminalCheckpointRuntimeRef.current?.getState().legacyRecoveryPending === true
      ),
      bindRestoreCoordinator: (options: TerminalRestoreAdapterOptions) => {
        const adapter = createTerminalViewRestoreAdapter(options);
        terminalRestoreAdapterRef.current = adapter;
        return adapter;
      },
      submitClear: () => {
        const term = xtermRef.current;
        lastSnapshotRef.current = null;
        clearBufferedOutput();
        outputIngressRetryQueueRef.current?.reset();
        outputSchedulerRef.current?.reset('terminal-clear');
        if (term) {
          getTerminalWriteCoordinator(term)?.submitCompatibility({
            type: 'clear',
            viewGeneration: xtermGenerationRef.current,
          });
        }
      },
      focus: (reason = 'handle') => {
        focusTerminalInput(reason);
      },
      hasSelection: () => !!(
        xtermRef.current?.hasSelection()
        || (
          savedRightClickSelXtermGenerationRef.current === xtermGenerationRef.current
          && savedRightClickSelRef.current
        )
      ),
      getSelection: () => (
        xtermRef.current?.getSelection()
        || (
          savedRightClickSelXtermGenerationRef.current === xtermGenerationRef.current
            ? savedRightClickSelRef.current
            : ''
        )
      ),
      getMouseTrackingActive: () => {
        const term = xtermRef.current;
        const mode = term?.modes.mouseTrackingMode;
        return mode !== undefined && mode !== 'none';
      },
      clearSelection: () => {
        xtermRef.current?.clearSelection();
        savedRightClickSelRef.current = '';
        savedRightClickSelGenerationRef.current += 1;
        savedRightClickSelXtermGenerationRef.current = 0;
      },
      copySelection: (source = 'keyboard') => clipboardCoordinator.copySelection(source),
      pasteClipboard: (source = 'command-preset') => clipboardCoordinator.pasteClipboard(source),
      pasteText: (data, source = 'command-preset') => clipboardCoordinator.pasteText(data, source),
      invalidateClipboardContext: () => {
        clipboardViewGenerationRef.current += 1;
      },
      fit: () => {
        if (!isVisibleRef.current) return;
        requestAnimationFrame(() => {
          const term = xtermRef.current;
          if (term) submitTerminalFit(term);
        });
      },
      repairLayout: (reason = 'repair-layout') => repairLayoutAfterIme(reason),
      getScreenRepairReadiness: () => getScreenRepairReadiness(),
      applyScreenRepair: (repair: ScreenRepairMessage) => applyScreenRepair(repair),
      clearVisibleOutputRecovery: () => {
        outputIngressRetryQueueRef.current?.reset();
        outputSchedulerRef.current?.reset('visible-output-recovery');
      },
      captureRetainedState: () => {
        const term = xtermRef.current;
        return term ? captureTerminalRetainedState(term) : null;
      },
      sendInput: (data: string) => {
        const debugInput = buildTerminalInputDebugPayload(data, { captureSeq: nextCaptureSeq() }, { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) });
        return submitCapturedInput(data, debugInput, 'imperative');
      },
      restoreSnapshot: () => restoreSnapshotAfterIme(),
      replaceWithSnapshot: (
        data: string,
        shouldApply?: () => boolean,
        options?: TerminalSnapshotReplacementOptions,
      ) => (
        replaceWithSnapshot(data, shouldApply, options)
      ),
      releasePending: () => {
        const attempt = getCurrentRestoreAttempt();
        if (attempt) {
          void releaseRestorePending(attempt);
        }
      },
      completeCheckpointTakeover: () => {
        const checkpointRuntime = terminalCheckpointRuntimeRef.current;
        if (!checkpointRuntime?.getState().active) return;
        const completed = checkpointRuntime.completeLegacyRecovery({
          source: 'compatibility-snapshot',
        });
        if (!completed.accepted && completed.reason !== 'legacy-recovery-not-pending') {
          recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_takeover_incomplete', {
            reason: completed.reason ?? 'checkpoint-takeover-incomplete',
          });
          syncInputReadiness('checkpoint-takeover-incomplete');
        }
      },
      setInputTransportState: (state: TerminalInputTransportState) => {
        if (!state.serverReady) {
          queueFocusRestoreIfFocused('server-not-ready');
        }
        transportStateRef.current = state;
        syncInputReadiness('transport-state');
      },
      setServerReady: (ready: boolean) => {
        if (!ready) {
          queueFocusRestoreIfFocused('server-not-ready');
        }
        transportStateRef.current = {
          ...transportStateRef.current,
          serverReady: ready,
          barrierReason: ready ? 'none' : 'repair-server-not-ready',
          closedReason: 'none',
          reconnectState: ready ? 'connected' : transportStateRef.current.reconnectState,
        };
        syncInputReadiness('server-ready-legacy');
      },
      setWindowsPty: (info?: WindowsPtyInfo) => {
        const term = xtermRef.current;
        if (!term) return;
        getTerminalWriteCoordinator(term)?.submitCompatibility({
          type: 'set-windows-pty',
          viewGeneration: xtermGenerationRef.current,
          value: info,
        });
      },
    }), [
      bufferOutputWhileRestorePending,
      clearBufferedOutput,
      clipboardCoordinator,
      writeOutput,
      writeOutputAndWait,
      writeRecoveryTailAndWait,
      awaitOutputIdleWithFifoProbe,
      probeOutputFifo,
      applyScreenRepair,
      getScreenRepairReadiness,
      getCurrentRestoreAttempt,
      getTerminalWriteCoordinator,
      restoreSnapshotAfterIme,
      replaceWithSnapshot,
      releaseRestorePending,
      focusTerminalInput,
      nextCaptureSeq,
      queueFocusRestoreIfFocused,
      repairLayoutAfterIme,
      sessionId,
      submitCapturedInput,
      submitTerminalFit,
      syncInputReadiness,
    ]);

    useEffect(() => () => {
      disposeTerminalPendingInputQueueLifetime({
        expiryTimers: inputQueueExpiryTimersRef.current,
        rejectPending: () => rejectPendingInputQueue('context-changed', 'terminal-disposed'),
      });
    }, [rejectPendingInputQueue, sessionId]);

    useEffect(() => {
      if (!terminalRef.current) return;
      void terminalRuntimeRevision;

      // Guard: clear any leftover DOM from previous instance (React StrictMode
      // double-mount can leave orphan elements if dispose() is async)
      const container = terminalRef.current;
      const replayInputGuard = replayInputGuardRef.current;
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      const initialFontSize = getInitialFontSize();

      const term = new Terminal({
        cursorBlink: true,
        fontSize: initialFontSize,
        fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
        theme: TERMINAL_XTERM_THEME,
        ...resolveTerminalXtermOptions(getTerminalResourceLimits()),
        convertEol: false,
        disableStdin: true,
      });

      const fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(serializeAddon);
      term.open(terminalRef.current);
      const helperTextarea = getHelperTextarea();
      if (helperTextarea) {
        helperTextarea.setAttribute('aria-label', 'Terminal input');
        helperTextarea.disabled = true;
        helperTextarea.readOnly = false;
      }
      const buildInputCaptureState = () => {
        const activeElement = document.activeElement;
        const imeSnapshot = imeTransactionRef.current?.getSnapshot() ?? null;
        return {
          inputReady: inputReadyRef.current,
          transportReady: transportReadyRef.current,
          captureAllowed: captureAllowedRef.current,
          captureState: captureStateRef.current,
          barrierReason: transportBarrierReasonRef.current,
          closedReason: transportClosedReasonRef.current,
          serverReady: serverReadyRef.current,
          geometryReady: geometryReadyRef.current,
          restorePending: restorePendingRef.current,
          visible: isVisibleRef.current,
          helperDisabled: helperTextarea?.disabled ?? false,
          helperReadOnly: helperTextarea?.readOnly ?? false,
          isComposing: isComposingRef.current || (imeSnapshot?.state !== 'idle'),
          imeState: imeSnapshot?.state ?? 'idle',
          compositionSeq: imeSnapshot?.compositionSeq ?? null,
          activeElementIsHelper: activeElement === helperTextarea,
        };
      };
      const recordHelperTape = (
        kind: string,
        event: KeyboardEvent | InputEvent | CompositionEvent,
        sequence: { captureSeq?: number; compositionSeq?: number },
      ) => {
        if (!isTerminalDebugCaptureEnabled(sessionId)) {
          return;
        }
        recordTerminalDebugEvent(
          sessionId,
          kind,
          buildTerminalEventTapeDetails(event, sequence, buildInputCaptureState()),
        );
      };
      recordTerminalDebugEvent(sessionId, 'terminal_mounted');
      terminalDisposedRef.current = false;
      const restoreReleaseSingleFlight = restoreReleaseSingleFlightRef.current;
      replayInputGuard.reset();
      beginRestoreAttempt(term);
      geometryReadyRef.current = false;
      serverReadyRef.current = false;
      inputReadyRef.current = false;
      captureStateRef.current = 'transient-blocked';
      captureAllowedRef.current = true;
      transportReadyRef.current = false;
      transportBarrierReasonRef.current = 'restore-pending';
      transportClosedReasonRef.current = 'none';
      clearBufferedOutput();
      savedRightClickSelRef.current = '';
      savedRightClickSelGenerationRef.current += 1;
      savedRightClickSelXtermGenerationRef.current = 0;
      xtermGenerationRef.current += 1;
      clipboardViewGenerationRef.current += 1;
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      serializeAddonRef.current = serializeAddon;
      const coordinatorGeneration = xtermGenerationRef.current;
      const coordinatorLimits = getCachedTerminalOutputResourceLimits();
      const coordinatorInputLimits = getInputQueueLimits();
      const requestCheckpointRecovery = (reason: string): void => {
        checkpointInputBarrierRef.current = true;
        recordTerminalDebugEvent(sessionId, 'terminal_write_coordinator_recovery_requested', { reason });
        syncInputReadiness('terminal-checkpoint-recovery');
        onVisibleOutputOverflow?.({
          reason: `terminal-authority-recovery:${reason}`,
          droppedBytes: 0,
          pendingBytes: bufferedOutputBytesRef.current,
        });
      };
      const checkpointRuntime = createTerminalCheckpointRuntime({
        sessionId,
        initialViewGeneration: coordinatorGeneration,
        getCoordinator: () => terminalWriteCoordinatorRef.current,
        send: message => checkpointSendRef.current(message),
        getPreparedCheckpointReadyReceipt: getTerminalControlSocketReceipt,
        sendPreparedCheckpointReady: input => sendTerminalAuthorityControl({
          message: input.message,
          expectedControlSocketId: input.expectedControlSocketId,
          afterEnqueueOrdinal: input.afterEnqueueOrdinal,
        }),
        onPreparedCheckpointReadySendBlocked: failure => {
          recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_ready_send_blocked', failure);
        },
        onPreparedCheckpointReadyDeferred: deferral => {
          recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_ready_deferred', deferral);
        },
        requestFreshRecovery: requestCheckpointRecovery,
        advanceViewGeneration: (nextGeneration) => {
          xtermGenerationRef.current = nextGeneration;
          clipboardViewGenerationRef.current += 1;
          refreshTerminalCheckpointRegistration();
        },
        onCapabilityRegistration: (capability) => {
          checkpointMutationLeaseBarrierRef.current = !isTerminalCheckpointMutationLeaseReady(capability, sessionId, xtermGenerationRef.current);
          syncInputReadiness('terminal-checkpoint-mutation-lease');
          // @req MIG-BGSTAB-002 AC-3
          // A replacement browser runtime can join after the original responder
          // disable boundary has already committed. The authoritative capability
          // is therefore also the reconnect-time fence: never revive xterm's
          // parser responder while the server owns terminal query side effects.
          if (capability.authorityMode === 'checkpoint') {
            legacyParserRepliesEnabledRef.current = false;
            terminalQueryResponderIdentityRef.current = null;
            terminalQueryReplyOrdinalRef.current = 0;
          }
        },
        onAuthorityStateChange: (state) => {
          if (state === 'legacy') {
            legacyAuthorityReadySyncPendingRef.current = true;
            checkpointMutationLeaseBarrierRef.current = false;
          } else {
            legacyAuthorityReadySyncPendingRef.current = false;
          }
          checkpointInputBarrierRef.current = state === 'checkpoint-pending'
            || state === 'recovery-required'
            || state === 'legacy-recovery-pending'
            || state === 'runtime-recreation-required';
          syncInputReadiness(state === 'legacy'
            ? 'terminal-authority-legacy-convergence-pending'
            : `terminal-authority-${state}`);
        },
      });
      terminalCheckpointRuntimeRef.current = checkpointRuntime;

      const retireTerminalResponderRuntime = (): void => {
        unregisterTerminalResponderRuntimeRef.current?.();
        unregisterTerminalResponderRuntimeRef.current = null;
        const previousRuntime = terminalResponderHandoffRuntimeRef.current;
        terminalResponderHandoffRuntimeRef.current = null;
        previousRuntime?.dispose('runtime-replaced');
        pendingCompatibilityRollbackRef.current = null;
        terminalQueryResponderIdentityRef.current = null;
        terminalQueryReplyOrdinalRef.current = 0;
      };

      const installTerminalResponderRuntime = (
        identity: TerminalResponderBoundaryIdentity,
        legacyParserRepliesInitiallyEnabled: boolean,
      ): TerminalResponderHandoffRuntime => {
        retireTerminalResponderRuntime();
        legacyParserRepliesEnabledRef.current = legacyParserRepliesInitiallyEnabled;
        const runtime = createTerminalResponderHandoffRuntime({
          identity,
          lifecycleGeneration: coordinatorGeneration,
          legacyParserRepliesInitiallyEnabled,
          awaitOutputIdleWithFifoProbe: () => awaitOutputIdleWithFifoProbe(),
          awaitCompatibilityDrain: () => awaitOutputIdleWithFifoProbe(),
          flushPendingQueryRepliesImmediately: () => {
            if (!flushPendingUserInputBeforeQueryReply('query-reply-boundary')) {
              const currentReceipt = getTerminalControlSocketReceipt();
              return {
                ok: false,
                reason: 'pending-user-input-not-drained',
                controlSocketId: currentReceipt.controlSocketId,
              };
            }
            return getTerminalControlSocketReceipt();
          },
          setLegacyParserRepliesEnabled: (enabled) => {
            legacyParserRepliesEnabledRef.current = enabled;
            if (!enabled) {
              terminalQueryResponderIdentityRef.current = null;
              terminalQueryReplyOrdinalRef.current = 0;
            }
          },
          sendResponderControl: input => sendTerminalAuthorityControl({
            message: input.message as unknown as TerminalResponderHandoffClientMessage,
            expectedControlSocketId: input.expectedControlSocketId,
            afterEnqueueOrdinal: input.afterEnqueueOrdinal,
          }),
          onPromotionAbortRequired: (reason) => {
            recordTerminalDebugEvent(sessionId, 'terminal_responder_promotion_aborted', { reason });
            requestCheckpointRecovery(`responder-handoff:${reason}`);
          },
          onRecoveryRestartRequired: (reason) => {
            if (
              terminalResponderHandoffRuntimeRef.current === runtime
              && !terminalDisposedRef.current
            ) {
              requestCheckpointRecovery(`responder-handoff:${reason}`);
            }
          },
          forwardUserInput: (input) => {
            const debugInput = buildTerminalInputDebugPayload(
              input.data,
              { captureSeq: nextCaptureSeq() },
              { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) },
            );
            submitCapturedInput(input.data, debugInput, `responder-${input.kind}`);
          },
        });
        terminalResponderHandoffRuntimeRef.current = runtime;
        return runtime;
      };

      const completeCompatibilityRollback = (
        metadata: Readonly<{
          viewGeneration: number;
          streamEpoch: string;
          checkpointEpoch: string;
          sourceSeq: string;
        }>,
      ): void => {
        const pending = pendingCompatibilityRollbackRef.current;
        const runtime = terminalResponderHandoffRuntimeRef.current;
        if (
          !pending
          || !runtime
          || metadata.viewGeneration !== pending.identity.viewGeneration
          || metadata.streamEpoch !== pending.identity.streamEpoch
          || metadata.checkpointEpoch !== pending.message.checkpointEpoch
          || BigInt(metadata.sourceSeq) < BigInt(pending.identity.boundarySourceSeq)
        ) {
          return;
        }
        const compatibilityIdentity: TerminalCompatibilityDrainIdentity = {
          ...pending.identity,
          checkpointEpoch: metadata.checkpointEpoch,
          drainedThroughSourceSeq: metadata.sourceSeq,
          checkpointApplied: true,
          postSnapshotTailDrained: true,
        };
        void runtime.restoreLegacyParserRepliesAfterCompatibilityDrain(
          compatibilityIdentity,
        ).then((result) => {
          if (
            !result.accepted
            || terminalResponderHandoffRuntimeRef.current !== runtime
            || pendingCompatibilityRollbackRef.current !== pending
          ) {
            if (!result.accepted) {
              recordTerminalDebugEvent(sessionId, 'terminal_compatibility_responder_restore_rejected', {
                reason: result.reason ?? 'compatibility-responder-restore-rejected',
              });
              if (
                terminalResponderHandoffRuntimeRef.current === runtime
                && pendingCompatibilityRollbackRef.current === pending
              ) {
                requestCheckpointRecovery(
                  `responder-handoff:${result.reason ?? 'compatibility-responder-restore-rejected'}`,
                );
              }
            }
            return;
          }
          const settledCompatibilityIdentity = result.compatibilityDrainIdentity
            ?? compatibilityIdentity;
          unregisterTerminalResponderRuntimeRef.current?.();
          unregisterTerminalResponderRuntimeRef.current = registerTerminalResponderHandoffRuntime(
            settledCompatibilityIdentity,
            runtime,
          );
          pendingCompatibilityRollbackRef.current = null;
          recordTerminalDebugEvent(sessionId, 'terminal_compatibility_responder_drained', {
            viewGeneration: settledCompatibilityIdentity.viewGeneration,
            checkpointEpoch: settledCompatibilityIdentity.checkpointEpoch,
            drainedThroughSourceSeq: settledCompatibilityIdentity.drainedThroughSourceSeq,
          });
        }).catch(() => {
          if (terminalResponderHandoffRuntimeRef.current === runtime) {
            requestCheckpointRecovery('responder-handoff:compatibility-drain-failed');
          }
        });
      };

      terminalWriteCoordinatorRef.current = createTerminalWriteCoordinator({
        viewGeneration: coordinatorGeneration,
        adapter: createTerminalWriteCoordinatorAdapter({
          terminal: term,
          fitAddon,
          markReady: () => {
            checkpointInputBarrierRef.current = resolveTerminalCheckpointInputRoute(
              checkpointRuntime.getState(),
            ) === 'pending-input-queue';
            syncInputReadiness('terminal-write-coordinator-ready');
          },
          releaseInput: (data) => {
            const debugInput = buildTerminalInputDebugPayload(
              data,
              { captureSeq: nextCaptureSeq() },
              { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) },
            );
            const released = submitCapturedInputDirect(data, debugInput, 'terminal-write-coordinator');
            if (!released.ok) {
              throw new Error(`checkpoint-input-release-rejected:${released.reason}`);
            }
          },
          settleInput: (token, outcome) => {
            recordTerminalDebugEvent(sessionId, 'terminal_checkpoint_input_settled', {
              token,
              outcome,
            });
          },
          requestFreshRecovery: (reason) => {
            const checkpointState = checkpointRuntime.getState();
            if (checkpointState.active || checkpointState.recoveryPending) {
              checkpointRuntime.coordinatorRecoveryFailed(reason);
            } else {
              if (!checkpointState.legacyRecoveryPending) {
                const installed = checkpointRuntime.beginLegacyRecovery(reason);
                if (!installed.accepted && installed.reason === 'runtime-recreation-required') {
                  return;
                }
              }
              requestCheckpointRecovery(reason);
            }
          },
          requestRuntimeRecreation: (reason) => {
            checkpointInputBarrierRef.current = true;
            recordTerminalDebugEvent(sessionId, 'terminal_runtime_recreation_required', { reason });
            syncInputReadiness('terminal-runtime-recreation-required');
            runtimeRecreationRecoveryReasonRef.current = {
              sessionId,
              reason,
              recoveryRequested: false,
            };
            setTerminalRuntimeRevision(revision => revision + 1);
          },
          compatibilityRecoveryDrained: (generation) => {
            recordTerminalDebugEvent(sessionId, 'terminal_compatibility_recovery_drained', {
              viewGeneration: generation,
            });
          },
          settle: (token, outcome) => {
            recordTerminalDebugEvent(sessionId, 'terminal_write_coordinator_settled', { token, outcome });
          },
          checkpointApplied: (metadata) => {
            const result = checkpointRuntime.checkpointApplied(metadata);
            if (!result.accepted) {
              throw new Error(result.reason ?? 'checkpoint-apply-ack-failed');
            }
          },
          checkpointDrained: (metadata) => {
            const result = checkpointRuntime.checkpointDrained(metadata);
            if (!result.accepted) {
              throw new Error(result.reason ?? 'checkpoint-drain-ack-failed');
            }
            if (restorePendingRef.current) {
              restoreReleaseSingleFlightRef.current.supersede();
              restoreAttemptEpochRef.current += 1;
              restorePendingRef.current = false;
              restoreCoverageTransactionRef.current = null;
              inFlightOutputRef.current = [];
              clearBufferedOutput();
              bufferedOutputOverflowedRef.current = false;
              failedHeldProvenanceRef.current = null;
              syncInputReadiness('restore-superseded-by-checkpoint-drain');
              onRestorePendingSettled?.();
            }
            completeCompatibilityRollback(metadata);
          },
        }),
        digestBytes: digestTerminalBytes,
        timeoutMs: TERMINAL_RECOVERY_WRITE_COMPLETION_TIMEOUT_MS,
        postCheckpointMaxBytes: coordinatorLimits.visibleOutputQueueMaxBytes,
        postCheckpointMaxChunks: coordinatorLimits.visibleOutputMaxChunks,
        pendingInputMaxBytes: coordinatorInputLimits.inputQueueMaxBytes,
        pendingInputMaxCount: coordinatorLimits.visibleOutputMaxChunks,
        pendingInputTtlMs: coordinatorInputLimits.inputQueueTtlMs,
        settlementLedgerMaxEntries: coordinatorLimits.visibleOutputMaxChunks,
        inputSettlementLedgerMaxEntries: INPUT_SETTLEMENT_LEDGER_MAX_ENTRIES,
        settlementLedgerTtlMs: coordinatorInputLimits.inputQueueTtlMs,
      });
      checkpointMutationLeaseBarrierRef.current = true;
      const unregisterCheckpointDispatcher = registerTerminalCheckpointDispatcher(
        sessionId,
        checkpointRuntime,
      );
      syncInputReadiness('mount');
      const pendingRuntimeRecreationRecovery = runtimeRecreationRecoveryReasonRef.current;
      if (pendingRuntimeRecreationRecovery?.sessionId === sessionId) {
        runtimeRecreationRecoveryReasonRef.current = null;
        const recoveryInstalled = checkpointRuntime.rollbackToLegacy(
          pendingRuntimeRecreationRecovery.reason,
          {
            requestFreshRecovery: !pendingRuntimeRecreationRecovery.recoveryRequested,
          },
        );
        if (!recoveryInstalled.accepted) {
          runtimeRecreationRecoveryReasonRef.current = {
            ...pendingRuntimeRecreationRecovery,
            recoveryRequested: true,
          };
          recordTerminalDebugEvent(sessionId, 'terminal_runtime_recreation_recovery_install_failed', {
            reason: recoveryInstalled.reason ?? 'compatibility-recovery-install-rejected',
            recoveryReason: pendingRuntimeRecreationRecovery.reason,
          });
          requestCheckpointRecovery(
            `runtime-recreation-recovery-install-failed:${pendingRuntimeRecreationRecovery.reason}`,
          );
        } else {
          recordTerminalDebugEvent(sessionId, 'terminal_runtime_recreation_recovery_installed', {
            reason: pendingRuntimeRecreationRecovery.reason,
            recoveryRequested: pendingRuntimeRecreationRecovery.recoveryRequested,
          });
        }
      } else if (pendingRuntimeRecreationRecovery !== null) {
        runtimeRecreationRecoveryReasonRef.current = null;
        recordTerminalDebugEvent(sessionId, 'terminal_runtime_recreation_recovery_handoff_discarded', {
          handoffSessionId: pendingRuntimeRecreationRecovery.sessionId,
          reason: pendingRuntimeRecreationRecovery.reason,
        });
      }

      const unregisterResponderHandoffView = registerTerminalResponderHandoffView(sessionId, {
        getViewGeneration: () => xtermGenerationRef.current,
        onResponderDisableBoundary: (
          message: TerminalResponderDisableBoundaryMessage,
          identity: TerminalResponderBoundaryIdentity,
        ) => {
          if (identity.viewGeneration !== xtermGenerationRef.current) return;
          // @req MIG-BGSTAB-002 AC-3
          // Capability registration may win the reconnect race and activate
          // checkpoint authority before a replayed disable boundary arrives.
          // In that ordering the replacement runtime must inherit the already
          // committed server-responder fence instead of briefly reviving xterm.
          const runtime = installTerminalResponderRuntime(
            identity,
            !checkpointRuntime.getState().active,
          );
          void runtime.disableLegacyParserRepliesAtBoundary(identity).then((result) => {
            if (!result.accepted && terminalResponderHandoffRuntimeRef.current === runtime) {
              recordTerminalDebugEvent(sessionId, 'terminal_responder_disable_rejected', {
                reason: result.reason ?? 'responder-disable-rejected',
                transitionEpoch: message.transitionEpoch,
                viewGeneration: identity.viewGeneration,
              });
            }
          }).catch(() => {
            if (terminalResponderHandoffRuntimeRef.current === runtime) {
              requestCheckpointRecovery('responder-handoff:disable-failed');
            }
          });
        },
        onRollbackStart: (
          message: TerminalAuthorityRollbackStartMessage,
          identity: TerminalResponderBoundaryIdentity,
        ) => {
          if (identity.viewGeneration !== xtermGenerationRef.current) return;
          const rollbackBoundary = checkpointRuntime.beginCompatibilityRollback(message);
          if (!rollbackBoundary.accepted) {
            recordTerminalDebugEvent(sessionId, 'terminal_compatibility_rollback_boundary_rejected', {
              reason: rollbackBoundary.reason ?? 'rollback-boundary-rejected',
              transitionEpoch: identity.transitionEpoch,
              streamEpoch: identity.streamEpoch,
              checkpointEpoch: message.checkpointEpoch,
              viewGeneration: identity.viewGeneration,
            });
            requestCheckpointRecovery(
              `terminal-authority-rollback-boundary:${rollbackBoundary.reason ?? 'rejected'}`,
            );
            return;
          }
          installTerminalResponderRuntime(identity, false);
          pendingCompatibilityRollbackRef.current = Object.freeze({ message, identity });
          queueFocusRestoreIfFocused('terminal-authority-rollback-start');
          checkpointInputBarrierRef.current = true;
          syncInputReadiness('terminal-authority-rollback-start');
          recordTerminalDebugEvent(sessionId, 'terminal_compatibility_rollback_started', {
            transitionEpoch: identity.transitionEpoch,
            streamEpoch: identity.streamEpoch,
            checkpointEpoch: message.checkpointEpoch,
            viewGeneration: identity.viewGeneration,
          });
        },
        onLegacyResponderEnabled: (message: TerminalLegacyResponderEnabledMessage) => {
          let runtime = terminalResponderHandoffRuntimeRef.current;
          if (!runtime && !checkpointRuntime.getState().active) {
            runtime = installTerminalResponderRuntime({
              sessionId: message.sessionId,
              connectionId: message.connectionId,
              viewGeneration: message.viewGeneration,
              transitionEpoch: message.transitionEpoch,
              authorityEpoch: message.authorityEpoch,
              streamEpoch: message.streamEpoch,
              responderLeaseId: message.responderLeaseId,
              boundarySourceSeq: message.boundarySourceSeq,
            }, true);
            recordTerminalDebugEvent(sessionId, 'terminal_legacy_responder_runtime_rebound', {
              transitionEpoch: message.transitionEpoch,
              viewGeneration: message.viewGeneration,
            });
          }
          const controlReceipt = getTerminalControlSocketReceipt();
          if (
            !runtime
            || !runtime.getState().legacyParserRepliesEnabled
            || message.connectionId !== controlReceipt.controlSocketId
            || message.viewGeneration !== xtermGenerationRef.current
          ) {
            recordTerminalDebugEvent(sessionId, 'terminal_legacy_responder_enable_rejected', {
              reason: !runtime
                ? 'responder-runtime-unavailable'
                : !runtime.getState().legacyParserRepliesEnabled
                  ? 'legacy-parser-responder-disabled'
                  : message.connectionId !== controlReceipt.controlSocketId
                    ? 'control-socket-identity-mismatch'
                    : 'view-generation-mismatch',
              receivedConnectionId: message.connectionId,
              currentControlSocketId: controlReceipt.controlSocketId,
              receivedViewGeneration: message.viewGeneration,
              currentViewGeneration: xtermGenerationRef.current,
            });
            return;
          }
          if (checkpointRuntime.getState().legacyRecoveryPending) {
            const completed = checkpointRuntime.completeLegacyRecovery({
              source: 'legacy-responder-enabled',
              viewGeneration: message.viewGeneration,
              streamEpoch: message.streamEpoch,
              checkpointEpoch: message.checkpointEpoch,
            });
            if (!completed.accepted) {
              recordTerminalDebugEvent(sessionId, 'terminal_legacy_responder_checkpoint_commit_rejected', {
                reason: completed.reason ?? 'legacy-recovery-not-ready',
                transitionEpoch: message.transitionEpoch,
                viewGeneration: message.viewGeneration,
              });
              return;
            }
          }
          legacyParserRepliesEnabledRef.current = true;
          terminalQueryResponderIdentityRef.current = Object.freeze({
            sessionId: message.sessionId,
            connectionId: message.connectionId,
            viewGeneration: message.viewGeneration,
            transitionEpoch: message.transitionEpoch,
            authorityEpoch: message.authorityEpoch,
            streamEpoch: message.streamEpoch,
            boundarySourceSeq: message.boundarySourceSeq,
            responderLeaseId: message.responderLeaseId,
            queryReplyCapability: message.queryReplyCapability,
            parserResponderCapability: message.parserResponderCapability,
            driverLeaseGeneration: message.driverLeaseGeneration,
            acceptedViewAttributesGeneration: message.acceptedViewAttributesGeneration,
          });
          terminalQueryReplyOrdinalRef.current = 0;
          checkpointInputBarrierRef.current = false;
          checkpointMutationLeaseBarrierRef.current = false;
          syncInputReadiness('terminal-authority-legacy-responder-enabled');
          recordTerminalDebugEvent(sessionId, 'terminal_legacy_responder_enabled', {
            transitionEpoch: message.transitionEpoch,
            viewGeneration: message.viewGeneration,
          });
          onCompatibilityAuthorityReady?.();
        },
      });

      let pendingUserXtermDataPermits = 0;
      const markUserXtermDataProvenance = (): void => {
        pendingUserXtermDataPermits += 1;
        queueMicrotask(() => {
          pendingUserXtermDataPermits = Math.max(0, pendingUserXtermDataPermits - 1);
        });
      };
      const consumeUserXtermDataProvenance = (): boolean => {
        if (pendingUserXtermDataPermits <= 0) return false;
        pendingUserXtermDataPermits -= 1;
        return true;
      };

      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== 'keydown') return true;

        if (shouldDropStaleRepeatedTerminalKey({ event: ev })) {
          recordTerminalDebugEvent(sessionId, 'stale_key_repeat_dropped', {
            safeKeyName: ev.key,
            repeat: ev.repeat,
            eventAgeMs: Math.max(0, Math.round(performance.now() - ev.timeStamp)),
          });
          ev.preventDefault();
          return false;
        }

        // Mark user as actively typing — suppresses breathing animation for 3s
        const el = containerRef.current;
        if (el && !el.classList.contains('user-active')) {
          el.classList.add('user-active');
        }
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        userActiveTimerRef.current = setTimeout(() => {
          containerRef.current?.classList.remove('user-active');
        }, 3000);

        // Ctrl+C: 선택 복사는 generation-safe coordinator가 소유한다. 미선택은 xterm 기본 SIGINT 경로다.
        const hasClipboardSelection = term.hasSelection() || (
          savedRightClickSelXtermGenerationRef.current === xtermGenerationRef.current
          && savedRightClickSelRef.current.length > 0
        );
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'c' && hasClipboardSelection) {
          void clipboardCoordinator.copySelection('keyboard');
          return false;
        }

        // Ctrl+V: xterm 내부 textarea paste 이벤트가 클립보드를 처리하므로
        // 여기서는 xterm이 \x16(Ctrl+V 문자)을 전송하지 않도록 차단만 한다.
        // 이 핸들러에서 직접 onInput을 호출하면 paste 이벤트와 이중 붙여넣기 발생.
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'v') {
          recordTerminalDebugEvent(sessionId, 'shortcut_binding_skipped', {
            reason: 'reserved',
            shortcutLabel: 'Ctrl+V',
            pasteGuard: true,
          });
          return false;
        }

        // IME 가드: ev.isComposing, keyCode 229, helper textarea composition 상태를 OR 판정한다.
        // compositionend 직후 Space keydown이 같은 이벤트 루프에 도착해도 네이티브 xterm IME 처리에 위임한다.
        const imeSnapshot = imeTransactionRef.current?.getSnapshot() ?? null;
        const imeActive = ev.isComposing || ev.keyCode === 229 || isComposingRef.current || (imeSnapshot?.state !== 'idle');
        if (imeActive) {
          const isSafeSpaceKey = ev.key === ' ' || ev.key === 'Spacebar' || ev.code === 'Space';
          const safeKeyName = isSafeSpaceKey
            ? null
            : ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert'].includes(ev.key)
              ? ev.key
              : null;
          recordTerminalDebugEvent(sessionId, 'ime_guard_delegated', {
            safeKeyName,
            keyCategory: isSafeSpaceKey ? 'space' : safeKeyName ? 'control-navigation' : 'other',
            keyCode: ev.keyCode === 229 ? 229 : null,
            isComposing: ev.isComposing,
            refActive: isComposingRef.current,
            imeState: imeSnapshot?.state ?? 'idle',
            compositionSeq: imeSnapshot?.compositionSeq ?? null,
          });
          markUserXtermDataProvenance();
          return true;
        }

        const shortcutDescriptor = buildTerminalShortcutKeyDescriptor(ev);
        const shortcutLabel = describeTerminalShortcutKey(shortcutDescriptor);
        const shortcutResolution = resolveTerminalShortcut({
          event: shortcutDescriptor,
          state: terminalShortcutStateRef.current,
          workspaceId: workspaceIdRef.current,
          sessionId,
          imeActive: false,
          hasSelection: term.hasSelection(),
        });
        const shortcutDetails = {
          shortcutLabel,
          shortcutCode: shortcutDescriptor.code,
          ctrlKey: shortcutDescriptor.ctrlKey,
          shiftKey: shortcutDescriptor.shiftKey,
          altKey: shortcutDescriptor.altKey,
          metaKey: shortcutDescriptor.metaKey,
          location: shortcutDescriptor.location,
          repeat: shortcutDescriptor.repeat ?? false,
        };

        if (shortcutResolution.kind === 'matched') {
          recordTerminalDebugEvent(sessionId, 'shortcut_binding_matched', {
            ...shortcutDetails,
            bindingId: shortcutResolution.bindingId,
            bindingSource: shortcutResolution.source,
            actionType: shortcutResolution.action.type,
          });

          if (shortcutResolution.action.type === 'send') {
            ev.preventDefault();
            const debugInput = buildTerminalInputDebugPayload(shortcutResolution.action.data, {
              captureSeq: nextCaptureSeq(),
            }, { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) });
            submitCapturedInput(shortcutResolution.action.data, debugInput, 'shortcut-binding');
            return false;
          }

          recordTerminalDebugEvent(sessionId, 'shortcut_binding_blocked', {
            ...shortcutDetails,
            bindingId: shortcutResolution.bindingId,
            bindingSource: shortcutResolution.source,
          });
          ev.preventDefault();
          return false;
        }

        if (shortcutResolution.kind === 'skipped') {
          recordTerminalDebugEvent(sessionId, 'shortcut_binding_skipped', {
            ...shortcutDetails,
            reason: shortcutResolution.reason,
          });
        } else if (shortcutResolution.reason === 'action-pass-through') {
          recordTerminalDebugEvent(sessionId, 'shortcut_binding_passed_through', {
            ...shortcutDetails,
            reason: shortcutResolution.reason,
          });
        }

        const isPlainKey = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
        const isSpaceKey = ev.code === 'Space' || ev.key === ' ' || ev.key === 'Spacebar';
        const isEnterKey = ev.key === 'Enter';
        if (isPlainKey && (isSpaceKey || ev.key === 'Backspace' || isEnterKey)) {
          recordTerminalDebugEvent(sessionId, 'key_event_observed', {
            safeKeyName: isSpaceKey ? null : ev.key,
            keyCategory: isSpaceKey ? 'space' : 'control-navigation',
            repeat: ev.repeat,
            inputReady: inputReadyRef.current,
            restorePending: restorePendingRef.current,
          });
        }
        // 2차 수정: plain Space/Backspace도 xterm 네이티브 경로에 맡긴다.
        // 다만 기존 회귀 테스트와 디버그 추적을 위해 관측 이벤트는 유지한다.
        if (isPlainKey && captureAllowedRef.current && (isSpaceKey || ev.key === 'Backspace')) {
          recordTerminalDebugEvent(sessionId, 'key_delegated_to_xterm', {
            safeKeyName: isSpaceKey ? null : 'Backspace',
            keyCategory: isSpaceKey ? 'space' : 'control-navigation',
            repeat: ev.repeat,
            delegatedToXterm: true,
          });
          markUserXtermDataProvenance();
          return true;
        }

        // 그 외 모든 키는 xterm 네이티브 처리에 위임
        markUserXtermDataProvenance();
        return true;
      });

      // Double rAF ensures layout is fully settled before measuring
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          if (!isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
            recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
              width: container?.offsetWidth ?? 0,
              height: container?.offsetHeight ?? 0,
              reason: 'initial',
            });
            return;
          }
          submitTerminalFit(term, () => {
            recordTerminalDebugEvent(sessionId, 'fit_completed', {
              cols: term.cols,
              rows: term.rows,
              reason: 'initial',
            });
            geometryReadyRef.current = true;
            emitResize(term.cols, term.rows, 'initial');
            syncInputReadiness('initial-fit');
            // term.focus() removed — focus only on user click (handleClick) to prevent
            // focus stealing when multiple terminals are mounted in grid mode (R7)

            // Set terminal background as CSS variable from theme config
            const bg = term.options.theme?.background || '#1e1e1e';
            document.documentElement.style.setProperty('--terminal-bg', bg);
          });
        });
      });

      term.onData((data) => {
        if (data.length === 0) return;
        if (data === '\x1b[I' || data === '\x1b[O') return;
        const programmaticPaste = programmaticPasteRef.current;
        const hasUserInputProvenance = (
          programmaticPaste !== null
          || consumeUserXtermDataProvenance()
        );
        if (replayInputGuard.shouldSuppressXtermData(
          hasUserInputProvenance ? 'user-input' : 'parser-generated',
        )) {
          recordTerminalDebugEvent(sessionId, 'xterm_replay_auto_reply_suppressed', {
            byteLength: getOutputUtf8ByteLength(data),
            provenance: 'parser-generated',
          });
          return;
        }
        if (
          !hasUserInputProvenance
          && isTerminalQueryReply(data, { provenance: 'parser-generated' })
        ) {
          // @req MIG-BGSTAB-002 AC-3
          // The checkpoint runtime is the authoritative reconnect-time fence.
          // A replayed capability/disable ordering must never let a stale local
          // boolean revive xterm's parser side effects while server authority
          // owns the same query stream.
          if (
            checkpointRuntime.getState().active
            || !legacyParserRepliesEnabledRef.current
          ) {
            recordTerminalDebugEvent(sessionId, 'terminal_query_reply_suppressed', {
              reason: checkpointRuntime.getState().active
                ? 'checkpoint-authority-active'
                : 'legacy-parser-responder-disabled',
              byteLength: getOutputUtf8ByteLength(data),
            });
            return;
          }
          if (terminalQueryResponderIdentityRef.current) {
            const routed = routeTerminalQueryReply(data);
            recordTerminalDebugEvent(sessionId, routed.accepted
              ? 'terminal_query_reply_sent'
              : 'terminal_query_reply_rejected', {
              reason: routed.reason ?? null,
              byteLength: getOutputUtf8ByteLength(data),
              replyOrdinal: Math.max(0, terminalQueryReplyOrdinalRef.current - 1),
            });
            return;
          }
          // Initial legacy compatibility mode predates an authority lease. Keep
          // its parser replies on the ordinary path until the exact disable
          // boundary is acknowledged; post-rollback replies always have a lease.
        }
        const compositionSeq = imeTransactionRef.current?.observeXtermData();
        const debugInput = buildTerminalInputDebugPayload(data, {
          captureSeq: programmaticPaste?.captureSeq ?? nextCaptureSeq(),
          compositionSeq,
        }, { captureEnabled: isTerminalDebugCaptureEnabled(sessionId) });
        const source = programmaticPaste?.source ?? 'xterm';
        const result = submitCapturedInput(data, debugInput, source);
        if (programmaticPaste) {
          programmaticPaste.result = result;
          programmaticPasteRef.current = null;
        }
      });

      // Track terminal focus via DOM events (xterm v5 has no onFocus/onBlur API)
      const termEl = terminalRef.current!;
      const onFocusIn = () => {
        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.add('terminal-focused');
      };
      const onFocusOut = (event: FocusEvent) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && termEl.contains(nextTarget)) {
          return;
        }

        if (
          pendingFocusRestoreRef.current
          && (!nextTarget || nextTarget === document.body || nextTarget === document.documentElement)
        ) {
          containerRef.current?.classList.add('terminal-focused');
          return;
        }

        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
      };
      const onDocumentPointerDownCapture = (event: PointerEvent) => {
        if (!pendingFocusRestoreRef.current) {
          return;
        }

        const target = event.target;
        if (target instanceof Node && termEl.contains(target)) {
          return;
        }

        pendingFocusRestoreRef.current = false;
        containerRef.current?.classList.remove('terminal-focused');
        recordTerminalDebugEvent(sessionId, 'focus_restore_cancelled', { reason: 'external-pointer' });
      };
      termEl.addEventListener('focusin', onFocusIn);
      termEl.addEventListener('focusout', onFocusOut);
      document.addEventListener('pointerdown', onDocumentPointerDownCapture, true);

      // xterm v6은 paste 이벤트에서 clipboardData를 읽어 처리한 뒤 preventDefault를 호출하지 않아
      // 브라우저가 textarea에 텍스트를 추가로 삽입하고 input 이벤트를 발생시킨다.
      // 일부 Chrome/Windows 환경에서 해당 input 이벤트가 insertText 타입으로 올 경우
      // xterm의 _inputEvent 핸들러가 두 번째 triggerDataEvent를 호출해 이중 붙여넣기가 발생한다.
      // capture 단계에서 preventDefault를 호출하면 브라우저 삽입 동작만 막고
      // xterm 내부 paste 핸들러(clipboardData 읽기)는 그대로 실행된다.
      const onPasteCapture = (e: Event) => {
        markUserXtermDataProvenance();
        e.preventDefault();
      };
      termEl.addEventListener('paste', onPasteCapture, { capture: true });

      // Helper textarea IME event tape는 원문 없이 sequence/length metadata만 기록한다.
      const onHelperKeyDown = (event: KeyboardEvent) => {
        recordHelperTape('helper_keydown', event, { captureSeq: nextCaptureSeq() });
      };
      const onHelperBeforeInput = (event: Event) => {
        if (event instanceof InputEvent) {
          const compositionSeq = imeTransactionRef.current?.observeBeforeInput(
            event.inputType,
            Array.from(event.data ?? '').length,
          );
          recordHelperTape('helper_beforeinput', event, {
            captureSeq: nextCaptureSeq(),
            compositionSeq,
          });
        }
      };
      const onHelperInput = (event: Event) => {
        markUserXtermDataProvenance();
        if (event instanceof InputEvent) {
          const compositionSeq = imeTransactionRef.current?.observeInput(
            event.inputType,
            Array.from(event.data ?? '').length,
          );
          recordHelperTape('helper_input', event, {
            captureSeq: nextCaptureSeq(),
            compositionSeq,
          });
        }
      };
      const onCompositionStart = (event: CompositionEvent) => {
        const compositionSeq = imeTransactionRef.current?.beginComposition();
        isComposingRef.current = true;
        recordHelperTape('helper_compositionstart', event, { compositionSeq });
      };
      const onCompositionUpdate = (event: CompositionEvent) => {
        const compositionSeq = imeTransactionRef.current?.updateComposition();
        recordHelperTape('helper_compositionupdate', event, { compositionSeq });
      };
      const onCompositionEnd = (event: CompositionEvent) => {
        const compositionSeq = imeTransactionRef.current?.endComposition(
          Array.from(event.data ?? '').length,
        );
        recordHelperTape('helper_compositionend', event, { compositionSeq });
      };
      if (helperTextarea) {
        helperTextarea.addEventListener('keydown', onHelperKeyDown);
        helperTextarea.addEventListener('beforeinput', onHelperBeforeInput);
        helperTextarea.addEventListener('input', onHelperInput, { capture: true });
        helperTextarea.addEventListener('compositionstart', onCompositionStart);
        helperTextarea.addEventListener('compositionupdate', onCompositionUpdate);
        helperTextarea.addEventListener('compositionend', onCompositionEnd);
      }
      const unregisterInputTransportOverride = registerInputTransportOverrideHandler(sessionId, (override) => {
        inputTransportOverrideRef.current = override;
        syncInputReadiness(override ? 'debug-transport-override' : 'debug-transport-override-cleared');
      });
      const unregisterInputGateSnapshotReader = registerInputGateSnapshotReader(sessionId, () => {
        const gate = computeInputGateSnapshot();
        return {
          inputReady: gate.transportReady,
          captureState: gate.captureState,
          barrierReason: gate.barrierReason,
          closedReason: gate.closedReason,
          restorePending: restorePendingRef.current,
          geometryReady: geometryReadyRef.current,
          serverReady: gate.transportState.serverReady,
        };
      });
      const unregisterRepairLayoutHandler = registerTerminalRepairLayoutHandler(sessionId, (reason) => {
        return repairLayoutAfterIme(reason);
      });
      const unregisterRetainedStateCaptureHandler = registerTerminalRetainedStateCaptureHandler(
        sessionId,
        () => createTerminalRetainedStateEvidence(captureTerminalRetainedState(term)),
      );
      const unregisterRetainedStateStreamingCaptureHandler =
        registerTerminalRetainedStateStreamingCaptureHandler(
          sessionId,
          options => captureTerminalRetainedStateStreaming(term, options),
        );

      // 우클릭 캡처: DOM selectionchange가 xterm 선택을 지우기 전에 선택 텍스트 저장
      // (DOM 렌더러 모드에서 right-click mousedown이 DOM selection을 collapse시켜
      //  xterm이 자신의 selection을 clearSelection() 하는 타이밍 문제 해결)
      const onMouseDownCapture = (e: MouseEvent) => {
        if (e.button === 2) {
          savedRightClickSelRef.current = term.getSelection();
          savedRightClickSelGenerationRef.current += 1;
          savedRightClickSelXtermGenerationRef.current = xtermGenerationRef.current;
        } else if (e.button === 0) {
          savedRightClickSelRef.current = '';
          savedRightClickSelGenerationRef.current += 1;
          savedRightClickSelXtermGenerationRef.current = 0;
        }
      };
      containerRef.current!.addEventListener('mousedown', onMouseDownCapture, true);

      // window.resize listener removed — ResizeObserver covers all size changes

      let rafId: number | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        // 0-size 가드: display:none 상태(워크스페이스 비활성)에서는 fit 및 PTY resize 스킵
        const container = containerRef.current;
        if (!isVisibleRef.current || !container || container.offsetWidth === 0 || container.offsetHeight === 0) {
          recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
            width: container?.offsetWidth ?? 0,
            height: container?.offsetHeight ?? 0,
          });
          return;
        }

        // rAF throttle: visual fit at most once per frame
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          submitTerminalFit(term, () => {
            recordTerminalDebugEvent(sessionId, 'fit_completed', {
              cols: term.cols,
              rows: term.rows,
              reason: 'resize-observer',
            });
            geometryReadyRef.current = true;
            syncInputReadiness('resize-observer');
            rafId = null;
            // Debounce server PTY resize to avoid flooding during drag
            if (resizeTimer !== null) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              emitResize(term.cols, term.rows, 'resize-observer');
              resizeTimer = null;
            }, 100);
          }, () => {
            rafId = null;
          });
        });
      });
      // Observe both .terminal-view and .terminal-container (FitAddon measures the latter)
      resizeObserver.observe(containerRef.current!);
      resizeObserver.observe(terminalRef.current!);

      return () => {
        containerRef.current?.removeEventListener('mousedown', onMouseDownCapture, true);
        termEl.removeEventListener('paste', onPasteCapture, { capture: true });
        unregisterInputTransportOverride();
        unregisterInputGateSnapshotReader();
        unregisterRepairLayoutHandler();
        unregisterRetainedStateCaptureHandler();
        unregisterRetainedStateStreamingCaptureHandler();
        if (helperTextarea) {
          helperTextarea.removeEventListener('keydown', onHelperKeyDown);
          helperTextarea.removeEventListener('beforeinput', onHelperBeforeInput);
          helperTextarea.removeEventListener('input', onHelperInput, { capture: true });
          helperTextarea.removeEventListener('compositionstart', onCompositionStart);
          helperTextarea.removeEventListener('compositionupdate', onCompositionUpdate);
          helperTextarea.removeEventListener('compositionend', onCompositionEnd);
        }
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        if (idleSnapshotTimerRef.current) {
          clearTimeout(idleSnapshotTimerRef.current);
          idleSnapshotTimerRef.current = null;
        }
        if (userActiveTimerRef.current) clearTimeout(userActiveTimerRef.current);
        if (outputTimerRef.current) clearTimeout(outputTimerRef.current);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        imeTransactionRef.current?.dispose();
        termEl.removeEventListener('focusin', onFocusIn);
        termEl.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('pointerdown', onDocumentPointerDownCapture, true);
        resizeObserver.disconnect();
        const snapshotLimits = getSnapshotResourceLimits();
        if (isTerminalSnapshotRemovalRequested(sessionId, { tombstoneTtlMs: snapshotLimits.tombstoneTtlMs })) {
          clearTerminalSnapshotRemovalRequest(sessionId);
        } else if (restorePendingRef.current) {
          persistBufferedOutput();
        } else {
          saveSnapshot();
        }
        serializeAddonRef.current = null;
        fitAddonRef.current = null;
        terminalDisposedRef.current = true;
        outputIngressRetryQueueRef.current?.reset();
        outputIngressRetryQueueRef.current = null;
        outputSchedulerRef.current?.reset('terminal-disposed');
        outputSchedulerRef.current = null;
        outputSchedulerTermRef.current = null;
        restoreReleaseSingleFlight.supersede();
        restoreAttemptEpochRef.current += 1;
        replayInputGuard.reset();
        terminalRestoreAdapterRef.current?.handle({ type: 'dispose' });
        terminalRestoreAdapterRef.current = null;
        if (checkpointRuntime.getState().legacyRecoveryPending) {
          const pendingRecovery = runtimeRecreationRecoveryReasonRef.current;
          if (pendingRecovery === null || pendingRecovery.sessionId !== sessionId) {
            runtimeRecreationRecoveryReasonRef.current = {
              sessionId,
              reason: 'bounded-reconnect-runtime-replacement',
              recoveryRequested: true,
            };
          }
        }
        unregisterResponderHandoffView();
        unregisterTerminalResponderRuntimeRef.current?.();
        unregisterTerminalResponderRuntimeRef.current = null;
        const responderRuntime = terminalResponderHandoffRuntimeRef.current;
        terminalResponderHandoffRuntimeRef.current = null;
        responderRuntime?.dispose('runtime-replaced');
        pendingCompatibilityRollbackRef.current = null;
        terminalQueryResponderIdentityRef.current = null;
        terminalQueryReplyOrdinalRef.current = 0;
        legacyParserRepliesEnabledRef.current = true;
        unregisterCheckpointDispatcher();
        checkpointRuntime.dispose();
        terminalCheckpointRuntimeRef.current = null;
        const disposeGeneration = terminalWriteCoordinatorRef.current?.getState().viewGeneration
          ?? coordinatorGeneration;
        terminalWriteCoordinatorRef.current?.dispatch({
          type: 'dispose',
          viewGeneration: disposeGeneration,
        });
        terminalWriteCoordinatorRef.current = null;
        savedRightClickSelRef.current = '';
        savedRightClickSelGenerationRef.current += 1;
        savedRightClickSelXtermGenerationRef.current = 0;
        clipboardViewGenerationRef.current += 1;
        xtermRef.current = null;
        geometryReadyRef.current = false;
        serverReadyRef.current = false;
        restorePendingRef.current = false;
        inputReadyRef.current = false;
        captureStateRef.current = 'closed';
        captureAllowedRef.current = false;
        transportReadyRef.current = false;
        transportClosedReasonRef.current = 'terminal-disposed';
        checkpointInputBarrierRef.current = false;
        checkpointMutationLeaseBarrierRef.current = false;
        legacyAuthorityReadySyncPendingRef.current = false;
        inFlightOutputRef.current = [];
        clearBufferedOutput();
        recordTerminalDebugEvent(sessionId, 'terminal_disposed');
        term.dispose();
      };
    }, [
      sessionId,
      beginRestoreAttempt,
      awaitOutputIdleWithFifoProbe,
      clipboardCoordinator,
      clearBufferedOutput,
      computeInputGateSnapshot,
      emitResize,
      getInitialFontSize,
      getHelperTextarea,
      getTerminalControlSocketReceipt,
      nextCaptureSeq,
      onRestorePendingSettled,
      onVisibleOutputOverflow,
      persistBufferedOutput,
      repairLayoutAfterIme,
      saveSnapshot,
      registerTerminalCheckpointDispatcher,
      refreshTerminalCheckpointRegistration,
      registerTerminalResponderHandoffRuntime,
      registerTerminalResponderHandoffView,
      routeTerminalQueryReply,
      sendTerminalAuthorityControl,
      submitCapturedInput,
      submitCapturedInputDirect,
      submitTerminalFit,
      syncInputReadiness,
      terminalRuntimeRevision,
      flushPendingUserInputBeforeQueryReply,
    ]);

    useEffect(() => {
      workspaceIdRef.current = workspaceId;
      terminalShortcutStateRef.current = terminalShortcutState;
    }, [terminalShortcutState, workspaceId]);

    useEffect(() => {
      const wasVisible = previousVisibilityRef.current;
      previousVisibilityRef.current = isVisible;
      isVisibleRef.current = isVisible;

      const term = xtermRef.current;
      if (!term) {
        return;
      }

      if (wasVisible === isVisible) {
        return;
      }

      if (!isVisible) {
        syncInputReadiness('hidden');
        return;
      }

      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
          recordTerminalDebugEvent(sessionId, 'fit_skipped_non_renderable', {
            width: container?.offsetWidth ?? 0,
            height: container?.offsetHeight ?? 0,
            reason: 'visible',
          });
          return;
        }

        submitTerminalFit(term, () => {
          recordTerminalDebugEvent(sessionId, 'fit_completed', {
            cols: term.cols,
            rows: term.rows,
            reason: 'visible',
          });
          geometryReadyRef.current = true;
          emitResize(term.cols, term.rows, 'visible');
          syncInputReadiness('visible-fit');
        });
      });
    }, [emitResize, isVisible, sessionId, submitTerminalFit, syncInputReadiness]);

    useEffect(() => {
      const persistSnapshot = () => {
        if (idleSnapshotTimerRef.current) {
          clearTimeout(idleSnapshotTimerRef.current);
          idleSnapshotTimerRef.current = null;
        }
        if (restorePendingRef.current) {
          persistBufferedOutput();
        } else {
          saveSnapshot();
        }
      };

      window.addEventListener('beforeunload', persistSnapshot);
      window.addEventListener('pagehide', persistSnapshot);
      return () => {
        window.removeEventListener('beforeunload', persistSnapshot);
        window.removeEventListener('pagehide', persistSnapshot);
      };
    }, [persistBufferedOutput, saveSnapshot]);

    // Desktop: Ctrl+Wheel font zoom
    useEffect(() => {
      if (isMobile) return;
      const container = containerRef.current;
      if (!container) return;

      const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const currentSize = xtermRef.current?.options.fontSize || FONT_DEFAULT;
          const delta = e.deltaY < 0 ? 1 : -1;
          const newSize = Math.max(FONT_MIN, Math.min(FONT_MAX, currentSize + delta));
          handleFontSizeChange(newSize);
          localStorage.setItem(FONT_STORAGE_KEY, newSize.toString());
        }
      };

      // Use capture phase to intercept Ctrl+Wheel before xterm's viewport scrolls
      container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
      return () => container.removeEventListener('wheel', handleWheel, { capture: true });
    }, [isMobile, handleFontSizeChange]);

    // Mobile: single-touch pan scroll + two-touch pinch zoom
    useEffect(() => {
      if (!isMobile) return;
      const container = containerRef.current;
      if (!container) return;
      const onTouchEnd = () => finishMobileTouchGesture('touchend');
      const onTouchCancel = () => finishMobileTouchGesture('touchcancel');

      container.addEventListener('touchstart', handleMobileTouchStart, { passive: false });
      container.addEventListener('touchmove', handleMobileTouchMove, { passive: false });
      container.addEventListener('touchend', onTouchEnd);
      container.addEventListener('touchcancel', onTouchCancel);

      return () => {
        container.removeEventListener('touchstart', handleMobileTouchStart);
        container.removeEventListener('touchmove', handleMobileTouchMove);
        container.removeEventListener('touchend', onTouchEnd);
        container.removeEventListener('touchcancel', onTouchCancel);
      };
    }, [isMobile, handleMobileTouchStart, handleMobileTouchMove, finishMobileTouchGesture]);



    const handleClick = useCallback(() => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        recordTerminalDebugEvent(sessionId, 'mobile_touch_click_suppressed');
        return;
      }
      focusTerminalInput('terminal-view-click');
    }, [focusTerminalInput, sessionId]);

    const handleManualRepairMouseEvent = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !onManualRepair) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onManualRepair?.();
    }, [onManualRepair]);

    const handleManualRepairPointerEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 1 || !onManualRepair) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onManualRepair?.();
    }, [onManualRepair]);

    return (
      <div
        className="terminal-view"
        ref={containerRef}
        data-terminal-view="true"
        style={isMobile ? { touchAction: 'none' } : undefined}
        onClick={handleClick}
        onPointerDownCapture={handleManualRepairPointerEvent}
        onMouseDownCapture={handleManualRepairMouseEvent}
        onAuxClickCapture={handleManualRepairMouseEvent}
      >
        <div ref={terminalRef} className="terminal-container" data-terminal-container="true" />
        <FontSizeToast fontSize={toastFontSize} />
      </div>
    );
  }
);

TerminalView.displayName = 'TerminalView';

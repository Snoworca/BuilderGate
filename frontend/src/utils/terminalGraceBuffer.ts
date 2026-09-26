// @req REL-BGSTAB-009 AC-1 AC-2 AC-3
//
// The remount grace lane: while a session is detached (handler removed, pending
// unsubscribe timer armed) server frames are held here instead of reaching a
// view that does not exist. This is a temporary safety rail ahead of the new
// server authority — it does not widen local-snapshot semantics and adds no
// cache.
//
// It lived inside `WebSocketContext` as two zero-dependency `useCallback`s, so
// the only way to assert anything about it was to regex its source text. Those
// gates are satisfied by any rewrite that keeps the same tokens while inverting
// the behaviour, which is exactly what AC-3 is about: the order of
// `snapshot → held tail → ready` is the contract, and a check on the final
// buffer contents passes under the wrong order. Extracting it unchanged makes
// the order observable to a test.
import { getOutputUtf8ByteLength } from './terminalOutputHotPath.ts';
import { getTerminalResourceLimits } from './inputReliabilityMode.ts';
import { fromJsonOutputMessage, type TerminalOutputDelivery } from './terminalOutputDelivery.ts';
import { recordTerminalDebugEvent } from './terminalDebugCapture.ts';
import {
  hasSameRestoreNeededAuthorityProof,
  matchesRestoreNeededSnapshotAuthorityProof,
} from './visibleOutputRecovery.ts';
import type {
  ScreenRepairReconnectRequiredMessage,
  ScreenRepairRestoreNeededMessage,
  ScreenSnapshotMessage,
  ServerWsMessage,
  TerminalOutputMessage,
  TerminalSessionReadyMessage,
} from '../types/ws-protocol.ts';

export interface GraceBufferedSessionState {
  snapshot?: ScreenSnapshotMessage;
  output: TerminalOutputMessage[];
  outputBytes: number;
  outputOverflowReason?: 'byte-cap-exceeded' | 'chunk-cap-exceeded';
  authorityProofMismatch?: boolean;
  restoreNeeded?: ScreenRepairRestoreNeededMessage;
  reconnectRequired?: ScreenRepairReconnectRequiredMessage;
  subscribedInfo?: { status: string; cwd?: string; ready: boolean };
  ready?: TerminalSessionReadyMessage;
  status?: string;
  cwd?: string;
  error?: string;
}

/**
 * Structural subset of `SessionHandlers` that the flush calls. Declared here
 * rather than imported so this module does not depend on the context that uses
 * it; `SessionHandlers` remains assignable to it.
 */
export interface TerminalGraceBufferFlushHandlers {
  onScreenSnapshot?: (snapshot: ScreenSnapshotMessage) => void;
  onScreenRepairRestoreNeeded?: (message: ScreenRepairRestoreNeededMessage) => void;
  onScreenRepairReconnectRequired?: (message: ScreenRepairReconnectRequiredMessage) => void;
  onSubscribed?: (info: { status: string; cwd?: string; ready: boolean }) => void;
  onSessionReady?: (message: TerminalSessionReadyMessage) => void;
  onOutput?: (delivery: TerminalOutputDelivery) => void;
  onGraceOutputOverflow?: (reason: 'byte-cap-exceeded' | 'chunk-cap-exceeded') => void;
  onGraceAuthorityProofMismatch?: () => void;
  onStatus?: (status: string) => void;
  onError?: (message: string) => void;
  onCwd?: (cwd: string) => void;
}

export function createGraceBufferedSessionState(): GraceBufferedSessionState {
  return { output: [], outputBytes: 0 };
}

/**
 * Admits one server frame into the grace state for a detached session.
 *
 * Mutates and returns `current` — the caller owns the map entry.
 */
export function applyGraceBufferedMessage(
  current: GraceBufferedSessionState,
  sessionId: string,
  msg: ServerWsMessage,
): GraceBufferedSessionState {
  switch (msg.type) {
    case 'screen-snapshot':
      if (current.reconnectRequired || current.authorityProofMismatch) {
        recordTerminalDebugEvent(sessionId, 'websocket_grace_snapshot_after_reconnect_ignored', {
          replayToken: msg.replayToken,
          snapshotSeq: msg.seq,
        });
        break;
      }
      if (
        current.restoreNeeded
        && (
          !matchesRestoreNeededSnapshotAuthorityProof(current.restoreNeeded, msg)
        )
      ) {
        recordTerminalDebugEvent(sessionId, 'websocket_grace_snapshot_generation_mismatch', {
          replayToken: msg.replayToken,
          snapshotSeq: msg.seq,
          expectedReplayToken: current.restoreNeeded.replayToken,
          expectedSnapshotSeq: current.restoreNeeded.snapshotSeq,
        });
        current.authorityProofMismatch = true;
        current.snapshot = undefined;
        current.ready = undefined;
        current.output = [];
        current.outputBytes = 0;
        break;
      }
      current.snapshot = msg;
      // A ready frame can only complete the snapshot generation that was
      // already observed. Snapshot replacement therefore invalidates any
      // older grace-buffered ready token.
      current.ready = undefined;
      if (!current.restoreNeeded) {
        current.output = [];
        current.outputBytes = 0;
        current.outputOverflowReason = undefined;
      }
      break;
    case 'screen-repair':
    case 'screen-repair:rejected':
      recordTerminalDebugEvent(sessionId, 'screen_repair_grace_buffer_skipped', {
        type: msg.type,
        reason: msg.type === 'screen-repair:rejected' ? msg.reason : null,
      });
      break;
    case 'screen-repair:restore-needed':
      if (current.reconnectRequired) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_restore_after_reconnect_ignored', {
          repairToken: msg.repairToken,
          replayToken: msg.replayToken,
          snapshotSeq: msg.snapshotSeq,
        });
        break;
      }
      if (!hasSameRestoreNeededAuthorityProof(msg, msg)) {
        recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_invalid_proof_ignored', {
          repairToken: msg.repairToken,
          replayToken: msg.replayToken,
          snapshotSeq: msg.snapshotSeq,
        });
        current.authorityProofMismatch = true;
        current.restoreNeeded = undefined;
        current.snapshot = undefined;
        current.ready = undefined;
        current.output = [];
        current.outputBytes = 0;
        break;
      }
      if (
        current.restoreNeeded?.repairToken === msg.repairToken
        && current.restoreNeeded.replayToken === msg.replayToken
        && current.restoreNeeded.snapshotSeq === msg.snapshotSeq
      ) {
        if (!hasSameRestoreNeededAuthorityProof(current.restoreNeeded, msg)) {
          recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_proof_mismatch_ignored', {
            repairToken: msg.repairToken,
            replayToken: msg.replayToken,
            snapshotSeq: msg.snapshotSeq,
          });
          current.authorityProofMismatch = true;
          current.restoreNeeded = undefined;
          current.snapshot = undefined;
          current.ready = undefined;
          current.output = [];
          current.outputBytes = 0;
          break;
        }
        recordTerminalDebugEvent(sessionId, 'screen_repair_restore_grace_duplicate_ignored', {
          repairToken: msg.repairToken,
          replayToken: msg.replayToken,
          snapshotSeq: msg.snapshotSeq,
        });
        break;
      }
      current.restoreNeeded = msg;
      current.authorityProofMismatch = false;
      current.reconnectRequired = undefined;
      current.snapshot = undefined;
      current.ready = undefined;
      current.output = [];
      current.outputBytes = 0;
      current.outputOverflowReason = undefined;
      break;
    case 'screen-repair:reconnect-required':
      current.reconnectRequired = msg;
      current.restoreNeeded = undefined;
      current.snapshot = undefined;
      current.ready = undefined;
      current.output = [];
      current.outputBytes = 0;
      current.outputOverflowReason = undefined;
      break;
    case 'output':
      {
        if (current.reconnectRequired) {
          break;
        }
        if (
          current.restoreNeeded
          && msg.replayToken !== current.restoreNeeded.replayToken
        ) {
          recordTerminalDebugEvent(sessionId, 'websocket_grace_output_generation_mismatch', {
            replayToken: msg.replayToken ?? null,
            expectedReplayToken: current.restoreNeeded.replayToken,
            screenSeq: msg.screenSeq ?? null,
          });
          break;
        }
        if (current.outputOverflowReason) {
          break;
        }
        const limits = getTerminalResourceLimits();
        const messageBytes = getOutputUtf8ByteLength(msg.data);
        const byteOverflow = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;
        const chunkOverflow = current.output.length + 1 > limits.visibleOutputMaxChunks;
        if (byteOverflow || chunkOverflow) {
          current.output = [];
          current.outputBytes = 0;
          current.outputOverflowReason = byteOverflow
            ? 'byte-cap-exceeded'
            : 'chunk-cap-exceeded';
          recordTerminalDebugEvent(sessionId, 'websocket_grace_output_overflow', {
            reason: current.outputOverflowReason,
            messageBytes,
            maxBytes: limits.visibleOutputQueueMaxBytes,
            maxChunks: limits.visibleOutputMaxChunks,
          });
          break;
        }
        current.output.push(msg);
        current.outputBytes += messageBytes;
      }
      break;
    case 'status':
      current.status = msg.status;
      break;
    case 'session:ready':
      if (current.reconnectRequired) {
        break;
      }
      if (
        current.restoreNeeded
        && (
          !current.snapshot
          || msg.replayToken !== current.restoreNeeded.replayToken
          || msg.snapshotSeq !== current.restoreNeeded.snapshotSeq
        )
      ) {
        recordTerminalDebugEvent(sessionId, 'websocket_grace_ready_generation_mismatch', {
          replayToken: msg.replayToken ?? null,
          snapshotSeq: msg.snapshotSeq ?? null,
          expectedReplayToken: current.restoreNeeded.replayToken,
          expectedSnapshotSeq: current.restoreNeeded.snapshotSeq,
        });
        break;
      }
      if (
        current.snapshot
        && !current.restoreNeeded
        && (
          msg.replayToken !== current.snapshot.replayToken
          || msg.snapshotSeq !== current.snapshot.seq
        )
      ) {
        recordTerminalDebugEvent(sessionId, 'websocket_grace_ready_snapshot_mismatch', {
          replayToken: msg.replayToken ?? null,
          snapshotSeq: msg.snapshotSeq ?? null,
          expectedReplayToken: current.snapshot.replayToken,
          expectedSnapshotSeq: current.snapshot.seq,
        });
        break;
      }
      current.ready = msg;
      break;
    case 'input:rejected':
      recordTerminalDebugEvent(msg.sessionId, 'server_input_rejected', {
        reason: msg.reason,
        inputSeqStart: msg.inputSeqStart ?? null,
        inputSeqEnd: msg.inputSeqEnd ?? null,
        buffered: true,
      });
      break;
    case 'cwd':
      current.cwd = msg.cwd;
      break;
    case 'session:error':
      current.error = msg.message;
      break;
    case 'session:exited':
      current.error = `Shell exited with code ${msg.exitCode}`;
      break;
  }

  return current;
}

/**
 * Hands one grace generation to a freshly attached view.
 *
 * AC-3 order, and it is the order that is the product: restore barrier →
 * current server snapshot → post-snapshot held tail → `session:ready`. Ready is
 * what releases queued input, so it is last and it is withheld whenever the
 * generation did not converge (reconnect, proof mismatch, overflow, or a
 * restore with no snapshot).
 */
export function flushGraceBufferedSession(
  buffered: GraceBufferedSessionState,
  handlers: TerminalGraceBufferFlushHandlers,
): void {
  const recoveryTerminal = Boolean(buffered.reconnectRequired) || Boolean(buffered.authorityProofMismatch);
  const recoveryBlocked = recoveryTerminal || Boolean(buffered.outputOverflowReason) || Boolean(buffered.restoreNeeded);
  const recoverySnapshotReady = !buffered.restoreNeeded || Boolean(buffered.snapshot);
  if (!recoveryTerminal && buffered.restoreNeeded) {
    handlers.onScreenRepairRestoreNeeded?.(buffered.restoreNeeded);
  }
  if (buffered.reconnectRequired) {
    handlers.onScreenRepairReconnectRequired?.(buffered.reconnectRequired);
  }
  if (buffered.outputOverflowReason) {
    handlers.onGraceOutputOverflow?.(buffered.outputOverflowReason);
  }
  if (buffered.authorityProofMismatch) {
    handlers.onGraceAuthorityProofMismatch?.();
  }
  if (buffered.subscribedInfo) {
    handlers.onSubscribed?.({
      ...buffered.subscribedInfo,
      ready: recoveryBlocked ? false : buffered.subscribedInfo.ready,
    });
  }
  if (!recoveryTerminal && !buffered.outputOverflowReason && buffered.snapshot) {
    handlers.onScreenSnapshot?.(buffered.snapshot);
  }
  if (buffered.status) {
    handlers.onStatus?.(buffered.status);
  }
  if (buffered.cwd) {
    handlers.onCwd?.(buffered.cwd);
  }
  if (!recoveryTerminal && recoverySnapshotReady) {
    for (const output of buffered.output) {
      handlers.onOutput?.(fromJsonOutputMessage(output.data, output));
    }
  }
  if (!recoveryTerminal && recoverySnapshotReady && !buffered.outputOverflowReason && buffered.ready) {
    handlers.onSessionReady?.(buffered.ready);
  }
  if (buffered.error) {
    handlers.onError?.(buffered.error);
  }
}

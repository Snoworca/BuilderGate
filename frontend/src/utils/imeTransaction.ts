export type ImeState = 'idle' | 'composing' | 'committing' | 'settling';

export type ImeDeferredKind = 'repair' | 'snapshot' | 'capture-close';

export type ImeTelemetryValue = string | number | boolean | null;

export interface ImeTransactionSnapshot {
  state: ImeState;
  compositionSeq: number | null;
  sessionGeneration: number;
  xtermDataSeen: boolean;
  commitCandidateLength: number;
  deferredCount: number;
}

export interface ImeWaitResult {
  status: 'ready' | 'context-changed' | 'disposed';
}

interface ImeDeferredWaiter {
  kind: ImeDeferredKind;
  reason: string;
  compositionSeq: number | null;
  sessionGeneration: number;
  resolve: (result: ImeWaitResult) => void;
}

interface ImeTransactionRuntime {
  getSessionGeneration?: () => number;
  onEvent?: (kind: string, details: Record<string, ImeTelemetryValue>) => void;
  onStateChange?: (snapshot: ImeTransactionSnapshot) => void;
}

export interface ImeTransactionOptions extends ImeTransactionRuntime {
  settleDelayMs?: number;
  commitObservationMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_SETTLE_DELAY_MS = 40;
const DEFAULT_COMMIT_OBSERVATION_MS = 50;

const COMPOSITION_COMMIT_INPUT_TYPES = new Set([
  'insertFromComposition',
]);

const COMPOSITION_METADATA_INPUT_TYPES = new Set([
  'insertCompositionText',
  'deleteCompositionText',
  'insertFromComposition',
]);

export class ImeTransaction {
  private state: ImeState = 'idle';
  private lastCompositionSeq = 0;
  private activeCompositionSeq: number | null = null;
  private activeSessionGeneration = 0;
  private xtermDataSeen = false;
  private commitCandidateLength = 0;
  private commitCandidateSource: string | null = null;
  private fallbackObservedSeq: number | null = null;
  private settleTimer: unknown | null = null;
  private commitTimer: unknown | null = null;
  private readonly settleDelayMs: number;
  private readonly commitObservationMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimerHandle: (handle: unknown) => void;
  private runtime: Required<ImeTransactionRuntime>;
  private deferredWaiters: ImeDeferredWaiter[] = [];

  constructor(options: ImeTransactionOptions = {}) {
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    this.commitObservationMs = options.commitObservationMs ?? DEFAULT_COMMIT_OBSERVATION_MS;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimerHandle = options.clearTimeout ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    this.runtime = {
      getSessionGeneration: options.getSessionGeneration ?? (() => 0),
      onEvent: options.onEvent ?? (() => {}),
      onStateChange: options.onStateChange ?? (() => {}),
    };
  }

  configure(runtime: ImeTransactionRuntime): void {
    this.runtime = {
      ...this.runtime,
      ...runtime,
    };
  }

  beginComposition(): number {
    const previousCompositionSeq = this.activeCompositionSeq;
    const previousSessionGeneration = this.activeSessionGeneration;
    const seq = this.lastCompositionSeq + 1;
    this.lastCompositionSeq = seq;
    this.clearCommitTimer();
    this.clearSettleTimer();
    if (previousCompositionSeq !== null && this.state !== 'idle') {
      this.retargetSupersededWaiters(previousCompositionSeq, previousSessionGeneration, seq);
    }
    this.activeCompositionSeq = seq;
    this.activeSessionGeneration = this.currentSessionGeneration();
    this.xtermDataSeen = false;
    this.commitCandidateLength = 0;
    this.commitCandidateSource = null;
    this.fallbackObservedSeq = null;
    this.transition('composing', 'compositionstart');
    return seq;
  }

  updateComposition(): number {
    return this.ensureActiveComposition('compositionupdate');
  }

  observeBeforeInput(inputType: string, dataLength: number): number | undefined {
    if (!COMPOSITION_METADATA_INPUT_TYPES.has(inputType)) {
      return this.activeCompositionSeq ?? undefined;
    }

    const seq = this.ensureActiveComposition(`beforeinput-${inputType}`);
    if (COMPOSITION_COMMIT_INPUT_TYPES.has(inputType) && dataLength > 0) {
      this.rememberCommitCandidate(dataLength, inputType);
    }
    return seq;
  }

  observeInput(inputType: string, dataLength: number): number | undefined {
    if (!COMPOSITION_METADATA_INPUT_TYPES.has(inputType)) {
      return this.activeCompositionSeq ?? undefined;
    }

    const seq = this.ensureActiveComposition(`input-${inputType}`);
    if (COMPOSITION_COMMIT_INPUT_TYPES.has(inputType) && dataLength > 0) {
      this.rememberCommitCandidate(dataLength, inputType);
    }
    return seq;
  }

  endComposition(dataLength: number): number {
    const seq = this.ensureActiveComposition('compositionend');
    if (dataLength > 0) {
      this.rememberCommitCandidate(dataLength, 'compositionend');
    }

    if (this.xtermDataSeen) {
      this.transition('settling', 'compositionend-after-xterm-data');
      this.scheduleSettle(seq, this.activeSessionGeneration);
      return seq;
    }

    this.transition('committing', 'compositionend');
    this.scheduleCommitObservation(seq, this.activeSessionGeneration);
    return seq;
  }

  observeXtermData(): number | undefined {
    const seq = this.activeCompositionSeq;
    if (seq === null || this.state === 'idle') {
      return undefined;
    }

    this.xtermDataSeen = true;
    this.clearCommitTimer();
    this.transition('settling', 'xterm-data');
    this.scheduleSettle(seq, this.activeSessionGeneration);
    return seq;
  }

  waitForIdle(kind: ImeDeferredKind, reason: string): Promise<ImeWaitResult> {
    if (this.state === 'idle') {
      return Promise.resolve({ status: 'ready' });
    }

    const sessionGeneration = this.currentSessionGeneration();
    this.emit(deferredEventKind(kind), {
      reason,
      imeState: this.state,
      compositionSeq: this.activeCompositionSeq,
      sessionGeneration,
      deferredCount: this.deferredWaiters.length + 1,
    });

    return new Promise<ImeWaitResult>((resolve) => {
      this.deferredWaiters.push({
        kind,
        reason,
        compositionSeq: this.activeCompositionSeq,
        sessionGeneration,
        resolve,
      });
    });
  }

  isActive(): boolean {
    return this.state !== 'idle';
  }

  getState(): ImeState {
    return this.state;
  }

  getActiveCompositionSeq(): number | undefined {
    return this.activeCompositionSeq ?? undefined;
  }

  getSnapshot(): ImeTransactionSnapshot {
    return {
      state: this.state,
      compositionSeq: this.activeCompositionSeq,
      sessionGeneration: this.activeSessionGeneration,
      xtermDataSeen: this.xtermDataSeen,
      commitCandidateLength: this.commitCandidateLength,
      deferredCount: this.deferredWaiters.length,
    };
  }

  dispose(): void {
    this.clearCommitTimer();
    this.clearSettleTimer();
    const waiters = this.deferredWaiters;
    this.deferredWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve({ status: 'disposed' });
    }
    this.state = 'idle';
    this.activeCompositionSeq = null;
    this.xtermDataSeen = false;
    this.commitCandidateLength = 0;
    this.commitCandidateSource = null;
    this.fallbackObservedSeq = null;
    this.notifyStateChange();
  }

  private ensureActiveComposition(reason: string): number {
    if (this.activeCompositionSeq !== null && this.state !== 'idle') {
      return this.activeCompositionSeq;
    }

    const seq = this.lastCompositionSeq + 1;
    this.lastCompositionSeq = seq;
    this.activeCompositionSeq = seq;
    this.activeSessionGeneration = this.currentSessionGeneration();
    this.xtermDataSeen = false;
    this.commitCandidateLength = 0;
    this.commitCandidateSource = null;
    this.fallbackObservedSeq = null;
    this.transition('composing', reason);
    return seq;
  }

  private rememberCommitCandidate(dataLength: number, source: string): void {
    if (dataLength <= 0) {
      return;
    }

    this.commitCandidateLength = Math.max(this.commitCandidateLength, dataLength);
    this.commitCandidateSource = source;
  }

  private scheduleCommitObservation(seq: number, sessionGeneration: number): void {
    this.clearCommitTimer();
    this.commitTimer = this.setTimer(() => {
      this.commitTimer = null;
      if (!this.matchesActive(seq, sessionGeneration) || this.state !== 'committing') {
        return;
      }
      if (!this.xtermDataSeen) {
        this.emit('ime_commit_without_xterm_data', {
          compositionSeq: seq,
          sessionGeneration,
          committedLength: this.commitCandidateLength,
          candidateSource: this.commitCandidateSource,
        });
        this.observeFallbackCandidate(seq, sessionGeneration);
      }
      this.transition('settling', 'commit-observation-timeout');
      this.scheduleSettle(seq, sessionGeneration);
    }, this.commitObservationMs);
  }

  private scheduleSettle(seq: number, sessionGeneration: number): void {
    this.clearSettleTimer();
    this.settleTimer = this.setTimer(() => {
      this.settleTimer = null;
      if (!this.matchesActive(seq, sessionGeneration) || this.state !== 'settling') {
        return;
      }

      this.transition('idle', 'settle-deadline');
      this.emit('ime_settled', {
        compositionSeq: seq,
        sessionGeneration,
        xtermDataSeen: this.xtermDataSeen,
        deferredCount: this.deferredWaiters.length,
      });
      this.activeCompositionSeq = null;
      this.xtermDataSeen = false;
      this.commitCandidateLength = 0;
      this.commitCandidateSource = null;
      this.fallbackObservedSeq = null;
      this.notifyStateChange();
      this.resolveDeferredWaiters(seq, sessionGeneration);
    }, this.settleDelayMs);
  }

  private observeFallbackCandidate(seq: number, sessionGeneration: number): void {
    if (
      this.fallbackObservedSeq === seq
      || this.xtermDataSeen
      || this.commitCandidateLength <= 0
    ) {
      return;
    }

    this.fallbackObservedSeq = seq;
    this.emit('ime_fallback_observed', {
      compositionSeq: seq,
      sessionGeneration,
      committedLength: this.commitCandidateLength,
      candidateSource: this.commitCandidateSource,
      fallbackMode: 'observe-only',
      xtermDataSeen: false,
    });
  }

  private transition(nextState: ImeState, reason: string): void {
    if (this.state === nextState) {
      this.notifyStateChange();
      return;
    }

    const previousState = this.state;
    this.state = nextState;
    this.emit('ime_state_changed', {
      reason,
      previousState,
      imeState: nextState,
      compositionSeq: this.activeCompositionSeq,
      sessionGeneration: this.activeSessionGeneration,
      xtermDataSeen: this.xtermDataSeen,
    });
    this.notifyStateChange();
  }

  private resolveDeferredWaiters(settledCompositionSeq: number, settledSessionGeneration: number): void {
    if (this.state !== 'idle' || this.deferredWaiters.length === 0) {
      return;
    }

    const currentGeneration = this.currentSessionGeneration();
    const waiters = this.deferredWaiters;
    this.deferredWaiters = [];
    for (const waiter of waiters) {
      if (
        waiter.compositionSeq !== settledCompositionSeq
        || waiter.sessionGeneration !== settledSessionGeneration
        || waiter.sessionGeneration !== currentGeneration
      ) {
        this.emit('ime_deferred_action_cancelled', {
          reason: waiter.reason,
          deferredKind: waiter.kind,
          queuedCompositionSeq: waiter.compositionSeq,
          settledCompositionSeq,
          queuedSessionGeneration: waiter.sessionGeneration,
          settledSessionGeneration,
          currentSessionGeneration: currentGeneration,
        });
        waiter.resolve({ status: 'context-changed' });
        continue;
      }

      waiter.resolve({ status: 'ready' });
    }
  }

  private retargetSupersededWaiters(
    previousCompositionSeq: number,
    previousSessionGeneration: number,
    nextCompositionSeq: number,
  ): void {
    if (this.deferredWaiters.length === 0) {
      return;
    }

    const remaining: ImeDeferredWaiter[] = [];
    for (const waiter of this.deferredWaiters) {
      const matchesSupersededComposition =
        waiter.compositionSeq === previousCompositionSeq
        && waiter.sessionGeneration === previousSessionGeneration;
      if (!matchesSupersededComposition) {
        remaining.push(waiter);
        continue;
      }

      this.emit('ime_deferred_action_retargeted', {
        reason: waiter.reason,
        deferredKind: waiter.kind,
        previousCompositionSeq,
        nextCompositionSeq,
        sessionGeneration: waiter.sessionGeneration,
      });
      waiter.compositionSeq = nextCompositionSeq;
      remaining.push(waiter);
    }
    this.deferredWaiters = remaining;
  }

  private matchesActive(seq: number, sessionGeneration: number): boolean {
    return this.activeCompositionSeq === seq
      && this.activeSessionGeneration === sessionGeneration
      && this.currentSessionGeneration() === sessionGeneration;
  }

  private currentSessionGeneration(): number {
    const value = this.runtime.getSessionGeneration();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private clearCommitTimer(): void {
    if (this.commitTimer !== null) {
      this.clearTimerHandle(this.commitTimer);
      this.commitTimer = null;
    }
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      this.clearTimerHandle(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private emit(kind: string, details: Record<string, ImeTelemetryValue>): void {
    this.runtime.onEvent(kind, details);
  }

  private notifyStateChange(): void {
    this.runtime.onStateChange(this.getSnapshot());
  }
}

function deferredEventKind(kind: ImeDeferredKind): string {
  switch (kind) {
    case 'repair':
      return 'ime_repair_deferred';
    case 'snapshot':
    case 'capture-close':
    default:
      return 'ime_capture_close_deferred';
  }
}

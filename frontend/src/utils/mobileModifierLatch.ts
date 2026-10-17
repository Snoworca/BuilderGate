// Module-level Ctrl/Alt/Shift latch for the mobile terminal keyboard.
//
// Each modifier is off, once (applies to the next encoded key) or locked (stays
// until tapped). The store follows the useSyncExternalStore contract so the
// keyboard UI and TerminalView read the same state.
import { encodeMobileKey, type ModifierState } from './mobileKeyEncoder.ts';

// @req FR-MKB-002
export type LatchState = 'off' | 'once' | 'locked';

// @req FR-MKB-002
export type LatchModifier = 'ctrl' | 'alt' | 'shift';

// @req FR-MKB-002
export type LatchSnapshot = Readonly<Record<LatchModifier, LatchState>>;

// @req FR-MKB-002
export interface LatchPress {
  /** A tap when the hold timer has not fired yet; nothing once it has locked. */
  release(): void;
  /** Clears the hold timer without changing any state (pointercancel). */
  cancel(): void;
}

// @req FR-MKB-002
export const LATCH_HOLD_MS = 1500;

const LOCK_VIBRATION_MS = 25;
const MODIFIERS: readonly LatchModifier[] = ['ctrl', 'alt', 'shift'];
const OFF_SNAPSHOT: LatchSnapshot = Object.freeze({ ctrl: 'off', alt: 'off', shift: 'off' });

let snapshot: LatchSnapshot = OFF_SNAPSHOT;
const listeners = new Set<() => void>();
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
// Bumped by resetForTests so a press handle taken before a reset stays inert.
let generation = 0;

function commit(next: Record<LatchModifier, LatchState>): void {
  if (MODIFIERS.every((mod) => next[mod] === snapshot[mod])) return;
  snapshot = Object.freeze({ ...next });
  for (const listener of [...listeners]) listener();
}

function setModifier(mod: LatchModifier, state: LatchState): void {
  commit({ ...snapshot, [mod]: state });
}

function vibrateOnLock(): void {
  const nav = typeof navigator === 'undefined'
    ? undefined
    : navigator as Navigator & { vibrate?: (pattern: number) => boolean };
  if (typeof nav?.vibrate === 'function') {
    nav.vibrate(LOCK_VIBRATION_MS);
  }
}

function tap(mod: LatchModifier): void {
  setModifier(mod, snapshot[mod] === 'off' ? 'once' : 'off');
}

// @req FR-MKB-002
export const mobileModifierLatch = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },

  getSnapshot(): LatchSnapshot {
    return snapshot;
  },

  tap,

  startPress(mod: LatchModifier): LatchPress {
    let locked = false;
    let settled = false;
    const pressGeneration = generation;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (settled) return;
      locked = true;
      setModifier(mod, 'locked');
      vibrateOnLock();
    }, LATCH_HOLD_MS);
    pendingTimers.add(timer);

    const clear = (): void => {
      clearTimeout(timer);
      pendingTimers.delete(timer);
    };

    return {
      release() {
        if (settled || pressGeneration !== generation) return;
        settled = true;
        clear();
        if (!locked) tap(mod);
      },
      cancel() {
        if (settled) return;
        settled = true;
        clear();
      },
    };
  },

  consumeOnce(): void {
    commit({
      ctrl: snapshot.ctrl === 'once' ? 'off' : snapshot.ctrl,
      alt: snapshot.alt === 'once' ? 'off' : snapshot.alt,
      shift: snapshot.shift === 'once' ? 'off' : snapshot.shift,
    });
  },

  activeModifiers(): ModifierState {
    return {
      ctrl: snapshot.ctrl !== 'off',
      alt: snapshot.alt !== 'off',
      shift: snapshot.shift !== 'off',
    };
  },

  resetForTests(): void {
    generation += 1;
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    commit({ ...OFF_SNAPSHOT });
  },
};

function isPrintableAsciiCharacter(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/**
 * Re-encodes one printable ASCII character typed on the system keyboard when any
 * modifier is latched, and consumes the once modifiers. Anything else is returned
 * unchanged and leaves the latch untouched.
 */
// @req FR-MKB-003
export function applyLatchToTypedData(data: string, applicationCursor: boolean): string {
  if (!isPrintableAsciiCharacter(data)) return data;
  const mods = mobileModifierLatch.activeModifiers();
  if (!mods.ctrl && !mods.alt && !mods.shift) return data;
  const encoded = encodeMobileKey(data, mods, applicationCursor);
  // A character the modifiers leave as it was (ctrl+1, shift+.) is unconverted
  // input, so the once modifiers stay armed for the next key.
  if (encoded !== data) mobileModifierLatch.consumeOnce();
  return encoded;
}

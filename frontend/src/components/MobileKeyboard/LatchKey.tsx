// A lockable Ctrl/Alt/Shift button for the mobile terminal keyboard.
//
// Tap = the next key only (once), hold 1500 ms = locked, tap again = off. The
// state lives in the module-level latch store so the bar, the future special
// keyboard and TerminalView all draw and use the same value.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react';
import {
  mobileModifierLatch,
  type LatchModifier,
  type LatchPress,
} from '../../utils/mobileModifierLatch.ts';
import './mobileKeyboard.css';

export interface LatchKeyProps {
  mod: LatchModifier;
  label: string;
  ariaLabel: string;
  className?: string;
}

// @req FR-MKB-005
export function LatchKey({ mod, label, ariaLabel, className }: LatchKeyProps): ReactElement {
  const snapshot = useSyncExternalStore(
    mobileModifierLatch.subscribe,
    mobileModifierLatch.getSnapshot,
    mobileModifierLatch.getSnapshot,
  );
  const state = snapshot[mod];
  const pressRef = useRef<LatchPress | null>(null);
  const [holding, setHolding] = useState(false);

  // The hold fill disappears the moment the press turns into a lock.
  useEffect(() => {
    if (state === 'locked') setHolding(false);
  }, [state]);

  // An unmounted key must not leave a timer that locks later.
  useEffect(() => () => {
    pressRef.current?.cancel();
    pressRef.current = null;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    // Keeps focus on the terminal textarea so the system keyboard stays up.
    event.preventDefault();
    // Capture so a release outside the button still ends this press instead of
    // leaving a timer that locks 1500 ms later.
    const button = event.currentTarget;
    if (typeof button.setPointerCapture === 'function') {
      try { button.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    }
    pressRef.current?.cancel();
    pressRef.current = mobileModifierLatch.startPress(mod);
    setHolding(true);
  }, [mod]);

  const onPointerUp = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    setHolding(false);
    press?.release();
  }, []);

  const onPointerCancel = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    setHolding(false);
    press?.cancel();
  }, []);

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const classes = ['mobile-key', 'mobile-key--mod'];
  if (holding) classes.push('mobile-key--holding');
  if (className) classes.push(className);

  return (
    <button
      type="button"
      className={classes.join(' ')}
      data-latch-state={state}
      data-mod={mod}
      aria-label={ariaLabel}
      aria-pressed={state !== 'off'}
      title={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      <span className="mobile-key__hold" aria-hidden="true" />
      <span className="mobile-key__label">{label}</span>
      <span className="mobile-key__dot" aria-hidden="true" />
    </button>
  );
}

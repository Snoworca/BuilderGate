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
  type LatchState,
  type LatchPress,
} from '../../utils/mobileModifierLatch.ts';
import { isDragBeyond } from './mobileKeyboardModel.ts';
import './mobileKeyboard.css';

export interface LatchKeyProps {
  mod: LatchModifier;
  label: string;
  ariaLabel: string;
  className?: string;
}

// @req FR-MKB-005
// @req FR-MKB-011
export function LatchKey({ mod, label, ariaLabel, className }: LatchKeyProps): ReactElement {
  const snapshot = useSyncExternalStore(
    mobileModifierLatch.subscribe,
    mobileModifierLatch.getSnapshot,
    mobileModifierLatch.getSnapshot,
  );
  const state = snapshot[mod];
  const pressRef = useRef<LatchPress | null>(null);
  // Where and with which pointer the current press began; other pointers
  // (a second finger) neither drag nor release it.
  const startRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // The latch state when the current press began, or null with no press. The
  // hold fill shows during a press and disappears the moment that press turns
  // into a lock — derived here rather than reset from an effect.
  const [pressedFrom, setPressedFrom] = useState<LatchState | null>(null);
  const holding = pressedFrom !== null && !(state === 'locked' && pressedFrom !== 'locked');
  const setHolding = useCallback((on: boolean): void => {
    setPressedFrom(on ? mobileModifierLatch.getSnapshot()[mod] : null);
  }, [mod]);

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
    startRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setHolding(true);
  }, [mod, setHolding]);

  /** True when the event belongs to another pointer than the one that started the press. */
  const otherPointer = useCallback((event: ReactPointerEvent<HTMLButtonElement>): boolean => {
    const start = startRef.current;
    return start !== null && start.pointerId !== event.pointerId;
  }, []);

  const draggedAway = useCallback((event: ReactPointerEvent<HTMLButtonElement>): boolean => {
    const start = startRef.current;
    return start !== null && isDragBeyond(event.clientX - start.x, event.clientY - start.y);
  }, []);

  // A press that travels more than 8 px is a drag (scrolling the bar): it is
  // cancelled, not released, so the modifier is left as it was.
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pressRef.current === null || otherPointer(event) || !draggedAway(event)) return;
    const press = pressRef.current;
    pressRef.current = null;
    startRef.current = null;
    setHolding(false);
    press.cancel();
  }, [draggedAway, otherPointer, setHolding]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (otherPointer(event)) return;
    const press = pressRef.current;
    const dragged = draggedAway(event);
    pressRef.current = null;
    startRef.current = null;
    setHolding(false);
    if (dragged) press?.cancel();
    else press?.release();
  }, [draggedAway, otherPointer, setHolding]);

  const onPointerCancel = useCallback((event?: ReactPointerEvent<HTMLButtonElement>) => {
    if (event && otherPointer(event)) return;
    const press = pressRef.current;
    pressRef.current = null;
    startRef.current = null;
    setHolding(false);
    press?.cancel();
  }, [otherPointer, setHolding]);

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
      onPointerMove={onPointerMove}
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

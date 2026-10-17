// The accessory key bar shown above the system keyboard while a terminal has
// focus on a phone. Keys act on pointerup so a horizontal drag can scroll the bar
// without sending anything, and every press keeps the terminal textarea focused.
import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { t, type MessageKey } from '../../i18n/i18n.ts';
import type { MobileKeyName } from '../../utils/mobileKeyEncoder.ts';
import { mobileModifierLatch, type LatchModifier } from '../../utils/mobileModifierLatch.ts';
import { LatchKey } from './LatchKey.tsx';
import './mobileKeyboard.css';

export type MobileBarEntry =
  | { kind: 'key'; key: MobileKeyName; label: string; ariaKey: MessageKey; arrow?: boolean }
  | { kind: 'mod'; mod: LatchModifier; label: string; ariaKey: MessageKey }
  | { kind: 'sep' };

/** A pointer that travels farther than this before release is a scroll, not a key. */
const TAP_SLOP_PX = 8;
const KEYBOARD_GLYPH = '\u2328';

// Key caps are ASCII constants; the arrows are written as escapes.
// @req FR-MKB-006
export const MOBILE_BAR_KEYS: readonly MobileBarEntry[] = [
  { kind: 'key', key: 'Esc', label: 'Esc', ariaKey: 'mobileKeyboard.key.esc' },
  { kind: 'key', key: 'Tab', label: 'Tab', ariaKey: 'mobileKeyboard.key.tab' },
  { kind: 'mod', mod: 'ctrl', label: 'Ctrl', ariaKey: 'mobileKeyboard.key.ctrl' },
  { kind: 'mod', mod: 'alt', label: 'Alt', ariaKey: 'mobileKeyboard.key.alt' },
  { kind: 'sep' },
  { kind: 'key', key: 'Left', label: '\u2190', ariaKey: 'mobileKeyboard.key.left', arrow: true },
  { kind: 'key', key: 'Up', label: '\u2191', ariaKey: 'mobileKeyboard.key.up', arrow: true },
  { kind: 'key', key: 'Down', label: '\u2193', ariaKey: 'mobileKeyboard.key.down', arrow: true },
  { kind: 'key', key: 'Right', label: '\u2192', ariaKey: 'mobileKeyboard.key.right', arrow: true },
  { kind: 'sep' },
  { kind: 'key', key: 'Home', label: 'Home', ariaKey: 'mobileKeyboard.key.home' },
  { kind: 'key', key: 'End', label: 'End', ariaKey: 'mobileKeyboard.key.end' },
  { kind: 'key', key: 'PageUp', label: 'PgUp', ariaKey: 'mobileKeyboard.key.pageUp' },
  { kind: 'key', key: 'PageDown', label: 'PgDn', ariaKey: 'mobileKeyboard.key.pageDown' },
];

const ACTIONABLE = '[data-mobile-key],[data-mobile-action]';

interface TrackedPress {
  pointerId: number;
  element: Element;
  startX: number;
  startY: number;
  moved: boolean;
}

export interface MobileKeyBarProps {
  onSendKey: (key: MobileKeyName) => void;
  onToggleKeyboard: () => void;
  keyboardOpen: boolean;
  /**
   * Called after a press that left focus on the bar (a browser that ignores the
   * pointerdown preventDefault), so the owner can focus the terminal again and
   * the system keyboard stays up. Applies to every button, Ctrl/Alt included.
   */
  onRestoreFocus?: () => void;
}

export interface MobileKeyBarVisibility {
  isMobile: boolean;
  screen: string;
  hasActiveTab: boolean;
  inputFocused: boolean;
}

/** The bar shows only on a phone, on the workspace screen, while the active tab's input has focus. */
// @req FR-MKB-006
export function shouldShowMobileKeyBar({ isMobile, screen, hasActiveTab, inputFocused }: MobileKeyBarVisibility): boolean {
  return isMobile && screen === 'workspace' && hasActiveTab && inputFocused;
}

/** A latch left on in mobile mode must not reach a desktop hardware keyboard. */
// @req FR-MKB-006
export function useResetLatchWhenNotMobile(isMobile: boolean): void {
  useEffect(() => {
    if (!isMobile) mobileModifierLatch.reset();
  }, [isMobile]);
}

function farFrom(press: TrackedPress, x: number, y: number): boolean {
  return Math.hypot(x - press.startX, y - press.startY) > TAP_SLOP_PX;
}

// @req FR-MKB-006
export function MobileKeyBar({ onSendKey, onToggleKeyboard, keyboardOpen, onRestoreFocus }: MobileKeyBarProps): ReactElement {
  const pressRef = useRef<TrackedPress | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // Keeps focus on the terminal textarea so the system keyboard stays up.
    event.preventDefault();
    const element = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    pressRef.current = element
      ? { pointerId: event.pointerId, element, startX: event.clientX, startY: event.clientY, moved: false }
      : null;
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (press && press.pointerId === event.pointerId && farFrom(press, event.clientX, event.clientY)) {
      press.moved = true;
    }
  }, []);

  const runPress = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || press.pointerId !== event.pointerId) return;
    if (press.moved || farFrom(press, event.clientX, event.clientY)) return;
    const element = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    if (element !== press.element) return;
    if (element.getAttribute('data-mobile-action') === 'toggle-keyboard') {
      onToggleKeyboard();
      return;
    }
    const key = element.getAttribute('data-mobile-key');
    if (key) onSendKey(key as MobileKeyName);
  }, [onSendKey, onToggleKeyboard]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    runPress(event);
    // LatchKey handles its own press before this bubbles here; any button that
    // took focus (Ctrl, Alt, the switch, a plain key) hands it back.
    const focused = bar.ownerDocument.activeElement;
    if (onRestoreFocus && focused !== null && bar.contains(focused)) onRestoreFocus();
  }, [runPress, onRestoreFocus]);

  const onPointerCancel = useCallback(() => {
    pressRef.current = null;
  }, []);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);

  const toggleAria = t(keyboardOpen ? 'mobileKeyboard.switch.toSystem' : 'mobileKeyboard.switch.toSpecial');
  const toggleText = t(keyboardOpen ? 'mobileKeyboard.switch.systemLabel' : 'mobileKeyboard.switch.specialLabel');

  return (
    <div
      className="mobile-key-bar"
      role="toolbar"
      aria-label={t('mobileKeyboard.bar')}
      style={{ touchAction: 'pan-x' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onMouseDown={onMouseDown}
    >
      {MOBILE_BAR_KEYS.map((entry, index) => {
        if (entry.kind === 'sep') {
          return <span key={`sep-${index}`} className="mobile-key-bar__sep" data-mobile-sep="" aria-hidden="true" />;
        }
        const aria = t(entry.ariaKey);
        if (entry.kind === 'mod') {
          return <LatchKey key={entry.mod} mod={entry.mod} label={entry.label} ariaLabel={aria} />;
        }
        return (
          <button
            key={entry.key}
            type="button"
            className={entry.arrow ? 'mobile-key mobile-key--arrow' : 'mobile-key'}
            data-mobile-key={entry.key}
            aria-label={aria}
            title={aria}
          >
            <span className="mobile-key__label">{entry.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="mobile-key mobile-key--toggle"
        data-mobile-action="toggle-keyboard"
        aria-label={toggleAria}
        title={toggleAria}
        aria-pressed={keyboardOpen}
      >
        <span className="mobile-key__label">{`${KEYBOARD_GLYPH} ${toggleText}`}</span>
      </button>
    </div>
  );
}

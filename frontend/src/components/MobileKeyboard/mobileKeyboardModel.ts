// The non-component half of the mobile terminal keyboard: key tables, the bar
// visibility rule, the drag threshold, the special keyboard's right-block
// preference and panel height, and the switch's focus hand-over. Kept apart
// from the .tsx components so they export components only (react-refresh).
import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { MobileKeyName } from '../../utils/mobileKeyEncoder.ts';
import { mobileModifierLatch, type LatchModifier } from '../../utils/mobileModifierLatch.ts';

export type MobileBarEntry =
  | { kind: 'key'; key: MobileKeyName; label: string; ariaKey: MessageKey; arrow?: boolean }
  | { kind: 'mod'; mod: LatchModifier; label: string; ariaKey: MessageKey }
  | { kind: 'sep' };

// Key caps are ASCII constants; the arrows are written as escapes.
// @req FR-MKB-006
export const MOBILE_BAR_KEYS: readonly MobileBarEntry[] = [
  { kind: 'key', key: 'Esc', label: 'Esc', ariaKey: 'mobileKeyboard.key.esc' },
  { kind: 'key', key: 'Tab', label: 'Tab', ariaKey: 'mobileKeyboard.key.tab' },
  { kind: 'mod', mod: 'ctrl', label: 'Ctrl', ariaKey: 'mobileKeyboard.key.ctrl' },
  { kind: 'mod', mod: 'alt', label: 'Alt', ariaKey: 'mobileKeyboard.key.alt' },
  { kind: 'sep' },
  { kind: 'key', key: 'Left', label: '←', ariaKey: 'mobileKeyboard.key.left', arrow: true },
  { kind: 'key', key: 'Up', label: '↑', ariaKey: 'mobileKeyboard.key.up', arrow: true },
  { kind: 'key', key: 'Down', label: '↓', ariaKey: 'mobileKeyboard.key.down', arrow: true },
  { kind: 'key', key: 'Right', label: '→', ariaKey: 'mobileKeyboard.key.right', arrow: true },
  { kind: 'sep' },
  { kind: 'key', key: 'Home', label: 'Home', ariaKey: 'mobileKeyboard.key.home' },
  { kind: 'key', key: 'End', label: 'End', ariaKey: 'mobileKeyboard.key.end' },
  { kind: 'key', key: 'PageUp', label: 'PgUp', ariaKey: 'mobileKeyboard.key.pageUp' },
  { kind: 'key', key: 'PageDown', label: 'PgDn', ariaKey: 'mobileKeyboard.key.pageDown' },
];

export interface MobileKeyBarVisibility {
  isMobile: boolean;
  screen: string;
  hasActiveTab: boolean;
  inputFocused: boolean;
  /** The special keyboard panel is open; the input is blurred then, and the bar stays. */
  panelOpen?: boolean;
}

/** The bar shows on a phone, on the workspace screen, with an active tab whose input has focus or whose panel is open. */
// @req FR-MKB-006
// @req FR-MKB-008
export function shouldShowMobileKeyBar({ isMobile, screen, hasActiveTab, inputFocused, panelOpen = false }: MobileKeyBarVisibility): boolean {
  return isMobile && screen === 'workspace' && hasActiveTab && (inputFocused || panelOpen);
}

/** A latch left on in mobile mode must not reach a desktop hardware keyboard. */
// @req FR-MKB-006
export function useResetLatchWhenNotMobile(isMobile: boolean): void {
  useEffect(() => {
    if (!isMobile) mobileModifierLatch.reset();
  }, [isMobile]);
}

/** A pointer that travels farther than this before release is a drag, not a key. */
export const TAP_SLOP_PX = 8;

// @req FR-MKB-011
export function isDragBeyond(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > TAP_SLOP_PX;
}

// --- Shared press handling for the bar and the panel ---------------------------

const ACTIONABLE = '[data-mobile-key],[data-mobile-action]';

interface TrackedPress {
  pointerId: number;
  element: Element;
  startX: number;
  startY: number;
  moved: boolean;
}

export interface TapPressHandlers<T extends Element> {
  onPointerDown: (event: ReactPointerEvent<T>) => void;
  onPointerMove: (event: ReactPointerEvent<T>) => void;
  onPointerUp: (event: ReactPointerEvent<T>) => void;
  onPointerCancel: () => void;
  onMouseDown: (event: ReactMouseEvent<T>) => void;
}

/**
 * Press handling shared by the key bar and the special keyboard: pointerdown
 * and mousedown defaults are prevented so the focused element keeps focus, the
 * action runs on pointerup over the element the press started on, and a press
 * that moved more than TAP_SLOP_PX is a drag that does nothing. onTap receives
 * the [data-mobile-key] / [data-mobile-action] element that was tapped.
 */
// @req FR-MKB-009
export function useTapPress<T extends Element>(onTap: (element: Element, event: ReactPointerEvent<T>) => void): TapPressHandlers<T> {
  const pressRef = useRef<TrackedPress | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<T>) => {
    event.preventDefault();
    const element = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    pressRef.current = element
      ? { pointerId: event.pointerId, element, startX: event.clientX, startY: event.clientY, moved: false }
      : null;
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    const press = pressRef.current;
    if (press && press.pointerId === event.pointerId && isDragBeyond(event.clientX - press.startX, event.clientY - press.startY)) {
      press.moved = true;
    }
  }, []);

  const onPointerUp = useCallback((event: ReactPointerEvent<T>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || press.pointerId !== event.pointerId) return;
    if (press.moved || isDragBeyond(event.clientX - press.startX, event.clientY - press.startY)) return;
    const element = event.target instanceof Element ? event.target.closest(ACTIONABLE) : null;
    if (element !== press.element) return;
    onTap(element, event);
  }, [onTap]);

  const onPointerCancel = useCallback(() => {
    pressRef.current = null;
  }, []);

  const onMouseDown = useCallback((event: ReactMouseEvent<T>) => {
    event.preventDefault();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseDown };
}

// --- Special keyboard tables ---------------------------------------------------

export type RightBlock = 'arrows' | 'numpad';

export type SpecialKeyEntry =
  | {
    kind: 'key';
    key: MobileKeyName | string;
    label: string;
    ariaKey: MessageKey;
    ariaParams?: Readonly<Record<string, string>>;
    variant?: 'fn' | 'nav' | 'arrow' | 'enter';
  }
  | { kind: 'mod'; mod: LatchModifier; label: string; ariaKey: MessageKey }
  | { kind: 'switch'; to: RightBlock; labelKey: MessageKey; ariaKey: MessageKey }
  | { kind: 'blank' };

type SpecialBlock = readonly (readonly SpecialKeyEntry[])[];

function fnKey(n: number): SpecialKeyEntry {
  const name = `F${n}`;
  return { kind: 'key', key: name, label: name, ariaKey: 'mobileKeyboard.key.function', ariaParams: { name }, variant: 'fn' };
}

function charKey(ch: string): SpecialKeyEntry {
  return { kind: 'key', key: ch, label: ch, ariaKey: 'mobileKeyboard.key.char', ariaParams: { char: ch } };
}

// @req FR-MKB-009
export const SPECIAL_TOP_ROW: readonly SpecialKeyEntry[] = [
  { kind: 'key', key: 'Esc', label: 'Esc', ariaKey: 'mobileKeyboard.key.esc' },
  { kind: 'key', key: 'Tab', label: 'Tab', ariaKey: 'mobileKeyboard.key.tab' },
  { kind: 'mod', mod: 'ctrl', label: 'Ctrl', ariaKey: 'mobileKeyboard.key.ctrl' },
  { kind: 'mod', mod: 'alt', label: 'Alt', ariaKey: 'mobileKeyboard.key.alt' },
  { kind: 'mod', mod: 'shift', label: 'Shift', ariaKey: 'mobileKeyboard.key.shift' },
];

// @req FR-MKB-009
export const SPECIAL_LEFT_BLOCK: SpecialBlock = [
  [fnKey(1), fnKey(2), fnKey(3)],
  [fnKey(4), fnKey(5), fnKey(6)],
  [fnKey(7), fnKey(8), fnKey(9)],
  [fnKey(10), fnKey(11), fnKey(12)],
];

// @req FR-MKB-009
export const SPECIAL_MIDDLE_BLOCK: SpecialBlock = [
  [{ kind: 'key', key: 'Backspace', label: '⌫', ariaKey: 'mobileKeyboard.key.backspace' }, charKey('/'), charKey('|')],
  [charKey('~'), charKey('*'), charKey('-')],
  [charKey('`'), charKey(':'), charKey('+')],
  [charKey('_'), charKey('='), { kind: 'key', key: 'Enter', label: 'Enter', ariaKey: 'mobileKeyboard.key.enter', variant: 'enter' }],
];

// @req FR-MKB-009
export const SPECIAL_ARROW_BLOCK: SpecialBlock = [
  [
    { kind: 'key', key: 'Home', label: 'Home', ariaKey: 'mobileKeyboard.key.home', variant: 'nav' },
    { kind: 'key', key: 'Up', label: '↑', ariaKey: 'mobileKeyboard.key.up', variant: 'arrow' },
    { kind: 'key', key: 'PageUp', label: 'PgUp', ariaKey: 'mobileKeyboard.key.pageUp', variant: 'nav' },
  ],
  [
    { kind: 'key', key: 'Left', label: '←', ariaKey: 'mobileKeyboard.key.left', variant: 'arrow' },
    { kind: 'blank' },
    { kind: 'key', key: 'Right', label: '→', ariaKey: 'mobileKeyboard.key.right', variant: 'arrow' },
  ],
  [
    { kind: 'key', key: 'End', label: 'End', ariaKey: 'mobileKeyboard.key.end', variant: 'nav' },
    { kind: 'key', key: 'Down', label: '↓', ariaKey: 'mobileKeyboard.key.down', variant: 'arrow' },
    { kind: 'key', key: 'PageDown', label: 'PgDn', ariaKey: 'mobileKeyboard.key.pageDown', variant: 'nav' },
  ],
  [
    { kind: 'key', key: 'Insert', label: 'Ins', ariaKey: 'mobileKeyboard.key.insert', variant: 'nav' },
    { kind: 'key', key: 'Delete', label: 'Del', ariaKey: 'mobileKeyboard.key.delete', variant: 'nav' },
    { kind: 'switch', to: 'numpad', labelKey: 'mobileKeyboard.special.numpadLabel', ariaKey: 'mobileKeyboard.special.toNumpad' },
  ],
];

// Digits and '.' are plain characters: no keypad application-mode sequences.
// @req FR-MKB-010
export const SPECIAL_NUMPAD_BLOCK: SpecialBlock = [
  [charKey('7'), charKey('8'), charKey('9')],
  [charKey('4'), charKey('5'), charKey('6')],
  [charKey('1'), charKey('2'), charKey('3')],
  [charKey('0'), charKey('.'), { kind: 'switch', to: 'arrows', labelKey: 'mobileKeyboard.special.arrowsLabel', ariaKey: 'mobileKeyboard.special.toArrows' }],
];

export const RIGHT_BLOCK_STORAGE_KEY = 'buildergate.mobileKeyboard.rightBlock';

/** The remembered right block; arrows when nothing usable is stored or storage fails. */
// @req FR-MKB-010
export function readRightBlock(storage: Storage | null): RightBlock {
  try {
    return storage?.getItem(RIGHT_BLOCK_STORAGE_KEY) === 'numpad' ? 'numpad' : 'arrows';
  } catch {
    return 'arrows';
  }
}

// @req FR-MKB-010
export function writeRightBlock(storage: Storage | null, value: RightBlock): void {
  try {
    storage?.setItem(RIGHT_BLOCK_STORAGE_KEY, value);
  } catch {
    // A blocked or full storage only loses the preference.
  }
}

export const DEFAULT_SPECIAL_PANEL_HEIGHT = 280;

/** The panel takes the place of the system keyboard: its last measured height, else 280 px. */
// @req FR-MKB-008
export function specialPanelHeight(lastInset: number): number {
  return lastInset > 0 ? lastInset : DEFAULT_SPECIAL_PANEL_HEIGHT;
}

/** The part of TerminalHandle the keyboard switch needs. */
export interface SpecialKeyboardFocusTarget {
  blurInput(): void;
  setFocusSuppressed(on: boolean): void;
  focus(reason?: string): void;
}

/**
 * One switch tap. Opening drops the terminal's focus (the system keyboard goes
 * down) and shuts every focus entry; closing reopens them and focuses the
 * terminal right away, which must happen inside the tap handler for iOS to raise
 * the keyboard. Returns the new open state.
 */
// @req FR-MKB-008
export function applySpecialKeyboardToggle(open: boolean, handle: SpecialKeyboardFocusTarget | null | undefined): boolean {
  if (!open) {
    handle?.blurInput();
    handle?.setFocusSuppressed(true);
    return true;
  }
  handle?.setFocusSuppressed(false);
  handle?.focus('mobile-keyboard-switch');
  return false;
}

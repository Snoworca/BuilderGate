// The non-component half of the mobile terminal keyboard: key tables, the bar
// visibility rule, the drag threshold, the special keyboard's right-block
// preference and panel height, and the switch's focus hand-over. Kept apart
// from the .tsx components so they export components only (react-refresh).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import type { MessageKey } from '../../i18n/i18n.ts';
import type { MobileKeyName } from '../../utils/mobileKeyEncoder.ts';
import {
  mobileModifierLatch,
  sendMobileKeyTo,
  type LatchModifier,
  type MobileKeyTarget,
} from '../../utils/mobileModifierLatch.ts';

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
  /** A long press on a key would open the browser context menu over the keys. */
  onContextMenu: (event: ReactMouseEvent<T>) => void;
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

  // FR-MKB-009 AC-6: a long press is a held key, not a request for the menu.
  const onContextMenu = useCallback((event: ReactMouseEvent<T>) => {
    event.preventDefault();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMouseDown, onContextMenu };
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
export const MIN_SPECIAL_PANEL_HEIGHT = 260;

/**
 * The panel takes the place of the system keyboard: its last measured height, raised to at
 * least 260 px so a short landscape keyboard does not cut keys off; 280 px with no reading.
 */
// @req FR-MKB-008
export function specialPanelHeight(lastInset: number): number {
  return lastInset > 0 ? Math.max(lastInset, MIN_SPECIAL_PANEL_HEIGHT) : DEFAULT_SPECIAL_PANEL_HEIGHT;
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

// --- App's panel wiring --------------------------------------------------------

/**
 * Shift lives only on the panel's top row; the key bar has Ctrl and Alt but no
 * Shift. A Shift left on after the panel closes would uppercase every typed
 * letter with nothing on screen showing it, so closing turns it off. Ctrl and
 * Alt stay as they are: the bar still shows them.
 */
// @req FR-MKB-003
// @req FR-MKB-008
function turnOffPanelOnlyModifiers(): void {
  mobileModifierLatch.turnOff('shift');
}

/** The part of TerminalHandle the panel wiring needs: focus hand-over and key sending. */
export interface SpecialKeyboardPanelTarget extends SpecialKeyboardFocusTarget, MobileKeyTarget {}

export interface SpecialKeyboardPanelOptions {
  activeTabId: string | null;
  /** A remounted TerminalView starts unsuppressed; a new session id re-applies it. */
  activeSessionId: string | null;
  getHandle: (tabId: string) => SpecialKeyboardPanelTarget | null;
  /** The panel height to use when it opens (measured before the keyboard goes down). */
  measureHeight: () => number;
  /** Read synchronously by the caller's own focus paths; owned by the caller. */
  openRef: MutableRefObject<boolean>;
}

export interface SpecialKeyboardPanel {
  open: boolean;
  height: number;
  /** The bar's switch: opens or closes the panel inside the tap handler. */
  toggle: () => void;
  /** Closes the panel without raising the system keyboard. */
  close: () => void;
  /** Sends one bar or panel key to the active terminal. */
  sendKey: (key: MobileKeyName | string) => void;
  /** Hands focus back to the terminal after a bar button took it, unless the panel is open. */
  restoreFocus: () => void;
}

/**
 * App's special keyboard wiring: the switch, the close, the suppression that
 * follows the active tab while the panel is open, and the key send that never
 * refocuses the terminal while the panel is open. The open state is kept in
 * openRef so the switch acts synchronously inside the gesture (iOS); the
 * returned `open` renders it.
 */
// @req FR-MKB-008
// @req FR-MKB-009
export function useSpecialKeyboardPanel({
  activeTabId,
  activeSessionId,
  getHandle,
  measureHeight,
  openRef,
}: SpecialKeyboardPanelOptions): SpecialKeyboardPanel {
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(() => specialPanelHeight(0));
  // The tab whose terminal is currently focus-suppressed for the panel.
  const suppressedTabIdRef = useRef<string | null>(null);
  const getHandleRef = useRef(getHandle);
  const measureHeightRef = useRef(measureHeight);
  useEffect(() => {
    getHandleRef.current = getHandle;
    measureHeightRef.current = measureHeight;
  });

  const handleFor = useCallback((tabId: string | null): SpecialKeyboardPanelTarget | null => (
    tabId === null ? null : getHandleRef.current(tabId)
  ), []);

  const toggle = useCallback((): void => {
    const handle = handleFor(activeTabId);
    if (!openRef.current) {
      // FR-MKB-008 AC-4: with no terminal to suppress, an open panel would sit
      // over a terminal that a later mount leaves free to raise the keyboard.
      if (handle === null) return;
      // Measured before the keyboard goes down: the panel takes its height.
      setHeight(measureHeightRef.current());
    } else if (suppressedTabIdRef.current !== null && suppressedTabIdRef.current !== activeTabId) {
      handleFor(suppressedTabIdRef.current)?.setFocusSuppressed(false);
    }
    // Synchronous: closing focuses the terminal inside this tap handler (iOS).
    const wasOpen = openRef.current;
    openRef.current = applySpecialKeyboardToggle(openRef.current, handle);
    suppressedTabIdRef.current = openRef.current && handle !== null ? activeTabId : null;
    if (wasOpen && !openRef.current) turnOffPanelOnlyModifiers();
    setOpen(openRef.current);
  }, [activeTabId, handleFor, openRef]);

  const close = useCallback((): void => {
    if (!openRef.current) return;
    handleFor(suppressedTabIdRef.current)?.setFocusSuppressed(false);
    suppressedTabIdRef.current = null;
    openRef.current = false;
    turnOffPanelOnlyModifiers();
    setOpen(false);
  }, [handleFor, openRef]);

  // While the panel is open the active terminal must be suppressed: after a
  // tab switch the suppression moves to the new tab, and after a restart or
  // session swap (a remounted TerminalView starts unsuppressed) it is applied
  // again, so the runtime layer cannot raise the keyboard over the panel.
  useEffect(() => {
    if (!openRef.current) return;
    const previous = suppressedTabIdRef.current;
    if (previous !== null && previous !== activeTabId) {
      handleFor(previous)?.setFocusSuppressed(false);
    }
    const next = handleFor(activeTabId);
    if (next === null) {
      suppressedTabIdRef.current = null;
      return;
    }
    next.blurInput();
    next.setFocusSuppressed(true);
    suppressedTabIdRef.current = activeTabId;
  }, [activeTabId, activeSessionId, handleFor, openRef]);

  const sendKey = useCallback((key: MobileKeyName | string): void => {
    if (activeTabId === null) return;
    const handle = handleFor(activeTabId);
    // encodeMobileKey takes any single character as well as a key name, which
    // the panel's symbol and number keys rely on.
    sendMobileKeyTo(handle, key as MobileKeyName);
    // A browser that let the tap move focus onto the bar gets it handed back,
    // unless the panel is open: then the terminal must stay blurred.
    if (openRef.current) return;
    if (!(document.activeElement instanceof HTMLTextAreaElement)) handle?.focus();
  }, [activeTabId, handleFor, openRef]);

  // Ctrl/Alt and the switch hand focus back the same way (the bar calls this
  // only when focus sits on one of its buttons).
  const restoreFocus = useCallback((): void => {
    if (activeTabId === null || openRef.current) return;
    handleFor(activeTabId)?.focus();
  }, [activeTabId, handleFor, openRef]);

  return { open, height, toggle, close, sendKey, restoreFocus };
}

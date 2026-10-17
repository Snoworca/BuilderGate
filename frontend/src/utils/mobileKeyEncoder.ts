// Pure key-to-bytes encoder for the mobile terminal keyboard.
//
// It has no DOM and no xterm import on purpose. A custom keydown key table inside
// TerminalView once bypassed xterm's IME pipeline and broke CJK input, so the
// mobile keys get their own pure module instead of a keydown handler.

// @req FR-MKB-001
export type MobileKeyName =
  | 'Up' | 'Down' | 'Left' | 'Right'
  | 'Home' | 'End'
  | 'Insert' | 'Delete' | 'PageUp' | 'PageDown'
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12'
  | 'Esc' | 'Tab' | 'Enter' | 'Backspace';

// @req FR-MKB-001
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const ESC = '\u001b';

/** Final byte of the CSI 1;m X / SS3 X forms. */
const CURSOR_FINALS: Readonly<Record<string, string>> = {
  Up: 'A',
  Down: 'B',
  Right: 'C',
  Left: 'D',
  Home: 'H',
  End: 'F',
};

/** Parameter of the CSI n ~ forms. */
const TILDE_CODES: Readonly<Record<string, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

/** Unmodified function key bytes, xterm defaults. */
const FUNCTION_KEYS: Readonly<Record<string, string>> = {
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
};

const SIMPLE_KEYS: Readonly<Record<string, string>> = {
  Esc: ESC,
  Tab: '\t',
  Enter: '\r',
  Backspace: '\x7f',
};

/** xterm Ctrl+<non-letter> table. Letters are handled case-insensitively below. */
const CTRL_SYMBOLS: Readonly<Record<string, string>> = {
  '@': '\x00',
  '2': '\x00',
  ' ': '\x00',
  '[': '\x1b',
  '3': '\x1b',
  '\\': '\x1c',
  '4': '\x1c',
  ']': '\x1d',
  '5': '\x1d',
  '^': '\x1e',
  '6': '\x1e',
  '_': '\x1f',
  '-': '\x1f',
  '7': '\x1f',
  '?': '\x7f',
  '8': '\x7f',
};

function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function modifierParameter(mods: ModifierState): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

function hasAnyModifier(mods: ModifierState): boolean {
  return mods.ctrl || mods.alt || mods.shift;
}

function isAsciiLetter(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

function applyCtrlToCharacter(ch: string): string {
  if (isAsciiLetter(ch)) {
    return String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40);
  }
  return lookup(CTRL_SYMBOLS, ch) ?? ch;
}

function encodeCharacter(ch: string, mods: ModifierState): string {
  let out = ch;
  if (mods.shift && isAsciiLetter(out)) {
    out = out.toUpperCase();
  }
  if (mods.ctrl) {
    out = applyCtrlToCharacter(out);
  }
  return mods.alt ? `${ESC}${out}` : out;
}

/**
 * Turns a named key or one character plus a modifier state into PTY bytes.
 * Strings that are neither a known key name nor a single character are returned unchanged.
 */
// @req FR-MKB-001
export function encodeMobileKey(
  key: MobileKeyName | string,
  mods: ModifierState,
  applicationCursor: boolean,
): string {
  const cursorFinal = lookup(CURSOR_FINALS, key);
  if (cursorFinal !== undefined) {
    if (hasAnyModifier(mods)) {
      return `${ESC}[1;${modifierParameter(mods)}${cursorFinal}`;
    }
    return `${ESC}${applicationCursor ? 'O' : '['}${cursorFinal}`;
  }

  const tildeCode = lookup(TILDE_CODES, key);
  if (tildeCode !== undefined) {
    if (hasAnyModifier(mods)) {
      return `${ESC}[${tildeCode};${modifierParameter(mods)}~`;
    }
    return `${ESC}[${tildeCode}~`;
  }

  const functionKey = lookup(FUNCTION_KEYS, key);
  if (functionKey !== undefined) {
    return mods.alt ? `${ESC}${functionKey}` : functionKey;
  }

  const simple = lookup(SIMPLE_KEYS, key);
  if (simple !== undefined) {
    const base = key === 'Tab' && mods.shift ? `${ESC}[Z` : simple;
    return mods.alt ? `${ESC}${base}` : base;
  }

  if (Array.from(key).length === 1) {
    return encodeCharacter(key, mods);
  }
  return key;
}

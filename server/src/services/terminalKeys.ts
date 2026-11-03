// FR-MCP-015 (#232): named keys and key combinations for buildergate.message.send, turned into the
// bytes a browser xterm sends.
//
// encodeTerminalKey is the same table as the browser's mobile key encoder
// (frontend/src/utils/mobileKeyEncoder.ts, FR-MKB-001). The two packages share no source folder, so
// the table lives in both; frontend/tests/unit/terminalKeyEncoderParity.test.ts compares them for
// every key, modifier combination and cursor mode, and fails on the first byte they disagree on.
// No imports on purpose: that test loads this file straight from the frontend test runner.

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const ESC = '\u001b';

const CURSOR_FINALS: Readonly<Record<string, string>> = {
  Up: 'A',
  Down: 'B',
  Right: 'C',
  Left: 'D',
  Home: 'H',
  End: 'F',
};

const TILDE_CODES: Readonly<Record<string, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

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

/** A named key or one character plus a modifier state, as PTY bytes (FR-MKB-001's table). */
export function encodeTerminalKey(key: string, mods: ModifierState, applicationCursor: boolean): string {
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

// ---------------------------------------------------------------------------------------------
// FR-MCP-015 AC-2..AC-5: key names as an MCP client writes them.

/** FR-MCP-015 AC-4: keys in one request. */
export const MCP_KEYS_MAX = 64;

export interface ParsedMcpKey {
  /** The name as given, lower-cased; what the audit and the result show. */
  name: string;
  /** The encoder's key: a key name or one character. */
  key: string;
  mods: ModifierState;
  /** Its bytes hold CR or LF, so sending it needs the submit scope (AC-5). */
  submits: boolean;
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', delete: 'Delete',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  esc: 'Esc', escape: 'Esc', tab: 'Tab', enter: 'Enter', return: 'Enter', backspace: 'Backspace', space: ' ',
};

const MODIFIER_NAMES: Readonly<Record<string, keyof ModifierState>> = {
  shift: 'shift', alt: 'alt', meta: 'alt', option: 'alt', ctrl: 'ctrl', control: 'ctrl',
};

const NEWLINE = 'newline';
const NO_MODS: ModifierState = { ctrl: false, alt: false, shift: false };

/** Splits "ctrl+alt+left" into modifiers and key; a trailing "++" is the "+" key. */
function splitSpec(spec: string): { modifiers: string[]; key: string } {
  if (spec === '+') return { modifiers: [], key: '+' };
  if (spec.endsWith('++')) return { modifiers: spec.slice(0, -2).split('+').filter(Boolean), key: '+' };
  const parts = spec.split('+');
  return { modifiers: parts.slice(0, -1), key: parts[parts.length - 1] ?? '' };
}

function parseOne(raw: string): ParsedMcpKey | string {
  const name = raw.trim().toLowerCase();
  const { modifiers, key: keyName } = splitSpec(name);
  if (keyName === '') return 'no key after the modifiers';
  const mods: ModifierState = { ...NO_MODS };
  for (const modifier of modifiers) {
    const field = lookup(MODIFIER_NAMES, modifier);
    if (field === undefined) return `unknown modifier "${modifier}" (use shift, alt or ctrl)`;
    mods[field] = true;
  }
  if (keyName === NEWLINE) {
    if (hasAnyModifier(mods)) return 'newline takes no modifier';
    return { name, key: 'j', mods: { ...NO_MODS, ctrl: true }, submits: true };
  }
  // A character keeps its case from the request ("A" is A). With shift a letter is taken in lower
  // case, so that shift is what makes it upper case.
  const character = Array.from(keyName).length === 1 ? Array.from(raw.trim()).slice(-1)[0] : undefined;
  const key = lookup(KEY_NAMES, keyName)
    ?? (character !== undefined && mods.shift && isAsciiLetter(character) ? character.toLowerCase() : character);
  if (key === undefined) return `unknown key "${keyName}"`;
  const bytes = encodeTerminalKey(key, mods, false);
  // AC-4: every modifier must change the bytes; one that would be dropped is refused.
  for (const field of ['shift', 'alt', 'ctrl'] as const) {
    if (mods[field] && encodeTerminalKey(key, { ...mods, [field]: false }, false) === bytes) {
      const hint = key === 'Enter' && field !== 'alt' ? '; use "newline" for a line break inside the input, or "enter" to submit' : '';
      return `${field} would be lost on "${keyName}"${hint}`;
    }
  }
  return { name, key, mods, submits: /[\r\n]/.test(bytes) };
}

/** FR-MCP-015 AC-2/AC-4: the keys of one request, or why they are refused (nothing is sent then). */
export function parseMcpKeys(input: unknown): { ok: true; keys: ParsedMcpKey[] } | { ok: false; errors: Record<string, string> } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: { keys: 'a non-empty array of key names' } };
  if (input.length > MCP_KEYS_MAX) return { ok: false, errors: { keys: `at most ${MCP_KEYS_MAX} keys` } };
  const keys: ParsedMcpKey[] = [];
  // A Map, not an object: a name such as "__proto__" would be dropped by the prototype setter and
  // the request would go out without the refused key (AC-4).
  const errors = new Map<string, string>();
  for (const item of input) {
    if (typeof item !== 'string') {
      errors.set(String(item), 'a key name must be a string');
      continue;
    }
    const parsed = parseOne(item);
    if (typeof parsed === 'string') errors.set(item.trim().toLowerCase(), parsed);
    else keys.push(parsed);
  }
  return errors.size > 0 ? { ok: false, errors: Object.fromEntries(errors) } : { ok: true, keys };
}

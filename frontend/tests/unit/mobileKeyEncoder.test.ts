// FR-MKB-001: the mobile key encoder turns a key name or one character plus a
// modifier state into the bytes xterm would have sent. It is a pure module: no
// DOM, no xterm import (see the SDS Durable Rules on why the keydown handler
// must not grow its own key table again).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeMobileKey, type ModifierState } from '../../src/utils/mobileKeyEncoder.ts';

const ESC = '\u001b';
const NONE: ModifierState = { ctrl: false, alt: false, shift: false };

function mods(partial: Partial<ModifierState>): ModifierState {
  return { ...NONE, ...partial };
}

// --- arrows, Home, End ---------------------------------------------------------

test('FR-MKB-001 AC-1 / SDS-AC-1: arrows without modifiers use CSI in normal cursor mode', () => {
  assert.equal(encodeMobileKey('Up', NONE, false), `${ESC}[A`);
  assert.equal(encodeMobileKey('Down', NONE, false), `${ESC}[B`);
  assert.equal(encodeMobileKey('Right', NONE, false), `${ESC}[C`);
  assert.equal(encodeMobileKey('Left', NONE, false), `${ESC}[D`);
});

test('FR-MKB-001 AC-1 / SDS-AC-1: arrows without modifiers use SS3 in application cursor mode', () => {
  assert.equal(encodeMobileKey('Up', NONE, true), `${ESC}OA`);
  assert.equal(encodeMobileKey('Down', NONE, true), `${ESC}OB`);
  assert.equal(encodeMobileKey('Right', NONE, true), `${ESC}OC`);
  assert.equal(encodeMobileKey('Left', NONE, true), `${ESC}OD`);
});

test('FR-MKB-001 AC-2 / SDS-AC-1: Home and End follow the applicationCursor argument', () => {
  assert.equal(encodeMobileKey('Home', NONE, false), `${ESC}[H`);
  assert.equal(encodeMobileKey('End', NONE, false), `${ESC}[F`);
  assert.equal(encodeMobileKey('Home', NONE, true), `${ESC}OH`);
  assert.equal(encodeMobileKey('End', NONE, true), `${ESC}OF`);
});

test('FR-MKB-001 AC-3 / SDS-AC-2: shift+alt+ctrl on an arrow emits modifier parameter 8', () => {
  assert.equal(encodeMobileKey('Up', mods({ shift: true, alt: true, ctrl: true }), false), `${ESC}[1;8A`);
  // The parameter form ignores application cursor mode: xterm only uses SS3 unmodified.
  assert.equal(encodeMobileKey('Up', mods({ shift: true, alt: true, ctrl: true }), true), `${ESC}[1;8A`);
});

test('FR-MKB-001 AC-3 / SDS-AC-2: every modifier parameter 2..8 on arrows, Home and End', () => {
  const cases: Array<[Partial<ModifierState>, number]> = [
    [{ shift: true }, 2],
    [{ alt: true }, 3],
    [{ shift: true, alt: true }, 4],
    [{ ctrl: true }, 5],
    [{ shift: true, ctrl: true }, 6],
    [{ alt: true, ctrl: true }, 7],
    [{ shift: true, alt: true, ctrl: true }, 8],
  ];
  const finals: Array<[string, string]> = [
    ['Up', 'A'], ['Down', 'B'], ['Right', 'C'], ['Left', 'D'], ['Home', 'H'], ['End', 'F'],
  ];
  for (const [partial, m] of cases) {
    for (const [key, final] of finals) {
      assert.equal(encodeMobileKey(key, mods(partial), false), `${ESC}[1;${m}${final}`, `${key} m=${m}`);
    }
  }
});

// --- Insert, Delete, PageUp, PageDown -------------------------------------------

test('FR-MKB-001 AC-4: Insert, Delete, PageUp, PageDown use tilde sequences with an optional modifier parameter', () => {
  const codes: Array<[string, number]> = [['Insert', 2], ['Delete', 3], ['PageUp', 5], ['PageDown', 6]];
  for (const [key, n] of codes) {
    assert.equal(encodeMobileKey(key, NONE, false), `${ESC}[${n}~`, key);
    assert.equal(encodeMobileKey(key, NONE, true), `${ESC}[${n}~`, `${key} app cursor`);
    assert.equal(encodeMobileKey(key, mods({ ctrl: true }), false), `${ESC}[${n};5~`, `${key} ctrl`);
    assert.equal(encodeMobileKey(key, mods({ shift: true, alt: true }), false), `${ESC}[${n};4~`, `${key} shift+alt`);
  }
});

// --- function keys -------------------------------------------------------------

test('FR-MKB-001 AC-5: F1..F4 use SS3 and F5..F12 use the xterm tilde numbers', () => {
  const expected: Record<string, string> = {
    F1: `${ESC}OP`, F2: `${ESC}OQ`, F3: `${ESC}OR`, F4: `${ESC}OS`,
    F5: `${ESC}[15~`, F6: `${ESC}[17~`, F7: `${ESC}[18~`, F8: `${ESC}[19~`,
    F9: `${ESC}[20~`, F10: `${ESC}[21~`, F11: `${ESC}[23~`, F12: `${ESC}[24~`,
  };
  for (const [key, bytes] of Object.entries(expected)) {
    assert.equal(encodeMobileKey(key, NONE, false), bytes, key);
  }
});

test('FR-MKB-001 AC-7: Ctrl or Shift on F1..F12 emits the unmodified bytes', () => {
  assert.equal(encodeMobileKey('F1', mods({ ctrl: true }), false), `${ESC}OP`);
  assert.equal(encodeMobileKey('F5', mods({ shift: true }), false), `${ESC}[15~`);
  assert.equal(encodeMobileKey('F12', mods({ ctrl: true, shift: true }), false), `${ESC}[24~`);
});

// --- Esc, Tab, Enter, Backspace -------------------------------------------------

test('FR-MKB-001 AC-6: Esc, Tab, Enter, Backspace and Shift+Tab', () => {
  assert.equal(encodeMobileKey('Esc', NONE, false), ESC);
  assert.equal(encodeMobileKey('Tab', NONE, false), '\t');
  assert.equal(encodeMobileKey('Enter', NONE, false), '\r');
  assert.equal(encodeMobileKey('Backspace', NONE, false), '\x7f');
  assert.equal(encodeMobileKey('Tab', mods({ shift: true }), false), `${ESC}[Z`);
});

// --- Ctrl + one character -------------------------------------------------------

test('FR-MKB-001 AC-7 / SDS-AC-3: ctrl+c and ctrl+C both map to 0x03', () => {
  assert.equal(encodeMobileKey('c', mods({ ctrl: true }), false), '\x03');
  assert.equal(encodeMobileKey('C', mods({ ctrl: true }), false), '\x03');
});

test('FR-MKB-001 AC-7 / SDS-AC-3: the full xterm ctrl table, letters case-insensitive', () => {
  for (let i = 0; i < 26; i += 1) {
    const lower = String.fromCharCode(0x61 + i);
    const upper = String.fromCharCode(0x41 + i);
    const expected = String.fromCharCode(0x01 + i);
    assert.equal(encodeMobileKey(lower, mods({ ctrl: true }), false), expected, `ctrl+${lower}`);
    assert.equal(encodeMobileKey(upper, mods({ ctrl: true }), false), expected, `ctrl+${upper}`);
  }
  const table: Array<[string, string]> = [
    ['@', '\x00'], ['2', '\x00'], [' ', '\x00'],
    ['[', '\x1b'], ['3', '\x1b'],
    ['\\', '\x1c'], ['4', '\x1c'],
    [']', '\x1d'], ['5', '\x1d'],
    ['^', '\x1e'], ['6', '\x1e'],
    ['_', '\x1f'], ['-', '\x1f'], ['7', '\x1f'],
    ['?', '\x7f'], ['8', '\x7f'],
  ];
  for (const [ch, expected] of table) {
    assert.equal(encodeMobileKey(ch, mods({ ctrl: true }), false), expected, `ctrl+${JSON.stringify(ch)}`);
  }
});

test('FR-MKB-001 AC-7 / SDS-AC-3: ctrl on a character outside the xterm table passes it through unchanged', () => {
  assert.equal(encodeMobileKey('é', mods({ ctrl: true }), false), 'é');
  assert.equal(encodeMobileKey('1', mods({ ctrl: true }), false), '1');
  assert.equal(encodeMobileKey('.', mods({ ctrl: true }), false), '.');
});

test('FR-MKB-001 AC-7 / AC-8: shift uppercases a letter before ctrl, and leaves non-letters alone', () => {
  assert.equal(encodeMobileKey('a', mods({ shift: true }), false), 'A');
  assert.equal(encodeMobileKey('1', mods({ shift: true }), false), '1');
  assert.equal(encodeMobileKey('a', mods({ shift: true, ctrl: true }), false), '\x01');
  assert.equal(encodeMobileKey('a', mods({ shift: true, alt: true }), false), `${ESC}A`);
});

// --- Alt ------------------------------------------------------------------------

test('FR-MKB-001 AC-8 / SDS-AC-4: alt on a key with a parameter form emits the parameter form without an ESC prefix', () => {
  assert.equal(encodeMobileKey('Up', mods({ alt: true }), false), `${ESC}[1;3A`);
  assert.equal(encodeMobileKey('Delete', mods({ alt: true }), false), `${ESC}[3;3~`);
  assert.equal(encodeMobileKey('Home', mods({ alt: true }), true), `${ESC}[1;3H`);
});

test('FR-MKB-001 AC-8 / SDS-AC-4: alt prefixes one ESC on characters, Esc/Tab/Enter/Backspace and F keys', () => {
  assert.equal(encodeMobileKey('x', mods({ alt: true }), false), `${ESC}x`);
  assert.equal(encodeMobileKey('F5', mods({ alt: true }), false), `${ESC}${ESC}[15~`);
  assert.equal(encodeMobileKey('F1', mods({ alt: true }), false), `${ESC}${ESC}OP`);
  assert.equal(encodeMobileKey('Esc', mods({ alt: true }), false), `${ESC}${ESC}`);
  assert.equal(encodeMobileKey('Tab', mods({ alt: true }), false), `${ESC}\t`);
  assert.equal(encodeMobileKey('Enter', mods({ alt: true }), false), `${ESC}\r`);
  assert.equal(encodeMobileKey('Backspace', mods({ alt: true }), false), `${ESC}\x7f`);
  assert.equal(encodeMobileKey('c', mods({ alt: true, ctrl: true }), false), `${ESC}\x03`);
});

test('CON-MKB-001 AC-1: the mobile key encoder imports no DOM, xterm or socket module and touches no browser global', () => {
  const source = readFileSync(new URL('../../src/utils/mobileKeyEncoder.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.doesNotMatch(specifier, /^(react|react-dom|@xterm\/|xterm)/, `encoder imports ${specifier}`);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(document|window|navigator|WebSocket)\b/, 'encoder references a browser global');
});

test('CON-MKB-001 AC-2: mobile key encoding never runs inside the xterm keydown handler', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('attachCustomKeyEventHandler(');
  assert.ok(start > 0, 'TerminalView installs a custom key handler');
  let depth = 0;
  let end = start;
  for (let index = source.indexOf('(', start); index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    if (depth === 0) { end = index; break; }
  }
  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /encodeMobileKey|applyLatchToTypedData|mobileModifierLatch/, 'the keydown handler encodes mobile keys');
});

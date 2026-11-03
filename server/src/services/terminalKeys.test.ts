// FR-MCP-015 (#232): named keys and key combinations for buildergate.message.send, as the bytes a
// browser xterm sends. The byte table must equal the browser's mobile key encoder; that parity is
// checked from the frontend side (frontend/tests/unit/terminalKeyEncoderParity.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeTerminalKey, MCP_KEYS_MAX, parseMcpKeys, type ParsedMcpKey } from './terminalKeys.js';

const ESC = '\u001b';
const none = { ctrl: false, alt: false, shift: false };

function bytes(spec: string, applicationCursor = false): string {
  const parsed = parseMcpKeys([spec]);
  assert.equal(parsed.ok, true, `${spec}: ${JSON.stringify(parsed)}`);
  const [key] = (parsed as { ok: true; keys: ParsedMcpKey[] }).keys;
  return encodeTerminalKey(key!.key, key!.mods, applicationCursor);
}

test('FR-MCP-015 AC-3: arrows follow the application cursor mode, and take the CSI 1;m form with modifiers', () => {
  assert.equal(bytes('up'), `${ESC}[A`);
  assert.equal(bytes('up', true), `${ESC}OA`);
  assert.equal(bytes('Down'), `${ESC}[B`);
  assert.equal(bytes('shift+up'), `${ESC}[1;2A`);
  assert.equal(bytes('shift+up', true), `${ESC}[1;2A`);
  assert.equal(bytes('ctrl+alt+left'), `${ESC}[1;7D`);
  assert.equal(bytes('CTRL+Right'), `${ESC}[1;5C`);
  assert.equal(bytes('home'), `${ESC}[H`);
  assert.equal(bytes('shift+end'), `${ESC}[1;2F`);
});

test('FR-MCP-015 AC-3: tilde keys and function keys use the xterm forms', () => {
  assert.equal(bytes('pageup'), `${ESC}[5~`);
  assert.equal(bytes('shift+pagedown'), `${ESC}[6;2~`);
  assert.equal(bytes('delete'), `${ESC}[3~`);
  assert.equal(bytes('insert'), `${ESC}[2~`);
  assert.equal(bytes('f1'), `${ESC}OP`);
  assert.equal(bytes('f5'), `${ESC}[15~`);
});

test('FR-MCP-015 AC-3: esc, tab, shift+tab, enter, backspace, space, newline, ctrl and alt with characters', () => {
  assert.equal(bytes('esc'), ESC);
  assert.equal(bytes('escape'), ESC);
  assert.equal(bytes('tab'), '\t');
  assert.equal(bytes('shift+tab'), `${ESC}[Z`);
  assert.equal(bytes('enter'), '\r');
  assert.equal(bytes('backspace'), '\x7f');
  assert.equal(bytes('space'), ' ');
  assert.equal(bytes('newline'), '\n');
  assert.equal(bytes('ctrl+c'), '\x03');
  assert.equal(bytes('ctrl+D'), '\x04');
  assert.equal(bytes('alt+b'), `${ESC}b`);
  assert.equal(bytes('alt+enter'), `${ESC}\r`);
  assert.equal(bytes('alt+backspace'), `${ESC}\x7f`);
  assert.equal(bytes('alt+esc'), `${ESC}${ESC}`);
  assert.equal(bytes('alt+space'), `${ESC} `);
  // What a browser xterm and the mobile keyboard send for these.
  assert.equal(bytes('ctrl+space'), '\x00');
  assert.equal(bytes('alt+f12'), `${ESC}${ESC}[24~`);
  assert.equal(bytes('ctrl+alt+a'), `${ESC}\x01`);
  assert.equal(bytes('a'), 'a');
  assert.equal(bytes('shift+a'), 'A');
  assert.equal(bytes('/'), '/');
  assert.equal(bytes('+'), '+');
});

test('FR-MCP-015 AC-4: unknown names and combinations legacy bytes cannot tell apart are refused, with a replacement where there is one', () => {
  const refused = parseMcpKeys(['up', 'shift+enter', 'hyper+x', 'shift+backspace', 'f13', 'ctrl+']);
  assert.equal(refused.ok, false);
  const errors = (refused as { ok: false; errors: Record<string, string> }).errors;
  assert.deepEqual(Object.keys(errors).sort(), ['ctrl+', 'f13', 'hyper+x', 'shift+backspace', 'shift+enter'].sort());
  assert.match(errors['shift+enter']!, /newline/);
  // Ctrl with a character that has no C0 code would go out unchanged: refused, not silently altered.
  // Every modifier must change the bytes; one that would be dropped is refused, not lost silently.
  // Shift and Ctrl on F1..F12 are dropped by the shared table (FR-MKB-001 AC-7).
  for (const spec of ['ctrl+enter', 'shift+esc', 'shift+space', 'ctrl+backspace', 'ctrl++', 'ctrl+1', 'ctrl+9',
    'shift+f1', 'ctrl+f5', 'shift+1', 'ctrl+shift+a', 'ctrl+tab', 'shift+newline']) {
    assert.equal(parseMcpKeys([spec]).ok, false, spec);
  }
  // A name that is also an Object.prototype key must still be refused, not dropped by a setter.
  for (const spec of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(parseMcpKeys(['down', spec]).ok, false, spec);
  }
  assert.equal(parseMcpKeys([]).ok, false);
  assert.equal(parseMcpKeys('up').ok, false);
  assert.equal(parseMcpKeys([7]).ok, false);
  assert.equal(parseMcpKeys(Array.from({ length: MCP_KEYS_MAX }, () => 'down')).ok, true);
  assert.equal(parseMcpKeys(Array.from({ length: MCP_KEYS_MAX + 1 }, () => 'down')).ok, false);
});

test('FR-MCP-015 AC-5: a key whose bytes hold CR or LF is a submit key', () => {
  const parsed = parseMcpKeys(['down', 'enter', 'newline', 'ctrl+m', 'ctrl+j', 'esc', 'ctrl+c']);
  assert.equal(parsed.ok, true);
  const keys = (parsed as { ok: true; keys: ParsedMcpKey[] }).keys;
  assert.deepEqual(keys.map((key) => key.submits), [false, true, true, true, true, false, false]);
  assert.equal(encodeTerminalKey('Up', none, false), `${ESC}[A`);
});

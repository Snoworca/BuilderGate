import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeTerminalPasteText } from '../../src/utils/terminalPasteSanitizer.ts';

const ESC = '\u001b';
// 8-bit CSI. xterm's parser accepts it as an introducer, so a payload carrying it
// can close the bracket exactly as the 7-bit form does.
const CSI8 = '\u009b';
const BEL = '\u0007';
const DEL = '\u007f';

test('SEC-BGSTAB-001 AC-8: an embedded close marker cannot end the bracket early', () => {
  // The attack: term.paste() wraps this in ESC[200~ ... ESC[201~, and prepareTextForTerminal
  // has already turned every newline into CR. If the payload's own ESC[201~ survives, the
  // shell leaves paste mode at that point and runs the remainder as typed commands.
  const result = sanitizeTerminalPasteText(`echo safe${ESC}[201~\nrm -rf /`);

  assert.equal(result.text.includes(`${ESC}[201~`), false);
  assert.equal(result.text, 'echo safe\nrm -rf /');
  assert.equal(result.removedBracketedPasteMarkers, 1);
});

test('SEC-BGSTAB-001 AC-8: an embedded open marker is removed too', () => {
  const result = sanitizeTerminalPasteText(`a${ESC}[200~b`);

  assert.equal(result.text, 'ab');
  assert.equal(result.removedBracketedPasteMarkers, 1);
});

test('SEC-BGSTAB-001 AC-8: the 8-bit CSI form of both markers is removed', () => {
  const result = sanitizeTerminalPasteText(`a${CSI8}200~b${CSI8}201~c`);

  assert.equal(result.text, 'abc');
  assert.equal(result.removedBracketedPasteMarkers, 2);
});

test('SEC-BGSTAB-001 AC-8: every marker is removed, not just the first', () => {
  const result = sanitizeTerminalPasteText(`${ESC}[201~x${ESC}[201~y${ESC}[201~`);

  assert.equal(result.text, 'xy');
  assert.equal(result.removedBracketedPasteMarkers, 3);
});

test('#18: a bare ESC is removed so no other escape sequence survives the paste', () => {
  // ESC]0;pwned BEL would retitle the window; the point is that no ESC reaches the PTY
  // from a paste at all, not that we enumerate which sequences are dangerous.
  const result = sanitizeTerminalPasteText(`${ESC}]0;pwned${BEL}tail`);

  assert.equal(result.text.includes(ESC), false);
  assert.equal(result.text, ']0;pwnedtail');
  assert.equal(result.removedControlCount, 2);
  assert.equal(result.removedBracketedPasteMarkers, 0);
});

test('#18: tab, newline and carriage return survive so paste semantics are unchanged', () => {
  const result = sanitizeTerminalPasteText('a\tb\nc\r\nd');

  assert.equal(result.text, 'a\tb\nc\r\nd');
  assert.equal(result.removedControlCount, 0);
  assert.equal(result.removedBracketedPasteMarkers, 0);
});

test('#18: DEL and C1 controls are removed', () => {
  const result = sanitizeTerminalPasteText(`a${DEL}b\u0090c`);

  assert.equal(result.text, 'abc');
  assert.equal(result.removedControlCount, 2);
});

test('#18: ordinary text including non-ASCII is returned unchanged', () => {
  const payload = 'git commit -m "한글 메시지, emoji included"';
  const result = sanitizeTerminalPasteText(payload);

  assert.equal(result.text, payload);
  assert.equal(result.removedControlCount, 0);
  assert.equal(result.removedBracketedPasteMarkers, 0);
});

test('#18: the empty payload is handled without special-casing by the caller', () => {
  const result = sanitizeTerminalPasteText('');

  assert.equal(result.text, '');
  assert.equal(result.removedControlCount, 0);
  assert.equal(result.removedBracketedPasteMarkers, 0);
});

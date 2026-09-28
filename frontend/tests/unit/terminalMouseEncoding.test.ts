import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideBinaryMouseReport,
  mouseEncodingRestoreSequence,
  readTerminalMouseEncoding,
} from '../../src/utils/terminalMouseEncoding.ts';

// REL-BGSTAB-039 — a restored terminal keeps the mouse report encoding, and every mouse report
// reaches the PTY.

test('AC-3: the browser snapshot re-selects SGR and SGR-pixels, and nothing for the default', () => {
  assert.equal(mouseEncodingRestoreSequence('SGR'), '\x1b[?1006h');
  assert.equal(mouseEncodingRestoreSequence('SGR_PIXELS'), '\x1b[?1016h');
  assert.equal(mouseEncodingRestoreSequence('DEFAULT'), '');
  assert.equal(mouseEncodingRestoreSequence(null), '');
});

test('AC-3: the encoding is read from the xterm core, and anything unreadable is null', () => {
  const fake = (activeEncoding: unknown) => ({ _core: { coreMouseService: { activeEncoding } } });
  assert.equal(readTerminalMouseEncoding(fake('SGR')), 'SGR');
  assert.equal(readTerminalMouseEncoding(fake('SGR_PIXELS')), 'SGR_PIXELS');
  assert.equal(readTerminalMouseEncoding(fake('DEFAULT')), 'DEFAULT');
  assert.equal(readTerminalMouseEncoding(fake('URXVT')), null);
  assert.equal(readTerminalMouseEncoding({}), null);
  assert.equal(readTerminalMouseEncoding(null), null);
});

test('AC-4: a 7-bit default-encoding report is forwarded as it is', () => {
  // ESC [ M, button 96 (wheel up), col 85 -> 117, row 17 -> 49: all 7-bit.
  const report = '\x1b[M' + String.fromCharCode(96, 117, 49);
  assert.deepEqual(decideBinaryMouseReport(report), { forward: true, data: report });
});

test('AC-4: a report with a byte above 0x7F is dropped, and an empty one is ignored', () => {
  // col 120 -> 152: the text input path would re-encode it as two UTF-8 bytes.
  const report = '\x1b[M' + String.fromCharCode(96, 152, 49);
  assert.deepEqual(decideBinaryMouseReport(report), { forward: false, reason: 'non-ascii-byte' });
  assert.deepEqual(decideBinaryMouseReport(''), { forward: false, reason: 'empty' });
});

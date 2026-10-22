// REL-BGSTAB-038 AC-6/AC-7: a resize is only sent when the size changes, so a
// resize that never reached the server, or a server that rebuilt the PTY at its
// default 80x24 while the browser was reconnecting, left the PTY at the wrong
// size for good: the browser terminal never changed size again, so nothing sent
// it. Measured 2026-10-22 on 0.10.19: four grid panes drawn in their top 24 rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResizeSendLedger } from '../../src/components/Terminal/terminalResizeSendLedger.ts';

test('REL-BGSTAB-038 AC-3: a size already delivered is not sent again', () => {
  const ledger = createResizeSendLedger();
  assert.equal(ledger.needsSend({ cols: 120, rows: 40 }), true);
  ledger.recordSend({ cols: 120, rows: 40 }, true);
  assert.equal(ledger.needsSend({ cols: 120, rows: 40 }), false);
  assert.equal(ledger.needsSend({ cols: 120, rows: 41 }), true);
});

test('REL-BGSTAB-038 AC-6: a resize that could not be sent is not recorded as sent', () => {
  const ledger = createResizeSendLedger();
  ledger.recordSend({ cols: 120, rows: 40 }, false);
  assert.equal(ledger.needsSend({ cols: 120, rows: 40 }), true);

  ledger.recordSend({ cols: 80, rows: 24 }, true);
  ledger.recordSend({ cols: 120, rows: 40 }, false);
  assert.equal(ledger.needsSend({ cols: 120, rows: 40 }), true);
});

test('REL-BGSTAB-038 AC-7: an opened connection resends the last size even when it was delivered before', () => {
  const ledger = createResizeSendLedger();
  ledger.recordSend({ cols: 120, rows: 40 }, true);
  const resend = ledger.forgetAndResend({ cols: 120, rows: 40 });
  assert.deepEqual(resend, { cols: 120, rows: 40 });
  assert.equal(ledger.needsSend({ cols: 120, rows: 40 }), true);
});

test('REL-BGSTAB-038 AC-7: nothing is resent before the terminal has a size', () => {
  const ledger = createResizeSendLedger();
  assert.equal(ledger.forgetAndResend(null), null);
});

const containerSource = () => readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);

test('REL-BGSTAB-038 AC-6/AC-7: TerminalContainer resends through the ledger when the socket connects', () => {
  const source = containerSource();
  assert.match(source, /createResizeSendLedger\(\)/);
  assert.match(source, /forgetAndResend\(lastResizeRef\.current\)/);
  assert.match(source, /'ws-connected-resend'/);
});

// A workspace switch reveals a terminal whose browser size did not change, so no
// fit and no resize happened; a 270-column PTY stayed behind a 68-column pane and
// every full-width rule Claude Code drew folded into four lines over the text.
test('REL-BGSTAB-038 AC-8: TerminalContainer resends the last size when a hidden terminal is shown again', () => {
  assert.match(containerSource(), /'reveal-resend'/);
});

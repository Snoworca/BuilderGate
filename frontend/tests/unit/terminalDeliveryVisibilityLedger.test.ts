// REL-BGSTAB-052 AC-10: the per-session delivery visibility the client reports is forgotten
// when the session is unsubscribed, and a session seen again still gets a generation the
// server accepts (it ignores any generation not above the last one it saw on the socket).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryVisibilityLedger } from '../../src/utils/terminalDeliveryVisibilityLedger.ts';

test('REL-BGSTAB-052 AC-10: unchanged visibility is not republished; a change raises the generation', () => {
  const ledger = createDeliveryVisibilityLedger();
  assert.equal(ledger.publish('s1', true, 1), true);
  const first = ledger.get('s1')!.generation;
  assert.equal(ledger.publish('s1', true, 1), false, 'same visibility: nothing to send');
  assert.equal(ledger.publish('s1', false, 1), true);
  assert.ok(ledger.get('s1')!.generation > first);
});

test('REL-BGSTAB-052 AC-10: a forgotten session is dropped, and coming back it still moves forward', () => {
  const ledger = createDeliveryVisibilityLedger();
  for (let i = 0; i < 500; i += 1) { ledger.publish(`s${i}`, true, 1); ledger.forget(`s${i}`); }
  assert.equal([...ledger.entries()].length, 0, 'closed sessions leave nothing behind');
  ledger.publish('back', true, 1);
  const before = ledger.get('back')!.generation;
  ledger.forget('back');
  ledger.publish('back', true, 1);
  assert.ok(ledger.get('back')!.generation > before, 'never repeats a generation the server has seen');
});

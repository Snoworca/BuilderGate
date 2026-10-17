// FR-MKB-006 AC-3 / SDS-AC-5: a mobile bar key goes through the encoder and the
// latch, then to the active terminal's existing sendInput path. App.tsx's
// sendMobileKey delegates to sendMobileKeyTo with the active tab's handle, so the
// helper is exercised here with a fake handle instead of rendering App.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { LATCH_HOLD_MS, mobileModifierLatch, sendMobileKeyTo } from '../../src/utils/mobileModifierLatch.ts';

const ESC = '\u001b';

function fakeHandle(applicationCursor: boolean) {
  const sent: string[] = [];
  return {
    sent,
    handle: {
      getApplicationCursorKeysMode: () => applicationCursor,
      sendInput: (data: string) => { sent.push(data); },
    },
  };
}

test.beforeEach(() => {
  mobileModifierLatch.reset();
});

test('FR-MKB-006 AC-3 / SDS-AC-5: Up with Ctrl once and application cursor mode sends ESC [1;5A and leaves Ctrl off', () => {
  const { sent, handle } = fakeHandle(true);
  mobileModifierLatch.tap('ctrl');
  sendMobileKeyTo(handle, 'Up');
  assert.deepEqual(sent, [`${ESC}[1;5A`]);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'once Ctrl is consumed after sending');
});

test('FR-MKB-006 AC-3 / SDS-AC-5: application cursor mode decides the unmodified arrow form', () => {
  const app = fakeHandle(true);
  sendMobileKeyTo(app.handle, 'Up');
  const normal = fakeHandle(false);
  sendMobileKeyTo(normal.handle, 'Up');
  assert.deepEqual(app.sent, [`${ESC}OA`]);
  assert.deepEqual(normal.sent, [`${ESC}[A`]);
});

test('FR-MKB-006 AC-3 / SDS-AC-5: a locked modifier stays applied across keys', () => {
  const { sent, handle } = fakeHandle(false);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    mobileModifierLatch.startPress('ctrl');
    mock.timers.tick(LATCH_HOLD_MS);
  } finally {
    mock.timers.reset();
  }
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked');
  sendMobileKeyTo(handle, 'Left');
  sendMobileKeyTo(handle, 'Right');
  assert.deepEqual(sent, [`${ESC}[1;5D`, `${ESC}[1;5C`]);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked', 'locked survives the send');
});

test('FR-MKB-006 AC-3 / SDS-AC-5: without an active handle nothing is sent and once stays', () => {
  mobileModifierLatch.tap('ctrl');
  sendMobileKeyTo(null, 'Up');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'nothing was sent, so nothing is consumed');
});

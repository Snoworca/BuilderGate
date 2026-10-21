// FR-MKB-002 / FR-MKB-003: the module-level Ctrl/Alt/Shift latch store and the
// typed-data re-encoding step that TerminalView calls from term.onData.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATCH_HOLD_MS,
  applyLatchToTypedData,
  mobileModifierLatch,
  takeLatchedPaste,
} from '../../src/utils/mobileModifierLatch.ts';

const ESC = '\u001b';

function setVibrate(value: unknown): () => void {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(nav, 'vibrate');
  const previous = nav.vibrate;
  Object.defineProperty(nav, 'vibrate', { value, configurable: true, writable: true });
  return () => {
    if (had) {
      Object.defineProperty(nav, 'vibrate', { value: previous, configurable: true, writable: true });
    } else {
      delete nav.vibrate;
    }
  };
}

function withFakeTimers(run: () => void): void {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    run();
  } finally {
    mock.timers.reset();
  }
}

test.beforeEach(() => {
  mobileModifierLatch.resetForTests();
});

// --- tap -----------------------------------------------------------------------

test('FR-MKB-002 AC-1: tap cycles off -> once -> off, and locked -> off', () => {
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once');
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');

  withFakeTimers(() => {
    mobileModifierLatch.startPress('alt');
    mock.timers.tick(LATCH_HOLD_MS);
  });
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'locked');
  mobileModifierLatch.startPress('alt').release();
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'off');
});

test('FR-MKB-002 AC-6: getSnapshot is stable until a change and subscribers are notified', () => {
  const first = mobileModifierLatch.getSnapshot();
  assert.equal(mobileModifierLatch.getSnapshot(), first, 'same object while nothing changed');
  let calls = 0;
  const unsubscribe = mobileModifierLatch.subscribe(() => { calls += 1; });
  mobileModifierLatch.tap('shift');
  assert.equal(calls, 1);
  const second = mobileModifierLatch.getSnapshot();
  assert.notEqual(second, first, 'a change produces a new snapshot');
  assert.deepEqual(second, { ctrl: 'off', alt: 'off', shift: 'once' });
  assert.equal(Object.isFrozen(second), true, 'snapshot is immutable');
  unsubscribe();
  mobileModifierLatch.tap('shift');
  assert.equal(calls, 1, 'unsubscribed listener is not called');
});

// --- press and hold ------------------------------------------------------------

// 2026-10-21: 1500 ms, then 1000 ms, were too long to hold on a phone; the lock now comes at 750 ms.
test('FR-MKB-002 AC-2 / SDS-AC-5: LATCH_HOLD_MS is 750', () => {
  assert.equal(LATCH_HOLD_MS, 750);
});

test('FR-MKB-002 AC-2 AC-3 / SDS-AC-5: a release at 749 ms is a tap', () => {
  withFakeTimers(() => {
    const press = mobileModifierLatch.startPress('ctrl');
    mock.timers.tick(749);
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'nothing changes before 750 ms');
    press.release();
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'an early release is a tap');
    mock.timers.tick(10);
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'the cleared timer never fires');
  });
});

test('FR-MKB-002 AC-2 / SDS-AC-5: at 750 ms the modifier is locked before release, and release then does nothing', () => {
  withFakeTimers(() => {
    const press = mobileModifierLatch.startPress('ctrl');
    mock.timers.tick(750);
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked');
    press.release();
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked');
  });
});

test('FR-MKB-002 AC-3 / SDS-AC-6: cancel leaves off and once untouched and fires no timer', () => {
  mobileModifierLatch.startPress('alt').release();
  withFakeTimers(() => {
    const ctrlPress = mobileModifierLatch.startPress('ctrl');
    const altPress = mobileModifierLatch.startPress('alt');
    ctrlPress.cancel();
    altPress.cancel();
    mock.timers.tick(5000);
  });
  assert.deepEqual(mobileModifierLatch.getSnapshot(), { ctrl: 'off', alt: 'once', shift: 'off' });
});

test('FR-MKB-002 AC-5 / SDS-AC-7: locking without navigator.vibrate does not throw', () => {
  const restore = setVibrate(undefined);
  try {
    withFakeTimers(() => {
      mobileModifierLatch.startPress('shift');
      assert.doesNotThrow(() => mock.timers.tick(LATCH_HOLD_MS));
    });
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'locked');
  } finally {
    restore();
  }
});

test('FR-MKB-002 AC-5 / SDS-AC-7: locking calls navigator.vibrate(25) when it exists', () => {
  const calls: unknown[][] = [];
  const restore = setVibrate((...args: unknown[]) => { calls.push(args); return true; });
  try {
    withFakeTimers(() => {
      mobileModifierLatch.startPress('ctrl');
      mock.timers.tick(LATCH_HOLD_MS - 1);
      assert.deepEqual(calls, [], 'no vibration before the lock');
      mock.timers.tick(1);
    });
    assert.deepEqual(calls, [[25]]);
  } finally {
    restore();
  }
});

// --- consumeOnce / activeModifiers ---------------------------------------------

test('FR-MKB-002 AC-4 / SDS-AC-8: consumeOnce turns once off and keeps locked; a tap releases the lock', () => {
  mobileModifierLatch.startPress('ctrl').release();
  withFakeTimers(() => {
    mobileModifierLatch.startPress('alt');
    mock.timers.tick(LATCH_HOLD_MS);
  });
  assert.deepEqual(mobileModifierLatch.activeModifiers(), { ctrl: true, alt: true, shift: false });
  mobileModifierLatch.consumeOnce();
  assert.deepEqual(mobileModifierLatch.getSnapshot(), { ctrl: 'off', alt: 'locked', shift: 'off' });
  assert.deepEqual(mobileModifierLatch.activeModifiers(), { ctrl: false, alt: true, shift: false });
  mobileModifierLatch.startPress('alt').release();
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'off');
});

// --- applyLatchToTypedData -----------------------------------------------------

test('FR-MKB-003 AC-1: ctrl once re-encodes c and auto-capitalised C to 0x03 and consumes once', () => {
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(applyLatchToTypedData('c', false), '\x03');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(applyLatchToTypedData('C', false), '\x03');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');
});

test('FR-MKB-003 AC-1: a locked modifier survives typed characters', () => {
  withFakeTimers(() => {
    mobileModifierLatch.startPress('alt');
    mock.timers.tick(LATCH_HOLD_MS);
  });
  assert.equal(applyLatchToTypedData('x', false), `${ESC}x`);
  assert.equal(applyLatchToTypedData('y', false), `${ESC}y`);
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'locked');
});

test('FR-MKB-003 AC-3 / SDS-AC-9: non-ASCII, multi-character and modifier-free data is returned unchanged with state kept', () => {
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(applyLatchToTypedData('한', false), '한');
  assert.equal(applyLatchToTypedData('ab', false), 'ab');
  assert.equal(applyLatchToTypedData('\r', false), '\r', 'a control character is not printable ASCII');
  assert.equal(applyLatchToTypedData(`${ESC}[A`, false), `${ESC}[A`);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'unconverted input leaves once untouched');

  mobileModifierLatch.resetForTests();
  assert.equal(applyLatchToTypedData('c', false), 'c', 'no modifier -> identity');
  assert.deepEqual(mobileModifierLatch.getSnapshot(), { ctrl: 'off', alt: 'off', shift: 'off' });
});

test('FR-MKB-002 AC-4 / SDS-AC-8 / FR-MKB-003 AC-1: a printable ASCII key the modifier leaves unchanged still consumes once', () => {
  // The character reached the converter, so it is one encoded key: once turns off
  // even though the encoded result equals the input.
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(applyLatchToTypedData('1', false), '1', 'ctrl+1 is outside the xterm table');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'ctrl once is consumed by ctrl+1');

  mobileModifierLatch.tap('shift');
  assert.equal(applyLatchToTypedData('1', false), '1', 'shift on a non-letter is unchanged');
  assert.equal(mobileModifierLatch.getSnapshot().shift, 'off', 'shift once is consumed by shift+1');

  withFakeTimers(() => {
    mobileModifierLatch.startPress('ctrl');
    mock.timers.tick(LATCH_HOLD_MS);
  });
  mobileModifierLatch.tap('shift');
  assert.equal(applyLatchToTypedData('.', false), '.');
  assert.deepEqual(
    mobileModifierLatch.getSnapshot(),
    { ctrl: 'locked', alt: 'off', shift: 'off' },
    'once is consumed, locked stays',
  );
});

// --- production reset (wave 2) --------------------------------------------------

test('FR-MKB-006 AC-7 / SDS-AC-7: reset during a held press commits all off and the hold timer does not lock', () => {
  mobileModifierLatch.startPress('alt').release();
  let press: { release(): void } | null = null;
  withFakeTimers(() => {
    press = mobileModifierLatch.startPress('ctrl');
    mock.timers.tick(LATCH_HOLD_MS - 1);
    mobileModifierLatch.reset();
    assert.deepEqual(mobileModifierLatch.getSnapshot(), { ctrl: 'off', alt: 'off', shift: 'off' });
    mock.timers.tick(LATCH_HOLD_MS);
  });
  assert.deepEqual(
    mobileModifierLatch.getSnapshot(),
    { ctrl: 'off', alt: 'off', shift: 'off' },
    'the press started before reset never locks',
  );
  (press as unknown as { release(): void }).release();
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'a release of the stale press is not a tap');
});

test('FR-MKB-006 AC-7 / SDS-AC-7: reset clears a locked modifier and later presses still work', () => {
  withFakeTimers(() => {
    mobileModifierLatch.startPress('shift');
    mock.timers.tick(LATCH_HOLD_MS);
  });
  assert.equal(mobileModifierLatch.getSnapshot().shift, 'locked');
  mobileModifierLatch.reset();
  assert.equal(mobileModifierLatch.getSnapshot().shift, 'off');
  withFakeTimers(() => {
    mobileModifierLatch.startPress('shift').release();
  });
  assert.equal(mobileModifierLatch.getSnapshot().shift, 'once', 'a press after reset is a normal tap');
});

// --- turnOff (A-001) -------------------------------------------------------------

test('FR-MKB-003 / FR-MKB-008 (A-001): turnOff clears one modifier from once or locked, notifies once, and leaves the others', () => {
  withFakeTimers(() => {
    const restore = setVibrate(() => true);
    try {
      mobileModifierLatch.startPress('ctrl').release();
      const press = mobileModifierLatch.startPress('shift');
      mock.timers.tick(LATCH_HOLD_MS);
      press.release();
    } finally {
      restore();
    }
  });
  assert.deepEqual({ ...mobileModifierLatch.getSnapshot() }, { ctrl: 'once', alt: 'off', shift: 'locked' }, 'precondition');

  let notified = 0;
  const unsubscribe = mobileModifierLatch.subscribe(() => { notified += 1; });
  try {
    mobileModifierLatch.turnOff('shift');
    assert.deepEqual({ ...mobileModifierLatch.getSnapshot() }, { ctrl: 'once', alt: 'off', shift: 'off' });
    assert.equal(notified, 1, 'subscribers hear the change');
    mobileModifierLatch.turnOff('shift');
    assert.equal(notified, 1, 'turning off an off modifier notifies nobody');

    mobileModifierLatch.tap('shift');
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'once');
    mobileModifierLatch.turnOff('shift');
    assert.equal(mobileModifierLatch.getSnapshot().shift, 'off', 'once goes off as well');
  } finally {
    unsubscribe();
  }
});

// FR-MKB-003 AC-6 (2026-10-21): with Ctrl latched, v pastes the clipboard as Ctrl+V does on a
// desktop, instead of sending the ^V control character the program would see.
test('FR-MKB-003 AC-6: Ctrl latched + v is a clipboard paste and spends a once Ctrl', () => {
  mobileModifierLatch.reset();
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(takeLatchedPaste('v'), true);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off', 'a once Ctrl is spent');
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(takeLatchedPaste('V'), true, 'auto-capitalised V too');
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');
});

test('FR-MKB-003 AC-6: anything else is not a paste and leaves the latch as it was', () => {
  mobileModifierLatch.reset();
  assert.equal(takeLatchedPaste('v'), false, 'no Ctrl');
  mobileModifierLatch.startPress('ctrl').release();
  assert.equal(takeLatchedPaste('c'), false);
  assert.equal(takeLatchedPaste('vv'), false);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once', 'untouched');
  mobileModifierLatch.startPress('alt').release();
  assert.equal(takeLatchedPaste('v'), false, 'Ctrl+Alt+v stays a key for the program');
});

test('FR-MKB-003 AC-6: TerminalView pastes through the clipboard coordinator before re-encoding', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(takeLatchedPaste\(data\)\) \{\s*void clipboardCoordinatorRef\.current\?\.pasteClipboard\('keyboard'\);\s*return;\s*\}\s*data = applyLatchToTypedData\(/);
});

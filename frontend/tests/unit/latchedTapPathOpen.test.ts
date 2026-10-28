import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { openPathOnLatchedTap } from '../../src/utils/latchedTapPathOpen.ts';
import { mobileModifierLatch } from '../../src/utils/mobileModifierLatch.ts';
import type { TerminalPathTarget } from '../../src/utils/terminalPathDetection.ts';
import type { TerminalPathsAtPoint } from '../../src/utils/terminalPathLinks.ts';

// FR-ARCH-013 AC-10: on a phone the key bar's Ctrl latch turns a tap on a path into
// the desktop's Ctrl+click. AC-6: with the latch off a tap opens nothing.

const near: TerminalPathTarget = { path: '.\\mobile.html', alternatives: [] };

function harness(paths: TerminalPathsAtPoint | null) {
  const opened: TerminalPathTarget[] = [];
  const asked: Array<[number, number]> = [];
  return {
    opened,
    asked,
    deps: {
      pathsAt: (x: number, y: number) => {
        asked.push([x, y]);
        return paths;
      },
      open: (target: TerminalPathTarget) => { opened.push(target); },
    },
  };
}

afterEach(() => mobileModifierLatch.resetForTests());

test('FR-ARCH-013 AC-10: a tap with Ctrl latched once opens the path near the tap and spends the latch', () => {
  mobileModifierLatch.tap('ctrl');
  const h = harness({ near, screen: [near] });

  assert.equal(openPathOnLatchedTap(45, 113, h.deps), true);
  assert.deepEqual(h.asked, [[45, 113]]);
  assert.deepEqual(h.opened, [near]);
  assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'off');
});

test('FR-ARCH-013 AC-10: a locked Ctrl opens the path and stays locked', () => {
  // A hold past LATCH_HOLD_MS locks the modifier.
  const press = mobileModifierLatch.startPress('ctrl');
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      press.release();
      assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked');
      const h = harness({ near, screen: [near] });
      assert.equal(openPathOnLatchedTap(10, 20, h.deps), true);
      assert.deepEqual(h.opened, [near]);
      assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'locked');
      resolve();
    }, 800);
  });
});

test('FR-ARCH-013 AC-6: without a Ctrl latch a tap opens nothing and is left to focus the terminal', () => {
  const h = harness({ near, screen: [near] });
  assert.equal(openPathOnLatchedTap(45, 113, h.deps), false);
  assert.deepEqual(h.opened, []);
});

test('FR-ARCH-013 AC-6: Alt or Shift alone does not open a path', () => {
  mobileModifierLatch.tap('alt');
  mobileModifierLatch.tap('shift');
  const h = harness({ near, screen: [near] });
  assert.equal(openPathOnLatchedTap(45, 113, h.deps), false);
  assert.deepEqual(h.opened, []);
  assert.equal(mobileModifierLatch.getSnapshot().alt, 'once');
});

test('FR-ARCH-013 AC-10: with Ctrl latched but no path near the tap, nothing opens and the latch stays', () => {
  mobileModifierLatch.tap('ctrl');
  for (const paths of [{ near: null, screen: [near] }, null]) {
    const h = harness(paths);
    assert.equal(openPathOnLatchedTap(45, 113, h.deps), false);
    assert.deepEqual(h.opened, []);
    assert.equal(mobileModifierLatch.getSnapshot().ctrl, 'once');
  }
});

test('FR-ARCH-013 AC-10: the terminal tap handler tries the latched open before focusing the terminal', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalRuntimeLayer.tsx', import.meta.url), 'utf8');
  const click = source.indexOf('onClickCapture=');
  assert.ok(click > 0, 'onClickCapture handler not found');
  const handler = source.slice(click, source.indexOf('onContextMenu=', click));
  const opened = handler.indexOf('openPathOnLatchedTap(');
  assert.ok(opened > 0, 'onClickCapture must call openPathOnLatchedTap');
  assert.ok(handler.indexOf('consumeTap()') < opened, 'the latched open runs only for a confirmed tap');
  assert.ok(opened < handler.indexOf('focusTerminal('), 'a latched open must come before the focus');
});

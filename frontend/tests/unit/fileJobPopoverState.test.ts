import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeFileJobPopover,
  isFileJobPopoverOpen,
  openFileJobPopover,
  subscribeFileJobPopover,
  toggleFileJobPopover,
} from '../../src/components/fileExplorer/fileJobPopoverState.ts';

// FR-FEX-008 AC-3/AC-7 — the popover's open state is one module value shared by
// the status bar (toggle), the explorer window's '외 N개' button (open) and the
// popover's outside press (close). Being a module value it survives between
// tests, so each case starts by closing it.

function counter(): { calls: () => number; stop: () => void } {
  let n = 0;
  const stop = subscribeFileJobPopover(() => { n += 1; });
  return { calls: () => n, stop };
}

test('TC-REQ-FR-FEX-008-AC3-61 open/close/toggle 이 같은 값을 바꾸고 getter 가 그 값을 돌려준다', () => {
  closeFileJobPopover();
  assert.equal(isFileJobPopoverOpen(), false);
  openFileJobPopover();
  assert.equal(isFileJobPopoverOpen(), true);
  toggleFileJobPopover();
  assert.equal(isFileJobPopoverOpen(), false);
  toggleFileJobPopover();
  assert.equal(isFileJobPopoverOpen(), true);
  closeFileJobPopover();
  assert.equal(isFileJobPopoverOpen(), false);
});

test('TC-REQ-FR-FEX-008-AC3-62 값이 바뀔 때만 구독자를 깨운다 — 반복된 close 는 렌더를 부르지 않는다', () => {
  closeFileJobPopover();
  const c = counter();
  closeFileJobPopover();
  closeFileJobPopover();
  assert.equal(c.calls(), 0, 'closing an already closed popover must not notify');
  openFileJobPopover();
  openFileJobPopover();
  assert.equal(c.calls(), 1, 'opening twice notifies once');
  toggleFileJobPopover();
  assert.equal(c.calls(), 2);
  c.stop();
});

test('TC-REQ-FR-FEX-008-AC3-63 구독 해제 뒤에는 알림이 오지 않고, 다른 구독자는 계속 받는다', () => {
  closeFileJobPopover();
  const a = counter();
  const b = counter();
  openFileJobPopover();
  a.stop();
  closeFileJobPopover();
  assert.equal(a.calls(), 1, 'an unsubscribed listener must not be called');
  assert.equal(b.calls(), 2);
  b.stop();
});

test('TC-REQ-FR-FEX-008-AC3-64 알림 중에 구독을 해제해도 그 회차의 나머지 구독자가 빠지지 않는다', () => {
  closeFileJobPopover();
  let later = 0;
  const stopFirst = subscribeFileJobPopover(() => { stopFirst(); });
  const stopLater = subscribeFileJobPopover(() => { later += 1; });
  openFileJobPopover();
  assert.equal(later, 1, 'a listener removed mid-notify must not make the next one skip');
  stopLater();
  closeFileJobPopover();
});

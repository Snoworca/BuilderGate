// FR-FEX-032: holding an explorer row picks it up; the picked entries follow the pointer and
// drop on a folder. The decisions are pure; the driver is run here on a jsdom document with a
// stand-in hit test (jsdom has no layout).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  PICK_EVENT,
  PICK_HOLD_MS,
  PICK_SLOP_PX,
  autoScrollDelta,
  decidePickRelease,
  hiddenRowsCss,
  startPick,
  type PickDropDetail,
  type PickLeaveDetail,
  type PickOverDetail,
} from '../../src/components/fileExplorer/fileExplorerPickUp.ts';

// @req FR-FEX-032
test('FR-FEX-032 AC-1: the hold is 0.45 s and the slop 10 px', () => {
  assert.equal(PICK_HOLD_MS, 450);
  assert.equal(PICK_SLOP_PX, 10);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-3/AC-5: a moved release drops; in place a touch opens the menu and a mouse puts it back', () => {
  assert.equal(decidePickRelease({ touch: false, moved: true }), 'drop');
  assert.equal(decidePickRelease({ touch: true, moved: true }), 'drop');
  assert.equal(decidePickRelease({ touch: true, moved: false }), 'menu');
  assert.equal(decidePickRelease({ touch: false, moved: false }), 'cancel');
});

// @req FR-FEX-032
test('FR-FEX-032 AC-4: near the top or bottom edge of the list the list scrolls', () => {
  const rect = { top: 100, bottom: 500 };
  assert.equal(autoScrollDelta(300, rect), 0);
  assert.ok(autoScrollDelta(105, rect) < 0, 'near the top scrolls up');
  assert.ok(autoScrollDelta(495, rect) > 0, 'near the bottom scrolls down');
  assert.ok(Math.abs(autoScrollDelta(101, rect)) > Math.abs(autoScrollDelta(130, rect)), 'faster at the edge');
  assert.equal(autoScrollDelta(50, rect), 0, 'outside the list nothing scrolls');
});

// @req FR-FEX-032
test('FR-FEX-032 AC-1: the carried rows and the rows inside a carried folder leave the list', () => {
  const dom = new JSDOM('<div class="fx-scroll"><div data-path="a/b"></div><div data-path="a/b/c"></div><div data-path="a\\b\\d"></div><div data-path="a/bc"></div><div data-path="x"></div></div>');
  const doc = dom.window.document;
  const style = doc.createElement('style');
  style.textContent = hiddenRowsCss(['a/b', 'x'], (s) => dom.window.CSS?.escape?.(s) ?? s.replace(/["\\]/g, '\\$&'), '.fx-scroll');
  doc.head.appendChild(style);
  const hidden = [...doc.querySelectorAll('[data-path]')]
    .filter((el) => [...doc.querySelectorAll(style.textContent!.split('{')[0])].includes(el))
    .map((el) => el.getAttribute('data-path'));
  assert.deepEqual(hidden.sort(), ['a/b', 'a/b/c', 'x'].sort());
  assert.match(style.textContent!, /display:\s*none/);
});

function setup() {
  const dom = new JSDOM('<!doctype html><html><body><div id="row" data-path="a.txt"></div><div id="dir" data-path="docs"></div><div id="out"></div></body></html>', { pretendToBeVisual: true });
  const win = dom.window as unknown as Window;
  const doc = win.document;
  let under: Element | null = doc.getElementById('row');
  const events: string[] = [];
  for (const id of ['row', 'dir', 'out']) {
    const el = doc.getElementById(id)!;
    el.addEventListener(PICK_EVENT.over, (e) => events.push(`over:${id}:${(e as CustomEvent<PickOverDetail>).detail.keys.ctrlKey ? 'ctrl' : '-'}`));
    el.addEventListener(PICK_EVENT.leave, (e) => events.push(`leave:${id}->${(e as CustomEvent<PickLeaveDetail>).detail.next?.id ?? 'null'}`));
  }
  doc.getElementById('dir')!.addEventListener(PICK_EVENT.drop, (e) => {
    const detail = (e as CustomEvent<PickDropDetail>).detail;
    detail.handled = true;
    events.push(`drop:dir:${detail.keys.ctrlKey ? 'ctrl' : '-'}`);
  });
  const pointer = (type: string, x: number, y: number, init: Record<string, unknown> = {}) =>
    win.dispatchEvent(new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: type === 'pointermove' ? 1 : 0, ...init }));
  // jsdom has no Touch constructor; a phone's touch events carry these lists.
  // Touch events go to the element the finger went down on, even once it left the DOM.
  const fingerRow = doc.getElementById('row')!;
  const finger = (type: string, x: number, y: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    const list = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
    Object.defineProperty(event, 'touches', { value: list });
    Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    fingerRow.dispatchEvent(event);
    return event;
  };
  return {
    dom, win, doc, events, pointer, finger,
    setUnder: (id: string | null) => { under = id === null ? null : doc.getElementById(id); },
    hitTest: () => under,
  };
}

// @req FR-FEX-032
test('FR-FEX-032 AC-1/AC-2/AC-3: the ghost follows the pointer, targets hear over and leave, a release drops', () => {
  const s = setup();
  const releases: string[] = [];
  let ended = 0;
  startPick({
    doc: s.doc, win: s.win, start: { x: 10, y: 10 }, label: 'a.txt', hitTest: s.hitTest,
    onRelease: (kind) => releases.push(kind), onEnd: () => { ended += 1; },
  });
  const ghost = s.doc.querySelector('.fx-pick-ghost') as HTMLElement | null;
  assert.ok(ghost !== null, 'a card is shown');
  assert.equal(ghost.textContent, 'a.txt');
  s.setUnder('dir');
  s.pointer('pointermove', 60, 80, { ctrlKey: true });
  assert.match(ghost.style.transform, /60px.*80px|translate\(\s*\d/);
  s.pointer('pointerup', 60, 80, { ctrlKey: true });
  assert.deepEqual(s.events, ['over:dir:ctrl', 'drop:dir:ctrl', 'leave:dir->null']);
  assert.deepEqual(releases, ['drop']);
  assert.equal(ended, 1);
  assert.equal(s.doc.querySelector('.fx-pick-ghost'), null, 'the card is gone');
  // Listeners are gone: a later move dispatches nothing.
  s.pointer('pointermove', 70, 90);
  assert.equal(s.events.length, 3);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-2: moving from one target to another leaves the first', () => {
  const s = setup();
  const session = startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, label: 'x', hitTest: s.hitTest, onRelease: () => {}, onEnd: () => {} });
  s.setUnder('out');
  s.pointer('pointermove', 30, 30);
  s.setUnder('dir');
  s.pointer('pointermove', 40, 40);
  s.pointer('pointermove', 41, 41);
  assert.deepEqual(s.events, ['over:out:-', 'leave:out->dir', 'over:dir:-', 'over:dir:-']);
  session.stop();
});

// @req FR-FEX-032
test('FR-FEX-032 AC-5: a touch released in place asks for the menu; a mouse one puts it back', () => {
  for (const touch of [true, false]) {
    const s = setup();
    const releases: string[] = [];
    startPick({ doc: s.doc, win: s.win, start: { x: 20, y: 20 }, touchTarget: touch ? s.doc.getElementById('row')! : undefined, label: 'x', hitTest: s.hitTest, onRelease: (kind) => releases.push(kind), onEnd: () => {} });
    if (touch) {
      s.finger('touchmove', 24, 23);
      s.finger('touchend', 24, 23);
    } else {
      s.pointer('pointermove', 24, 23);
      s.pointer('pointerup', 24, 23);
    }
    assert.deepEqual(releases, [touch ? 'menu' : 'cancel']);
    assert.ok(!s.events.some((e) => e.startsWith('drop')), 'no drop');
  }
});

// @req FR-FEX-032
test('FR-FEX-032 AC-3: Escape and a cancelled pointer put the entries back without a drop', () => {
  for (const how of ['escape', 'pointercancel'] as const) {
    const s = setup();
    const releases: string[] = [];
    let ended = 0;
    startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, label: 'x', hitTest: s.hitTest, onRelease: (kind) => releases.push(kind), onEnd: () => { ended += 1; } });
    s.setUnder('dir');
    s.pointer('pointermove', 50, 50);
    if (how === 'escape') s.win.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    else s.pointer('pointercancel', 50, 50);
    assert.deepEqual(releases, ['cancel'], how);
    assert.equal(ended, 1, how);
    assert.ok(!s.events.some((e) => e.startsWith('drop')), how);
    assert.equal(s.events.at(-1), 'leave:dir->null', `${how}: the target is told to clear`);
  }
});

// @req FR-FEX-032
test('FR-FEX-032 AC-2: pressing or releasing the copy key re-asks the target under the pointer', () => {
  const s = setup();
  const session = startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, label: 'x', hitTest: s.hitTest, onRelease: () => {}, onEnd: () => {} });
  s.setUnder('dir');
  s.pointer('pointermove', 50, 50);
  s.win.dispatchEvent(new s.dom.window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
  assert.deepEqual(s.events, ['over:dir:-', 'over:dir:ctrl']);
  session.stop();
});

// @req FR-FEX-032
test('FR-FEX-032 AC-4/AC-1: while picked a touch does not scroll the page, the browser menu is held back and the release click is swallowed', () => {
  const s = setup();
  const releases: string[] = [];
  const session = startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, touchTarget: s.doc.getElementById('row')!, label: 'x', hitTest: s.hitTest, onRelease: (kind) => releases.push(kind), onEnd: () => {} });
  s.setUnder('dir');
  const move = s.finger('touchmove', 40, 40);
  assert.equal(move.defaultPrevented, true, 'touchmove is cancelled');
  assert.deepEqual(s.events, ['over:dir:-'], 'the finger moves the pick');
  const menu = new s.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  let heard = false;
  s.doc.getElementById('row')!.addEventListener('contextmenu', () => { heard = true; });
  s.doc.getElementById('row')!.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
  assert.equal(heard, false, 'the views do not open their menu during the pick');
  s.finger('touchend', 40, 40);
  assert.deepEqual(releases, ['drop'], 'the finger lifted over the folder drops');
  const click = new s.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  let clicked = false;
  s.doc.getElementById('dir')!.addEventListener('click', () => { clicked = true; });
  s.doc.getElementById('dir')!.dispatchEvent(click);
  assert.equal(clicked, false, 'the click the release makes selects nothing');
  const after = new s.dom.window.Event('touchmove', { bubbles: true, cancelable: true });
  s.doc.getElementById('row')!.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false, 'after the pick a touch scrolls again');
  session.stop(); // idempotent
});

// @req FR-FEX-032
test('FR-FEX-032 AC-1: only the picking panel hides its rows; another explorer showing the same path keeps them', () => {
  const css = hiddenRowsCss(['a.txt'], (v) => v, '.fx-scroll[data-fx-tab="t1"]');
  assert.match(css, /^\.fx-scroll\[data-fx-tab="t1"\] \[data-path="a\.txt"\]/);
  assert.doesNotMatch(css, /(^|, )\.fx-scroll \[/, 'no unscoped selector');
});

// @req FR-FEX-032
test('FR-FEX-032 AC-3: a finger whose row left the DOM (a folder opened under it) still moves and ends the pick', () => {
  const s = setup();
  const releases: string[] = [];
  const row = s.doc.getElementById('row')!;
  startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, touchTarget: row, label: 'x', hitTest: s.hitTest, onRelease: (kind) => releases.push(kind), onEnd: () => {} });
  row.remove();
  s.setUnder('dir');
  const move = s.finger('touchmove', 40, 40);
  assert.equal(move.defaultPrevented, true);
  s.finger('touchend', 40, 40);
  assert.deepEqual(releases, ['drop']);
});

// @req FR-FEX-032
test('FR-FEX-032 AC-3: a mouse pick whose button came up unseen (another window, a blur) ends as a cancel', () => {
  for (const how of ['buttons', 'blur'] as const) {
    const s = setup();
    const releases: string[] = [];
    startPick({ doc: s.doc, win: s.win, start: { x: 0, y: 0 }, label: 'x', hitTest: s.hitTest, onRelease: (kind) => releases.push(kind), onEnd: () => {} });
    s.setUnder('dir');
    s.pointer('pointermove', 50, 50, { buttons: 1 });
    if (how === 'buttons') s.pointer('pointermove', 60, 60, { buttons: 0 });
    else s.win.dispatchEvent(new s.dom.window.Event('blur'));
    assert.deepEqual(releases, ['cancel'], how);
    assert.ok(!s.events.some((e) => e.startsWith('drop')), how);
  }
});

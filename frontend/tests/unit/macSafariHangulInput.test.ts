// FR-BGSTAB-036: Hangul typed in desktop Safari reaches the terminal without dropped or split jamo.
//
// Measured on macOS Safari 26.5 (2026-10-30) with a probe page: the macOS Korean IME fires no
// composition events. The first jamo of a syllable is an insertText, every later jamo replaces
// the syllable with insertReplacementText, and the input events arrive before their keyCode 229
// keydown. xterm.js 6.0.0 ignores insertReplacementText, and ignores an insertText while a key
// is held, so 안녕하세요 reached the PTY as ㅇㄴㅎ세요 and fast typing lost whole syllable starts.
//
// The xterm model below follows xterm 6.0.0 (CoreBrowserTerminal._keyDown / _keyUp /
// _inputEvent and CompositionHelper._handleAnyTextareaChanges): it sends a non-229 key from
// keydown, an insertText only while no key is held, and after a keyCode 229 keydown whatever
// the textarea changed by the next tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIosHangulInput } from '../../src/utils/iosHangulInput.ts';

const DEL = '\x7f';

function harness() {
  const sent: string[] = [];
  const textarea = { value: '' };
  const timers: Array<() => void> = [];
  const input = createIosHangulInput({
    send: (data) => sent.push(data),
    textarea: () => textarea,
    schedule: (callback) => { timers.push(callback); },
  });
  let xtermKeyDownSeen = false;
  const xtermSend = (data: string) => {
    sent.push(data);
    input.noteSentInput(data);
  };
  const keyEvent = (type: string, key: string, keyCode: number) => ({
    type, key, keyCode, isComposing: false, ctrlKey: false, altKey: false, metaKey: false,
  });

  const keydown = (key: string, keyCode = 229) => {
    xtermKeyDownSeen = true;
    if (!input.handleKey(keyEvent('keydown', key, keyCode))) return;
    if (keyCode === 229) {
      const oldValue = textarea.value;
      timers.push(() => {
        const newValue = textarea.value;
        if (newValue.length > oldValue.length) xtermSend(newValue.replace(oldValue, ''));
        else if (newValue.length < oldValue.length) xtermSend(DEL);
        else if (newValue !== oldValue) xtermSend(newValue);
      });
    } else if (key === 'Backspace') {
      xtermSend(DEL);
    } else if (key === 'Enter') {
      textarea.value = '';
      xtermSend('\r');
    } else if (key.length === 1) {
      xtermSend(key);
    }
  };
  const keyup = (key: string, keyCode = 0) => {
    xtermKeyDownSeen = false;
    input.handleKey(keyEvent('keyup', key, keyCode));
  };
  // A textarea change: beforeinput, the change, then xterm's input listener and the view's.
  const edit = (inputType: string, value: string, data: string | null = null, composing = false) => {
    input.handleBeforeInput();
    textarea.value = value;
    if (inputType === 'insertText' && data && !xtermKeyDownSeen) xtermSend(data);
    input.handleInput(composing, inputType);
  };
  const tick = () => {
    while (timers.length > 0) timers.shift()!();
  };
  // One macOS key as measured: its textarea change first, then keydown 229 and the next tick.
  const stroke = (key: string, change: () => void, release = true) => {
    change();
    keydown(key);
    tick();
    if (release) keyup(key);
  };
  return { sent, textarea, keydown, keyup, edit, tick, stroke };
}

/** The line a shell builds from the sent data: DEL removes the last character. */
function lineOf(sent: readonly string[]): string {
  const line: string[] = [];
  for (const ch of Array.from(sent.join(''))) {
    if (ch === DEL) line.pop();
    else line.push(ch);
  }
  return line.join('');
}

test('FR-BGSTAB-036 AC-1: the measured macOS Safari 안녕하세요, with 요 typed while ㅇ was held, builds 안녕하세요', () => {
  const h = harness();
  const replace = (value: string) => () => h.edit('insertReplacementText', value, value.slice(-1));
  const insert = (value: string, data: string) => () => h.edit('insertText', value, data);

  h.stroke('ㅇ', insert('ㅇ', 'ㅇ'));
  h.stroke('ㅏ', replace('아'));
  h.stroke('ㄴ', replace('안'));
  replace('안')();
  h.stroke('ㄴ', insert('안ㄴ', 'ㄴ'));
  h.stroke('ㅕ', replace('안녀'));
  h.stroke('ㅇ', replace('안녕'));
  replace('안녕')();
  h.stroke('ㅎ', insert('안녕ㅎ', 'ㅎ'), false);
  h.stroke('ㅏ', replace('안녕하'), false);
  h.keyup('ㅎ');
  h.keyup('ㅏ');
  h.stroke('ㅅ', replace('안녕핫'));
  replace('안녕하')();
  h.stroke('ㅔ', insert('안녕하세', '세'));
  h.stroke('ㅇ', replace('안녕하셍'), false);
  replace('안녕하세')();
  // ㅇ is still held: xterm ignores this insertText.
  h.stroke('ㅛ', insert('안녕하세요', '요'), false);
  h.keyup('ㅇ');
  h.keyup('ㅛ');
  replace('안녕하세요')();

  assert.deepEqual(h.sent.slice(0, 4), ['ㅇ', `${DEL}아`, `${DEL}안`, 'ㄴ']);
  assert.equal(lineOf(h.sent), '안녕하세요');
});

test('FR-BGSTAB-036 AC-1: 가 then 아 typed while ㅇ was held builds 가아', () => {
  const h = harness();
  h.stroke('ㄱ', () => h.edit('insertText', 'ㄱ', 'ㄱ'));
  h.stroke('ㅏ', () => h.edit('insertReplacementText', '가', '가'));
  h.stroke('ㅇ', () => h.edit('insertReplacementText', '강', '강'), false);
  h.edit('insertReplacementText', '가', '가');
  h.stroke('ㅏ', () => h.edit('insertText', '가아', '아'), false);
  h.keyup('ㅇ');
  h.keyup('ㅏ');
  h.edit('insertReplacementText', '가아', '아');
  assert.equal(lineOf(h.sent), '가아');
});

test('FR-BGSTAB-036 AC-2: a replacement that changes nothing sends nothing', () => {
  const h = harness();
  h.stroke('ㅇ', () => h.edit('insertText', 'ㅇ', 'ㅇ'));
  h.stroke('ㅏ', () => h.edit('insertReplacementText', '아', '아'));
  const before = h.sent.length;
  h.edit('insertReplacementText', '아', '아');
  assert.equal(h.sent.length, before);
});

test('FR-BGSTAB-036 AC-3: a Backspace the IME handles is sent as its replacement', () => {
  const h = harness();
  h.stroke('ㄱ', () => h.edit('insertText', 'ㄱ', 'ㄱ'));
  h.stroke('ㅏ', () => h.edit('insertReplacementText', '가', '가'));
  h.stroke('ㄱ', () => h.edit('insertReplacementText', '각', '각'));
  h.sent.length = 0;
  h.stroke('Backspace', () => h.edit('insertReplacementText', '가', '가'));
  assert.deepEqual(h.sent, [`${DEL}가`]);
});

test('FR-BGSTAB-036 AC-4: an insertText while no key is held is sent once, by xterm', () => {
  const h = harness();
  h.edit('insertText', 'x', 'x');
  assert.deepEqual(h.sent, ['x']);
});

test('FR-BGSTAB-036 AC-5: the iPhone space, inserted into the textarea after xterm sent it, is not sent again', () => {
  const h = harness();
  h.keydown(' ', 32);
  h.edit('insertText', ' ', ' ');
  h.keyup(' ', 32);
  assert.deepEqual(h.sent, [' ']);
});

test('FR-BGSTAB-036 AC-6: a change right after a keyCode 229 keydown is sent once, by xterm', () => {
  const h = harness();
  h.edit('insertText', 'ab', 'ab');
  h.sent.length = 0;
  // Android: keydown 229, then the IME deletes, before the next tick.
  h.keydown('Unidentified', 229);
  h.edit('deleteContentBackward', 'a');
  h.tick();
  h.keyup('Unidentified', 229);
  assert.deepEqual(h.sent, [DEL]);
});

test('FR-BGSTAB-036 AC-7: a composition change is left to xterm\'s composition path', () => {
  const h = harness();
  h.keydown('Process', 229);
  h.tick();
  h.edit('insertCompositionText', '가', '가', true);
  h.keyup('Process', 229);
  assert.deepEqual(h.sent, []);
});

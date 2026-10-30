// FR-BGSTAB-037: dictation that rewrites its own text reaches the terminal once.
//
// Measured on iOS 18.7 Safari (2026-10-30) with a probe page: each time dictation refines its
// result it selects all the text it has inserted so far and inserts the whole new hypothesis
// with insertText. xterm.js 6.0.0 sends the data of every insertText while no key is held and
// never removes the selection, so the PTY got 안 + 안녕하 + 안녕하세요 + ...
//
// The model dispatches an input event as the browser does: the view's capture listener on an
// ancestor first (interceptInput), then, unless that kept the event, xterm's textarea listener
// (an insertText while no key is held is sent) and the view's own input listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIosHangulInput } from '../../src/utils/iosHangulInput.ts';

const DEL = '\x7f';

function harness() {
  const sent: string[] = [];
  const textarea = { value: '', selectionStart: 0, selectionEnd: 0 };
  const input = createIosHangulInput({
    send: (data) => sent.push(data),
    textarea: () => textarea,
    schedule: () => {},
  });
  let xtermReached = 0;
  // An insertText (or other change) that replaces textarea[start, end) with `data`.
  const insert = (data: string, start: number, end: number, inputType = 'insertText') => {
    textarea.selectionStart = start;
    textarea.selectionEnd = end;
    input.handleBeforeInput();
    textarea.value = textarea.value.slice(0, start) + data + textarea.value.slice(end);
    textarea.selectionStart = start + data.length;
    textarea.selectionEnd = textarea.selectionStart;
    if (input.interceptInput(false, inputType)) return;
    xtermReached += 1;
    if (inputType === 'insertText' && data) {
      sent.push(data);
      input.noteSentInput(data);
    }
    input.handleInput(false, inputType);
  };
  return { sent, textarea, insert, xtermReached: () => xtermReached };
}

function lineOf(sent: readonly string[]): string {
  const line: string[] = [];
  for (const ch of Array.from(sent.join(''))) {
    if (ch === DEL) line.pop();
    else line.push(ch);
  }
  return line.join('');
}

// What the dictation did in the terminal's textarea (measured): each hypothesis over the last.
const HYPOTHESES = [
  '안',
  '안녕하',
  '안녕하세요',
  '안녕하세요 오늘',
  '안녕하세요 오늘 날씨',
  '안녕하세요. 오늘 날씨가',
  '안녕하세요. 오늘 날씨가좋',
  '안녕하세요. 오늘 날씨가 좋네요.',
  '안녕하세요. 오늘 날씨가 좋네요.',
];

function dictate(h: ReturnType<typeof harness>, hypotheses: readonly string[]) {
  let previous = '';
  for (const text of hypotheses) {
    h.insert(text, 0, Array.from(previous).length);
    previous = text;
  }
}

test('FR-BGSTAB-037 AC-1: the measured dictation builds the final text once', () => {
  const h = harness();
  dictate(h, HYPOTHESES);
  assert.deepEqual(h.sent.slice(0, 4), ['안', '녕하', '세요', ' 오늘']);
  assert.equal(lineOf(h.sent), '안녕하세요. 오늘 날씨가 좋네요.');
});

test('FR-BGSTAB-037 AC-1: the dictation\'s final tidy-up (a typeless change, then spaces and words) keeps the line', () => {
  // Measured in a plain textarea: the final result replaced the text with 안녕하세요., then the
  // rest came back word by word with insertText, and a last typeless change completed it.
  const h = harness();
  dictate(h, HYPOTHESES.slice(0, 8));
  const full = '안녕하세요. 오늘 날씨가 좋네요.';
  h.insert('안녕하세요.', 0, Array.from(full).length, '');
  for (const word of [' ', '오늘', ' ', '날씨가', ' ']) h.insert(word, h.textarea.value.length, h.textarea.value.length);
  h.insert('좋네요.', h.textarea.value.length, h.textarea.value.length, '');
  assert.equal(h.textarea.value, full);
  assert.equal(lineOf(h.sent), full);
});

test('FR-BGSTAB-037 AC-2: a rewrite of earlier text deletes back to the common start and retypes', () => {
  const h = harness();
  dictate(h, HYPOTHESES.slice(0, 5));
  h.sent.length = 0;
  h.insert('안녕하세요. 오늘 날씨가', 0, Array.from('안녕하세요 오늘 날씨').length);
  assert.deepEqual(h.sent, [`${DEL.repeat(6)}. 오늘 날씨가`]);
});

test('FR-BGSTAB-037 AC-3: a rewrite to the same text sends nothing', () => {
  const h = harness();
  dictate(h, ['안녕']);
  h.sent.length = 0;
  h.insert('안녕', 0, 2);
  assert.deepEqual(h.sent, []);
});

test('FR-BGSTAB-037 AC-4: an insertText over a selection never reaches xterm', () => {
  const h = harness();
  dictate(h, HYPOTHESES);
  assert.equal(h.xtermReached(), 1, 'only the first insertText, with nothing selected, reached xterm');
});

test('FR-BGSTAB-037 AC-5: an insertText with nothing selected is xterm\'s, sent once', () => {
  const h = harness();
  h.insert('x', 0, 0);
  h.insert('y', 1, 1);
  assert.deepEqual(h.sent, ['x', 'y']);
  assert.equal(h.xtermReached(), 2);
});

test('FR-BGSTAB-037 AC-5: a composition change is never kept from xterm', () => {
  const sent: string[] = [];
  const textarea = { value: 'ab', selectionStart: 0, selectionEnd: 2 };
  const input = createIosHangulInput({ send: (data) => sent.push(data), textarea: () => textarea, schedule: () => {} });
  input.handleBeforeInput();
  textarea.value = '가';
  assert.equal(input.interceptInput(true, 'insertCompositionText'), false);
  assert.equal(input.interceptInput(true, 'insertText'), false);
  assert.deepEqual(sent, []);
});

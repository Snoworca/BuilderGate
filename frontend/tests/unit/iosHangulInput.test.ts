// FR-MKB-015: Hangul typed on the iPhone keyboard reaches the terminal as composed syllables.
//
// The traces below were measured on iOS 18.7 Safari (2026-10-29) with a probe page. The iOS
// Korean keyboard fires no composition events: every jamo is a keydown (keyCode 0) and a
// keypress (keyCode = the jamo's code point), and joining it to the character before is a
// deleteContentBackward followed by an insertText of the joined syllable(s). xterm.js sends
// the keypress jamo and ignores both textarea edits, so the PTY got ㅇㅏㄴㄴㅕㅇ.
//
// The keyboard also keeps its own Hangul state: a Backspace that xterm sent left it holding
// a syllable the terminal had deleted (가, Backspace, 나 gave 가나 on 2222). A Backspace is
// therefore left to the keyboard while the textarea holds Hangul. What the keyboard does with
// it is the keyboard's business; the tests model it as the textarea edits it makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIosHangulInput,
  isHangulJamoKeystroke,
  type HangulKeyEventLike,
} from '../../src/utils/iosHangulInput.ts';

const DEL = '\x7f';

type Edit = ['del'] | ['ins', string];

interface Keystroke {
  key: string;
  edits: Edit[];
}

// What the iOS keyboard did for each key while typing 안녕하세요 (measured).
const ANNYEONGHASEYO: Keystroke[] = [
  { key: 'ㅇ', edits: [['ins', 'ㅇ']] },
  { key: 'ㅏ', edits: [['del'], ['ins', '아']] },
  { key: 'ㄴ', edits: [['del'], ['ins', '안']] },
  { key: 'ㄴ', edits: [['ins', 'ㄴ']] },
  { key: 'ㅕ', edits: [['del'], ['ins', '녀']] },
  { key: 'ㅇ', edits: [['del'], ['ins', '녕']] },
  { key: 'ㅎ', edits: [['ins', 'ㅎ']] },
  { key: 'ㅏ', edits: [['del'], ['ins', '하']] },
  { key: 'ㅅ', edits: [['del'], ['ins', '핫']] },
  { key: 'ㅔ', edits: [['del'], ['ins', '하세']] },
  { key: 'ㅇ', edits: [['del'], ['ins', '셍']] },
  { key: 'ㅛ', edits: [['del'], ['ins', '세요']] },
];

function keyEvent(type: string, key: string, init: Partial<HangulKeyEventLike> = {}): HangulKeyEventLike {
  return {
    type,
    key,
    keyCode: type === 'keypress' && key.length === 1 ? key.codePointAt(0)! : 0,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  };
}

function harness() {
  const sent: string[] = [];
  const textarea = { value: '' };
  const input = createIosHangulInput({ send: (data) => sent.push(data), textarea: () => textarea });
  // One iOS keystroke: keydown, keypress, the textarea edits, keyup. A keypress the module
  // lets through is sent by xterm, as xterm does.
  const edit = (edits: Edit[]) => {
    for (const change of edits) {
      if (change[0] === 'del') textarea.value = Array.from(textarea.value).slice(0, -1).join('');
      else textarea.value += change[1];
      input.handleInput();
    }
  };
  const type = (stroke: Keystroke) => {
    const passed = { keydown: input.handleKey(keyEvent('keydown', stroke.key)), keypress: false };
    passed.keypress = input.handleKey(keyEvent('keypress', stroke.key));
    if (passed.keypress) sent.push(stroke.key);
    edit(stroke.edits);
    input.handleKey(keyEvent('keyup', stroke.key));
    return passed;
  };
  // A Backspace xterm handles is a DEL that onData reports back; one the view leaves to the
  // keyboard is the keyboard's textarea edits.
  const backspace = (edits: Edit[]) => {
    const toXterm = input.handleKey(keyEvent('keydown', 'Backspace', { keyCode: 8 }));
    if (toXterm) {
      sent.push(DEL);
      input.noteSentInput(DEL);
    } else {
      edit(edits);
    }
    input.handleKey(keyEvent('keyup', 'Backspace', { keyCode: 8 }));
    return toXterm;
  };
  return { sent, textarea, input, type, backspace };
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

test('FR-MKB-015 AC-1: the measured 안녕하세요 keystrokes send the textarea edits and build 안녕하세요', () => {
  const { sent, type } = harness();
  for (const stroke of ANNYEONGHASEYO) {
    const passed = type(stroke);
    assert.equal(passed.keydown, false, `xterm does not handle the keydown of ${stroke.key}`);
    assert.equal(passed.keypress, false, `xterm does not send the keypress jamo ${stroke.key}`);
  }
  assert.deepEqual(sent.slice(0, 6), ['ㅇ', DEL, '아', DEL, '안', 'ㄴ']);
  assert.equal(lineOf(sent), '안녕하세요');
});

test('FR-MKB-015 AC-2: one delete followed by two syllables sends DEL and both syllables', () => {
  const { sent, type } = harness();
  for (const stroke of ANNYEONGHASEYO.slice(6, 9)) type(stroke);
  sent.length = 0;
  type({ key: 'ㅔ', edits: [['del'], ['ins', '하세']] });
  assert.deepEqual(sent, [DEL, '하세']);
});

test('FR-MKB-015 AC-3: a Backspace after 각 is left to the keyboard and its 가 is sent', () => {
  const { sent, type, backspace } = harness();
  type({ key: 'ㄱ', edits: [['ins', 'ㄱ']] });
  type({ key: 'ㅏ', edits: [['del'], ['ins', '가']] });
  type({ key: 'ㄱ', edits: [['del'], ['ins', '각']] });
  sent.length = 0;
  assert.equal(backspace([['del'], ['ins', '가']]), false, 'xterm does not handle the Backspace');
  assert.deepEqual(sent, [DEL, '가']);
});

test('FR-MKB-015 AC-3: 가, Backspace until empty, then ㄴ ㅏ builds 나', () => {
  const { sent, textarea, type, backspace } = harness();
  type({ key: 'ㄱ', edits: [['ins', 'ㄱ']] });
  type({ key: 'ㅏ', edits: [['del'], ['ins', '가']] });
  assert.equal(backspace([['del'], ['ins', 'ㄱ']]), false);
  assert.equal(backspace([['del']]), false);
  assert.equal(textarea.value, '');
  assert.equal(backspace([]), true, 'with nothing typed this way left, xterm sends the Backspace');
  type({ key: 'ㄴ', edits: [['ins', 'ㄴ']] });
  type({ key: 'ㅏ', edits: [['del'], ['ins', '나']] });
  assert.equal(lineOf(sent.slice(sent.indexOf('ㄴ'))), '나');
  assert.deepEqual(sent.slice(0, 7), ['ㄱ', DEL, '가', DEL, 'ㄱ', DEL, DEL]);
});

test('FR-MKB-015 AC-2: a change of any input type is sent as removed and added characters', () => {
  const { sent, textarea, input, type } = harness();
  for (const stroke of ANNYEONGHASEYO.slice(0, 6)) type(stroke);
  sent.length = 0;
  input.handleKey(keyEvent('keydown', 'ㅑ'));
  input.handleKey(keyEvent('keypress', 'ㅑ'));
  textarea.value = '안냥';
  input.handleInput();
  input.handleKey(keyEvent('keyup', 'ㅑ'));
  // One input event is one change, sent in one piece.
  assert.deepEqual(sent, [`${DEL}냥`]);
});

test('FR-MKB-015 AC-4: a DEL from xterm removes one character of the textarea, not all of it', () => {
  const { textarea, input, type } = harness();
  for (const stroke of ANNYEONGHASEYO.slice(0, 6)) type(stroke);
  assert.equal(textarea.value, '안녕');
  input.noteSentInput(DEL);
  assert.equal(textarea.value, '안');
});

test('FR-MKB-015 AC-4: any other input sent while the textarea holds Hangul empties it', () => {
  for (const other of ['\r', 'a', ' ', '\x1b[D', '\x03', 'pasted text']) {
    const { textarea, input, type } = harness();
    type({ key: 'ㄱ', edits: [['ins', 'ㄱ']] });
    input.noteSentInput(other);
    assert.equal(textarea.value, '', `after ${JSON.stringify(other)}`);
  }
});

test('FR-MKB-015 AC-4: the module\'s own sends do not touch the textarea', () => {
  const textarea = { value: '' };
  const input = createIosHangulInput({
    // An xterm onData listener that reports every send back, as TerminalView does.
    send: (data) => input.noteSentInput(data),
    textarea: () => textarea,
  });
  input.handleKey(keyEvent('keydown', 'ㄱ'));
  input.handleKey(keyEvent('keypress', 'ㄱ'));
  textarea.value = 'ㄱ';
  input.handleInput();
  input.handleKey(keyEvent('keyup', 'ㄱ'));
  input.handleKey(keyEvent('keydown', 'ㅏ'));
  input.handleKey(keyEvent('keypress', 'ㅏ'));
  textarea.value = '';
  input.handleInput();
  textarea.value = '가';
  input.handleInput();
  input.handleKey(keyEvent('keyup', 'ㅏ'));
  assert.equal(textarea.value, '가');
});

test('FR-MKB-015 AC-5: a jamo keystroke with no textarea edit sends the jamo at keyup', () => {
  const { sent, type } = harness();
  type({ key: 'ㅋ', edits: [] });
  assert.deepEqual(sent, ['ㅋ']);
});

test('FR-MKB-015 AC-5: a Backspace left to the keyboard that changes nothing sends DEL and trims the textarea', () => {
  const { sent, textarea, type, backspace } = harness();
  type({ key: 'ㄱ', edits: [['ins', 'ㄱ']] });
  type({ key: 'ㅏ', edits: [['del'], ['ins', '가']] });
  sent.length = 0;
  assert.equal(backspace([]), false);
  assert.deepEqual(sent, [DEL]);
  assert.equal(textarea.value, '');
});

test('FR-MKB-015 AC-6: composition, modifier and non-jamo keys stay on the existing path', () => {
  const { input } = harness();
  const passes: Array<[string, HangulKeyEventLike]> = [
    ['keyCode 229', keyEvent('keydown', 'ㅇ', { keyCode: 229 })],
    ['isComposing', keyEvent('keydown', 'ㅇ', { isComposing: true })],
    ['ctrl', keyEvent('keydown', 'ㅇ', { ctrlKey: true })],
    ['alt', keyEvent('keydown', 'ㅇ', { altKey: true })],
    ['meta', keyEvent('keydown', 'ㅇ', { metaKey: true })],
    ['latin', keyEvent('keydown', 'a', { keyCode: 65 })],
    ['syllable', keyEvent('keydown', '가')],
    ['Process', keyEvent('keydown', 'Process', { keyCode: 229 })],
    ['Backspace', keyEvent('keydown', 'Backspace', { keyCode: 8 })],
  ];
  for (const [name, event] of passes) {
    assert.equal(isHangulJamoKeystroke(event), false, name);
    assert.equal(input.handleKey(event), true, `${name} keydown`);
    assert.equal(input.handleKey({ ...event, type: 'keypress' }), true, `${name} keypress`);
  }
});

test('FR-MKB-015 AC-6: input events outside a jamo keystroke send nothing', () => {
  const { sent, textarea, input } = harness();
  textarea.value = 'x';
  input.handleInput();
  textarea.value = '';
  input.handleInput();
  assert.deepEqual(sent, []);
});

test('FR-MKB-015 AC-6: a composition change inside a jamo keystroke is left to xterm\'s composition path', () => {
  // A hardware keyboard might open a composition after a keydown that is not keyCode 229;
  // xterm sends the composed text at compositionend, so sending it here too would double it.
  const { sent, textarea, input } = harness();
  input.handleKey(keyEvent('keydown', 'ㅇ'));
  input.handleKey(keyEvent('keypress', 'ㅇ'));
  textarea.value = 'ㅇ';
  input.handleInput(true);
  input.handleKey(keyEvent('keyup', 'ㅇ'));
  assert.deepEqual(sent, []);
});

test('FR-MKB-015 AC-6: the textarea is never edited while no Hangul has been typed this way', () => {
  const sent: string[] = [];
  const textarea = { value: 'composition text' };
  const input = createIosHangulInput({ send: (data) => sent.push(data), textarea: () => textarea });
  for (const other of [DEL, '\r', 'a']) input.noteSentInput(other);
  assert.equal(textarea.value, 'composition text');
});

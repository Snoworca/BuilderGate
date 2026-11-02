// FR-BGSTAB-038: Backspace on the last jamo of a Windows IME composition must not delete the
// character before it.
//
// Measured on Windows Chrome with the Microsoft Korean IME (2026-11-02, user probe on 2222):
// typing 아니 then Backspace twice left an empty line instead of 아. The second Backspace fires
//   keydown Process 229 (isComposing true) -> compositionupdate "" ->
//   beforeinput insertCompositionText "" -> input deleteContentBackward (isComposing FALSE,
//   value 아ㄴ -> 아) -> compositionend ""
// and the FR-BGSTAB-036 rule (send a textarea change outside a composition that xterm does not
// send) sent DEL for that input, a DEL for a ㄴ the PTY never received.
//
// The xterm model follows xterm 6.0.0 CompositionHelper: a keyCode 229 keydown outside a
// composition compares the textarea on the next tick unless a composition started by then, and
// compositionend sends, on the next tick, the textarea from the composition start (up to a new
// composition's start when one began).
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
  const xtermSend = (data: string) => {
    sent.push(data);
    input.noteSentInput(data);
  };
  let composing = false;
  let compositionStart = 0;
  const tick = () => {
    while (timers.length > 0) timers.shift()!();
  };
  const keyEvent = (type: string, key: string, keyCode: number, isComposing: boolean) => ({
    type, key, keyCode, isComposing, ctrlKey: false, altKey: false, metaKey: false,
  });
  const keydown229 = () => {
    input.handleKey(keyEvent('keydown', 'Process', 229, composing));
    if (!composing) {
      const oldValue = textarea.value;
      timers.push(() => {
        if (composing) return;
        const newValue = textarea.value;
        if (newValue.length > oldValue.length) xtermSend(newValue.replace(oldValue, ''));
        else if (newValue.length < oldValue.length) xtermSend(DEL);
        else if (newValue !== oldValue) xtermSend(newValue);
      });
    }
  };
  const keyup = (key: string) => input.handleKey(keyEvent('keyup', key, 229, composing));
  const compositionstart = () => {
    composing = true;
    compositionStart = textarea.value.length;
    input.handleComposition(true);
  };
  const compositionend = () => {
    composing = false;
    input.handleComposition(false);
    const start = compositionStart;
    timers.push(() => {
      const text = composing
        ? textarea.value.substring(start, compositionStart)
        : textarea.value.substring(start);
      if (text.length > 0) xtermSend(text);
    });
  };
  // beforeinput, the change, then the view's input listener (xterm ignores these input types).
  const change = (value: string, inputType: string, isComposing: boolean) => {
    input.handleBeforeInput();
    textarea.value = value;
    input.handleInput(isComposing || inputType.includes('Composition'), inputType);
  };
  return { sent, textarea, tick, keydown229, keyup, compositionstart, compositionend, change };
}

test('FR-BGSTAB-038 AC-1·AC-2: 아니, Backspace, Backspace leaves 아 and sends no DEL', () => {
  const h = harness();
  // ㅇ: the keydown comes before the composition starts.
  h.keydown229();
  h.compositionstart();
  h.change('ㅇ', 'insertCompositionText', true);
  h.tick();
  h.keyup('Process');
  // ㅏ, ㄴ
  h.keydown229(); h.change('아', 'insertCompositionText', true); h.tick(); h.keyup('Process');
  h.keydown229(); h.change('안', 'insertCompositionText', true); h.tick(); h.keyup('Process');
  // ㅣ: 아 is committed and 니 starts a new composition in the same task.
  h.keydown229();
  h.change('아', 'insertCompositionText', true);
  h.compositionend();
  h.compositionstart();
  h.change('아니', 'insertCompositionText', true);
  h.tick();
  h.keyup('Process');
  assert.deepEqual(h.sent, ['아']);
  // Backspace: 니 -> ㄴ.
  h.keydown229(); h.tick();
  h.change('아ㄴ', 'insertCompositionText', true);
  h.tick();
  h.keyup('Backspace');
  // Backspace: ㄴ removed by a deleteContentBackward that says it is not composing.
  h.keydown229(); h.tick();
  h.change('아', 'deleteContentBackward', false);
  h.compositionend();
  h.tick();
  h.keyup('Backspace');
  assert.deepEqual(h.sent, ['아'], 'only the committed 아 reaches the PTY');
  assert.equal(h.textarea.value, '아');
});

test('FR-BGSTAB-038 AC-3: with no composition events a textarea change is still sent (FR-BGSTAB-036)', () => {
  const h = harness();
  h.change('가', 'insertReplacementText', false);
  assert.deepEqual(h.sent, ['가']);
});

test('FR-BGSTAB-038 AC-1: after compositionend the FR-BGSTAB-036 rule applies again', () => {
  const h = harness();
  h.compositionstart();
  h.change('가', 'insertCompositionText', true);
  h.compositionend();
  h.tick();
  assert.deepEqual(h.sent, ['가']);
  h.change('', 'deleteContentBackward', false);
  assert.deepEqual(h.sent, ['가', DEL]);
});

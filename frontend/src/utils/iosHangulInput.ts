// The iOS Korean keyboard fires no composition events (measured on iOS 18.7 Safari,
// 2026-10-29). Each jamo is a keydown with keyCode 0 and a keypress whose charCode is
// the jamo, and joining it to the character before is a deleteContentBackward followed
// by an insertText of the joined syllable(s). xterm sends the keypress jamo and ignores
// both textarea edits, so 안녕 reached the PTY as ㅇㅏㄴㄴㅕㅇ. For such a keystroke the
// terminal sends how the textarea changed instead: a DEL for each character removed from
// the end, then the characters added.
//
// The keyboard joins a jamo to what it believes it is composing, and it keeps that belief
// itself. A Backspace that xterm sent never reached it, so 가, Backspace, 나 gave 가나 on
// 2222. While the textarea holds text typed this way, a Backspace is left to the keyboard
// and its change is sent like any other: the keyboard stays in step, and it removes the
// last jamo of a syllable it is composing (각 -> 가) as it does in any other app.
//
// Input that reaches the PTY by another path does not touch the textarea, so a DEL removes
// the textarea's last character and anything else empties it.
//
// The macOS Korean IME in Safari also fires no composition events (measured on Safari 26.5,
// 2026-10-30): the first jamo of a syllable is an insertText and every later jamo replaces
// the syllable with insertReplacementText, before the keyCode 229 keydown. xterm ignores
// insertReplacementText, and ignores an insertText while a key is held, so 안녕하세요
// became ㅇㄴㅎ세요 and fast typing lost whole syllable starts (FR-BGSTAB-036). Any textarea
// change outside a composition that xterm does not send is sent the same way, as the
// characters removed from the end and the characters added. What xterm sends is left to it:
// an insertText while no key is held, a key it sent from keydown (the iPhone space, which iOS
// still puts in the textarea), and the moment after a keyCode 229 keydown, when xterm
// compares the textarea itself.

export interface HangulKeyEventLike {
  type: string;
  key: string;
  keyCode: number;
  isComposing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface IosHangulInputOptions {
  /** Sends typed data to the terminal; TerminalView passes term.input. */
  send: (data: string) => void;
  textarea: () => { value: string; selectionStart?: number | null; selectionEnd?: number | null } | null;
  /** Runs a callback on the next tick; defaults to setTimeout(callback, 0), as xterm uses. */
  schedule?: (callback: () => void) => void;
}

export interface IosHangulInput {
  /** The custom key handler's answer: false when the key is not xterm's to handle. */
  handleKey: (event: HangulKeyEventLike) => boolean;
  /** A beforeinput event on the helper textarea, before the textarea changes. */
  handleBeforeInput: () => void;
  /** An input event on the helper textarea; `composing` when it belongs to a composition. */
  handleInput: (composing?: boolean, inputType?: string) => void;
  /** Data that reached the terminal by any path; keeps the textarea in step with it. */
  noteSentInput: (data: string) => void;
  /**
   * An input event, seen before xterm's listener: true when the view sends it and xterm must
   * not see it (an insertText that replaced a selection, as dictation does).
   */
  interceptInput: (composing: boolean, inputType: string) => boolean;
}

const DEL = '\x7f';
// Hangul Compatibility Jamo, the block the iOS keyboard puts in KeyboardEvent.key.
const JAMO_FIRST = 0x3131;
const JAMO_LAST = 0x318e;

function isHangulCompatibilityJamo(key: string): boolean {
  const code = key.length === 1 ? key.charCodeAt(0) : 0;
  return code >= JAMO_FIRST && code <= JAMO_LAST;
}

function isPlainKey(event: HangulKeyEventLike): boolean {
  return !event.isComposing && event.keyCode !== 229 && !event.ctrlKey && !event.altKey && !event.metaKey;
}

// @req FR-MKB-015
export function isHangulJamoKeystroke(event: HangulKeyEventLike): boolean {
  return isHangulCompatibilityJamo(event.key) && isPlainKey(event);
}

/** What turns `before` into `after` on a terminal line: DELs for the removed tail, then the added text. */
function lineChange(before: string, after: string): string {
  const from = Array.from(before);
  const to = Array.from(after);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  return DEL.repeat(from.length - common) + to.slice(common).join('');
}

function withoutLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join('');
}

// @req FR-MKB-015
export function createIosHangulInput(options: IosHangulInputOptions): IosHangulInput {
  // The key the keyboard is handling, and the textarea as the terminal last saw it.
  let keystroke: { key: string; changed: boolean } | null = null;
  let seen = '';
  // The textarea holds text typed this way, so other input has to keep it in step.
  let textareaHoldsHangul = false;
  let sending = false;
  // FR-BGSTAB-036: what xterm does with a textarea change. `keyHeld` follows xterm's
  // _keyDownSeen (set by any keydown, cleared by any keyup), `keySentByXterm` is a held key
  // xterm already sent, and `xtermComparing` is the tick after a keyCode 229 keydown.
  let keyHeld = false;
  let keySentByXterm = false;
  let xtermComparing = false;
  let beforeChange: string | null = null;
  // FR-BGSTAB-037: the textarea had a selection when the change began.
  let beforeSelected = false;
  const schedule = options.schedule ?? ((callback: () => void) => { setTimeout(callback, 0); });

  const send = (data: string) => {
    sending = true;
    try {
      options.send(data);
    } finally {
      sending = false;
    }
  };
  const textareaValue = () => options.textarea()?.value ?? '';

  return {
    handleKey(event) {
      if (event.type === 'keydown') {
        keyHeld = true;
        keySentByXterm = false;
        if (event.keyCode === 229) {
          xtermComparing = true;
          schedule(() => { xtermComparing = false; });
        }
        const backspace = event.key === 'Backspace' && isPlainKey(event)
          && textareaHoldsHangul && textareaValue().length > 0;
        keystroke = isHangulJamoKeystroke(event) || backspace ? { key: event.key, changed: false } : null;
        seen = textareaValue();
        return keystroke === null;
      }
      if (event.type === 'keypress') return keystroke === null;
      if (event.type === 'keyup') keyHeld = false;
      if (event.type === 'keyup' && keystroke !== null) {
        const unchanged = keystroke.changed ? null : keystroke.key;
        keystroke = null;
        if (unchanged === 'Backspace') {
          // The keyboard did nothing with it, so the terminal and the textarea both lose a character.
          const textarea = options.textarea();
          if (textarea) textarea.value = withoutLastCharacter(textarea.value);
          if (textareaValue().length === 0) textareaHoldsHangul = false;
          send(DEL);
        } else if (unchanged !== null) {
          send(unchanged);
        }
      }
      return true;
    },
    handleBeforeInput() {
      const textarea = options.textarea();
      beforeChange = textarea?.value ?? '';
      beforeSelected = textarea?.selectionStart != null && textarea.selectionStart !== textarea.selectionEnd;
    },
    // @req FR-BGSTAB-037
    // Dictation selects all it has inserted and inserts its new result over it. xterm would
    // send the whole result again; the change is sent instead and xterm never sees the event.
    interceptInput(composing, inputType) {
      if (keystroke !== null || composing || inputType !== 'insertText' || !beforeSelected) return false;
      const before = beforeChange;
      beforeChange = null;
      beforeSelected = false;
      if (before === null) return false;
      const change = lineChange(before, textareaValue());
      if (change) send(change);
      return true;
    },
    handleInput(composing = false, inputType = '') {
      const before = beforeChange;
      beforeChange = null;
      if (keystroke === null) {
        // @req FR-BGSTAB-036
        if (composing || before === null) return;
        if (inputType === 'insertText' && !keyHeld) return;
        if (keySentByXterm || xtermComparing) return;
        const change = lineChange(before, textareaValue());
        if (change) send(change);
        return;
      }
      if (composing) {
        // A composition after all: xterm sends the composed text at compositionend.
        keystroke = null;
        return;
      }
      const value = textareaValue();
      const change = lineChange(seen, value);
      seen = value;
      keystroke.changed = true;
      textareaHoldsHangul = value.length > 0;
      if (change) send(change);
    },
    noteSentInput(data) {
      if (!sending && keyHeld) keySentByXterm = true;
      if (sending || !textareaHoldsHangul) return;
      const textarea = options.textarea();
      if (!textarea) return;
      textarea.value = data === DEL ? withoutLastCharacter(textarea.value) : '';
      if (textarea.value.length === 0) textareaHoldsHangul = false;
    },
  };
}

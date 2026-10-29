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
  textarea: () => { value: string } | null;
}

export interface IosHangulInput {
  /** The custom key handler's answer: false when the key is not xterm's to handle. */
  handleKey: (event: HangulKeyEventLike) => boolean;
  /** An input event on the terminal's helper textarea; `composing` when it belongs to a composition. */
  handleInput: (composing?: boolean) => void;
  /** Data that reached the terminal by any path; keeps the textarea in step with it. */
  noteSentInput: (data: string) => void;
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
        const backspace = event.key === 'Backspace' && isPlainKey(event)
          && textareaHoldsHangul && textareaValue().length > 0;
        keystroke = isHangulJamoKeystroke(event) || backspace ? { key: event.key, changed: false } : null;
        seen = textareaValue();
        return keystroke === null;
      }
      if (event.type === 'keypress') return keystroke === null;
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
    handleInput(composing = false) {
      if (keystroke === null) return;
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
      if (sending || !textareaHoldsHangul) return;
      const textarea = options.textarea();
      if (!textarea) return;
      textarea.value = data === DEL ? withoutLastCharacter(textarea.value) : '';
      if (textarea.value.length === 0) textareaHoldsHangul = false;
    },
  };
}

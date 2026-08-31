export interface TerminalPartialEscapeState {
  parserComplete: boolean;
  pendingEscapeTailAnsi: string;
  overflowed: boolean;
}

type ScanState =
  | 'ground'
  | 'esc'
  | 'escIntermediate'
  | 'csi'
  | 'osc'
  | 'oscEsc'
  | 'string'
  | 'stringEsc';

const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

function getUtf8CodePointWidth(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function getUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (const codePointValue of value) {
    bytes += getUtf8CodePointWidth(codePointValue.codePointAt(0) ?? 0);
  }
  return bytes;
}

function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithLowSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

function stateAfterEscByte(code: number): ScanState {
  if (code === 0x5b) return 'csi';
  if (code === 0x5d) return 'osc';
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) return 'string';
  if (code >= 0x20 && code <= 0x2f) return 'escIntermediate';
  if (code < 0x20 || code === 0x7f) return 'esc';
  return 'ground';
}

function stateAfterC1SequenceByte(code: number): ScanState | null {
  if (code === C1_CSI) return 'csi';
  if (code === C1_OSC) return 'osc';
  if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
    return 'string';
  }
  return null;
}

/**
 * Incremental VT control-sequence suffix tracker. It mirrors the Orca
 * parser-tail state transitions but maps the cap to BuilderGate's existing
 * snapshot byte budget. The two input parts are scanned without joining.
 *
 * @req REL-BGSTAB-009
 */
export function advanceTerminalPartialEscapeTail(
  pendingEscapeTailAnsi: string,
  chunk: string,
  maxBytes = Number.POSITIVE_INFINITY,
): TerminalPartialEscapeState {
  const boundedMaxBytes = Math.max(0, Math.floor(maxBytes));
  let state: ScanState = 'ground';
  let retained: string[] = [];
  let retainedBytes = 0;
  let currentSequenceOverflowed = false;

  const clearSequence = (): void => {
    retained = [];
    retainedBytes = 0;
    currentSequenceOverflowed = false;
  };
  const startSequence = (value: string): void => {
    retained = [value];
    retainedBytes = getUtf8ByteLength(value);
    currentSequenceOverflowed = retainedBytes > boundedMaxBytes;
    if (currentSequenceOverflowed) retained = [];
  };
  const appendSequence = (value: string): void => {
    if (currentSequenceOverflowed) return;
    const previous = retained[retained.length - 1] ?? '';
    const completesSplitSurrogatePair = endsWithHighSurrogate(previous)
      && startsWithLowSurrogate(value);
    retainedBytes += completesSplitSurrogatePair
      ? 1
      : getUtf8ByteLength(value);
    if (retainedBytes > boundedMaxBytes) {
      retained = [];
      currentSequenceOverflowed = true;
      return;
    }
    retained.push(value);
  };

  for (const part of [pendingEscapeTailAnsi, chunk]) {
    for (const value of part) {
      const code = value.codePointAt(0) ?? 0;
      if (state === 'ground') {
        if (code === ESC) {
          startSequence(value);
          state = 'esc';
        } else {
          const c1State = stateAfterC1SequenceByte(code);
          if (c1State !== null) {
            startSequence(value);
            state = c1State;
          }
        }
        continue;
      }

      if (
        code === ESC
        && state !== 'osc'
        && state !== 'string'
        && state !== 'oscEsc'
        && state !== 'stringEsc'
      ) {
        startSequence(value);
        state = 'esc';
        continue;
      }


      if (
        state !== 'osc'
        && state !== 'string'
        && state !== 'oscEsc'
        && state !== 'stringEsc'
      ) {
        const c1State = stateAfterC1SequenceByte(code);
        if (c1State !== null) {
          startSequence(value);
          state = c1State;
          continue;
        }
      }

      appendSequence(value);
      if (code === CAN || code === SUB) {
        state = 'ground';
        clearSequence();
        continue;
      }
      if (code === C1_ST) {
        state = 'ground';
        clearSequence();
        continue;
      }

      switch (state) {
        case 'esc':
          state = stateAfterEscByte(code);
          if (state === 'ground') clearSequence();
          break;
        case 'escIntermediate':
          if (code >= 0x30 && code <= 0x7e) {
            state = 'ground';
            clearSequence();
          }
          break;
        case 'csi':
          if (code === CAN || code === SUB || (code >= 0x40 && code <= 0x7e)) {
            state = 'ground';
            clearSequence();
          }
          break;
        case 'osc':
          if (code === BEL || code === CAN || code === SUB) {
            state = 'ground';
            clearSequence();
          } else if (code === ESC) {
            state = 'oscEsc';
          }
          break;
        case 'oscEsc':
          if (code === 0x5c) {
            state = 'ground';
            clearSequence();
          } else {
            startSequence(`\x1b${value}`);
            state = code === ESC ? 'esc' : stateAfterEscByte(code);
            if (state === 'ground') clearSequence();
          }
          break;
        case 'string':
          if (code === CAN || code === SUB) {
            state = 'ground';
            clearSequence();
          } else if (code === ESC) {
            state = 'stringEsc';
          }
          break;
        case 'stringEsc':
          if (code === 0x5c) {
            state = 'ground';
            clearSequence();
          } else {
            startSequence(`\x1b${value}`);
            state = code === ESC ? 'esc' : stateAfterEscByte(code);
            if (state === 'ground') clearSequence();
          }
          break;
      }
    }
  }

  const parserComplete = state === 'ground';
  return {
    parserComplete,
    pendingEscapeTailAnsi: parserComplete || currentSequenceOverflowed ? '' : retained.join(''),
    overflowed: !parserComplete && currentSequenceOverflowed,
  };
}

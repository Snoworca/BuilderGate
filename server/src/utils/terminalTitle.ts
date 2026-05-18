export type TerminalTitleSource = 'osc0' | 'osc2';

export interface TerminalTitleEvent {
  source: TerminalTitleSource;
  rawTitle: string;
  title: string;
}

export type TerminalTitleCallback = (event: TerminalTitleEvent) => void;

const OSC_TITLE_PREFIXES = ['\x1b]0;', '\x1b]2;'] as const;
const DEFAULT_TITLE_MAX_LENGTH = 32;
const MAX_OSC_TITLE_PAYLOAD_CHARS = 4096;

const CONTROL_OR_SPACE_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;
const BIDI_FORMAT_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const LEADING_SLASH_ABSOLUTE_PATH_PATTERN = /^[\\/]/u;

export class TerminalTitleDetector {
  private callback: TerminalTitleCallback | null = null;
  private residual = '';
  private discardingOverCapSequence = false;
  private signalData = '';

  setCallback(cb: TerminalTitleCallback): void {
    this.callback = cb;
  }

  process(data: string): void {
    this.signalData = '';
    let input = this.residual + data;
    this.residual = '';
    let index = 0;

    while (index < input.length) {
      if (this.discardingOverCapSequence) {
        const terminator = findOscTerminator(input, index);
        const nextStart = findNextTitleStart(input, index);
        if (terminator && (nextStart < 0 || terminator.start < nextStart)) {
          this.discardingOverCapSequence = false;
          index = terminator.end;
          continue;
        }
        if (nextStart < 0) {
          return;
        }
        this.discardingOverCapSequence = false;
        index = nextStart;
      }

      const start = input.indexOf('\x1b]', index);
      if (start < 0) {
        this.signalData += input.slice(index);
        this.captureTrailingPartialStart();
        return;
      }

      this.signalData += input.slice(index, start);

      if (input.length - start < 4) {
        this.residual = input.slice(start);
        return;
      }

      const command = input[start + 2];
      const separator = input[start + 3];
      if ((command !== '0' && command !== '2') || separator !== ';') {
        this.signalData += input.slice(start, start + 2);
        index = start + 2;
        continue;
      }

      const payloadStart = start + 4;
      const terminator = findOscTerminator(input, payloadStart);
      if (terminator) {
        const rawTitle = input.slice(payloadStart, terminator.start);
        if (rawTitle.length <= MAX_OSC_TITLE_PAYLOAD_CHARS) {
          const title = sanitizeTerminalTitle(rawTitle);
          if (title) {
            this.callback?.({
              source: command === '0' ? 'osc0' : 'osc2',
              rawTitle,
              title,
            });
          }
        }
        index = terminator.end;
        continue;
      }

      const payloadLength = input.length - payloadStart;
      if (payloadLength > MAX_OSC_TITLE_PAYLOAD_CHARS) {
        const nextStart = findNextTitleStart(input, payloadStart);
        if (nextStart >= 0) {
          index = nextStart;
          continue;
        }
        this.discardingOverCapSequence = true;
        return;
      }

      this.residual = input.slice(start);
      return;
    }
  }

  getSignalData(): string {
    return this.signalData;
  }

  destroy(): void {
    this.callback = null;
    this.residual = '';
    this.discardingOverCapSequence = false;
    this.signalData = '';
  }

  private captureTrailingPartialStart(): void {
    for (const prefix of OSC_TITLE_PREFIXES) {
      for (let length = 1; length < prefix.length; length += 1) {
        const suffix = prefix.slice(0, length);
        if (this.signalData.endsWith(suffix)) {
          this.residual = suffix;
          this.signalData = this.signalData.slice(0, -suffix.length);
          return;
        }
      }
    }
  }
}

export function sanitizeTerminalTitle(raw: string, maxLength = DEFAULT_TITLE_MAX_LENGTH): string | null {
  const sanitized = raw
    .replace(BIDI_FORMAT_PATTERN, '')
    .replace(CONTROL_OR_SPACE_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!sanitized) {
    return null;
  }

  const visibleChars = Array.from(sanitized);
  return visibleChars.slice(0, Math.max(1, maxLength)).join('');
}

export function isDefaultTerminalTabName(name: string): boolean {
  return /^Terminal-[1-9]\d*$/.test(name);
}

export function isSystemAbsolutePathTerminalTitle(title: string): boolean {
  const candidate = title.trim();
  return WINDOWS_DRIVE_ABSOLUTE_PATH_PATTERN.test(candidate)
    || LEADING_SLASH_ABSOLUTE_PATH_PATTERN.test(candidate);
}

function findOscTerminator(input: string, start: number): { start: number; end: number } | null {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === '\x07') {
      return { start: index, end: index + 1 };
    }
    if (input[index] === '\x1b' && input[index + 1] === '\\') {
      return { start: index, end: index + 2 };
    }
  }
  return null;
}

function findNextTitleStart(input: string, start: number): number {
  let best = -1;
  for (const prefix of OSC_TITLE_PREFIXES) {
    const found = input.indexOf(prefix, start);
    if (found >= 0 && (best < 0 || found < best)) {
      best = found;
    }
  }
  return best;
}

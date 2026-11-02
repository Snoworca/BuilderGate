/**
 * FR-ARCH-017: the terminal text as plain text, for the dialog the terminal menu
 * opens on a touch screen. The terminal draws on a WebGL canvas, so a phone shows
 * no selection handles over it; plain text in a dialog gets the OS selection,
 * magnifier and copy.
 */

/** AC-2: the dialog keeps at most this many lines, counted after joining wrapped rows. */
export const TERMINAL_TEXT_MAX_LINES = 2000;

export interface TerminalTextLineLike {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface TerminalTextBufferLike {
  length: number;
  getLine(index: number): TerminalTextLineLike | undefined;
}

export interface TerminalTextClipboardLike {
  writeText(data: string): Promise<void>;
}

/**
 * Reads a buffer as text. A row that the next row continues (isWrapped) filled the
 * full width, so its trailing spaces are part of the text and are kept; the last
 * row of a line is trimmed. Trailing blank lines are dropped.
 */
export function readTerminalBufferText(
  buffer: TerminalTextBufferLike,
  maxLines: number = TERMINAL_TEXT_MAX_LINES,
): string {
  const lines: string[] = [];
  let current: string | null = null;
  for (let index = 0; index < buffer.length; index += 1) {
    const row = buffer.getLine(index);
    if (!row) continue;
    const continued = buffer.getLine(index + 1)?.isWrapped === true;
    const text = row.translateToString(!continued);
    if (row.isWrapped && current !== null) {
      current += text;
    } else {
      if (current !== null) lines.push(current);
      current = text;
    }
  }
  if (current !== null) lines.push(current);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-maxLines).join('\n');
}

/** AC-4: writes the whole text; a missing or refusing clipboard reports failed. */
export async function copyAllTerminalText(
  text: string,
  clipboard: TerminalTextClipboardLike | undefined,
): Promise<'copied' | 'failed'> {
  if (!clipboard) return 'failed';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** AC-1: the menu offers 텍스트 선택 only where a finger is the pointer. */
export function isTouchMenuScreen(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

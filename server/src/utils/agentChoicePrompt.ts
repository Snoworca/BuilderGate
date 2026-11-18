import type { HeadlessTerminalState } from './headlessTerminal.js';

/**
 * FR-AITUI-024: how many rows at the bottom of a screen are read to decide whether
 * an agent waits on a choice. A question with four described options, Type
 * something / Chat about this and a footer takes about 16 rows at 200 columns, and
 * each description wraps over more rows on a phone-width terminal.
 */
export const CHOICE_PROMPT_SCAN_ROWS = 40;

/**
 * Rows under a menu's footer: the border a named (-n) Claude Code session draws there.
 * The composer and status rows under an agent's answer are more than this, so footer
 * words quoted in a transcript are not a footer.
 */
const MAX_ROWS_BELOW_FOOTER = 3;

/** Without a footer, rows the cursor line may sit above the bottom: options and descriptions. */
const MAX_ROWS_BELOW_CURSOR = 8;

// A selected option: a cursor glyph (Claude Code ❯, Codex ›, others ▶ ➤), an optional
// number, then text. An empty composer ("❯ ") has no text after the glyph.
// Claude Code draws its cursor as a plain '>' when it decides the terminal has no
// Unicode (no TERM / WT_SESSION / TERM_PROGRAM), which is how the BuilderGate daemon
// starts it; a doubled '>>' is a PowerShell continuation line, not a cursor.
const CURSOR_GLYPH = '(?:[❯›▶➤]|>(?!>))';
const CURSOR_OPTION = new RegExp(`^\\s*[│┃]?\\s*${CURSOR_GLYPH}\\s*(?:(\\d{1,2})[.)]\\s+)?\\S`, 'u');
const NUMBERED_OPTION = new RegExp(`^\\s*[│┃]?\\s*(?:${CURSOR_GLYPH}\\s*)?(\\d{1,2})[.)]\\s+\\S`, 'u');
// The footer a menu prints. "esc to interrupt" is a working agent, not a menu.
const MENU_HINT = /(?:\benter\b|⏎).{0,24}?\bto\s+(?:confirm|select|submit|choose|continue|accept)\b|\besc\b.{0,16}?\bto\s+(?:cancel|go\s+back|exit|reject|deny|close|dismiss)\b/iu;

/**
 * FR-AITUI-024 AC-1: whether the bottom rows of a screen show an agent waiting on a
 * choice. Either the menu footer sits at the bottom with a selected option anywhere
 * above it (a menu of any length), or, with no footer, a selected option sits near
 * the bottom and the next numbered option follows it. Pure: the screen text is all
 * it reads.
 */
export function isAgentChoicePrompt(screenText: string): boolean {
  const rows = screenText.split('\n').map(row => row.replace(/\s+$/u, '')).filter(row => row.trim() !== '');
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 1 - MAX_ROWS_BELOW_FOOTER; i -= 1) {
    if (MENU_HINT.test(rows[i])) return rows.slice(0, i).some(row => CURSOR_OPTION.test(row));
  }
  let cursorIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (CURSOR_OPTION.test(rows[i])) {
      cursorIndex = i;
      break;
    }
  }
  if (cursorIndex < 0) return false;
  const below = rows.slice(cursorIndex + 1);
  if (below.length > MAX_ROWS_BELOW_CURSOR) return false;
  const selected = CURSOR_OPTION.exec(rows[cursorIndex])?.[1];
  if (selected === undefined) return false;
  const next = String(Number(selected) + 1);
  return below.some(row => NUMBERED_OPTION.exec(row)?.[1] === next);
}

// Input that moves through a menu or that the terminal sends by itself: cursor and
// paging keys, Tab / Shift+Tab, focus and mouse reports, and replies to queries
// (cursor position, device attributes, OSC colours, DCS). None of it answers.
const NON_ANSWERING_SEQUENCE = new RegExp([
  '\\u001b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse
  '\\u001b\\[M[\\s\\S]{3}', // X10 mouse
  '\\u001b\\[[IO]', // focus in / out
  '\\u001b\\[\\d+;\\d+R', // cursor position report
  '\\u001b\\[[?>=][\\d;]*c', // device attributes
  '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC reply
  '\\u001bP[\\s\\S]*?\\u001b\\\\', // DCS reply
  '\\u001b\\[(?:\\d+(?:;\\d+)*)?[ABCDHFZ]', // arrows, Home/End, Shift+Tab
  '\\u001bO[ABCDHF]', // application-mode arrows, Home/End
  '\\u001b\\[[1-6](?:;\\d+)?~', // Home/Insert/Delete/End/PageUp/PageDown
  '\\t',
].join('|'), 'gu');

/**
 * FR-AITUI-024 AC-3: whether client input answers a waiting choice (Enter, Esc, a
 * digit, a letter, a paste) rather than only moving through it or being a report
 * the terminal sends by itself.
 */
export function isChoiceAnsweringInput(data: string): boolean {
  return data.replace(NON_ANSWERING_SEQUENCE, '').length > 0;
}

/**
 * FR-AITUI-024 AC-2: up to `maxRows` rows of the live screen as plain text, one row
 * per line, ending at the last row that has text. An inline agent (Claude Code) draws
 * under the shell prompt, so on a tall screen its menu can sit mid-screen with blank
 * rows below it. Never more than the screen and never the scrollback, so a read costs
 * the same on a session with 10,000 lines of history as on a fresh one.
 */
export function readHeadlessBottomRows(state: HeadlessTerminalState, maxRows: number): string {
  const terminal = state.terminal;
  const buffer = terminal.buffer.active;
  const top = buffer.baseY;
  const rowText = (y: number) => buffer.getLine(y)?.translateToString(true) ?? '';
  let last = top + terminal.rows - 1;
  while (last >= top && rowText(last).trim() === '') last -= 1;
  if (last < top) return '';
  const first = Math.max(top, last - Math.max(0, maxRows) + 1);
  const rows: string[] = [];
  for (let y = first; y <= last; y += 1) rows.push(rowText(y));
  return rows.join('\n');
}

import type { HeadlessTerminalState } from './headlessTerminal.js';

/**
 * FR-AITUI-024: how many rows at the bottom of a screen are read to decide whether
 * an agent waits on a choice. A question with four described options, Type
 * something / Chat about this and a footer takes about 16 rows at 200 columns, and
 * each description wraps over more rows on a phone-width terminal.
 */
export const CHOICE_PROMPT_SCAN_ROWS = 40;

/**
 * Rows a menu's footer may sit above the bottom: the border a named (-n) Claude Code
 * session draws there, a background-agents panel. Footer words quoted in an answer
 * are told apart by the composer under them, not by this count.
 */
const MAX_ROWS_BELOW_FOOTER = 6;

/** Without a footer, rows the cursor line may sit above the bottom: options and descriptions. */
const MAX_ROWS_BELOW_CURSOR = 8;

// A selected option: a cursor glyph (Claude Code ❯, Codex ›, others ▶ ➤), an optional
// number, then text. An empty composer ("❯ ") has no text after the glyph.
// Claude Code draws its cursor as a plain '>' when it decides the terminal has no
// Unicode (no TERM / WT_SESSION / TERM_PROGRAM), which is how the BuilderGate daemon
// starts it; a doubled '>>' is a PowerShell continuation line, not a cursor.
const CURSOR_GLYPH = '(?:[❯›▶➤]|>(?!>))';
const CURSOR_OPTION = new RegExp(`^\\s*[│┃]?\\s*${CURSOR_GLYPH}\\s*(?:(\\d{1,2})[.)]\\s+)?\\S`, 'u');
// A row that starts with a cursor glyph, text or not: a menu option, or an agent's
// composer ("❯ " empty, "❯ typed text").
const CURSOR_LEAD = new RegExp(`^\\s*[│┃]?\\s*${CURSOR_GLYPH}`, 'u');
const NUMBERED_OPTION = new RegExp(`^\\s*[│┃]?\\s*(?:${CURSOR_GLYPH}\\s*)?(\\d{1,2})[.)]\\s+\\S`, 'u');
// The footer a menu prints. "esc to interrupt" is a working agent, not a menu.
const MENU_HINT = /(?:\benter\b|⏎).{0,24}?\bto\s+(?:confirm|select|submit|choose|continue|accept)\b|\besc\b.{0,16}?\bto\s+(?:cancel|go\s+back|exit|reject|deny|close|dismiss)\b/iu;
// Claude Code's task list, drawn under the footer of a waiting menu: its header
// ("2/6 tasks done · 1 in progress"), items (◼ in progress, ◻ open, ✔ done) and the
// "… +1 task" overflow row. Not counted against MAX_ROWS_BELOW_FOOTER.
const TASK_PANEL_ROW = /^\s*(?:[◼◻✔]\s|…\s*\+\d+\s|\d+\/\d+\s+tasks?\s+done\b)/u;
// The two options Claude Code adds to every AskUserQuestion menu. With them over a
// footer the menu is a question even when its selected row wrapped above the screen.
const QUESTION_MENU_OPTION = new RegExp(`^\\s*[│┃]?\\s*(?:${CURSOR_GLYPH}\\s*)?\\d{1,2}[.)]\\s+(?:Type something\\.|Chat about this)$`, 'u');

/**
 * FR-AITUI-024 AC-1: whether the bottom rows of a screen show an agent waiting on a
 * choice. Either the menu footer sits at the bottom with a selected option anywhere
 * above it (a menu of any length), or, with no footer, a selected option sits near
 * the bottom and the next numbered option follows it. Footer words in the composer,
 * or above it in an answer, are not a footer: a menu replaces the composer. Pure:
 * the screen text is all it reads.
 */
export function isAgentChoicePrompt(screenText: string): boolean {
  const rows = screenText.split('\n').map(row => row.replace(/\s+$/u, '')).filter(row => row.trim() !== '');
  for (let i = rows.length - 1, below = 0; i >= 0 && below <= MAX_ROWS_BELOW_FOOTER; i -= 1) {
    if (CURSOR_LEAD.test(rows[i])) break;
    if (MENU_HINT.test(rows[i])) {
      const above = rows.slice(0, i);
      return above.some(row => CURSOR_OPTION.test(row) || QUESTION_MENU_OPTION.test(row));
    }
    if (!TASK_PANEL_ROW.test(rows[i])) below += 1;
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

/**
 * Bottom rows searched for signs that the agent has moved on from a menu: the
 * composer, its two status rows and an expanded background-agents panel.
 */
const MOVED_ON_SCAN_ROWS = 20;
// A rule, plain or with a session name on either end ("─ og-flow 2136 ────").
const RULE_ROW = /^\s*─(?:─{2,}|.*─{3,})/u;
// A rule with the composer on the same row, as a read that joins wrapped rows gives it.
const RULE_THEN_COMPOSER = new RegExp(`^\\s*─{3,}[^❯›>]*?${CURSOR_GLYPH}`, 'u');
// A selected numbered option is a menu row even when rules frame it (a scrolled
// menu with the cursor on "Chat about this").
const NUMBERED_CURSOR = new RegExp(`^\\s*[│┃]?\\s*${CURSOR_GLYPH}\\s*\\d{1,2}[.)]\\s`, 'u');
const AGENT_AT_WORK = /\besc to interrupt\b|\?\s+for shortcuts\b|\b\d{1,3}% context left\b|← for agents\b/iu;
/** Rows a composer draft may wrap over before the rule under it. */
const MAX_COMPOSER_ROWS = 8;
// A prompt as the last row: PowerShell, cmd, POSIX shells ($ # %), a lone prompt
// glyph (an empty agent composer, starship, fish), cmder's λ.
const SHELL_PROMPT = new RegExp(`^PS [^\\n]*>$|^[A-Za-z]:\\\\[^>\\n]*>$|[$#%λ]$|^${CURSOR_GLYPH}$`, 'u');

/**
 * FR-AITUI-024 AC-6: whether the bottom rows show that the agent has moved on from a
 * menu: its composer between two rules (Claude Code), its working line ("esc to
 * interrupt"), its shortcut hint ("? for shortcuts"), or a shell prompt on the last
 * row. A menu that is only out of view (scrolled, its footer replaced by "Jump to
 * bottom") shows none of these. Pure: the screen text is all it reads.
 */
export function showsAgentPromptOrWork(screenText: string): boolean {
  const all = screenText.split('\n').map(row => row.replace(/\s+$/u, '')).filter(row => row.trim() !== '');
  if (all.length === 0) return false;
  if (SHELL_PROMPT.test(all[all.length - 1].trim())) return true;
  const rows = all.slice(-MOVED_ON_SCAN_ROWS);
  if (rows.some(row => AGENT_AT_WORK.test(row))) return true;
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (NUMBERED_CURSOR.test(rows[i])) continue;
    const composer = RULE_THEN_COMPOSER.test(rows[i]) || (i > 0 && CURSOR_LEAD.test(rows[i]) && RULE_ROW.test(rows[i - 1]));
    if (!composer) continue;
    // The rule under the composer, after any rows its draft wraps over.
    for (let j = i + 1; j < rows.length && j <= i + MAX_COMPOSER_ROWS; j += 1) {
      if (RULE_ROW.test(rows[j])) return true;
      if (CURSOR_LEAD.test(rows[j])) break;
    }
  }
  return false;
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

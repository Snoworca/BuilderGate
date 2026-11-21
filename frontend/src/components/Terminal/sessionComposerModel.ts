// The session composer's decisions, kept apart from React so each can be tested alone:
// what a key does, how tall the box may be, and where the history cursor goes.
// @req FR-CMP-001 FR-CMP-002 FR-CMP-003

import type { MessageKey } from '../../i18n/i18n.ts';

export const COMPOSER_HISTORY_LIMIT = 50;
export const COMPOSER_MIN_TERMINAL_ROWS = 6;
export const COMPOSER_LINE_HEIGHT_PX = 20;
/** Drag handle, padding and borders around the text lines. */
export const COMPOSER_CHROME_PX = 24;
/** One line of text: the smallest the composer gets (FR-CMP-002 AC-1). */
export const COMPOSER_MIN_HEIGHT_PX = COMPOSER_CHROME_PX + COMPOSER_LINE_HEIGHT_PX;
export const COMPOSER_DEFAULT_HEIGHT_PX = 120;
/** The one-line error shown above the box (FR-CMP-003 AC-4). */
export const COMPOSER_ERROR_ROW_PX = 20;
export const COMPOSER_MAX_TILE_FRACTION = 0.5;
export const COMPOSER_MOBILE_MAX_TILE_FRACTION = 0.35;
export const COMPOSER_DRAFT_SAVE_DELAY_MS = 300;
/** Line-count changes reach the layout (and so the PTY size) at most this often. */
export const COMPOSER_AUTOGROW_DELAY_MS = 150;

const DEFAULT_TERMINAL_FONT_PX = 14;
/** xterm draws a row at about 1.2 times the font size with the default line height. */
const TERMINAL_ROW_PER_FONT_PX = 1.2;

// The server's submit Enter delay (server/src/services/submitDelivery.ts DEFAULT_SUBMIT_ENTER_DELAY).
const ENTER_DELAY_BASE_MS = 1000;
const ENTER_DELAY_PER_KB_MS = 50;
const ENTER_DELAY_MAX_MS = 10_000;

export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/** The same test the terminal uses: an Enter that confirms a composition reports one of these. */
export function isImeComposingKey(event: Pick<ComposerKeyInput, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** `native` leaves the key to the textarea (a newline for Enter). */
export type ComposerEnterDecision = 'send' | 'continue-line' | 'native';

export function decideComposerEnter(input: {
  event: ComposerKeyInput;
  mobile: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}): ComposerEnterDecision {
  const { event, mobile, value, selectionStart, selectionEnd } = input;
  if (event.key !== 'Enter' || isImeComposingKey(event)) return 'native';
  // FR-CMP-003 AC-1: a phone keyboard's Enter is a newline; the send button sends.
  if (mobile || event.shiftKey || event.altKey) return 'native';
  if (event.ctrlKey || event.metaKey) return 'send';
  const caretAtLineEnd = selectionStart === selectionEnd
    && (selectionStart === value.length || value[selectionStart] === '\n');
  if (caretAtLineEnd && selectionStart > 0 && value[selectionStart - 1] === '\\') return 'continue-line';
  return 'send';
}

/** Claude Code's line continuation: drop the backslash before the caret and break the line. */
export function applyContinueLine(value: string, caret: number): { value: string; caret: number } {
  return { value: `${value.slice(0, caret - 1)}\n${value.slice(caret)}`, caret };
}

export function isSendableDraft(draft: string): boolean {
  return draft.trim().length > 0;
}

export function countDraftLines(draft: string): number {
  return draft.split('\n').length;
}

/**
 * FR-CMP-002 AC-2: the lines the draft takes on screen, wrapped lines included, from the
 * textarea's content height; never fewer than its hard line breaks.
 */
export function countVisualLines(input: { draft: string; scrollHeight: number; paddingY: number; lineHeightPx: number }): number {
  const hard = countDraftLines(input.draft);
  if (!(input.lineHeightPx > 0)) return hard;
  const measured = Math.round((input.scrollHeight - input.paddingY) / input.lineHeightPx);
  return Math.max(1, hard, measured);
}

export function estimateTerminalRowPx(storedFontSize: string | null): number {
  const parsed = storedFontSize === null ? Number.NaN : Number.parseInt(storedFontSize, 10);
  const fontPx = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TERMINAL_FONT_PX;
  return Math.ceil(fontPx * TERMINAL_ROW_PER_FONT_PX);
}

/**
 * FR-CMP-002 AC-1: at least one line; at most half the tile (35% on a phone) and no more than
 * leaves the terminal six rows. When both cannot hold, the one line wins.
 */
export function clampComposerHeight(input: {
  requested: number;
  tileHeight: number;
  /** Fixed rows in the tile besides the terminal and the composer (the status row). */
  reservedPx: number;
  terminalRowPx: number;
  mobile: boolean;
}): number {
  const { requested, tileHeight, reservedPx, terminalRowPx, mobile } = input;
  const floor = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.round(requested));
  if (tileHeight <= 0) return floor;
  const fraction = mobile ? COMPOSER_MOBILE_MAX_TILE_FRACTION : COMPOSER_MAX_TILE_FRACTION;
  const max = Math.min(
    Math.floor(tileHeight * fraction),
    tileHeight - reservedPx - COMPOSER_MIN_TERMINAL_ROWS * terminalRowPx,
  );
  return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(floor, max));
}

/** FR-CMP-002 AC-2: the chosen height is a ceiling; a short draft takes less. */
export function composerLayoutHeight(input: { chosenHeight: number; lineCount: number }): number {
  const content = COMPOSER_CHROME_PX + Math.max(1, input.lineCount) * COMPOSER_LINE_HEIGHT_PX;
  return Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(input.chosenHeight, content));
}

export interface ComposerHistoryBrowse {
  /** The history entry on screen, or null when the draft is the user's own. */
  index: number | null;
  /** The draft that was there before browsing began; Down past the newest brings it back. */
  stash: string;
}

export const NOT_BROWSING_HISTORY: ComposerHistoryBrowse = Object.freeze({ index: null, stash: '' });

export type ComposerHistoryStep =
  | { handled: false }
  | { handled: true; draft: string; browse: ComposerHistoryBrowse };

export function isCaretOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes('\n');
}

/** Where the caret goes in a recalled entry: the end of its first line, so Up and Down keep working. */
export function historyCaret(draft: string): number {
  const lineBreak = draft.indexOf('\n');
  return lineBreak < 0 ? draft.length : lineBreak;
}

/**
 * FR-CMP-003 AC-5: Up and Down walk the history only from the first line, and only when the
 * draft is empty or is a recalled entry; otherwise they move the caret as usual.
 */
export function navigateComposerHistory(input: {
  history: readonly string[];
  draft: string;
  browse: ComposerHistoryBrowse;
  direction: 'prev' | 'next';
  caretOnFirstLine: boolean;
}): ComposerHistoryStep {
  const { history, draft, browse, direction, caretOnFirstLine } = input;
  if (!caretOnFirstLine || history.length === 0) return { handled: false };
  if (direction === 'prev') {
    if (browse.index === null) {
      if (draft !== '') return { handled: false };
      const index = history.length - 1;
      return { handled: true, draft: history[index], browse: { index, stash: draft } };
    }
    const index = Math.max(0, browse.index - 1);
    return { handled: true, draft: history[index], browse: { index, stash: browse.stash } };
  }
  if (browse.index === null) return { handled: false };
  if (browse.index < history.length - 1) {
    const index = browse.index + 1;
    return { handled: true, draft: history[index], browse: { index, stash: browse.stash } };
  }
  return { handled: true, draft: browse.stash, browse: NOT_BROWSING_HISTORY };
}

export function pushComposerHistory(history: readonly string[], entry: string): string[] {
  const next = history[history.length - 1] === entry ? [...history] : [...history, entry];
  return next.slice(-COMPOSER_HISTORY_LIMIT);
}

export type ComposerShortcutDecision = 'open-and-focus' | 'focus-composer' | 'close';

/** FR-CMP-001 AC-3: one key to go and write, and to put the box away. */
export function decideComposerShortcut(input: { open: boolean; composerFocused: boolean }): ComposerShortcutDecision {
  if (!input.open) return 'open-and-focus';
  return input.composerFocused ? 'close' : 'focus-composer';
}

/** FR-CMP-003 AC-3: the Enter follows the paste as the server's submit does, so a busy TUI does not take it as part of the paste. */
export function composerEnterDelayMs(text: string): number {
  return Math.min(ENTER_DELAY_MAX_MS, ENTER_DELAY_BASE_MS + Math.ceil(text.length / 1024) * ENTER_DELAY_PER_KB_MS);
}

/** FR-CMP-003 AC-4: the paste path's refusals, in words. */
export function composerSendErrorKey(reason: string): MessageKey {
  if (reason === 'paste-too-large') return 'composer.error.tooLarge';
  if (reason === 'unsupported-multiline-paste') return 'composer.error.multiline';
  return 'composer.error.unavailable';
}

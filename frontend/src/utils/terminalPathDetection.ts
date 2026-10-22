// Finds file paths in terminal rows (FR-ARCH-012), picks the one nearest a
// press and lists the paths on screen (FR-ARCH-013). Pure and free of xterm,
// so each rule is testable without a terminal; TerminalView only feeds it rows.
// @req FR-ARCH-012
// @req FR-ARCH-013

import { isOpenableFile } from '../components/fileExplorer/fileRowInteraction.ts';

/** One buffer row as text, with the cell column of each character. */
export interface TerminalRowText {
  text: string;
  /** colOf[i] is the cell column of text's i-th character (code point). */
  colOf: number[];
  /** The row continues the row above it (xterm IBufferLine.isWrapped). */
  isWrapped: boolean;
}

/** What to open: the path, then the fallbacks tried in order when it is not found. */
export interface TerminalPathTarget {
  path: string;
  /**
   * Pieces of a path joined across a TUI's wrap indent, each a path on its own;
   * empty for an ordinary path (FR-ARCH-012 AC-5, AC-8).
   */
  alternatives: string[];
}

/** A path found in the rows. Rows index the array given; columns are cells, end inclusive. */
export interface TerminalPathRange extends TerminalPathTarget {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

export interface LineLike {
  isWrapped: boolean;
  length: number;
  getCell(x: number): CellLike | undefined;
}

/** FR-ARCH-013 AC-3: the screen list holds at most this many paths. */
export const SCREEN_PATH_LIMIT = 10;

/** Reads one xterm buffer line cell by cell, so wide characters keep their columns. */
export function readRow(line: LineLike, cols: number): TerminalRowText {
  let text = '';
  const colOf: number[] = [];
  const width = Math.min(cols, line.length);
  for (let x = 0; x < width; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue; // the second half of a wide character
    const chars = cell.getChars() || ' ';
    for (const ch of chars) {
      text += ch;
      colOf.push(x);
    }
  }
  return { text, colOf, isWrapped: line.isWrapped };
}

// AC-4: URLs are blanked out before paths are looked for, keeping offsets.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;

// A path: an optional root (drive, ~/, ./, ../ or /), folders, then a name with
// an extension, then an optional :line[:column] (AC-2). Names may hold letters of
// any script; the extension is ASCII, so a Korean particle after it ends the path.
// The lookbehind keeps a match from starting inside a longer word or path.
const NAME = '[\\p{L}\\p{N}_@+%#=~-][\\p{L}\\p{N}_.@+%#=~-]*';
const PATH_PATTERN = new RegExp(
  '(?<![\\p{L}\\p{N}_.@+%#=~\\\\/-])'
  + '((?:[A-Za-z]:[\\\\/]|~[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?'
  + `(?:${NAME}[\\\\/])*`
  + `${NAME}\\.[A-Za-z0-9]+)`
  + '(?::\\d+(?::\\d+)?)?'
  + '(?![A-Za-z0-9_])',
  'gu',
);

/** One logical line: a row and the wrapped rows after it. */
interface LogicalLine {
  text: string;
  /** For each code point of text: its row index and cell column. */
  at: Array<{ row: number; col: number }>;
  /** Code point indexes of indent spaces at the start of wrapped rows inside a path. */
  gaps: Set<number>;
}

const PATH_CHAR = /[\p{L}\p{N}_.@+%#=~\\/-]/u;
// A TUI such as Claude Code cuts a long path to its own width and puts its
// indent before each piece. Up to this many spaces at the start of a row,
// between path characters, are taken as that indent.
const MAX_WRAP_INDENT = 4;

function logicalLines(rows: readonly TerminalRowText[], cols: number): LogicalLine[] {
  const lines: LogicalLine[] = [];
  rows.forEach((current, rowIndex) => {
    const chars = [...current.text];
    let indent = 0;
    while (indent < chars.length && chars[indent] === ' ') indent += 1;
    const previous = lines[lines.length - 1];
    const before = previous ? [...previous.text] : [];
    const last = before[before.length - 1];
    const lastAt = previous?.at[previous.at.length - 1];
    // The piece runs on from the row above when that row ends in a path
    // character and this one starts with an indent and a path character. The
    // terminal marks the row wrapped when the TUI relied on autowrap; ConPTY,
    // which redraws the screen itself, can send it as a row of its own, so a
    // row above that is full to the last column counts too.
    const joinsPath = previous !== undefined && last !== undefined && PATH_CHAR.test(last)
      && indent > 0 && indent <= MAX_WRAP_INDENT && PATH_CHAR.test(chars[indent] ?? '')
      && (current.isWrapped || (lastAt?.row === rowIndex - 1 && lastAt.col === cols - 1));
    if (!(current.isWrapped || joinsPath) || previous === undefined) {
      lines.push({ text: '', at: [], gaps: new Set() });
    }
    const line = lines[lines.length - 1];
    chars.forEach((ch, i) => {
      const col = current.colOf[i] ?? i;
      if (col >= cols) return;
      if (joinsPath && i < indent) line.gaps.add(before.length + i);
      line.text += ch;
      line.at.push({ row: rowIndex, col });
    });
  });
  return lines;
}

/** Openable paths in one text, by code point index, end inclusive. */
function detect(text: string): Array<{ path: string; start: number; end: number }> {
  const found: Array<{ path: string; start: number; end: number }> = [];
  const masked = text.replace(URL_PATTERN, (url) => ' '.repeat(url.length));
  for (const match of masked.matchAll(PATH_PATTERN)) {
    const path = match[1];
    if (!isOpenableFile(fileNameOf(path))) continue;
    // match.index counts UTF-16 units; the result counts code points.
    const start = [...masked.slice(0, match.index)].length;
    found.push({ path, start, end: start + [...path].length - 1 });
  }
  return found;
}

// FR-ARCH-012 AC-9: the file the server makes for a shell to report its folder
// (SessionManager: <tmp>/buildergate-cwd-<session>.txt). A WSL shell prints the
// PROMPT_COMMAND that writes it; it is BuilderGate's, never the user's file.
const INTERNAL_CWD_FILE = /(?:^|[\\/])buildergate-cwd-[^\\/]+\.txt$/i;

function isInternalPath(path: string): boolean {
  return INTERNAL_CWD_FILE.test(path);
}

/** FR-ARCH-012 AC-1~AC-5: the openable file paths in the rows, in reading order. */
export function findPathsInRows(rows: readonly TerminalRowText[], cols: number): TerminalPathRange[] {
  const found: TerminalPathRange[] = [];
  for (const line of logicalLines(rows, cols)) {
    const toRange = (path: string, start: number, end: number, alternatives: string[]): TerminalPathRange | null => {
      const first = line.at[start];
      const last = line.at[end];
      if (!first || !last) return null;
      return { path, alternatives, startRow: first.row, startCol: first.col, endRow: last.row, endCol: last.col };
    };
    const plain = detect(line.text);
    if (line.gaps.size === 0) {
      for (const hit of plain) {
        const range = toRange(hit.path, hit.start, hit.end, []);
        if (range) found.push(range);
      }
      continue;
    }
    // Look again with the wrap indent taken out. A path that runs across it is
    // the joined one; the pieces found without joining become its fallbacks,
    // since a real space can also fall at the start of a wrapped row.
    const chars = [...line.text];
    const kept: number[] = [];
    chars.forEach((_, i) => { if (!line.gaps.has(i)) kept.push(i); });
    const covered = new Set<number>();
    for (const hit of detect(kept.map(i => chars[i]).join(''))) {
      const start = kept[hit.start];
      const end = kept[hit.end];
      const crosses = [...line.gaps].some(gap => gap > start && gap < end);
      const pieces = crosses ? plain.filter(piece => piece.start >= start && piece.end <= end) : [];
      pieces.forEach(piece => covered.add(piece.start));
      if (!crosses) covered.add(start);
      const range = toRange(hit.path, start, end, pieces.map(piece => piece.path).filter(path => path !== hit.path));
      if (range) found.push(range);
    }
    for (const hit of plain) {
      if (covered.has(hit.start)) continue;
      const range = toRange(hit.path, hit.start, hit.end, []);
      if (range) found.push(range);
    }
  }
  return found
    .filter(range => !isInternalPath(range.path))
    .sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol);
}

/** The cells a path takes on one row, or null when it does not touch that row. */
function spanOnRow(range: TerminalPathRange, row: number): [number, number] | null {
  if (row < range.startRow || row > range.endRow) return null;
  return [row === range.startRow ? range.startCol : 0, row === range.endRow ? range.endCol : Number.MAX_SAFE_INTEGER];
}

/**
 * FR-ARCH-013 AC-1: the path at or nearest a press. The pressed row comes first,
 * then the rows right above and below; within a row the nearest column wins.
 */
export function pickPathNear(paths: readonly TerminalPathRange[], row: number, col: number): TerminalPathRange | null {
  for (const candidateRows of [[row], [row - 1, row + 1]]) {
    let best: TerminalPathRange | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const range of paths) {
      for (const candidateRow of candidateRows) {
        const span = spanOnRow(range, candidateRow);
        if (span === null) continue;
        const distance = col < span[0] ? span[0] - col : col > span[1] ? col - span[1] : 0;
        if (distance < bestDistance) {
          best = range;
          bestDistance = distance;
        }
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** FR-ARCH-013 AC-3: paths on screen, bottom (latest output) first, unique, at most ten. */
export function listScreenPaths(paths: readonly TerminalPathRange[]): TerminalPathTarget[] {
  const ordered = [...paths].sort((a, b) => b.endRow - a.endRow || b.startCol - a.startCol);
  const listed: TerminalPathTarget[] = [];
  for (const range of ordered) {
    if (!listed.some(target => target.path === range.path)) listed.push(targetOf(range));
    if (listed.length === SCREEN_PATH_LIMIT) break;
  }
  return listed;
}

/** FR-ARCH-013 AC-1: the screen cell under a client point, or null outside the screen. */
export function cellAtPoint(
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number,
  x: number,
  y: number,
): { row: number; col: number } | null {
  if (cols <= 0 || rows <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.floor(((x - rect.left) / rect.width) * cols);
  const row = Math.floor(((y - rect.top) / rect.height) * rows);
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { row, col };
}

/** The path and its fallbacks, without the position. */
export function targetOf(range: TerminalPathTarget): TerminalPathTarget {
  return { path: range.path, alternatives: [...range.alternatives] };
}

/**
 * FR-ARCH-013 AC-7: a path as the menu shows it: the file name, and its folder
 * relative to the session folder (null for the session folder itself). Windows
 * paths compare without case and with either separator; the folder keeps the
 * separator the path was written with.
 */
export function describeTerminalPath(path: string, cwd: string): { name: string; folder: string | null } {
  const name = fileNameOf(path);
  const folder = path.slice(0, path.length - name.length).replace(/[\\/]+$/, '');
  if (folder === '' || folder === '.') return { name, folder: null };
  const windows = /^[A-Za-z]:/.test(folder) || /^[A-Za-z]:/.test(cwd);
  const segmentsOf = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]+/);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const folderSegments = segmentsOf(folder);
  const rootSegments = cwd === '' ? [] : segmentsOf(cwd);
  const inside = rootSegments.length > 0
    && rootSegments.length <= folderSegments.length
    && rootSegments.every((segment, i) => same(segment, folderSegments[i]));
  if (!inside) return { name, folder };
  const rest = folderSegments.slice(rootSegments.length);
  if (rest.length === 0) return { name, folder: null };
  const separator = folder.match(/[\\/]/)?.[0] ?? '/';
  return { name, folder: rest.join(separator) };
}

/** FR-ARCH-013 AC-7: a folder longer than max loses its leading folders to "…". */
export function shortenFolder(folder: string, max: number): string {
  if (folder.length <= max) return folder;
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const segments = folder.split(/[\\/]/).filter((segment) => segment !== '');
  let kept = segments[segments.length - 1] ?? folder;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const next = `${segments[i]}${separator}${kept}`;
    if (1 + separator.length + next.length > max) break;
    kept = next;
  }
  return `…${separator}${kept}`;
}

/** The last segment of a path, for the menu label. */
export function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] ?? path;
}

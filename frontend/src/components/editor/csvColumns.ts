// FR-MDE-017 -- column spans for CSV/TSV lines, so the code editor can colour
// each column. Pure and DOM-free: the ViewPlugin in codeEditorExtensions.ts
// turns these spans into mark decorations.
//
// A line is split on its own; a quoted cell that spans lines is not followed
// across the line break (colouring is a reading aid, not a parser).
//
// @req FR-MDE-017

export type ColumnDelimiter = ',' | '\t';

export interface ColumnSpan {
  from: number;
  to: number;
}

/** How many column colours cycle before repeating. */
export const CSV_COLUMN_COLOR_COUNT = 6;

// @req FR-MDE-017
/** The class for a column index; it repeats every CSV_COLUMN_COLOR_COUNT columns. */
export function csvColumnClass(index: number): string {
  const slot = ((index % CSV_COLUMN_COLOR_COUNT) + CSV_COLUMN_COLOR_COUNT) % CSV_COLUMN_COLOR_COUNT;
  return `cm-csv-col-${slot}`;
}

// @req FR-MDE-017
/**
 * The cells of one line, delimiters excluded. A delimiter between double
 * quotes does not split; `""` inside quotes is an escaped quote and keeps
 * the quoted run open. An empty line is one empty cell.
 */
export function splitDelimitedColumns(line: string, delimiter: ColumnDelimiter): ColumnSpan[] {
  const spans: ColumnSpan[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      spans.push({ from: start, to: i });
      start = i + 1;
    }
  }
  spans.push({ from: start, to: line.length });
  return spans;
}

/** The delimiter for a file name, or null when it is not CSV/TSV. */
export function columnDelimiterFor(filePath: string): ColumnDelimiter | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv')) return ',';
  if (lower.endsWith('.tsv')) return '\t';
  return null;
}

/**
 * Diff rows for the Git window: hidden-context gaps, hunk headers and lines with
 * word marks; split-view pairing; and the window of rows to draw for long diffs.
 *
 * @req FR-GIT-007
 */
import type { DiffHunk, DiffLine } from './gitApi.ts';

export const WORD_DIFF_MAX = 500;

type Range = [number, number];

/** Changed character ranges of a removed line and the added line it pairs with (token LCS). */
export function wordDiff(a: string, b: string): { old: Range[]; new: Range[] } | null {
  if (a.length > WORD_DIFF_MAX || b.length > WORD_DIFF_MAX) return null;
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const x = tok(a), y = tok(b);
  const n = x.length, m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keepX = new Array<boolean>(n).fill(false), keepY = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i] === y[j]) { keepX[i] = true; keepY[j] = true; i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1; else j += 1;
  }
  const ranges = (tokens: string[], keep: boolean[], text: string): Range[] => {
    const out: Range[] = [];
    let pos = 0;
    tokens.forEach((t, i) => {
      if (!keep[i]) {
        const last = out[out.length - 1];
        if (last && !/\s/.test(text.slice(last[1], pos))) last[1] = pos + t.length;
        else out.push([pos, pos + t.length]);
      }
      pos += t.length;
    });
    return out;
  };
  return { old: ranges(x, keepX, a), new: ranges(y, keepY, b) };
}

export type DiffRow =
  | { type: 'gap'; at: 'top' | 'between' | 'bottom'; count: number; hunk: number }
  | { type: 'hunk'; header: string; index: number }
  | ({ type: 'line'; marks?: Range[]; hunk: number } & DiffLine);

export function buildDiffRows(hunks: readonly DiffHunk[], opts: { gapAfter?: number }): DiffRow[] {
  const rows: DiffRow[] = [];
  hunks.forEach((h, hi) => {
    const prev = hunks[hi - 1];
    const gap = prev ? h.newStart - (prev.newStart + prev.newLines) : h.newStart - 1;
    if (gap > 0) rows.push({ type: 'gap', at: prev ? 'between' : 'top', count: gap, hunk: hi });
    rows.push({ type: 'hunk', header: h.header, index: hi });
    for (let i = 0; i < h.lines.length;) {
      if (h.lines[i].k !== '-') { rows.push({ type: 'line', hunk: hi, ...h.lines[i] }); i += 1; continue; }
      const dels: DiffLine[] = [];
      while (i < h.lines.length && h.lines[i].k === '-') dels.push(h.lines[i++]);
      const adds: DiffLine[] = [];
      while (i < h.lines.length && h.lines[i].k === '+') adds.push(h.lines[i++]);
      const marks = dels.map((d, j) => (adds[j] ? wordDiff(d.t, adds[j].t) : null));
      dels.forEach((d, j) => rows.push({ type: 'line', hunk: hi, ...d, ...(marks[j] ? { marks: marks[j]!.old } : {}) }));
      adds.forEach((d, j) => rows.push({ type: 'line', hunk: hi, ...d, ...(marks[j] ? { marks: marks[j]!.new } : {}) }));
    }
  });
  if (opts.gapAfter && opts.gapAfter > 0) rows.push({ type: 'gap', at: 'bottom', count: opts.gapAfter, hunk: hunks.length });
  return rows;
}

type LineRow = Extract<DiffRow, { type: 'line' }>;
export type SplitRow =
  | Exclude<DiffRow, { type: 'line' }>
  | { type: 'pair'; left: LineRow | null; right: LineRow | null };

export function pairSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: LineRow[] = [], adds: LineRow[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) out.push({ type: 'pair', left: dels[i] ?? null, right: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const r of rows) {
    if (r.type !== 'line') { flush(); out.push(r); continue; }
    if (r.k === '-') dels.push(r);
    else if (r.k === '+') adds.push(r);
    else { flush(); out.push({ type: 'pair', left: r, right: r }); }
  }
  flush();
  return out;
}

export function virtualRange(input: { scrollTop: number; viewport: number; rowHeight: number; total: number; overscan: number }): { start: number; end: number } {
  const first = Math.floor(input.scrollTop / input.rowHeight);
  const visible = Math.ceil(input.viewport / input.rowHeight);
  return { start: Math.max(0, first - input.overscan), end: Math.min(input.total, first + visible + input.overscan) };
}

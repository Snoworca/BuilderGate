/**
 * Commit graph lanes ("active lanes", as in SourceTree and VS Code Git Graph).
 *
 * Commits arrive newest first in topological order. Each lane waits for one commit
 * (the parent its line leads to). A commit takes the lane that waits for it, or a
 * free lane when nothing does (a tip). Its first parent continues that lane; other
 * parents get lanes of their own (merge lines). Lanes that also waited for it join
 * it. A lane keeps the colour its tip got. The state carries over to the next page.
 *
 * @req FR-GIT-005
 */

export interface GraphCommit { sha: string; parents: string[] }

export interface GraphRow {
  sha: string;
  lane: number;
  isTip: boolean;
  /** Palette index (0..PALETTE_SIZE-1) of this commit's lane. */
  color: number;
  /** The lane continues below this commit (it has a first parent). */
  continuesDown: boolean;
  /** Lanes that end at this commit (other children of it). */
  joinFrom: number[];
  /** Lanes this commit opens or joins for its extra parents. */
  mergeTo: number[];
  /** Lanes that pass by this row unchanged. */
  passThrough: number[];
  /** Colour of every lane as it enters / leaves the row. */
  colorsBefore: number[];
  colorsAfter: number[];
}

export interface GraphState { lanes: Array<string | null>; colors: number[]; next: number }

export const MAX_LANES = 8;
export const PALETTE_SIZE = 6;

export function emptyGraphState(): GraphState {
  return { lanes: [], colors: [], next: 0 };
}

export function layoutGraph(commits: readonly GraphCommit[], from: GraphState = emptyGraphState()): {
  rows: GraphRow[];
  state: GraphState;
  laneCount: number;
  overflow: number;
} {
  const lanes = from.lanes.slice();
  const colors = from.colors.slice();
  let next = from.next;
  let maxLanes = Math.max(1, lanes.length);
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  const newColor = () => (next++) % PALETTE_SIZE;

  const rows = commits.map((c): GraphRow => {
    const before = lanes.slice();
    const colorsBefore = colors.slice(0, before.length);
    let lane = lanes.indexOf(c.sha);
    const isTip = lane < 0;
    if (isTip) { lane = free(); colors[lane] = newColor(); }
    const joinFrom: number[] = [];
    before.forEach((waiting, k) => {
      if (waiting === c.sha && k !== lane) { joinFrom.push(k); lanes[k] = null; }
    });
    lanes[lane] = c.parents[0] ?? null;
    const mergeTo: number[] = [];
    for (const p of c.parents.slice(1)) {
      let j = lanes.indexOf(p);
      if (j < 0) { j = free(); lanes[j] = p; colors[j] = newColor(); }
      mergeTo.push(j);
    }
    const passThrough = before
      .map((waiting, k) => (waiting !== null && k !== lane && !joinFrom.includes(k) ? k : -1))
      .filter((k) => k >= 0);
    const colorsAfter = colors.slice(0, lanes.length);
    maxLanes = Math.max(maxLanes, before.length, lanes.length, lane + 1);
    const row: GraphRow = { sha: c.sha, lane, isTip, color: colors[lane], continuesDown: lanes[lane] !== null, joinFrom, mergeTo, passThrough, colorsBefore, colorsAfter };
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return row;
  });

  return {
    rows,
    state: { lanes, colors: colors.slice(0, lanes.length), next },
    laneCount: Math.min(MAX_LANES, maxLanes),
    overflow: Math.max(0, maxLanes - MAX_LANES),
  };
}

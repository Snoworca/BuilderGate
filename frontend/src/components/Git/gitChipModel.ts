/**
 * What the branch chip in the session bottom bar shows at each width.
 *
 * The stage comes from the width left in the bar after the session name (not the
 * viewport). The chip never shrinks inside a stage: the branch name is shortened in
 * the middle here, and the CSS never adds a second ellipsis.
 *
 * @req FR-GIT-001
 * @req FR-GIT-002
 */

export interface ChipStage { min: number; chars: number }

/** design ③: left width ≥ min → this stage; chars = longest branch name shown. */
export const CHIP_STAGES: readonly ChipStage[] = [
  { min: 460, chars: 28 },
  { min: 390, chars: 20 },
  { min: 300, chars: 20 },
  { min: 260, chars: 14 },
  { min: 200, chars: 14 },
  { min: 150, chars: 10 },
  { min: 0, chars: 0 },
];
const LAST = CHIP_STAGES.length - 1;
const HYSTERESIS = 8;
const NAME_MAX = 150;
const BAR = 4;
const GAPS = 16;
/** ⎇ ●n: the narrowest chip. */
const CHIP_MIN = 74;

export function availableChipWidth(rowWidth: number, nameWidth: number): number {
  return rowWidth - BAR - Math.min(NAME_MAX, nameWidth) - GAPS;
}

export function stageFor(available: number, previous?: number): number {
  let stage = CHIP_STAGES.findIndex((s) => available >= s.min);
  if (stage < 0) stage = LAST;
  if (previous !== undefined && stage !== previous) {
    const edge = CHIP_STAGES[Math.min(stage, previous)].min;
    if (Math.abs(available - edge) < HYSTERESIS) return previous;
  }
  return stage;
}

/** The session name keeps 150px until the last stage, then gives way down to 40px. */
export function nameMaxWidth(stage: number, rowWidth: number): number {
  if (stage < LAST) return NAME_MAX;
  return Math.max(40, Math.min(NAME_MAX, rowWidth - BAR - GAPS - CHIP_MIN));
}

/** prefix/…end when the first "/" is within 8 characters, otherwise …end. */
export function midTrunc(name: string, max: number): string {
  if (max <= 0) return '';
  if (name.length <= max) return name;
  const slash = name.indexOf('/');
  if (slash >= 0 && slash < 8 && max >= 10) {
    const keep = Math.max(3, max - slash - 2);
    return `${name.slice(0, slash + 1)}…${name.slice(-keep)}`;
  }
  return `…${name.slice(-(max - 1))}`;
}

export interface ChipOperation { kind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect'; step?: number; total?: number }

export interface ChipSummary {
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base: { ref: string; ahead: number } | null;
  operation: ChipOperation | null;
  paths: number;
  untrackedScan: 'normal' | 'off';
  stale: boolean;
}

export interface ChipView {
  icon: 'branch' | 'commit';
  branch: string;
  dirty: string;
  ahead: { text: string; base: boolean } | null;
  operation: ChipOperation | null;
  tone: 'normal' | 'warn' | 'stale';
  showCwd: boolean;
  showTime: boolean;
}

export function chipView(s: ChipSummary | null, stage: number, isRepo: boolean): ChipView {
  const showCwd = !isRepo || stage <= 1;
  const showTime = !isRepo || stage <= 3;
  if (!s) return { icon: 'branch', branch: '', dirty: '', ahead: null, operation: null, tone: 'normal', showCwd, showTime };
  const chars = CHIP_STAGES[Math.min(Math.max(stage, 0), LAST)].chars;
  const branch = s.detached ? (chars ? (s.head ?? '').slice(0, 7) : '') : midTrunc(s.branch ?? '', chars);
  const dirty = s.paths > 0 ? `●${s.paths > 99 ? '99+' : s.paths}${s.untrackedScan === 'off' ? '+' : ''}` : '';
  let ahead: ChipView['ahead'] = null;
  if (s.upstream) {
    const text = `${stage <= 4 && s.ahead ? `↑${s.ahead}` : ''}${stage === 0 && s.behind ? `↓${s.behind}` : ''}`;
    if (text) ahead = { text, base: false };
  } else if (s.base && s.base.ahead > 0 && stage <= 4) {
    ahead = { text: `≈↑${s.base.ahead}`, base: true };
  }
  const tone: ChipView['tone'] = s.stale ? 'stale' : s.detached || s.operation ? 'warn' : 'normal';
  return { icon: s.detached ? 'commit' : 'branch', branch, dirty, ahead, operation: s.operation && stage <= 4 ? s.operation : null, tone, showCwd, showTime };
}

// FR-MSG-012 AC-1: when the storage PC was unreachable, as member PCs report it. Kept as sorted,
// merged intervals inside the 7-day window, so repeated or overlapping reports do not pile up.

export interface OfflineReport { from: string; to: string }

export const OFFLINE_WINDOW_MS = 7 * 24 * 3_600_000;

/** The reports with one more interval, merged with any it overlaps or touches; older than 7 days dropped. */
export function addOfflineReport(reports: readonly OfflineReport[], added: { from: number; to: number }, now: number): OfflineReport[] {
  const intervals = [...reports.map((report) => ({ from: Date.parse(report.from), to: Date.parse(report.to) })), added]
    .filter((interval) => interval.to > now - OFFLINE_WINDOW_MS)
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged.map((interval) => ({ from: new Date(interval.from).toISOString(), to: new Date(interval.to).toISOString() }));
}

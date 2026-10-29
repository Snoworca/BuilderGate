// FR-LOOP-002: when a loop runs. Every time is the server's local time — a schedule written as
// "08:30" means 08:30 on the machine that runs it.

/** `HH:MM`, 24-hour. */
export type LoopTime = string;

export type LoopSchedule =
  /** Days are 0 (Sunday) to 6 (Saturday), as `Date.getDay()` numbers them. */
  | { kind: 'weekly'; days: number[]; times: LoopTime[] }
  /** Dates are 1–31; `lastDay` adds each month's own last day. */
  | { kind: 'monthly'; dates: number[]; lastDay: boolean; times: LoopTime[] }
  /** `date` is `YYYY-MM-DD`. */
  | { kind: 'once'; date: string; times: LoopTime[] }
  /** Counts on from `startsAt` (`YYYY-MM-DDTHH:MM`) across midnight. */
  | { kind: 'interval'; everyMinutes: number; startsAt: string };

/** Far enough to reach the next 29 February from any day. */
const SEARCH_DAYS = 366 * 8 + 2;

/** The first run strictly after `after`, or null when the schedule has none left. */
export function nextRunAfter(schedule: LoopSchedule, after: Date): Date | null {
  if (schedule.kind === 'interval') return nextInterval(schedule, after);
  if (schedule.kind === 'once') {
    const [y, m, d] = schedule.date.split('-').map(Number);
    return firstAfter(dayTimes(y, m - 1, d, schedule.times), after);
  }
  const times = parseTimes(schedule.times);
  if (times.length === 0) return null;
  for (let i = 0; i < SEARCH_DAYS; i += 1) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
    if (!runsOn(schedule, day)) continue;
    const found = firstAfter(dayTimes(day.getFullYear(), day.getMonth(), day.getDate(), schedule.times), after);
    if (found) return found;
  }
  return null;
}

function runsOn(schedule: Extract<LoopSchedule, { kind: 'weekly' | 'monthly' }>, day: Date): boolean {
  if (schedule.kind === 'weekly') return schedule.days.includes(day.getDay());
  const date = day.getDate();
  const lastDate = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
  return schedule.dates.includes(date) || (schedule.lastDay && date === lastDate);
}

function nextInterval(schedule: Extract<LoopSchedule, { kind: 'interval' }>, after: Date): Date | null {
  const start = parseLocalDateTime(schedule.startsAt);
  if (!start || !(schedule.everyMinutes >= 1)) return null;
  if (after < start) return start;
  const step = schedule.everyMinutes * 60_000;
  const passed = Math.floor((after.getTime() - start.getTime()) / step) + 1;
  return new Date(start.getTime() + passed * step);
}

function dayTimes(year: number, month: number, date: number, times: LoopTime[]): Date[] {
  return parseTimes(times).map(([h, m]) => new Date(year, month, date, h, m));
}

function firstAfter(candidates: Date[], after: Date): Date | null {
  const later = candidates.filter((candidate) => candidate > after).sort((a, b) => a.getTime() - b.getTime());
  return later[0] ?? null;
}

function parseTimes(times: LoopTime[]): Array<[number, number]> {
  return times.flatMap((time) => {
    const match = /^(\d{2}):(\d{2})$/u.exec(time);
    return match ? [[Number(match[1]), Number(match[2])] as [number, number]] : [];
  });
}

/** `YYYY-MM-DDTHH:MM` as local time, or null. */
export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return new Date(y, mo - 1, d, h, mi);
}

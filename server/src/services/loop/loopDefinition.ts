// FR-LOOP-001: what a loop is, and the checks a definition passes before it is saved.
import type { ShellType } from '../../types/index.js';
import { nextRunAfter, parseLocalDateTime, type LoopSchedule } from './loopSchedule.js';

export type LoopStep =
  /** One line typed into the shell, then Enter. */
  | { kind: 'command'; text: string }
  /** Text for the agent the steps above started; may span lines. */
  | { kind: 'prompt'; text: string }
  /** Waits exactly this long. */
  | { kind: 'delay'; ms: number }
  /** The server closes the tab. Always the last step. */
  | { kind: 'end' };

/** What the editor sends. */
export interface LoopInput {
  name: string;
  enabled: boolean;
  schedule: LoopSchedule;
  shell: ShellType;
  cwd: string;
  /** Tabs of runs without a session-end step kept open; the oldest beyond this close. */
  keepTabs?: number;
  steps: LoopStep[];
}

export type ValidLoopInput = Required<LoopInput>;

export type LoopInputRejection =
  | 'name' | 'shell' | 'cwd' | 'keepTabs' | 'schedule' | 'interval' | 'startsAt' | 'oncePassed'
  | 'noSteps' | 'emptyText' | 'commandMultiline' | 'delay' | 'endNotLast' | 'step';

export type LoopInputResult = { ok: true; value: ValidLoopInput } | { ok: false; reason: LoopInputRejection };

export const LOOP_NAME_MAX = 64;
export const LOOP_KEEP_TABS_MAX = 16;
export const LOOP_DELAY_MAX_MS = 3_600_000;
export const LOOP_TEXT_MAX = 12_000;
const SHELLS: readonly ShellType[] = ['auto', 'powershell', 'wsl', 'bash', 'zsh', 'sh', 'cmd'];

export function validateLoopInput(input: unknown, now: Date): LoopInputResult {
  const raw = isRecord(input) ? input : {};
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > LOOP_NAME_MAX) return reject('name');
  if (!SHELLS.includes(raw.shell as ShellType)) return reject('shell');
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  if (!cwd) return reject('cwd');
  const keepTabs = raw.keepTabs === undefined ? 1 : raw.keepTabs;
  if (!Number.isInteger(keepTabs) || (keepTabs as number) < 1 || (keepTabs as number) > LOOP_KEEP_TABS_MAX) return reject('keepTabs');

  const schedule = readSchedule(raw.schedule);
  if (typeof schedule === 'string') return reject(schedule);
  const enabled = raw.enabled !== false;
  // A finished one-time loop may still be saved while it is off (renamed, kept for later).
  if (enabled && schedule.kind === 'once' && nextRunAfter(schedule, now) === null) return reject('oncePassed');

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return reject('noSteps');
  const steps: LoopStep[] = [];
  for (const [index, value] of raw.steps.entries()) {
    const step = readStep(value);
    if (typeof step === 'string') return reject(step);
    if (step.kind === 'end' && index !== raw.steps.length - 1) return reject('endNotLast');
    steps.push(step);
  }

  return {
    ok: true,
    value: { name, enabled, schedule, shell: raw.shell as ShellType, cwd, keepTabs: keepTabs as number, steps },
  };
}

function readStep(value: unknown): LoopStep | LoopInputRejection {
  if (!isRecord(value)) return 'step';
  switch (value.kind) {
    case 'command':
    case 'prompt': {
      const text = typeof value.text === 'string' ? value.text : '';
      if (!text.trim() || text.length > LOOP_TEXT_MAX) return 'emptyText';
      if (value.kind === 'command' && /[\r\n]/u.test(text.trim())) return 'commandMultiline';
      return { kind: value.kind, text: value.kind === 'command' ? text.trim() : text };
    }
    case 'delay':
      return Number.isInteger(value.ms) && (value.ms as number) >= 0 && (value.ms as number) <= LOOP_DELAY_MAX_MS
        ? { kind: 'delay', ms: value.ms as number }
        : 'delay';
    case 'end':
      return { kind: 'end' };
    default:
      return 'step';
  }
}

function readSchedule(value: unknown): LoopSchedule | 'schedule' | 'interval' | 'startsAt' {
  if (!isRecord(value)) return 'schedule';
  switch (value.kind) {
    case 'weekly': {
      const days = numbers(value.days, 0, 6);
      const times = timeList(value.times);
      return days && days.length > 0 && times ? { kind: 'weekly', days, times } : 'schedule';
    }
    case 'monthly': {
      const dates = numbers(value.dates, 1, 31);
      const lastDay = value.lastDay === true;
      const times = timeList(value.times);
      return dates && (dates.length > 0 || lastDay) && times ? { kind: 'monthly', dates, lastDay, times } : 'schedule';
    }
    case 'once': {
      const date = typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.date) ? value.date : null;
      const times = timeList(value.times);
      return date && times && parseLocalDateTime(`${date}T00:00`) ? { kind: 'once', date, times } : 'schedule';
    }
    case 'interval': {
      const everyMinutes = value.everyMinutes;
      const startsAt = typeof value.startsAt === 'string' ? value.startsAt : '';
      if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1) return 'interval';
      if (!parseLocalDateTime(startsAt)) return 'startsAt';
      return { kind: 'interval', everyMinutes: everyMinutes as number, startsAt };
    }
    default:
      return 'schedule';
  }
}

function numbers(value: unknown, min: number, max: number): number[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((n) => Number.isInteger(n) && n >= min && n <= max)) return null;
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

/** One or more distinct `HH:MM` times, sorted. */
function timeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid = value.every((time) => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(time));
  return valid ? [...new Set(value as string[])].sort() : null;
}

function reject(reason: LoopInputRejection): LoopInputResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

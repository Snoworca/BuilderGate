// FR-LOOP-006 AC-5: the catalog keys the loop screens show, as literal tables.
import type { MessageKey } from '../../i18n/i18n.ts';
import type { LoopRunReason, LoopRunResult, LoopSchedule, LoopStep } from './loopTypes.ts';

const REJECTIONS = {
  name: 'loop.error.name',
  shell: 'loop.error.shell',
  cwd: 'loop.error.cwd',
  keepTabs: 'loop.error.keepTabs',
  schedule: 'loop.error.schedule',
  interval: 'loop.error.interval',
  startsAt: 'loop.error.startsAt',
  oncePassed: 'loop.error.oncePassed',
  noSteps: 'loop.error.noSteps',
  emptyText: 'loop.error.emptyText',
  commandMultiline: 'loop.error.commandMultiline',
  delay: 'loop.error.delay',
  endNotLast: 'loop.error.endNotLast',
  step: 'loop.error.step',
} as const satisfies Record<string, MessageKey>;

/** The message for a reason the server refused a loop with, or null for one it does not know. */
export function loopRejectionMessage(reason: string): MessageKey | null {
  return Object.hasOwn(REJECTIONS, reason) ? REJECTIONS[reason as keyof typeof REJECTIONS] : null;
}

/** Sunday first, as `Date.getDay()` numbers them. */
export const DAY_KEYS = [
  'loop.day.0', 'loop.day.1', 'loop.day.2', 'loop.day.3', 'loop.day.4', 'loop.day.5', 'loop.day.6',
] as const satisfies readonly MessageKey[];

export const MODE_KEYS = {
  weekly: 'loop.mode.weekly',
  monthly: 'loop.mode.monthly',
  once: 'loop.mode.once',
  interval: 'loop.mode.interval',
} as const satisfies Record<LoopSchedule['kind'], MessageKey>;

export const STEP_KEYS = {
  command: 'loop.step.command',
  prompt: 'loop.step.prompt',
  delay: 'loop.step.delay',
  end: 'loop.step.end',
} as const satisfies Record<LoopStep['kind'], MessageKey>;

export const RESULT_KEYS = {
  running: 'loop.result.running',
  success: 'loop.result.success',
  failed: 'loop.result.failed',
  skipped: 'loop.result.skipped',
  aborted: 'loop.result.aborted',
} as const satisfies Record<LoopRunResult, MessageKey>;

/** Why a run did not succeed; `directoryMissing` and `error` take `{detail}`. */
export const RUN_REASON_KEYS = {
  previousRunning: 'loop.reason.previousRunning',
  tabCap: 'loop.reason.tabCap',
  directoryMissing: 'loop.reason.directoryMissing',
  cancelled: 'loop.reason.cancelled',
  tabClosed: 'loop.reason.tabClosed',
  restart: 'loop.reason.restart',
  inputRejected: 'loop.reason.inputRejected',
  error: 'loop.reason.error',
} as const satisfies Record<LoopRunReason, MessageKey>;

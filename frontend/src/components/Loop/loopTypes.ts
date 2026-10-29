// FR-LOOP-001/002: the loop as the server stores it (server/src/services/loop/loopDefinition.ts).

export type LoopSchedule =
  /** Days are 0 (Sunday) to 6 (Saturday). Times are `HH:MM`. */
  | { kind: 'weekly'; days: number[]; times: string[] }
  | { kind: 'monthly'; dates: number[]; lastDay: boolean; times: string[] }
  /** `date` is `YYYY-MM-DD`. */
  | { kind: 'once'; date: string; times: string[] }
  /** Counts on from `startsAt` (`YYYY-MM-DDTHH:MM`). */
  | { kind: 'interval'; everyMinutes: number; startsAt: string };

export type LoopStep =
  | { kind: 'command'; text: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'delay'; ms: number }
  | { kind: 'end' };

export type LoopShell = 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';

export interface LoopInput {
  name: string;
  enabled: boolean;
  schedule: LoopSchedule;
  shell: LoopShell;
  cwd: string;
  keepTabs: number;
  steps: LoopStep[];
}

export type LoopRunResult = 'running' | 'success' | 'failed' | 'skipped' | 'aborted';

export type LoopRunReason =
  | 'previousRunning' | 'tabCap' | 'directoryMissing' | 'cancelled' | 'tabClosed' | 'restart' | 'inputRejected' | 'error';

export interface LoopRun {
  id: string;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  result: LoopRunResult;
  stepsSent: number;
  totalSteps: number;
  workspaceId: string | null;
  workspaceName: string | null;
  tabId: string | null;
  tabName: string | null;
  reason: LoopRunReason | null;
  /** The folder or the error's own text, for `directoryMissing` and `error`. */
  detail: string | null;
}

export interface LoopView extends LoopInput {
  id: string;
  nextRunAt: string | null;
  lastRun: LoopRun | null;
}

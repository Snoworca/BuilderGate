// FR-LOOP-001/002/008: the loop as the server stores it (server/src/services/loop/loopDefinition.ts).

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

/** FR-LOOP-008 AC-1: where a run sends its steps. */
export type LoopTarget =
  | { kind: 'new'; shell: LoopShell; cwd: string; keepTabs: number }
  | { kind: 'session'; tabId: string; label: { workspaceName: string; tabName: string }; skipWhenBusy: boolean };

export type LoopTargetKind = LoopTarget['kind'];

export interface LoopInput {
  name: string;
  enabled: boolean;
  schedule: LoopSchedule;
  target: LoopTarget;
  steps: LoopStep[];
}

/** FR-LOOP-008 AC-7: a tab an existing-session loop can be pointed at (GET /api/loops/sessions). */
export interface LoopSessionOption {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string;
  shell: string;
  alive: boolean;
  agent: { kind: string; status: string } | null;
}

export type LoopRunResult = 'running' | 'success' | 'failed' | 'skipped' | 'aborted';

export type LoopRunReason =
  | 'previousRunning' | 'tabCap' | 'directoryMissing' | 'cancelled' | 'tabClosed' | 'restart' | 'inputRejected' | 'error'
  | 'sessionMissing' | 'sessionStopped' | 'agentBusy';

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
  /** FR-LOOP-008 AC-9: whether the run's tab is still open (history reads only). */
  tabOpen?: boolean;
}

export interface LoopView extends LoopInput {
  id: string;
  nextRunAt: string | null;
  lastRun: LoopRun | null;
  /** FR-LOOP-008 AC-7: an existing-session loop whose tab is gone. */
  targetMissing: boolean;
}

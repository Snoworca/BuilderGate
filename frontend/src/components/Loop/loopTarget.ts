// FR-LOOP-008: the existing-session target's rules for the loop editor and list, apart from React.
import type { MessageKey } from '../../i18n/i18n.ts';
import type { ChipTone } from '../ui/uiClasses.ts';
import { agentName } from '../Messenger/messengerModel.ts';
import type { LoopInput, LoopRun, LoopSessionOption, LoopStep, LoopTargetKind, LoopView } from './loopTypes.ts';

/** The agent states the server counts as working (server LoopService AGENT_WORKING, AC-5). */
const AGENT_WORKING = new Set(['busy', 'starting', 'running']);

export interface SessionStatus {
  key: MessageKey;
  params?: Record<string, string>;
  tone: ChipTone;
}

/** AC-8: 「Claude 작업 중」, 「Codex 입력 대기」, 「에이전트 없음」 or 「셸 종료됨」. */
export function sessionStatus(option: LoopSessionOption): SessionStatus {
  if (!option.alive) return { key: 'loop.session.stopped', tone: 'danger' };
  if (!option.agent) return { key: 'loop.session.noAgent', tone: 'neutral' };
  const params = { agent: agentName(option.agent.kind) };
  return AGENT_WORKING.has(option.agent.status)
    ? { key: 'loop.session.agentWorking', params, tone: 'accent' }
    : { key: 'loop.session.agentWaiting', params, tone: 'ok' };
}

export interface SessionGroup {
  workspaceId: string;
  name: string;
  options: Array<{ tabId: string; name: string; disabled: boolean; session: LoopSessionOption }>;
}

/**
 * AC-8: one optgroup per workspace, in the order the server lists them (workspace screen order,
 * then tab order). A tab whose shell ended is shown but cannot be chosen. Two tabs with the same
 * name in one workspace get their folder's last name added: 「빌드 감시 (orbit-api)」.
 */
export function sessionGroups(sessions: readonly LoopSessionOption[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  for (const session of sessions) {
    let group = groups.find((entry) => entry.workspaceId === session.workspaceId);
    if (!group) {
      group = { workspaceId: session.workspaceId, name: session.workspaceName, options: [] };
      groups.push(group);
    }
    group.options.push({ tabId: session.tabId, name: session.tabName, disabled: !session.alive, session });
  }
  for (const group of groups) {
    for (const entry of group.options) {
      const shared = group.options.filter((other) => other.session.tabName === entry.session.tabName).length > 1;
      if (shared) entry.name = `${entry.session.tabName} (${folderName(entry.session.cwd)})`;
    }
  }
  return groups;
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).filter((part) => part !== '').at(-1) ?? cwd;
}

/** AC-8: an existing-session loop never closes the user's session. */
export function canAddStepKind(kind: LoopStep['kind'], target: LoopTargetKind): boolean {
  return !(kind === 'end' && target === 'session');
}

export type SaveBlocker = 'emptyText' | 'endNotAllowed' | 'noSession' | 'noSessions';

/** AC-8: what keeps a loop from being saved, checked before the server is asked. */
export function saveBlocker(draft: LoopInput, sessions: readonly LoopSessionOption[]): SaveBlocker | null {
  // FR-LOOP-001 AC-3: caught here rather than after the server's 400.
  if (draft.steps.some((step) => (step.kind === 'command' || step.kind === 'prompt') && step.text.trim() === '')) return 'emptyText';
  if (draft.target.kind !== 'session') return null;
  if (draft.steps.some((step) => step.kind === 'end')) return 'endNotAllowed';
  if (draft.target.tabId === '') return hasChoosableSession(sessions) ? 'noSession' : 'noSessions';
  return null;
}

/** AC-8: whether any tab can be chosen; tabs whose shell ended cannot. */
export function hasChoosableSession(sessions: readonly LoopSessionOption[]): boolean {
  return sessions.some((session) => session.alive);
}

/** AC-8 (Q3): how many other loops send into this tab. */
export function loopsOnSameTab(loops: readonly LoopView[], tabId: string, selfId: string | null): number {
  return loops.filter((loop) => loop.id !== selfId && loop.target.kind === 'session' && loop.target.tabId === tabId).length;
}

/** AC-9: the list row's target — 「ProjectMaster : api-server」, or the shell and folder of a new session. */
export function targetSummary(loop: LoopView): { kind: LoopTargetKind; text: string; missing: boolean } {
  const target = loop.target;
  if (target.kind === 'session') {
    return { kind: 'session', text: `${target.label.workspaceName} : ${target.label.tabName}`, missing: loop.targetMissing };
  }
  return { kind: 'new', text: `${target.shell} · ${target.cwd}`, missing: false };
}

/** The definition fields of a listed loop, as the editor saves them. */
export function toLoopInput(loop: LoopView): LoopInput {
  const { name, enabled, schedule, target, steps } = loop;
  return { name, enabled, schedule, target, steps };
}

/** AC-9: 「탭 열기」 for a run whose tab is still open (the server says so per run), whatever the loop's target. */
export function canOpenRunTab(run: { tabId: string | null; tabOpen?: boolean }): boolean {
  return run.tabId !== null && run.tabOpen === true;
}

const SKIP_REASON_KEYS = {
  previousRunning: 'loop.reasonShort.previousRunning',
  tabCap: 'loop.reasonShort.tabCap',
  sessionMissing: 'loop.reasonShort.sessionMissing',
  sessionStopped: 'loop.reasonShort.sessionStopped',
  agentBusy: 'loop.reasonShort.agentBusy',
} as const satisfies Partial<Record<NonNullable<LoopRun['reason']>, MessageKey>>;

/** AC-9: the short why after 「건너뜀」 in the list's last-result column; null when there is none. */
export function lastResultReason(run: LoopRun | null): MessageKey | null {
  if (!run || run.result !== 'skipped' || run.reason === null) return null;
  return Object.hasOwn(SKIP_REASON_KEYS, run.reason) ? SKIP_REASON_KEYS[run.reason as keyof typeof SKIP_REASON_KEYS] : null;
}

/** AC-8: when the loop was turned off for a missing session — the start of that run. */
export function missingSince(run: LoopRun | null): string | null {
  return run?.reason === 'sessionMissing' ? run.startedAt : null;
}

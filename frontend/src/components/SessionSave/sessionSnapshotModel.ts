import { t } from '../../i18n/i18n.ts';

// FR-AITUI-009 — the rules the session save and resume screens apply, kept
// apart from the components so they can be judged without a DOM.

export type AgentKind = 'claude' | 'codex' | 'hermes' | 'opencode';
export type ResolveConfidence = 'exact' | 'estimated';
export type SnapshotRestoreState = 'pending' | 'restored' | 'skipped' | 'failed';

export interface AgentTabCandidate {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  agent: AgentKind;
}

export interface SnapshotEntry {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  agent: AgentKind;
  sessionId: string;
  method: string;
  confidence: ResolveConfidence;
  resumeCommand: string;
  resumeArguments: string[];
  restore: SnapshotRestoreState;
  processedAt?: string;
}

export interface SessionSnapshot {
  version: 1;
  savedAt: string;
  entries: SnapshotEntry[];
}

export interface SnapshotStatus {
  snapshot: SessionSnapshot | null;
  pendingCount: number;
  /** Pending entries carried over from before a restart — the ones to offer. */
  restorable: boolean;
}

export interface SaveResultItem {
  tabId: string;
  tabName: string;
  workspaceName: string;
  agent: AgentKind | null;
  status: 'found' | 'not-found';
  sessionId?: string;
  confidence?: ResolveConfidence;
  method?: string;
}

export const AGENT_LABELS: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  hermes: 'Hermes',
  opencode: 'OpenCode',
};

export function groupByWorkspace<T extends { workspaceId: string; workspaceName: string }>(
  items: readonly T[],
): Array<{ workspaceId: string; workspaceName: string; items: T[] }> {
  const groups: Array<{ workspaceId: string; workspaceName: string; items: T[] }> = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const at = index.get(item.workspaceId);
    if (at === undefined) {
      index.set(item.workspaceId, groups.length);
      groups.push({ workspaceId: item.workspaceId, workspaceName: item.workspaceName, items: [item] });
    } else {
      groups[at].items.push(item);
    }
  }
  return groups;
}

export function pendingEntries(status: SnapshotStatus | null): SnapshotEntry[] {
  return status?.snapshot?.entries.filter((entry) => entry.restore === 'pending') ?? [];
}

/** FR-AITUI-009 AC-4: an estimated id waits for the user to check it. */
export function defaultRestoreSelection(entries: readonly SnapshotEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.confidence === 'exact').map((entry) => entry.tabId));
}

export function summarizeSaveResults(results: readonly SaveResultItem[]): { exact: number; estimated: number; notFound: number } {
  let exact = 0;
  let estimated = 0;
  let notFound = 0;
  for (const result of results) {
    if (result.status !== 'found') notFound += 1;
    else if (result.confidence === 'exact') exact += 1;
    else estimated += 1;
  }
  return { exact, estimated, notFound };
}

function quoteForPreview(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

export function resumeCommandPreview(entry: Pick<SnapshotEntry, 'resumeCommand' | 'resumeArguments'>): string {
  return [entry.resumeCommand, ...entry.resumeArguments].map(quoteForPreview).join(' ');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatSavedAt(iso: string, now: Date = new Date(), options: { omitToday?: boolean } = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return options.omitToday ? time : t('sessionSave.savedAt.today', { time });
  return t('sessionSave.savedAt.date', { month: at.getMonth() + 1, day: at.getDate(), time });
}

export type SaveButtonState =
  | { kind: 'save'; badge: number; disabled: boolean }
  | { kind: 'saved'; label: string; badge: number }
  | { kind: 'pending'; count: number };

/** FR-AITUI-009 AC-1: one header button, three faces. */
/**
 * FR-AITUI-009 AC-6: what the save button offers changes when a tab gains or
 * loses its AI command, so this is the key to read the candidates again on.
 */
export function aiTabSignature(tabs: ReadonlyArray<{ id: string; recoveryCommand?: string }>): string {
  return tabs.map(tab => `${tab.id}:${tab.recoveryCommand ?? ''}`).join('|');
}

export function saveButtonState(input: { candidateCount: number; status: SnapshotStatus | null; now?: Date }): SaveButtonState {
  const status = input.status;
  if (status && status.restorable && status.pendingCount > 0) {
    return { kind: 'pending', count: status.pendingCount };
  }
  if (status?.snapshot && status.pendingCount > 0) {
    const label = formatSavedAt(status.snapshot.savedAt, input.now ?? new Date(), { omitToday: true });
    return { kind: 'saved', label: t('sessionSave.button.savedLabel', { time: label }), badge: input.candidateCount };
  }
  return { kind: 'save', badge: input.candidateCount, disabled: input.candidateCount === 0 };
}

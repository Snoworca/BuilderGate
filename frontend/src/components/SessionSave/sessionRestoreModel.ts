import { activeLanguage, t } from '../../i18n/i18n.ts';
import { AGENT_LABELS, type AgentKind, type SnapshotEntry } from './sessionSnapshotModel.ts';

// FR-AITUI-016..FR-AITUI-018 — the rules the restore tab and the restore notice
// apply, kept apart from the components so they can be judged without a DOM.

export type SnapshotOrigin = 'manual' | 'auto';

/** FR-AITUI-017 AC-4: one line of the list. */
export interface SnapshotSummary {
  id: string;
  origin: SnapshotOrigin;
  savedAt: string;
  tabCount: number;
  agentCounts: Partial<Record<AgentKind, number>>;
  /** The save the last server start restored. */
  usedForRestore: boolean;
}

export interface SnapshotList {
  manual: SnapshotSummary[];
  auto: SnapshotSummary | null;
  retention: number;
}

/** FR-AITUI-018 AC-6: an entry, and where restoring it by hand types its command. */
export interface PlannedEntry extends SnapshotEntry {
  /** FR-AITUI-016 AC-3: what ran in a shell entry's tab. */
  runningCommand?: string;
  target: 'tab' | 'new-tab';
  targetReason: 'idle' | 'busy' | 'missing';
}

export interface SnapshotDetail {
  id: string;
  origin: SnapshotOrigin;
  savedAt: string;
  entries: PlannedEntry[];
}

/** FR-AITUI-018 AC-5: one entry the user picked. */
export interface HandRestoreItem {
  tabId: string;
  includeCommand: boolean;
}

/** FR-AITUI-016 AC-8 / FR-AITUI-018 AC-2/AC-3: the parts of the status the restore tab and notice read. */
export interface SessionSaveStatusFields {
  report?: ReadonlyArray<unknown>;
  reportId?: string | null;
  reportNoticeShown?: boolean;
  reportSource?: { origin: SnapshotOrigin; id: string; savedAt: string } | null;
  autoSave?: { enabled: boolean; intervalMinutes: number; lastAt: string | null; lastResult: 'saved' | 'skipped' | 'deferred' | 'failed' | null };
}

const AGENT_ORDER: readonly AgentKind[] = ['claude', 'codex', 'hermes', 'opencode'];

export function agentCountsText(counts: Partial<Record<AgentKind, number>>): string {
  return AGENT_ORDER
    .filter((agent) => (counts[agent] ?? 0) > 0)
    .map((agent) => `${AGENT_LABELS[agent]} ${counts[agent]}`)
    .join(' · ');
}

/** FR-I18N-008: a day as the active UI language writes it, e.g. 10월 8일 (목) / Thu, October 8. */
export function dayLabelOf(day: Date): string {
  return new Intl.DateTimeFormat(activeLanguage() || 'en', { month: 'long', day: 'numeric', weekday: 'short' }).format(day);
}

export function timeLabelOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(activeLanguage() || 'en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

/** FR-AITUI-018 AC-4: the manual saves by day, newest first; today and yesterday are named. */
export function groupManualByDay(
  manual: readonly SnapshotSummary[],
  now: Date = new Date(),
): Array<{ key: string; label: string; items: SnapshotSummary[] }> {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const sorted = [...manual].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  const groups: Array<{ key: string; label: string; items: SnapshotSummary[] }> = [];
  for (const item of sorted) {
    const at = new Date(item.savedAt);
    const key = dayKey(at);
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      const date = dayLabelOf(at);
      const label = key === today
        ? t('sessionSave.restore.today', { date })
        : key === yesterday ? t('sessionSave.restore.yesterday', { date }) : date;
      group = { key, label, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** FR-AITUI-018 AC-5: every entry unless unticked; a running command only when its own box is ticked. */
export function restoreItems(
  entries: readonly PlannedEntry[],
  unpicked: ReadonlySet<string>,
  commandOn: ReadonlySet<string>,
): HandRestoreItem[] {
  return entries
    .filter((entry) => !unpicked.has(entry.tabId))
    .map((entry) => ({ tabId: entry.tabId, includeCommand: Boolean(entry.runningCommand) && commandOn.has(entry.tabId) }));
}

/**
 * FR-AITUI-018 AC-3: the restore notice is shown by the first client to see this
 * restore's report; once it says so, no reload or other browser shows it again.
 */
export function claimsRestoreNotice(status: SessionSaveStatusFields | null, claimedReportId: string | null): boolean {
  if (!status || !status.reportId) return false;
  if ((status.report?.length ?? 0) === 0) return false;
  if (status.reportNoticeShown !== false) return false;
  return claimedReportId !== status.reportId;
}

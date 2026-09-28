// FR-AITUI-013 / FR-AITUI-014 / FR-AITUI-015 — the rules the all-terminal save
// dialog and the restore report apply, kept apart from the components so they
// can be judged without a DOM.
import type { AgentKind, ResolveConfidence } from './sessionSnapshotModel.ts';

export type SnapshotMode = 'agent' | 'shell' | 'command';
export type LauncherMap = Record<AgentKind, string[]>;

export interface SessionCandidate {
  sessionId: string;
  startedAtMs: number;
}

/** One terminal as GET /api/session-snapshot/preview describes it. */
export interface PreviewTab {
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  cwd: string | null;
  runningCommand: string | null;
  agent: AgentKind | null;
  launcher: string | null;
  args: string[];
  sessionId: string | null;
  method: string | null;
  confidence: ResolveConfidence | 'missing' | null;
  candidates: SessionCandidate[];
}

export interface SnapshotPreview {
  tabs: PreviewTab[];
  launchers: LauncherMap;
}

/** What the user has chosen for one row. */
export interface RowDraft {
  tabId: string;
  picked: boolean;
  open: boolean;
  mode: SnapshotMode;
  agent: AgentKind | null;
  launcher: string;
  argsText: string;
  sessionId: string;
  command: string;
  edited: boolean;
}

export interface SaveItem {
  tabId: string;
  mode: SnapshotMode;
  agent?: AgentKind;
  launcher?: string;
  args?: string[];
  sessionId?: string;
  command?: string;
}

export type RestoreResult = 'waiting' | 'confirmed' | 'unconfirmed' | 'typed' | 'shell' | 'failed';

export interface RestoreReportItem {
  tabId: string;
  workspaceName: string;
  tabName: string;
  mode: SnapshotMode;
  agent: AgentKind | null;
  cwd: string | null;
  commandLine: string;
  launcher?: string;
  args?: string[];
  sessionId?: string;
  result: RestoreResult;
  reason?: string;
}

export type RowStatus = 'exact' | 'estimated' | 'missing' | 'invalid' | 'edited' | 'shell' | 'command';
export type RowFilter = 'all' | 'review' | 'agent' | 'shell';

const AGENT_ORDER: readonly AgentKind[] = ['claude', 'codex', 'hermes', 'opencode'];

// The same shapes the server accepts (agentSessionResolver.isValidAgentSessionId).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
const HERMES_ID = /^\d{8}_\d{6}_[0-9a-f]{6}$/;
const OPENCODE_ID = /^ses_[0-9A-Za-z]{26}$/;

export function isValidSessionId(agent: AgentKind, id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  switch (agent) {
    case 'claude': return UUID.test(id) || CLAUDE_NAME.test(id);
    case 'codex': return UUID.test(id);
    case 'hermes': return HERMES_ID.test(id);
    case 'opencode': return OPENCODE_ID.test(id);
    default: return false;
  }
}

export function selectorFor(agent: AgentKind, sessionId: string): string[] {
  if (agent === 'codex') return ['resume', sessionId];
  if (agent === 'opencode') return ['--session', sessionId];
  return ['--resume', sessionId];
}

/** Splits an arguments field on spaces, keeping "double" and 'single' quoted runs together. */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current) out.push(current);
  return out;
}

export function joinArgs(args: readonly string[]): string {
  return args.map((arg) => (arg === '' || /\s/.test(arg) ? `"${arg}"` : arg)).join(' ');
}

export function initialDraft(tab: PreviewTab): RowDraft {
  if (tab.agent) {
    return {
      tabId: tab.tabId,
      picked: true,
      open: tab.confidence !== 'exact',
      mode: 'agent',
      agent: tab.agent,
      launcher: tab.launcher ?? tab.agent,
      argsText: joinArgs(tab.args),
      sessionId: tab.sessionId ?? '',
      command: '',
      edited: false,
    };
  }
  return {
    tabId: tab.tabId,
    picked: true,
    open: false,
    mode: 'shell',
    agent: null,
    launcher: '',
    argsText: '',
    sessionId: '',
    command: tab.runningCommand ?? '',
    edited: false,
  };
}

export function rowStatus(tab: PreviewTab, draft: RowDraft): RowStatus {
  if (draft.mode === 'shell') return 'shell';
  if (draft.mode === 'command') return 'command';
  if (!draft.agent) return 'shell';
  if (!draft.sessionId) return 'missing';
  if (!isValidSessionId(draft.agent, draft.sessionId)) return 'invalid';
  const untouched = !draft.edited && draft.sessionId === tab.sessionId && draft.agent === tab.agent;
  if (untouched && (tab.confidence === 'exact' || tab.confidence === 'estimated')) return tab.confidence;
  return 'edited';
}

export function needsReview(tab: PreviewTab, draft: RowDraft): boolean {
  const status = rowStatus(tab, draft);
  return status === 'estimated' || status === 'missing' || status === 'invalid';
}

export function rowMatchesFilter(filter: RowFilter, tab: PreviewTab, draft: RowDraft): boolean {
  if (filter === 'review') return needsReview(tab, draft);
  if (filter === 'agent') return draft.mode === 'agent';
  if (filter === 'shell') return draft.mode !== 'agent';
  return true;
}

/** The line typed into the shell after the restart, or none for a shell only. */
export function restoreCommandPreview(draft: RowDraft): { text: string; shellOnly: boolean } {
  if (draft.mode === 'command') {
    const text = draft.command.trim();
    return { text, shellOnly: text.length === 0 };
  }
  if (draft.mode === 'shell' || !draft.agent || !draft.sessionId) return { text: '', shellOnly: true };
  const parts = [draft.launcher || draft.agent, ...parseArgs(draft.argsText), ...selectorFor(draft.agent, draft.sessionId)];
  return { text: joinArgs(parts), shellOnly: false };
}

export function toSaveItem(draft: RowDraft): SaveItem {
  if (draft.mode === 'command') return { tabId: draft.tabId, mode: 'command', command: draft.command.trim() };
  if (draft.mode === 'shell' || !draft.agent) return { tabId: draft.tabId, mode: 'shell' };
  return {
    tabId: draft.tabId,
    mode: 'agent',
    agent: draft.agent,
    launcher: draft.launcher || draft.agent,
    args: parseArgs(draft.argsText),
    sessionId: draft.sessionId.trim(),
  };
}

export function launcherOptions(
  launchers: LauncherMap,
  current?: { agent: AgentKind | null; launcher: string },
): Array<{ agent: AgentKind; launchers: string[] }> {
  return AGENT_ORDER.map((agent) => {
    const names = launchers[agent]?.length ? [...launchers[agent]] : [agent];
    // The row's own launcher stays selectable, so the select never shows a command it will not run.
    if (current?.agent === agent && current.launcher && !names.includes(current.launcher)) names.push(current.launcher);
    return { agent, launchers: names };
  });
}

/** FR-AITUI-015 AC-6: the retry editor starts from what was tried. */
export function draftFromReport(item: RestoreReportItem): RowDraft {
  if (item.mode === 'agent' && item.agent) {
    return {
      tabId: item.tabId, picked: true, open: true, mode: 'agent', agent: item.agent,
      launcher: item.launcher ?? item.agent, argsText: joinArgs(item.args ?? []), sessionId: item.sessionId ?? '', command: '', edited: false,
    };
  }
  return {
    tabId: item.tabId, picked: true, open: true, mode: item.mode === 'command' ? 'command' : 'shell', agent: null,
    launcher: '', argsText: '', sessionId: '', command: item.mode === 'command' ? item.commandLine : '', edited: false,
  };
}

export function isRetryable(item: RestoreReportItem): boolean {
  return item.result === 'failed' || item.result === 'unconfirmed';
}

export function summarizeReport(report: readonly RestoreReportItem[]): { resumed: number; failed: number; shell: number; waiting: number } {
  let resumed = 0;
  let failed = 0;
  let shell = 0;
  let waiting = 0;
  for (const item of report) {
    if (item.result === 'confirmed' || item.result === 'typed') resumed += 1;
    else if (item.result === 'failed' || item.result === 'unconfirmed') failed += 1;
    else if (item.result === 'shell') shell += 1;
    else waiting += 1;
  }
  return { resumed, failed, shell, waiting };
}

/** FR-AITUI-015 AC-6: the banner goes away on its own only when nothing is left to look at. */
export function reportAutoDismissMs(report: readonly RestoreReportItem[]): number | null {
  if (report.length === 0) return null;
  const summary = summarizeReport(report);
  return summary.failed === 0 && summary.waiting === 0 ? 5000 : null;
}

// FR-USAGE-004 / FR-USAGE-006: the rules that turn usage readings into bars and alerts. No I/O.

export type UsageAgent = 'claude' | 'codex';
export type UsageWindowKind = 'fiveHour' | 'weekly';
export type UsageSource = 'windows' | 'wsl' | 'local';
export type UsageLevel = 'plenty' | 'low' | 'critical';

export interface UsageWindowReading {
  /** 0–100. */
  usedPercent: number;
  /** Epoch ms, or null when the agent gave none. */
  resetsAt: number | null;
}

/** One agent account's latest limits as one source recorded them. */
export interface UsageReading {
  agent: UsageAgent;
  /** A hash of the account identity; null when the record names no account. */
  accountKey: string | null;
  /** Shown masked only. */
  email: string | null;
  plan: string | null;
  source: UsageSource;
  /** Epoch ms of the record. */
  observedAt: number;
  windows: Partial<Record<UsageWindowKind, UsageWindowReading>>;
}

export interface UsageDisplayPrefs {
  nicknames: Record<string, string>;
  hidden: string[];
}

export interface UsageWindowView {
  kind: UsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  level: UsageLevel;
  resetsAt: number | null;
  /** The reset time has passed since the reading; shown as 0 % and reset. */
  reset: boolean;
}

export interface UsageAccountView {
  accountKey: string | null;
  unknownAccount: boolean;
  label: string;
  source: UsageSource;
  observedAt: number;
  stale: boolean;
  windows: UsageWindowView[];
}

export interface UsageView {
  agents: Array<{ agent: UsageAgent; accounts: UsageAccountView[] }>;
}

/** Remaining at or above this is plenty; below LOW_REMAINING is critical (FR-USAGE-004 AC-3). */
export const PLENTY_REMAINING = 40;
export const LOW_REMAINING = 15;
/** FR-USAGE-004 AC-5. */
export const STALE_AFTER_MS = 3_600_000;
const WINDOW_ORDER: readonly UsageWindowKind[] = ['fiveHour', 'weekly'];
const AGENT_ORDER: readonly UsageAgent[] = ['claude', 'codex'];

export function levelFor(usedPercent: number): UsageLevel {
  const remaining = 100 - usedPercent;
  if (remaining >= PLENTY_REMAINING) return 'plenty';
  return remaining >= LOW_REMAINING ? 'low' : 'critical';
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

const groupKey = (reading: UsageReading) => `${reading.agent}\u0000${reading.accountKey ?? `?${reading.source}`}`;

/** Reset times this close apart are the same window of the same quota. */
const SAME_RESET_TOLERANCE_MS = 5000;

/**
 * FR-USAGE-004 AC-1: one reading per agent account — the newest. Unknown accounts stay per source.
 * Two account keys that report the same quota (every window at the same use, resetting within
 * 5 s) are one bar: Codex was measured on 2026-10-31 writing two creator_account_id values whose
 * weekly limits matched to the second. The smallest key is kept so a nickname stays put.
 */
export function mergeReadings(readings: readonly UsageReading[]): UsageReading[] {
  const newest = new Map<string, UsageReading>();
  for (const reading of readings) {
    const key = groupKey(reading);
    const current = newest.get(key);
    if (!current || reading.observedAt > current.observedAt) newest.set(key, reading);
  }
  const kept: UsageReading[] = [];
  const ordered = [...newest.values()].sort((a, b) => (a.accountKey ?? '\uffff').localeCompare(b.accountKey ?? '\uffff'));
  for (const reading of ordered) {
    const twin = reading.accountKey === null ? undefined : kept.find((other) => other.accountKey !== null && sameQuota(other, reading));
    if (twin) twin.observedAt = Math.max(twin.observedAt, reading.observedAt);
    else kept.push({ ...reading });
  }
  return kept;
}

function sameQuota(a: UsageReading, b: UsageReading): boolean {
  if (a.agent !== b.agent) return false;
  const kinds = new Set([...Object.keys(a.windows), ...Object.keys(b.windows)]) as Set<UsageWindowKind>;
  if (kinds.size === 0) return false;
  for (const kind of kinds) {
    const x = a.windows[kind];
    const y = b.windows[kind];
    if (!x || !y || x.usedPercent !== y.usedPercent || x.resetsAt === null || y.resetsAt === null) return false;
    if (Math.abs(x.resetsAt - y.resetsAt) > SAME_RESET_TOLERANCE_MS) return false;
  }
  return true;
}

/** The window as it stands now: a passed reset reads empty. */
function currentWindow(window: UsageWindowReading, now: number): { usedPercent: number; reset: boolean } {
  const reset = window.resetsAt !== null && window.resetsAt <= now;
  return { usedPercent: reset ? 0 : clampPercent(window.usedPercent), reset };
}

export function labelFor(reading: UsageReading, prefs: UsageDisplayPrefs): string {
  const nickname = reading.accountKey ? prefs.nicknames[reading.accountKey]?.trim() : '';
  if (nickname) return nickname;
  const plan = reading.plan ? reading.plan.charAt(0).toUpperCase() + reading.plan.slice(1) : null;
  const email = reading.email ? maskEmail(reading.email) : null;
  if (plan || email) return [plan, email].filter(Boolean).join(' · ');
  return reading.accountKey ? `#${reading.accountKey.slice(0, 8)}` : '';
}

export function toUsageView(readings: readonly UsageReading[], prefs: UsageDisplayPrefs, now: number): UsageView {
  const agents: UsageView['agents'] = [];
  const merged = mergeReadings(readings).filter((reading) => !reading.accountKey || !prefs.hidden.includes(reading.accountKey));
  for (const agent of AGENT_ORDER) {
    const accounts = merged
      .filter((reading) => reading.agent === agent)
      .map((reading): UsageAccountView => ({
        accountKey: reading.accountKey,
        unknownAccount: reading.accountKey === null,
        label: labelFor(reading, prefs),
        source: reading.source,
        observedAt: reading.observedAt,
        stale: now - reading.observedAt > STALE_AFTER_MS,
        windows: WINDOW_ORDER.flatMap((kind) => {
          const window = reading.windows[kind];
          if (!window) return [];
          const current = currentWindow(window, now);
          return [{
            kind,
            usedPercent: current.usedPercent,
            remainingPercent: 100 - current.usedPercent,
            level: levelFor(current.usedPercent),
            resetsAt: window.resetsAt,
            reset: current.reset,
          }];
        }),
      }))
      .filter((account) => account.windows.length > 0)
      .sort((a, b) => Number(a.unknownAccount) - Number(b.unknownAccount) || a.label.localeCompare(b.label));
    if (accounts.length > 0) agents.push({ agent, accounts });
  }
  return { agents };
}

export interface UsageAlertSettings {
  /** Alert when remaining is below this (1–99). */
  thresholdPercent: number;
  agents: readonly UsageAgent[];
  windows: readonly UsageWindowKind[];
  /** Accounts the user hid: still remembered, never alerted. */
  hidden?: readonly string[];
}

export interface UsageAlert {
  agent: UsageAgent;
  accountKey: string | null;
  window: UsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: number | null;
  reading: UsageReading;
}

/** Used percent of the last update, per agent · account · window. */
export type LastUsedByWindow = Record<string, number>;

/**
 * FR-USAGE-006 AC-2: below the threshold, every update alerts — unless its used percent equals the
 * previous update's for the same agent, account and window. Every value seen is remembered,
 * alerting or not, so the comparison is always with the previous update.
 */
export function decideAlerts(
  readings: readonly UsageReading[],
  lastUsed: LastUsedByWindow,
  settings: UsageAlertSettings,
  now: number,
): { alerts: UsageAlert[]; lastUsed: LastUsedByWindow } {
  const next: LastUsedByWindow = { ...lastUsed };
  const alerts: UsageAlert[] = [];
  for (const reading of mergeReadings(readings)) {
    for (const kind of WINDOW_ORDER) {
      const window = reading.windows[kind];
      if (!window) continue;
      const { usedPercent } = currentWindow(window, now);
      const key = `${reading.agent}|${reading.accountKey ?? `?${reading.source}`}|${kind}`;
      const previous = lastUsed[key];
      next[key] = usedPercent;
      if (!settings.agents.includes(reading.agent) || !settings.windows.includes(kind)) continue;
      if (reading.accountKey && settings.hidden?.includes(reading.accountKey)) continue;
      const remainingPercent = 100 - usedPercent;
      if (remainingPercent >= settings.thresholdPercent) continue;
      if (previous === usedPercent) continue;
      alerts.push({ agent: reading.agent, accountKey: reading.accountKey, window: kind, usedPercent, remainingPercent, resetsAt: window.resetsAt, reading });
    }
  }
  return { alerts, lastUsed: next };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

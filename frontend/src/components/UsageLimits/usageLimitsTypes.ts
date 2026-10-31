// FR-USAGE-005..007: the usage state the server sends (server/src/services/usage/UsageLimitsService.ts).

export type UsageAgent = 'claude' | 'codex';
export type UsageWindowKind = 'fiveHour' | 'weekly';
export type UsageSource = 'windows' | 'wsl' | 'local';
export type UsageLevel = 'plenty' | 'low' | 'critical';

export interface UsageWindowView {
  kind: UsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  level: UsageLevel;
  resetsAt: number | null;
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

export interface UsageSettingsView {
  showInSidebar: boolean;
  refreshSeconds: number;
  claudeCollection: boolean;
  alerts: {
    thresholdPercent: number;
    agents: UsageAgent[];
    windows: UsageWindowKind[];
    googleChat: { enabled: boolean; webhookUrlSet: boolean; webhookUrlHint: string };
    telegram: { enabled: boolean; botTokenSet: boolean; botTokenHint: string; chatId: string };
  };
}

export interface UsageState {
  view: { agents: Array<{ agent: UsageAgent; accounts: UsageAccountView[] }> };
  lastRefreshAt: number | null;
  accounts: Array<{ agent: UsageAgent; accountKey: string; defaultLabel: string; source: UsageSource; nickname: string; hidden: boolean }>;
  claudeCollection: Array<{ configDir: string; source: UsageSource; installed: boolean; drifted: boolean; error?: string }>;
  settings: UsageSettingsView;
}

export interface UsageSendResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface UsageSettingsUpdate {
  showInSidebar: boolean;
  refreshSeconds: number;
  claudeCollection: boolean;
  /** Per account; an empty name removes it. Accounts left out keep theirs. */
  nicknames: Record<string, string>;
  /** Per account: true hides, false shows. */
  hidden: Record<string, boolean>;
  alerts: {
    thresholdPercent: number;
    agents: UsageAgent[];
    windows: UsageWindowKind[];
    googleChat: { enabled: boolean; webhookUrl?: string };
    telegram: { enabled: boolean; botToken?: string; chatId: string };
    clear?: Array<'googleChatWebhook' | 'telegramBotToken'>;
  };
}

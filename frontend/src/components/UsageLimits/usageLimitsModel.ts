// FR-USAGE-005..007: the usage settings form and countdown, apart from React so they can be tested.
import type { UsageAgent, UsageSettingsUpdate, UsageState, UsageWindowKind } from './usageLimitsTypes.ts';

export const REFRESH_SECONDS_MIN = 15;
export const REFRESH_SECONDS_MAX = 3600;

/** What the form holds; numbers stay text until saved so a half-typed value is not lost. */
export interface UsageSettingsForm {
  showInSidebar: boolean;
  refreshSeconds: string;
  claudeCollection: boolean;
  thresholdPercent: string;
  agents: UsageAgent[];
  windows: UsageWindowKind[];
  googleChatEnabled: boolean;
  googleChatWebhookUrl: string;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  nicknames: Record<string, string>;
  hidden: string[];
}

export function formFromState(state: UsageState): UsageSettingsForm {
  const { settings } = state;
  return {
    showInSidebar: settings.showInSidebar,
    refreshSeconds: String(settings.refreshSeconds),
    claudeCollection: settings.claudeCollection,
    thresholdPercent: String(settings.alerts.thresholdPercent),
    agents: [...settings.alerts.agents],
    windows: [...settings.alerts.windows],
    googleChatEnabled: settings.alerts.googleChat.enabled,
    googleChatWebhookUrl: '',
    telegramEnabled: settings.alerts.telegram.enabled,
    telegramBotToken: '',
    telegramChatId: settings.alerts.telegram.chatId,
    nicknames: Object.fromEntries(state.accounts.filter((a) => a.nickname).map((a) => [a.accountKey, a.nickname])),
    hidden: state.accounts.filter((a) => a.hidden).map((a) => a.accountKey),
  };
}

const wholeIn = (text: string, min: number, max: number) => /^\d+$/u.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The fields that would be refused, in form order. */
export function validateUsageForm(form: UsageSettingsForm): Array<'refreshSeconds' | 'thresholdPercent'> {
  const invalid: Array<'refreshSeconds' | 'thresholdPercent'> = [];
  if (!wholeIn(form.refreshSeconds, REFRESH_SECONDS_MIN, REFRESH_SECONDS_MAX)) invalid.push('refreshSeconds');
  if (!wholeIn(form.thresholdPercent, 1, 99)) invalid.push('thresholdPercent');
  return invalid;
}

/**
 * FR-USAGE-006 AC-4: a blank secret field is left out, so the stored secret stays.
 * FR-USAGE-004 AC-4: nicknames and hidden flags are sent for the listed accounts only; the server
 * merges them, so an account not read this time keeps its own.
 */
export function buildSettingsUpdate(form: UsageSettingsForm, listedAccounts: readonly string[] = []): UsageSettingsUpdate {
  const webhookUrl = form.googleChatWebhookUrl.trim();
  const botToken = form.telegramBotToken.trim();
  return {
    showInSidebar: form.showInSidebar,
    refreshSeconds: Number(form.refreshSeconds),
    claudeCollection: form.claudeCollection,
    nicknames: Object.fromEntries(listedAccounts.map((key) => [key, form.nicknames[key] ?? ''])),
    hidden: Object.fromEntries(listedAccounts.map((key) => [key, form.hidden.includes(key)])),
    alerts: {
      thresholdPercent: Number(form.thresholdPercent),
      agents: form.agents,
      windows: form.windows,
      googleChat: { enabled: form.googleChatEnabled, ...(webhookUrl ? { webhookUrl } : {}) },
      telegram: { enabled: form.telegramEnabled, chatId: form.telegramChatId.trim(), ...(botToken ? { botToken } : {}) },
    },
  };
}

/** FR-USAGE-007 AC-2: time until a reset, rounded up to the minute. */
export function durationParts(ms: number): { days: number; hours: number; minutes: number } {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

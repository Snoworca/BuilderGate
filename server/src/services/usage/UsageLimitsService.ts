// FR-USAGE-003..006: usage limits under the workspace list — settings, polling, alerts.
//
// Every source is a local file, so the service polls: it rereads the sources every refresh
// interval and on request, keeps the last view, and decides alerts on each refresh. The webhook URL
// and the bot token are stored encrypted and never leave the server except as a 4-character hint.
import fs from 'node:fs/promises';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import {
  decideAlerts,
  labelFor,
  mergeReadings,
  toUsageView,
  type LastUsedByWindow,
  type UsageAgent,
  type UsageReading,
  type UsageSource,
  type UsageView,
  type UsageWindowKind,
} from './usageModel.js';
import { formatUsageAlert, type SendResult } from './usageNotifier.js';

export interface UsageCipher {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export interface ClaudeCollectionDirStatus {
  configDir: string;
  source: UsageSource;
  installed: boolean;
  drifted: boolean;
  error?: string;
}

export interface UsageLimitsDeps {
  dataPath?: string;
  now?: () => number;
  machine: string;
  cipher: UsageCipher;
  readReadings: () => Promise<UsageReading[]>;
  setClaudeCollection: (on: boolean) => Promise<ClaudeCollectionDirStatus[]>;
  claudeCollectionStatus: () => Promise<ClaudeCollectionDirStatus[]>;
  sendGoogleChat: (config: { webhookUrl: string }, text: string) => Promise<SendResult>;
  sendTelegram: (config: { botToken: string; chatId: string }, text: string) => Promise<SendResult>;
  /** Off in tests, which call refresh() themselves. */
  startTimer?: boolean;
}

export const REFRESH_SECONDS_MIN = 15;
export const REFRESH_SECONDS_MAX = 3600;
const AGENTS: readonly UsageAgent[] = ['claude', 'codex'];
const WINDOWS: readonly UsageWindowKind[] = ['fiveHour', 'weekly'];

interface StoredSettings {
  version: 1;
  showInSidebar: boolean;
  refreshSeconds: number;
  claudeCollection: boolean;
  nicknames: Record<string, string>;
  hidden: string[];
  alerts: {
    thresholdPercent: number;
    agents: UsageAgent[];
    windows: UsageWindowKind[];
    googleChat: { enabled: boolean; webhookUrl: string | null };
    telegram: { enabled: boolean; botToken: string | null; chatId: string };
  };
  /** FR-USAGE-006 AC-2: used percent of the previous update per agent · account · window. */
  lastUsed: LastUsedByWindow;
}

export interface UsageSettingsInput {
  showInSidebar?: boolean;
  refreshSeconds?: number;
  claudeCollection?: boolean;
  /** Merged per account; an empty name removes the nickname. */
  nicknames?: Record<string, string>;
  /** Merged per account: true hides, false shows. */
  hidden?: Record<string, boolean>;
  alerts?: {
    thresholdPercent?: number;
    agents?: UsageAgent[];
    windows?: UsageWindowKind[];
    googleChat?: { enabled?: boolean; webhookUrl?: string };
    telegram?: { enabled?: boolean; botToken?: string; chatId?: string };
    clear?: Array<'googleChatWebhook' | 'telegramBotToken'>;
  };
}

export class UsageSettingsError extends Error {
  constructor(readonly field: string) {
    super(`Invalid usage setting: ${field}`);
  }
}

function defaults(): StoredSettings {
  return {
    version: 1,
    showInSidebar: true,
    refreshSeconds: 60,
    claudeCollection: false,
    nicknames: {},
    hidden: [],
    alerts: {
      thresholdPercent: 20,
      agents: [...AGENTS],
      windows: [...WINDOWS],
      googleChat: { enabled: false, webhookUrl: null },
      telegram: { enabled: false, botToken: null, chatId: '' },
    },
    lastUsed: {},
  };
}

export class UsageLimitsService {
  private readonly dataPath: string;
  private readonly now: () => number;
  private settings: StoredSettings = defaults();
  private readings: UsageReading[] = [];
  private lastRefreshAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  /** FR-USAGE-003: the last install or removal per folder, so a failure shows in the state. */
  private collectionResults: ClaudeCollectionDirStatus[] = [];
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: UsageLimitsDeps) {
    this.dataPath = path.resolve(deps.dataPath ?? './data/usage-limits.json');
    this.now = deps.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {
    this.settings = await this.load();
    // FR-USAGE-003 AC-3: the relay in each Claude folder is a copy; rewrite it so an updated
    // BuilderGate does not keep running the old one. Wrapping stays single.
    if (this.settings.claudeCollection) {
      this.collectionResults = await this.deps.setClaudeCollection(true).catch((error) => {
        console.warn('[Usage] could not refresh the Claude relay:', error instanceof Error ? error.message : error);
        return [];
      });
    }
    this.arm();
    if (this.deps.startTimer ?? true) void this.refresh().catch((error) => console.warn('[Usage] first refresh failed:', error));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** FR-USAGE-005 AC-2: one refresh at a time; a caller during one waits for it. */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async getState() {
    const prefs = { nicknames: this.settings.nicknames, hidden: this.settings.hidden };
    const merged = mergeReadings(this.readings);
    return {
      view: this.settings.showInSidebar ? toUsageView(this.readings, prefs, this.now()) : ({ agents: [] } satisfies UsageView),
      lastRefreshAt: this.lastRefreshAt,
      accounts: merged
        .filter((reading) => reading.accountKey !== null && Object.keys(reading.windows).length > 0)
        .map((reading) => ({
          agent: reading.agent,
          accountKey: reading.accountKey!,
          defaultLabel: labelFor(reading, { nicknames: {}, hidden: [] }),
          source: reading.source,
          nickname: this.settings.nicknames[reading.accountKey!] ?? '',
          hidden: this.settings.hidden.includes(reading.accountKey!),
        })),
      claudeCollection: await this.collectionStatus(),
      settings: this.publicSettings(),
    };
  }

  async updateSettings(input: UsageSettingsInput): Promise<void> {
    const next = structuredClone(this.settings);
    if (input.showInSidebar !== undefined) next.showInSidebar = Boolean(input.showInSidebar);
    if (input.refreshSeconds !== undefined) {
      if (!Number.isInteger(input.refreshSeconds) || input.refreshSeconds < REFRESH_SECONDS_MIN || input.refreshSeconds > REFRESH_SECONDS_MAX) {
        throw new UsageSettingsError('refreshSeconds');
      }
      next.refreshSeconds = input.refreshSeconds;
    }
    if (input.nicknames !== undefined) next.nicknames = mergeNicknames(next.nicknames, input.nicknames);
    if (input.hidden !== undefined) next.hidden = mergeHidden(next.hidden, input.hidden);
    const alerts = input.alerts;
    if (alerts) {
      if (alerts.thresholdPercent !== undefined) {
        if (!Number.isInteger(alerts.thresholdPercent) || alerts.thresholdPercent < 1 || alerts.thresholdPercent > 99) {
          throw new UsageSettingsError('alerts.thresholdPercent');
        }
        next.alerts.thresholdPercent = alerts.thresholdPercent;
      }
      if (alerts.agents !== undefined) next.alerts.agents = AGENTS.filter((agent) => alerts.agents!.includes(agent));
      if (alerts.windows !== undefined) next.alerts.windows = WINDOWS.filter((kind) => alerts.windows!.includes(kind));
      const chat = alerts.googleChat;
      if (chat?.enabled !== undefined) next.alerts.googleChat.enabled = Boolean(chat.enabled);
      // FR-USAGE-006 AC-4: a blank keeps the stored secret; clearing is asked for separately.
      if (chat?.webhookUrl?.trim()) next.alerts.googleChat.webhookUrl = this.deps.cipher.encrypt(chat.webhookUrl.trim());
      const telegram = alerts.telegram;
      if (telegram?.enabled !== undefined) next.alerts.telegram.enabled = Boolean(telegram.enabled);
      if (telegram?.botToken?.trim()) next.alerts.telegram.botToken = this.deps.cipher.encrypt(telegram.botToken.trim());
      if (telegram?.chatId !== undefined) next.alerts.telegram.chatId = String(telegram.chatId).trim();
      if (alerts.clear?.includes('googleChatWebhook')) next.alerts.googleChat.webhookUrl = null;
      if (alerts.clear?.includes('telegramBotToken')) next.alerts.telegram.botToken = null;
    }
    if (input.claudeCollection !== undefined) {
      const on = Boolean(input.claudeCollection);
      // FR-USAGE-003 AC-4: saving with collection on also puts the relay back where it was replaced.
      const drifted = on && this.settings.claudeCollection && (await this.collectionStatus()).some((dir) => dir.drifted);
      if (on !== this.settings.claudeCollection || drifted) {
        const results = await this.deps.setClaudeCollection(on);
        this.collectionResults = results;
        if (on && results.length > 0 && results.every((dir) => dir.error)) throw new UsageSettingsError('claudeCollection');
        next.claudeCollection = on;
      }
    }
    const intervalChanged = next.refreshSeconds !== this.settings.refreshSeconds;
    // A refresh may have run while this save waited; its remembered values are the newer ones.
    this.settings = { ...next, lastUsed: this.settings.lastUsed };
    await this.persist();
    if (intervalChanged) this.arm();
  }

  /** FR-USAGE-006 AC-5: a real message with the values typed, falling back to the stored ones per field. */
  async testChannel(channel: 'googleChat' | 'telegram', typed: { webhookUrl?: string; botToken?: string; chatId?: string }): Promise<SendResult> {
    const text = `[BuilderGate] 사용량 한도 알림 테스트 · ${this.deps.machine}`;
    if (channel === 'googleChat') {
      return this.deps.sendGoogleChat({ webhookUrl: typed.webhookUrl?.trim() || this.secret(this.settings.alerts.googleChat.webhookUrl) }, text);
    }
    return this.deps.sendTelegram({
      botToken: typed.botToken?.trim() || this.secret(this.settings.alerts.telegram.botToken),
      chatId: typed.chatId?.trim() || this.settings.alerts.telegram.chatId,
    }, text);
  }

  private async runRefresh(): Promise<void> {
    this.readings = await this.deps.readReadings();
    this.lastRefreshAt = this.now();
    const decision = decideAlerts(this.readings, this.settings.lastUsed, { ...this.settings.alerts, hidden: this.settings.hidden }, this.now());
    this.settings.lastUsed = decision.lastUsed;
    await this.persist();
    const prefs = { nicknames: this.settings.nicknames, hidden: [] };
    for (const alert of decision.alerts) {
      const text = formatUsageAlert({
        agent: alert.agent,
        accountLabel: labelFor(alert.reading, prefs),
        window: alert.window,
        remainingPercent: alert.remainingPercent,
        thresholdPercent: this.settings.alerts.thresholdPercent,
        resetsAt: alert.resetsAt,
        now: this.now(),
        machine: this.deps.machine,
      });
      await this.sendAlert(text);
    }
  }

  /** FR-USAGE-006 AC-6: each channel on its own; a failure is logged and the rest go on. */
  private async sendAlert(text: string): Promise<void> {
    const { googleChat, telegram } = this.settings.alerts;
    const sends: Array<Promise<SendResult>> = [];
    if (googleChat.enabled && googleChat.webhookUrl) {
      sends.push(this.deps.sendGoogleChat({ webhookUrl: this.secret(googleChat.webhookUrl) }, text));
    }
    if (telegram.enabled && telegram.botToken && telegram.chatId) {
      sends.push(this.deps.sendTelegram({ botToken: this.secret(telegram.botToken), chatId: telegram.chatId }, text));
    }
    for (const result of await Promise.allSettled(sends)) {
      if (result.status === 'rejected' || !result.value.ok) {
        console.warn('[Usage] alert send failed:', result.status === 'rejected' ? String(result.reason) : result.value.error);
      }
    }
  }

  /** Each folder's state, with the error of the last install or removal there. */
  private async collectionStatus(): Promise<ClaudeCollectionDirStatus[]> {
    const status = await this.deps.claudeCollectionStatus().catch(() => [] as ClaudeCollectionDirStatus[]);
    if (status.length === 0) return this.collectionResults.filter((dir) => dir.error);
    return status.map((dir) => {
      const error = this.collectionResults.find((result) => result.configDir === dir.configDir)?.error;
      return error ? { ...dir, error } : dir;
    });
  }

  private publicSettings() {
    const { googleChat, telegram } = this.settings.alerts;
    return {
      showInSidebar: this.settings.showInSidebar,
      refreshSeconds: this.settings.refreshSeconds,
      claudeCollection: this.settings.claudeCollection,
      alerts: {
        thresholdPercent: this.settings.alerts.thresholdPercent,
        agents: this.settings.alerts.agents,
        windows: this.settings.alerts.windows,
        googleChat: { enabled: googleChat.enabled, webhookUrlSet: googleChat.webhookUrl !== null, webhookUrlHint: hint(this.secret(googleChat.webhookUrl)) },
        telegram: { enabled: telegram.enabled, botTokenSet: telegram.botToken !== null, botTokenHint: hint(this.secret(telegram.botToken)), chatId: telegram.chatId },
      },
    };
  }

  private secret(stored: string | null): string {
    if (!stored) return '';
    try {
      return this.deps.cipher.decrypt(stored);
    } catch {
      return '';
    }
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.disposed || !(this.deps.startTimer ?? true)) return;
    this.timer = setInterval(() => {
      void this.refresh().catch((error) => console.warn('[Usage] refresh failed:', error));
    }, this.settings.refreshSeconds * 1000);
    this.timer.unref?.();
  }

  private async load(): Promise<StoredSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.dataPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
      throw error;
    }
    let stored: Partial<StoredSettings>;
    try {
      stored = JSON.parse(raw) as Partial<StoredSettings>;
    } catch (error) {
      console.warn('[Usage] usage-limits.json does not parse; starting from defaults:', error instanceof Error ? error.message : error);
      return defaults();
    }
    const base = defaults();
    return {
      ...base,
      ...stored,
      version: 1,
      alerts: {
        ...base.alerts,
        ...stored.alerts,
        googleChat: { ...base.alerts.googleChat, ...stored.alerts?.googleChat },
        telegram: { ...base.alerts.telegram, ...stored.alerts?.telegram },
      },
      lastUsed: stored.lastUsed ?? {},
    };
  }

  private persist(): Promise<void> {
    return publishStoreAtomically(this.dataPath, JSON.stringify(this.settings, null, 2), { ensureDirectory: true });
  }
}

function hint(secret: string): string {
  return secret ? `●●●●${secret.slice(-4)}` : '';
}

function mergeNicknames(current: Record<string, string>, input: Record<string, string>): Record<string, string> {
  const out = { ...current };
  for (const [key, value] of Object.entries(input ?? {})) {
    const name = typeof value === 'string' ? value.trim().slice(0, 40) : '';
    if (name) out[key] = name;
    else delete out[key];
  }
  return out;
}

function mergeHidden(current: string[], input: Record<string, boolean>): string[] {
  const out = new Set(current);
  for (const [key, hide] of Object.entries(input ?? {})) {
    if (hide === true) out.add(key);
    else if (hide === false) out.delete(key);
  }
  return [...out];
}

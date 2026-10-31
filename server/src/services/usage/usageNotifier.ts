// FR-USAGE-006 AC-3..AC-5: the alert text and the two channels. A result never carries the
// webhook URL or the bot token, so it is safe to return to the browser and to log.
import type { UsageAgent, UsageWindowKind } from './usageModel.js';

export interface SendResult {
  ok: boolean;
  /** HTTP status, or 0 when no response came. */
  status: number;
  error?: string;
}

const TIMEOUT_MS = 10_000;
const GOOGLE_CHAT_HOST = 'chat.googleapis.com';
const AGENT_NAMES: Record<UsageAgent, string> = { claude: 'Claude', codex: 'Codex' };
const WINDOW_NAMES: Record<UsageWindowKind, string> = { fiveHour: '5시간', weekly: '주간' };

export function formatUsageAlert(input: {
  agent: UsageAgent;
  accountLabel: string;
  window: UsageWindowKind;
  remainingPercent: number;
  thresholdPercent: number;
  resetsAt: number | null;
  now: number;
  machine: string;
}): string {
  const who = input.accountLabel ? `${AGENT_NAMES[input.agent]}(${input.accountLabel})` : AGENT_NAMES[input.agent];
  const parts = [`[BuilderGate] ${who} ${WINDOW_NAMES[input.window]} 한도 남은 양 ${formatPercent(input.remainingPercent)}% (기준 ${input.thresholdPercent}%)`];
  if (input.resetsAt !== null) parts.push(`${formatDuration(input.resetsAt - input.now)} 후 초기화`);
  parts.push(input.machine);
  return parts.join(' · ');
}

export async function sendGoogleChat(config: { webhookUrl: string }, text: string, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  const url = config.webhookUrl.trim();
  if (!url) return { ok: false, status: 0, error: 'webhook URL is empty' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, error: 'webhook URL is not a URL' };
  }
  // Only Google Chat; the server would otherwise POST to any address it can reach.
  if (parsed.protocol !== 'https:' || parsed.hostname !== GOOGLE_CHAT_HOST) {
    return { ok: false, status: 0, error: `webhook URL must be https://${GOOGLE_CHAT_HOST}/…` };
  }
  // The key and token in the query are as secret as the whole URL.
  const queryValues = [...parsed.searchParams.values()].filter((value) => value.length >= 4);
  return post(fetchFn, url, { text }, [url, ...queryValues]);
}

export async function sendTelegram(config: { botToken: string; chatId: string }, text: string, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  const token = config.botToken.trim();
  const chatId = config.chatId.trim();
  if (!token) return { ok: false, status: 0, error: 'bot token is empty' };
  if (!chatId) return { ok: false, status: 0, error: 'chat id is empty' };
  return post(fetchFn, `https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text }, [token]);
}

async function post(fetchFn: typeof fetch, url: string, body: unknown, secrets: string[]): Promise<SendResult> {
  const redact = (text: string) => secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), text);
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, status: response.status };
    const detail = await response.text().catch(() => '');
    return { ok: false, status: response.status, error: redact(describe(detail) || response.statusText || `HTTP ${response.status}`) };
  } catch (error) {
    return { ok: false, status: 0, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

/** The service's own reason when it sends one (Telegram `description`, Google `error.message`). */
function describe(body: string): string {
  try {
    const parsed = JSON.parse(body) as { description?: unknown; error?: { message?: unknown } };
    if (typeof parsed.description === 'string') return parsed.description;
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '곧';
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return rest > 0 ? `${hours}시간 ${rest}분` : `${hours}시간`;
  return `${rest}분`;
}

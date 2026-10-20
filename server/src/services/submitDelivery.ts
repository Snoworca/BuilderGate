// FR-MCP-002 AC-7: a submit delivery writes its text and its Enter as two PTY writes.
//
// Written as one chunk, `text\r` reaches an AI TUI (Claude Code, Codex) in however many reads
// the PTY happens to hand it. When the Enter lands in the same read as a long run of text, the
// TUI takes the whole read as a paste and keeps the Enter as part of it: the prompt stays in the
// input box. A short `hi\r` and even a 2,000-character prompt were seen to submit, other long
// prompts were not — the split depends on timing, not on the text. Writing the Enter on its own
// after a pause is what a person does (paste, then press Enter) and keeps it out of the paste.

type Rec = Record<string, unknown>;

// FR-MCP-002 AC-8: both waits are MCP settings (McpControlService); the cap is not.
export interface SubmitEnterDelay {
  baseMs: number;
  perKbMs: number;
}

// 1000 ms base (2026-10-21 user request): 150 ms was short enough for a busy TUI to take the Enter as part of the paste.
export const DEFAULT_SUBMIT_ENTER_DELAY: SubmitEnterDelay = { baseMs: 1000, perKbMs: 50 };
export const SUBMIT_ENTER_BASE_MS_MAX = 5000;
export const SUBMIT_ENTER_PER_KB_MS_MAX = 1000;
/** Keeps a mistyped setting from holding an MCP call for minutes. */
export const SUBMIT_ENTER_MAX_DELAY_MS = 10_000;

const ENTER = '\r';

export function isValidSubmitEnterBaseMs(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= SUBMIT_ENTER_BASE_MS_MAX;
}

export function isValidSubmitEnterPerKbMs(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= SUBMIT_ENTER_PER_KB_MS_MAX;
}

export function submitEnterDelayMs(text: string, delay: SubmitEnterDelay = DEFAULT_SUBMIT_ENTER_DELAY): number {
  return Math.min(SUBMIT_ENTER_MAX_DELAY_MS, delay.baseMs + Math.ceil(text.length / 1024) * delay.perKbMs);
}

export function isSubmitDelivery(request: Rec): boolean {
  const delivery = asRecord(request.delivery);
  return delivery.submit === true || delivery.mode === 'submit';
}

function isAccepted(result: Rec): boolean {
  return result.accepted !== false && result.ok !== false && result.status !== 'failed';
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends a gateway request. A paste request goes through unchanged. A submit request has its
 * trailing CR/LF removed and is sent as the text, then — after options.delay's base wait plus its
 * per-KB wait for each started 1024 characters, at most 10 s — a lone Enter. The Enter request
 * drops auditContext so one delivery is audited once. A rejected text write sends no Enter; a rejected Enter write is returned as the result.
 */
export async function submitWithSeparateEnter(
  submit: (request: Rec) => unknown,
  request: Rec,
  options: { sleep?: (ms: number) => Promise<void>; delay?: SubmitEnterDelay } = {},
): Promise<Rec> {
  if (!isSubmitDelivery(request)) {
    return asRecord(await submit(request));
  }
  const text = (typeof request.data === 'string' ? request.data : '').replace(/[\r\n]+$/u, '');
  if (text === '') {
    return asRecord(await submit({ ...request, data: ENTER }));
  }
  const textResult = asRecord(await submit({ ...request, data: text }));
  if (!isAccepted(textResult)) {
    return textResult;
  }
  await (options.sleep ?? defaultSleep)(submitEnterDelayMs(text, options.delay));
  const { auditContext: _auditContext, ...enterRequest } = request;
  const enterResult = asRecord(await submit({ ...enterRequest, data: ENTER }));
  return isAccepted(enterResult) ? textResult : enterResult;
}

function asRecord(value: unknown): Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
}

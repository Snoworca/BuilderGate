// FR-MCP-002 AC-7: a submit delivery writes its text and its Enter as two PTY writes.
//
// Written as one chunk, `text\r` reaches an AI TUI (Claude Code, Codex) in however many reads
// the PTY happens to hand it. When the Enter lands in the same read as a long run of text, the
// TUI takes the whole read as a paste and keeps the Enter as part of it: the prompt stays in the
// input box. A short `hi\r` and even a 2,000-character prompt were seen to submit, other long
// prompts were not — the split depends on timing, not on the text. Writing the Enter on its own
// after a pause is what a person does (paste, then press Enter) and keeps it out of the paste.

type Rec = Record<string, unknown>;

export const SUBMIT_ENTER_MIN_DELAY_MS = 150;
export const SUBMIT_ENTER_DELAY_PER_KB_MS = 50;
export const SUBMIT_ENTER_MAX_DELAY_MS = 1000;

const ENTER = '\r';

export function submitEnterDelayMs(text: string): number {
  return Math.min(
    SUBMIT_ENTER_MAX_DELAY_MS,
    SUBMIT_ENTER_MIN_DELAY_MS + Math.ceil(text.length / 1024) * SUBMIT_ENTER_DELAY_PER_KB_MS,
  );
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
 * trailing CR/LF removed and is sent as the text, then — after a wait that grows with the text
 * length — a lone Enter. The Enter request drops auditContext so one delivery is audited once.
 * A rejected text write sends no Enter; a rejected Enter write is returned as the result.
 */
export async function submitWithSeparateEnter(
  submit: (request: Rec) => unknown,
  request: Rec,
  options: { sleep?: (ms: number) => Promise<void> } = {},
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
  await (options.sleep ?? defaultSleep)(submitEnterDelayMs(text));
  const { auditContext: _auditContext, ...enterRequest } = request;
  const enterResult = asRecord(await submit({ ...enterRequest, data: ENTER }));
  return isAccepted(enterResult) ? textResult : enterResult;
}

function asRecord(value: unknown): Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {};
}

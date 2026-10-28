/**
 * REL-BGSTAB-057: inputs the terminal sent on its own -- parser-generated replies to a
 * program's query -- are remembered by input seq, so that a server refusal of one is not
 * reported to the user as lost typing. Measured 2026-10-27 on a production log: all 69
 * refused inputs were 11-12 byte ESC replies sent while the screen was being switched.
 *
 * Two keys because two components own the two numbers: the view gives a reply its capture
 * seq when xterm emits it, and the container gives it an input seq when it is sequenced. A
 * control chunk is never coalesced with other input, so a reply gets an input seq of its own.
 */

/** Per session; older entries are dropped first, so a long session cannot grow this. */
const MAX_REMEMBERED = 512;

interface SessionReplies {
  captures: Set<number>;
  inputSeqs: Set<number>;
}

const sessions = new Map<string, SessionReplies>();

function repliesFor(sessionId: string): SessionReplies {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { captures: new Set(), inputSeqs: new Set() };
    sessions.set(sessionId, entry);
  }
  return entry;
}

function addBounded(set: Set<number>, value: number): void {
  set.delete(value);
  set.add(value);
  if (set.size > MAX_REMEMBERED) {
    const oldest = set.values().next().value as number;
    set.delete(oldest);
  }
}

/** The view sent `captureSeq` as a parser-generated reply, without the user typing it. */
export function noteAutomaticReplyCapture(sessionId: string, captureSeq: number): void {
  addBounded(repliesFor(sessionId).captures, captureSeq);
}

/** The container numbered an input; it is an automatic reply when its capture seq was noted. */
export function bindAutomaticReplyInput(
  sessionId: string,
  input: { captureSeq?: number; inputSeqStart: number; inputSeqEnd: number },
): void {
  const entry = sessions.get(sessionId);
  if (!entry || input.captureSeq === undefined || !entry.captures.has(input.captureSeq)) return;
  entry.captures.delete(input.captureSeq);
  for (let seq = input.inputSeqStart; seq <= input.inputSeqEnd; seq += 1) {
    addBounded(entry.inputSeqs, seq);
  }
}

/** True only when every refused input seq was an automatic reply. */
export function isAutomaticReplyRejection(
  sessionId: string,
  range: { inputSeqStart?: number; inputSeqEnd?: number },
): boolean {
  const entry = sessions.get(sessionId);
  const start = range.inputSeqStart;
  const end = range.inputSeqEnd ?? start;
  if (!entry || start === undefined || end === undefined || end < start) return false;
  if (end - start >= MAX_REMEMBERED) return false;
  for (let seq = start; seq <= end; seq += 1) {
    if (!entry.inputSeqs.has(seq)) return false;
  }
  return true;
}

export function forgetAutomaticReplies(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Decides what an inbound WebSocket message is, before anything tries to read
 * it. This is the single codec-selection point (`08 §1.5`); below it the
 * distinction between JSON and binary does not exist.
 *
 * The branch order is fixed by `08:128-134` and `03:108-113`:
 *
 *   ArrayBuffer   → binary
 *   not a string  → refused, with the type named   (this is the Blob arm)
 *   string        → JSON
 *
 * The middle arm is not a catch-all afterthought. A Blob's bytes are only
 * reachable through `await blob.arrayBuffer()`, so a synchronous message
 * handler cannot process one at all — it can only refuse it and say so. That
 * happens whenever `binaryType` is left at its 'blob' default, which is a
 * misconfiguration that has to be visible at runtime rather than silent.
 *
 * The JSON parse lives here rather than at the call site so that a parse
 * failure is a value the caller can record. The previous inline form was
 * `catch { return; }`, which left no trace of a dropped message.
 */

export type WsFrameDispatch =
  /** Bytes to hand to `decodeWsMessage`. Never parsed or copied here. */
  | { readonly kind: 'binary'; readonly buffer: ArrayBuffer }
  /** A parsed JSON value. Not narrowed — the existing type guards do that. */
  | { readonly kind: 'json'; readonly message: unknown }
  | { readonly kind: 'malformed-json'; readonly textLength: number }
  /** Anything a synchronous handler cannot read, Blob above all. */
  | { readonly kind: 'unsupported'; readonly frameType: string };

/**
 * Names the runtime type for the rejection record.
 *
 * `constructor.name` is not reachable on a null-prototype object, and this runs
 * on every inbound message, so the fallback is `typeof` rather than a throw.
 */
function frameTypeOf(data: unknown): string {
  if (data === null) return 'null';
  const name = (data as { constructor?: { name?: string } })?.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : typeof data;
}

export function classifyWsFrame(data: unknown): WsFrameDispatch {
  if (data instanceof ArrayBuffer) {
    return { kind: 'binary', buffer: data };
  }

  if (typeof data !== 'string') {
    return { kind: 'unsupported', frameType: frameTypeOf(data) };
  }

  try {
    return { kind: 'json', message: JSON.parse(data) };
  } catch {
    return { kind: 'malformed-json', textLength: data.length };
  }
}

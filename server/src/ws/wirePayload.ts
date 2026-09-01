/**
 * The wire payload of a queued transport message (`01 §3.1`).
 *
 * `payload` used to be a bare `string`, which made "send a binary frame on a
 * JSON-only socket" a perfectly well-typed statement. Splitting it into a
 * discriminated union removes that state from the language: the text is only
 * reachable after narrowing to the json branch, so the send site has to decide
 * which call it is making (`01:910`).
 */

import { SERVER_TO_CLIENT_OPCODE_BY_TYPE } from './binaryFrameCodec.js';

export type WirePayload =
  | { readonly codec: 'json'; readonly text: string }
  | { readonly codec: 'binary'; readonly bytes: Uint8Array; readonly codecEpoch: number };

/** What a socket negotiated. Absent means the socket never negotiated binary. */
export interface SocketCodecBinding {
  readonly codec: 'binary';
  readonly codecEpoch: number;
}

export type ResolvedWireCodec =
  | { readonly codec: 'json' }
  | { readonly codec: 'binary'; readonly opcode: number; readonly codecEpoch: number };

export function jsonWirePayload(text: string): WirePayload {
  return { codec: 'json', text };
}

export function binaryWirePayload(bytes: Uint8Array, codecEpoch: number): WirePayload {
  if (!Number.isSafeInteger(codecEpoch) || codecEpoch < 0) {
    throw new RangeError(`codecEpoch must be a non-negative safe integer: ${String(codecEpoch)}`);
  }
  return { codec: 'binary', bytes, codecEpoch };
}

/**
 * The byte count the transport accounting must charge. The two branches are
 * measured differently on purpose: utf8 length for text, and the view's own
 * `byteLength` for bytes, which is not the backing buffer's length.
 */
export function wirePayloadByteLength(payload: WirePayload): number {
  return payload.codec === 'json'
    ? Buffer.byteLength(payload.text, 'utf8')
    : payload.bytes.byteLength;
}

/**
 * The JSON text of a payload. Throws for a binary payload rather than
 * stringifying it: a caller that can legitimately receive either branch must
 * narrow, and a caller that cannot should fail loudly instead of putting
 * `[object Object]` on the wire.
 */
export function jsonWirePayloadText(payload: WirePayload): string {
  if (payload.codec !== 'json') {
    throw new TypeError('wire payload is a binary frame, not JSON text');
  }
  return payload.text;
}

/**
 * The payload's bytes as hex, whichever branch it is on. Evidence tooling
 * compares payloads across the two codecs, so it needs one reading that does
 * not depend on which branch produced the message.
 */
export function wirePayloadHex(payload: WirePayload): string {
  return payload.codec === 'json'
    ? Buffer.from(payload.text, 'utf8').toString('hex')
    : Buffer.from(payload.bytes).toString('hex');
}

/** The data-plane opcode of a message, or `undefined` for the control plane. */
export function wireOpcodeOf(message: object): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(message, 'type')) return undefined;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(SERVER_TO_CLIENT_OPCODE_BY_TYPE, type)
    ? SERVER_TO_CLIENT_OPCODE_BY_TYPE[type]
    : undefined;
}

/**
 * Which codec this message goes out under. JSON is the safe default in both
 * fallbacks — an unbound socket, and a control message on a bound socket —
 * because the control plane stays on JSON in v1 (`01:173`).
 */
export function resolveWireCodec(
  binding: SocketCodecBinding | undefined,
  message: object,
): ResolvedWireCodec {
  if (binding === undefined) return { codec: 'json' };
  const opcode = wireOpcodeOf(message);
  if (opcode === undefined) return { codec: 'json' };
  return { codec: 'binary', opcode, codecEpoch: binding.codecEpoch };
}

export function encodeFor(input: {
  binding: SocketCodecBinding | undefined;
  message: object;
  encodeJson: (message: object) => string;
  /**
   * Returns `undefined` for a message it cannot frame yet. Opcodes are assigned
   * by the spec before their encoders exist, so declining has to mean "send it
   * as JSON" rather than "send nothing".
   */
  encodeBinary: (message: object, opcode: number) => Uint8Array | undefined;
}): WirePayload {
  const resolved = resolveWireCodec(input.binding, input.message);
  if (resolved.codec === 'binary') {
    const bytes = input.encodeBinary(input.message, resolved.opcode);
    if (bytes !== undefined) return binaryWirePayload(bytes, resolved.codecEpoch);
  }
  return jsonWirePayload(input.encodeJson(input.message));
}

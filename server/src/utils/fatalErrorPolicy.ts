/**
 * Codes that mean a peer went away rather than that this process is broken.
 *
 * A PTY's internal socket pipe raises `EPIPE` from `Socket.writeAfterFIN` when
 * the child's far end closes first, which happens routinely while a session is
 * being torn down. Exiting on it takes every other live terminal with it, and
 * nothing in the server's own state was wrong.
 */
const PEER_DISCONNECT_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_DESTROYED',
]);

/**
 * Whether an uncaught value describes a peer that disconnected.
 *
 * Only a real `Error` qualifies: a bare string or a plain object carrying a
 * `code` field is far more likely to be something thrown by mistake, and
 * treating it as routine would hide it.
 */
export function isPeerDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PEER_DISCONNECT_CODES.has(code);
}

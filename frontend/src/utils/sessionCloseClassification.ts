import type { TerminalInputClosedReason } from '../types/ws-protocol';

/**
 * What a `session:error` message says about the session behind it.
 *
 * The server uses one message type for two unrelated things: the shell is gone,
 * and the server could not do something for a shell that is still running. Only
 * the first should reach the user as a terminated session, because that state
 * unmounts the terminal host and leaves a restart button in its place.
 */
export type SessionErrorClassification = Extract<
  TerminalInputClosedReason,
  'session-exited' | 'session-missing' | 'server-error'
>;

const SHELL_EXITED_PREFIX = 'Shell exited';
const SESSION_MISSING_MARKER = 'Session not found';

/** Anchored at the start: a shell that prints the phrase must not close itself. */
export function classifySessionError(message: string): SessionErrorClassification {
  if (message.includes(SESSION_MISSING_MARKER)) return 'session-missing';
  if (message.startsWith(SHELL_EXITED_PREFIX)) return 'session-exited';
  return 'server-error';
}

/**
 * Whether the session behind this message is gone. Anything the server merely
 * failed to do leaves the session running, so it answers false — including
 * messages this build has never seen, which is the safe side: a live terminal
 * survives an unrecognised error, where a dead one only costs a stale view.
 */
export function sessionErrorTerminatesSession(message: string): boolean {
  const classification = classifySessionError(message);
  return classification === 'session-exited' || classification === 'session-missing';
}

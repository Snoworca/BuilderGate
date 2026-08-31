import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifySessionError,
  sessionErrorTerminatesSession,
} from '../../src/utils/sessionCloseClassification.ts';

/**
 * `session:error` says the server could not carry out something for this
 * session. It does not say the session is gone, and the two are not
 * interchangeable to the user: the terminal host is unmounted for a terminated
 * session and only a restart brings it back.
 *
 * The server sends `session:error` for a message handler that threw and for a
 * restore it could not produce. Neither ends the shell. Treating them as an
 * end turns a recoverable server-side hiccup into a destroyed terminal.
 */

test('an exited shell terminates the session', () => {
  assert.equal(classifySessionError('Shell exited with code 0'), 'session-exited');
  assert.equal(sessionErrorTerminatesSession('Shell exited with code 0'), true);
  assert.equal(sessionErrorTerminatesSession('Shell exited with code 137'), true);
});

test('a missing session terminates the session', () => {
  assert.equal(classifySessionError('Session not found'), 'session-missing');
  assert.equal(sessionErrorTerminatesSession('Session not found'), true);
});

test('a server-side failure does not terminate the session', () => {
  assert.equal(
    classifySessionError('Authoritative terminal restore unavailable'),
    'server-error',
  );
  assert.equal(
    sessionErrorTerminatesSession('Authoritative terminal restore unavailable'),
    false,
    'an unavailable restore was treated as a terminated session',
  );
  assert.equal(
    sessionErrorTerminatesSession('WebSocket message handling failed'),
    false,
    'a failed message handler was treated as a terminated session',
  );
});

test('an unrecognised message is a server error, not a termination', () => {
  assert.equal(classifySessionError(''), 'server-error');
  assert.equal(sessionErrorTerminatesSession(''), false);
  assert.equal(sessionErrorTerminatesSession('something nobody has seen yet'), false);
});

test('the exited match is anchored, so the phrase alone does not terminate', () => {
  // The server's own wording starts the message; a shell that merely printed
  // the words must not be able to close its own terminal.
  assert.equal(
    sessionErrorTerminatesSession('the log said Shell exited with code 0'),
    false,
    'a quoted exit line terminated the session',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { isPeerDisconnectError } from './fatalErrorPolicy.js';

/**
 * An uncaught exception exits the process, which for this server means every
 * live terminal session dies at once. That is the right response to corrupted
 * state and the wrong one to a peer that went away.
 *
 * Observed 2026-08-31: a PTY's internal socket pipe threw
 * `Error: This socket has been ended by the other party` (`EPIPE`, from
 * `Socket.writeAfterFIN` inside `Socket.ondata`) while a session was being torn
 * down, and the whole server exited. Nothing in the server's own state was
 * wrong — the far end of one child's pipe had simply closed first.
 *
 * The distinction is the error code. These three say a peer is gone; none of
 * them says this process cannot continue.
 */

function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

test('a socket ended by the far end is not fatal', () => {
  assert.equal(
    isPeerDisconnectError(nodeError('EPIPE', 'This socket has been ended by the other party')),
    true,
  );
});

test('writing to an ended stream is not fatal', () => {
  assert.equal(isPeerDisconnectError(nodeError('ERR_STREAM_WRITE_AFTER_END', 'write after end')), true);
  assert.equal(isPeerDisconnectError(nodeError('ERR_STREAM_DESTROYED', 'Cannot call write after a stream was destroyed')), true);
});

test('an ordinary programming error stays fatal', () => {
  assert.equal(isPeerDisconnectError(new TypeError('x is not a function')), false);
  assert.equal(isPeerDisconnectError(nodeError('ENOENT', 'no such file')), false);
  assert.equal(isPeerDisconnectError(nodeError('ERR_INVALID_ARG_TYPE', 'bad argument')), false);
});

test('a non-error value stays fatal', () => {
  assert.equal(isPeerDisconnectError(undefined), false);
  assert.equal(isPeerDisconnectError(null), false);
  assert.equal(isPeerDisconnectError('EPIPE'), false, 'a bare string must not be read as a code');
  assert.equal(isPeerDisconnectError({ code: 'EPIPE' }), false, 'only an Error carries a stack worth trusting');
});

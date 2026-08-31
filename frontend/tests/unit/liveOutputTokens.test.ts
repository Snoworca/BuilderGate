import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLiveOutputTokenStore } from '../../src/utils/liveOutputTokens.ts';

/**
 * S4-C5d — the live-path token store.
 *
 * `08:210` states the gap precisely: `replayToken` and `repairToken` already
 * live in two refs, but both are *comparison* state for an in-flight recovery
 * transaction. Outside R1/R2 there is nothing to compare against, so the live
 * path has no way to learn the current value — and `TerminalContainer` forwards
 * `replayToken` into restore-buffer entries on every output.
 *
 * `08:224` forbids merging the existing refs: the JSON path must keep reading
 * `output.replayToken` first and consult this store only when the message has
 * none, so JSON-observable behaviour stays bit-identical.
 *
 * Disposal is generation-stamped rather than a `clear()` the caller must
 * remember. `08:223` lists three triggers — `wsConnectionGenerationRef`,
 * `sessionGenerationRef`, epoch rollback — and a token that outlives any one of
 * them gets written into a restore entry under the wrong authority. Stamping
 * turns three call sites that must all be right into one that cannot be wrong.
 */

const GEN = 'ws1:sess1';

// ---------------------------------------------------------------------------
// 1. Reading what was written.
// ---------------------------------------------------------------------------

test('a stored token is readable at the same generation', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });

  assert.deepEqual(store.get('s', GEN), { replayToken: 'r1' });
});

test('an unknown session is undefined', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });

  assert.equal(store.get('other', GEN), undefined);
});

test('a session with no tokens yet is undefined, not an empty object', () => {
  // The caller decides whether to fall back; `{}` would read as "asked and
  // answered" and suppress the fallback.
  const store = createLiveOutputTokenStore();
  assert.equal(store.get('s', GEN), undefined);
});

// ---------------------------------------------------------------------------
// 2. Merging — the two tokens have independent update sources.
// ---------------------------------------------------------------------------

test('updating one token leaves the other standing', () => {
  // `screen-snapshot` carries a replayToken and `screen-repair` a repairToken.
  // Replacing the record wholesale on each would erase whichever arrived first.
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });
  store.update('s', GEN, { repairToken: 'p1' });

  assert.deepEqual(store.get('s', GEN), { replayToken: 'r1', repairToken: 'p1' });
});

test('the merge works in the other order too', () => {
  // The two tokens are handled by separate expressions, so exercising only the
  // replay-then-repair order leaves the repair half of the merge unconstrained.
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { repairToken: 'p1' });
  store.update('s', GEN, { replayToken: 'r1' });

  assert.deepEqual(store.get('s', GEN), { replayToken: 'r1', repairToken: 'p1' });
});

test('a repairToken alone stores no replayToken key at all', () => {
  // Not `{ replayToken: undefined }`: the caller decides whether to fall back
  // by asking whether the field is there, and an explicit undefined answers
  // "asked and answered" for a token that was never learned.
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { repairToken: 'p1' });

  assert.deepEqual(store.get('s', GEN), { repairToken: 'p1' });
  assert.equal('replayToken' in store.get('s', GEN)!, false);
});

test('a replayToken alone stores no repairToken key at all', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });

  assert.equal('repairToken' in store.get('s', GEN)!, false);
});

test('a later value for the same token replaces the earlier one', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });
  store.update('s', GEN, { replayToken: 'r2' });

  assert.deepEqual(store.get('s', GEN), { replayToken: 'r2' });
});

test('a later repairToken replaces the earlier one', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { repairToken: 'p1' });
  store.update('s', GEN, { repairToken: 'p2' });

  assert.deepEqual(store.get('s', GEN), { repairToken: 'p2' });
});

test('a blank repairToken does not erase a good one', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { repairToken: 'p1' });
  store.update('s', GEN, { repairToken: '' });

  assert.deepEqual(store.get('s', GEN), { repairToken: 'p1' });
});

test('an update carrying nothing does not create a session entry', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, {});

  assert.equal(store.get('s', GEN), undefined);
  assert.equal(store.size, 0);
});

test('an empty-string token is refused rather than stored', () => {
  // Downstream these are compared for equality and `''` would match another
  // absent value. `06` treats a blank token as absent everywhere else.
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: '' });

  assert.equal(store.get('s', GEN), undefined);
});

test('a blank token does not erase a good one already stored', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });
  store.update('s', GEN, { replayToken: '' });

  assert.deepEqual(store.get('s', GEN), { replayToken: 'r1' });
});

// ---------------------------------------------------------------------------
// 3. Generation stamping — the disposal rule (08:223).
// ---------------------------------------------------------------------------

test('a token written under an older generation is not readable', () => {
  // A reconnect or a session-generation bump invalidates the token even though
  // the sessionId is unchanged. Returning it would bind a stale replayToken
  // into a restore-buffer entry under the new authority.
  const store = createLiveOutputTokenStore();
  store.update('s', 'ws1:sess1', { replayToken: 'r1' });

  assert.equal(store.get('s', 'ws2:sess1'), undefined, 'ws generation changed');
  assert.equal(store.get('s', 'ws1:sess2'), undefined, 'session generation changed');
});

test('writing at a new generation discards the old tokens entirely', () => {
  // Not merged across generations: a repairToken from the previous connection
  // is no more valid than the replayToken that came with it.
  const store = createLiveOutputTokenStore();
  store.update('s', 'ws1:sess1', { replayToken: 'r1', repairToken: 'p1' });
  store.update('s', 'ws2:sess1', { replayToken: 'r2' });

  assert.deepEqual(store.get('s', 'ws2:sess1'), { replayToken: 'r2' });
});

test('a generation that comes back does not resurrect its tokens', () => {
  // Generation values are not guaranteed monotonic across every path, so a
  // repeat must not be a licence to read what a newer generation replaced.
  const store = createLiveOutputTokenStore();
  store.update('s', 'ws1:sess1', { replayToken: 'r1' });
  store.update('s', 'ws2:sess1', { replayToken: 'r2' });

  assert.equal(store.get('s', 'ws1:sess1'), undefined);
});

test('generations are per session, not global', () => {
  const store = createLiveOutputTokenStore();
  store.update('a', 'ws1:sessA', { replayToken: 'ra' });
  store.update('b', 'ws1:sessB', { replayToken: 'rb' });

  assert.deepEqual(store.get('a', 'ws1:sessA'), { replayToken: 'ra' });
  assert.deepEqual(store.get('b', 'ws1:sessB'), { replayToken: 'rb' });
});

// ---------------------------------------------------------------------------
// 4. Explicit disposal.
// ---------------------------------------------------------------------------

test('forget drops one session and leaves the rest', () => {
  const store = createLiveOutputTokenStore();
  store.update('a', GEN, { replayToken: 'ra' });
  store.update('b', GEN, { replayToken: 'rb' });
  store.forget('a');

  assert.equal(store.get('a', GEN), undefined);
  assert.deepEqual(store.get('b', GEN), { replayToken: 'rb' });
});

test('clear drops everything', () => {
  const store = createLiveOutputTokenStore();
  store.update('a', GEN, { replayToken: 'ra' });
  store.update('b', GEN, { replayToken: 'rb' });
  store.clear();

  assert.equal(store.size, 0);
  assert.equal(store.get('a', GEN), undefined);
});

// ---------------------------------------------------------------------------
// 5. The stored record is not a live handle.
// ---------------------------------------------------------------------------

test('a returned record refuses mutation loudly', () => {
  const store = createLiveOutputTokenStore();
  store.update('s', GEN, { replayToken: 'r1' });

  const found = store.get('s', GEN)!;
  assert.throws(() => { (found as { replayToken?: string }).replayToken = 'x'; }, TypeError);
  assert.equal(store.get('s', GEN)?.replayToken, 'r1');
});

test('mutating the input after updating does not change the stored record', () => {
  const store = createLiveOutputTokenStore();
  const input = { replayToken: 'r1' };
  store.update('s', GEN, input);
  input.replayToken = 'changed';

  assert.equal(store.get('s', GEN)?.replayToken, 'r1');
});

// ---------------------------------------------------------------------------
// 6. The boundary control 08:226 demands.
// ---------------------------------------------------------------------------

test('a store that was never written is indistinguishable from no store', () => {
  // `08:226` requires the JSON path to stay green with this store deliberately
  // empty. That only holds if an empty store answers every query the same way
  // "no store at all" would — `undefined`, never a throw and never a default.
  const store = createLiveOutputTokenStore();
  for (const sessionId of ['s', '', 'unknown']) {
    for (const generation of [GEN, '', 'other']) {
      assert.equal(store.get(sessionId, generation), undefined);
    }
  }
  assert.equal(store.size, 0);
});

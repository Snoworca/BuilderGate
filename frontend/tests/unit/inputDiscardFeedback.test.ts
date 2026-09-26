// REL-BGSTAB-016 / issue #109. The rule decides when a discard owes the user a surface, and the
// cases that must NOT show one are the ones that keep it honest: a surface that appears whenever
// input is handled would be indistinguishable from a working feature while reporting nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  publishInputDiscard,
  shouldShowInputDiscardFeedback,
  subscribeToInputDiscards,
} from '../../src/utils/inputDiscardFeedback.ts';

test('#109 AC-1 the capture-gate site reports a discard in observe mode while transient-blocked', () => {
  assert.equal(
    shouldShowInputDiscardFeedback({ site: 'capture-gate', mode: 'observe', state: 'transient-blocked' }),
    true,
  );
});

test('#109 AC-2 the transport site reports the same situation under its own predicate', () => {
  assert.equal(
    shouldShowInputDiscardFeedback({ site: 'transport-queue', mode: 'observe', state: 'queue' }),
    true,
  );
});

test('#109 AC-4 nothing is reported where the input is sent or queued', () => {
  // Other modes do not discard: queue holds it, strict rejects loudly through another path.
  for (const mode of ['queue', 'strict']) {
    assert.equal(shouldShowInputDiscardFeedback({ site: 'capture-gate', mode, state: 'transient-blocked' }), false);
    assert.equal(shouldShowInputDiscardFeedback({ site: 'transport-queue', mode, state: 'queue' }), false);
  }
  // An open gate sends the input; a closed one rejects it with a reason of its own.
  assert.equal(shouldShowInputDiscardFeedback({ site: 'capture-gate', mode: 'observe', state: 'open' }), false);
  assert.equal(shouldShowInputDiscardFeedback({ site: 'capture-gate', mode: 'observe', state: 'closed' }), false);
  assert.equal(shouldShowInputDiscardFeedback({ site: 'transport-queue', mode: 'observe', state: 'reject' }), false);
  assert.equal(shouldShowInputDiscardFeedback({ site: 'transport-queue', mode: 'observe', state: 'send' }), false);
});

test('#109 discards are delivered per session and stop on unsubscribe', () => {
  const seen: string[] = [];
  const stopA = subscribeToInputDiscards('session-a', () => seen.push('a'));
  const stopB = subscribeToInputDiscards('session-b', () => seen.push('b'));

  publishInputDiscard('session-a');
  assert.deepEqual(seen, ['a'], 'a discard in one terminal must not count against another');

  publishInputDiscard('session-b');
  assert.deepEqual(seen, ['a', 'b']);

  stopA();
  publishInputDiscard('session-a');
  assert.deepEqual(seen, ['a', 'b'], 'an unmounted view must stop hearing');

  stopB();
  publishInputDiscard('session-b');
  assert.deepEqual(seen, ['a', 'b']);
});

test('#109 AC-5 the published signal carries no input text', () => {
  // The publisher takes a session id and nothing else, so there is no parameter that could
  // carry the discarded characters into a listener, a log line or a screenshot.
  assert.equal(publishInputDiscard.length, 1);
});

// AC-1/AC-2 wiring. The rule above decides; these two assert that both discard sites actually
// ask it. A site that stopped asking would go silent again with every unit test still green,
// which is the failure this pair exists to make visible.
test('#109 both discard sites publish through the shared rule', () => {
  const view = readFileSync(
    new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
    'utf8',
  );
  const container = readFileSync(
    new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
    'utf8',
  );

  for (const [name, source, site] of [
    ['TerminalView#submitCapturedInputDirect', view, 'capture-gate'],
    ['TerminalContainer#enqueueTransportInput', container, 'transport-queue'],
  ] as const) {
    assert.match(source, /shouldShowInputDiscardFeedback\(/u, `${name} must consult the shared rule`);
    assert.match(source, new RegExp(`site: '${site}'`, 'u'), `${name} must identify itself as ${site}`);
    assert.match(source, /publishInputDiscard\(sessionId\)/u, `${name} must publish the discard`);
  }

  // AC-5 again, at the call site: the publisher is given a session and nothing else.
  assert.doesNotMatch(view, /publishInputDiscard\(sessionId,\s*(data|input)/u);
  assert.doesNotMatch(container, /publishInputDiscard\(sessionId,\s*(data|input)/u);
});

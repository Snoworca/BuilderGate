import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendSteps, canAddStep, moveStep, newLoopDraft, numberField, parseLoopLine } from '../../src/components/Loop/loopModel.ts';
import { loopRejectionMessage, RUN_REASON_KEYS } from '../../src/components/Loop/loopMessages.ts';

// FR-LOOP-006 — the loop editor's step list and its one-line input.

test('FR-LOOP-006 AC-4: the example line becomes a command, a delay and a prompt', () => {
  assert.deepEqual(parseLoopLine('codex delay 2000 "금일 주식 시황 분석하시오"'), [
    { kind: 'command', text: 'codex' },
    { kind: 'delay', ms: 2000 },
    { kind: 'prompt', text: '금일 주식 시황 분석하시오' },
  ]);
});

test('FR-LOOP-006 AC-4: arguments stay with their command, several delays and prompts follow in order', () => {
  assert.deepEqual(parseLoopLine('codex --model gpt-5 delay 3000 "a" delay 1000 "b \\"c\\""'), [
    { kind: 'command', text: 'codex --model gpt-5' },
    { kind: 'delay', ms: 3000 },
    { kind: 'prompt', text: 'a' },
    { kind: 'delay', ms: 1000 },
    { kind: 'prompt', text: 'b "c"' },
  ]);
});

test('FR-LOOP-006 AC-4: exit is an ordinary command, not the session-end step', () => {
  assert.deepEqual(parseLoopLine('exit'), [{ kind: 'command', text: 'exit' }]);
  assert.deepEqual(parseLoopLine('   '), []);
});

test('FR-LOOP-006 AC-3: after a session-end step nothing more can be added', () => {
  const steps = [{ kind: 'command' as const, text: 'codex' }];
  assert.equal(canAddStep(steps), true);
  const ended = appendSteps(steps, [{ kind: 'end' }]);
  assert.equal(canAddStep(ended), false);
  assert.equal(appendSteps(ended, [{ kind: 'command', text: 'x' }]), ended);
});

test('FR-LOOP-006 AC-3: the session-end step stays last when steps are moved', () => {
  const steps = [{ kind: 'command' as const, text: 'a' }, { kind: 'command' as const, text: 'b' }, { kind: 'end' as const }];
  assert.deepEqual(moveStep(steps, 0, 1).map((s) => ('text' in s ? s.text : s.kind)), ['b', 'a', 'end']);
  assert.equal(moveStep(steps, 1, 1), steps, 'a step cannot move below the session end');
  assert.equal(moveStep(steps, 2, -1), steps, 'the session end cannot move up');
});

test('FR-LOOP-006 AC-3: a new loop starts on weekdays at the next whole hour in no folder', () => {
  const draft = newLoopDraft(new Date(2026, 9, 30, 14, 20));
  assert.equal(draft.schedule.kind, 'weekly');
  assert.deepEqual(draft.schedule.kind === 'weekly' && draft.schedule.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(draft.schedule.kind === 'weekly' && draft.schedule.times, ['15:00']);
  assert.equal(draft.keepTabs, 1);
  assert.deepEqual(draft.steps, []);
});

test('FR-LOOP-006 AC-3: an emptied number field is sent as nothing, so the server refuses it instead of saving 0', () => {
  assert.ok(Number.isNaN(numberField('')));
  assert.ok(Number.isNaN(numberField('  ')));
  assert.equal(numberField('2000'), 2000);
  assert.equal(JSON.stringify({ ms: numberField('') }), '{"ms":null}');
});

test('FR-LOOP-006 AC-5: every reason the server gives has words on screen', () => {
  for (const reason of ['name', 'shell', 'cwd', 'keepTabs', 'schedule', 'interval', 'startsAt', 'oncePassed', 'noSteps', 'emptyText', 'commandMultiline', 'delay', 'endNotLast', 'step']) {
    assert.ok(loopRejectionMessage(reason), reason);
  }
  assert.equal(loopRejectionMessage('nope'), null);
  for (const reason of ['previousRunning', 'tabCap', 'directoryMissing', 'cancelled', 'tabClosed', 'restart', 'inputRejected', 'error'] as const) {
    assert.ok(RUN_REASON_KEYS[reason], reason);
  }
});

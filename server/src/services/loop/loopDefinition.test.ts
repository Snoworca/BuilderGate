import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateLoopInput, type LoopInput } from './loopDefinition.js';

const NOW = new Date(2026, 9, 29, 12, 0);

const valid = (): LoopInput => ({
  name: '아침 주식 시황',
  enabled: true,
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['08:30'] },
  shell: 'powershell',
  cwd: 'C:\\work\\market',
  keepTabs: 1,
  steps: [
    { kind: 'command', text: 'codex' },
    { kind: 'delay', ms: 2000 },
    { kind: 'prompt', text: '금일 주식 시황 분석하시오\n표로 정리하시오' },
    { kind: 'end' },
  ],
});

const reason = (input: unknown) => {
  const result = validateLoopInput(input, NOW);
  return result.ok ? 'ok' : result.reason;
};

test('FR-LOOP-001 AC-1: a full definition is accepted as given, keepTabs defaulting to 1', () => {
  const result = validateLoopInput(valid(), NOW);
  assert.equal(result.ok, true);
  const { keepTabs: _keep, ...withoutKeep } = valid();
  const defaulted = validateLoopInput(withoutKeep, NOW);
  assert.ok(defaulted.ok && defaulted.value.target.kind === 'new' && defaulted.value.target.keepTabs === 1);
});

test('FR-LOOP-001 AC-1: keepTabs outside 1..16 is refused', () => {
  assert.equal(reason({ ...valid(), keepTabs: 0 }), 'keepTabs');
  assert.equal(reason({ ...valid(), keepTabs: 17 }), 'keepTabs');
});

test('FR-LOOP-001 AC-2: a session-end step anywhere but last is refused', () => {
  const steps = [{ kind: 'command', text: 'codex' }, { kind: 'end' }, { kind: 'delay', ms: 10 }];
  assert.equal(reason({ ...valid(), steps }), 'endNotLast');
});

test('FR-LOOP-001 AC-2: a delay must be a whole number of ms from 0 to one hour', () => {
  assert.equal(reason({ ...valid(), steps: [{ kind: 'delay', ms: -1 }] }), 'delay');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'delay', ms: 1.5 }] }), 'delay');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'delay', ms: 3_600_001 }] }), 'delay');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'delay', ms: 3_600_000 }] }), 'ok');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'delay', ms: null }] }), 'delay', 'an emptied wait field is refused, not saved as 0');
});

test('FR-LOOP-001 AC-2: a command is one line; a prompt may have several', () => {
  assert.equal(reason({ ...valid(), steps: [{ kind: 'command', text: 'a\nb' }] }), 'commandMultiline');
});

test('FR-LOOP-001 AC-3: no steps, an empty command or prompt, or nothing chosen in the schedule is refused', () => {
  assert.equal(reason({ ...valid(), steps: [] }), 'noSteps');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'command', text: '  ' }] }), 'emptyText');
  assert.equal(reason({ ...valid(), steps: [{ kind: 'prompt', text: '' }] }), 'emptyText');
  assert.equal(reason({ ...valid(), schedule: { kind: 'weekly', days: [], times: ['08:30'] } }), 'schedule');
  assert.equal(reason({ ...valid(), schedule: { kind: 'monthly', dates: [], lastDay: false, times: ['08:30'] } }), 'schedule');
  assert.equal(reason({ ...valid(), schedule: { kind: 'weekly', days: [1], times: [] } }), 'schedule');
  assert.equal(reason({ ...valid(), schedule: { kind: 'weekly', days: [7], times: ['08:30'] } }), 'schedule');
  assert.equal(reason({ ...valid(), schedule: { kind: 'weekly', days: [1], times: ['25:00'] } }), 'schedule');
  assert.equal(reason({ ...valid(), schedule: { kind: 'interval', everyMinutes: 0, startsAt: '2026-10-29T09:00' } }), 'interval');
  assert.equal(reason({ ...valid(), schedule: { kind: 'interval', everyMinutes: null, startsAt: '2026-10-29T09:00' } }), 'interval');
  assert.equal(reason({ ...valid(), schedule: { kind: 'interval', everyMinutes: 30, startsAt: '' } }), 'startsAt');
});

test('FR-LOOP-001 AC-4: a one-time date whose times have all passed is refused', () => {
  assert.equal(reason({ ...valid(), schedule: { kind: 'once', date: '2026-10-29', times: ['09:00'] } }), 'oncePassed');
  assert.equal(reason({ ...valid(), schedule: { kind: 'once', date: '2026-10-29', times: ['09:00', '13:00'] } }), 'ok');
  // A finished one-time loop can still be renamed or kept while it is off.
  assert.equal(reason({ ...valid(), enabled: false, schedule: { kind: 'once', date: '2026-10-29', times: ['09:00'] } }), 'ok');
});

test('FR-LOOP-001: name, shell and directory are required', () => {
  assert.equal(reason({ ...valid(), name: ' ' }), 'name');
  assert.equal(reason({ ...valid(), shell: 'fish' }), 'shell');
  assert.equal(reason({ ...valid(), cwd: '' }), 'cwd');
  assert.equal(reason(null), 'name');
});

// FR-LOOP-008: the target — a new session, or an existing session tab.

const sessionTarget = { kind: 'session', tabId: 'tab-7', label: { workspaceName: 'ProjectMaster', tabName: 'api-server' }, skipWhenBusy: false };

const sessionLoop = () => {
  const { shell: _s, cwd: _c, keepTabs: _k, ...rest } = valid();
  return { ...rest, target: sessionTarget, steps: [{ kind: 'prompt', text: '진행 상황을 알려 주세요' }] };
};

test('FR-LOOP-008 AC-1: a definition without target reads as a new session from shell, cwd and keepTabs', () => {
  const result = validateLoopInput(valid(), NOW);
  assert.ok(result.ok);
  assert.deepEqual(result.value.target, { kind: 'new', shell: 'powershell', cwd: 'C:\\work\\market', keepTabs: 1 });
  assert.equal('shell' in result.value, false, 'the stored shape keeps the target only');
});

test('FR-LOOP-008 AC-1: an explicit new-session target is used as given', () => {
  const { shell: _s, cwd: _c, keepTabs: _k, ...rest } = valid();
  const result = validateLoopInput({ ...rest, target: { kind: 'new', shell: 'bash', cwd: '/work', keepTabs: 3 } }, NOW);
  assert.ok(result.ok);
  assert.deepEqual(result.value.target, { kind: 'new', shell: 'bash', cwd: '/work', keepTabs: 3 });
  assert.equal(reason({ ...rest, target: { kind: 'new', shell: 'bash', cwd: '' } }), 'cwd');
  assert.equal(reason({ ...rest, target: { kind: 'new', shell: 'fish', cwd: '/w' } }), 'shell');
});

test('FR-LOOP-008 AC-1: an existing-session target keeps the tab id and label; skipWhenBusy defaults to on', () => {
  const result = validateLoopInput(sessionLoop(), NOW);
  assert.ok(result.ok);
  assert.deepEqual(result.value.target, sessionTarget);
  const { skipWhenBusy: _skip, label: _label, ...bare } = sessionTarget;
  const defaulted = validateLoopInput({ ...sessionLoop(), target: bare }, NOW);
  assert.ok(defaulted.ok);
  assert.deepEqual(defaulted.value.target, { kind: 'session', tabId: 'tab-7', label: { workspaceName: '', tabName: '' }, skipWhenBusy: true });
});

test('FR-LOOP-008 AC-1: an existing-session target needs a tab id; an unknown or malformed target is refused as target', () => {
  assert.equal(reason({ ...sessionLoop(), target: { ...sessionTarget, tabId: ' ' } }), 'session');
  assert.equal(reason({ ...sessionLoop(), target: { kind: 'elsewhere' } }), 'target', 'an unknown kind has its own reason');
  assert.equal(reason({ ...sessionLoop(), target: 'mine' }), 'target');
});

test('FR-LOOP-008 AC-2: a session-end step is refused for an existing-session loop', () => {
  assert.equal(reason({ ...sessionLoop(), steps: [{ kind: 'prompt', text: 'hi' }, { kind: 'end' }] }), 'endNotAllowed');
});

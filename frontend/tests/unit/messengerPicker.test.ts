import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeMentionQuery,
  applyPickerItem,
  buildPickerModel,
  movePickerSelection,
  recipientSummary,
  type PickerSource,
} from '../../src/components/Messenger/mentionPicker.ts';

// FR-MSG-003 AC-6 — the composer's @ picker, as mockup ② draws it.

const source: PickerSource = {
  people: [
    { node: '이영희_과장', connected: false, sessions: [{ name: 'git viewer 개선', status: 'idle' }] },
    { node: '김철수_대리', connected: true, sessions: [{ name: 'frontend-auth', status: 'busy' }, { name: '터미널2', status: 'idle' }] },
  ],
  mine: [{ name: 'api-server', status: 'busy' }, { name: '터미널2', status: 'idle' }],
};

test('AC-6: no @ before the caret means no picker', () => {
  assert.equal(activeMentionQuery('hello'), null);
  assert.equal(activeMentionQuery('mail a@b'), null);
  assert.equal(activeMentionQuery('@done '), null);
});

test('AC-6: the query starts at the @ and runs to the caret, quotes included', () => {
  assert.deepEqual(activeMentionQuery('hi @김'), { start: 3, query: '김' });
  assert.deepEqual(activeMentionQuery('@김철수_대리::"git vi'), { start: 0, query: '김철수_대리::"git vi' });
});

test('AC-6: on @ the list shows people first (connected first), then my sessions', () => {
  const model = buildPickerModel('', source);
  assert.equal(model.crumb, null);
  assert.deepEqual(model.items.map((item) => [item.section, item.label]), [
    ['people', '김철수_대리'],
    ['people', '이영희_과장'],
    ['mine', 'api-server'],
    ['mine', '터미널2'],
  ]);
  assert.equal(model.items[1].disabled, true);
  assert.equal(model.items[0].insert, '@김철수_대리::');
  assert.equal(model.items[0].done, false);
  assert.equal(model.items[2].insert, '@api-server ');
});

test('AC-6: typing filters case-insensitively by substring', () => {
  const model = buildPickerModel('이', source);
  assert.deepEqual(model.items.map((item) => item.label), ['이영희_과장']);
  assert.deepEqual(buildPickerModel('API', source).items.map((item) => item.label), ['api-server']);
  assert.equal(buildPickerModel('zzz', source).items.length, 0);
});

test('AC-6: :: switches to that person\'s sessions in this room and filters them', () => {
  const model = buildPickerModel('김철수_대리::', source);
  assert.equal(model.crumb, '김철수_대리');
  assert.deepEqual(model.items.map((item) => [item.section, item.label, item.insert]), [
    ['remote', 'frontend-auth', '@김철수_대리::frontend-auth '],
    ['remote', '터미널2', '@김철수_대리::터미널2 '],
  ]);
  assert.deepEqual(buildPickerModel('김철수_대리::터', source).items.map((item) => item.label), ['터미널2']);
});

test('AC-1: a session name with spaces is inserted with quotes', () => {
  const model = buildPickerModel('이영희_과장::"git', source);
  assert.deepEqual(model.items.map((item) => item.insert), ['@이영희_과장::"git viewer 개선" ']);
});

test('AC-6: an unknown person after :: shows nothing', () => {
  assert.equal(buildPickerModel('박민수_부장::', source).items.length, 0);
});

test('AC-6: choosing replaces the query and leaves the caret after the insert', () => {
  const value = 'hi @김 rest';
  const result = applyPickerItem(value, 5, { start: 3, insert: '@김철수_대리::' });
  assert.deepEqual(result, { value: 'hi @김철수_대리:: rest', caret: 12 });
});

test('AC-6: arrow keys wrap around', () => {
  assert.equal(movePickerSelection(0, 3, 1), 1);
  assert.equal(movePickerSelection(2, 3, 1), 0);
  assert.equal(movePickerSelection(0, 3, -1), 2);
  assert.equal(movePickerSelection(0, 0, 1), 0);
});

const room = {
  me: '홍길동_팀장',
  people: ['홍길동_팀장', '김철수_대리'],
  sessions: [
    { id: '홍길동_팀장::k1', node: '홍길동_팀장', name: 'api-server' },
    { id: '김철수_대리::k3', node: '김철수_대리', name: 'frontend-auth' },
    { id: '김철수_대리::k4', node: '김철수_대리', name: '터미널2' },
  ],
};

test('AC-2: no session mention means the whole room, counted without me as sender', () => {
  assert.deepEqual(recipientSummary('hello', room), { kind: 'room', sessions: 3, chips: [], missing: [], ambiguous: [] });
});

test('AC-2: session mentions become chips and the 1:n ratio', () => {
  const summary = recipientSummary('@api-server @김철수_대리::frontend-auth go', room);
  assert.equal(summary.kind, 'targets');
  assert.deepEqual(summary.chips.map((chip) => [chip.label, chip.index]), [['api-server', 0], ['김철수_대리::frontend-auth', 1]]);
});

test('AC-3/AC-4: person-only mentions are not chips; unknown names are reported', () => {
  const summary = recipientSummary('@김철수_대리 @nobody', room);
  // D4: an unknown name means the recipients cannot be decided, not "the whole room".
  assert.equal(summary.kind, 'blocked');
  assert.deepEqual(summary.chips, []);
  assert.deepEqual(summary.missing, ['@nobody']);
});

test('AC-6: the picker opens after punctuation too, as the server reads mentions', () => {
  assert.deepEqual(activeMentionQuery('(@김'), { start: 1, query: '김' });
  assert.equal(activeMentionQuery('x_@a'), null);
});

test('D4: an unknown or ambiguous name blocks the recipients even beside a good one', () => {
  assert.equal(recipientSummary('@nobody hi', room).kind, 'blocked');
  assert.equal(recipientSummary('@api-server @nobody', room).kind, 'blocked');
  assert.equal(recipientSummary('@김철수_대리 hi', room).kind, 'room');
});

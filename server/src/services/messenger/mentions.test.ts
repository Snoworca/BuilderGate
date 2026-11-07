// FR-MSG-003: @ mentions — tokenizer and resolution against the room (contract §5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMentions, resolveTargets, tokenizeMentions, type MentionRoster } from './mentions.js';

const roster: MentionRoster = {
  selfNode: 'alice',
  people: ['alice', 'bob', '김철수_대리'],
  sessions: [
    { id: 'alice::s1', node: 'alice', name: 'worker' },
    { id: 'alice::s2', node: 'alice', name: 'my build' },
    { id: 'bob::s1', node: 'bob', name: 'worker' },
    { id: 'bob::s2', node: 'bob', name: 'api server' },
  ],
};

test('FR-MSG-003 AC-1: grammar — @name, @node::name, quoted names, first :: splits', () => {
  const tokens = tokenizeMentions('hi @worker and @bob::"api server", also @"my build" and @a::b::c.');
  assert.deepEqual(tokens.map((t) => ({ node: t.node, name: t.name })), [
    { node: undefined, name: 'worker' },
    { node: 'bob', name: 'api server' },
    { node: undefined, name: 'my build' },
    { node: 'a', name: 'b::c' },
  ]);
  assert.equal(tokens[0]!.raw, '@worker');
  assert.equal(tokens[1]!.raw, '@bob::"api server"');
});

test('FR-MSG-003 AC-1: @ only at a word start; trailing punctuation is not part of the name', () => {
  assert.deepEqual(tokenizeMentions('mail me at a@b.com'), []);
  assert.deepEqual(tokenizeMentions('(@worker), @bob: ok').map((t) => t.name), ['worker', 'bob']);
  assert.deepEqual(tokenizeMentions('@ alone and @"unclosed'), []);
});

test('FR-MSG-003 AC-1/AC-2: @session is my server, @person::session another; no session mention = whole room', () => {
  assert.deepEqual(resolveMentions('@worker please', roster), { ok: true, to: ['alice::s1'] });
  assert.deepEqual(resolveMentions('@bob::worker and @bob::"api server"', roster), { ok: true, to: ['bob::s1', 'bob::s2'] });
  assert.deepEqual(resolveMentions('hello room', roster), { ok: true, to: [] });
});

test('FR-MSG-003 AC-4: @person names the person (node id), Korean names with _ included', () => {
  assert.deepEqual(resolveMentions('@bob look', roster), { ok: true, to: ['bob'] });
  assert.deepEqual(resolveMentions('@김철수_대리 확인', roster), { ok: true, to: ['김철수_대리'] });
  assert.deepEqual(resolveMentions('@BOB case-insensitive node', roster), { ok: true, to: ['bob'] });
});

test('FR-MSG-003 AC-3: two matches → AMBIGUOUS_TARGET with candidates; none → TARGET_NOT_FOUND', () => {
  const twin: MentionRoster = { ...roster, sessions: [...roster.sessions, { id: 'alice::s9', node: 'alice', name: 'worker' }] };
  assert.deepEqual(resolveMentions('@worker', twin), { ok: false, code: 'AMBIGUOUS_TARGET', name: 'worker', candidates: ['alice::s1', 'alice::s9'] });
  assert.deepEqual(resolveMentions('@nobody', roster), { ok: false, code: 'TARGET_NOT_FOUND', name: 'nobody' });
  assert.deepEqual(resolveMentions('@bob::ghost', roster), { ok: false, code: 'TARGET_NOT_FOUND', name: 'bob::ghost' });
});

test('FR-MSG-003 AC-1: session names are case-sensitive', () => {
  assert.deepEqual(resolveMentions('@Worker', roster), { ok: false, code: 'TARGET_NOT_FOUND', name: 'Worker' });
});

test('FR-MSG-003 AC-5: duplicates collapse; order of first mention kept', () => {
  assert.deepEqual(resolveMentions('@worker @bob @worker', roster), { ok: true, to: ['alice::s1', 'bob'] });
});

test('FR-MSG-007 AC-2: to entries are mention texts or member ids, merged with the text', () => {
  assert.deepEqual(resolveTargets(['bob::s2', '@worker', 'bob'], roster), { ok: true, to: ['bob::s2', 'alice::s1', 'bob'] });
  assert.deepEqual(resolveTargets(['@bob::"api server"'], roster), { ok: true, to: ['bob::s2'] });
  assert.deepEqual(resolveTargets(['ghost'], roster), { ok: false, code: 'TARGET_NOT_FOUND', name: 'ghost' });
});

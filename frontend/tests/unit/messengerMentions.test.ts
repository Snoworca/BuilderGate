import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findMentions,
  formatMention,
  resolveMention,
  removeMentionAt,
  splitMessageText,
} from '../../src/components/Messenger/mentions.ts';

// FR-MSG-003 — the @ grammar of contract §5, copied from the server for highlighting
// and for the composer's own checks.

const pick = (text: string) => findMentions(text).map(({ node, name, raw }) => ({ node, name, raw }));

test('FR-MSG-003 AC-1: @name is a mention without a node', () => {
  assert.deepEqual(pick('@터미널2 다시 돌려 주세요'), [{ node: null, name: '터미널2', raw: '@터미널2' }]);
});

test('FR-MSG-003 AC-1: the first :: splits node and session name', () => {
  assert.deepEqual(pick('hi @김철수_대리::frontend-auth ok'), [
    { node: '김철수_대리', name: 'frontend-auth', raw: '@김철수_대리::frontend-auth' },
  ]);
  assert.deepEqual(pick('@a::b::c'), [{ node: 'a', name: 'b::c', raw: '@a::b::c' }]);
});

test('FR-MSG-003 AC-1: quoted names keep their spaces, with or without a node', () => {
  assert.deepEqual(pick('@김철수_대리::"git viewer 개선" 봐 주세요'), [
    { node: '김철수_대리', name: 'git viewer 개선', raw: '@김철수_대리::"git viewer 개선"' },
  ]);
  assert.deepEqual(pick('@"세션 복구 작업 판단" 확인'), [
    { node: null, name: '세션 복구 작업 판단', raw: '@"세션 복구 작업 판단"' },
  ]);
});

test('FR-MSG-003: a token must start a word; mail addresses and bare @ are not mentions', () => {
  assert.deepEqual(pick('mail me at a@b.com'), []);
  assert.deepEqual(pick('@ alone'), []);
  assert.deepEqual(pick('@node:: nothing'), []);
  assert.deepEqual(pick('@"unterminated'), []);
});

test('FR-MSG-003: several mentions keep their positions', () => {
  const found = findMentions('@a @b::c\n@"d e"');
  assert.deepEqual(found.map((m) => [m.start, m.end]), [[0, 2], [3, 8], [9, 15]]);
});

test('FR-MSG-003 AC-1: formatMention quotes names that would not survive the grammar', () => {
  assert.equal(formatMention(null, 'api-server'), '@api-server');
  assert.equal(formatMention('김철수_대리', 'git viewer 개선'), '@김철수_대리::"git viewer 개선"');
  assert.equal(formatMention(null, 'a::b'), '@"a::b"');
});

const room = {
  me: '홍길동_팀장',
  people: ['홍길동_팀장', '김철수_대리'],
  sessions: [
    { id: '홍길동_팀장::k1', node: '홍길동_팀장', name: 'api-server' },
    { id: '홍길동_팀장::k2', node: '홍길동_팀장', name: '터미널2' },
    { id: '김철수_대리::k3', node: '김철수_대리', name: '터미널2' },
    { id: '김철수_대리::k4', node: '김철수_대리', name: 'dup' },
    { id: '김철수_대리::k5', node: '김철수_대리', name: 'dup' },
  ],
};

test('FR-MSG-003 AC-1: @x is my session first, then a person', () => {
  assert.deepEqual(resolveMention({ node: null, name: '터미널2' }, room), { kind: 'session', id: '홍길동_팀장::k2' });
  assert.deepEqual(resolveMention({ node: null, name: '김철수_대리' }, room), { kind: 'person', node: '김철수_대리' });
});

test('FR-MSG-003 AC-1: @node::x is a session of that node', () => {
  assert.deepEqual(resolveMention({ node: '김철수_대리', name: '터미널2' }, room), { kind: 'session', id: '김철수_대리::k3' });
});

test('FR-MSG-003 AC-3: two matches are ambiguous, none is missing', () => {
  assert.deepEqual(resolveMention({ node: '김철수_대리', name: 'dup' }, room), { kind: 'ambiguous' });
  assert.deepEqual(resolveMention({ node: null, name: 'nobody' }, room), { kind: 'missing' });
  assert.deepEqual(resolveMention({ node: '이영희_과장', name: 'x' }, room), { kind: 'missing' });
});

test('FR-MSG-003 AC-6: removing a recipient chip removes its token and the space after it', () => {
  assert.equal(removeMentionAt('@a @b::c hello', 1), '@a hello');
  assert.equal(removeMentionAt('@a hello', 0), 'hello');
});

test('FR-MSG-002 AC-5: only code spans, code blocks and mentions are recognised in a body', () => {
  assert.deepEqual(splitMessageText('see `x` and @a\n```\nblock @b\n```'), [
    { kind: 'text', text: 'see ' },
    { kind: 'code', text: 'x' },
    { kind: 'text', text: ' and ' },
    { kind: 'mention', text: '@a', node: null, name: 'a' },
    { kind: 'text', text: '\n' },
    { kind: 'block', text: 'block @b\n' },
  ]);
  assert.deepEqual(splitMessageText('**not bold**'), [{ kind: 'text', text: '**not bold**' }]);
});

// The server's rule (w-server-core): what may stand before @, and trailing punctuation.
test('FR-MSG-003: @ after a letter, digit, _ or @ is not a mention; after punctuation it is', () => {
  assert.deepEqual(pick('a@b.com x_@y z@@w'), []);
  assert.deepEqual(pick('(@api-server) ok'), [{ node: null, name: 'api-server', raw: '@api-server' }]);
  assert.deepEqual(pick('hi,@a'), [{ node: null, name: 'a', raw: '@a' }]);
});

test('FR-MSG-003: trailing .,;:!?)]}>\'’ is not part of an unquoted name, and raw/end leave it out', () => {
  const found = findMentions('ask @a, then @kim::worker. Or @b! @c\' @d’ @e)]');
  assert.deepEqual(found.map(({ node, name, raw }) => [node, name, raw]), [
    [null, 'a', '@a'], ['kim', 'worker', '@kim::worker'], [null, 'b', '@b'], [null, 'c', '@c'], [null, 'd', '@d'], [null, 'e', '@e'],
  ]);
  assert.equal(found[0].end, 'ask @a'.length);
});

test('FR-MSG-003: an empty name after stripping, or an empty node, is not a mention', () => {
  assert.deepEqual(pick('@... @::x @kim::. @""'), []);
});

test('FR-MSG-003: a quoted name keeps its punctuation', () => {
  assert.deepEqual(pick('@kim::"a, b." done'), [{ node: 'kim', name: 'a, b.', raw: '@kim::"a, b."' }]);
});

// FR-MSG-003 AC-5: a body names members by the ids stored in `to`, shown with their current names.
import { labelMentions } from '../../src/components/Messenger/mentions.ts';

const renamedRoom = {
  me: 'hong',
  people: ['hong', 'kim'],
  sessions: [
    { id: 'hong::k1', node: 'hong', name: 'api-server2' },
    { id: 'kim::k3', node: 'kim', name: 'frontend' },
  ],
};

test('FR-MSG-003 AC-5: renamed sessions show their current name, matched through the stored ids', () => {
  const segments = labelMentions(splitMessageText('@api-server @kim::fe and @kim'), ['hong::k1', 'kim::k3', 'kim'], renamedRoom);
  const mentions = segments.filter((segment) => segment.kind === 'mention');
  assert.deepEqual(mentions.map((m) => m.kind === 'mention' ? [m.shownNode, m.shownName] : null), [
    [null, 'api-server2'],
    ['kim', 'frontend'],
    [null, 'kim'],
  ]);
});

test('FR-MSG-003 AC-5: a mention with nothing to match keeps its own text', () => {
  const segments = labelMentions(splitMessageText('@gone @kim::old'), [], renamedRoom);
  assert.deepEqual(segments.filter((s) => s.kind === 'mention').map((m) => m.kind === 'mention' ? [m.shownNode, m.shownName] : null), [
    [null, 'gone'],
    ['kim', 'old'],
  ]);
});

test('FR-MSG-003 AC-5: a mention that still resolves uses that member even if `to` lists others first', () => {
  const segments = labelMentions(splitMessageText('@kim::frontend @api-server'), ['hong::k1', 'kim::k3'], renamedRoom);
  assert.deepEqual(segments.filter((s) => s.kind === 'mention').map((m) => m.kind === 'mention' ? [m.shownNode, m.shownName] : null), [
    ['kim', 'frontend'],
    [null, 'api-server2'],
  ]);
});

// D9: control characters never reach the screen; new lines and tabs stay.
import { stripControlChars } from '../../src/components/Messenger/mentions.ts';

test('D9: C0 and C1 control characters are dropped, \\n and \\t kept', () => {
  assert.equal(stripControlChars('a\u0007b\u001b[31m\nc\td\u009be\u007f'), 'ab[31m\nc\tde');
  assert.equal(stripControlChars('plain'), 'plain');
});

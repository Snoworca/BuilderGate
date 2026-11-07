import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyContactInput,
  connectFailureKey,
  deliveryLabel,
  foldAgentRuns,
  headerBadge,
  messengerLayout,
  roomBadge,
  senderView,
  sortRooms,
  validatePersonName,
  visiblePanes,
} from '../../src/components/Messenger/messengerModel.ts';
import type { RoomMessage } from '../../src/components/Messenger/messengerTypes.ts';

const msg = (seq: number | null, kind: 'human' | 'agent' | 'system', extra: Partial<RoomMessage> = {}): RoomMessage => ({
  seq,
  clientMsgId: `c${seq ?? 'x'}-${kind}`,
  roomId: 'rm_1',
  at: `2026-11-05T0${(seq ?? 0) % 10}:00:00.000Z`,
  from: { node: 'a', kind, ...(kind === 'agent' ? { sessionKey: 's' } : {}) },
  to: [],
  text: 't',
  ...extra,
});

// FR-MSG-002 AC-5 — a long run of agent messages folds, the last two stay open.
test('FR-MSG-002 AC-5: runs of five or more agent messages fold all but the last two', () => {
  const list = [msg(1, 'human'), ...[2, 3, 4, 5, 6, 7].map((n) => msg(n, 'agent')), msg(8, 'human')];
  const items = foldAgentRuns(list, new Set());
  assert.deepEqual(items.map((item) => item.kind === 'fold' ? `fold:${item.count}` : `m:${item.message.seq}`), [
    'm:1', 'fold:4', 'm:6', 'm:7', 'm:8',
  ]);
  const fold = items[1];
  assert.ok(fold.kind === 'fold');
  assert.equal(fold.firstAt, list[1].at);
  assert.equal(fold.lastAt, list[4].at);
});

test('FR-MSG-002 AC-5: a short run is not folded and an expanded fold opens', () => {
  const short = [msg(1, 'agent'), msg(2, 'agent'), msg(3, 'agent'), msg(4, 'agent')];
  assert.equal(foldAgentRuns(short, new Set()).every((item) => item.kind === 'message'), true);
  const long = [1, 2, 3, 4, 5].map((n) => msg(n, 'agent'));
  const folded = foldAgentRuns(long, new Set());
  assert.equal(folded[0].kind, 'fold');
  const key = folded[0].kind === 'fold' ? folded[0].key : '';
  assert.equal(foldAgentRuns(long, new Set([key])).every((item) => item.kind === 'message'), true);
});

test('FR-MSG-002 AC-5: a system line breaks a run', () => {
  const list = [msg(1, 'agent'), msg(2, 'agent'), msg(3, 'system'), msg(4, 'agent'), msg(5, 'agent'), msg(6, 'agent')];
  assert.equal(foldAgentRuns(list, new Set()).some((item) => item.kind === 'fold'), false);
});

// FR-MSG-002 AC-4, FR-MSG-011 — three delivery states.
test('FR-MSG-002 AC-4: unsequenced is sending (with the host named when it is off)', () => {
  assert.deepEqual(deliveryLabel(msg(null, 'human'), { hostOnline: true, hostNode: 'h' }), { tone: 'wait', key: 'messenger.delivery.sending' });
  assert.deepEqual(deliveryLabel(msg(null, 'human'), { hostOnline: false, hostNode: 'h' }), { tone: 'wait', key: 'messenger.delivery.sendingHostOff', params: { host: 'h' } });
});

test('FR-MSG-002 AC-4: receipts decide delivered vs pasted n/m; no session target shows nothing', () => {
  const ctx = { hostOnline: true, hostNode: 'h' };
  // M-4: nothing delivered is still sending; some not delivered is 대기 n; any paste is 붙여넣음 a/b.
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 0, pasted: 0 } }), ctx), { tone: 'wait', key: 'messenger.delivery.sending' });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 2, pasted: 0 } }), ctx), { tone: 'wait', key: 'messenger.delivery.waitingCount', params: { count: 1 } });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 3, pasted: 0 } }), ctx), { tone: 'neutral', key: 'messenger.delivery.delivered' });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 3, pasted: 1 } }), ctx), { tone: 'ok', key: 'messenger.delivery.pasted', params: { pasted: 1, total: 3 } });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 3, pasted: 3 } }), ctx), { tone: 'ok', key: 'messenger.delivery.pasted', params: { pasted: 3, total: 3 } });
  assert.equal(deliveryLabel(msg(3, 'human', { receipts: { targets: 0, delivered: 0, pasted: 0 } }), ctx), null);
  assert.deepEqual(deliveryLabel(msg(3, 'human'), ctx), { tone: 'neutral', key: 'messenger.delivery.delivered' });
});

test('FR-MSG-005: a held message is not pasted, whatever its receipts say', () => {
  assert.deepEqual(
    deliveryLabel(msg(3, 'agent', { held: true, receipts: { targets: 2, delivered: 2, pasted: 0 } }), { hostOnline: true, hostNode: 'h' }),
    { tone: 'wait', key: 'messenger.delivery.held' },
  );
  assert.equal(deliveryLabel(msg(3, 'system'), { hostOnline: true, hostNode: 'h' }), null);
});

// FR-MSG-001 AC-2, FR-MSG-005 AC-3, FR-MSG-013 AC-1 — badges.
const summary = (over: object) => ({
  id: 'r', name: 'n', hostNode: 'h', isHost: true, hostOnline: true, lastAt: '', lastText: '', lastFrom: '',
  unread: 0, mention: 0, held: false, invitedPending: [], ...over,
});

test('FR-MSG-005 AC-3: a held room shows ! before any count', () => {
  assert.deepEqual(roomBadge(summary({ held: true, unread: 4, mention: 1 })), { tone: 'hold', text: '!' });
  assert.deepEqual(roomBadge(summary({ unread: 4, mention: 1 })), { tone: 'mention', text: '@1' });
  assert.deepEqual(roomBadge(summary({ unread: 4 })), { tone: 'unread', text: '4' });
  assert.equal(roomBadge(summary({})), null);
});

test('FR-MSG-013 AC-1: the header badge counts unread plus things waiting for me; red on a mention or a request', () => {
  assert.deepEqual(headerBadge({ total: 3, mention: 1 }, 0), { count: 3, tone: 'danger' });
  assert.deepEqual(headerBadge({ total: 3, mention: 0 }, 0), { count: 3, tone: 'accent' });
  assert.deepEqual(headerBadge({ total: 0, mention: 0 }, 1), { count: 1, tone: 'danger' });
  assert.equal(headerBadge({ total: 0, mention: 0 }, 0), null);
});

test('FR-MSG-001 AC-2: rooms sort by last message time, newest first', () => {
  const rooms = [summary({ id: 'a', lastAt: '2026-11-05T01:00:00Z' }), summary({ id: 'b', lastAt: '2026-11-05T03:00:00Z' }), summary({ id: 'c', lastAt: '' })];
  assert.deepEqual(sortRooms(rooms).map((room) => room.id), ['b', 'a', 'c']);
});

// FR-MSG-013 AC-2 — narrow layout.
test('FR-MSG-013 AC-2: below 640px or on a phone the window shows one pane at a time', () => {
  assert.equal(messengerLayout(900, false), 'split');
  assert.equal(messengerLayout(639, false), 'single');
  assert.equal(messengerLayout(900, true), 'single');
  assert.deepEqual(visiblePanes('split', null), { list: true, room: true });
  assert.deepEqual(visiblePanes('single', null), { list: true, room: false });
  assert.deepEqual(visiblePanes('single', 'rm_1'), { list: false, room: true });
});

// FR-MSG-013 AC-4, FR-MSG-004 AC-5 — who said it and in which colour.
test('FR-MSG-013 AC-4: a person is human, my session is local, another PC\'s session is remote', () => {
  const sessions = [{ id: 'me::k', node: 'me', sessionKey: 'k', name: 'api-server', enter: true, pasteAll: false }, { id: 'kim::f', node: 'kim', sessionKey: 'f', name: 'frontend-auth', enter: true, pasteAll: false }];
  assert.deepEqual(senderView({ node: 'kim', kind: 'human' }, 'me', sessions), { tone: 'human', name: 'kim', initial: 'K' });
  assert.deepEqual(senderView({ node: 'me', kind: 'agent', sessionKey: 'k' }, 'me', sessions), { tone: 'local', name: 'api-server', initial: 'A' });
  assert.deepEqual(senderView({ node: 'kim', kind: 'agent', sessionKey: 'f' }, 'me', sessions), { tone: 'remote', name: 'kim::frontend-auth', initial: 'F' });
  assert.deepEqual(senderView({ node: 'kim', kind: 'agent', sessionKey: 'gone' }, 'me', sessions), { tone: 'remote', name: 'kim::gone', initial: 'G' });
});

// FR-MSG-008 AC-1 — name rules, mockup ④.
test('FR-MSG-008 AC-1: names reject whitespace, ::, @ and /, my name and case-only duplicates', () => {
  const ctx = { myName: '홍길동_팀장', existing: ['김철수_대리'] };
  assert.equal(validatePersonName('이영희_과장', ctx), null);
  assert.equal(validatePersonName('이 지수', ctx), 'messenger.name.error.space');
  assert.equal(validatePersonName('이영희::과장', ctx), 'messenger.name.error.forbidden');
  assert.equal(validatePersonName('a@b', ctx), 'messenger.name.error.forbidden');
  assert.equal(validatePersonName('a/b', ctx), 'messenger.name.error.forbidden');
  assert.equal(validatePersonName('김철수_대리', ctx), 'messenger.name.error.duplicate');
  assert.equal(validatePersonName('홍길동_팀장', ctx), 'messenger.name.error.mine');
  assert.equal(validatePersonName('', ctx), 'messenger.name.error.empty');
  assert.equal(validatePersonName('_x', ctx), 'messenger.name.error.pattern');
  assert.equal(validatePersonName('a'.repeat(33), ctx), 'messenger.name.error.pattern');
  assert.equal(validatePersonName('ABC', { myName: 'x', existing: ['abc'] }), 'messenger.name.error.duplicate');
});

test('FR-MSG-008 AC-3/AC-4: one input takes an address, a connection code or an invite code', () => {
  assert.equal(classifyContactInput(''), 'empty');
  assert.equal(classifyContactInput('  bgc1.eyJ2IjoxfQ '), 'contact-code');
  assert.equal(classifyContactInput('bgi1.eyJ2IjoxfQ'), 'invite-code');
  assert.equal(classifyContactInput('10.0.1.100:3000'), 'address');
  assert.equal(classifyContactInput('pc-kim.local:2002'), 'address');
  // Without a port the server uses the LAN port 3334.
  assert.equal(classifyContactInput('10.0.1.100'), 'address');
  assert.equal(classifyContactInput('pc-kim.local'), 'address');
  assert.equal(classifyContactInput('10.0.1.100:99999'), 'invalid');
  assert.equal(classifyContactInput('hello world'), 'invalid');
});

test('FR-MSG-008 AC-5: connection failures (server codes) map to mockup ④ wording', () => {
  assert.equal(connectFailureKey('CODE_INVALID'), 'messenger.connect.error.codeExpired');
  assert.equal(connectFailureKey('ADDRESS_UNREACHABLE'), 'messenger.connect.error.unreachable');
  assert.equal(connectFailureKey('TLS_FINGERPRINT_CHANGED'), 'messenger.connect.error.fingerprint');
  assert.equal(connectFailureKey('CODE_EXPIRED'), null);
  assert.equal(connectFailureKey('SOMETHING_ELSE'), null);
});

// Mockup ③/⑤ — the session picker: grouped by workspace, searched like session.search, with a status chip.
import { agentChip, groupSessions } from '../../src/components/Messenger/messengerModel.ts';

test('mockup ③: an agent at work is "<Agent> working", anything else is idle', () => {
  assert.deepEqual(agentChip({ agentKind: 'claude', agentStatus: 'busy' }), { tone: 'ok', key: 'messenger.agent.working', params: { agent: 'Claude' } });
  assert.deepEqual(agentChip({ agentKind: 'codex', agentStatus: 'waiting_input' }), { tone: 'ok', key: 'messenger.agent.waiting', params: { agent: 'Codex' } });
  assert.deepEqual(agentChip({ agentStatus: 'ready' }), { tone: 'neutral', key: 'messenger.agent.idle' });
  assert.deepEqual(agentChip({}), { tone: 'neutral', key: 'messenger.agent.idle' });
});

test('mockup ③: sessions group by workspace in workspace order; search words match in any order', () => {
  const workspaces = [{ id: 'w2', name: 'AgentKernelX', sortOrder: 2 }, { id: 'w1', name: 'ProjectMaster', sortOrder: 1 }];
  const sessions = [
    { sessionKey: 'a', name: 'api-server', workspaceId: 'w1', cwd: 'C:\\work\\ProjectMaster\\server' },
    { sessionKey: 'b', name: '터미널2', workspaceId: 'w1', cwd: 'C:\\work\\ProjectMaster' },
    { sessionKey: 'c', name: 'remote ext', workspaceId: 'w2', cwd: '/home/beom/AgentKernelX' },
    { sessionKey: 'd', name: 'orphan', cwd: '/tmp' },
  ];
  assert.deepEqual(groupSessions(sessions, workspaces, '').map((group) => [group.name, group.sessions.map((s) => s.sessionKey)]), [
    ['ProjectMaster', ['a', 'b']],
    ['AgentKernelX', ['c']],
    ['', ['d']],
  ]);
  assert.deepEqual(groupSessions(sessions, workspaces, 'server projectmaster').map((group) => group.sessions.map((s) => s.sessionKey)), [['a']]);
  assert.deepEqual(groupSessions(sessions, workspaces, 'agentkernelx').map((group) => group.sessions.map((s) => s.sessionKey)), [['c']]);
});

// FR-MSG-002 AC-2, FR-MSG-011 AC-2 — the log is older pages, the latest page and my outbox, deduped by clientMsgId.
import { mergeRoomMessages } from '../../src/components/Messenger/messengerModel.ts';

test('FR-MSG-002 AC-2: pages and the outbox merge once per clientMsgId, sequenced copy first', () => {
  const a = msg(1, 'human');
  const b = msg(2, 'human');
  const pending = { ...msg(null, 'human'), clientMsgId: 'out-1' };
  const sequencedPending = { ...msg(3, 'human'), clientMsgId: 'out-1' };
  assert.deepEqual(mergeRoomMessages([a], [a, b, sequencedPending], [pending]).map((m) => [m.clientMsgId, m.seq]), [
    [a.clientMsgId, 1], [b.clientMsgId, 2], ['out-1', 3],
  ]);
  assert.deepEqual(mergeRoomMessages([], [a], [pending]).map((m) => m.seq), [1, null]);
});

// Security decision: room messages are pasted only into sessions with a detected AI agent.
import { sessionAgentNote, sessionHasAgent } from '../../src/components/Messenger/messengerModel.ts';

test('no-agent: receipts whose every target was skipped say so; partly skipped counts only the pasteable', () => {
  const ctx = { hostOnline: true, hostNode: 'h' };
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 2, delivered: 2, pasted: 0, skipped: 2 } }), ctx), { tone: 'wait', key: 'messenger.delivery.noAgent' });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 2, delivered: 2, pasted: 1, skipped: 1 } }), ctx), { tone: 'ok', key: 'messenger.delivery.pasted', params: { pasted: 1, total: 1 } });
  assert.deepEqual(deliveryLabel(msg(3, 'human', { receipts: { targets: 3, delivered: 3, pasted: 0, skipped: 1 } }), ctx), { tone: 'neutral', key: 'messenger.delivery.delivered' });
});

test('no-agent: a room session with agent null is marked; a session with an agent or an older server is not', () => {
  const base = { id: 'n::k', node: 'n', sessionKey: 'k', name: 'x', enter: true, pasteAll: false };
  assert.equal(sessionAgentNote({ ...base, agent: null }), 'messenger.members.noAgent');
  assert.equal(sessionAgentNote({ ...base, agent: { kind: 'claude', status: 'busy' } }), null);
  assert.equal(sessionAgentNote(base), null);
});

test('no-agent: a picker session has an agent when its kind is known', () => {
  assert.equal(sessionHasAgent({ agentKind: 'codex' }), true);
  assert.equal(sessionHasAgent({ agentKind: 'unknown' }), false);
  assert.equal(sessionHasAgent({}), false);
});

// H-4: mention counts are numbers; a boolean true from an older server counts as one.
test('H-4: room and header badges read a numeric mention, and true as 1', () => {
  assert.deepEqual(roomBadge(summary({ unread: 2, mention: 3 })), { tone: 'mention', text: '@3' });
  assert.deepEqual(roomBadge(summary({ unread: 2, mention: true })), { tone: 'mention', text: '@1' });
  assert.deepEqual(roomBadge(summary({ unread: 2, mention: false })), { tone: 'unread', text: '2' });
  assert.deepEqual(headerBadge({ total: 2, mention: true }, 0), { count: 2, tone: 'danger' });
  assert.deepEqual(headerBadge({ total: 2, mention: false }, 0), { count: 2, tone: 'accent' });
});

// Contact.lastSeen: 「PC 꺼짐 · n시간 전」 only for a disconnected contact with a lastSeen.
import { contactStatus, relativeTimeParts, skipReasonHints } from '../../src/components/Messenger/messengerModel.ts';

test('lastSeen: relative time picks minutes, hours or days', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  assert.deepEqual(relativeTimeParts('2026-11-07T11:50:00Z', now), { value: -10, unit: 'minute' });
  assert.deepEqual(relativeTimeParts('2026-11-07T09:00:00Z', now), { value: -3, unit: 'hour' });
  assert.deepEqual(relativeTimeParts('2026-11-05T12:00:00Z', now), { value: -2, unit: 'day' });
  assert.equal(relativeTimeParts('nope', now), null);
});

test('lastSeen: shown only when disconnected; errors and other states win', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  assert.deepEqual(contactStatus({ name: 'k', state: 'disconnected', lastSeen: '2026-11-07T09:00:00Z' }, now), { key: 'messenger.contact.offlineSince', ago: { value: -3, unit: 'hour' } });
  assert.deepEqual(contactStatus({ name: 'k', state: 'disconnected' }, now), { key: 'messenger.contact.offline' });
  assert.deepEqual(contactStatus({ name: 'k', state: 'connected', lastSeen: '2026-11-07T09:00:00Z' }, now), { key: 'messenger.contact.connected' });
  assert.deepEqual(contactStatus({ name: 'k', state: 'requested' }, now), { key: 'messenger.contact.requested' });
  assert.deepEqual(contactStatus({ name: 'k', state: 'pending-in' }, now), { key: 'messenger.contact.pendingIn' });
  assert.deepEqual(contactStatus({ name: 'k', state: 'disconnected', error: 'TLS_FINGERPRINT_CHANGED', lastSeen: '2026-11-07T09:00:00Z' }, now), { key: 'messenger.contact.fingerprintChanged' });
  assert.deepEqual(contactStatus({ name: 'k', state: 'connected', error: 'LINK_SAVE_FAILED' }, now), { key: 'messenger.error.LINK_SAVE_FAILED' });
});

test('receipts: skippedReasons become small hints, one per reason with a count', () => {
  assert.deepEqual(skipReasonHints({ targets: 3, delivered: 3, pasted: 1, skipped: 2, skippedReasons: { NO_AGENT: 1, PASTE_FAILED: 1 } }), [
    { key: 'messenger.delivery.skippedNoAgent', count: 1 },
    { key: 'messenger.delivery.skippedFailed', count: 1 },
  ]);
  assert.deepEqual(skipReasonHints({ targets: 1, delivered: 1, pasted: 1, skippedReasons: { NO_AGENT: 0 } }), []);
  assert.deepEqual(skipReasonHints(undefined), []);
});

// Room names: the server refuses control characters, ']' and '|' (NAME_INVALID_CHAR); 1..60 chars.
import { inviteOutcome, validateRoomName } from '../../src/components/Messenger/messengerModel.ts';

test('room name: 1..60 characters without control characters, ] or |', () => {
  assert.equal(validateRoomName('로그인 API 변경'), null);
  assert.equal(validateRoomName('  '), 'messenger.form.nameRequired');
  assert.equal(validateRoomName('a'.repeat(61)), 'messenger.form.nameRequired');
  assert.equal(validateRoomName('a]b'), 'messenger.form.nameInvalidChar');
  assert.equal(validateRoomName('a|b'), 'messenger.form.nameInvalidChar');
  assert.equal(validateRoomName('a\u0007b'), 'messenger.form.nameInvalidChar');
  assert.equal(validateRoomName('a\nb'), 'messenger.form.nameInvalidChar');
});

test('invite: waiting-host is not a success; anything else is', () => {
  assert.equal(inviteOutcome({ ok: true, status: 'waiting-host' }), 'waiting-host');
  assert.equal(inviteOutcome({ ok: true }), 'sent');
});

// D7: the headline names the real reason; hints add the counts.
test('D7: all skipped for no agent says no agent; any other failure says not pasted', () => {
  const ctx = { hostOnline: true, hostNode: 'h' };
  const label = (receipts: Parameters<typeof skipReasonHints>[0]) => deliveryLabel(msg(3, 'human', { receipts }), ctx);
  assert.deepEqual(label({ targets: 1, delivered: 1, pasted: 0, skipped: 1, skippedReasons: { NO_AGENT: 1 } }), { tone: 'wait', key: 'messenger.delivery.noAgent' });
  assert.deepEqual(label({ targets: 1, delivered: 1, pasted: 0, skipped: 1, skippedReasons: { PASTE_FAILED: 1 } }), { tone: 'wait', key: 'messenger.delivery.notPasted' });
  assert.deepEqual(label({ targets: 2, delivered: 2, pasted: 0, skipped: 2, skippedReasons: { NO_AGENT: 1, MULTILINE_UNSUPPORTED: 1 } }), { tone: 'wait', key: 'messenger.delivery.notPasted' });
  // Only one pasteable session, and it failed: still "not pasted", not "delivered".
  assert.deepEqual(label({ targets: 2, delivered: 2, pasted: 0, skipped: 1, skippedReasons: { PASTE_FAILED: 1 } }), { tone: 'wait', key: 'messenger.delivery.notPasted' });
  // A failure beside a paste keeps the paste count headline.
  assert.deepEqual(label({ targets: 3, delivered: 3, pasted: 1, skipped: 2, skippedReasons: { NO_AGENT: 1, PASTE_FAILED: 1 } }), { tone: 'ok', key: 'messenger.delivery.pasted', params: { pasted: 1, total: 1 } });
});

test('D7: a multi-line refusal has its own hint', () => {
  assert.deepEqual(skipReasonHints({ targets: 2, delivered: 2, pasted: 0, skipped: 2, skippedReasons: { MULTILINE_UNSUPPORTED: 1, PASTE_FAILED: 1 } }), [
    { key: 'messenger.delivery.skippedFailed', count: 1 },
    { key: 'messenger.delivery.skippedMultiline', count: 1 },
  ]);
});

// Low batch: run count, local paste of an outbox message, per-session Enter, move suggestion.
import { agentRunLabel, localReceiptLabel, moveSuggestion, sessionSelections } from '../../src/components/Messenger/messengerModel.ts';

test('FR-MSG-005 AC-2: an agent message shows 연속 n/limit; others and messages without a count show nothing', () => {
  assert.deepEqual(agentRunLabel(msg(5, 'agent', { agentRun: 19 }), 20), { key: 'messenger.delivery.agentRun', params: { n: 19, limit: 20 } });
  assert.equal(agentRunLabel(msg(5, 'human', { agentRun: 0 }), 20), null);
  assert.equal(agentRunLabel(msg(5, 'agent'), 20), null);
});

test('FR-MSG-011 AC-1: an unsequenced message already pasted on this PC says so', () => {
  assert.deepEqual(localReceiptLabel(msg(null, 'agent', { localReceipt: { pasted: 1 } })), { tone: 'ok', key: 'messenger.delivery.pastedHere' });
  assert.equal(localReceiptLabel(msg(null, 'agent', { localReceipt: { pasted: 0, skipped: 1 } })), null);
  assert.equal(localReceiptLabel(msg(null, 'agent')), null);
  assert.equal(localReceiptLabel(msg(4, 'agent', { localReceipt: { pasted: 1 } })), null);
});

test('FR-MSG-001 AC-1: chosen sessions go out with their Enter choice, on unless switched off', () => {
  assert.deepEqual(sessionSelections(new Set(['a', 'b']), new Set(['b', 'z'])), [{ sessionKey: 'a', enter: true }, { sessionKey: 'b', enter: false }]);
  assert.deepEqual(sessionSelections(new Set(), new Set(['b'])), []);
});

test('FR-MSG-012 AC-1: the move suggestion shows on the storage PC only, with the hours it was off', () => {
  const room = { hostNode: 'hong', moveSuggested: true, offlineHours7d: 31 };
  assert.deepEqual(moveSuggestion(room, 'hong'), { hours: 31 });
  assert.equal(moveSuggestion(room, 'kim'), null);
  assert.equal(moveSuggestion({ ...room, moveSuggested: false }, 'hong'), null);
  assert.deepEqual(moveSuggestion({ hostNode: 'hong', moveSuggested: true }, 'hong'), { hours: 0 });
});

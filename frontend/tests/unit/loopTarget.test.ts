import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canAddStepKind,
  canOpenRunTab,
  lastResultReason,
  missingSince,
  hasChoosableSession,
  loopsOnSameTab,
  saveBlocker,
  sessionGroups,
  sessionStatus,
  targetSummary,
  toLoopInput,
} from '../../src/components/Loop/loopTarget.ts';
import { newLoopDraft } from '../../src/components/Loop/loopModel.ts';
import { loopRejectionMessage, RUN_REASON_KEYS } from '../../src/components/Loop/loopMessages.ts';
import type { LoopInput, LoopSessionOption, LoopView } from '../../src/components/Loop/loopTypes.ts';

// FR-LOOP-008 — the existing-session target in the loop editor and list.

const option = (overrides: Partial<LoopSessionOption>): LoopSessionOption => ({
  tabId: 't', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'api-server', cwd: 'C:\\work\\api', shell: 'powershell', alive: true, agent: null,
  ...overrides,
});

test('FR-LOOP-008 AC-1: a new loop starts as a new session', () => {
  const draft = newLoopDraft(new Date(2026, 10, 8, 9, 0));
  assert.deepEqual(draft.target, { kind: 'new', shell: 'auto', cwd: '', keepTabs: 1 });
});

test('FR-LOOP-008 AC-8: options are grouped by workspace in the order given; a shell that ended cannot be chosen', () => {
  const groups = sessionGroups([
    option({ tabId: 'a' }),
    option({ tabId: 'b', tabName: '오래된 셸', alive: false }),
    option({ tabId: 'c', workspaceId: 'w2', workspaceName: 'orbit-api', tabName: '빌드 감시' }),
  ]);
  assert.deepEqual(groups.map((group) => group.name), ['ProjectMaster', 'orbit-api']);
  assert.deepEqual(groups[0].options.map((entry) => [entry.tabId, entry.name, entry.disabled]), [['a', 'api-server', false], ['b', '오래된 셸', true]]);
  assert.deepEqual(groups[1].options.map((entry) => entry.tabId), ['c']);
});

test('FR-LOOP-008 AC-8: two tabs with the same name in a workspace get their folder name added', () => {
  const [group] = sessionGroups([
    option({ tabId: 'a', tabName: '빌드 감시', cwd: 'C:\\work\\orbit-api' }),
    option({ tabId: 'b', tabName: '빌드 감시', cwd: '/home/me/web/' }),
  ]);
  assert.deepEqual(group.options.map((entry) => entry.name), ['빌드 감시 (orbit-api)', '빌드 감시 (web)']);
});

test('FR-LOOP-008 AC-8: the status words follow the agent the server detected', () => {
  assert.deepEqual(sessionStatus(option({ alive: false })), { key: 'loop.session.stopped', tone: 'danger' });
  assert.deepEqual(sessionStatus(option({ agent: null })), { key: 'loop.session.noAgent', tone: 'neutral' });
  for (const status of ['busy', 'starting', 'running']) {
    assert.deepEqual(sessionStatus(option({ agent: { kind: 'claude', status } })), { key: 'loop.session.agentWorking', params: { agent: 'Claude' }, tone: 'accent' });
  }
  assert.deepEqual(sessionStatus(option({ agent: { kind: 'codex', status: 'waiting_input' } })), { key: 'loop.session.agentWaiting', params: { agent: 'Codex' }, tone: 'ok' });
});

test('FR-LOOP-008 AC-8: the session-end step cannot be added to an existing-session loop', () => {
  assert.equal(canAddStepKind('end', 'session'), false);
  assert.equal(canAddStepKind('prompt', 'session'), true);
  assert.equal(canAddStepKind('end', 'new'), true);
});

test('FR-LOOP-008 AC-8: saving is blocked by a leftover session end, no chosen session, or no session at all', () => {
  const sessionDraft = (steps: LoopInput['steps'], tabId = 'a'): LoopInput => ({
    ...newLoopDraft(new Date()), steps, target: { kind: 'session', tabId, label: { workspaceName: '', tabName: '' }, skipWhenBusy: true },
  });
  const sessions = [option({ tabId: 'a' })];
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: 'x' }, { kind: 'end' }]), sessions), 'endNotAllowed');
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: 'x' }], ''), sessions), 'noSession');
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: 'x' }], ''), []), 'noSessions');
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: 'x' }], ''), [option({ alive: false })]), 'noSessions', 'only ended shells is the empty state');
  assert.equal(hasChoosableSession([option({ alive: false })]), false);
  assert.equal(hasChoosableSession([option({ alive: false }), option({ tabId: 'b' })]), true);
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: 'x' }]), sessions), null);
  assert.equal(saveBlocker({ ...newLoopDraft(new Date()), steps: [{ kind: 'end' }] }, []), null, 'a new-session loop is not blocked');
  // An empty command or prompt is caught before the server's 400, for either target.
  assert.equal(saveBlocker({ ...newLoopDraft(new Date()), steps: [{ kind: 'command', text: '  ' }] }, []), 'emptyText');
  assert.equal(saveBlocker(sessionDraft([{ kind: 'prompt', text: '' }]), sessions), 'emptyText');
});

const view = (id: string, target: LoopView['target'], overrides: Partial<LoopView> = {}): LoopView => ({
  ...newLoopDraft(new Date()), id, name: id, target, steps: [{ kind: 'prompt', text: 'x' }], nextRunAt: null, lastRun: null, targetMissing: false, ...overrides,
});
const onTab = (tabId: string) => ({ kind: 'session' as const, tabId, label: { workspaceName: 'ProjectMaster', tabName: 'api-server' }, skipWhenBusy: true });

test('FR-LOOP-008 AC-8 (Q3): other loops on the same tab are counted, not this one', () => {
  const loops = [view('a', onTab('t1')), view('b', onTab('t1')), view('c', onTab('t2')), view('d', { kind: 'new', shell: 'bash', cwd: '/w', keepTabs: 1 })];
  assert.equal(loopsOnSameTab(loops, 't1', 'a'), 1);
  assert.equal(loopsOnSameTab(loops, 't1', null), 2);
  assert.equal(loopsOnSameTab(loops, 't3', null), 0);
});

test('FR-LOOP-008 AC-9: the list names the target; a missing tab is marked', () => {
  assert.deepEqual(targetSummary(view('a', onTab('t1'))), { kind: 'session', text: 'ProjectMaster : api-server', missing: false });
  assert.deepEqual(targetSummary(view('a', onTab('t1'), { targetMissing: true })), { kind: 'session', text: 'ProjectMaster : api-server', missing: true });
  assert.deepEqual(targetSummary(view('n', { kind: 'new', shell: 'pwsh' as never, cwd: 'C:\\work\\market', keepTabs: 1 })), { kind: 'new', text: 'pwsh · C:\\work\\market', missing: false });
});

test('FR-LOOP-008 AC-1: the editor sends only the definition, the visible target included', () => {
  const input = toLoopInput(view('a', onTab('t1'), { targetMissing: true }));
  assert.deepEqual(Object.keys(input).sort(), ['enabled', 'name', 'schedule', 'steps', 'target']);
});

test('FR-LOOP-008: every new reason has words on screen', () => {
  for (const reason of ['target', 'session', 'sessionMissing', 'endNotAllowed']) assert.ok(loopRejectionMessage(reason), reason);
  for (const reason of ['sessionMissing', 'sessionStopped', 'agentBusy'] as const) assert.ok(RUN_REASON_KEYS[reason], reason);
});

test('FR-LOOP-008 AC-9: 「탭 열기」 shows for any run whose tab is still open, new-session runs included', () => {
  const run = { tabId: 'sched-3', tabOpen: true };
  assert.equal(canOpenRunTab(run), true);
  assert.equal(canOpenRunTab({ ...run, tabOpen: false }), false, 'hidden once the tab is gone');
  assert.equal(canOpenRunTab({ tabId: null, tabOpen: false }), false);
});

const run = (overrides: Record<string, unknown>) => ({
  id: 'r', trigger: 'schedule', startedAt: '2026-11-07T08:00:00.000Z', finishedAt: null, result: 'skipped', stepsSent: 0, totalSteps: 1,
  workspaceId: null, workspaceName: null, tabId: null, tabName: null, reason: null, detail: null, ...overrides,
}) as LoopView['lastRun'] & object;

test('FR-LOOP-008 AC-9: the last result names why a run was skipped', () => {
  assert.equal(lastResultReason(run({ reason: 'agentBusy' })), 'loop.reasonShort.agentBusy');
  assert.equal(lastResultReason(run({ reason: 'sessionMissing' })), 'loop.reasonShort.sessionMissing');
  assert.equal(lastResultReason(run({ reason: 'sessionStopped' })), 'loop.reasonShort.sessionStopped');
  assert.equal(lastResultReason(run({ reason: 'previousRunning' })), 'loop.reasonShort.previousRunning');
  assert.equal(lastResultReason(run({ result: 'success' })), null);
  assert.equal(lastResultReason(null), null);
});

test('FR-LOOP-008 AC-8: the missing-session banner says when the loop was turned off', () => {
  assert.equal(missingSince(run({ reason: 'sessionMissing' })), '2026-11-07T08:00:00.000Z');
  assert.equal(missingSince(run({ reason: 'agentBusy' })), null);
  assert.equal(missingSince(null), null);
});

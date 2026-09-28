import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_LABELS,
  defaultRestoreSelection,
  formatSavedAt,
  groupByWorkspace,
  pendingEntries,
  resumeCommandPreview,
  saveButtonState,
  summarizeSaveResults,
  type SnapshotEntry,
  type SnapshotStatus,
} from '../../src/components/SessionSave/sessionSnapshotModel.ts';

// FR-AITUI-009 — the rules the save and resume screens apply.

function entry(over: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    tabId: 't', workspaceId: 'w1', workspaceName: 'og', tabName: 'api', cwd: '/work', agent: 'claude',
    sessionId: '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19', method: 'claude-pid-file', confidence: 'exact',
    resumeCommand: 'claude', resumeArguments: ['--resume', '7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19'], restore: 'pending',
    ...over,
  };
}

test('agent labels are the proper nouns', () => {
  assert.deepEqual(AGENT_LABELS, { claude: 'Claude', codex: 'Codex', hermes: 'Hermes', opencode: 'OpenCode' });
});

test('items group by workspace in first-seen order', () => {
  const groups = groupByWorkspace([
    { workspaceId: 'w2', workspaceName: 'B', tabId: '1' },
    { workspaceId: 'w1', workspaceName: 'A', tabId: '2' },
    { workspaceId: 'w2', workspaceName: 'B', tabId: '3' },
  ]);
  assert.deepEqual(groups.map((g) => [g.workspaceName, g.items.map((i) => i.tabId)]), [['B', ['1', '3']], ['A', ['2']]]);
});

test('AC-4: only exact pending entries are checked by default', () => {
  const entries = [
    entry({ tabId: 'a' }),
    entry({ tabId: 'b', confidence: 'estimated' }),
    entry({ tabId: 'c', restore: 'restored' }),
  ];
  const status: SnapshotStatus = { snapshot: { version: 1, savedAt: '2026-09-26T04:40:00.000Z', entries }, pendingCount: 2, restorable: true };
  assert.deepEqual(pendingEntries(status).map((e) => e.tabId), ['a', 'b']);
  assert.deepEqual([...defaultRestoreSelection(pendingEntries(status))], ['a']);
});

test('AC-2: save results summarise as exact, estimated and not found', () => {
  assert.deepEqual(summarizeSaveResults([
    { tabId: '1', tabName: 'a', workspaceName: 'w', agent: 'claude', status: 'found', confidence: 'exact' },
    { tabId: '2', tabName: 'b', workspaceName: 'w', agent: 'hermes', status: 'found', confidence: 'estimated' },
    { tabId: '3', tabName: 'c', workspaceName: 'w', agent: 'codex', status: 'not-found' },
  ]), { exact: 1, estimated: 1, notFound: 1 });
});

test('AC-4: the command preview is what the shell will receive, quoting spaced arguments', () => {
  assert.equal(resumeCommandPreview(entry({})), 'claude --resume 7c1e0b52-4a0e-4f7b-9d61-2b8e5f0c3a19');
  assert.equal(resumeCommandPreview(entry({ resumeArguments: ['--resume', 'my session'] })), 'claude --resume "my session"');
});

test('saved time reads as today or as a date', () => {
  const now = new Date(2026, 8, 26, 15, 0, 0);
  assert.equal(formatSavedAt(new Date(2026, 8, 26, 13, 40, 0).toISOString(), now), '오늘 13:40');
  assert.equal(formatSavedAt(new Date(2026, 8, 25, 9, 5, 0).toISOString(), now), '9월 25일 09:05');
  assert.equal(formatSavedAt('not a date', now), '');
});

test('AC-1: the header button is save, saved or resume', () => {
  const now = new Date(2026, 8, 26, 15, 0, 0);
  assert.deepEqual(saveButtonState({ candidateCount: 6, status: null, now }), { kind: 'save', badge: 6, disabled: false });
  assert.deepEqual(saveButtonState({ candidateCount: 0, status: null, now }), { kind: 'save', badge: 0, disabled: true });
  const saved: SnapshotStatus = { snapshot: { version: 1, savedAt: new Date(2026, 8, 26, 13, 40).toISOString(), entries: [entry({})] }, pendingCount: 1, restorable: false };
  assert.deepEqual(saveButtonState({ candidateCount: 6, status: saved, now }), { kind: 'saved', label: '저장됨 · 13:40', badge: 6 });
  const pending: SnapshotStatus = { ...saved, restorable: true };
  assert.deepEqual(saveButtonState({ candidateCount: 0, status: pending, now }), { kind: 'pending', count: 1 });
});

test('FR-AITUI-015 AC-5: the save button is usable whenever there is a terminal, agent or not', () => {
  const now = new Date(2026, 8, 28, 15, 0, 0);
  assert.deepEqual(saveButtonState({ candidateCount: 0, tabCount: 3, status: null, now }), { kind: 'save', badge: 0, disabled: false });
  assert.deepEqual(saveButtonState({ candidateCount: 0, tabCount: 0, status: null, now }), { kind: 'save', badge: 0, disabled: true });
});

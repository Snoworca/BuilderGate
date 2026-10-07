import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentCountsText,
  claimsRestoreNotice,
  dayLabelOf,
  groupManualByDay,
  restoreItems,
  type PlannedEntry,
  type SnapshotSummary,
} from '../../src/components/SessionSave/sessionRestoreModel.ts';

// FR-AITUI-018 AC-3..AC-5 — the rules the restore tab and the restore notice apply.

function summary(over: Partial<SnapshotSummary>): SnapshotSummary {
  return { id: 'm1', origin: 'manual', savedAt: '2026-10-08T05:02:00.000Z', tabCount: 5, agentCounts: {}, usedForRestore: false, ...over };
}

function entry(over: Partial<PlannedEntry>): PlannedEntry {
  return {
    tabId: 't1', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'build', cwd: '/work',
    mode: 'agent', agent: 'claude', sessionId: 'id', method: 'user', confidence: 'exact',
    resumeCommand: 'claude', resumeArguments: ['--resume', 'id'], restore: 'pending',
    target: 'tab', targetReason: 'idle',
    ...over,
  };
}

test('FR-AITUI-018 AC-4: the agent counts read "Claude 2 · Codex 1", and nothing when there are none', () => {
  assert.equal(agentCountsText({ codex: 1, claude: 2 }), 'Claude 2 · Codex 1');
  assert.equal(agentCountsText({}), '');
});

test('FR-AITUI-018 AC-4: manual saves are grouped by day, newest first, today and yesterday named', () => {
  const now = new Date(2026, 9, 8, 15, 0);
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
  const groups = groupManualByDay([
    summary({ id: 'a', savedAt: at(8, 14) }),
    summary({ id: 'b', savedAt: at(8, 10) }),
    summary({ id: 'c', savedAt: at(7, 18) }),
    summary({ id: 'd', savedAt: at(5, 21) }),
  ], now);
  assert.deepEqual(groups.map((g) => g.items.map((i) => i.id)), [['a', 'b'], ['c'], ['d']]);
  assert.equal(groups[0].label, `오늘 · ${dayLabelOf(new Date(2026, 9, 8))}`);
  assert.equal(groups[1].label, `어제 · ${dayLabelOf(new Date(2026, 9, 7))}`);
  assert.equal(groups[2].label, dayLabelOf(new Date(2026, 9, 5)));
  assert.match(dayLabelOf(new Date(2026, 9, 8)), /10월 8일/, 'dates follow the active UI language (FR-I18N-008)');
});

test('FR-AITUI-018 AC-5: the restore request carries the picked entries, and a running command only when ticked', () => {
  const entries = [
    entry({ tabId: 't1' }),
    entry({ tabId: 't2', mode: 'shell', agent: null, runningCommand: 'npm run dev' }),
    entry({ tabId: 't3', mode: 'shell', agent: null }),
  ];
  assert.deepEqual(restoreItems(entries, new Set(), new Set()), [
    { tabId: 't1', includeCommand: false }, { tabId: 't2', includeCommand: false }, { tabId: 't3', includeCommand: false },
  ], 'every entry by default, no command');
  assert.deepEqual(restoreItems(entries, new Set(['t3']), new Set(['t2'])), [
    { tabId: 't1', includeCommand: false }, { tabId: 't2', includeCommand: true },
  ]);
  assert.deepEqual(restoreItems(entries, new Set(), new Set(['t3'])).find((i) => i.tabId === 't3'), { tabId: 't3', includeCommand: false }, 'no command to type, nothing to include');
});

test('FR-AITUI-018 AC-3: a client claims the restore notice only when the server has not shown it yet', () => {
  const report = [{ tabId: 't1' }];
  assert.equal(claimsRestoreNotice({ report, reportId: 'r1', reportNoticeShown: false }, null), true);
  assert.equal(claimsRestoreNotice({ report, reportId: 'r1', reportNoticeShown: true }, null), false, 'shown once, by any client, before this reload');
  assert.equal(claimsRestoreNotice({ report, reportId: 'r1', reportNoticeShown: false }, 'r1'), false, 'this client already claimed it');
  assert.equal(claimsRestoreNotice({ report: [], reportId: 'r1', reportNoticeShown: false }, null), false, 'nothing restored');
  assert.equal(claimsRestoreNotice({ report, reportId: null, reportNoticeShown: false }, null), false);
  assert.equal(claimsRestoreNotice(null, null), false);
});

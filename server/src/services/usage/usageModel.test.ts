import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideAlerts,
  levelFor,
  mergeReadings,
  toUsageView,
  type UsageReading,
} from './usageModel.js';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');

const reading = (overrides: Partial<UsageReading> = {}): UsageReading => ({
  agent: 'codex',
  accountKey: 'acct-a',
  email: null,
  plan: 'pro',
  source: 'windows',
  observedAt: NOW - 60_000,
  windows: { weekly: { usedPercent: 80, resetsAt: NOW + 3_600_000 } },
  ...overrides,
});

test('FR-USAGE-004 AC-3: the level follows the remaining capacity', () => {
  assert.equal(levelFor(0), 'plenty');
  assert.equal(levelFor(60), 'plenty'); // 40 left
  assert.equal(levelFor(61), 'low'); // 39 left
  assert.equal(levelFor(85), 'low'); // 15 left
  assert.equal(levelFor(86), 'critical'); // 14 left
});

test('FR-USAGE-004 AC-1: readings of one account from Windows and WSL merge into the newest', () => {
  const merged = mergeReadings([
    reading({ source: 'windows', observedAt: NOW - 120_000, windows: { weekly: { usedPercent: 10, resetsAt: NOW + 1 } } }),
    reading({ source: 'wsl', observedAt: NOW - 30_000, windows: { weekly: { usedPercent: 20, resetsAt: NOW + 1 } } }),
    reading({ accountKey: 'acct-b', observedAt: NOW - 30_000 }),
  ]);
  assert.equal(merged.length, 2);
  const a = merged.find((r) => r.accountKey === 'acct-a')!;
  assert.equal(a.windows.weekly?.usedPercent, 20);
  assert.equal(a.source, 'wsl');
});

test('FR-USAGE-004 AC-2/AC-5: a passed reset reads 0 and reset; an old reading is stale', () => {
  const view = toUsageView([
    reading({ observedAt: NOW - 2 * 3_600_000, windows: { weekly: { usedPercent: 90, resetsAt: NOW - 1000 } } }),
  ], { nicknames: {}, hidden: [] }, NOW);
  const account = view.agents[0].accounts[0];
  assert.equal(account.stale, true);
  assert.deepEqual(
    { used: account.windows[0].usedPercent, reset: account.windows[0].reset, level: account.windows[0].level },
    { used: 0, reset: true, level: 'plenty' },
  );
});

test('FR-USAGE-004 AC-4: the label is the nickname, else plan and email, else a short hash; hidden accounts are left out', () => {
  const view = toUsageView([
    // Different accounts have their own windows: resets apart would otherwise be one quota (see below).
    reading({ accountKey: 'k1', email: 'beom@hancomins.com', plan: 'pro', windows: { weekly: { usedPercent: 11, resetsAt: NOW + 100_000 } } }),
    reading({ accountKey: 'k2', email: null, plan: null, windows: { weekly: { usedPercent: 22, resetsAt: NOW + 200_000 } } }),
    reading({ accountKey: 'k3', windows: { weekly: { usedPercent: 33, resetsAt: NOW + 300_000 } } }),
  ], { nicknames: { k3: '회사 팀' }, hidden: ['k2'] }, NOW);
  const labels = view.agents[0].accounts.map((a) => a.label);
  // User decision 2026-10-31: the whole address, so the account can be told at a glance.
  assert.deepEqual(labels.sort(), ['Pro · beom@hancomins.com', '회사 팀'].sort());
  const hashOnly = toUsageView([reading({ accountKey: 'abcdef1234567890', plan: null })], { nicknames: {}, hidden: [] }, NOW);
  assert.equal(hashOnly.agents[0].accounts[0].label, '#abcdef12');
});

test('FR-USAGE-004: an account with no known window and an unknown account are reported as such', () => {
  const view = toUsageView([
    reading({ accountKey: null, windows: { weekly: { usedPercent: 5, resetsAt: NOW + 1 } } }),
    reading({ accountKey: 'k-empty', windows: {} }),
  ], { nicknames: {}, hidden: [] }, NOW);
  assert.equal(view.agents[0].accounts.length, 1, 'an account without a window is not shown');
  assert.equal(view.agents[0].accounts[0].unknownAccount, true);
});

const settings = { thresholdPercent: 20, agents: ['claude', 'codex'] as const, windows: ['fiveHour', 'weekly'] as const, hidden: [] as string[] };

test('FR-USAGE-006 AC-1/AC-2: below the threshold every update alerts, unless the value equals the previous update', () => {
  const first = decideAlerts([reading({ windows: { weekly: { usedPercent: 85, resetsAt: NOW + 1 } } })], {}, settings, NOW);
  assert.equal(first.alerts.length, 1, '15 % left is below 20 %');
  assert.equal(first.alerts[0].remainingPercent, 15);
  const same = decideAlerts([reading({ windows: { weekly: { usedPercent: 85, resetsAt: NOW + 1 } } })], first.lastUsed, settings, NOW);
  assert.equal(same.alerts.length, 0, 'the same value as the last update sends nothing');
  const moved = decideAlerts([reading({ windows: { weekly: { usedPercent: 86, resetsAt: NOW + 1 } } })], same.lastUsed, settings, NOW);
  assert.equal(moved.alerts.length, 1, 'a new value below the threshold sends again');
});

test('FR-USAGE-006 AC-2: at or above the threshold nothing is sent, and the value is still remembered', () => {
  const ok = decideAlerts([reading({ windows: { weekly: { usedPercent: 80, resetsAt: NOW + 1 } } })], {}, settings, NOW);
  assert.equal(ok.alerts.length, 0, '20 % left is not below 20 %');
  assert.equal(Object.values(ok.lastUsed).length, 1);
});

test('FR-USAGE-006 AC-1: only the chosen agents and windows alert', () => {
  const r = reading({ windows: { weekly: { usedPercent: 99, resetsAt: NOW + 1 }, fiveHour: { usedPercent: 99, resetsAt: NOW + 1 } } });
  assert.equal(decideAlerts([r], {}, { ...settings, windows: ['fiveHour'] }, NOW).alerts.length, 1);
  assert.equal(decideAlerts([r], {}, { ...settings, agents: ['claude'] }, NOW).alerts.length, 0);
});

test('FR-USAGE-006: a window whose reset has passed counts as empty and does not alert', () => {
  const passed = decideAlerts([reading({ windows: { weekly: { usedPercent: 99, resetsAt: NOW - 1 } } })], {}, settings, NOW);
  assert.equal(passed.alerts.length, 0);
});

test('FR-USAGE-004 AC-1: two account keys reporting the same quota (same use, resets within 5 s) show as one bar', () => {
  const merged = mergeReadings([
    reading({ accountKey: 'zz-later', observedAt: NOW - 1000, windows: { weekly: { usedPercent: 44, resetsAt: NOW + 86_400_000 } } }),
    reading({ accountKey: 'aa-first', observedAt: NOW - 5000, windows: { weekly: { usedPercent: 44, resetsAt: NOW + 86_400_000 + 3000 } } }),
    reading({ accountKey: 'other', observedAt: NOW - 1000, windows: { weekly: { usedPercent: 44, resetsAt: NOW + 2 * 86_400_000 } } }),
  ]);
  assert.equal(merged.length, 2, 'a different reset time is a different quota');
  const one = merged.find((r) => r.accountKey === 'aa-first')!;
  assert.ok(one, 'the smallest key is kept, so a nickname does not flip between the two');
  assert.equal(one.observedAt, NOW - 1000, 'with the newest time');
});

test('FR-USAGE-006: a hidden account does not alert, but its value is still remembered', () => {
  const r = reading({ accountKey: 'hide-me', windows: { weekly: { usedPercent: 99, resetsAt: NOW + 1 } } });
  const decision = decideAlerts([r], {}, { ...settings, hidden: ['hide-me'] }, NOW);
  assert.equal(decision.alerts.length, 0);
  assert.equal(Object.keys(decision.lastUsed).length, 1);
});

test('FR-USAGE-004 AC-1: two keys on one quota merge even when read a moment apart at slightly different use', () => {
  const merged = mergeReadings([
    reading({ accountKey: 'k-b', observedAt: NOW - 1000, windows: { weekly: { usedPercent: 51, resetsAt: NOW + 86_400_000 } } }),
    reading({ accountKey: 'k-a', observedAt: NOW - 9000, windows: { weekly: { usedPercent: 50, resetsAt: NOW + 86_400_000 + 2000 } } }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].accountKey, 'k-a', 'the smallest key stays');
  assert.equal(merged[0].windows.weekly?.usedPercent, 51, 'with the newest values');
  assert.equal(merged[0].observedAt, NOW - 1000);
});

test('FR-USAGE-004: an unknown-account record whose every window has reset shows nothing', () => {
  const view = toUsageView([
    reading({ accountKey: null, observedAt: NOW - 8 * 86_400_000, windows: { weekly: { usedPercent: 100, resetsAt: NOW - 1000 } } }),
    reading({ accountKey: 'known', observedAt: NOW - 8 * 86_400_000, windows: { weekly: { usedPercent: 100, resetsAt: NOW - 1000 } } }),
  ], { nicknames: {}, hidden: [] }, NOW);
  assert.deepEqual(view.agents[0].accounts.map((a) => a.accountKey), ['known'], 'a known account still shows its reset');
});

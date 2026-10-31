import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCodexUsageReader, parseCodexRateLimits } from './codexUsageReader.js';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');

const meta = (accountId?: string) => JSON.stringify({
  timestamp: '2026-10-31T08:00:00.000Z',
  type: 'session_meta',
  payload: { ...(accountId ? { creator_account_id: accountId } : {}), cwd: '/w', base_instructions: { text: 'x'.repeat(5000) } },
});
const tokenCount = (at: string, primary: object | null, secondary: object | null = null, plan = 'pro') => JSON.stringify({
  timestamp: at,
  type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary, secondary, plan_type: plan } },
});

test('FR-USAGE-001 AC-2: windows are told apart by window_minutes, not by primary/secondary', () => {
  const parsed = parseCodexRateLimits(JSON.parse(tokenCount('2026-10-31T08:30:00.000Z',
    { used_percent: 94, window_minutes: 10080, resets_at: 1793776651 },
    { used_percent: 12, window_minutes: 300, resets_at: 1793700000 })));
  assert.deepEqual(parsed?.windows, {
    weekly: { usedPercent: 94, resetsAt: 1793776651000 },
    fiveHour: { usedPercent: 12, resetsAt: 1793700000000 },
  });
  assert.equal(parsed?.plan, 'pro');
  const other = parseCodexRateLimits(JSON.parse(tokenCount('2026-10-31T08:30:00.000Z', { used_percent: 5, window_minutes: 60, resets_at: 1 })));
  assert.deepEqual(other?.windows, {}, 'an unknown window length is ignored');
});

test('FR-USAGE-001 AC-2: an older record with resets_in_seconds is read relative to its timestamp', () => {
  const parsed = parseCodexRateLimits(JSON.parse(tokenCount('2026-10-31T08:00:00.000Z', { used_percent: 30, window_minutes: 300, resets_in_seconds: 600 })));
  assert.equal(parsed?.windows.fiveHour?.resetsAt, Date.parse('2026-10-31T08:10:00.000Z'));
});

function home(): { dir: string; write: (name: string, lines: string[], mtime: number) => void; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-codex-usage-'));
  const day = path.join(dir, 'sessions', '2026', '10', '31');
  mkdirSync(day, { recursive: true });
  return {
    dir,
    write(name, lines, mtime) {
      const file = path.join(day, name);
      writeFileSync(file, `${lines.join('\n')}\n`);
      utimesSync(file, mtime / 1000, mtime / 1000);
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('FR-USAGE-001 AC-1/AC-3/AC-4: the newest rollout per account gives its last limits; no account is unknown', async () => {
  const h = home();
  try {
    h.write('rollout-a-old.jsonl', [meta('acct-1'), tokenCount('2026-10-31T06:00:00.000Z', { used_percent: 10, window_minutes: 10080, resets_at: 1793776651 })], NOW - 3 * 3_600_000);
    h.write('rollout-a-new.jsonl', [
      meta('acct-1'),
      tokenCount('2026-10-31T08:00:00.000Z', { used_percent: 40, window_minutes: 10080, resets_at: 1793776651 }),
      tokenCount('2026-10-31T08:30:00.000Z', { used_percent: 41, window_minutes: 10080, resets_at: 1793776651 }),
      JSON.stringify({ timestamp: '2026-10-31T08:31:00.000Z', type: 'response_item', payload: {} }),
    ], NOW - 3_600_000);
    // A different account: its own weekly window, so a different reset time.
    h.write('rollout-b.jsonl', [meta('acct-2'), tokenCount('2026-10-31T07:00:00.000Z', { used_percent: 70, window_minutes: 10080, resets_at: 1793900000 })], NOW - 2 * 3_600_000);
    h.write('rollout-old-cli.jsonl', [meta(), tokenCount('2026-10-31T05:00:00.000Z', { used_percent: 3, window_minutes: 10080, resets_at: 1793776651 })], NOW - 4 * 3_600_000);
    h.write('rollout-no-limits.jsonl', [meta('acct-3')], NOW - 60_000);
    const reader = createCodexUsageReader({ now: () => NOW });
    const readings = await reader.read([{ codexHome: h.dir, source: 'windows' }]);
    const byUsed = readings.map((r) => [r.accountKey === null ? 'unknown' : 'known', r.windows.weekly?.usedPercent, r.source]).sort();
    assert.deepEqual(byUsed, [['known', 41, 'windows'], ['known', 70, 'windows'], ['unknown', 3, 'windows']]);
    const a = readings.find((r) => r.windows.weekly?.usedPercent === 41)!;
    assert.equal(a.observedAt, Date.parse('2026-10-31T08:30:00.000Z'));
    assert.equal(a.plan, 'pro');
    assert.match(a.accountKey ?? '', /^[0-9a-f]{16}$/u, 'the raw account id is not kept, only its hash');
    assert.notEqual(a.accountKey, 'acct-1');
  } finally {
    h.done();
  }
});

test('FR-USAGE-001: unchanged rollouts are not read again', async () => {
  const h = home();
  try {
    h.write('rollout-a.jsonl', [meta('acct-1'), tokenCount('2026-10-31T08:30:00.000Z', { used_percent: 41, window_minutes: 10080, resets_at: 1793776651 })], NOW - 60_000);
    let reads = 0;
    const reader = createCodexUsageReader({ now: () => NOW, onFileRead: () => { reads += 1; } });
    await reader.read([{ codexHome: h.dir, source: 'windows' }]);
    const afterFirst = reads;
    await reader.read([{ codexHome: h.dir, source: 'windows' }]);
    assert.ok(afterFirst > 0);
    assert.equal(reads, afterFirst);
  } finally {
    h.done();
  }
});

test('FR-USAGE-001: a missing Codex home reads nothing and does not throw', async () => {
  const reader = createCodexUsageReader({ now: () => NOW });
  assert.deepEqual(await reader.read([{ codexHome: path.join(os.tmpdir(), 'no-such-codex-home-xyz'), source: 'wsl' }]), []);
});

test('FR-USAGE-001 AC-2: only the main codex limit is read; another limit_id (premium) is skipped', async () => {
  const h = home();
  try {
    const premium = JSON.stringify({ timestamp: '2026-10-31T08:40:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'premium', primary: { used_percent: 99, window_minutes: 10080, resets_at: 1 }, plan_type: 'pro' } } });
    h.write('rollout-a.jsonl', [meta('acct-1'), tokenCount('2026-10-31T08:30:00.000Z', { used_percent: 41, window_minutes: 10080, resets_at: 1793776651 }), premium], NOW - 60_000);
    const readings = await createCodexUsageReader({ now: () => NOW }).read([{ codexHome: h.dir, source: 'windows' }]);
    assert.equal(readings[0].windows.weekly?.usedPercent, 41);
  } finally {
    h.done();
  }
});

test('FR-USAGE-001: day folders older than the look-back are not walked at all', async () => {
  const h = home();
  try {
    const oldDay = path.join(h.dir, 'sessions', '2026', '09', '01');
    mkdirSync(oldDay, { recursive: true });
    const oldFile = path.join(oldDay, 'rollout-old.jsonl');
    writeFileSync(oldFile, `${meta('acct-9')}\n${tokenCount('2026-10-31T08:00:00.000Z', { used_percent: 9, window_minutes: 10080, resets_at: 1793776651 })}\n`);
    utimesSync(oldFile, NOW / 1000, NOW / 1000); // a recent mtime, so only the folder name can skip it
    const read: string[] = [];
    await createCodexUsageReader({ now: () => NOW, onFileRead: (file) => read.push(file) }).read([{ codexHome: h.dir, source: 'windows' }]);
    assert.equal(read.includes(oldFile), false);
  } finally {
    h.done();
  }
});

test('FR-USAGE-001: a limits line longer than one read block, with Korean text, is read intact', async () => {
  const h = home();
  try {
    const long = JSON.stringify({
      timestamp: '2026-10-31T08:30:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { note: '한글'.repeat(40_000) }, rate_limits: { limit_id: 'codex', primary: { used_percent: 57, window_minutes: 10080, resets_at: 1793776651 }, secondary: null, plan_type: 'pro' } },
    });
    h.write('rollout-long.jsonl', [meta('acct-1'), long], NOW - 60_000);
    const readings = await createCodexUsageReader({ now: () => NOW }).read([{ codexHome: h.dir, source: 'windows' }]);
    assert.equal(readings[0]?.windows.weekly?.usedPercent, 57);
  } finally {
    h.done();
  }
});

test('FR-USAGE-001: a session started 10 days ago that is still being written is read', async () => {
  const h = home();
  try {
    const startedDay = path.join(h.dir, 'sessions', '2026', '10', '21');
    mkdirSync(startedDay, { recursive: true });
    const file = path.join(startedDay, 'rollout-resumed.jsonl');
    writeFileSync(file, `${meta('acct-r')}\n${tokenCount('2026-10-31T08:50:00.000Z', { used_percent: 63, window_minutes: 10080, resets_at: 1793776651 })}\n`);
    utimesSync(file, NOW / 1000, NOW / 1000);
    const readings = await createCodexUsageReader({ now: () => NOW }).read([{ codexHome: h.dir, source: 'windows' }]);
    assert.ok(readings.some((r) => r.windows.weekly?.usedPercent === 63), 'a resumed session keeps writing into the folder of the day it began');
  } finally {
    h.done();
  }
});

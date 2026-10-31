import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UsageLimitsService, UsageSettingsError, type UsageLimitsDeps } from './UsageLimitsService.js';
import type { UsageReading } from './usageModel.js';

const NOW = Date.parse('2026-10-31T09:00:00.000Z');
const WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=K&token=TOKENQk3d';
const BOT = '123456:BOT-SECRET-wxyz';

function harness(readings: () => UsageReading[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-usage-svc-'));
  const sent: Array<{ channel: string; text: string; target: string }> = [];
  const relayCalls: boolean[] = [];
  let failChat = false;
  const deps: UsageLimitsDeps = {
    dataPath: path.join(dir, 'usage-limits.json'),
    now: () => NOW,
    machine: 'DESKTOP-1',
    cipher: { encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`, decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString() },
    readReadings: async () => readings(),
    setClaudeCollection: async (on) => { relayCalls.push(on); return [{ configDir: 'C:/u/.claude', source: 'windows', installed: on, drifted: false }]; },
    claudeCollectionStatus: async () => [],
    sendGoogleChat: async (config, text) => {
      sent.push({ channel: 'gchat', text, target: config.webhookUrl });
      return failChat ? { ok: false, status: 500, error: 'boom' } : { ok: true, status: 200 };
    },
    sendTelegram: async (config, text) => { sent.push({ channel: 'tg', text, target: `${config.botToken}|${config.chatId}` }); return { ok: true, status: 200 }; },
    startTimer: false,
  };
  const service = new UsageLimitsService(deps);
  return { service, sent, relayCalls, dir, failChat: (on: boolean) => { failChat = on; }, done: () => { service.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

const codex = (used: number): UsageReading => ({
  agent: 'codex', accountKey: 'k1', email: null, plan: 'pro', source: 'windows', observedAt: NOW - 1000,
  windows: { weekly: { usedPercent: used, resetsAt: NOW + 2 * 86_400_000 } },
});

test('FR-USAGE-005 AC-1/AC-2: defaults, range checks, and a state that never shows a secret', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    const state = await h.service.getState();
    assert.equal(state.settings.refreshSeconds, 60);
    assert.equal(state.settings.alerts.thresholdPercent, 20);
    await assert.rejects(h.service.updateSettings({ refreshSeconds: 14 }), UsageSettingsError);
    await assert.rejects(h.service.updateSettings({ refreshSeconds: 3601 }), UsageSettingsError);
    await assert.rejects(h.service.updateSettings({ alerts: { thresholdPercent: 0 } }), UsageSettingsError);
    await h.service.updateSettings({ refreshSeconds: 15, alerts: { thresholdPercent: 99, googleChat: { enabled: true, webhookUrl: WEBHOOK }, telegram: { enabled: true, botToken: BOT, chatId: '-100' } } });
    const masked = JSON.stringify(await h.service.getState());
    assert.equal(masked.includes('TOKENQk3d'), false);
    assert.equal(masked.includes('BOT-SECRET'), false);
    const after = await h.service.getState();
    assert.equal(after.settings.alerts.googleChat.webhookUrlHint, '●●●●Qk3d');
    assert.equal(after.settings.alerts.telegram.botTokenHint, '●●●●wxyz');
    assert.equal(after.settings.alerts.telegram.chatId, '-100');
  } finally {
    h.done();
  }
});

test('FR-USAGE-006 AC-4: secrets are stored encrypted; a blank keeps them; clearing removes them', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ alerts: { googleChat: { webhookUrl: WEBHOOK }, telegram: { botToken: BOT } } });
    const raw = readFileSync(path.join(h.dir, 'usage-limits.json'), 'utf8');
    assert.equal(raw.includes('TOKENQk3d'), false);
    assert.equal(raw.includes('BOT-SECRET'), false);
    await h.service.updateSettings({ alerts: { googleChat: { webhookUrl: '' } } });
    assert.equal((await h.service.getState()).settings.alerts.googleChat.webhookUrlSet, true);
    await h.service.updateSettings({ alerts: { clear: ['googleChatWebhook'] } });
    assert.equal((await h.service.getState()).settings.alerts.googleChat.webhookUrlSet, false);
    assert.equal((await h.service.getState()).settings.alerts.telegram.botTokenSet, true);
  } finally {
    h.done();
  }
});

test('FR-USAGE-006 AC-2/AC-3/AC-6: alerts go to enabled channels on each new value below the threshold; a failing channel does not stop the other', async () => {
  let used = 85;
  const h = harness(() => [codex(used)]);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ alerts: { googleChat: { enabled: true, webhookUrl: WEBHOOK }, telegram: { enabled: true, botToken: BOT, chatId: '-100' } } });
    h.failChat(true);
    await h.service.refresh();
    assert.deepEqual(h.sent.map((s) => s.channel), ['gchat', 'tg']);
    assert.match(h.sent[1].text, /Codex\(Pro\) 주간 한도 남은 양 15% \(기준 20%\) · 2일 후 초기화 · DESKTOP-1/u);
    await h.service.refresh();
    assert.equal(h.sent.length, 2, 'the same value as the previous update sends nothing');
    used = 90;
    await h.service.refresh();
    assert.equal(h.sent.length, 4);
    used = 50;
    await h.service.refresh();
    assert.equal(h.sent.length, 4, 'above the threshold nothing is sent');
    const state = await h.service.getState();
    assert.equal(state.view.agents[0].accounts[0].windows[0].usedPercent, 50);
  } finally {
    h.done();
  }
});

test('FR-USAGE-006 AC-5: a test send uses the values given, or the stored ones, and reports the result', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ alerts: { telegram: { botToken: BOT, chatId: '-100' } } });
    const typed = await h.service.testChannel('googleChat', { webhookUrl: WEBHOOK });
    assert.deepEqual(typed, { ok: true, status: 200 });
    assert.equal(h.sent[0].target, WEBHOOK);
    await h.service.testChannel('telegram', {});
    assert.equal(h.sent[1].target, `${BOT}|-100`, 'stored values when nothing is typed');
    await h.service.testChannel('telegram', { chatId: '-200' });
    assert.equal(h.sent[2].target, `${BOT}|-200`, 'a typed field overrides only itself');
    assert.match(h.sent[0].text, /테스트/u);
  } finally {
    h.done();
  }
});

test('FR-USAGE-003: turning Claude collection on and off goes through the installer and is saved', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ claudeCollection: true });
    await h.service.updateSettings({ claudeCollection: false });
    assert.deepEqual(h.relayCalls, [true, false]);
    assert.equal((await h.service.getState()).settings.claudeCollection, false);
  } finally {
    h.done();
  }
});

test('FR-USAGE-004 AC-4: nicknames and hidden accounts shape the view', async () => {
  const h = harness(() => [codex(10)]);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ nicknames: { k1: '개인' } });
    await h.service.refresh();
    assert.equal((await h.service.getState()).view.agents[0].accounts[0].label, '개인');
    await h.service.updateSettings({ hidden: { k1: true } });
    assert.deepEqual((await h.service.getState()).view.agents, []);
    assert.deepEqual((await h.service.getState()).accounts.map((a) => a.accountKey), ['k1'], 'hidden accounts stay listed in settings');
  } finally {
    h.done();
  }
});

test('FR-USAGE-003 AC-1: a collection that fails in every folder is refused and the failure is shown', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    (h.service as any).deps.setClaudeCollection = async () => [{ configDir: 'C:/u/.claude', source: 'windows', installed: false, drifted: false, error: 'settings.json does not parse' }];
    await assert.rejects(h.service.updateSettings({ claudeCollection: true }), UsageSettingsError);
    const state = await h.service.getState();
    assert.equal(state.settings.claudeCollection, false);
    assert.equal(state.claudeCollection[0]?.error, 'settings.json does not parse');
  } finally {
    h.done();
  }
});

test('FR-USAGE-003 AC-4: saving with collection on puts the relay back where it was replaced', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ claudeCollection: true });
    (h.service as any).deps.claudeCollectionStatus = async () => [{ configDir: 'C:/u/.claude', source: 'windows', installed: false, drifted: true }];
    await h.service.updateSettings({ claudeCollection: true });
    assert.deepEqual(h.relayCalls, [true, true]);
  } finally {
    h.done();
  }
});

test('FR-USAGE-004 AC-4: nicknames and hidden flags merge per account; accounts not in the request keep theirs', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ nicknames: { a: '가', b: '나' }, hidden: { a: true } });
    await h.service.updateSettings({ nicknames: { b: '' }, hidden: { b: true } });
    const stored = JSON.parse(readFileSync(path.join(h.dir, 'usage-limits.json'), 'utf8'));
    assert.deepEqual(stored.nicknames, { a: '가' });
    assert.deepEqual([...stored.hidden].sort(), ['a', 'b']);
    await h.service.updateSettings({ hidden: { a: false } });
    assert.deepEqual(JSON.parse(readFileSync(path.join(h.dir, 'usage-limits.json'), 'utf8')).hidden, ['b']);
  } finally {
    h.done();
  }
});

test('FR-USAGE-006 AC-2: a refresh during a slow save keeps its remembered values', async () => {
  let used = 85;
  const h = harness(() => [codex(used)]);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ alerts: { telegram: { enabled: true, botToken: BOT, chatId: '-1' } } });
    let release!: () => void;
    (h.service as any).deps.setClaudeCollection = () => new Promise((resolve) => { release = () => resolve([{ configDir: 'x', source: 'windows', installed: true, drifted: false }]); });
    const saving = h.service.updateSettings({ claudeCollection: true });
    await h.service.refresh(); // remembers 85 and alerts once
    release();
    await saving;
    await h.service.refresh(); // still 85: must not alert again
    assert.equal(h.sent.length, 1);
    used = 86;
  } finally {
    h.done();
  }
});

test('FR-USAGE-005: a damaged settings file does not stop the server; defaults are used', async () => {
  const h = harness(() => []);
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(h.dir, 'usage-limits.json'), '{ not json');
    await h.service.initialize();
    assert.equal((await h.service.getState()).settings.refreshSeconds, 60);
  } finally {
    h.done();
  }
});

test('FR-USAGE-004 AC-4: an account with no recorded window is not listed in settings either', async () => {
  const h = harness(() => [codex(10), { ...codex(10), accountKey: 'k-empty', windows: {} }]);
  try {
    await h.service.initialize();
    await h.service.refresh();
    assert.deepEqual((await h.service.getState()).accounts.map((a) => a.accountKey), ['k1']);
  } finally {
    h.done();
  }
});

test('FR-USAGE-003 AC-3: with collection on, a server start writes the current relay again (an update would leave the old one)', async () => {
  const h = harness(() => []);
  try {
    await h.service.initialize();
    await h.service.updateSettings({ claudeCollection: true });
    h.service.dispose();
    const again = new UsageLimitsService({ ...(h.service as any).deps });
    await again.initialize();
    assert.deepEqual(h.relayCalls, [true, true]);
    again.dispose();
  } finally {
    h.done();
  }
});

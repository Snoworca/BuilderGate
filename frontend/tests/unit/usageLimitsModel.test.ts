import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSettingsUpdate, durationParts, validateUsageForm, type UsageSettingsForm } from '../../src/components/UsageLimits/usageLimitsModel.ts';

// FR-USAGE-005..007 — the usage settings form and the reset countdown.

const form = (overrides: Partial<UsageSettingsForm> = {}): UsageSettingsForm => ({
  showInSidebar: true,
  refreshSeconds: '60',
  claudeCollection: false,
  thresholdPercent: '20',
  agents: ['claude', 'codex'],
  windows: ['fiveHour', 'weekly'],
  googleChatEnabled: true,
  googleChatWebhookUrl: '',
  telegramEnabled: false,
  telegramBotToken: '',
  telegramChatId: '-100',
  nicknames: { k1: '회사 팀' },
  hidden: [],
  ...overrides,
});

test('FR-USAGE-005 AC-1 / FR-USAGE-006 AC-1: out-of-range numbers are caught before saving', () => {
  assert.deepEqual(validateUsageForm(form()), []);
  assert.deepEqual(validateUsageForm(form({ refreshSeconds: '14', thresholdPercent: '100' })), ['refreshSeconds', 'thresholdPercent']);
  assert.deepEqual(validateUsageForm(form({ refreshSeconds: '', thresholdPercent: '2.5' })), ['refreshSeconds', 'thresholdPercent']);
});

test('FR-USAGE-006 AC-4: a blank secret is not sent, so the stored one is kept', () => {
  const update = buildSettingsUpdate(form());
  assert.equal(update.refreshSeconds, 60);
  assert.equal(update.alerts.thresholdPercent, 20);
  assert.equal('webhookUrl' in update.alerts.googleChat, false);
  assert.equal('botToken' in update.alerts.telegram, false);
  assert.equal(update.alerts.telegram.chatId, '-100');
  const typed = buildSettingsUpdate(form({ googleChatWebhookUrl: ' https://chat.googleapis.com/x ' }));
  assert.equal(typed.alerts.googleChat.webhookUrl, 'https://chat.googleapis.com/x');
});

test('FR-USAGE-007 AC-2: the reset countdown is split into days, hours and minutes, rounding up', () => {
  assert.deepEqual(durationParts(2 * 3_600_000 + 9 * 60_000 + 1), { days: 0, hours: 2, minutes: 10 });
  assert.deepEqual(durationParts(3 * 86_400_000 + 4 * 3_600_000), { days: 3, hours: 4, minutes: 0 });
  assert.deepEqual(durationParts(-5), { days: 0, hours: 0, minutes: 0 });
});

test('FR-USAGE-004 AC-4: nicknames and hidden flags go out per listed account, so unlisted accounts keep theirs', () => {
  const update = buildSettingsUpdate(form({ nicknames: { k1: '회사 팀', k2: '' }, hidden: ['k2'] }), ['k1', 'k2']);
  assert.deepEqual(update.nicknames, { k1: '회사 팀', k2: '' });
  assert.deepEqual(update.hidden, { k1: false, k2: true });
});

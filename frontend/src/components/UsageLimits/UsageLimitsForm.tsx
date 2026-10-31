// FR-USAGE-005..007: usage limit settings. The same form is in the settings dialog of the workspace list and on the settings page.
import { useEffect, useState } from 'react';
import { Button, Field, NumberInput, Switch, TextInput } from '../ui';
import { activeLanguage, t } from '../../i18n/i18n.ts';
import { usageLimitsApi } from '../../services/api.ts';
import { buildSettingsUpdate, formFromState, validateUsageForm, type UsageSettingsForm } from './usageLimitsModel.ts';
import { AGENT_KEYS, SOURCE_KEYS, WINDOW_KEYS } from './usageLimitsMessages.ts';
import type { UsageAgent, UsageSendResult, UsageState, UsageWindowKind } from './usageLimitsTypes.ts';
import './UsageLimits.css';

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** FR-USAGE-007 AC-3: the dialog and the settings page show the same settings; a save tells the other. */
export const USAGE_CHANGED_EVENT = 'buildergate:usage-limits-changed';
const announceUsageChange = () => window.dispatchEvent(new Event(USAGE_CHANGED_EVENT));

interface TestOutcome { at: Date; result: UsageSendResult }

export function UsageLimitsForm({ onSaved, onCancel }: { onSaved?: (state: UsageState) => void; onCancel?: () => void }) {
  const [state, setState] = useState<UsageState | null>(null);
  const [form, setForm] = useState<UsageSettingsForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Partial<Record<'googleChat' | 'telegram', TestOutcome>>>({});
  const [testing, setTesting] = useState<'googleChat' | 'telegram' | null>(null);

  useEffect(() => {
    usageLimitsApi.get()
      .then((loaded) => { setState(loaded); setForm(formFromState(loaded)); })
      .catch((reason: unknown) => setError(errorText(reason)));
  }, []);

  if (!form || !state) {
    return <div className="usage-form">{error !== null ? <div className="usage-error" role="alert">{error}</div> : t('usage.form.loading')}</div>;
  }

  const patch = (changes: Partial<UsageSettingsForm>) => { setSaved(false); setForm({ ...form, ...changes }); };
  const toggleIn = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  const invalid = validateUsageForm(form);
  const { alerts } = state.settings;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await usageLimitsApi.saveSettings(buildSettingsUpdate(form, state.accounts.map((account) => account.accountKey)));
      announceUsageChange();
      setState(next);
      setForm(formFromState(next));
      setSaved(true);
      onSaved?.(next);
    } catch (reason) {
      setError(errorText(reason));
      // FR-USAGE-003 AC-4: show which Claude folder failed and why, without reopening the form.
      usageLimitsApi.get().then(setState).catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  const clearSecret = async (which: 'googleChatWebhook' | 'telegramBotToken') => {
    try {
      // Clears only the secret; other unsaved edits stay in the form.
      const next = await usageLimitsApi.saveSettings({ alerts: { clear: [which] } });
      setState(next);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  // FR-USAGE-006 AC-5: the values typed now, stored ones for anything left blank.
  const runTest = async (channel: 'googleChat' | 'telegram') => {
    setTesting(channel);
    const values = channel === 'googleChat'
      ? { webhookUrl: form.googleChatWebhookUrl }
      : { botToken: form.telegramBotToken, chatId: form.telegramChatId };
    try {
      const result = await usageLimitsApi.test(channel, values);
      setTests((current) => ({ ...current, [channel]: { at: new Date(), result } }));
    } catch (reason) {
      setTests((current) => ({ ...current, [channel]: { at: new Date(), result: { ok: false, status: 0, error: errorText(reason) } } }));
    } finally {
      setTesting(null);
    }
  };

  const outcome = (channel: 'googleChat' | 'telegram') => {
    const entry = tests[channel];
    if (!entry) return null;
    const time = entry.at.toLocaleTimeString(activeLanguage());
    return (
      <div className={`usage-test-result ${entry.result.ok ? 'ok' : 'fail'}`} role="status">
        {entry.result.ok
          ? t('usage.test.sent', { time, status: entry.result.status })
          : t('usage.test.failed', { time, error: entry.result.error ?? `HTTP ${entry.result.status}` })}
      </div>
    );
  };

  return (
    <div className="usage-form" data-testid="usage-limits-form">
      <div className="usage-section">{t('usage.form.display')}</div>
      <Switch checked={form.showInSidebar} onChange={(e) => patch({ showInSidebar: e.target.checked })}>{t('usage.form.showInSidebar')}</Switch>
      <Field label={t('usage.form.refreshSeconds')} htmlFor="usage-refresh" help={t('usage.form.refreshHelp')} error={invalid.includes('refreshSeconds') ? t('usage.form.refreshInvalid') : undefined}>
        <NumberInput id="usage-refresh" min={15} max={3600} unit={t('usage.form.seconds')} value={form.refreshSeconds} onChange={(e) => patch({ refreshSeconds: e.target.value })} />
      </Field>
      <Switch checked={form.claudeCollection} onChange={(e) => patch({ claudeCollection: e.target.checked })}>{t('usage.form.claudeCollection')}</Switch>
      <p className="usage-help">{t('usage.form.claudeCollectionHelp')}</p>
      {state.claudeCollection.some((dir) => dir.drifted) && <p className="usage-warn" role="status">{t('usage.form.claudeDrifted')}</p>}
      {state.claudeCollection.filter((dir) => dir.error).map((dir) => (
        <p key={dir.configDir} className="usage-error">{t('usage.form.claudeDirFailed', { where: t(SOURCE_KEYS[dir.source]), error: dir.error ?? '' })}</p>
      ))}

      {state.accounts.length > 0 && (
        <>
          <div className="usage-section">{t('usage.form.accounts')}</div>
          <p className="usage-help">{t('usage.form.accountsHelp')}</p>
          {state.accounts.map((account) => (
            <div key={account.accountKey} className="usage-account-row">
              <span className="usage-account-who"><b>{t(AGENT_KEYS[account.agent])}</b> · {account.defaultLabel} · {t(SOURCE_KEYS[account.source])}</span>
              <TextInput value={form.nicknames[account.accountKey] ?? ''} placeholder={t('usage.form.nickname')} aria-label={t('usage.form.nickname')} maxLength={40}
                onChange={(e) => patch({ nicknames: { ...form.nicknames, [account.accountKey]: e.target.value } })} />
              <label className="usage-check"><input type="checkbox" checked={!form.hidden.includes(account.accountKey)}
                onChange={() => patch({ hidden: toggleIn(form.hidden, account.accountKey) })} /> {t('usage.form.show')}</label>
            </div>
          ))}
        </>
      )}

      <div className="usage-section">{t('usage.form.alerts')}</div>
      <Field label={t('usage.form.threshold')} htmlFor="usage-threshold" error={invalid.includes('thresholdPercent') ? t('usage.form.thresholdInvalid') : undefined}>
        <NumberInput id="usage-threshold" min={1} max={99} unit="%" value={form.thresholdPercent} onChange={(e) => patch({ thresholdPercent: e.target.value })} />
      </Field>
      <p className="usage-help">{t('usage.form.thresholdHelp')}</p>
      <div className="usage-checks" role="group" aria-label={t('usage.form.targets')}>
        {(['claude', 'codex'] as UsageAgent[]).map((agent) => (
          <label key={agent} className="usage-check"><input type="checkbox" checked={form.agents.includes(agent)} onChange={() => patch({ agents: toggleIn(form.agents, agent) })} /> {t(AGENT_KEYS[agent])}</label>
        ))}
        {(['fiveHour', 'weekly'] as UsageWindowKind[]).map((kind) => (
          <label key={kind} className="usage-check"><input type="checkbox" checked={form.windows.includes(kind)} onChange={() => patch({ windows: toggleIn(form.windows, kind) })} /> {t(WINDOW_KEYS[kind])}</label>
        ))}
      </div>

      <div className="usage-channel">
        <div className="usage-channel-head">
          <Switch checked={form.googleChatEnabled} onChange={(e) => patch({ googleChatEnabled: e.target.checked })}>{t('usage.channel.googleChat')}</Switch>
          <Button size="sm" variant="secondary" disabled={testing !== null} onClick={() => void runTest('googleChat')}>{t('usage.test.send')}</Button>
        </div>
        <Field label={t('usage.channel.webhookUrl')} htmlFor="usage-gchat" help={alerts.googleChat.webhookUrlSet ? t('usage.channel.stored', { hint: alerts.googleChat.webhookUrlHint }) : undefined}>
          <div className="usage-secret">
            <TextInput id="usage-gchat" mono autoComplete="off" value={form.googleChatWebhookUrl} placeholder="https://chat.googleapis.com/v1/spaces/…" onChange={(e) => patch({ googleChatWebhookUrl: e.target.value })} />
            {alerts.googleChat.webhookUrlSet && <Button size="sm" variant="secondary" onClick={() => void clearSecret('googleChatWebhook')}>{t('usage.channel.clear')}</Button>}
          </div>
        </Field>
        {outcome('googleChat')}
      </div>

      <div className="usage-channel">
        <div className="usage-channel-head">
          <Switch checked={form.telegramEnabled} onChange={(e) => patch({ telegramEnabled: e.target.checked })}>{t('usage.channel.telegram')}</Switch>
          <Button size="sm" variant="secondary" disabled={testing !== null} onClick={() => void runTest('telegram')}>{t('usage.test.send')}</Button>
        </div>
        <Field label={t('usage.channel.botToken')} htmlFor="usage-tg-token" help={alerts.telegram.botTokenSet ? t('usage.channel.stored', { hint: alerts.telegram.botTokenHint }) : undefined}>
          <div className="usage-secret">
            <TextInput id="usage-tg-token" mono type="password" autoComplete="off" value={form.telegramBotToken} placeholder="123456:ABC-…" onChange={(e) => patch({ telegramBotToken: e.target.value })} />
            {alerts.telegram.botTokenSet && <Button size="sm" variant="secondary" onClick={() => void clearSecret('telegramBotToken')}>{t('usage.channel.clear')}</Button>}
          </div>
        </Field>
        <Field label={t('usage.channel.chatId')} htmlFor="usage-tg-chat" help={t('usage.channel.chatIdHelp')}>
          <TextInput id="usage-tg-chat" mono value={form.telegramChatId} onChange={(e) => patch({ telegramChatId: e.target.value })} />
        </Field>
        {outcome('telegram')}
      </div>

      {error !== null && <div className="usage-error" role="alert">{error}</div>}
      <div className="usage-actions">
        {saved && <span className="usage-saved" role="status">{t('usage.form.saved')}</span>}
        {onCancel && <Button variant="secondary" size="md" onClick={onCancel}>{t('common.cancel')}</Button>}
        <Button variant="primary" size="md" disabled={saving || invalid.length > 0} onClick={() => void save()}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

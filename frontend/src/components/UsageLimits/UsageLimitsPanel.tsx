// FR-USAGE-007: usage bars under the workspace list, with refresh and settings.
import { useCallback, useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common/Icon';
import { t } from '../../i18n/i18n.ts';
import { usageLimitsApi } from '../../services/api.ts';
import { activeAgents, agentClassName, durationParts, loggedOutAgents } from './usageLimitsModel.ts';
import { AGENT_KEYS, SOURCE_KEYS, WINDOW_KEYS } from './usageLimitsMessages.ts';
import type { UsageAccountView, UsageState, UsageWindowView } from './usageLimitsTypes.ts';
import { USAGE_CHANGED_EVENT, UsageLimitsForm } from './UsageLimitsForm.tsx';
import './UsageLimits.css';

const DEFAULT_POLL_MS = 60_000;

function resetText(window: UsageWindowView, now: number): string {
  if (window.reset) return t('usage.reset.done');
  if (window.resetsAt === null) return '';
  const { days, hours, minutes } = durationParts(window.resetsAt - now);
  const span = days > 0 ? t('usage.duration.daysHours', { days, hours }) : hours > 0 ? t('usage.duration.hoursMinutes', { hours, minutes }) : t('usage.duration.minutes', { minutes });
  return t('usage.reset.in', { time: span });
}

function ageText(observedAt: number, now: number): string {
  const minutes = Math.floor((now - observedAt) / 60_000);
  if (minutes < 1) return t('usage.age.now');
  if (minutes < 60) return t('usage.age.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('usage.age.hours', { hours }) : t('usage.age.days', { days: Math.floor(hours / 24) });
}

function WindowBar({ window, now }: { window: UsageWindowView; now: number }) {
  const used = Math.round(window.usedPercent);
  return (
    <div className="usage-win">
      <span className="usage-win-label">{t(WINDOW_KEYS[window.kind])}</span>
      <div className="usage-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={t(WINDOW_KEYS[window.kind])}>
        <div className={`usage-bar-fill usage-${window.level}`} style={{ width: `${used}%` }} />
      </div>
      <div className="usage-win-text"><span>{used}%</span><span className="usage-reset">{resetText(window, now)}</span></div>
    </div>
  );
}

function AccountRows({ accounts, now, alwaysNamed = false }: { accounts: UsageAccountView[]; now: number; alwaysNamed?: boolean }) {
  if (accounts.length === 1 && !alwaysNamed) {
    const [only] = accounts;
    return <>{only.windows.map((w) => <WindowBar key={w.kind} window={w} now={now} />)}</>;
  }
  return (
    <>
      {accounts.map((account) => (
        <div key={account.accountKey ?? `?${account.source}`} className={`usage-account${account.stale ? ' usage-stale' : ''}`}>
          {/* The name has a line of its own so a full address is not cut off. */}
          <div className={`usage-account-name${account.unknownAccount ? ' usage-unknown' : ''}`} title={account.label}>{account.unknownAccount ? t('usage.account.unknown') : account.label}</div>
          <div className="usage-account-head">
            <span className="usage-account-where">{t(SOURCE_KEYS[account.source])}</span>
            <span className="usage-age">{ageText(account.observedAt, now)}</span>
          </div>
          {account.windows.map((w) => <WindowBar key={w.kind} window={w} now={now} />)}
        </div>
      ))}
    </>
  );
}

export function UsageLimitsPanel() {
  const [state, setState] = useState<UsageState | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loggedOutOpen, setLoggedOutOpen] = useState(false);

  const load = useCallback(() => {
    usageLimitsApi.get().then((next) => { setState(next); setNow(Date.now()); }).catch(() => { /* keep the last view */ });
  }, []);

  useEffect(() => { load(); }, [load]);

  // FR-USAGE-007 AC-3: a save on the settings page shows here at once.
  useEffect(() => {
    window.addEventListener(USAGE_CHANGED_EVENT, load);
    return () => window.removeEventListener(USAGE_CHANGED_EVENT, load);
  }, [load]);

  // FR-USAGE-005 AC-3: the browser follows the server's refresh interval.
  const pollMs = (state?.settings.refreshSeconds ?? DEFAULT_POLL_MS / 1000) * 1000;
  useEffect(() => {
    const timer = window.setInterval(load, pollMs);
    return () => window.clearInterval(timer);
  }, [load, pollMs]);

  const refresh = () => {
    setSpinning(true);
    usageLimitsApi.refresh()
      .then((next) => { setState(next); setNow(Date.now()); })
      .catch(() => { /* keep the last view */ })
      .finally(() => setSpinning(false));
  };

  if (!state || !state.settings.showInSidebar) return null;
  const claudeOff = !state.settings.claudeCollection;
  const agents = activeAgents(state.view);
  const loggedOut = loggedOutAgents(state.view);
  const anyLoggedOut = loggedOut.length > 0;
  const hasClaude = agents.some((agent) => agent.agent === 'claude');
  if (agents.length === 0 && !claudeOff && !anyLoggedOut) return null;

  return (
    <div className="usage-panel" data-testid="usage-limits-panel">
      <div className="usage-panel-head">
        <span className="usage-panel-title">{t('usage.panel.title')}</span>
        {anyLoggedOut && (
          <button type="button" className="usage-icon-btn" title={t('usage.panel.showLoggedOut')} aria-label={t('usage.panel.showLoggedOut')}
            onClick={() => { load(); setLoggedOutOpen(true); }}><Icon name="archive" size={15} /></button>
        )}
        <button type="button" className={`usage-icon-btn${spinning ? ' usage-spin' : ''}`} title={t('usage.panel.refresh')} aria-label={t('usage.panel.refresh')} onClick={refresh}><Icon name="refresh" size={15} /></button>
        <button type="button" className="usage-icon-btn" title={t('usage.panel.settings')} aria-label={t('usage.panel.settings')} onClick={() => setSettingsOpen(true)}><Icon name="settings" size={15} /></button>
      </div>
      {claudeOff && !hasClaude && (
        <div className="usage-agent">
          <div className="usage-agent-head"><span className="usage-agent-name">{t(AGENT_KEYS.claude)}</span></div>
          <div className="usage-off">{t('usage.panel.claudeOff')} <button type="button" className="usage-link" onClick={() => setSettingsOpen(true)}>{t('usage.panel.turnOn')}</button></div>
        </div>
      )}
      {agents.length === 0 && !claudeOff && <div className="usage-off">{t('usage.panel.onlyLoggedOut')}</div>}
      {agents.map((group) => (
        <div key={group.agent} className={agentClassName(group.accounts)}>
          <div className="usage-agent-head">
            <span className="usage-agent-name">{t(AGENT_KEYS[group.agent])}</span>
            {group.accounts.length === 1 && <span className="usage-age">{ageText(group.accounts[0].observedAt, now)}</span>}
          </div>
          <AccountRows accounts={group.accounts} now={now} />
        </div>
      ))}
      {/* FR-USAGE-007 AC-6: read once when it opens; these records no longer change. */}
      {loggedOutOpen && (
        <WindowDialog dialogId="usage-limits-logged-out" title={t('usage.loggedOut.title')} mode="modal"
          defaultRect={{ x: 180, y: 80, width: 420, height: 460 }} minSize={{ width: 300, height: 220 }} onClose={() => setLoggedOutOpen(false)}>
          <div className="usage-panel usage-logged-out-dialog">
            <div className="usage-off">{t('usage.loggedOut.note')}</div>
            {loggedOut.length === 0 && <div className="usage-off">{t('usage.loggedOut.none')}</div>}
            {loggedOut.map((group) => (
              <div key={group.agent} className="usage-agent">
                <div className="usage-agent-head"><span className="usage-agent-name">{t(AGENT_KEYS[group.agent])}</span></div>
                <AccountRows accounts={group.accounts} now={now} alwaysNamed />
              </div>
            ))}
          </div>
        </WindowDialog>
      )}
      {settingsOpen && (
        <WindowDialog dialogId="usage-limits-settings" title={t('usage.dialog.title')} mode="modal"
          defaultRect={{ x: 160, y: 60, width: 600, height: 680 }} minSize={{ width: 380, height: 420 }} onClose={() => setSettingsOpen(false)}>
          <UsageLimitsForm onCancel={() => setSettingsOpen(false)} onSaved={(next) => { setState(next); setSettingsOpen(false); }} />
        </WindowDialog>
      )}
    </div>
  );
}

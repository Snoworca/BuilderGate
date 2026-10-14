import { useCallback, useEffect, useState } from 'react';
import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import { Button, Chip } from '../ui';
import type { ChipTone } from '../ui';
import {
  currentNotificationPermission,
  notificationCenter,
  type NotificationPermissionState,
} from '../../utils/browserNotifications.ts';

const STATE_VIEW = {
  granted: { tone: 'ok', label: 'notification.settings.state.granted', help: 'notification.settings.help.granted' },
  denied: { tone: 'danger', label: 'notification.settings.state.denied', help: 'notification.settings.help.denied' },
  default: { tone: 'neutral', label: 'notification.settings.state.default', help: 'notification.settings.help.default' },
  unavailable: { tone: 'warn', label: 'notification.settings.state.unavailable', help: 'notification.settings.help.unavailable' },
} satisfies Record<NotificationPermissionState, { tone: ChipTone; label: MessageKey; help: MessageKey }>;

/** FR-MCP-012 AC-6: whether this page may show system notifications, and a way to ask. */
export function BrowserNotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermissionState>(() => currentNotificationPermission());
  const refresh = useCallback(() => setPermission(currentNotificationPermission()), []);

  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const request = async () => {
    try {
      await Notification.requestPermission();
    } finally {
      refresh();
    }
  };

  const sendTest = () => {
    const title = t('notification.settings.testTitle');
    const body = t('notification.settings.testBody');
    if (permission === 'granted') {
      try {
        new Notification(title, { body, tag: 'buildergate-test' });
        return;
      } catch {
        // fall through to the in-page notification
      }
    }
    notificationCenter.push(
      { id: `test_${Date.now()}`, title, body, level: 'info', at: new Date().toISOString(), from: null },
      { unseen: false },
    );
  };

  const view = STATE_VIEW[permission];
  return (
    <div className="settings-notification" data-testid="settings-browser-notifications">
      <p data-testid="settings-notification-state" data-state={permission}>
        <Chip tone={view.tone}>{t(view.label)}</Chip>
      </p>
      <p className="settings-notification-help">{t(view.help)}</p>
      <div className="settings-notification-actions">
        {permission === 'default' && (
          <Button variant="primary" size="sm" onClick={() => { void request(); }} data-testid="settings-notification-request">
            {t('notification.settings.request')}
          </Button>
        )}
        <Button size="sm" onClick={sendTest} data-testid="settings-notification-test">
          {t('notification.settings.test')}
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useSyncExternalStore } from 'react';
import './BrowserNotificationLayer.css';
import { t } from '../../i18n/i18n.ts';
import {
  notificationCenter,
  openNotificationSender,
  titleWithUnseenCount,
} from '../../utils/browserNotifications.ts';

const BASE_TITLE = typeof document === 'undefined' ? 'BuilderGate' : document.title || 'BuilderGate';

/**
 * FR-MCP-012 AC-5: notifications the page shows itself. They stay until dismissed or opened, and
 * while the page is out of view the tab title carries the unseen count. This is what still works
 * when the browser refuses system notifications, for example over remote access.
 */
export function BrowserNotificationLayer() {
  const items = useSyncExternalStore(notificationCenter.subscribe, notificationCenter.list);
  const unseen = useSyncExternalStore(notificationCenter.subscribe, notificationCenter.unseenCount);

  useEffect(() => {
    document.title = titleWithUnseenCount(BASE_TITLE, unseen);
  }, [unseen]);

  useEffect(() => {
    const markSeenWhenInView = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) notificationCenter.markSeen();
    };
    document.addEventListener('visibilitychange', markSeenWhenInView);
    window.addEventListener('focus', markSeenWhenInView);
    return () => {
      document.removeEventListener('visibilitychange', markSeenWhenInView);
      window.removeEventListener('focus', markSeenWhenInView);
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="browser-notification-layer" role="region" aria-label={t('notification.region')}>
      {items.map((item) => (
        <div key={item.id} className={`browser-notification browser-notification--${item.level}`} role="status" data-testid="browser-notification">
          <button
            type="button"
            className="browser-notification__main"
            onClick={() => { openNotificationSender(item); notificationCenter.dismiss(item.id); }}
            title={item.from ? t('notification.openSender') : undefined}
          >
            <span className="browser-notification__title">{item.title}</span>
            {item.body && <span className="browser-notification__body">{item.body}</span>}
            {item.from && <span className="browser-notification__from">{item.from.alias}</span>}
          </button>
          <button
            type="button"
            className="browser-notification__close"
            aria-label={t('notification.dismiss')}
            onClick={() => notificationCenter.dismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

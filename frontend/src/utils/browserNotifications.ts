// FR-MCP-012: notifications sent by the MCP tool buildergate.notify. The server sends
// `notification:show` to every page; each page decides how to show it.

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';
export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unavailable';

export interface BrowserNotificationSender {
  alias: string;
  sessionKey: string;
  workspaceId: string | null;
  tabId: string | null;
}

export interface BrowserNotificationPayload {
  id: string;
  title: string;
  body: string;
  level: NotificationLevel;
  at: string;
  from: BrowserNotificationSender | null;
}

const LEVELS: readonly NotificationLevel[] = ['info', 'success', 'warning', 'error'];
const MAX_IN_PAGE = 5;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function parseNotificationPayload(data: unknown): BrowserNotificationPayload | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const id = str(record.id);
  const title = str(record.title);
  if (!id || !title) return null;
  const level = LEVELS.includes(record.level as NotificationLevel) ? record.level as NotificationLevel : 'info';
  const rawFrom = record.from && typeof record.from === 'object' ? record.from as Record<string, unknown> : null;
  const from = rawFrom && str(rawFrom.sessionKey)
    ? {
      alias: str(rawFrom.alias) ?? String(rawFrom.sessionKey),
      sessionKey: String(rawFrom.sessionKey),
      workspaceId: str(rawFrom.workspaceId),
      tabId: str(rawFrom.tabId),
    }
    : null;
  return { id, title, body: str(record.body) ?? '', level, at: str(record.at) ?? '', from };
}

/**
 * System notifications need the API and a secure context. Over remote access with a self-signed
 * certificate a browser may still refuse them; the page then falls back to its own surface.
 */
export function readNotificationPermission(env: {
  secure: boolean;
  api: { permission: string } | undefined;
}): NotificationPermissionState {
  if (!env.secure || !env.api) return 'unavailable';
  const permission = env.api.permission;
  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

export function currentNotificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined') return 'unavailable';
  return readNotificationPermission({
    secure: window.isSecureContext === true,
    api: typeof Notification === 'undefined' ? undefined : Notification,
  });
}

export function decideNotificationPresentation(input: {
  inView: boolean;
  permission: NotificationPermissionState;
}): 'system' | 'in-page' {
  return !input.inView && input.permission === 'granted' ? 'system' : 'in-page';
}

export function titleWithUnseenCount(baseTitle: string, unseen: number): string {
  return unseen > 0 ? `(${unseen}) ${baseTitle}` : baseTitle;
}

export interface NotificationCenter {
  push(notification: BrowserNotificationPayload, options: { unseen: boolean }): void;
  dismiss(id: string): void;
  markSeen(): void;
  list(): readonly BrowserNotificationPayload[];
  unseenCount(): number;
  subscribe(listener: () => void): () => void;
}

/** In-page notifications, newest first. They stay until the user dismisses or opens them. */
export function createNotificationCenter(): NotificationCenter {
  let items: BrowserNotificationPayload[] = [];
  const unseen = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  return {
    push(notification, options) {
      if (items.some(item => item.id === notification.id)) return;
      items = [notification, ...items].slice(0, MAX_IN_PAGE);
      if (options.unseen) unseen.add(notification.id);
      for (const id of [...unseen]) if (!items.some(item => item.id === id)) unseen.delete(id);
      emit();
    },
    dismiss(id) {
      if (!items.some(item => item.id === id)) return;
      items = items.filter(item => item.id !== id);
      unseen.delete(id);
      emit();
    },
    markSeen() {
      if (unseen.size === 0) return;
      unseen.clear();
      emit();
    },
    list: () => items,
    unseenCount: () => unseen.size,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const notificationCenter = createNotificationCenter();

let navigate: ((workspaceId: string, tabId: string | null) => void) | null = null;

/** The workspace manager registers how to open a sender's tab. */
export function setNotificationNavigator(next: typeof navigate): void {
  navigate = next;
}

export function openNotificationSender(notification: BrowserNotificationPayload): void {
  const from = notification.from;
  if (from?.workspaceId) navigate?.(from.workspaceId, from.tabId);
}

function pageInView(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Called for every `notification:show` event. */
export function presentBrowserNotification(data: unknown): void {
  const notification = parseNotificationPayload(data);
  if (!notification) return;
  const inView = pageInView();
  if (decideNotificationPresentation({ inView, permission: currentNotificationPermission() }) === 'system') {
    try {
      const shown = new Notification(notification.title, {
        body: notification.from ? `${notification.body}${notification.body ? '\n' : ''}— ${notification.from.alias}` : notification.body,
        tag: notification.id,
      });
      shown.onclick = () => {
        window.focus();
        openNotificationSender(notification);
        shown.close();
      };
      return;
    } catch {
      // Some browsers expose the API but refuse page-created notifications; fall through.
    }
  }
  notificationCenter.push(notification, { unseen: !inView });
}

// Mockup ① callout 1: the header's messenger button with its unread badge,
// red when a message names me or something waits for me.
// @req FR-MSG-013 FR-MSG-010
import { Icon } from '../common';
import { t, tn } from '../../i18n/i18n.ts';
import { headerBadge } from './messengerModel.ts';
import type { MessengerState } from './messengerTypes.ts';

interface MessengerButtonProps {
  state: MessengerState | null;
  active: boolean;
  onClick: () => void;
}

export function MessengerButton({ state, active, onClick }: MessengerButtonProps) {
  const pending = state ? state.invites.length + state.approvals.length + state.requests.length : 0;
  const badge = state ? headerBadge(state.unread, pending) : null;
  return (
    <button
      type="button"
      className={`icon-button icon-button-md header-action-button header-messenger-button${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={t('messenger.title')}
      title={t('messenger.title')}
    >
      <Icon name="chat" size={18} />
      {badge !== null && (
        <span
          className={`ui-badge header-messenger-badge ${badge.tone === 'danger' ? 'header-messenger-badge-danger' : 'ui-badge-accent'}`}
          role="status"
          aria-label={tn('messenger.button.unread', badge.count)}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

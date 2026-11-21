// FR-CMP-001 AC-2: the composer toggle at the right end of a session's status row, with a
// dot while an unsent draft waits. Its styles are in SessionComposer.css, which the composer
// that every status row sits under has already loaded.
// @req FR-CMP-001

import { t } from '../../i18n/i18n.ts';
import { Icon } from '../common/Icon';
import { isSendableDraft } from './sessionComposerModel.ts';
import { useComposerSession } from './sessionComposerStore.ts';
import { toggleComposer, useSessionComposerHost } from './sessionComposerHost.ts';

export function SessionComposerToggle({ tabId, showLabel }: { tabId: string; showLabel: boolean }) {
  const host = useSessionComposerHost();
  const session = useComposerSession(tabId);
  if (!host) return null;
  const hasDraft = isSendableDraft(session.draft);
  const action = session.open ? t('composer.toggle.close') : t('composer.toggle.open');
  const title = hasDraft ? `${action} · ${t('composer.toggle.draftPending')}` : action;
  return (
    <button
      type="button"
      className="metadata-composer-toggle"
      aria-pressed={session.open}
      aria-label={title}
      title={title}
      data-composer-toggle={tabId}
      onClick={() => toggleComposer(host, tabId)}
    >
      <Icon name="edit" size={14} />
      {showLabel && <span>{t('composer.toggle.label')}</span>}
      {hasDraft && <span className="metadata-composer-toggle__dot" aria-hidden="true" />}
    </button>
  );
}

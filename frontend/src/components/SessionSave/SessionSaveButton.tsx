// FR-AITUI-009 AC-1 — the header button: save (bookmark), saved, or resume.
import { Icon } from '../common/Icon.tsx';
import { Badge, Tooltip } from '../ui/index.ts';
import type { SaveButtonState } from './sessionSnapshotModel.ts';
import './SessionSave.css';
import { t, tn } from '../../i18n/i18n.ts';

export interface SessionSaveButtonProps {
  state: SaveButtonState;
  onClick: () => void;
}

export function SessionSaveButton({ state, onClick }: SessionSaveButtonProps) {
  if (state.kind === 'pending') {
    return (
      <button
        type="button"
        className="session-save-pill session-save-pill-pending"
        aria-label={tn('sessionSave.button.resumeAria', state.count)}
        title={t('sessionSave.button.resumeTitle')}
        onClick={onClick}
      >
        <Icon name="resume" size={16} />
        {t('sessionSave.button.resume')}
        <span className="session-save-pill-count">{state.count}</span>
      </button>
    );
  }
  if (state.kind === 'saved') {
    return (
      <button
        type="button"
        className="session-save-pill session-save-pill-saved"
        aria-label={t('sessionSave.button.savedAria', { label: state.label })}
        title={t('sessionSave.button.savedTitle')}
        onClick={onClick}
      >
        <Icon name="bookmark-check" size={16} />
        {state.label}
      </button>
    );
  }
  return (
    <Tooltip
      title={t('sessionSave.button.title')}
      content={state.disabled
        ? t('sessionSave.button.noSessions')
        : tn('sessionSave.button.hint', state.badge)}
    >
      <button
        type="button"
        className="icon-button icon-button-md session-save-button"
        aria-label={tn('sessionSave.button.aria', state.badge)}
        disabled={state.disabled}
        onClick={onClick}
      >
        <Icon name="bookmark-plus" size={18} />
        {state.badge > 0 && <Badge count={state.badge} />}
      </button>
    </Tooltip>
  );
}

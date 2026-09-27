import type {
  TerminalShortcutAction,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutScope,
} from '../../types';
import { Icon } from '../common/Icon';
import { Button, Field, Select, TextInput } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { ShortcutActionEditor } from './ShortcutActionEditor';
import {
  TERMINAL_SHORTCUT_SCOPE_OPTIONS,
  descriptorLabel,
} from './shortcutBindingViewModel';

interface ShortcutCapturePanelProps {
  captureStatus: 'idle' | 'waiting' | 'captured' | 'timeout';
  capturedDescriptor: TerminalShortcutKeyDescriptor | null;
  scope: TerminalShortcutScope;
  description: string;
  action: TerminalShortcutAction;
  saving: boolean;
  canUseWorkspaceScope: boolean;
  canUseSessionScope: boolean;
  error: string | null;
  lastTestResult: string | null;
  editingLabel?: string | null;
  onScopeChange: (scope: TerminalShortcutScope) => void;
  onDescriptionChange: (description: string) => void;
  onActionChange: (action: TerminalShortcutAction) => void;
  onStartCapture: () => void;
  onSave: () => void;
  onTestSend: () => void;
  onCancelEdit?: () => void;
}

// KeyboardEvent.location, named: the same key code can come from either side
// of the keyboard or from the numeric keypad.
function keyLocationLabel(location: number): string {
  if (location === 1) return t('shortcut.location.left');
  if (location === 2) return t('shortcut.location.right');
  if (location === 3) return t('shortcut.location.numpad');
  return t('shortcut.location.standard');
}

export function ShortcutCapturePanel({
  captureStatus,
  capturedDescriptor,
  scope,
  description,
  action,
  saving,
  canUseWorkspaceScope,
  canUseSessionScope,
  error,
  lastTestResult,
  editingLabel,
  onScopeChange,
  onDescriptionChange,
  onActionChange,
  onStartCapture,
  onSave,
  onTestSend,
  onCancelEdit,
}: ShortcutCapturePanelProps) {
  const statusText = captureStatus === 'waiting'
    ? t('shortcut.capture.waiting')
    : captureStatus === 'timeout'
      ? t('shortcut.capture.timeout')
      : capturedDescriptor
        ? descriptorLabel(capturedDescriptor)
        : t('shortcut.capture.none');

  return (
    <div className="terminal-shortcut-capture-panel">
      <div className={`terminal-shortcut-capture-box is-${captureStatus}`} aria-live="polite">
        <div className="terminal-shortcut-capture-label">{editingLabel ? t('shortcut.capture.editing') : t('shortcut.capture.detected')}</div>
        <div className="terminal-shortcut-capture-value">{statusText}</div>
        {editingLabel && <div className="terminal-shortcut-capture-meta"><span>{editingLabel}</span></div>}
        {capturedDescriptor && (
          <div className="terminal-shortcut-capture-meta">
            <span>{capturedDescriptor.code}</span>
            <span>{keyLocationLabel(capturedDescriptor.location)}</span>
          </div>
        )}
      </div>

      <div className="terminal-shortcut-form-grid">
        <Field label={t('shortcut.capture.scope')} htmlFor="terminal-shortcut-scope" className="terminal-shortcut-field">
          <Select
            id="terminal-shortcut-scope"
            value={scope}
            onChange={(event) => onScopeChange(event.target.value as TerminalShortcutScope)}
            aria-label={t('shortcut.capture.scopeAria')}
          >
            {TERMINAL_SHORTCUT_SCOPE_OPTIONS.map(option => (
              <option
                key={option.scope}
                value={option.scope}
                disabled={(option.scope === 'workspace' && !canUseWorkspaceScope) || (option.scope === 'session' && !canUseSessionScope)}
              >
                {t(option.labelKey)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('shortcut.capture.description')} htmlFor="terminal-shortcut-description" className="terminal-shortcut-field">
          <TextInput
            id="terminal-shortcut-description"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            aria-label={t('shortcut.capture.descriptionAria')}
            maxLength={160}
          />
        </Field>

        <ShortcutActionEditor action={action} onChange={onActionChange} />
      </div>

      {(error || lastTestResult) && (
        <div className={error ? 'terminal-shortcut-error' : 'terminal-shortcut-toast'} role={error ? 'alert' : 'status'}>
          <Icon name={error ? 'alert' : 'check-circle'} size={14} />
          <span>{error ?? lastTestResult}</span>
        </div>
      )}

      <div className="terminal-shortcut-actions">
        <Button
          variant="secondary"
          size="md"
          icon="keyboard"
          className="terminal-shortcut-secondary-button"
          onClick={onStartCapture}
        >
          {t('shortcut.capture.start')}
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="terminal-shortcut-secondary-button"
          onClick={onTestSend}
          disabled={action.type !== 'send' || saving}
        >
          {t('shortcut.list.testSend')}
        </Button>
        {editingLabel && onCancelEdit && (
          <Button
            variant="secondary"
            size="md"
            className="terminal-shortcut-secondary-button"
            onClick={onCancelEdit}
            disabled={saving}
          >
            {t('common.cancel')}
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          className="terminal-shortcut-primary-button"
          onClick={onSave}
          disabled={!capturedDescriptor || saving}
        >
          {saving ? t('shortcut.capture.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}

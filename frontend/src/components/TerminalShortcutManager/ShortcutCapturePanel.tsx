import type {
  TerminalShortcutAction,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutScope,
} from '../../types';
import { Icon } from '../common/Icon';
import { Button, Field, Select, TextInput } from '../ui';
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
  if (location === 1) return '왼쪽 키';
  if (location === 2) return '오른쪽 키';
  if (location === 3) return '숫자 키패드';
  return '기본 위치';
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
    ? '등록할 키를 누르세요'
    : captureStatus === 'timeout'
      ? '제한 시간 안에 누른 키가 없습니다'
      : capturedDescriptor
        ? descriptorLabel(capturedDescriptor)
        : '아직 없음';

  return (
    <div className="terminal-shortcut-capture-panel">
      <div className={`terminal-shortcut-capture-box is-${captureStatus}`} aria-live="polite">
        <div className="terminal-shortcut-capture-label">{editingLabel ? '수정할 단축키' : '감지한 키'}</div>
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
        <Field label="범위" htmlFor="terminal-shortcut-scope" className="terminal-shortcut-field">
          <Select
            id="terminal-shortcut-scope"
            value={scope}
            onChange={(event) => onScopeChange(event.target.value as TerminalShortcutScope)}
            aria-label="단축키 범위"
          >
            {TERMINAL_SHORTCUT_SCOPE_OPTIONS.map(option => (
              <option
                key={option.scope}
                value={option.scope}
                disabled={(option.scope === 'workspace' && !canUseWorkspaceScope) || (option.scope === 'session' && !canUseSessionScope)}
              >
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="설명" htmlFor="terminal-shortcut-description" className="terminal-shortcut-field">
          <TextInput
            id="terminal-shortcut-description"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            aria-label="단축키 설명"
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
          감지 시작
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="terminal-shortcut-secondary-button"
          onClick={onTestSend}
          disabled={action.type !== 'send' || saving}
        >
          테스트 전송
        </Button>
        {editingLabel && onCancelEdit && (
          <Button
            variant="secondary"
            size="md"
            className="terminal-shortcut-secondary-button"
            onClick={onCancelEdit}
            disabled={saving}
          >
            취소
          </Button>
        )}
        <Button
          variant="primary"
          size="md"
          className="terminal-shortcut-primary-button"
          onClick={onSave}
          disabled={!capturedDescriptor || saving}
        >
          {saving ? '저장 중' : '저장'}
        </Button>
      </div>
    </div>
  );
}

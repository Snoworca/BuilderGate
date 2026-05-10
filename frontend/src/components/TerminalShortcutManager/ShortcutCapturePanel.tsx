import type {
  TerminalShortcutAction,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutScope,
} from '../../types';
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
    ? '입력 대기 중'
    : captureStatus === 'timeout'
      ? '감지되지 않음'
      : capturedDescriptor
        ? descriptorLabel(capturedDescriptor)
        : '아직 없음';

  return (
    <div className="terminal-shortcut-capture-panel">
      <div className={`terminal-shortcut-capture-box is-${captureStatus}`} aria-live="polite">
        <div className="terminal-shortcut-capture-label">{editingLabel ? '수정' : '감지'}</div>
        <div className="terminal-shortcut-capture-value">{statusText}</div>
        {editingLabel && <div className="terminal-shortcut-capture-meta"><span>{editingLabel}</span></div>}
        {capturedDescriptor && (
          <div className="terminal-shortcut-capture-meta">
            <span>{capturedDescriptor.code}</span>
            <span>location {capturedDescriptor.location}</span>
          </div>
        )}
      </div>

      <div className="terminal-shortcut-form-grid">
        <label className="terminal-shortcut-field">
          <span>범위</span>
          <select
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
          </select>
        </label>

        <label className="terminal-shortcut-field">
          <span>설명</span>
          <input
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            aria-label="단축키 설명"
            maxLength={160}
          />
        </label>

        <ShortcutActionEditor action={action} onChange={onActionChange} />
      </div>

      {(error || lastTestResult) && (
        <div className={error ? 'terminal-shortcut-error' : 'terminal-shortcut-toast'} role={error ? 'alert' : 'status'}>
          {error ?? lastTestResult}
        </div>
      )}

      <div className="terminal-shortcut-actions">
        <button type="button" className="terminal-shortcut-secondary-button" onClick={onStartCapture}>
          감지 시작
        </button>
        <button
          type="button"
          className="terminal-shortcut-secondary-button"
          onClick={onTestSend}
          disabled={action.type !== 'send' || saving}
        >
          테스트 전송
        </button>
        <button
          type="button"
          className="terminal-shortcut-primary-button"
          onClick={onSave}
          disabled={!capturedDescriptor || saving}
        >
          {saving ? '저장 중' : '저장'}
        </button>
        {editingLabel && onCancelEdit && (
          <button type="button" className="terminal-shortcut-secondary-button" onClick={onCancelEdit} disabled={saving}>
            취소
          </button>
        )}
      </div>
    </div>
  );
}

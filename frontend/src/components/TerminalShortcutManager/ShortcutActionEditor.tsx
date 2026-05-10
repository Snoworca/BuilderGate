import type { TerminalShortcutAction } from '../../types';
import {
  CODEX_NEWLINE_ACTION_LABEL,
  createCodexNewlineAction,
  isCodexNewlineAction,
} from '../../utils/terminalShortcutBindings';

interface ShortcutActionEditorProps {
  action: TerminalShortcutAction;
  disabled?: boolean;
  onChange: (action: TerminalShortcutAction) => void;
}

type ActionPreset = 'send-codex-newline' | 'send-lf' | 'send-cr' | 'send-tab' | 'send-esc' | 'block' | 'pass-through' | 'custom';

function getPreset(action: TerminalShortcutAction): ActionPreset {
  if (action.type === 'block') return 'block';
  if (action.type === 'pass-through') return 'pass-through';
  if (isCodexNewlineAction(action)) return 'send-codex-newline';
  if (action.data === '\n' && action.label === 'LF') return 'send-lf';
  if (action.data === '\r' && action.label === 'CR') return 'send-cr';
  if (action.data === '\t' && action.label === 'TAB') return 'send-tab';
  if (action.data === '\x1b' && action.label === 'ESC') return 'send-esc';
  return 'custom';
}

function actionFromPreset(preset: ActionPreset, current: TerminalShortcutAction): TerminalShortcutAction {
  switch (preset) {
    case 'send-codex-newline':
      return createCodexNewlineAction();
    case 'send-lf':
      return { type: 'send', data: '\n', label: 'LF' };
    case 'send-cr':
      return { type: 'send', data: '\r', label: 'CR' };
    case 'send-tab':
      return { type: 'send', data: '\t', label: 'TAB' };
    case 'send-esc':
      return { type: 'send', data: '\x1b', label: 'ESC' };
    case 'block':
      return { type: 'block' };
    case 'pass-through':
      return { type: 'pass-through' };
    case 'custom':
    default:
      return current.type === 'send' ? current : { type: 'send', data: '', label: 'CUSTOM' };
  }
}

export function ShortcutActionEditor({ action, disabled, onChange }: ShortcutActionEditorProps) {
  const preset = getPreset(action);
  const customValue = action.type === 'send' ? action.data : '';

  return (
    <div className="terminal-shortcut-action-editor">
      <label className="terminal-shortcut-field">
        <span>동작</span>
        <select
          value={preset}
          disabled={disabled}
          onChange={(event) => onChange(actionFromPreset(event.target.value as ActionPreset, action))}
          aria-label="단축키 동작"
        >
          <option value="send-codex-newline">{CODEX_NEWLINE_ACTION_LABEL}</option>
          <option value="send-lf">LF 전송</option>
          <option value="send-cr">CR 전송</option>
          <option value="send-tab">Tab 전송</option>
          <option value="send-esc">Esc 전송</option>
          <option value="block">차단</option>
          <option value="pass-through">통과</option>
          <option value="custom">사용자 문자열</option>
        </select>
      </label>
      {preset === 'custom' && (
        <label className="terminal-shortcut-field terminal-shortcut-custom-data">
          <span>문자열</span>
          <input
            value={customValue}
            disabled={disabled}
            onChange={(event) => onChange({ type: 'send', data: event.target.value, label: 'CUSTOM' })}
            aria-label="사용자 전송 문자열"
          />
        </label>
      )}
    </div>
  );
}

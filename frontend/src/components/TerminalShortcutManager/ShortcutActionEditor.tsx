import type { TerminalShortcutAction } from '../../types';
import { Field, Select, TextInput } from '../ui';
import { t } from '../../i18n/i18n.ts';
import {
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
      <Field label={t('shortcut.action.field')} htmlFor="terminal-shortcut-action" className="terminal-shortcut-field">
        <Select
          id="terminal-shortcut-action"
          value={preset}
          disabled={disabled}
          onChange={(event) => onChange(actionFromPreset(event.target.value as ActionPreset, action))}
          aria-label={t('shortcut.action.aria')}
        >
          <option value="send-codex-newline">{t('shortcut.action.codexNewline')}</option>
          <option value="send-lf">{t('shortcut.action.sendLf')}</option>
          <option value="send-cr">{t('shortcut.action.sendCr')}</option>
          <option value="send-tab">{t('shortcut.action.sendTab')}</option>
          <option value="send-esc">{t('shortcut.action.sendEsc')}</option>
          <option value="block">{t('shortcut.action.block')}</option>
          <option value="pass-through">{t('shortcut.action.passThrough')}</option>
          <option value="custom">{t('shortcut.action.custom')}</option>
        </Select>
      </Field>
      {preset === 'custom' && (
        <Field
          label={t('shortcut.action.string')}
          htmlFor="terminal-shortcut-custom-data"
          className="terminal-shortcut-field terminal-shortcut-custom-data"
        >
          <TextInput
            id="terminal-shortcut-custom-data"
            mono
            value={customValue}
            disabled={disabled}
            onChange={(event) => onChange({ type: 'send', data: event.target.value, label: 'CUSTOM' })}
            aria-label={t('shortcut.action.customStringAria')}
          />
        </Field>
      )}
    </div>
  );
}

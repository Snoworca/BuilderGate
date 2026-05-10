import type {
  TerminalShortcutAction,
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutProfile,
  TerminalShortcutScope,
} from '../../types';
import {
  CODEX_NEWLINE_ACTION_LABEL,
  createCodexNewlineAction,
  describeTerminalShortcutKey,
  isCodexNewlineAction,
  isCodexNewlineShortcutDescriptor,
} from '../../utils/terminalShortcutBindings';

export const TERMINAL_SHORTCUT_SCOPE_OPTIONS: Array<{ scope: TerminalShortcutScope; label: string }> = [
  { scope: 'workspace', label: '워크스페이스' },
  { scope: 'global', label: '전체' },
  { scope: 'session', label: '현재 세션' },
];

export const TERMINAL_SHORTCUT_PROFILE_OPTIONS: Array<{ profile: TerminalShortcutProfile; label: string }> = [
  { profile: 'xterm-default', label: 'xterm 기본' },
  { profile: 'ai-tui-compat', label: 'AI TUI 호환' },
  { profile: 'custom', label: '사용자 지정' },
];

export function profileLabel(profile: TerminalShortcutProfile): string {
  return TERMINAL_SHORTCUT_PROFILE_OPTIONS.find(option => option.profile === profile)?.label ?? profile;
}

export function scopeLabel(scope: TerminalShortcutScope): string {
  return TERMINAL_SHORTCUT_SCOPE_OPTIONS.find(option => option.scope === scope)?.label ?? scope;
}

export function bindingScopeLabel(binding: Pick<TerminalShortcutBinding, 'scope' | 'workspaceId' | 'sessionId'>): string {
  if (binding.scope === 'workspace') {
    return `${scopeLabel(binding.scope)} ${binding.workspaceId ? `(${binding.workspaceId})` : ''}`.trim();
  }
  if (binding.scope === 'session') {
    return `${scopeLabel(binding.scope)} ${binding.sessionId ? `(${binding.sessionId})` : ''}`.trim();
  }
  return scopeLabel(binding.scope);
}

export function actionLabel(action: TerminalShortcutAction): string {
  if (action.type === 'pass-through') return '통과';
  if (action.type === 'block') return '차단';
  if (isCodexNewlineAction(action)) return `${CODEX_NEWLINE_ACTION_LABEL} 전송`;
  if (action.label) return `${action.label} 전송`;
  if (action.data === '\n') return 'LF 전송';
  if (action.data === '\r') return 'CR 전송';
  if (action.data === '\t') return 'Tab 전송';
  if (action.data === '\x1b') return 'Esc 전송';
  return `문자열 ${Array.from(action.data).length}자 전송`;
}

export function descriptorLabel(descriptor: TerminalShortcutKeyDescriptor): string {
  return describeTerminalShortcutKey(descriptor);
}

export function bindingKeyLabel(binding: TerminalShortcutBinding): string {
  return descriptorLabel(binding);
}

export function isCustomControlAction(action: TerminalShortcutAction): boolean {
  if (action.type !== 'send') return false;
  if (isCodexNewlineAction(action)) return false;
  if (!containsControlCharacter(action.data)) return false;
  return !['LF', 'CR', 'TAB', 'ESC'].includes(action.label ?? '');
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

export function defaultSendAction(): TerminalShortcutAction {
  return { type: 'send', data: '\n', label: 'LF' };
}

export function defaultActionForDescriptor(descriptor: TerminalShortcutKeyDescriptor): TerminalShortcutAction {
  return isCodexNewlineShortcutDescriptor(descriptor)
    ? createCodexNewlineAction()
    : defaultSendAction();
}

export function sortBindingsForDisplay(bindings: TerminalShortcutBinding[]): TerminalShortcutBinding[] {
  const scopeOrder = new Map<TerminalShortcutScope, number>([
    ['session', 0],
    ['workspace', 1],
    ['global', 2],
  ]);

  return [...bindings].sort((a, b) => {
    const scopeDelta = (scopeOrder.get(a.scope) ?? 99) - (scopeOrder.get(b.scope) ?? 99);
    if (scopeDelta !== 0) return scopeDelta;
    const targetDelta = (a.workspaceId ?? a.sessionId ?? '').localeCompare(b.workspaceId ?? b.sessionId ?? '');
    if (targetDelta !== 0) return targetDelta;
    return a.sortOrder - b.sortOrder;
  });
}

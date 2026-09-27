import type {
  TerminalShortcutAction,
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutProfile,
  TerminalShortcutScope,
} from '../../types';
import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import {
  createCodexNewlineAction,
  describeTerminalShortcutKey,
  isCodexNewlineAction,
  isCodexNewlineShortcutDescriptor,
} from '../../utils/terminalShortcutBindings';

export const TERMINAL_SHORTCUT_SCOPE_OPTIONS: Array<{ scope: TerminalShortcutScope; labelKey: MessageKey }> = [
  { scope: 'workspace', labelKey: 'shortcut.scope.workspace' },
  { scope: 'global', labelKey: 'shortcut.scope.global' },
  { scope: 'session', labelKey: 'shortcut.scope.session' },
];

export const TERMINAL_SHORTCUT_PROFILE_OPTIONS: Array<{ profile: TerminalShortcutProfile; labelKey: MessageKey }> = [
  { profile: 'xterm-default', labelKey: 'shortcut.profile.xtermDefault' },
  { profile: 'ai-tui-compat', labelKey: 'shortcut.profile.aiTuiCompat' },
  { profile: 'custom', labelKey: 'shortcut.profile.custom' },
];

export function profileLabel(profile: TerminalShortcutProfile): string {
  const found = TERMINAL_SHORTCUT_PROFILE_OPTIONS.find(option => option.profile === profile)?.labelKey; return found ? t(found) : profile;
}

export function scopeLabel(scope: TerminalShortcutScope): string {
  const found = TERMINAL_SHORTCUT_SCOPE_OPTIONS.find(option => option.scope === scope)?.labelKey; return found ? t(found) : scope;
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
  if (action.type === 'pass-through') return t('shortcut.action.passThrough');
  if (action.type === 'block') return t('shortcut.action.block');
  if (isCodexNewlineAction(action)) return t('shortcut.action.sendCodexNewline');
  // CUSTOM is the stored tag of a user string, not a name to show.
  if (action.label === 'CUSTOM') return tn('shortcut.action.sendCustomChars', Array.from(action.data).length);
  if (action.label) return t('shortcut.action.sendLabeled', { label: action.label });
  if (action.data === '\n') return t('shortcut.action.sendLf');
  if (action.data === '\r') return t('shortcut.action.sendCr');
  if (action.data === '\t') return t('shortcut.action.sendTab');
  if (action.data === '\x1b') return t('shortcut.action.sendEsc');
  return tn('shortcut.action.sendStringChars', Array.from(action.data).length);
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

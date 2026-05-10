import type {
  TerminalShortcutAction,
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutProfile,
  TerminalShortcutState,
} from '../types';

export type TerminalShortcutResolution =
  | { kind: 'matched'; bindingId: string; action: TerminalShortcutAction; source: 'user' | 'profile' }
  | { kind: 'skipped'; reason: 'ime-active' | 'reserved' | 'repeat-disabled' | 'disabled' | 'not-loaded' }
  | { kind: 'pass-through'; reason: 'no-match' | 'action-pass-through' };

interface ResolveTerminalShortcutInput {
  event: TerminalShortcutKeyDescriptor;
  state: TerminalShortcutState | null;
  workspaceId: string | null;
  sessionId: string;
  imeActive: boolean;
  hasSelection: boolean;
}

const SCOPE_RANK = new Map([
  ['session', 0],
  ['workspace', 1],
  ['global', 2],
]);

export const CODEX_NEWLINE_SEND_DATA = '\x1b\r';
export const CODEX_NEWLINE_ACTION_LABEL = 'Codex 줄바꿈';

export function createCodexNewlineAction(): TerminalShortcutAction {
  return { type: 'send', data: CODEX_NEWLINE_SEND_DATA, label: CODEX_NEWLINE_ACTION_LABEL };
}

export function isCodexNewlineAction(action: TerminalShortcutAction): boolean {
  return action.type === 'send' && action.data === CODEX_NEWLINE_SEND_DATA;
}

export function isCodexNewlineShortcutDescriptor(descriptor: TerminalShortcutKeyDescriptor): boolean {
  const key = descriptor.key.toLowerCase();
  const code = descriptor.code.toLowerCase();
  const isShiftEnter = key === 'enter'
    && code === 'enter'
    && descriptor.shiftKey
    && !descriptor.ctrlKey
    && !descriptor.altKey
    && !descriptor.metaKey;
  const isCtrlJ = (key === 'j' || code === 'keyj')
    && descriptor.ctrlKey
    && !descriptor.shiftKey
    && !descriptor.altKey
    && !descriptor.metaKey;
  return isShiftEnter || isCtrlJ;
}

export function buildTerminalShortcutKeyDescriptor(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'location' | 'repeat'>,
): TerminalShortcutKeyDescriptor {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    location: event.location,
    repeat: event.repeat,
  };
}

export function isReservedShortcutDescriptor(descriptor: TerminalShortcutKeyDescriptor): boolean {
  if (!descriptor.ctrlKey || descriptor.altKey || descriptor.metaKey) {
    return false;
  }
  const key = descriptor.key.toLowerCase();
  const code = descriptor.code.toLowerCase();
  return key === 'c' || key === 'v' || code === 'keyc' || code === 'keyv';
}

export function getActiveTerminalShortcutProfile(
  state: TerminalShortcutState | null,
  workspaceId: string | null,
  sessionId: string,
): TerminalShortcutProfile {
  if (!state) return 'xterm-default';

  const sessionSelection = state.profileSelections.find(selection =>
    selection.scope === 'session' && selection.sessionId === sessionId);
  if (sessionSelection) return sessionSelection.profile;

  const workspaceSelection = workspaceId
    ? state.profileSelections.find(selection =>
      selection.scope === 'workspace' && selection.workspaceId === workspaceId)
    : null;
  if (workspaceSelection) return workspaceSelection.profile;

  return state.profileSelections.find(selection => selection.scope === 'global')?.profile ?? 'xterm-default';
}

export function resolveTerminalShortcut(input: ResolveTerminalShortcutInput): TerminalShortcutResolution {
  const { event, state, workspaceId, sessionId, imeActive } = input;
  if (imeActive) {
    return { kind: 'skipped', reason: 'ime-active' };
  }
  if (isReservedShortcutDescriptor(event)) {
    return { kind: 'skipped', reason: 'reserved' };
  }
  if (!state) {
    return { kind: 'skipped', reason: 'not-loaded' };
  }

  const activeProfile = getActiveTerminalShortcutProfile(state, workspaceId, sessionId);
  const matchingUserBindings = getUserBindingCandidates(state.bindings, workspaceId, sessionId, activeProfile)
    .filter(binding => matchesBinding(event, binding));
  const userBinding = matchingUserBindings[0];
  if (userBinding) {
    if (!userBinding.enabled) {
      return { kind: 'skipped', reason: 'disabled' };
    }
    if (event.repeat && !userBinding.allowRepeat) {
      return { kind: 'skipped', reason: 'repeat-disabled' };
    }
    return actionResolution(userBinding.id, userBinding.action, 'user');
  }

  const builtInBinding = getBuiltInProfileBindings(activeProfile).find(binding => matchesBinding(event, binding));
  if (builtInBinding) {
    if (event.repeat && !builtInBinding.allowRepeat) {
      return { kind: 'skipped', reason: 'repeat-disabled' };
    }
    return actionResolution(builtInBinding.id, builtInBinding.action, 'profile');
  }

  return { kind: 'pass-through', reason: 'no-match' };
}

export function getBuiltInProfileBindings(profile: TerminalShortcutProfile): TerminalShortcutBinding[] {
  if (profile !== 'ai-tui-compat') {
    return [];
  }
  const base = {
    scope: 'global' as const,
    workspaceId: undefined,
    sessionId: undefined,
    profile,
    enabled: true,
    allowRepeat: false,
    matchByKeyFallback: false,
    sortOrder: 0,
    createdAt: 'builtin',
    updatedAt: 'builtin',
  };

  return [
    {
      ...base,
      id: 'profile:ai-tui-compat:shift-enter',
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      location: 0,
      action: createCodexNewlineAction(),
      description: 'Shift+Enter -> Codex newline',
    },
    {
      ...base,
      id: 'profile:ai-tui-compat:ctrl-j',
      key: 'j',
      code: 'KeyJ',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      location: 0,
      action: createCodexNewlineAction(),
      description: 'Ctrl+J -> Codex newline',
    },
    {
      ...base,
      id: 'profile:ai-tui-compat:enter',
      key: 'Enter',
      code: 'Enter',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      location: 0,
      action: { type: 'pass-through' },
      description: 'Enter passthrough',
    },
  ];
}

export function describeTerminalShortcutKey(descriptor: TerminalShortcutKeyDescriptor): string {
  const parts: string[] = [];
  if (descriptor.ctrlKey) parts.push('Ctrl');
  if (descriptor.shiftKey) parts.push('Shift');
  if (descriptor.altKey) parts.push('Alt');
  if (descriptor.metaKey) parts.push('Meta');
  parts.push(descriptor.key === ' ' ? 'Space' : descriptor.key || descriptor.code);
  return parts.join('+');
}

function getUserBindingCandidates(
  bindings: TerminalShortcutBinding[],
  workspaceId: string | null,
  sessionId: string,
  activeProfile: TerminalShortcutProfile,
): TerminalShortcutBinding[] {
  return bindings
    .filter(binding => isBindingInActiveScope(binding, workspaceId, sessionId))
    .filter(binding => !binding.profile || binding.profile === activeProfile)
    .sort((a, b) => {
      const scopeDelta = (SCOPE_RANK.get(a.scope) ?? 99) - (SCOPE_RANK.get(b.scope) ?? 99);
      if (scopeDelta !== 0) return scopeDelta;
      return a.sortOrder - b.sortOrder;
    });
}

function isBindingInActiveScope(binding: TerminalShortcutBinding, workspaceId: string | null, sessionId: string): boolean {
  if (binding.scope === 'session') return binding.sessionId === sessionId;
  if (binding.scope === 'workspace') return Boolean(workspaceId && binding.workspaceId === workspaceId);
  return binding.scope === 'global';
}

function matchesBinding(event: TerminalShortcutKeyDescriptor, binding: TerminalShortcutBinding): boolean {
  if (!sameModifiers(event, binding)) {
    return false;
  }
  const locationMatches = event.location === binding.location;
  const exactCodeMatch = event.code === binding.code && locationMatches;
  if (exactCodeMatch) {
    return true;
  }
  return Boolean(binding.matchByKeyFallback && event.key === binding.key);
}

function sameModifiers(left: TerminalShortcutKeyDescriptor, right: TerminalShortcutKeyDescriptor): boolean {
  return left.ctrlKey === right.ctrlKey
    && left.shiftKey === right.shiftKey
    && left.altKey === right.altKey
    && left.metaKey === right.metaKey;
}

function actionResolution(
  bindingId: string,
  action: TerminalShortcutAction,
  source: 'user' | 'profile',
): TerminalShortcutResolution {
  if (action.type === 'pass-through') {
    return { kind: 'pass-through', reason: 'action-pass-through' };
  }
  return { kind: 'matched', bindingId, action, source };
}

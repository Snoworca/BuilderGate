export type TerminalShortcutScope = 'global' | 'workspace' | 'session';
export type TerminalShortcutProfile = 'xterm-default' | 'ai-tui-compat' | 'custom';

export type TerminalShortcutAction =
  | { type: 'send'; data: string; label?: string }
  | { type: 'pass-through' }
  | { type: 'block' };

export interface TerminalShortcutKeyDescriptor {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  location: number;
  repeat?: boolean;
}

export interface TerminalShortcutBinding extends TerminalShortcutKeyDescriptor {
  id: string;
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
  profile?: TerminalShortcutProfile;
  action: TerminalShortcutAction;
  enabled: boolean;
  allowRepeat: boolean;
  matchByKeyFallback: boolean;
  description?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalShortcutProfileSelection {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
  profile: TerminalShortcutProfile;
  updatedAt: string;
}

export interface TerminalShortcutState {
  version: 1;
  lastUpdated: string;
  profileSelections: TerminalShortcutProfileSelection[];
  bindings: TerminalShortcutBinding[];
}

export interface SetTerminalShortcutProfileRequest {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
  profile: TerminalShortcutProfile;
}

export interface CreateTerminalShortcutBindingRequest extends TerminalShortcutKeyDescriptor {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
  profile?: TerminalShortcutProfile;
  action: TerminalShortcutAction;
  enabled?: boolean;
  allowRepeat?: boolean;
  matchByKeyFallback?: boolean;
  description?: string;
}

export type UpdateTerminalShortcutBindingRequest = Partial<CreateTerminalShortcutBindingRequest>;

export interface ResetTerminalShortcutScopeRequest {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
}

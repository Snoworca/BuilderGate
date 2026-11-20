export type TerminalShortcutScope = 'global' | 'workspace' | 'session';
export type TerminalShortcutProfile = 'xterm-default' | 'ai-tui-compat' | 'custom';

export type TerminalShortcutAction =
  | { type: 'send'; data: string; label?: string }
  | { type: 'pass-through' }
  | { type: 'block' }
  /** REL-BGSTAB-053: the browser redraws the screen; nothing is sent to the terminal. */
  | { type: 'redraw' }
  /** FR-CMP-001 AC-3: the browser opens, focuses or closes the session composer. */
  | { type: 'toggle-composer' }
  /** FR-TODO-002 AC-2: shows or hides the to-do panel; sends nothing to the terminal. */
  | { type: 'toggle-todo' };

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

export interface SetTerminalShortcutProfileInput {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
  profile: TerminalShortcutProfile;
}

export interface CreateTerminalShortcutBindingInput extends TerminalShortcutKeyDescriptor {
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

export interface UpdateTerminalShortcutBindingInput extends Partial<CreateTerminalShortcutBindingInput> {}

export interface ResetTerminalShortcutScopeInput {
  scope: TerminalShortcutScope;
  workspaceId?: string;
  sessionId?: string;
}

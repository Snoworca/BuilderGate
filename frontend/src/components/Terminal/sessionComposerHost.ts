// What the composer needs from the app -- the terminal's paste and input paths, its focus,
// the shortcut settings -- handed down by context so the grid and the tab view do not pass
// it through every layer. Without a provider (tests, other surfaces) nothing composer-related
// renders.
// @req FR-CMP-001 FR-CMP-003

import { createContext, useContext } from 'react';
import type { TerminalShortcutState } from '../../types';
import type { TerminalClipboardActionResult } from '../../utils/terminalClipboardCoordinator.ts';
import type { ComposerMenuOptions } from '../../utils/contextMenuBuilder.ts';
import { sessionComposerStore } from './sessionComposerStore.ts';
import { decideComposerShortcut } from './sessionComposerModel.ts';

export interface SessionComposerHost {
  mobile: boolean;
  shortcutState: TerminalShortcutState | null;
  /** The terminal's paste path: sanitize, size cap, multiline guard (FR-CMP-003 AC-3). */
  pasteText: (tabId: string, text: string) => TerminalClipboardActionResult;
  /** Raw input, for the Enter after the paste. Null when the terminal is gone. */
  sendInput: (tabId: string, data: string) => { ok: boolean } | null;
  focusTerminal: (tabId: string) => void;
}

export const SessionComposerHostContext = createContext<SessionComposerHost | null>(null);

export function useSessionComposerHost(): SessionComposerHost | null {
  return useContext(SessionComposerHostContext);
}

/** Opens the composer (if closed) and puts the caret in it. */
export function openComposer(tabId: string): void {
  sessionComposerStore.setOpen(tabId, true);
  sessionComposerStore.requestFocus(tabId);
}

/** Closes the composer and gives the keys back to the terminal. */
export function closeComposer(host: SessionComposerHost, tabId: string): void {
  sessionComposerStore.setOpen(tabId, false);
  host.focusTerminal(tabId);
}

/** FR-CMP-001 AC-2: the status-row toggle and the menu entry. */
export function toggleComposer(host: SessionComposerHost, tabId: string): void {
  if (sessionComposerStore.getSession(tabId).open) closeComposer(host, tabId);
  else openComposer(tabId);
}

/** FR-CMP-001 AC-3: the toggle shortcut, pressed in the terminal or in the composer. */
export function runComposerShortcut(host: SessionComposerHost, tabId: string, composerFocused: boolean): void {
  const decision = decideComposerShortcut({ open: sessionComposerStore.getSession(tabId).open, composerFocused });
  if (decision === 'close') closeComposer(host, tabId);
  else openComposer(tabId);
}

/** FR-CMP-001 AC-4: the terminal menu entry for this session. */
export function composerMenuOption(host: SessionComposerHost, tabId: string): ComposerMenuOptions {
  return {
    open: sessionComposerStore.getSession(tabId).open,
    onToggle: () => toggleComposer(host, tabId),
  };
}

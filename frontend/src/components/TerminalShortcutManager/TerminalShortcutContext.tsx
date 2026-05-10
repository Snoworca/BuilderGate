/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useTerminalShortcuts, type UseTerminalShortcutsResult } from './useTerminalShortcuts';

export type TerminalShortcutContextValue = UseTerminalShortcutsResult;

const TerminalShortcutContext = createContext<TerminalShortcutContextValue | null>(null);

export function TerminalShortcutProvider({ children }: { children: ReactNode }) {
  const shortcuts = useTerminalShortcuts();
  return (
    <TerminalShortcutContext.Provider value={shortcuts}>
      {children}
    </TerminalShortcutContext.Provider>
  );
}

export function useTerminalShortcutContext(): TerminalShortcutContextValue {
  const value = useContext(TerminalShortcutContext);
  if (!value) {
    throw new Error('useTerminalShortcutContext must be used inside TerminalShortcutProvider');
  }
  return value;
}

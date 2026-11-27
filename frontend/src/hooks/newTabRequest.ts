// FR-ARCH-018: what the tab bar + button and the new-tab shortcut create. Without a shell pick the
// new tab takes the active tab's shell and folder; with one (the + menu) the folder carries over
// only within the same shell family. At the tab limit nothing is created (AC-4).
// @req FR-ARCH-018
import { resolveCwd } from '../utils/shell.ts';

export interface NewTabRequestInput {
  activeTab: { shellType?: string; cwd?: string } | undefined;
  tabCount: number;
  maxTabs: number;
  shell?: string;
}

export interface NewTabRequest {
  shell: string | undefined;
  cwd: string | undefined;
}

export function resolveNewTabRequest({ activeTab, tabCount, maxTabs, shell }: NewTabRequestInput): NewTabRequest | null {
  if (tabCount >= maxTabs) return null;
  if (shell) {
    return { shell, cwd: resolveCwd(shell, activeTab?.shellType, activeTab?.cwd) };
  }
  return { shell: activeTab?.shellType, cwd: activeTab?.cwd };
}

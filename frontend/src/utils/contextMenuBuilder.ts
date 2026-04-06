import { resolveCwd } from './shell';
import type { WorkspaceTabRuntime } from '../types/workspace';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { ShellInfo } from '../types';

export interface BuildTerminalMenuOptions {
  tab: WorkspaceTabRuntime | undefined;
  tabs: WorkspaceTabRuntime[];
  maxTabs: number;
  availableShells?: ShellInfo[];
  onAddTab: (cwd?: string, shell?: string) => void;
  onCloseTab: () => void;
  onCopy: () => Promise<void>;
  onPaste: () => Promise<void>;
  hasSelection: boolean;
}

export function buildTerminalContextMenuItems(
  options: BuildTerminalMenuOptions
): ContextMenuItem[] {
  const { tab, tabs, maxTabs, availableShells, onAddTab, onCloseTab, onCopy, onPaste, hasSelection } = options;

  const newSessionItem: ContextMenuItem =
    availableShells && availableShells.length > 1
      ? {
          label: '새 세션',
          icon: '+',
          disabled: tabs.length >= maxTabs,
          children: [
            {
              label: availableShells.find(s => s.id === tab?.shellType)?.label ?? tab?.shellType ?? '현재 셸',
              icon: availableShells.find(s => s.id === tab?.shellType)?.icon ?? '🖥',
              onClick: () => onAddTab(tab?.cwd, tab?.shellType),
            },
            { separator: true } as const,
            ...availableShells
              .filter(s => s.id !== tab?.shellType)
              .map(shell => ({
                label: shell.label,
                icon: shell.icon,
                onClick: () =>
                  onAddTab(
                    resolveCwd(shell.id, tab?.shellType, tab?.cwd),
                    shell.id,
                  ),
              })),
          ],
        }
      : {
          label: '새 세션',
          icon: '+',
          disabled: tabs.length >= maxTabs,
          onClick: () => onAddTab(tab?.cwd),
        };

  return [
    newSessionItem,
    {
      label: '세션 닫기',
      icon: '✕',
      destructive: true,
      onClick: onCloseTab,
    },
    { separator: true } as const,
    {
      label: '복사',
      icon: '⎘',
      disabled: !hasSelection,
      onClick: () => {
        void onCopy();
      },
    },
    {
      label: '붙여넣기',
      icon: '⎗',
      onClick: () => {
        void onPaste();
      },
    },
  ];
}

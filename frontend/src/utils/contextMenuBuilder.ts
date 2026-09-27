import { resolveCwd } from './shell.ts';
import type { WorkspaceTabRuntime } from '../types/workspace';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { CommandPreset, CommandPresetKind, ShellInfo } from '../types';
import { activeLanguage, t, type MessageKey } from '../i18n/i18n.ts';

const REGISTERED_PRESET_CATEGORY_LABELS: ReadonlyArray<{ kind: CommandPresetKind; labelKey: MessageKey }> = [
  { kind: 'command', labelKey: 'contextMenu.preset.command' },
  { kind: 'directory', labelKey: 'contextMenu.preset.directory' },
  { kind: 'prompt', labelKey: 'contextMenu.preset.prompt' },
];

export interface RegisteredPresetMenuOptions {
  presets: CommandPreset[];
  onSelectPreset: (preset: CommandPreset) => void;
}

export interface MoveWorkspaceMenuOptions {
  disabled: boolean;
  onRequest: () => void;
}

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
  registeredPresetMenu?: RegisteredPresetMenuOptions;
  moveWorkspace?: MoveWorkspaceMenuOptions;
  /**
   * Opens the file explorer for this session. Optional so that a caller which
   * does not opt in gets exactly the menu it got before -- this builder is under
   * the stable FR-ARCH-004..006 contracts.
   * @req FR-FEX-010
   */
  onOpenFileExplorer?: () => void;
}

export function buildTerminalContextMenuItems(
  options: BuildTerminalMenuOptions
): ContextMenuItem[] {
  const {
    tab,
    tabs,
    maxTabs,
    availableShells,
    onAddTab,
    onCloseTab,
    onCopy,
    onPaste,
    hasSelection,
    registeredPresetMenu,
    moveWorkspace,
    onOpenFileExplorer,
  } = options;

  const newSessionItem: ContextMenuItem =
    availableShells && availableShells.length > 1
      ? {
          label: t('contextMenu.newSession'),
          icon: 'plus',
          disabled: tabs.length >= maxTabs,
          children: [
            {
              label: availableShells.find(s => s.id === tab?.shellType)?.label ?? tab?.shellType ?? t('contextMenu.currentShell'),
              icon: availableShells.find(s => s.id === tab?.shellType)?.icon ?? '🖥',
              onClick: () => onAddTab(tab?.cwd, tab?.shellType),
            },
            { separator: true },
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
          label: t('contextMenu.newSession'),
          icon: 'plus',
          disabled: tabs.length >= maxTabs,
          onClick: () => onAddTab(tab?.cwd),
        };

  const items: ContextMenuItem[] = [
    newSessionItem,
    {
      label: t('common.closeSession'),
      icon: 'close',
      destructive: true,
      onClick: onCloseTab,
    },
    ...(moveWorkspace
      ? [
          {
            label: t('contextMenu.moveWorkspace'),
            icon: 'swap',
            disabled: moveWorkspace.disabled,
            onClick: () => {
              if (!moveWorkspace.disabled) {
                moveWorkspace.onRequest();
              }
            },
          } satisfies ContextMenuItem,
        ]
      : []),
    ...(onOpenFileExplorer
      ? [
          {
            label: t('contextMenu.openFileExplorer'),
            icon: 'folder',
            onClick: onOpenFileExplorer,
          } satisfies ContextMenuItem,
        ]
      : []),
    { separator: true },
    {
      label: t('common.copy'),
      icon: 'copy',
      disabled: !hasSelection,
      onClick: () => {
        void onCopy();
      },
    },
    {
      label: t('common.paste'),
      icon: 'clipboard',
      onClick: () => {
        void onPaste();
      },
    },
  ];

  const registeredPresetItem = registeredPresetMenu
    ? buildRegisteredPresetContextMenuItem(registeredPresetMenu)
    : null;
  if (registeredPresetItem) {
    items.push({ separator: true }, registeredPresetItem);
  }

  return items;
}

export function buildRegisteredPresetContextMenuItem(
  options: RegisteredPresetMenuOptions,
): ContextMenuItem | null {
  const categoryItems: ContextMenuItem[] = [];

  for (const category of REGISTERED_PRESET_CATEGORY_LABELS) {
    const presets = options.presets
      .filter(preset => preset.kind === category.kind)
      .sort(compareCommandPresetMenuItems);

    if (presets.length === 0) {
      continue;
    }

    categoryItems.push({
      label: t(category.labelKey),
      children: presets.map(preset => ({
        label: preset.label,
        onClick: () => options.onSelectPreset(preset),
      })),
    });
  }

  if (categoryItems.length === 0) {
    return null;
  }

  return {
    label: t('contextMenu.pastePreset'),
    icon: 'command',
    children: categoryItems,
  };
}

function compareCommandPresetMenuItems(a: CommandPreset, b: CommandPreset): number {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  return a.label.localeCompare(b.label, activeLanguage());
}

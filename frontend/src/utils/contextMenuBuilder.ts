import { resolveCwd } from './shell.ts';
import type { WorkspaceTabRuntime } from '../types/workspace';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { CommandPreset, CommandPresetKind, ShellInfo } from '../types';
import { activeLanguage, t, type MessageKey } from '../i18n/i18n.ts';
import { describeTerminalPath, fileNameOf, shortenFolder, type TerminalPathTarget } from './terminalPathDetection.ts';

// FR-ARCH-013 AC-7: the folder line under a file in the terminal menu.
const FOLDER_LABEL_MAX = 40;

function folderLabelOf(path: string, cwd: string): string {
  const { folder } = describeTerminalPath(path, cwd);
  return folder === null ? t('terminalPath.currentFolder') : shortenFolder(folder, FOLDER_LABEL_MAX);
}

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
  /**
   * File paths from the terminal output: the one near the press and those on
   * screen. Optional for the same reason as onOpenFileExplorer.
   * @req FR-ARCH-013
   */
  openPath?: TerminalMenuPathOptions;
  /**
   * Shrinks the PTY by a row and restores it so the program redraws at its real
   * size. Optional for the same reason as onOpenFileExplorer.
   * @req REL-BGSTAB-050
   */
  onRedrawScreen?: () => void;
}

export interface TerminalMenuPathOptions {
  near: TerminalPathTarget | null;
  screen: TerminalPathTarget[];
  onOpen: (target: TerminalPathTarget) => void;
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
    openPath,
    onRedrawScreen,
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
    // FR-ARCH-013 AC-3·AC-4: the files on screen, disabled when there are none.
    ...(openPath
      ? [
          {
            label: t('contextMenu.screenFiles'),
            icon: 'document',
            disabled: openPath.screen.length === 0,
            // AC-4: with no children and no action the menu would drop the entry
            // instead of showing it disabled.
            onClick: openPath.screen.length === 0 ? () => undefined : undefined,
            children: openPath.screen.map((target) => ({
              label: describeTerminalPath(target.path, tab?.cwd ?? '').name,
              description: folderLabelOf(target.path, tab?.cwd ?? ''),
              onClick: () => openPath.onOpen(target),
            } satisfies ContextMenuItem)),
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
    // REL-BGSTAB-050 AC-2: the manual repair, which phones cannot reach by middle click.
    ...(onRedrawScreen
      ? [
          {
            label: t('contextMenu.redrawScreen'),
            icon: 'refresh',
            onClick: onRedrawScreen,
          } satisfies ContextMenuItem,
        ]
      : []),
  ];

  const registeredPresetItem = registeredPresetMenu
    ? buildRegisteredPresetContextMenuItem(registeredPresetMenu)
    : null;
  if (registeredPresetItem) {
    items.push({ separator: true }, registeredPresetItem);
  }

  // FR-ARCH-013 AC-1·AC-2: the path near the press comes first, apart from the rest.
  const near = openPath?.near;
  if (openPath && near) {
    items.unshift(
      {
        label: t('contextMenu.openPath', { name: fileNameOf(near.path) }),
        description: folderLabelOf(near.path, tab?.cwd ?? ''),
        icon: 'document',
        onClick: () => openPath.onOpen(near),
      },
      { separator: true },
    );
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

import { resolveCwd } from './shell.ts';
import type { WorkspaceTabRuntime } from '../types/workspace';
import type { ContextMenuItem } from '../components/ContextMenu/ContextMenu';
import type { CommandPreset, CommandPresetKind, ShellInfo } from '../types';

const REGISTERED_PRESET_CATEGORY_LABELS: Array<{ kind: CommandPresetKind; label: string }> = [
  { kind: 'command', label: '커맨드 라인' },
  { kind: 'directory', label: '디렉토리' },
  { kind: 'prompt', label: '프롬프트' },
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
  /**
   * 애플리케이션 마우스 트래킹 모드(Claude Code 등 TUI)가 활성이면 true.
   * 이 경우 xterm 로컬 선택이 만들어지지 않아 '복사'가 무의미하고, TUI가 OSC 52 로
   * 자체 복사를 처리하므로 컨텍스트 메뉴에서 '복사' 항목을 숨긴다.
   */
  mouseTrackingActive?: boolean;
  registeredPresetMenu?: RegisteredPresetMenuOptions;
  moveWorkspace?: MoveWorkspaceMenuOptions;
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
    mouseTrackingActive,
    registeredPresetMenu,
    moveWorkspace,
  } = options;

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
          label: '새 세션',
          icon: '+',
          disabled: tabs.length >= maxTabs,
          onClick: () => onAddTab(tab?.cwd),
        };

  const items: ContextMenuItem[] = [
    newSessionItem,
    {
      label: '세션 닫기',
      icon: '✕',
      destructive: true,
      onClick: onCloseTab,
    },
    ...(moveWorkspace
      ? [
          {
            label: '워크스페이스 이동',
            icon: '⇄',
            disabled: moveWorkspace.disabled,
            onClick: () => {
              if (!moveWorkspace.disabled) {
                moveWorkspace.onRequest();
              }
            },
          } satisfies ContextMenuItem,
        ]
      : []),
    { separator: true },
    ...(mouseTrackingActive
      ? []
      : [{
          label: '복사',
          icon: '⎘',
          disabled: !hasSelection,
          onClick: () => {
            void onCopy();
          },
        } satisfies ContextMenuItem]),
    {
      label: '붙여넣기',
      icon: '⎗',
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
      label: category.label,
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
    label: '등록 항목 붙여넣기',
    children: categoryItems,
  };
}

function compareCommandPresetMenuItems(a: CommandPreset, b: CommandPreset): number {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  return a.label.localeCompare(b.label, 'ko');
}

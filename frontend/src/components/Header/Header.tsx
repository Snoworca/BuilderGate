/**
 * Header Component
 * Phase 7: Frontend Security - Logout button added
 * Phase 1-Step3: Mobile responsive - Hamburger menu added
 */

import { useMemo, useState } from 'react';
import { Icon, IconButton } from '../common';
import { ContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu/ContextMenu';
import { truncatePathLeft } from '../../utils/pathUtils';
import { SessionSaveButton, type SaveButtonState } from '../SessionSave';
import './Header.css';
import { t, tn } from '../../i18n/i18n.ts';

interface HeaderProps {
  onLogout?: () => void;
  onOpenSettings?: () => void;
  isSettingsActive?: boolean;
  isMobile?: boolean;
  onMenuClick?: () => void;
  activeWorkspaceName?: string | null;
  activeCwd?: string | null;
  viewMode?: 'tab' | 'grid';
  onToggleViewMode?: () => void;
  onOpenCommandPresetManager?: () => void;
  onOpenTerminalShortcutManager?: () => void;
  onOpenRecoveryOptionManager?: () => void;
  onOpenMcpControlManager?: () => void;
  /** The current workspace holds at least one editor window. @req FR-MDE-008 */
  hasEditorWindows?: boolean;
  /** One entry per editor window of the current workspace. @req FR-MDE-008 */
  editorTrayItems?: ContextMenuItem[];
  /**
   * How many of those windows are minimized.
   *
   * Drawn on the icon as a badge. A minimized window leaves no other trace on
   * screen, so without the count the tray says only "something is folded away"
   * and the user has to open the list to learn how much.
   * @req FR-MDE-008
   */
  /** How many documents are open, across every workspace. */
  editorTrayOpenCount?: number;
  /**
   * Opens the file explorer for the active tab, or raises it when it is
   * already open. Absent when there is no active tab, and then the button is
   * not drawn.
   * @req FR-FEX-010
   */
  onOpenFileExplorer?: () => void;
  /**
   * The session save button's face: save, saved, or resume. Absent until the
   * first status read, and then the button is not drawn.
   * @req FR-AITUI-009
   */
  sessionSaveState?: SaveButtonState;
  onSessionSave?: () => void;
}

function truncateText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 3) return value.slice(0, maxLen);
  return `${value.slice(0, maxLen - 3)}...`;
}

export function Header({
  onLogout,
  onOpenSettings,
  isSettingsActive,
  isMobile,
  onMenuClick,
  activeWorkspaceName,
  activeCwd,
  viewMode,
  onToggleViewMode,
  onOpenCommandPresetManager,
  onOpenTerminalShortcutManager,
  onOpenRecoveryOptionManager,
  onOpenMcpControlManager,
  hasEditorWindows,
  editorTrayItems,
  editorTrayOpenCount = 0,
  onOpenFileExplorer,
  sessionSaveState,
  onSessionSave,
}: HeaderProps) {
  const [toolsMenuPosition, setToolsMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [editorTrayPosition, setEditorTrayPosition] = useState<{ x: number; y: number } | null>(null);
  const displayWorkspaceName = activeWorkspaceName
    ? truncateText(activeWorkspaceName, isMobile ? 22 : 38)
    : null;
  const displayCwd = activeCwd
    ? truncatePathLeft(activeCwd, isMobile ? 24 : 48)
    : null;
  const toolsMenuItems = useMemo(() => [
    ...(onOpenCommandPresetManager ? [{
      label: t('header.tools.commandPresets'),
      onClick: () => onOpenCommandPresetManager?.(),
    }] : []),
    ...(onOpenTerminalShortcutManager ? [{
      label: t('header.tools.terminalKeyboard'),
      onClick: () => onOpenTerminalShortcutManager?.(),
    }] : []),
    ...(onOpenRecoveryOptionManager ? [{
      label: t('header.tools.recoveryOptions'),
      onClick: () => onOpenRecoveryOptionManager?.(),
    }] : []),
    ...(onOpenMcpControlManager ? [{
      label: t('header.tools.mcp'),
      onClick: () => onOpenMcpControlManager?.(),
    }] : []),
  ], [onOpenCommandPresetManager, onOpenMcpControlManager, onOpenRecoveryOptionManager, onOpenTerminalShortcutManager]);

  return (
    <header className="header">
      <div className="header-left">
        {isMobile && (
          <IconButton
            icon="menu"
            label={t('header.menu.open')}
            iconSize={20}
            className="icon-button-md hamburger-button"
            onClick={onMenuClick}
          />
        )}
        <img src="/logo.svg" alt="BuilderGate" className="header-logo" width="28" height="28" />
        <span className="header-title">BuilderGate</span>
      </div>

      {(displayWorkspaceName || displayCwd) && (
        <div className="header-center">
          {displayWorkspaceName && (
            <span className="header-center-title" title={activeWorkspaceName ?? undefined}>
              {displayWorkspaceName}
            </span>
          )}
          {displayCwd && (
            <span className="header-center-subtitle" title={activeCwd ?? undefined}>
              {displayCwd}
            </span>
          )}
        </div>
      )}

      {(onOpenSettings || onLogout || onSessionSave || onOpenCommandPresetManager || onOpenTerminalShortcutManager || onOpenRecoveryOptionManager || onOpenMcpControlManager) && (
        // Every button here is a design-system icon button (FR-UIDS-001):
        // `icon-button-md` gives the face, and `header-action-button` stays
        // because selectors outside this file find the header's buttons by it.
        <div className="header-right">
          {onOpenFileExplorer && (
            // Open or raise only. A toggle would make a second press close a
            // window the user may have just lost behind another one.
            <IconButton
              icon="folder"
              label={t('header.fileExplorer')}
              iconSize={18}
              className="icon-button-md header-action-button"
              onClick={onOpenFileExplorer}
            />
          )}
          {hasEditorWindows && (
            // A plain button rather than IconButton: the badge is a second
            // child, and IconButton's face is the glyph alone.
            <button
              type="button"
              className="icon-button icon-button-md header-action-button header-editor-tray-button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setEditorTrayPosition({ x: rect.left, y: rect.bottom + 4 });
              }}
              aria-haspopup="menu"
              aria-expanded={editorTrayPosition !== null}
              // The name stays put whatever the badge says. Folding the count
              // into it would make the button a different element to anything
              // selecting it by name, and the count is already announced by the
              // badge below.
              aria-label={t('header.editorWindows')}
              title={t('header.editorWindows')}
            >
              <Icon name="document" size={18} className="header-editor-tray-icon" />
              {editorTrayOpenCount > 0 && (
                <span
                  className="ui-badge ui-badge-accent header-editor-tray-badge"
                  role="status"
                  aria-label={tn('header.editorWindows.openCount', editorTrayOpenCount)}
                >
                  {editorTrayOpenCount}
                </span>
              )}
            </button>
          )}
          {onToggleViewMode && !isMobile && (
            // The drawing and the name say where the press goes, not where the
            // view is now.
            <IconButton
              icon={viewMode === 'tab' ? 'grid' : 'tabs'}
              label={viewMode === 'tab' ? t('header.view.toGrid') : t('header.view.toTab')}
              iconSize={18}
              className="icon-button-md header-action-button header-view-toggle-button"
              onClick={onToggleViewMode}
            />
          )}
          {sessionSaveState && onSessionSave && (
            // Between the view toggle and the tools: it acts on every AI tab,
            // not on the tab in front (FR-AITUI-009 AC-1).
            <SessionSaveButton state={sessionSaveState} onClick={onSessionSave} />
          )}
          {(onOpenCommandPresetManager || onOpenTerminalShortcutManager || onOpenRecoveryOptionManager || onOpenMcpControlManager) && !isMobile && (
            <IconButton
              icon="tools"
              label={t('header.tools')}
              iconSize={18}
              className="icon-button-md header-action-button header-tools-button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setToolsMenuPosition({ x: rect.left, y: rect.bottom + 4 });
              }}
              aria-haspopup="menu"
              aria-expanded={toolsMenuPosition !== null}
            />
          )}
          {onOpenSettings && (
            <IconButton
              icon="settings"
              label={t('header.settings')}
              iconSize={18}
              className={`icon-button-md header-action-button header-settings-button${isSettingsActive ? ' is-active' : ''}`}
              onClick={onOpenSettings}
              aria-pressed={isSettingsActive}
            />
          )}
          <IconButton
            icon="power"
            label={t('header.logout')}
            iconSize={18}
            className="icon-button-md header-action-button logout-button"
            onClick={onLogout}
          />
          {toolsMenuPosition && (
            <ContextMenu
              position={toolsMenuPosition}
              items={toolsMenuItems}
              onClose={() => setToolsMenuPosition(null)}
            />
          )}
          {editorTrayPosition && (editorTrayItems?.length ?? 0) > 0 && (
            <ContextMenu
              position={editorTrayPosition}
              items={editorTrayItems ?? []}
              onClose={() => setEditorTrayPosition(null)}
            />
          )}
        </div>
      )}
    </header>
  );
}

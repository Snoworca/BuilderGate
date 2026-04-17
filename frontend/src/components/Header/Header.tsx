/**
 * Header Component
 * Phase 7: Frontend Security - Logout button added
 * Phase 1-Step3: Mobile responsive - Hamburger menu added
 */

import { truncatePathLeft } from '../../utils/pathUtils';
import './Header.css';

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
}: HeaderProps) {
  const displayWorkspaceName = activeWorkspaceName
    ? truncateText(activeWorkspaceName, isMobile ? 22 : 38)
    : null;
  const displayCwd = activeCwd
    ? truncatePathLeft(activeCwd, isMobile ? 24 : 48)
    : null;

  return (
    <header className="header">
      <div className="header-left">
        {isMobile && (
          <button
            className="hamburger-button"
            onClick={onMenuClick}
            aria-label="Toggle sidebar menu"
          >
            <span className="hamburger-icon">
              <span />
              <span />
              <span />
            </span>
          </button>
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

      {(onOpenSettings || onLogout) && (
        <div className="header-right">
          {onToggleViewMode && !isMobile && (
            <button
              className="header-action-button"
              onClick={onToggleViewMode}
              title={viewMode === 'tab' ? 'Switch to Grid' : 'Switch to Tabs'}
            >
              {viewMode === 'tab' ? '⊞' : '☰'}
            </button>
          )}
          {onOpenSettings && (
            <button
              className={`header-action-button${isSettingsActive ? ' is-active' : ''}`}
              onClick={onOpenSettings}
              aria-pressed={isSettingsActive}
              title="Settings"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ position: 'relative', top: '2px' }}
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          )}
          <button className="logout-button" onClick={onLogout}>
            Logout
          </button>
        </div>
      )}
    </header>
  );
}

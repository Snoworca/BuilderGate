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
  activeCwd?: string | null;
  viewMode?: 'tab' | 'grid';
  onToggleViewMode?: () => void;
}

export function Header({
  onLogout,
  onOpenSettings,
  isSettingsActive,
  isMobile,
  onMenuClick,
  activeCwd,
  viewMode,
  onToggleViewMode,
}: HeaderProps) {
  const maxLen = isMobile ? 25 : 60;
  const displayCwd = activeCwd ? truncatePathLeft(activeCwd, maxLen) : null;

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
        <span className="header-logo">&#x1F4BB;</span>
        <span className="header-title">BuilderGate</span>
      </div>
      {displayCwd && (
        <div className="header-cwd" title={activeCwd ?? undefined}>
          <span className="header-cwd-path">{displayCwd}</span>
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
            >
              Settings
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

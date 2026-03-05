/**
 * Header Component
 * Phase 7: Frontend Security - Logout button added
 * Phase 1-Step3: Mobile responsive - Hamburger menu added
 */

import { truncatePathLeft } from '../../utils/pathUtils';
import './Header.css';

interface HeaderProps {
  onLogout?: () => void;
  isMobile?: boolean;
  onMenuClick?: () => void;
  activeCwd?: string | null;
}

export function Header({ onLogout, isMobile, onMenuClick, activeCwd }: HeaderProps) {
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
      {onLogout && (
        <div className="header-right">
          <button className="logout-button" onClick={onLogout}>
            Logout
          </button>
        </div>
      )}
    </header>
  );
}

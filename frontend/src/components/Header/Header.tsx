/**
 * Header Component
 * Phase 7: Frontend Security - Logout button added
 */

import './Header.css';

interface HeaderProps {
  onLogout?: () => void;
}

export function Header({ onLogout }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <span className="header-logo">&#x1F4BB;</span>
        <span className="header-title">Claude Web Shell</span>
      </div>
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

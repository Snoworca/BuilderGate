/**
 * Minimized Git windows of the active workspace, as buttons at the bottom left of
 * the stage. A click restores the window.
 *
 * @req FR-GIT-004
 */
import type { GitWindowRecord } from './gitWindowModel.ts';
import { t } from '../../i18n/i18n.ts';
import './gitViewer.css';

export interface GitWindowTrayProps {
  windows: readonly GitWindowRecord[];
  nameOf: (sessionId: string) => string;
  onRestore: (sessionId: string) => void;
}

export function GitWindowTray({ windows, nameOf, onRestore }: GitWindowTrayProps) {
  if (!windows.length) return null;
  return (
    <div className="git-tray" role="toolbar" aria-label={t('git.window.tray')}>
      {windows.map((w) => (
        <button key={w.sessionId} type="button" className="git-tray-item" onClick={() => onRestore(w.sessionId)}>
          {t('git.window.trayItem', { session: nameOf(w.sessionId) })}
        </button>
      ))}
    </div>
  );
}

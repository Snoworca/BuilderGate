import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import { useInlineRename } from '../../hooks/useInlineRename';
import { copyTextToClipboard, resolveCopyOutcome } from '../../utils/clipboardCopy';
import { recordTerminalDebugEvent } from '../../utils/terminalDebugCapture';

interface Props {
  tab: WorkspaceTabRuntime;
  onRename?: (name: string) => void;
  /** Right click on the cwd path. Both render sites pass it. @req FR-MDE-007 */
  onPathContextMenu?: (x: number, y: number) => void;
}

function formatElapsed(createdAt: string): string {
  const elapsed = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
  if (elapsed < 0) return '00:00';
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/** Truncate absolute path if it would exceed ~30% of status bar width.
 *  Heuristic: status bar ≈ 50 chars at 12px mono. 30% ≈ 15 chars budget.
 *  Subtract name (~10) + elapsed (~8) + padding → path budget ≈ 30 chars.
 */
function truncatePath(cwd: string, maxChars = 30): string {
  if (cwd.length <= maxChars) return cwd;
  // Find last separator
  const sep = cwd.includes('/') ? '/' : '\\';
  const lastSep = cwd.lastIndexOf(sep);
  if (lastSep <= 0) return cwd;
  const tail = cwd.slice(lastSep);
  if (tail.length >= maxChars - 4) return '...' + tail.slice(-(maxChars - 3));
  return '...' + tail;
}

function getSafeRecoveryIconLabel(recoveryIcon: WorkspaceTabRuntime['recoveryIcon']): string | null {
  if (recoveryIcon?.type === 'builtin') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  if (recoveryIcon?.type === 'text' && typeof recoveryIcon.value === 'string') {
    return getRecoveryIconLabel(recoveryIcon);
  }
  // Unsupported persisted icons are omitted.
  return null;
}

export function MetadataRow({ tab, onRename, onPathContextMenu }: Props) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(tab.createdAt));
  const [copyAttempt, setCopyAttempt] = useState<{ ok: boolean } | null>(null);

  const rename = useInlineRename({ onRename: onRename ?? (() => {}) });

  useEffect(() => {
    const timer = setInterval(() => setElapsed(formatElapsed(tab.createdAt)), 1000);
    return () => clearInterval(timer);
  }, [tab.createdAt]);

  // Issue #83: a copy that did not happen must not be indistinguishable from one
  // that did. The previous bare catch left no trace anywhere, so the badge simply
  // never appeared - which is also what the user sees before clicking - and they
  // pasted the clipboard's previous contents believing it had worked.
  const handleCopy = useCallback(async () => {
    if (!tab.cwd) return;
    try {
      await copyTextToClipboard(tab.cwd);
      setCopyAttempt({ ok: true });
    } catch (error) {
      setCopyAttempt({ ok: false });
      recordTerminalDebugEvent(tab.sessionId, 'metadata_cwd_copy_failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    setTimeout(() => setCopyAttempt(null), 1500);
  }, [tab.cwd, tab.sessionId]);

  const copyOutcome = resolveCopyOutcome(copyAttempt);

  // The tile root and the tab wrapper both open the terminal menu on a right
  // click, so the press is stopped here or two menus answer it.
  // @req FR-MDE-007
  const handlePathContextMenu = useCallback((event: ReactMouseEvent) => {
    if (!onPathContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onPathContextMenu(event.clientX, event.clientY);
  }, [onPathContextMenu]);

  const displayPath = useMemo(() => {
    if (!tab.cwd) return '';
    return truncatePath(tab.cwd);
  }, [tab.cwd]);

  const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];
  const recoveryIconLabel = getSafeRecoveryIconLabel(tab.recoveryIcon);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: '28px',
      backgroundColor: '#2a2a2a',
      fontSize: '13px',
      padding: '0 8px 0 0',
    }}>
      {/* Color label */}
      <div style={{
        width: '4px',
        height: '100%',
        backgroundColor: color,
        flexShrink: 0,
      }} />

      {/* Session name — 더블클릭 시 인라인 편집 */}
      {recoveryIconLabel && (
        <span
          title={tab.recoveryCommand ? `Recovery: ${tab.recoveryCommand}` : 'Recovery'}
          style={{
            color: '#d7d7d7',
            marginLeft: '8px',
            fontSize: '11px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {recoveryIconLabel}
        </span>
      )}
      {rename.isEditing ? (
        <input
          ref={rename.inputRef}
          value={rename.editName}
          maxLength={32}
          onChange={rename.handleChange}
          onKeyDown={rename.handleKeyDown}
          onBlur={rename.handleBlur}
          style={{
            color: '#fff',
            marginLeft: recoveryIconLabel ? '4px' : '8px',
            background: 'transparent',
            border: '1px solid #555',
            borderRadius: '2px',
            fontSize: '13px',
            width: '120px',
            flexShrink: 0,
            padding: '0 2px',
          }}
        />
      ) : (
        <span
          onDoubleClick={onRename ? () => rename.startEdit(tab.name) : undefined}
          style={{
            color: '#fff',
            marginLeft: recoveryIconLabel ? '4px' : '8px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '150px',
            flexShrink: 0,
            cursor: onRename ? 'text' : 'default',
          }}
        >
          {tab.name}
        </span>
      )}

      {/* CWD path — click to copy */}
      {displayPath && (
        <span
          className="metadata-cwd-path"
          onClick={handleCopy}
          onContextMenu={handlePathContextMenu}
          title={copyOutcome === 'copied' ? 'Copied!' : copyOutcome === 'failed' ? 'Copy failed' : (tab.cwd || '')}
          style={{
            color: copyOutcome === 'copied' ? '#22c55e' : copyOutcome === 'failed' ? '#ef4444' : '#e0e0e0',
            marginLeft: 'auto',
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
            fontSize: '12px',
            textDecorationLine: 'underline',
            textDecorationColor: '#666',
            textDecorationStyle: 'solid' as const,
            textUnderlineOffset: '3px',
            letterSpacing: '0.5px',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {copyOutcome === 'copied' ? '✓ Copied' : copyOutcome === 'failed' ? '✗ Copy failed' : displayPath}
        </span>
      )}

      {/* Separator */}
      {displayPath && (
        <span style={{
          color: '#555',
          margin: '0 3px',
          flexShrink: 0,
          fontSize: '16px',
          lineHeight: '1',
          position: 'relative',
          top: '-1px',
        }}>│</span>
      )}

      {/* Elapsed time */}
      <span style={{
        color: '#e0e0e0',
        marginLeft: displayPath ? '0' : 'auto',
        fontFamily: 'monospace',
        fontSize: '12px',
        flexShrink: 0,
      }}>
        {elapsed}
      </span>
    </div>
  );
}

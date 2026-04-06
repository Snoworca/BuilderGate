import { useState, useEffect, useCallback, useMemo } from 'react';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { useInlineRename } from '../../hooks/useInlineRename';

interface Props {
  tab: WorkspaceTabRuntime;
  isOdd: boolean;
  onRename?: (name: string) => void;
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

export function MetadataRow({ tab, isOdd, onRename }: Props) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(tab.createdAt));
  const [copied, setCopied] = useState(false);

  const rename = useInlineRename({ onRename: onRename ?? (() => {}) });

  useEffect(() => {
    const timer = setInterval(() => setElapsed(formatElapsed(tab.createdAt)), 1000);
    return () => clearInterval(timer);
  }, [tab.createdAt]);

  const handleCopy = useCallback(async () => {
    if (!tab.cwd) return;
    try {
      await navigator.clipboard.writeText(tab.cwd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard API failure */ }
  }, [tab.cwd]);

  const displayPath = useMemo(() => {
    if (!tab.cwd) return '';
    return truncatePath(tab.cwd);
  }, [tab.cwd]);

  const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];

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
            marginLeft: '8px',
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
            marginLeft: '8px',
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
          onClick={handleCopy}
          title={copied ? 'Copied!' : (tab.cwd || '')}
          style={{
            color: copied ? '#22c55e' : '#e0e0e0',
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
          {copied ? '✓ Copied' : displayPath}
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

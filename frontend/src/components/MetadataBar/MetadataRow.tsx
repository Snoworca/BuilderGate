import { useState, useEffect, useCallback } from 'react';
import { TAB_COLORS } from '../../types/workspace';
import type { WorkspaceTabRuntime } from '../../types/workspace';

interface Props {
  tab: WorkspaceTabRuntime;
  isOdd: boolean;
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

export function MetadataRow({ tab, isOdd }: Props) {
  const [elapsed, setElapsed] = useState(() => formatElapsed(tab.createdAt));
  const [copied, setCopied] = useState(false);

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

  const color = TAB_COLORS[tab.colorIndex] || TAB_COLORS[0];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: '24px',
      backgroundColor: '#2a2a2a',
      fontSize: '12px',
      padding: '0 8px 0 0',
    }}>
      {/* Color label */}
      <div style={{
        width: '4px',
        height: '100%',
        backgroundColor: color,
        flexShrink: 0,
      }} />

      {/* Session name */}
      <span style={{
        color: '#fff',
        marginLeft: '8px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '150px',
        flex: 1,
      }}>
        {tab.name}
      </span>

      {/* Elapsed time — pushed to right end */}
      <span style={{
        color: '#888',
        marginLeft: 'auto',
        marginRight: '8px',
        fontFamily: 'monospace',
        fontSize: '11px',
        flexShrink: 0,
      }}>
        {elapsed}
      </span>

      {/* CWD copy button */}
      <button
        onClick={handleCopy}
        disabled={!tab.cwd}
        title={tab.cwd || 'Loading...'}
        style={{
          background: 'none',
          border: 'none',
          color: copied ? '#22c55e' : '#888',
          cursor: tab.cwd ? 'pointer' : 'default',
          fontSize: '13px',
          padding: '0 2px',
          flexShrink: 0,
        }}
      >
        {copied ? '✓' : '📋'}
      </button>
    </div>
  );
}

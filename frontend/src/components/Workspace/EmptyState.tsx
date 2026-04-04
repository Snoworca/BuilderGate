import { useState, useCallback } from 'react';
import { useLongPress } from '../../hooks/useLongPress';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ShellInfo } from '../../types';

interface Props {
  onAddTab: (shell?: string) => void;
  availableShells?: ShellInfo[];
}

export function EmptyState({ onAddTab, availableShells }: Props) {
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [shellMenuPosition, setShellMenuPosition] = useState({ x: 0, y: 0 });

  const longPress = useLongPress(
    useCallback((e: { clientX: number; clientY: number }) => {
      if (!availableShells || availableShells.length <= 1) return;
      setShellMenuPosition({ x: e.clientX, y: e.clientY });
      setShellMenuOpen(true);
    }, [availableShells]),
    500,
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: '16px',
      color: '#888',
    }}>
      <span style={{ fontSize: '48px' }}>⌨</span>
      <span style={{ fontSize: '16px' }}>터미널을 추가하세요</span>
      <button
        onClick={() => {
          if (longPress.wasLongPress()) return;
          onAddTab();
        }}
        onPointerDown={longPress.onPointerDown}
        onPointerUp={longPress.onPointerUp}
        onPointerMove={longPress.onPointerMove}
        style={{
          backgroundColor: '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          padding: '8px 20px',
          cursor: 'pointer',
          fontSize: '14px',
        }}
      >
        + Add Terminal
      </button>

      {shellMenuOpen && availableShells && (
        <ContextMenu
          position={shellMenuPosition}
          onClose={() => setShellMenuOpen(false)}
          items={availableShells.map(shell => ({
            label: shell.label,
            icon: shell.icon,
            onClick: () => { onAddTab(shell.id); setShellMenuOpen(false); },
          }))}
        />
      )}
    </div>
  );
}

import { useState, useCallback } from 'react';
import { useLongPress } from '../../hooks/useLongPress';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import type { ShellInfo } from '../../types';

interface Props {
  onAdd: (shell?: string) => void;
  availableShells?: ShellInfo[];
}

export function EmptyCell({ onAdd, availableShells }: Props) {
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
    <div
      onClick={() => {
        if (longPress.wasLongPress()) return;
        onAdd();
      }}
      onPointerDown={longPress.onPointerDown}
      onPointerUp={longPress.onPointerUp}
      onPointerMove={longPress.onPointerMove}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a1a',
        border: '1px dashed #333',
        cursor: 'pointer',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ fontSize: '24px', color: '#555' }}>+</span>

      {shellMenuOpen && availableShells && (
        <ContextMenu
          position={shellMenuPosition}
          onClose={() => setShellMenuOpen(false)}
          items={availableShells.map(shell => ({
            label: shell.label,
            icon: shell.icon,
            onClick: () => { onAdd(shell.id); setShellMenuOpen(false); },
          }))}
        />
      )}
    </div>
  );
}

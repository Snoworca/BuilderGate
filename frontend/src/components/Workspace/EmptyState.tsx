import { useState, useCallback } from 'react';
import { useLongPress } from '../../hooks/useLongPress';
import { ContextMenu } from '../ContextMenu/ContextMenu';
import { Icon } from '../common';
import { Button } from '../ui';
import type { ShellInfo } from '../../types';
import './Workspace.css';
import { t } from '../../i18n/i18n.ts';

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
    <div className="workspace-empty-state">
      <Icon name="terminal" size={40} className="workspace-empty-state-icon" />
      <span className="workspace-empty-state-text">{t('workspace.empty.prompt')}</span>
      <Button
        variant="primary"
        icon="plus"
        onClick={() => {
          if (longPress.wasLongPress()) return;
          onAddTab();
        }}
        onPointerDown={longPress.onPointerDown}
        onPointerUp={longPress.onPointerUp}
        onPointerMove={longPress.onPointerMove}
      >
        {t('common.addTerminal')}
      </Button>

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

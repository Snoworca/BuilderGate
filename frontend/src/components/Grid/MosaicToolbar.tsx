import { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { MosaicWindowContext } from 'react-mosaic-component';
import type { LayoutMode } from '../../hooks/useMosaicLayout';
import type { EqualLayoutPreset } from '../../hooks/mosaicLayoutStorage';
import { Icon, IconButton, type IconName } from '../common';
import './MosaicToolbar.css';
import { t } from '../../i18n/i18n.ts';

interface MosaicToolbarProps {
  layoutMode: LayoutMode;
  equalPreset: EqualLayoutPreset;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onColumnsLayout: () => void;
}

interface ToolbarButtonProps {
  mode?: Exclude<LayoutMode, 'none'>;
  command?: string;
  icon: IconName;
  /** What the button does. Becomes both the accessible name and the tooltip. */
  label: string;
  active: boolean;
  onClick: () => void;
}

function ToolbarButton({ mode, command, icon, label, active, onClick }: ToolbarButtonProps) {
  return (
    <IconButton
      icon={icon}
      label={label}
      iconSize={16}
      data-layout-mode-button={mode}
      data-layout-command={command}
      aria-pressed={active}
      onClick={onClick}
      draggable={false}
      className={`mosaic-toolbar-control mosaic-toolbar-button${active ? ' is-active' : ''}`}
    />
  );
}

export function MosaicToolbar({
  layoutMode,
  equalPreset,
  onLayoutModeChange,
  onColumnsLayout,
}: MosaicToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mosaicWindowContext = useContext(MosaicWindowContext);
  const connectDragSource = mosaicWindowContext?.mosaicWindowActions?.connectDragSource;
  const controlsVisible = expanded;

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      setExpanded(false);
    }, 300);
  }, [clearHideTimer]);

  const handleMouseEnter = useCallback(() => {
    clearHideTimer();
    setExpanded(true);
  }, [clearHideTimer]);

  const handleMouseLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  useEffect(() => {
    return () => clearHideTimer();
  }, [clearHideTimer]);

  const moveButtonShell = (
    <div
      data-grid-drag-handle="true"
      data-grid-move-button="true"
      title={t('grid.toolbar.dragToMove')}
      className={`mosaic-toolbar-control mosaic-toolbar-move${controlsVisible ? ' is-visible' : ''}`}
    >
      <Icon name="move" size={16} />
    </div>
  );

  const moveButton = connectDragSource ? connectDragSource(moveButtonShell) : moveButtonShell;

  return (
    <div
      data-grid-toolbar="true"
      className="mosaic-toolbar"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {moveButton}

      {expanded && (
        <div
          data-grid-mode-controls="true"
          draggable={false}
          className="mosaic-toolbar-modes"
        >
          <ToolbarButton
            mode="equal"
            icon="grid"
            label={t('grid.toolbar.equal')}
            active={layoutMode === 'equal' && equalPreset !== 'columns'}
            onClick={() => onLayoutModeChange('equal')}
          />
          <ToolbarButton
            command="columns"
            icon="columns"
            label={t('grid.toolbar.vertical')}
            active={layoutMode === 'equal' && equalPreset === 'columns'}
            onClick={onColumnsLayout}
          />
          <ToolbarButton
            mode="focus"
            icon="maximize"
            label={t('grid.toolbar.focus')}
            active={layoutMode === 'focus'}
            onClick={() => onLayoutModeChange('focus')}
          />
          <ToolbarButton
            mode="auto"
            icon="refresh"
            label={t('grid.toolbar.auto')}
            active={layoutMode === 'auto'}
            onClick={() => onLayoutModeChange('auto')}
          />
        </div>
      )}
    </div>
  );
}

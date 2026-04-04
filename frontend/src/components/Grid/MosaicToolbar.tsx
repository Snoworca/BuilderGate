import { useState, useRef, useCallback, useEffect, useContext } from 'react';
import { MosaicWindowContext } from 'react-mosaic-component';
import type { LayoutMode } from '../../hooks/useMosaicLayout';

interface MosaicToolbarProps {
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
}

interface ToolbarButtonProps {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}

function ToolbarButton({ label, title, active, onClick }: ToolbarButtonProps) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: '28px',
        height: '28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'rgba(80,160,255,0.8)' : 'rgba(60,60,60,0.85)',
        border: active ? '1px solid rgba(120,180,255,0.6)' : '1px solid transparent',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '16px',
        color: active ? '#fff' : 'rgba(255,255,255,0.5)',
        padding: 0,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

export function MosaicToolbar({ layoutMode, onLayoutModeChange }: MosaicToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // FR-1.2: connectDragSource from MosaicWindowContext for grip icon
  const mosaicWindowContext = useContext(MosaicWindowContext);
  const connectDragSource = mosaicWindowContext?.mosaicWindowActions?.connectDragSource;

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

  // Grip icon element — drag handle for tile DnD (hidden by default, visible on hover)
  const gripDiv = (
    <div
      style={{
        width: '28px',
        height: '28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        color: 'rgba(255,255,255,0.8)',
        fontSize: '16px',
        flexShrink: 0,
        backgroundColor: 'rgba(60,60,60,0.85)',
        borderRadius: '4px',
        opacity: expanded ? 1 : 0,
        transition: 'opacity 0.2s ease',
      }}
      title="드래그하여 타일 이동"
    >
      <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
        <polygon points="10,2 7,7 13,7" />
        <polygon points="10,18 7,13 13,13" />
        <polygon points="2,10 7,7 7,13" />
        <polygon points="18,10 13,7 13,13" />
        <rect x="9" y="7" width="2" height="6" />
        <rect x="7" y="9" width="6" height="2" />
      </svg>
    </div>
  );
  // connectDragSource may be undefined outside MosaicWindowContext (e.g. unit tests)
  const gripIcon = connectDragSource ? connectDragSource(gripDiv) : gripDiv;

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        left: 4,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Grip icon — always visible, serves as drag handle */}
      {gripIcon}

      {/* Toolbar panel — visible on hover */}
      {expanded && (
        <div
          draggable={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <ToolbarButton
            label="⊞"
            title="균등 분할 (Equal)"
            active={layoutMode === 'equal'}
            onClick={() => onLayoutModeChange('equal')}
          />
          <ToolbarButton
            label="⊡"
            title="포커스 모드 (Focus)"
            active={layoutMode === 'focus'}
            onClick={() => onLayoutModeChange('focus')}
          />
          <ToolbarButton
            label="⟳"
            title="자동 모드 (Auto)"
            active={layoutMode === 'auto'}
            onClick={() => onLayoutModeChange('auto')}
          />
        </div>
      )}
    </div>
  );
}

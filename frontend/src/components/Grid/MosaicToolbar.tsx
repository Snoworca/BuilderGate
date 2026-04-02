import { useState, useRef, useCallback, useEffect } from 'react';
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
        width: '24px',
        height: '24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'rgba(255,255,255,0.25)' : 'transparent',
        border: 'none',
        borderRadius: '4px',
        cursor: 'pointer',
        fontSize: '14px',
        color: active ? '#fff' : 'rgba(255,255,255,0.7)',
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
      {/* Trigger zone — always visible as tiny dot */}
      <div
        style={{
          width: '24px',
          height: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '4px',
          backgroundColor: expanded ? 'transparent' : 'rgba(128,128,128,0.3)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {!expanded && (
          <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', lineHeight: 1 }}>⋯</span>
        )}
      </div>

      {/* Toolbar panel — visible on hover */}
      {expanded && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            backgroundColor: 'rgba(128,128,128,0.4)',
            borderRadius: '6px',
            padding: '2px',
            backdropFilter: 'blur(4px)',
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

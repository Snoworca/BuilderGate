// ============================================================================
// BuilderGate Pane Split System - PaneIndicator (Phase 4: Mobile)
// Dot indicator + position text for mobile carousel.
// ============================================================================

import React from 'react';

interface PaneIndicatorProps {
  total: number;
  current: number; // 0-based
  onDotClick: (index: number) => void;
}

export const PaneIndicator: React.FC<PaneIndicatorProps> = ({
  total,
  current,
  onDotClick,
}) => {
  return (
    <>
      <div className="pane-indicator-dots">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            className={`pane-indicator-dot${i === current ? ' active' : ''}`}
            onClick={() => onDotClick(i)}
            aria-label={`Pane ${i + 1}`}
          />
        ))}
      </div>
      <div className="pane-indicator-position">
        [{current + 1}/{total}]
      </div>
    </>
  );
};

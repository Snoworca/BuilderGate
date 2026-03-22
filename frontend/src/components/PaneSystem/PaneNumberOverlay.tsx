import React from 'react';

interface PaneNumberOverlayProps {
  number: number;
  visible: boolean;
}

export function PaneNumberOverlay({ number, visible }: PaneNumberOverlayProps) {
  if (!visible) return null;
  return (
    <div className="pane-number-overlay">
      <span>{number}</span>
    </div>
  );
}

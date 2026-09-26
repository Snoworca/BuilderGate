// A rich tooltip for controls whose effect needs a sentence (FR-UIDS-002 AC-5).
// Shown on hover and on keyboard focus inside the anchor. Plain icon buttons
// keep the native title from IconButton instead.
import type { ReactNode } from 'react';

export interface TooltipProps {
  title?: ReactNode;
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({ title, content, children }: TooltipProps) {
  return (
    <span className="ui-tooltip-anchor">
      {children}
      <span className="ui-tooltip" role="tooltip">
        {title !== undefined && <span className="ui-tooltip-title">{title}</span>}
        {content}
      </span>
    </span>
  );
}

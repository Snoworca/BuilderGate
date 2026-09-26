// A labelled progress bar (FR-UIDS-002 AC-5).
import type { ReactNode } from 'react';
import { joinClassNames } from './uiClasses.ts';

export interface ProgressBarProps {
  label: ReactNode;
  value: number;
  max: number;
  tone?: 'accent' | 'ok';
}

export function ProgressBar({ label, value, max, tone = 'accent' }: ProgressBarProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="ui-progress">
      <div className="ui-progress-top">
        <span className="ui-progress-label">{label}</span>
        <span className="ui-progress-count">{value} / {max}</span>
      </div>
      <div
        className="ui-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div
          className={joinClassNames('ui-progress-fill', tone === 'ok' && 'ui-progress-fill-ok')}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** `on-fill` draws the arc in the text colour, for a filled button (FR-UIDS-006). */
export function Spinner({ label, tone = 'default' }: { label?: string; tone?: 'default' | 'on-fill' }) {
  return (
    <span
      className={joinClassNames('ui-spinner', tone === 'on-fill' && 'ui-spinner-on-fill')}
      role={label ? 'status' : undefined}
      aria-label={label}
    />
  );
}

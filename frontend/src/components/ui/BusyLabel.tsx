// A button label that swaps to a spinner and a progress label without changing
// the button's width: both labels share one grid cell and the unused one is
// hidden, so the width is the wider of the two (FR-UIDS-006 AC-6). A hidden
// label leaves the accessibility tree, so the button's name is the visible one.
import type { ReactNode } from 'react';
import { Spinner } from './ProgressBar.tsx';

export interface BusyLabelProps {
  busy: boolean;
  label: ReactNode;
  busyLabel: ReactNode;
  spinnerTone?: 'default' | 'on-fill';
}

export function BusyLabel({ busy, label, busyLabel, spinnerTone = 'default' }: BusyLabelProps) {
  return (
    <span className="ui-busy-label" data-busy={busy ? 'true' : 'false'}>
      <span className="ui-busy-label-idle">{label}</span>
      <span className="ui-busy-label-busy">
        <Spinner tone={spinnerTone} />
        {busyLabel}
      </span>
    </span>
  );
}

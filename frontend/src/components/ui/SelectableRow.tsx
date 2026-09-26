// A row that is one checkbox (FR-UIDS-002 AC-4): the whole row is the target.
// Before a choice is made it shows the box; afterwards the caller may put a
// status mark in its place.
import type { ReactNode } from 'react';
import { joinClassNames } from './uiClasses.ts';

export interface SelectableRowProps {
  name: ReactNode;
  /** Accessible name of the checkbox. */
  checkboxLabel: string;
  checked?: boolean;
  onToggle?: (checked: boolean) => void;
  /** Replaces the checkbox, e.g. with a status mark once the work has run. */
  control?: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  highlighted?: boolean;
  className?: string;
}

export function SelectableRow({
  name,
  checkboxLabel,
  checked = false,
  onToggle,
  control,
  badges,
  meta,
  trailing,
  highlighted,
  className,
}: SelectableRowProps) {
  const selected = highlighted ?? checked;
  return (
    <label className={joinClassNames('ui-row', selected && 'is-selected', className)}>
      <span className="ui-row-control">
        {control ?? (
          <input
            type="checkbox"
            checked={checked}
            aria-label={checkboxLabel}
            onChange={(event) => onToggle?.(event.target.checked)}
          />
        )}
      </span>
      <span className="ui-row-main">
        <span className="ui-row-title">
          <span className="ui-row-name">{name}</span>
          {badges}
        </span>
        {meta !== undefined && <span className="ui-row-meta">{meta}</span>}
      </span>
      {trailing !== undefined && <span className="ui-row-trailing">{trailing}</span>}
    </label>
  );
}

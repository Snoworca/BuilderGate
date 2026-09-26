// Chips and badges (FR-UIDS-002 AC-2). A tone never travels alone: the chip
// carries words, and an icon where one helps (NFR-UIDS-001 AC-4).
import type { ReactNode } from 'react';
import { Icon } from '../common/Icon.tsx';
import type { IconName } from '../common/iconGlyphs.ts';
import { chipClassName, joinClassNames, type ChipTone } from './uiClasses.ts';

export interface ChipProps {
  tone?: ChipTone;
  icon?: IconName;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Chip({ tone = 'neutral', icon, className, title, children }: ChipProps) {
  return (
    <span className={chipClassName(tone, className)} title={title}>
      {icon !== undefined && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export interface BadgeProps {
  count: number;
  tone?: 'neutral' | 'accent';
  className?: string;
  label?: string;
}

export function Badge({ count, tone = 'neutral', className, label }: BadgeProps) {
  return (
    <span
      className={joinClassNames('ui-badge', tone === 'accent' && 'ui-badge-accent', className)}
      aria-label={label}
    >
      {count}
    </span>
  );
}

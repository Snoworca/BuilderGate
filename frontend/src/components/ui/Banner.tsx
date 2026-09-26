// A banner that informs without blocking (FR-UIDS-002 AC-5): a primary action
// and a way to put it off.
import type { ReactNode } from 'react';
import { Icon } from '../common/Icon.tsx';
import type { IconName } from '../common/iconGlyphs.ts';
import { joinClassNames } from './uiClasses.ts';

export interface BannerProps {
  tone?: 'info' | 'warn';
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function Banner({ tone = 'info', icon, title, description, actions, className }: BannerProps) {
  return (
    <div className={joinClassNames('ui-banner', `ui-banner-${tone}`, className)} role="status">
      {icon !== undefined && (
        <span className="ui-banner-icon"><Icon name={icon} size={18} /></span>
      )}
      <span className="ui-banner-text">
        <span className="ui-banner-title">{title}</span>
        {description !== undefined && <span className="ui-banner-description">{description}</span>}
      </span>
      {actions !== undefined && <span className="ui-banner-actions">{actions}</span>}
    </div>
  );
}

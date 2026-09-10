// A button whose whole face is one drawn glyph.
//
// The label is required rather than optional: a control with nothing but a
// drawing on it is unreachable by a screen reader and unexplained on hover, and
// the letters this component replaced were at least readable. Passing it once
// serves both `aria-label` and `title`, so the two cannot disagree.

import type { ButtonHTMLAttributes } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './iconGlyphs.ts';
import './IconButton.css';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'title'> {
  icon: IconName;
  /** What the button does. Becomes both the accessible name and the tooltip. */
  label: string;
  iconSize?: number;
}

export function IconButton({
  icon,
  label,
  iconSize,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={['icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}

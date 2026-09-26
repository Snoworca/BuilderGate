// The shared button (FR-UIDS-002 AC-1): four variants, three sizes.
// Copy on it says what happens when it is pressed (FR-UIDS-003 AC-2).
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from '../common/Icon.tsx';
import type { IconName } from '../common/iconGlyphs.ts';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './uiClasses.ts';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'lg',
  icon,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button {...rest} type={type} className={buttonClassName(variant, size, className)}>
      {icon !== undefined && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

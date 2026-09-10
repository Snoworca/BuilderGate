// A two-state icon button: one control that draws where it is and offers the
// way back.
//
// Two plain buttons would have said the same thing with twice the width and no
// statement of state at all -- which of the two applied right now would have
// been left to the user to work out from the window.
//
// The accessible name is one string and does not change with the state. That is
// the ARIA toggle-button convention: `aria-pressed` is what carries the state,
// and a name that changed underneath it would say the state twice and let the
// two spellings disagree. What changes is the drawing, decided by
// `resolveToggleIcon` so that the rule lives in a value this component applies
// rather than in a branch buried in markup.

import { IconButton, type IconButtonProps } from './IconButton.tsx';
import { resolveToggleIcon, type ToggleIconPair } from './iconGlyphs.ts';

export interface IconToggleButtonProps
  extends Omit<IconButtonProps, 'icon' | 'onClick' | 'aria-pressed'> {
  /** The state the control is in now. */
  pressed: boolean;
  icons: ToggleIconPair;
  onToggle: () => void;
}

export function IconToggleButton({
  pressed,
  icons,
  onToggle,
  className,
  ...rest
}: IconToggleButtonProps) {
  return (
    <IconButton
      {...rest}
      icon={resolveToggleIcon(pressed, icons)}
      className={['icon-toggle-button', pressed ? 'is-pressed' : '', className]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={pressed}
      onClick={onToggle}
    />
  );
}

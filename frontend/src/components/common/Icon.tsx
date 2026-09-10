// The one element that turns a glyph name into a drawing.
//
// Every icon in the application goes through here, so stroke weight, join and
// cap are decided once. A second component drawing its own <svg> would drift on
// exactly those three and nobody would be able to say which of the two was
// wrong.

import { ICON_GLYPHS, type IconName } from './iconGlyphs.ts';

export interface IconProps {
  name: IconName;
  /** Edge length in pixels. The glyphs are authored on a 24x24 grid. */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The button around it carries the label, so the drawing itself is
      // announced as decoration rather than read out a second time.
      aria-hidden="true"
      focusable="false"
    >
      {ICON_GLYPHS[name].paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

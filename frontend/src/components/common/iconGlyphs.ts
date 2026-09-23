// The one vocabulary of drawn icons the application shares.
//
// The glyphs are path data rather than components so that what an icon *is*
// stays a value: a button can be judged on which glyph it names without a DOM,
// and two call sites naming the same glyph cannot drift into two drawings.
//
// Every path is authored on the same 24x24 grid and is stroked with
// `currentColor`, which is what the header's existing icons already do -- a
// filled glyph among them would read as a different weight of control.

export type IconName =
  | 'save'
  | 'terminal'
  | 'maximize'
  | 'restore'
  | 'minimize'
  | 'document'
  | 'close';

export interface IconGlyph {
  /** SVG path data on the 24x24 viewBox, drawn in order. */
  readonly paths: readonly string[];
}

export const ICON_GLYPHS: Record<IconName, IconGlyph> = {
  // A floppy disk: the outline with its clipped corner, the label plate and the
  // shutter. Still the least ambiguous drawing of "write this to storage".
  save: {
    paths: [
      'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
      'M17 21v-8H7v8',
      'M7 3v5h8',
    ],
  },
  // A shell prompt: the caret and the cursor rule.
  terminal: {
    paths: [
      'M4 17l6-5-6-5',
      'M12 19h8',
    ],
  },
  // Four corners pushed outward.
  maximize: {
    paths: [
      'M8 3H5a2 2 0 0 0-2 2v3',
      'M16 3h3a2 2 0 0 1 2 2v3',
      'M21 16v3a2 2 0 0 1-2 2h-3',
      'M3 16v3a2 2 0 0 0 2 2h3',
    ],
  },
  // The same four corners pulled inward. Deliberately the mirror of `maximize`
  // rather than an unrelated drawing, so the pair reads as one axis.
  restore: {
    paths: [
      'M8 3v3a2 2 0 0 1-2 2H3',
      'M21 8h-3a2 2 0 0 1-2-2V3',
      'M3 16h3a2 2 0 0 1 2 2v3',
      'M16 21v-3a2 2 0 0 1 2-2h3',
    ],
  },
  // The window collapses onto the bar it will sit in.
  minimize: {
    paths: [
      'M5 19h14',
    ],
  },
  // A page with a folded corner and two lines of text.
  document: {
    paths: [
      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
      'M14 2v6h6',
      'M9 13h6',
      'M9 17h4',
    ],
  },
  // Two crossed strokes: dismiss the thing this sits on, not the window.
  close: {
    paths: [
      'M6 6l12 12',
      'M18 6L6 18',
    ],
  },
};

/** Whether a string names a glyph this module can draw. */
export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(ICON_GLYPHS, value);
}

/** The two glyphs a two-state button alternates between. */
export interface ToggleIconPair {
  /** Drawn while the button is pressed. */
  readonly on: IconName;
  /** Drawn while it is not. */
  readonly off: IconName;
}

/**
 * Which of the pair a two-state button draws.
 *
 * A value rather than a branch inside the component, so the rule the toggle
 * applies is readable and testable on its own.
 */
export function resolveToggleIcon(pressed: boolean, pair: ToggleIconPair): IconName {
  return pressed ? pair.on : pair.off;
}

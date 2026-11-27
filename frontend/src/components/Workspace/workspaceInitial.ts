// FR-UIDS-016 AC-2: the one character a folded workspace row shows in its circle.
// Counted in graphemes, so a flag, an emoji or a decomposed syllable is never cut apart.
// @req FR-UIDS-016 AC-2

/** A middle dot: the circle of a workspace whose name is empty or blank is never empty. */
export const WORKSPACE_INITIAL_FALLBACK = '\u00b7';

/**
 * The first character of the trimmed name, uppercased while that keeps it one
 * character (ß would become SS, so it stays as it is).
 */
export function workspaceInitial(name: string): string {
  const trimmed = name.trim().normalize('NFC');
  const characters = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed), (part) => part.segment)
    : Array.from(trimmed);
  if (characters.length === 0) return WORKSPACE_INITIAL_FALLBACK;
  const first = characters[0];
  const upper = first.toUpperCase();
  return Array.from(upper).length === 1 ? upper : first;
}

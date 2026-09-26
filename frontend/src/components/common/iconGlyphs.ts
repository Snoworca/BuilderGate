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
  | 'close'
  | 'sidebar'
  | 'menu'
  | 'folder'
  | 'grid'
  | 'tabs'
  | 'bookmark'
  | 'bookmark-plus'
  | 'bookmark-check'
  | 'resume'
  | 'refresh'
  | 'check'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'copy'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'more'
  | 'tools'
  | 'settings'
  | 'power'
  | 'alert'
  | 'info'
  | 'check-circle'
  | 'lock'
  | 'keyboard'
  | 'plug'
  | 'external'
  | 'download'
  | 'command';

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
  // A window with a panel down its left side: the editor's file tree pane.
  sidebar: {
    paths: [
      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M9 3v18',
    ],
  },
  // Three rules: the sidebar menu.
  menu: {
    paths: [
      'M4 6h16',
      'M4 12h16',
      'M4 18h16',
    ],
  },
  // A folder with its tab.
  folder: {
    paths: [
      'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    ],
  },
  // Four panes: the grid view.
  grid: {
    paths: [
      'M5 4h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1z',
      'M14 4h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1z',
      'M5 13h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1z',
      'M14 13h5a1 1 0 0 1 1 1v5a1 1 0 0 1 -1 1h-5a1 1 0 0 1 -1 -1v-5a1 1 0 0 1 1 -1z',
    ],
  },
  // A window with a tab strip: the tab view.
  tabs: {
    paths: [
      'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2z',
      'M3 9h18',
      'M9 5v4',
    ],
  },
  // A bookmark: keep your place to come back to.
  bookmark: {
    paths: [
      'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z',
    ],
  },
  // Bookmark with a plus: save the sessions to resume later.
  'bookmark-plus': {
    paths: [
      'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z',
      'M12 7v6',
      'M9 10h6',
    ],
  },
  // Bookmark with a tick: the sessions are saved.
  'bookmark-check': {
    paths: [
      'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z',
      'M9 10l2 2 4-4',
    ],
  },
  // An arrow turning back: pick up where it left off.
  resume: {
    paths: [
      'M3 12a9 9 0 1 0 3-6.7',
      'M3 4v5h5',
    ],
  },
  // An arrow closing its own circle: load again.
  refresh: {
    paths: [
      'M20 11a8 8 0 1 0-2.3 5.7',
      'M20 4v7h-7',
    ],
  },
  // A tick.
  check: {
    paths: [
      'M5 12l5 5 9-10',
    ],
  },
  // A plus: add.
  plus: {
    paths: [
      'M12 5v14',
      'M5 12h14',
    ],
  },
  // A bin: delete.
  trash: {
    paths: [
      'M4 7h16',
      'M10 11v6',
      'M14 11v6',
      'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12',
      'M9 7V4h6v3',
    ],
  },
  // A pencil: rename or edit.
  edit: {
    paths: [
      'M4 20h4L19 9l-4-4L4 16z',
      'M13.5 6.5l4 4',
    ],
  },
  // Two sheets: copy.
  copy: {
    paths: [
      'M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2z',
      'M5 15V6a2 2 0 0 1 2-2h8',
    ],
  },
  // A magnifier.
  search: {
    paths: [
      'M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
      'M20 20l-3.5-3.5',
    ],
  },
  // Opens downward.
  'chevron-down': {
    paths: [
      'M6 9l6 6 6-6',
    ],
  },
  // Opens to the right.
  'chevron-right': {
    paths: [
      'M9 6l6 6-6 6',
    ],
  },
  // Three dots: more actions.
  more: {
    paths: [
      'M5 12h.01',
      'M12 12h.01',
      'M19 12h.01',
    ],
  },
  // A wrench: the tools menu.
  tools: {
    paths: [
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.6-3.6a3.5 3.5 0 0 1-4.6 4.6L7.5 19.5a2.1 2.1 0 0 1-3-3l9.2-9.2a3.5 3.5 0 0 1 4.6-4.6z',
    ],
  },
  // A hub with spokes: settings.
  settings: {
    paths: [
      'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
      'M12 2v3',
      'M12 19v3',
      'M4.9 4.9l2.1 2.1',
      'M17 17l2.1 2.1',
      'M2 12h3',
      'M19 12h3',
      'M4.9 19.1L7 17',
      'M17 7l2.1-2.1',
    ],
  },
  // The power mark: sign out.
  power: {
    paths: [
      'M12 3v9',
      'M6.3 7a8 8 0 1 0 11.4 0',
    ],
  },
  // A warning triangle.
  alert: {
    paths: [
      'M12 3L2 20h20L12 3z',
      'M12 10v4',
      'M12 17h.01',
    ],
  },
  // An i in a circle.
  info: {
    paths: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
      'M12 11v5',
      'M12 8h.01',
    ],
  },
  // A tick in a circle: done.
  'check-circle': {
    paths: [
      'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
      'M8 12l3 3 5-6',
    ],
  },
  // A padlock.
  lock: {
    paths: [
      'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2z',
      'M8 11V7a4 4 0 0 1 8 0v4',
    ],
  },
  // A keyboard: shortcuts.
  keyboard: {
    paths: [
      'M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2z',
      'M7 10h.01',
      'M11 10h.01',
      'M15 10h.01',
      'M7 14h10',
    ],
  },
  // A plug: MCP connections.
  plug: {
    paths: [
      'M9 3v5',
      'M15 3v5',
      'M7 8h10v3a5 5 0 0 1-10 0z',
      'M12 16v5',
    ],
  },
  // An arrow leaving a box: open elsewhere.
  external: {
    paths: [
      'M14 4h6v6',
      'M20 4l-9 9',
      'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    ],
  },
  // An arrow into a tray: download a file. Not for saving sessions -- that reads as a download.
  download: {
    paths: [
      'M12 3v10',
      'M8 9l4 4 4-4',
      'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    ],
  },
  // A prompt caret over a line: command lines.
  command: {
    paths: [
      'M5 7l5 5-5 5',
      'M13 17h6',
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

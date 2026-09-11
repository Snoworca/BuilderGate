// The tab set of the one editor window: what opening, selecting and closing a
// document do to it.
//
// A tab's identity is its normalized absolute path, which is what a whole
// window used to be identified by. Opening a path that is already open selects
// the tab holding it rather than adding a second one -- the same rule the
// window list had, moved down a level.
//
// Every function here is a pure function of the set and a path. Nothing reads
// the DOM and nothing knows what a tab renders, so the rules can be decided
// without a browser. The tab payload is a type parameter for the same reason:
// this module orders and selects tabs, and has no business knowing that one
// carries a terminal binding or an unsaved body.
// @req FR-MDE-007
// @req FR-MDE-010

/** The least this module needs of a tab: which document it holds. */
export interface EditorTabIdentity {
  filePath: string;
}

/**
 * The open tabs and which of them is active.
 *
 * The active tab is named by path rather than by index. An index would have to
 * be adjusted on every close, and an adjustment that slipped by one would leave
 * the window showing a document the user did not choose -- silently, because an
 * index is always a valid-looking number.
 *
 * An empty `tabs` and a null `activeFilePath` are the same state seen twice,
 * and that state is what closes the window (D-12). It is not a separate flag:
 * two representations of "no tabs" can disagree, and a window still open with
 * no tabs has nothing to show and no title to carry.
 * @req FR-MDE-010
 */
export interface EditorTabSet<TTab extends EditorTabIdentity> {
  tabs: readonly TTab[];
  activeFilePath: string | null;
}

/**
 * Opens a document. Appends a tab and makes it active, or -- when a tab already
 * holds that path -- selects the one that is there.
 *
 * The existing tab keeps its own payload. Re-opening a document from a
 * different terminal does not move where it saves to: the tab was bound when it
 * was opened, and the unsaved body it is holding belongs to that binding.
 * @req FR-MDE-007
 */
export function addEditorTab<TTab extends EditorTabIdentity>(
  set: EditorTabSet<TTab>,
  tab: TTab,
): EditorTabSet<TTab> {
  if (set.tabs.some(open => open.filePath === tab.filePath)) {
    return selectEditorTab(set, tab.filePath);
  }

  return { tabs: [...set.tabs, tab], activeFilePath: tab.filePath };
}

/**
 * Makes the tab holding `filePath` the active one.
 *
 * A path no tab holds leaves the set alone, and the same object comes back so a
 * caller can skip a render. Clearing the active tab instead would blank the
 * window in answer to a request for a document that is not open.
 * @req FR-MDE-007
 */
export function selectEditorTab<TTab extends EditorTabIdentity>(
  set: EditorTabSet<TTab>,
  filePath: string,
): EditorTabSet<TTab> {
  if (!set.tabs.some(tab => tab.filePath === filePath)) {
    return set;
  }
  if (set.activeFilePath === filePath) {
    return set;
  }

  return { tabs: set.tabs, activeFilePath: filePath };
}

/**
 * Closes the tab holding `filePath`.
 *
 * Closing the active tab activates the one to its right, or -- for the
 * rightmost tab -- the one to its left. Closing an inactive tab leaves the
 * active one where it is, which is why the successor is worked out from the
 * closed tab's position rather than from the active tab's.
 *
 * Closing the last tab empties the set, and an empty set is what closes the
 * window (D-12).
 * @req FR-MDE-010
 */
export function closeEditorTab<TTab extends EditorTabIdentity>(
  set: EditorTabSet<TTab>,
  filePath: string,
): EditorTabSet<TTab> {
  const index = set.tabs.findIndex(tab => tab.filePath === filePath);
  if (index === -1) {
    return set;
  }

  const remaining = set.tabs.filter(tab => tab.filePath !== filePath);
  if (remaining.length === 0) {
    return { tabs: remaining, activeFilePath: null };
  }
  if (set.activeFilePath !== filePath) {
    return { tabs: remaining, activeFilePath: set.activeFilePath };
  }

  // `remaining` has shifted left where the closed tab was, so the tab that was
  // to its right now sits at the same index. Past the end means it was the
  // rightmost, and the one to its left is the last of what is left.
  const successor = remaining[index] ?? remaining[remaining.length - 1];
  return { tabs: remaining, activeFilePath: successor.filePath };
}

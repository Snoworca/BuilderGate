// FR-ARCH-018 AC-1: the new-tab shortcut is pressed inside a terminal (TerminalView) or outside
// one (App's window listener), and the tab is added in App, which knows the active workspace and
// tab. A module-level signal joins them without threading a callback through every terminal.
// @req FR-ARCH-018

type NewTabListener = () => void;

const listeners = new Set<NewTabListener>();

export function requestNewTab(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeNewTabRequests(listener: NewTabListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

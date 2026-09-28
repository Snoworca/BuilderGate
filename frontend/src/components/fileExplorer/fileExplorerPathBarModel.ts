// What the explorer's path bar draws, left to right. The order is a value rather
// than markup so the component draws it by mapping this array, and a test that
// pins the array pins what is on screen (design §9.2).

// @req FR-FEX-002
// FR-FEX-013: 'search' opens the name search (also Ctrl/Cmd+F).
export const PATH_BAR_CONTROLS = ['up', 'path', 'search', 'mode', 'refresh', 'newdir'] as const;

export type PathBarControl = (typeof PATH_BAR_CONTROLS)[number];

// The last segment of a root, for a tab label. A root that is itself a drive or
// filesystem root has no last segment, so the whole path is the label.
// @req FR-FEX-003
/**
 * Tab names (#120): the terminal tab the explorer tab came from, so a tab says
 * which session it belongs to. Without one the folder name stands in; when the
 * same terminal shows up twice (reopened after a cd) the folder tells them apart.
 */
export function explorerTabLabels(tabs: readonly { sessionTabName: string; root: string }[]): string[] {
  const names = tabs.map((tab) => tab.sessionTabName.trim());
  const count = new Map<string, number>();
  for (const name of names) if (name !== '') count.set(name, (count.get(name) ?? 0) + 1);
  return tabs.map((tab, index) => {
    const name = names[index];
    if (name === '') return rootLabel(tab.root);
    return (count.get(name) ?? 0) > 1 ? `${name} · ${rootLabel(tab.root)}` : name;
  });
}

export function rootLabel(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last === undefined || last === '' ? root : last;
}

// ---------------------------------------------------------------------------
// FR-FEX-016: the list-mode breadcrumb, ./{…}/{parent}/{current} from the session root.

export interface BreadcrumbSegment {
  kind: 'root' | 'segment';
  label: string;
  /** The directory this segment names. */
  path: string;
  /** The current directory refreshes; every other segment navigates. */
  action: 'navigate' | 'refresh';
}

export type BreadcrumbItem = BreadcrumbSegment | { kind: 'ellipsis'; title: string };

// A backslash marks a Windows path; the server always reports one with it (C:\\…).
const isWindowsStyle = (p: string) => p.includes('\\');
const trimTrailing = (p: string) => p.replace(/[\\/]+$/, '') || p;

/**
 * The segments from the session root to `root`, or null when either is unknown or `root` is
 * not inside the session root (then the full path is shown). Windows paths compare
 * case-insensitively.
 */
export function buildBreadcrumb(root: string, sessionRoot: string | null): BreadcrumbSegment[] | null {
  if (!sessionRoot) return null;
  const windows = isWindowsStyle(sessionRoot) || isWindowsStyle(root);
  const sep = windows ? '\\' : '/';
  const norm = (p: string) => trimTrailing(windows ? p.replace(/\//g, '\\') : p);
  const base = norm(sessionRoot);
  const current = norm(root);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const segments: BreadcrumbSegment[] = [];
  if (same(current, base)) {
    return [{ kind: 'root', label: '.', path: base, action: 'refresh' }];
  }
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (!(windows ? current.toLowerCase().startsWith(prefix.toLowerCase()) : current.startsWith(prefix))) return null;
  const parts = current.slice(prefix.length).split(sep).filter(Boolean);
  segments.push({ kind: 'root', label: '.', path: base, action: 'navigate' });
  let acc = base;
  parts.forEach((part, index) => {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    segments.push({ kind: 'segment', label: part, path: acc, action: index === parts.length - 1 ? 'refresh' : 'navigate' });
  });
  return segments;
}

/** Keeps the root and the last `max - 2` segments; the middle becomes one ellipsis item. */
export function collapseBreadcrumb(segments: readonly BreadcrumbSegment[], max = 5): BreadcrumbItem[] {
  if (segments.length <= max) return [...segments];
  const tail = segments.slice(segments.length - (max - 2));
  const hidden = segments.slice(1, segments.length - tail.length);
  return [segments[0], { kind: 'ellipsis', title: hidden.map((s) => s.label).join('/') }, ...tail];
}

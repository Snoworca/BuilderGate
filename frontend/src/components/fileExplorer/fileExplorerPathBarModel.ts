// What the explorer's path bar draws, left to right. The order is a value rather
// than markup so the component draws it by mapping this array, and a test that
// pins the array pins what is on screen (design §9.2).

// @req FR-FEX-002
export const PATH_BAR_CONTROLS = ['up', 'path', 'mode', 'refresh', 'newdir'] as const;

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

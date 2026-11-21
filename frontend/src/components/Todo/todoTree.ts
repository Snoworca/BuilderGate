// The to-do panel's tree drawing: the dotted lines from each parent to its children, and the
// category's progress pie. Pure, so it is tested without a browser; the panel measures the boxes.
// @req FR-TODO-003
import type { TodoItem } from './todoModel.ts';

/** A row's status mark (icon or checkbox), in the list's content coordinates. */
export interface TodoTreeAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A crisp 1px line sits on half pixels. */
const crisp = (value: number) => Math.floor(value) + 0.5;

/**
 * FR-TODO-003 AC-10: one trunk from under each parent's mark down to its last visible child, and a
 * branch to each child's mark. `rows` are the visible rows in order; rows without an anchor are skipped.
 */
export function todoTreePath(rows: readonly Pick<TodoItem, 'id' | 'parentId'>[], anchors: ReadonlyMap<number, TodoTreeAnchor>): string {
  const children = new Map<number, TodoTreeAnchor[]>();
  for (const row of rows) {
    const anchor = anchors.get(row.id);
    if (row.parentId === null || !anchor) continue;
    const list = children.get(row.parentId) ?? [];
    list.push(anchor);
    children.set(row.parentId, list);
  }
  let path = '';
  for (const row of rows) {
    const parent = anchors.get(row.id);
    const under = children.get(row.id);
    if (!parent || !under?.length) continue;
    const x = crisp((parent.left + parent.right) / 2);
    const middle = (anchor: TodoTreeAnchor) => crisp((anchor.top + anchor.bottom) / 2);
    path += `M${x} ${Math.round(parent.bottom + 2)}V${middle(under[under.length - 1])}`;
    for (const child of under) path += `M${x} ${middle(child)}H${Math.round(child.left - 3)}`;
  }
  return path;
}

/** FR-TODO-003 AC-11: how many entries under a category are done. */
export function todoProgress(items: readonly TodoItem[], id: number): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (parentId: number) => {
    for (const entry of items) {
      if (entry.parentId !== parentId) continue;
      total += 1;
      if (entry.done) done += 1;
      walk(entry.id);
    }
  };
  walk(id);
  return { done, total };
}

const PIE_MIN = 0.12;
const PIE_MAX = 0.999;

/** FR-TODO-003 AC-11: the filled slice of a 24x24 pie, clockwise from 12 o'clock; never empty, never closed. */
export function todoPieSlicePath(ratio: number): string {
  const turn = Math.min(PIE_MAX, Math.max(PIE_MIN, Number.isFinite(ratio) ? ratio : 0)) * 2 * Math.PI;
  const x = 12 + 7 * Math.sin(turn);
  const y = 12 - 7 * Math.cos(turn);
  return `M12 12V5A7 7 0 ${turn > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z`;
}

// The to-do panel's rows: the server's flat list as a tree, with completed entries shown or hidden
// for the whole list and per category, and what is under a folded entry left out.
// @req FR-TODO-001 FR-TODO-003 FR-TODO-006 FR-TODO-008
import { t } from '../../i18n/i18n.ts';

/** FR-TODO-001 AC-7: who added an entry. */
export type TodoAuthor =
  | { kind: 'user' }
  | { kind: 'session'; sessionKey: string | null; name: string };

export interface TodoItem {
  id: number;
  /** null for a category. */
  parentId: number | null;
  title: string;
  detail: string;
  done: boolean;
  author?: TodoAuthor;
  createdAt: string;
  updatedAt: string;
}

/** FR-TODO-001 AC-3: category, item, sub-item. */
export const TODO_MAX_DEPTH = 3;
/** The server's limits (TodoService). */
export const TODO_TITLE_MAX = 200;
export const TODO_DETAIL_MAX = 20_000;

export type TodoDepth = 1 | 2 | 3;

export interface TodoRow {
  item: TodoItem;
  depth: TodoDepth;
  /** The category the row sits in (itself for a category). */
  categoryId: number;
}

export interface TodoView {
  /** The top toggle: hide completed entries. */
  hideDone: boolean;
  /** A category's own choice, which wins over the top toggle. */
  categoryShowDone: Readonly<Record<number, boolean>>;
  /** FR-TODO-008: entries whose rows below are hidden. */
  collapsed?: Readonly<Record<number, true>>;
}

export function canAddTodoChild(depth: number): boolean {
  return depth < TODO_MAX_DEPTH;
}

/** FR-TODO-003 AC-7: the small label beside the title; null when the entry names no author. */
export function todoAuthorLabel(author: TodoAuthor | undefined): string | null {
  if (!author) return null;
  return author.kind === 'user' ? t('todo.author.user') : author.name;
}

/** FR-TODO-003 AC-8: where a same-level entry goes (null: a new category). */
export function siblingParentId(entry: TodoItem): number | null {
  return entry.parentId;
}

/** FR-TODO-006: where an entry goes — under `parentId` (null: a category), before `beforeId` (null: the end). */
export interface TodoMove {
  parentId: number | null;
  beforeId: number | null;
}

export type TodoDropZone = 'before' | 'inside' | 'after';

const siblingsOf = (items: readonly TodoItem[], parentId: number | null) => items.filter((entry) => entry.parentId === parentId);

/** FR-TODO-006 AC-2: one place up (-1) or down (1) among its siblings; null at either end. */
export function siblingMove(items: readonly TodoItem[], id: number, direction: -1 | 1): TodoMove | null {
  const entry = items.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const siblings = siblingsOf(items, entry.parentId);
  const at = siblings.indexOf(entry);
  if (direction === -1) return at > 0 ? { parentId: entry.parentId, beforeId: siblings[at - 1].id } : null;
  if (at >= siblings.length - 1) return null;
  return { parentId: entry.parentId, beforeId: siblings[at + 2]?.id ?? null };
}

/** FR-TODO-006 AC-3: the top or bottom quarter of a row puts it beside; the middle puts it under, where a child fits. */
export function todoDropZone(offsetY: number, height: number, depth: number): TodoDropZone {
  if (!canAddTodoChild(depth)) return offsetY < height / 2 ? 'before' : 'after';
  if (offsetY < height / 4) return 'before';
  return offsetY > (height * 3) / 4 ? 'after' : 'inside';
}

/** FR-TODO-006 AC-3/AC-4: the move a drop asks for; null when it is refused or changes nothing. */
export function todoDropMove(items: readonly TodoItem[], dragId: number, targetId: number, zone: TodoDropZone): TodoMove | null {
  const byId = new Map(items.map((entry) => [entry.id, entry]));
  const dragged = byId.get(dragId);
  const target = byId.get(targetId);
  if (!dragged || !target || dragId === targetId) return null;
  const parentId = zone === 'inside' ? target.id : target.parentId;
  let parentDepth = 0;
  for (let at = parentId === null ? undefined : byId.get(parentId); at; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    if (at.id === dragId) return null;
    parentDepth += 1;
  }
  const heightOf = (entry: TodoItem): number => 1 + Math.max(0, ...siblingsOf(items, entry.id).map(heightOf));
  if (parentDepth + heightOf(dragged) > TODO_MAX_DEPTH) return null;
  const others = siblingsOf(items, parentId).filter((entry) => entry.id !== dragId);
  const beforeId = zone === 'before' ? target.id
    : zone === 'after' ? others[others.indexOf(target) + 1]?.id ?? null
      : null;
  if (dragged.parentId === parentId) {
    const siblings = siblingsOf(items, parentId);
    const stays = siblings[siblings.indexOf(dragged) + 1]?.id ?? null;
    if (stays === beforeId) return null;
  }
  return { parentId, beforeId };
}

/** FR-TODO-007 AC-8: how many entries a delete takes along with this one. */
export function todoDescendantCount(items: readonly TodoItem[], id: number): number {
  const under = items.filter((entry) => entry.parentId === id);
  return under.reduce((count, entry) => count + todoDescendantCount(items, entry.id), under.length);
}

/** FR-TODO-007 AC-9: the save takes away a detail that was there. */
export function detailSaveRemoves(previous: string, next: string): boolean {
  return previous.length > 0 && next.trim() === '';
}

/** FR-TODO-003 AC-9: what the list shows when it has no rows to show. */
export function todoListPlaceholder({ loaded, rowCount, adding }: { loaded: boolean; rowCount: number; adding: boolean }): 'loading' | 'empty' | null {
  if (!loaded) return 'loading';
  return rowCount === 0 && !adding ? 'empty' : null;
}

export function categoryShowsDone(categoryId: number, view: TodoView): boolean {
  return view.categoryShowDone[categoryId] ?? !view.hideDone;
}

/**
 * FR-TODO-003 AC-1/AC-3/AC-4: rows in tree order (each level by id). A hidden entry hides what is
 * under it. A completed category follows the top toggle; the entries under it follow its icon.
 * FR-TODO-008 AC-1: a folded entry keeps its row and hides what is under it.
 */
export function todoRows(items: readonly TodoItem[], view: TodoView): TodoRow[] {
  const children = new Map<number | null, TodoItem[]>();
  // FR-TODO-006 AC-1: the server's list order is the order.
  for (const entry of items) {
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const rows: TodoRow[] = [];
  // @req FR-TODO-008 AC-1
  const open = (id: number) => view.collapsed?.[id] !== true;
  const walk = (parentId: number, depth: TodoDepth, categoryId: number, showDone: boolean) => {
    for (const entry of children.get(parentId) ?? []) {
      if (entry.done && !showDone) continue;
      rows.push({ item: entry, depth, categoryId });
      if (depth < TODO_MAX_DEPTH && open(entry.id)) walk(entry.id, (depth + 1) as TodoDepth, categoryId, showDone);
    }
  };
  for (const category of children.get(null) ?? []) {
    if (category.done && view.hideDone) continue;
    rows.push({ item: category, depth: 1, categoryId: category.id });
    if (open(category.id)) walk(category.id, 2, category.id, categoryShowsDone(category.id, view));
  }
  return rows;
}

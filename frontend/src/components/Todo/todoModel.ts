// The to-do panel's rows: the server's flat list as a tree, with completed entries shown or hidden
// for the whole list and per category.
// @req FR-TODO-001 FR-TODO-003
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

export function categoryShowsDone(categoryId: number, view: TodoView): boolean {
  return view.categoryShowDone[categoryId] ?? !view.hideDone;
}

/**
 * FR-TODO-003 AC-1/AC-3/AC-4: rows in tree order (each level by id). A hidden entry hides what is
 * under it. A completed category follows the top toggle; the entries under it follow its icon.
 */
export function todoRows(items: readonly TodoItem[], view: TodoView): TodoRow[] {
  const children = new Map<number | null, TodoItem[]>();
  for (const entry of [...items].sort((a, b) => a.id - b.id)) {
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const rows: TodoRow[] = [];
  const walk = (parentId: number, depth: TodoDepth, categoryId: number, showDone: boolean) => {
    for (const entry of children.get(parentId) ?? []) {
      if (entry.done && !showDone) continue;
      rows.push({ item: entry, depth, categoryId });
      if (depth < TODO_MAX_DEPTH) walk(entry.id, (depth + 1) as TodoDepth, categoryId, showDone);
    }
  };
  for (const category of children.get(null) ?? []) {
    if (category.done && view.hideDone) continue;
    rows.push({ item: category, depth: 1, categoryId: category.id });
    walk(category.id, 2, category.id, categoryShowsDone(category.id, view));
  }
  return rows;
}

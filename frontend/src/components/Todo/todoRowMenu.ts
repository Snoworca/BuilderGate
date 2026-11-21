// The right-click menus of the to-do panel (a row's actions, and the panel's own) and the delete question.
// @req FR-TODO-007
import type { ContextMenuItem } from '../ContextMenu/ContextMenu.tsx';
import { t } from '../../i18n/i18n.ts';
import { canAddTodoChild, type TodoItem, type TodoMove } from './todoModel.ts';
import { TODO_PANEL_MAX_FONT_SIZE, TODO_PANEL_MIN_FONT_SIZE } from './todoPanelStore.ts';

export interface TodoRowMenuActions {
  editDetail: () => void;
  editTitle: () => void;
  addSibling: () => void;
  addChild: () => void;
  move: (to: TodoMove) => void;
  toggleDone: () => void;
  remove: () => void;
}

export interface TodoRowMenuInput {
  item: TodoItem;
  depth: number;
  /** Null at either end of its siblings. */
  moveUp: TodoMove | null;
  moveDown: TodoMove | null;
  actions: TodoRowMenuActions;
}

/** FR-TODO-007 AC-6. */
export function todoRowMenuItems({ item, depth, moveUp, moveDown, actions }: TodoRowMenuInput): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: item.detail ? t('todo.detail.edit') : t('todo.detail.add'), icon: 'document', onClick: actions.editDetail },
    { label: t('todo.editTitle'), icon: 'edit', onClick: actions.editTitle },
    { separator: true },
    { label: depth === 1 ? t('todo.addCategory') : t('todo.addSibling'), icon: 'add-sibling', onClick: actions.addSibling },
  ];
  if (canAddTodoChild(depth)) items.push({ label: t('todo.addChild'), icon: 'add-child', onClick: actions.addChild });
  items.push(
    { separator: true },
    { label: t('todo.moveUp'), icon: 'arrow-up', disabled: !moveUp, onClick: () => { if (moveUp) actions.move(moveUp); } },
    { label: t('todo.moveDown'), icon: 'arrow-down', disabled: !moveDown, onClick: () => { if (moveDown) actions.move(moveDown); } },
    { separator: true },
    { label: item.done ? t('todo.markOpen') : t('todo.markDone'), icon: 'check-circle', onClick: actions.toggleDone },
    { label: t('todo.delete'), icon: 'trash', destructive: true, onClick: actions.remove },
  );
  return items;
}

export interface TodoPanelMenuInput {
  hideDone: boolean;
  fontSize: number;
  actions: { addCategory: () => void; toggleHideDone: () => void; fontLarger: () => void; fontSmaller: () => void };
}

/** FR-TODO-007 AC-7: right-click on the empty list or the header. */
export function todoPanelMenuItems({ hideDone, fontSize, actions }: TodoPanelMenuInput): ContextMenuItem[] {
  return [
    { label: t('todo.addCategory'), icon: 'plus', onClick: actions.addCategory },
    { label: hideDone ? t('todo.showDone') : t('todo.hideDone'), icon: 'check-circle', onClick: actions.toggleHideDone },
    { separator: true },
    { label: t('todo.fontLarger'), icon: 'text-larger', disabled: fontSize >= TODO_PANEL_MAX_FONT_SIZE, onClick: actions.fontLarger },
    { label: t('todo.fontSmaller'), icon: 'text-smaller', disabled: fontSize <= TODO_PANEL_MIN_FONT_SIZE, onClick: actions.fontSmaller },
  ];
}

/** FR-TODO-007 AC-8: the question the delete modal asks. */
export function todoDeleteMessage(item: TodoItem, descendants: number): string {
  return descendants > 0
    ? t('todo.deleteMessageWithChildren', { id: item.id, title: item.title, count: descendants })
    : t('todo.deleteMessage', { id: item.id, title: item.title });
}

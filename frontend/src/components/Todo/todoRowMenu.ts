// The right-click menu of a to-do row: the row's actions in one list.
// @req FR-TODO-007
import type { ContextMenuItem } from '../ContextMenu/ContextMenu.tsx';
import { t } from '../../i18n/i18n.ts';
import { canAddTodoChild, type TodoItem, type TodoMove } from './todoModel.ts';

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

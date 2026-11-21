// The to-do panel: a tall resizable column on the right (the whole screen on a phone) with the
// server's list, a show/hide-completed toggle at the top and per category. Each entry's detail sits
// right under it and is written in place; a right-click on a row opens its actions.
// @req FR-TODO-002 FR-TODO-003 FR-TODO-006 FR-TODO-007
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../common';
import { Button } from '../ui';
import { ContextMenu } from '../ContextMenu';
import { t } from '../../i18n/i18n.ts';
import { todoApi } from '../../services/api.ts';
import { canAddTodoChild, categoryShowsDone, siblingMove, siblingParentId, TODO_DETAIL_MAX, TODO_TITLE_MAX, todoAuthorLabel, todoDropMove, todoDropZone, todoRows, type TodoDropZone, type TodoItem, type TodoMove, type TodoRow } from './todoModel.ts';
import { todoPanelStore, useTodoPanelState } from './todoPanelStore.ts';
import { todoRowMenuItems, type TodoRowMenuActions } from './todoRowMenu.ts';
import { useTodos } from './useTodos.ts';
import './TodoPanel.css';

interface TodoPanelProps {
  isMobile: boolean;
}

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function TodoPanel({ isMobile }: TodoPanelProps) {
  const panel = useTodoPanelState();
  const { items, error: loadError, refresh } = useTodos(panel.open);
  const [error, setError] = useState<string | null>(null);
  /**
   * Where the new-entry box is: under the row it was asked from (`anchorId`), for a child or a same-level
   * entry; or at the end for a category from the header (`anchorId` null).
   */
  const [adding, setAdding] = useState<{ parentId: number | null; anchorId: number | null; depth: number } | null>(null);
  /** FR-TODO-007: the entry whose detail or title is being written. */
  const [editingDetailId, setEditingDetailId] = useState<number | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: TodoRow } | null>(null);

  const rows = useMemo(() => todoRows(items, panel), [items, panel]);

  // A removed entry drops its selection and its open editors.
  useEffect(() => {
    if (items.length === 0) return;
    const exists = (id: number | null) => id === null || items.some((entry) => entry.id === id);
    if (!exists(panel.selectedId)) todoPanelStore.select(null);
    if (!exists(editingDetailId)) setEditingDetailId(null);
    if (!exists(editingTitleId)) setEditingTitleId(null);
  }, [items, panel.selectedId, editingDetailId, editingTitleId]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  const add = useCallback((parentId: number | null, title: string) => run(async () => {
    const created = await todoApi.add({ parentId, title });
    todoPanelStore.select(created.id);
  }), [run]);

  // FR-TODO-006: the broadcast brings the order to every browser; this one reads it at once.
  const move = useCallback((id: number, to: TodoMove | null) => {
    if (!to) return;
    void run(async () => {
      await todoApi.move(id, to);
      await refresh();
    });
  }, [run, refresh]);

  /** FR-TODO-007 AC-3/AC-5: rejects when the server refuses, so the editor keeps what was typed. */
  const save = useCallback(async (id: number, input: { title?: string; detail?: string }) => {
    try {
      await todoApi.update(id, input);
      setError(null);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
      throw reason;
    }
  }, [refresh]);

  // FR-TODO-006 AC-3: the dragged entry, and where it would land.
  const dragIdRef = useRef<number | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: number; zone: TodoDropZone } | null>(null);
  const dropFor = (row: TodoRow, event: ReactDragEvent<HTMLDivElement>) => {
    const dragId = dragIdRef.current;
    if (dragId === null) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const zone = todoDropZone(event.clientY - box.top, box.height, row.depth);
    const to = todoDropMove(items, dragId, row.item.id, zone);
    return to ? { zone, to, dragId } : null;
  };
  const drag = {
    onDragStart: (row: TodoRow, event: ReactDragEvent<HTMLDivElement>) => {
      dragIdRef.current = row.item.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(row.item.id));
    },
    onDragOver: (row: TodoRow, event: ReactDragEvent<HTMLDivElement>) => {
      const drop = dropFor(row, event);
      if (!drop) {
        if (dropHint?.targetId === row.item.id) setDropHint(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropHint?.targetId !== row.item.id || dropHint.zone !== drop.zone) setDropHint({ targetId: row.item.id, zone: drop.zone });
    },
    onDrop: (row: TodoRow, event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const drop = dropFor(row, event);
      dragIdRef.current = null;
      setDropHint(null);
      if (drop) move(drop.dragId, drop.to);
    },
    onDragEnd: () => {
      dragIdRef.current = null;
      setDropHint(null);
    },
  };

  const remove = useCallback((entry: TodoItem) => {
    if (!window.confirm(t('todo.deleteConfirm', { id: entry.id }))) return;
    void run(() => todoApi.remove(entry.id));
  }, [run]);

  // FR-TODO-002 AC-3: drag the left edge.
  const onResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = todoPanelStore.getState().width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const resize = (moveEvent: PointerEvent) => todoPanelStore.setWidth(startWidth + (startX - moveEvent.clientX));
    const end = () => {
      target.removeEventListener('pointermove', resize);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', resize);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }, []);

  if (!panel.open) return null;

  const shownError = error ?? (loadError ? t('todo.error.load') : null);

  const actionsFor = (row: TodoRow): TodoRowMenuActions => ({
    editDetail: () => {
      todoPanelStore.select(row.item.id);
      todoPanelStore.setDetailHidden(row.item.id, false);
      setEditingDetailId(row.item.id);
    },
    editTitle: () => {
      todoPanelStore.select(row.item.id);
      setEditingTitleId(row.item.id);
    },
    addSibling: () => setAdding({ parentId: siblingParentId(row.item), anchorId: row.item.id, depth: row.depth }),
    addChild: () => setAdding({ parentId: row.item.id, anchorId: row.item.id, depth: row.depth + 1 }),
    move: (to) => move(row.item.id, to),
    toggleDone: () => void run(() => todoApi.update(row.item.id, { done: !row.item.done })),
    remove: () => remove(row.item),
  });

  return (
    <aside
      className={`todo-panel${isMobile ? ' todo-panel--mobile' : ''}`}
      style={{ ...(isMobile ? {} : { width: panel.width }), '--todo-font-size': `${panel.fontSize}px` } as CSSProperties}
      aria-label={t('todo.title')}
    >
      {!isMobile && (
        <div className="todo-panel__resize" role="separator" aria-orientation="vertical" aria-label={t('todo.resize')} onPointerDown={onResizeStart} />
      )}
      <header className="todo-panel__header">
        <span className="todo-panel__title">{t('todo.title')}</span>
        <button
          type="button"
          className={`todo-panel__done-toggle${panel.hideDone ? '' : ' is-on'}`}
          aria-pressed={!panel.hideDone}
          onClick={() => todoPanelStore.setHideDone(!panel.hideDone)}
        >
          <Icon name="check-circle" size={14} />
          {panel.hideDone ? t('todo.showDone') : t('todo.hideDone')}
        </button>
        {/* FR-TODO-002 AC-5 */}
        <button type="button" className="icon-button todo-panel__icon" title={t('todo.fontSmaller')} aria-label={t('todo.fontSmaller')} onClick={() => todoPanelStore.changeFontSize(-1)}>
          <Icon name="text-smaller" size={16} />
        </button>
        <button type="button" className="icon-button todo-panel__icon" title={t('todo.fontLarger')} aria-label={t('todo.fontLarger')} onClick={() => todoPanelStore.changeFontSize(1)}>
          <Icon name="text-larger" size={16} />
        </button>
        <button type="button" className="icon-button todo-panel__icon" title={t('todo.addCategory')} aria-label={t('todo.addCategory')} onClick={() => setAdding({ parentId: null, anchorId: null, depth: 1 })}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" className="icon-button todo-panel__icon" title={t('todo.close')} aria-label={t('todo.close')} onClick={() => todoPanelStore.setOpen(false)}>
          <Icon name="close" size={16} />
        </button>
      </header>
      {shownError && <div className="todo-panel__error" role="alert">{shownError}</div>}
      <div className="todo-panel__list" role="tree">
        {rows.length === 0 && adding === null && <div className="todo-panel__empty">{t('todo.empty')}</div>}
        {rows.map((row) => {
          const actions = actionsFor(row);
          const moveUp = siblingMove(items, row.item.id, -1);
          const moveDown = siblingMove(items, row.item.id, 1);
          return (
            <TodoRowView
              key={row.item.id}
              row={row}
              selected={row.item.id === panel.selectedId}
              categoryShowDone={row.depth === 1 ? categoryShowsDone(row.item.id, panel) : undefined}
              detailHidden={panel.hiddenDetails[row.item.id] === true}
              editingDetail={editingDetailId === row.item.id}
              editingTitle={editingTitleId === row.item.id}
              addingDepth={adding !== null && adding.anchorId === row.item.id ? adding.depth : null}
              actions={actions}
              moveUp={moveUp}
              moveDown={moveDown}
              onSubmitNew={(title) => { const parentId = adding?.parentId ?? null; setAdding(null); void add(parentId, title); }}
              onCancelNew={() => setAdding(null)}
              onSaveTitle={(title) => {
                setEditingTitleId(null);
                if (title !== row.item.title) void save(row.item.id, { title }).catch(() => undefined);
              }}
              onCancelTitle={() => setEditingTitleId(null)}
              onSaveDetail={async (detail) => {
                await save(row.item.id, { detail });
                setEditingDetailId(null);
              }}
              onCancelDetail={() => setEditingDetailId(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                todoPanelStore.select(row.item.id);
                setMenu({ x: event.clientX, y: event.clientY, row });
              }}
              dropZone={dropHint?.targetId === row.item.id ? dropHint.zone : null}
              onDragStart={(event) => drag.onDragStart(row, event)}
              onDragOver={(event) => drag.onDragOver(row, event)}
              onDragLeave={() => { if (dropHint?.targetId === row.item.id) setDropHint(null); }}
              onDrop={(event) => drag.onDrop(row, event)}
              onDragEnd={drag.onDragEnd}
            />
          );
        })}
        {adding !== null && adding.anchorId === null && (
          <NewEntryInput depth={1} onSubmit={(title) => { setAdding(null); void add(null, title); }} onCancel={() => setAdding(null)} />
        )}
      </div>
      {/* FR-TODO-007 AC-6 */}
      {menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          items={todoRowMenuItems({
            item: menu.row.item,
            depth: menu.row.depth,
            moveUp: siblingMove(items, menu.row.item.id, -1),
            moveDown: siblingMove(items, menu.row.item.id, 1),
            actions: actionsFor(menu.row),
          })}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}

interface TodoRowViewProps {
  row: TodoRow;
  selected: boolean;
  /** Set on a category: whether its completed entries show. */
  categoryShowDone: boolean | undefined;
  detailHidden: boolean;
  editingDetail: boolean;
  editingTitle: boolean;
  /** The depth of the new-entry box asked from this row, or null. */
  addingDepth: number | null;
  actions: TodoRowMenuActions;
  /** FR-TODO-006 AC-2: null at the end of its siblings. */
  moveUp: TodoMove | null;
  moveDown: TodoMove | null;
  onSubmitNew: (title: string) => void;
  onCancelNew: () => void;
  onSaveTitle: (title: string) => void;
  onCancelTitle: () => void;
  /** Rejects when the server refuses. */
  onSaveDetail: (detail: string) => Promise<void>;
  onCancelDetail: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** FR-TODO-006 AC-3: where a dragged entry would land on this row. */
  dropZone: TodoDropZone | null;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function TodoRowView({
  row, selected, categoryShowDone, detailHidden, editingDetail, editingTitle, addingDepth, actions, moveUp, moveDown,
  onSubmitNew, onCancelNew, onSaveTitle, onCancelTitle, onSaveDetail, onCancelDetail, onContextMenu,
  dropZone, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: TodoRowViewProps) {
  const { item, depth } = row;
  const author = todoAuthorLabel(item.author);
  const hasDetail = item.detail.length > 0;
  const stop = (action: () => void) => (event: ReactMouseEvent) => { event.stopPropagation(); action(); };
  return (
    <>
      <div
        className={`todo-row todo-row--d${depth}${selected ? ' is-selected' : ''}${item.done ? ' is-done' : ''}${dropZone ? ` is-drop-${dropZone}` : ''}`}
        role="treeitem"
        aria-level={depth}
        aria-selected={selected}
        onClick={() => todoPanelStore.select(item.id)}
        onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest('button, input')) actions.editTitle(); }}
        onContextMenu={onContextMenu}
        draggable={!editingTitle}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        <input
          type="checkbox"
          className="todo-row__check"
          checked={item.done}
          aria-label={item.done ? t('todo.markOpen') : t('todo.markDone')}
          onClick={(event) => event.stopPropagation()}
          onChange={actions.toggleDone}
        />
        <span className="todo-row__id">#{item.id}</span>
        {editingTitle
          ? <TitleEditor title={item.title} onSave={onSaveTitle} onCancel={onCancelTitle} />
          : <span className="todo-row__title" title={item.title}>{item.title}</span>}
        {/* FR-TODO-007 AC-1/AC-4: there is a detail; when hidden, this shows it again. */}
        {hasDetail && (
          <button
            type="button"
            className={`todo-row__note${detailHidden ? ' is-hidden' : ''}`}
            title={detailHidden ? t('todo.detail.show') : t('todo.detail.heading')}
            aria-label={detailHidden ? t('todo.detail.show') : t('todo.detail.heading')}
            onClick={stop(() => { if (detailHidden) todoPanelStore.setDetailHidden(item.id, false); })}
          >
            <Icon name="document" size={12} />
          </button>
        )}
        {/* FR-TODO-003 AC-7 */}
        {author !== null && (
          <span className={`todo-row__author todo-row__author--${item.author!.kind}`} title={author}>{author}</span>
        )}
        <span className="todo-row__actions">
          {/* FR-TODO-007 AC-2 */}
          <button type="button" className="icon-button todo-row__action" title={hasDetail ? t('todo.detail.edit') : t('todo.detail.add')} aria-label={hasDetail ? t('todo.detail.edit') : t('todo.detail.add')} onClick={stop(actions.editDetail)}>
            <Icon name="document" size={14} />
          </button>
          {/* FR-TODO-006 AC-2 */}
          <button type="button" className="icon-button todo-row__action" disabled={!moveUp} title={t('todo.moveUp')} aria-label={t('todo.moveUp')} onClick={stop(() => { if (moveUp) actions.move(moveUp); })}>
            <Icon name="arrow-up" size={14} />
          </button>
          <button type="button" className="icon-button todo-row__action" disabled={!moveDown} title={t('todo.moveDown')} aria-label={t('todo.moveDown')} onClick={stop(() => { if (moveDown) actions.move(moveDown); })}>
            <Icon name="arrow-down" size={14} />
          </button>
          {/* FR-TODO-003 AC-8 */}
          <button type="button" className="icon-button todo-row__action" title={depth === 1 ? t('todo.addCategory') : t('todo.addSibling')} aria-label={depth === 1 ? t('todo.addCategory') : t('todo.addSibling')} onClick={stop(actions.addSibling)}>
            <Icon name="add-sibling" size={14} />
          </button>
          {canAddTodoChild(depth) && (
            <button type="button" className="icon-button todo-row__action" title={t('todo.addChild')} aria-label={t('todo.addChild')} onClick={stop(actions.addChild)}>
              <Icon name="add-child" size={14} />
            </button>
          )}
          <button type="button" className="icon-button todo-row__action" title={t('todo.delete')} aria-label={t('todo.delete')} onClick={stop(actions.remove)}>
            <Icon name="trash" size={14} />
          </button>
        </span>
        {categoryShowDone !== undefined && (
          <button
            type="button"
            className={`icon-button todo-row__done-toggle${categoryShowDone ? ' is-on' : ''}`}
            aria-pressed={categoryShowDone}
            title={categoryShowDone ? t('todo.categoryHideDone') : t('todo.categoryShowDone')}
            aria-label={categoryShowDone ? t('todo.categoryHideDone') : t('todo.categoryShowDone')}
            onClick={(event) => { event.stopPropagation(); todoPanelStore.toggleCategoryDone(item.id); }}
          >
            <Icon name="check-circle" size={14} />
          </button>
        )}
      </div>
      {editingDetail
        ? <DetailEditor depth={depth} detail={item.detail} onSave={onSaveDetail} onCancel={onCancelDetail} />
        : hasDetail && !detailHidden && (
          // FR-TODO-007 AC-1: the whole detail, right under the entry; a click edits it.
          <div className={`todo-detail todo-detail--d${depth}`} title={t('todo.detail.edit')} onClick={actions.editDetail}>
            {item.detail}
            <button type="button" className="todo-detail__hide" onClick={stop(() => todoPanelStore.setDetailHidden(item.id, true))}>
              {t('todo.detail.hide')}
            </button>
          </div>
        )}
      {addingDepth !== null && <NewEntryInput depth={addingDepth} onSubmit={onSubmitNew} onCancel={onCancelNew} />}
    </>
  );
}

/** FR-TODO-007 AC-5: the title, edited where it is. */
function TitleEditor({ title, onSave, onCancel }: { title: string; onSave: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && value.trim()) onSave(value.trim());
    else onCancel();
  };
  return (
    <input
      className="todo-row__input todo-row__title-input"
      autoFocus
      value={value}
      maxLength={TODO_TITLE_MAX}
      aria-label={t('todo.editTitle')}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

const DETAIL_EDITOR_MIN_HEIGHT = 58;

/** FR-TODO-007 AC-2/AC-3: in the detail's own place and width; grows, then scrolls. */
function DetailEditor({ depth, detail, onSave, onCancel }: { depth: number; detail: string; onSave: (detail: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(detail);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.max(area.scrollHeight, DETAIL_EDITOR_MIN_HEIGHT)}px`;
  }, [value]);
  useEffect(() => {
    const area = ref.current;
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  }, []);
  const save = (next: string) => {
    if (saving) return;
    setSaving(true);
    onSave(next.trim() ? next : '').catch(() => undefined).finally(() => setSaving(false));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(value); }
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
  };
  return (
    <div className={`todo-detail-edit todo-detail--d${depth}`}>
      <textarea
        ref={ref}
        value={value}
        maxLength={TODO_DETAIL_MAX}
        placeholder={t('todo.detail.placeholder')}
        aria-label={t('todo.detail.detail')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="todo-detail-edit__bar">
        {detail && (
          <button type="button" className="todo-detail-edit__clear" disabled={saving} onClick={() => save('')}>{t('todo.detail.clear')}</button>
        )}
        <span className="todo-detail-edit__hint">{t('todo.detail.hint')}</span>
        <Button size="sm" variant="secondary" onClick={onCancel}>{t('todo.detail.cancel')}</Button>
        <Button size="sm" variant="primary" disabled={saving || value === detail} onClick={() => save(value)}>{t('todo.detail.save')}</Button>
      </div>
    </div>
  );
}

function NewEntryInput({ depth, onSubmit, onCancel }: { depth: number; onSubmit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && value.trim()) onSubmit(value.trim());
    if (event.key === 'Escape') onCancel();
  };
  return (
    <div className={`todo-row todo-row--d${Math.min(depth, 3)} todo-row--new`}>
      <input
        className="todo-row__input"
        autoFocus
        value={value}
        maxLength={TODO_TITLE_MAX}
        placeholder={t('todo.newPlaceholder')}
        aria-label={depth === 1 ? t('todo.addCategory') : t('todo.addChild')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { if (!value.trim()) onCancel(); }}
      />
    </div>
  );
}

/** FR-TODO-002 AC-2: the header button. */
export function TodoButton() {
  const panel = useTodoPanelState();
  return (
    <button
      type="button"
      className={`icon-button icon-button-md header-action-button${panel.open ? ' is-active' : ''}`}
      onClick={() => todoPanelStore.toggle()}
      aria-pressed={panel.open}
      aria-label={t('todo.button')}
      title={t('todo.button')}
    >
      <Icon name="clipboard" size={18} />
    </button>
  );
}

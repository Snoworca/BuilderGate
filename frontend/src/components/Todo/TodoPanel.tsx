// The to-do panel: a tall resizable column on the right (the whole screen on a phone) with the
// server's list, a show/hide-completed toggle at the top and per category, and the selected
// entry's details at the bottom.
// @req FR-TODO-002 FR-TODO-003 FR-TODO-004 FR-TODO-006
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../common';
import { Button } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { todoApi } from '../../services/api.ts';
import { canAddTodoChild, categoryShowsDone, siblingMove, siblingParentId, TODO_DETAIL_MAX, TODO_TITLE_MAX, todoAuthorLabel, todoDropMove, todoDropZone, todoRows, type TodoDropZone, type TodoItem, type TodoMove, type TodoRow } from './todoModel.ts';
import { todoPanelStore, useTodoPanelState } from './todoPanelStore.ts';
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

  const rows = useMemo(() => todoRows(items, panel), [items, panel]);
  const selected = items.find((entry) => entry.id === panel.selectedId) ?? null;

  // FR-TODO-004 AC-3: a removed entry leaves the detail area empty.
  useEffect(() => {
    if (panel.selectedId !== null && items.length > 0 && !items.some((entry) => entry.id === panel.selectedId)) todoPanelStore.select(null);
  }, [items, panel.selectedId]);

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
    const move = (moveEvent: PointerEvent) => todoPanelStore.setWidth(startWidth + (startX - moveEvent.clientX));
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }, []);

  if (!panel.open) return null;

  const shownError = error ?? (loadError ? t('todo.error.load') : null);

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
        {rows.map((row) => (
          <TodoRowView
            key={row.item.id}
            row={row}
            selected={row.item.id === panel.selectedId}
            categoryShowDone={row.depth === 1 ? categoryShowsDone(row.item.id, panel) : undefined}
            addingDepth={adding !== null && adding.anchorId === row.item.id ? adding.depth : null}
            onAddChild={() => setAdding({ parentId: row.item.id, anchorId: row.item.id, depth: row.depth + 1 })}
            onAddSibling={() => setAdding({ parentId: siblingParentId(row.item), anchorId: row.item.id, depth: row.depth })}
            onSubmitNew={(title) => { const parentId = adding?.parentId ?? null; setAdding(null); void add(parentId, title); }}
            onCancelNew={() => setAdding(null)}
            onToggleDone={() => void run(() => todoApi.update(row.item.id, { done: !row.item.done }))}
            moveUp={siblingMove(items, row.item.id, -1)}
            moveDown={siblingMove(items, row.item.id, 1)}
            onMove={(to) => move(row.item.id, to)}
            dropZone={dropHint?.targetId === row.item.id ? dropHint.zone : null}
            onDragStart={(event) => drag.onDragStart(row, event)}
            onDragOver={(event) => drag.onDragOver(row, event)}
            onDragLeave={() => { if (dropHint?.targetId === row.item.id) setDropHint(null); }}
            onDrop={(event) => drag.onDrop(row, event)}
            onDragEnd={drag.onDragEnd}
            onRemove={() => remove(row.item)}
          />
        ))}
        {adding !== null && adding.anchorId === null && (
          <NewEntryInput depth={1} onSubmit={(title) => { setAdding(null); void add(null, title); }} onCancel={() => setAdding(null)} />
        )}
      </div>
      <TodoDetail
        key={selected?.id ?? 'none'}
        item={selected}
        onSave={async (input) => {
          const saved = await todoApi.update(selected!.id, input);
          setError(null);
          void refresh();
          return saved;
        }}
        onError={(reason) => setError(errorText(reason))}
      />
    </aside>
  );
}

interface TodoRowViewProps {
  row: TodoRow;
  selected: boolean;
  /** Set on a category: whether its completed entries show. */
  categoryShowDone: boolean | undefined;
  /** The depth of the new-entry box asked from this row, or null. */
  addingDepth: number | null;
  onAddChild: () => void;
  onAddSibling: () => void;
  onSubmitNew: (title: string) => void;
  onCancelNew: () => void;
  onToggleDone: () => void;
  onRemove: () => void;
  /** FR-TODO-006 AC-2: null at the end of its siblings. */
  moveUp: TodoMove | null;
  moveDown: TodoMove | null;
  onMove: (to: TodoMove) => void;
  /** FR-TODO-006 AC-3: where a dragged entry would land on this row. */
  dropZone: TodoDropZone | null;
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

function TodoRowView({
  row, selected, categoryShowDone, addingDepth, onAddChild, onAddSibling, onSubmitNew, onCancelNew, onToggleDone, onRemove,
  moveUp, moveDown, onMove, dropZone, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: TodoRowViewProps) {
  const { item, depth } = row;
  const author = todoAuthorLabel(item.author);
  return (
    <>
      <div
        className={`todo-row todo-row--d${depth}${selected ? ' is-selected' : ''}${item.done ? ' is-done' : ''}${dropZone ? ` is-drop-${dropZone}` : ''}`}
        role="treeitem"
        aria-level={depth}
        aria-selected={selected}
        onClick={() => todoPanelStore.select(item.id)}
        draggable
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
          onChange={onToggleDone}
        />
        <span className="todo-row__id">#{item.id}</span>
        <span className="todo-row__title" title={item.title}>{item.title}</span>
        {/* FR-TODO-003 AC-7 */}
        {author !== null && (
          <span className={`todo-row__author todo-row__author--${item.author!.kind}`} title={author}>{author}</span>
        )}
        <span className="todo-row__actions">
          {/* FR-TODO-006 AC-2 */}
          <button type="button" className="icon-button todo-row__action" disabled={!moveUp} title={t('todo.moveUp')} aria-label={t('todo.moveUp')} onClick={(event) => { event.stopPropagation(); if (moveUp) onMove(moveUp); }}>
            <Icon name="arrow-up" size={14} />
          </button>
          <button type="button" className="icon-button todo-row__action" disabled={!moveDown} title={t('todo.moveDown')} aria-label={t('todo.moveDown')} onClick={(event) => { event.stopPropagation(); if (moveDown) onMove(moveDown); }}>
            <Icon name="arrow-down" size={14} />
          </button>
          {/* FR-TODO-003 AC-8 */}
          <button type="button" className="icon-button todo-row__action" title={depth === 1 ? t('todo.addCategory') : t('todo.addSibling')} aria-label={depth === 1 ? t('todo.addCategory') : t('todo.addSibling')} onClick={(event) => { event.stopPropagation(); onAddSibling(); }}>
            <Icon name="add-sibling" size={14} />
          </button>
          {canAddTodoChild(depth) && (
            <button type="button" className="icon-button todo-row__action" title={t('todo.addChild')} aria-label={t('todo.addChild')} onClick={(event) => { event.stopPropagation(); onAddChild(); }}>
              <Icon name="add-child" size={14} />
            </button>
          )}
          <button type="button" className="icon-button todo-row__action" title={t('todo.delete')} aria-label={t('todo.delete')} onClick={(event) => { event.stopPropagation(); onRemove(); }}>
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
      {addingDepth !== null && <NewEntryInput depth={addingDepth} onSubmit={onSubmitNew} onCancel={onCancelNew} />}
    </>
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

interface TodoDetailProps {
  item: TodoItem | null;
  /** Rejects when the server refuses; the edit then stays in the boxes. */
  onSave: (input: { title: string; detail: string }) => Promise<TodoItem>;
  onError: (reason: unknown) => void;
}

function TodoDetail({ item, onSave, onError }: TodoDetailProps) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [detail, setDetail] = useState(item?.detail ?? '');
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef({ title: item?.title ?? '', detail: item?.detail ?? '' });

  // Someone else changed it (another browser, an agent): follow unless the user is editing.
  useEffect(() => {
    if (!item || dirty) return;
    if (item.title !== savedRef.current.title || item.detail !== savedRef.current.detail) {
      savedRef.current = { title: item.title, detail: item.detail };
      setTitle(item.title);
      setDetail(item.detail);
    }
  }, [item, dirty]);

  if (!item) return <section className="todo-panel__detail todo-panel__detail--empty">{t('todo.detail.empty')}</section>;

  const save = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), detail }).then((saved) => {
      savedRef.current = { title: saved.title, detail: saved.detail };
      setTitle(saved.title);
      setDetail(saved.detail);
      setDirty(false);
    }, onError);
  };

  return (
    <section className="todo-panel__detail" aria-label={t('todo.detail.heading')}>
      <div className="todo-panel__detail-head">
        <span className="todo-row__id">#{item.id}</span>
        <input
          className="todo-panel__detail-title"
          value={title}
          maxLength={TODO_TITLE_MAX}
          aria-label={t('todo.detail.title')}
          onChange={(event) => { setTitle(event.target.value); setDirty(true); }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) save(); }}
        />
      </div>
      <textarea
        className="todo-panel__detail-text"
        value={detail}
        maxLength={TODO_DETAIL_MAX}
        aria-label={t('todo.detail.detail')}
        placeholder={t('todo.detail.detail')}
        onChange={(event) => { setDetail(event.target.value); setDirty(true); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save(); }}
      />
      <div className="todo-panel__detail-actions">
        <Button size="sm" variant="primary" disabled={!dirty || !title.trim()} onClick={save}>{t('todo.detail.save')}</Button>
      </div>
    </section>
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

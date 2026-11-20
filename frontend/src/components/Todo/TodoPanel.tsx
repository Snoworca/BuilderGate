// The to-do panel: a tall resizable column on the right (the whole screen on a phone) with the
// server's list, a show/hide-completed toggle at the top and per category, and the selected
// entry's details at the bottom.
// @req FR-TODO-002 FR-TODO-003 FR-TODO-004
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../common';
import { Button } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { todoApi } from '../../services/api.ts';
import { canAddTodoChild, categoryShowsDone, TODO_DETAIL_MAX, TODO_TITLE_MAX, todoRows, type TodoItem, type TodoRow } from './todoModel.ts';
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
  /** Where the new-entry box is: under a parent, or at the end for a category. */
  const [adding, setAdding] = useState<{ parentId: number | null } | null>(null);

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
      style={isMobile ? undefined : { width: panel.width }}
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
        <button type="button" className="icon-button todo-panel__icon" title={t('todo.addCategory')} aria-label={t('todo.addCategory')} onClick={() => setAdding({ parentId: null })}>
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
            adding={adding?.parentId === row.item.id}
            onAddChild={() => setAdding({ parentId: row.item.id })}
            onSubmitChild={(title) => { setAdding(null); void add(row.item.id, title); }}
            onCancelChild={() => setAdding(null)}
            onToggleDone={() => void run(() => todoApi.update(row.item.id, { done: !row.item.done }))}
            onRemove={() => remove(row.item)}
          />
        ))}
        {adding?.parentId === null && (
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
  adding: boolean;
  onAddChild: () => void;
  onSubmitChild: (title: string) => void;
  onCancelChild: () => void;
  onToggleDone: () => void;
  onRemove: () => void;
}

function TodoRowView({ row, selected, categoryShowDone, adding, onAddChild, onSubmitChild, onCancelChild, onToggleDone, onRemove }: TodoRowViewProps) {
  const { item, depth } = row;
  return (
    <>
      <div
        className={`todo-row todo-row--d${depth}${selected ? ' is-selected' : ''}${item.done ? ' is-done' : ''}`}
        role="treeitem"
        aria-level={depth}
        aria-selected={selected}
        onClick={() => todoPanelStore.select(item.id)}
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
        <span className="todo-row__actions">
          {canAddTodoChild(depth) && (
            <button type="button" className="icon-button todo-row__action" title={t('todo.addChild')} aria-label={t('todo.addChild')} onClick={(event) => { event.stopPropagation(); onAddChild(); }}>
              <Icon name="plus" size={14} />
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
      {adding && <NewEntryInput depth={depth + 1} onSubmit={onSubmitChild} onCancel={onCancelChild} />}
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

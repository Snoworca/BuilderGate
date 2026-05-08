import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { buildTerminalInput } from './commandPresetExecution';
import { useCommandPresets } from './useCommandPresets';
import type { CommandPreset, CommandPresetKind } from '../../types';
import './CommandPresetDialog.css';

export interface CommandPresetDialogProps {
  open: boolean;
  activeTabId: string | null;
  activeShellType: string | null;
  onClose: () => void;
  onSendTerminalInput: (tabId: string, data: string) => void;
}

const ACTIVE_TAB_STORAGE_KEY = 'buildergate.commandPresetManager.activeTab';
const TAB_DEFINITIONS: Array<{ kind: CommandPresetKind; label: string }> = [
  { kind: 'command', label: '커맨드 라인' },
  { kind: 'directory', label: '디렉토리' },
  { kind: 'prompt', label: '프롬프트' },
];

interface EditingPresetDraft {
  id: string;
  label: string;
  value: string;
  saving: boolean;
  error: string | null;
}

type EditingPresetField = 'label' | 'value';

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) {
      throw new Error('Clipboard copy failed');
    }
  }
}

function readStoredTab(): CommandPresetKind {
  try {
    const value = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (value === 'command' || value === 'directory' || value === 'prompt') {
      return value;
    }
  } catch {
    // Ignore storage failures.
  }
  return 'command';
}

export function CommandPresetDialog({
  open,
  activeTabId,
  activeShellType,
  onClose,
  onSendTerminalInput,
}: CommandPresetDialogProps) {
  const {
    presets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
    movePreset,
  } = useCommandPresets();
  const [activeKind, setActiveKind] = useState<CommandPresetKind>(() => readStoredTab());
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [editingDraft, setEditingDraft] = useState<EditingPresetDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CommandPreset | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeKind);
    } catch {
      // Ignore storage failures.
    }
  }, [activeKind]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const activePresets = useMemo(() => {
    return presets
      .filter(preset => preset.kind === activeKind)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [activeKind, presets]);

  const activeTabLabel = TAB_DEFINITIONS.find(tab => tab.kind === activeKind)?.label ?? '';
  const isPrompt = activeKind === 'prompt';

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => setToast(null), 1500);
  }, []);

  const resetForm = useCallback(() => {
    setLabel('');
    setValue('');
    setLocalError(null);
  }, []);

  const handleTabClick = useCallback((kind: CommandPresetKind) => {
    setActiveKind(kind);
    setEditingDraft(null);
    resetForm();
  }, [resetForm]);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextLabel = label.trim();
    if (!nextLabel) {
      setLocalError('라벨을 입력하세요.');
      return;
    }
    if (!value.trim()) {
      setLocalError('내용을 입력하세요.');
      return;
    }

    setSaving(true);
    setLocalError(null);
    try {
      await createPreset({ kind: activeKind, label: nextLabel, value });
      showToast('등록되었습니다.');
      resetForm();
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : '저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }, [activeKind, createPreset, label, resetForm, showToast, value]);

  const handleEdit = useCallback((preset: CommandPreset) => {
    setEditingDraft({
      id: preset.id,
      label: preset.label,
      value: preset.value,
      saving: false,
      error: null,
    });
    setLocalError(null);
  }, []);

  const handleEditDraftChange = useCallback((field: EditingPresetField, nextValue: string) => {
    setEditingDraft(current => current
      ? { ...current, [field]: nextValue, error: null }
      : current);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingDraft(null);
  }, []);

  const handleSaveEdit = useCallback(async (preset: CommandPreset) => {
    const draft = editingDraft;
    if (!draft || draft.id !== preset.id || draft.saving) {
      return;
    }

    const nextLabel = draft.label.trim();
    if (!nextLabel) {
      setEditingDraft(current => current && current.id === preset.id
        ? { ...current, error: '라벨을 입력하세요.' }
        : current);
      return;
    }
    if (!draft.value.trim()) {
      setEditingDraft(current => current && current.id === preset.id
        ? { ...current, error: '내용을 입력하세요.' }
        : current);
      return;
    }

    setEditingDraft(current => current && current.id === preset.id
      ? { ...current, saving: true, error: null }
      : current);
    try {
      await updatePreset(preset.id, { label: nextLabel, value: draft.value });
      setEditingDraft(current => current?.id === preset.id ? null : current);
      showToast('수정되었습니다.');
    } catch (saveError) {
      setEditingDraft(current => current && current.id === preset.id
        ? {
          ...current,
          saving: false,
          error: saveError instanceof Error ? saveError.message : '저장하지 못했습니다.',
        }
        : current);
    }
  }, [editingDraft, showToast, updatePreset]);

  const handleDeleteRequest = useCallback((preset: CommandPreset) => {
    setLocalError(null);
    setDeleteError(null);
    setDeleteTarget(preset);
  }, []);

  const handleCancelDelete = useCallback(() => {
    if (deleteBusy) {
      return;
    }
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deleteBusy]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteBusy) {
      return;
    }

    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deletePreset(deleteTarget.id);
      if (editingDraft?.id === deleteTarget.id) {
        setEditingDraft(null);
      }
      setDeleteTarget(null);
      showToast('삭제되었습니다.');
    } catch (deleteError) {
      setDeleteError(deleteError instanceof Error ? deleteError.message : '삭제하지 못했습니다.');
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deletePreset, deleteTarget, editingDraft?.id, showToast]);

  const handleMove = useCallback(async (preset: CommandPreset, direction: 'up' | 'down') => {
    setLocalError(null);
    try {
      await movePreset(preset.id, direction);
    } catch (moveError) {
      setLocalError(moveError instanceof Error ? moveError.message : '순서를 변경하지 못했습니다.');
    }
  }, [movePreset]);

  const handleCopy = useCallback(async (preset: CommandPreset) => {
    try {
      await copyTextToClipboard(preset.value);
      showToast('복사되었습니다.');
    } catch {
      showToast('복사하지 못했습니다.');
    }
  }, [showToast]);

  const handleExecute = useCallback((preset: CommandPreset) => {
    if (!activeTabId) {
      showToast('활성 터미널이 없습니다.');
      return;
    }

    const input = buildTerminalInput(preset.kind, preset.value, activeShellType);
    if (!input) {
      showToast('실행할 내용이 없습니다.');
      return;
    }

    onSendTerminalInput(activeTabId, input);
    showToast(preset.kind === 'prompt' ? '붙여넣었습니다.' : '실행했습니다.');
  }, [activeShellType, activeTabId, onSendTerminalInput, showToast]);

  if (!open) {
    return null;
  }

  return (
    <>
      <WindowDialog
        dialogId="command-preset-manager"
        title="명령줄 관리"
        mode="modal"
        defaultRect={{ x: 120, y: 80, width: 760, height: 560 }}
        minSize={{ width: 560, height: 420 }}
        onClose={onClose}
      >
        <div className="command-preset-dialog" data-testid="command-preset-dialog">
          <div className="command-preset-tabs" role="tablist" aria-label="명령줄 관리 탭">
            {TAB_DEFINITIONS.map(tab => (
              <button
                key={tab.kind}
                type="button"
                role="tab"
                className={`command-preset-tab${activeKind === tab.kind ? ' is-active' : ''}`}
                aria-selected={activeKind === tab.kind}
                onClick={() => handleTabClick(tab.kind)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <form className={`command-preset-form${isPrompt ? ' command-preset-form-prompt' : ''}`} onSubmit={handleSubmit}>
            <label className="command-preset-field">
              <span>라벨</span>
              <input
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={`${activeTabLabel} 라벨`}
              />
            </label>
            <label className="command-preset-field command-preset-value-field">
              <span>{activeTabLabel}</span>
              {isPrompt ? (
                <textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="프롬프트"
                  rows={5}
                />
              ) : (
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={activeKind === 'directory' ? '디렉토리 경로' : '커맨드 라인'}
                />
              )}
            </label>
            <div className="command-preset-form-actions">
              <button type="submit" className="command-preset-primary-button" disabled={saving}>
                등록
              </button>
            </div>
          </form>

          {(localError || error) && (
            <div className="command-preset-error" role="alert">
              {localError || error}
            </div>
          )}

          <div className="command-preset-list" aria-label={`${activeTabLabel} 목록`}>
            {loading ? (
              <div className="command-preset-empty">불러오는 중...</div>
            ) : activePresets.length === 0 ? (
              <div className="command-preset-empty">등록된 항목이 없습니다.</div>
            ) : (
              activePresets.map((preset, index) => (
                <PresetItem
                  key={preset.id}
                  preset={preset}
                  index={index}
                  count={activePresets.length}
                  editingDraft={editingDraft?.id === preset.id ? editingDraft : null}
                  onCopy={handleCopy}
                  onExecute={handleExecute}
                  onEdit={handleEdit}
                  onEditDraftChange={handleEditDraftChange}
                  onSaveEdit={handleSaveEdit}
                  onCancelEdit={handleCancelEdit}
                  onDelete={handleDeleteRequest}
                  onMove={handleMove}
                />
              ))
            )}
          </div>
        </div>
      </WindowDialog>
      {deleteTarget && (
        <MessageBox
          dialogId={`command-preset-delete-confirm-${deleteTarget.id}`}
          title="삭제 확인"
          message={`${getPresetKindLabel(deleteTarget.kind)} '${deleteTarget.label}' 항목을 삭제하시겠습니까?`}
          okLabel="OK"
          cancelLabel="Cancel"
          okVariant="danger"
          busy={deleteBusy}
          error={deleteError}
          onOk={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
      {toast && <div className="command-preset-toast">{toast}</div>}
    </>
  );
}

function getPresetKindLabel(kind: CommandPresetKind): string {
  return TAB_DEFINITIONS.find(tab => tab.kind === kind)?.label ?? '항목';
}

function PresetItem({
  preset,
  index,
  count,
  editingDraft,
  onCopy,
  onExecute,
  onEdit,
  onEditDraftChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onMove,
}: {
  preset: CommandPreset;
  index: number;
  count: number;
  editingDraft: EditingPresetDraft | null;
  onCopy: (preset: CommandPreset) => void;
  onExecute: (preset: CommandPreset) => void;
  onEdit: (preset: CommandPreset) => void;
  onEditDraftChange: (field: EditingPresetField, value: string) => void;
  onSaveEdit: (preset: CommandPreset) => void;
  onCancelEdit: () => void;
  onDelete: (preset: CommandPreset) => void;
  onMove: (preset: CommandPreset, direction: 'up' | 'down') => void;
}) {
  const isEditing = editingDraft !== null;
  const actions = isEditing ? (
    <div className="command-preset-item-actions">
      <PresetActionButton
        icon="save"
        label={`${preset.label} 저장`}
        onClick={() => onSaveEdit(preset)}
        disabled={editingDraft.saving}
      />
      <PresetActionButton
        icon="cancel"
        label={`${preset.label} 취소`}
        onClick={onCancelEdit}
        disabled={editingDraft.saving}
      />
    </div>
  ) : (
    <div className="command-preset-item-actions">
      <PresetActionButton icon="copy" label={`${preset.label} 복사`} onClick={() => onCopy(preset)} />
      {preset.kind !== 'prompt' && (
        <PresetActionButton icon="play" label={`${preset.label} 실행`} onClick={() => onExecute(preset)} />
      )}
      <PresetActionButton icon="edit" label={`${preset.label} 수정`} onClick={() => onEdit(preset)} />
      <PresetActionButton icon="trash" label={`${preset.label} 삭제`} onClick={() => onDelete(preset)} />
      <PresetActionButton
        icon="arrow-up"
        label={`${preset.label} 위로`}
        onClick={() => onMove(preset, 'up')}
        disabled={index === 0}
      />
      <PresetActionButton
        icon="arrow-down"
        label={`${preset.label} 아래로`}
        onClick={() => onMove(preset, 'down')}
        disabled={index === count - 1}
      />
    </div>
  );
  const valueControl = isEditing ? (
    preset.kind === 'prompt' ? (
      <textarea
        className="command-preset-item-textarea"
        value={editingDraft.value}
        onChange={(event) => onEditDraftChange('value', event.target.value)}
        aria-label={`${preset.label} 프롬프트 수정`}
        readOnly={editingDraft.saving}
        rows={4}
      />
    ) : (
      <input
        value={editingDraft.value}
        onChange={(event) => onEditDraftChange('value', event.target.value)}
        aria-label={`${preset.label} 내용 수정`}
        readOnly={editingDraft.saving}
      />
    )
  ) : (
    preset.kind === 'prompt' ? (
      <textarea className="command-preset-item-textarea" value={preset.value} readOnly rows={4} />
    ) : (
      <input value={preset.value} readOnly />
    )
  );

  return (
    <article className={`command-preset-item command-preset-item-${preset.kind}`}>
      <div className="command-preset-item-header">
        {isEditing ? (
          <input
            className="command-preset-item-label-input"
            value={editingDraft.label}
            maxLength={80}
            onChange={(event) => onEditDraftChange('label', event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={`${preset.label} 라벨 수정`}
            readOnly={editingDraft.saving}
            autoFocus
          />
        ) : (
          <h3>{preset.label}</h3>
        )}
      </div>
      {preset.kind === 'prompt' ? (
        <>
          {valueControl}
          {editingDraft?.error && (
            <div className="command-preset-item-error" role="alert">
              {editingDraft.error}
            </div>
          )}
          <div className="command-preset-prompt-actions">
            {actions}
          </div>
        </>
      ) : (
        <>
          <div className="command-preset-inline-value">
            {valueControl}
            {actions}
          </div>
          {editingDraft?.error && (
            <div className="command-preset-item-error" role="alert">
              {editingDraft.error}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function PresetActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: PresetActionIconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="command-preset-icon-button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <PresetActionIcon name={icon} />
    </button>
  );
}

type PresetActionIconName = 'copy' | 'play' | 'edit' | 'trash' | 'arrow-up' | 'arrow-down' | 'save' | 'cancel';

function PresetActionIcon({ name }: { name: PresetActionIconName }) {
  return (
    <svg
      className="command-preset-action-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'copy' && (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      )}
      {name === 'play' && <path d="M8 5v14l11-7z" />}
      {name === 'edit' && (
        <>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </>
      )}
      {name === 'trash' && (
        <>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v5" />
          <path d="M14 11v5" />
        </>
      )}
      {name === 'arrow-up' && (
        <>
          <path d="M12 19V5" />
          <path d="M5 12l7-7 7 7" />
        </>
      )}
      {name === 'arrow-down' && (
        <>
          <path d="M12 5v14" />
          <path d="M19 12l-7 7-7-7" />
        </>
      )}
      {name === 'save' && <path d="M20 6L9 17l-5-5" />}
      {name === 'cancel' && (
        <>
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </>
      )}
    </svg>
  );
}

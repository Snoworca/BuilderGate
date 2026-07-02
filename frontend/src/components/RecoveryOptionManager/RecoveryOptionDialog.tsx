import { useCallback, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import type { RecoveryOption, RecoveryOptionIcon } from '../../types';
import { useRecoveryOptions } from './useRecoveryOptions';
import '../CommandPresetManager/CommandPresetDialog.css';

export interface RecoveryOptionDialogProps {
  open: boolean;
  onClose: () => void;
}

interface RecoveryOptionDraft {
  id: string | null;
  command: string;
  argumentsText: string;
  enabled: boolean;
  iconMode: 'none' | 'builtin' | 'text';
  iconValue: string;
  saving: boolean;
  error: string | null;
}

const BUILTIN_ICON_OPTIONS = [
  { key: 'bot', label: 'bot' },
  { key: 'terminal', label: 'terminal' },
  { key: 'brain', label: 'brain' },
  { key: 'code', label: 'code' },
  { key: 'sparkles', label: 'sparkles' },
];

const UNSAFE_ICON_HELP_TEXT = 'script, style, markup, URL icon values are rejected by validation.';

// @req FR-AITUI-001
function createBlankDraft(): RecoveryOptionDraft {
  return {
    id: null,
    command: '',
    argumentsText: '',
    enabled: true,
    iconMode: 'none',
    iconValue: '',
    saving: false,
    error: null,
  };
}

// @req FR-AITUI-001
function formatDraftArguments(argumentsList: string[]): string {
  return argumentsList.join('\n');
}

// @req FR-AITUI-001
function optionToDraft(option: RecoveryOption): RecoveryOptionDraft {
  return {
    id: option.id,
    command: option.command,
    argumentsText: formatDraftArguments(option.arguments),
    enabled: option.enabled,
    iconMode: option.icon?.type ?? 'none',
    iconValue: option.icon?.type === 'builtin'
      ? option.icon.key
      : option.icon?.type === 'text'
        ? option.icon.value
        : '',
    saving: false,
    error: null,
  };
}

// @req FR-AITUI-001
function parseDraftArguments(value: string): string[] {
  return value.split(/\r?\n/).filter(argument => argument.trim().length > 0);
}

// @req SEC-AITUI-002
function parseDraftIcon(draft: RecoveryOptionDraft): RecoveryOptionIcon | null {
  const value = draft.iconValue.trim();
  if (draft.iconMode === 'builtin') {
    return value ? { type: 'builtin', key: value } : null;
  }
  if (draft.iconMode === 'text') {
    return value ? { type: 'text', value } : null;
  }
  return null;
}

// @req FR-AITUI-001
function buildDraftPayload(draft: RecoveryOptionDraft): {
  command: string;
  arguments: string[];
  enabled: boolean;
  icon: RecoveryOptionIcon | null;
} {
  return {
    command: draft.command.trim(),
    arguments: parseDraftArguments(draft.argumentsText),
    enabled: draft.enabled,
    icon: parseDraftIcon(draft),
  };
}

// @req FR-AITUI-001
export function RecoveryOptionDialog({ open, onClose }: RecoveryOptionDialogProps) {
  const {
    options,
    loading,
    error,
    createOption,
    updateOption,
    deleteOption,
    moveOption,
  } = useRecoveryOptions();
  const [createDraft, setCreateDraft] = useState<RecoveryOptionDraft | null>(null);
  const [editingDraft, setEditingDraft] = useState<RecoveryOptionDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecoveryOption | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const sortedOptions = useMemo(() => {
    return [...options].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [options]);

  const handleAdd = useCallback(() => {
    setLocalError(null);
    setEditingDraft(null);
    setCreateDraft(createBlankDraft());
  }, []);

  const handleCancelDraft = useCallback(() => {
    setCreateDraft(null);
    setEditingDraft(null);
    setLocalError(null);
  }, []);

  const handleCreateDraftChange = useCallback((nextDraft: RecoveryOptionDraft) => {
    setCreateDraft(nextDraft);
    setLocalError(null);
  }, []);

  const handleEditingDraftChange = useCallback((nextDraft: RecoveryOptionDraft) => {
    setEditingDraft(nextDraft);
    setLocalError(null);
  }, []);

  const handleSaveDraft = useCallback(async (draft: RecoveryOptionDraft) => {
    if (!draft.command.trim()) {
      const message = '명령(command)을 입력하세요.';
      if (draft.id) {
        setEditingDraft(current => current?.id === draft.id ? { ...current, error: message } : current);
      } else {
        setCreateDraft(current => current ? { ...current, error: message } : current);
      }
      setLocalError(message);
      return;
    }

    const payload = buildDraftPayload(draft);
    if (draft.id) {
      setEditingDraft(current => current?.id === draft.id ? { ...current, saving: true, error: null } : current);
    } else {
      setCreateDraft(current => current ? { ...current, saving: true, error: null } : current);
    }
    setLocalError(null);

    try {
      if (draft.id) {
        await updateOption(draft.id, payload);
        setEditingDraft(null);
      } else {
        await createOption(payload);
        setCreateDraft(null);
      }
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '복구 옵션을 저장하지 못했습니다.';
      setLocalError(message);
      if (draft.id) {
        setEditingDraft(current => current?.id === draft.id ? { ...current, saving: false, error: message } : current);
      } else {
        setCreateDraft(current => current ? { ...current, saving: false, error: message } : current);
      }
    }
  }, [createOption, updateOption]);

  const handleSubmitCreate = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createDraft) {
      void handleSaveDraft(createDraft);
    }
  }, [createDraft, handleSaveDraft]);

  const handleEdit = useCallback((option: RecoveryOption) => {
    setCreateDraft(null);
    setLocalError(null);
    setEditingDraft(optionToDraft(option));
  }, []);

  const handleDeleteRequest = useCallback((option: RecoveryOption) => {
    setDeleteError(null);
    setLocalError(null);
    setDeleteTarget(option);
  }, []);

  const handleCancelDelete = useCallback(() => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deleteBusy]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteOption(deleteTarget.id);
      if (editingDraft?.id === deleteTarget.id) {
        setEditingDraft(null);
      }
      setDeleteTarget(null);
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : '복구 옵션을 삭제하지 못했습니다.');
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteOption, deleteTarget, editingDraft?.id]);

  const handleMove = useCallback(async (option: RecoveryOption, direction: 'up' | 'down') => {
    setLocalError(null);
    try {
      await moveOption(option.id, direction);
    } catch (moveError) {
      setLocalError(moveError instanceof Error ? moveError.message : '순서를 변경하지 못했습니다.');
    }
  }, [moveOption]);

  if (!open) {
    return null;
  }

  const visibleError = localError || error;

  return (
    <>
      <WindowDialog
        dialogId="recovery-option-manager"
        title="복구 옵션"
        mode="modal"
        defaultRect={{ x: 140, y: 90, width: 800, height: 560 }}
        minSize={{ width: 580, height: 420 }}
        onClose={onClose}
      >
        <div className="command-preset-dialog" data-testid="recovery-option-dialog">
          <div className="command-preset-form-actions" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: '#bdbdbd', fontSize: '12px' }}>{UNSAFE_ICON_HELP_TEXT}</span>
            <button type="button" className="command-preset-primary-button" onClick={handleAdd}>
              추가
            </button>
          </div>

          {createDraft && (
            <form className="command-preset-form" onSubmit={handleSubmitCreate}>
              <RecoveryOptionDraftFields
                draft={createDraft}
                onChange={handleCreateDraftChange}
                commandLabel="명령(command)"
                argumentsLabel="인수(arguments)"
                iconLabel="아이콘(icon)"
              />
              <div className="command-preset-form-actions">
                <button type="submit" className="command-preset-primary-button" disabled={createDraft.saving}>
                  등록
                </button>
                <button type="button" className="command-preset-secondary-button" onClick={handleCancelDraft} disabled={createDraft.saving}>
                  취소
                </button>
              </div>
            </form>
          )}

          {visibleError && (
            <div className="command-preset-error" role="alert">
              {visibleError}
            </div>
          )}

          <div className="command-preset-list" aria-label="복구 옵션 목록">
            {loading ? (
              <div className="command-preset-empty">불러오는 중...</div>
            ) : sortedOptions.length === 0 ? (
              <div className="command-preset-empty">등록된 복구 옵션이 없습니다.</div>
            ) : (
              sortedOptions.map((option, index) => (
                <RecoveryOptionRow
                  key={option.id}
                  option={option}
                  index={index}
                  count={sortedOptions.length}
                  editingDraft={editingDraft?.id === option.id ? editingDraft : null}
                  onEdit={handleEdit}
                  onDelete={handleDeleteRequest}
                  onMove={handleMove}
                  onDraftChange={handleEditingDraftChange}
                  onSaveDraft={handleSaveDraft}
                  onCancelDraft={handleCancelDraft}
                />
              ))
            )}
          </div>
        </div>
      </WindowDialog>

      {deleteTarget && (
        <MessageBox
          dialogId={`recovery-option-delete-confirm-${deleteTarget.id}`}
          title="삭제 확인"
          message={`'${deleteTarget.command}' 복구 옵션을 삭제하시겠습니까?`}
          okLabel="OK"
          cancelLabel="Cancel"
          okVariant="danger"
          busy={deleteBusy}
          error={deleteError}
          onOk={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
    </>
  );
}

// @req FR-AITUI-001
function RecoveryOptionDraftFields({
  draft,
  onChange,
  commandLabel,
  argumentsLabel,
  iconLabel,
}: {
  draft: RecoveryOptionDraft;
  onChange: (draft: RecoveryOptionDraft) => void;
  commandLabel: string;
  argumentsLabel: string;
  iconLabel: string;
}) {
  return (
    <>
      <label className="command-preset-field">
        <span>{commandLabel}</span>
        <input
          value={draft.command}
          maxLength={120}
          onChange={(event) => onChange({ ...draft, command: event.target.value, error: null })}
          placeholder="claude"
          readOnly={draft.saving}
        />
      </label>
      <label className="command-preset-field">
        <span>{argumentsLabel}</span>
        <textarea
          value={draft.argumentsText}
          onChange={(event) => onChange({ ...draft, argumentsText: event.target.value, error: null })}
          placeholder={'--continue\nworkspace path'}
          readOnly={draft.saving}
          rows={3}
        />
      </label>
      <label className="command-preset-field">
        <span>표시 유형</span>
        <select
          value={draft.iconMode}
          onChange={(event) => {
            const iconMode = event.target.value as RecoveryOptionDraft['iconMode'];
            onChange({
              ...draft,
              iconMode,
              iconValue: iconMode === 'builtin' ? (draft.iconValue || BUILTIN_ICON_OPTIONS[0].key) : draft.iconValue,
              error: null,
            });
          }}
          disabled={draft.saving}
          style={{
            height: '34px',
            background: '#1e1e1e',
            border: '1px solid #4c4c4c',
            borderRadius: '4px',
            color: '#fff',
            padding: '0 8px',
          }}
        >
          <option value="none">없음</option>
          <option value="text">텍스트</option>
          <option value="builtin">기본</option>
        </select>
      </label>
      <label className="command-preset-field">
        <span>{iconLabel}</span>
        {draft.iconMode === 'builtin' ? (
          <select
            value={draft.iconValue || BUILTIN_ICON_OPTIONS[0].key}
            onChange={(event) => onChange({ ...draft, iconValue: event.target.value, error: null })}
            disabled={draft.saving}
            style={{
              height: '34px',
              background: '#1e1e1e',
              border: '1px solid #4c4c4c',
              borderRadius: '4px',
              color: '#fff',
              padding: '0 8px',
            }}
          >
            {BUILTIN_ICON_OPTIONS.map(option => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        ) : (
          <input
            value={draft.iconMode === 'none' ? '' : draft.iconValue}
            maxLength={32}
            onChange={(event) => onChange({
              ...draft,
              iconMode: event.target.value ? 'text' : draft.iconMode,
              iconValue: event.target.value,
              error: null,
            })}
            placeholder="AI"
            readOnly={draft.saving}
          />
        )}
      </label>
      {draft.error && (
        <div className="command-preset-error" role="alert" style={{ gridColumn: '1 / -1' }}>
          {draft.error}
        </div>
      )}
    </>
  );
}

// @req FR-AITUI-001
function RecoveryOptionRow({
  option,
  index,
  count,
  editingDraft,
  onEdit,
  onDelete,
  onMove,
  onDraftChange,
  onSaveDraft,
  onCancelDraft,
}: {
  option: RecoveryOption;
  index: number;
  count: number;
  editingDraft: RecoveryOptionDraft | null;
  onEdit: (option: RecoveryOption) => void;
  onDelete: (option: RecoveryOption) => void;
  onMove: (option: RecoveryOption, direction: 'up' | 'down') => void;
  onDraftChange: (draft: RecoveryOptionDraft) => void;
  onSaveDraft: (draft: RecoveryOptionDraft) => void;
  onCancelDraft: () => void;
}) {
  const iconLabel = getRecoveryIconLabel(option.icon);

  return (
    <article
      className="command-preset-item recovery-option-row"
      data-testid="recovery-option-row"
    >
      {editingDraft ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(120px, 1fr)) auto', gap: '8px', alignItems: 'end' }}>
          <RecoveryOptionDraftFields
            draft={editingDraft}
            onChange={onDraftChange}
            commandLabel={`${option.command} 명령(command) 수정`}
            argumentsLabel={`${option.command} 인수(arguments) 수정`}
            iconLabel={`${option.command} 아이콘(icon) 수정`}
          />
          <div className="command-preset-item-actions">
            <button type="button" onClick={() => onSaveDraft(editingDraft)} disabled={editingDraft.saving} aria-label={`${option.command} 저장`}>
              저장
            </button>
            <button type="button" onClick={onCancelDraft} disabled={editingDraft.saving} aria-label={`${option.command} 취소`}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="command-preset-item-header">
            <h3>
              {iconLabel && (
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    minWidth: '20px',
                    marginRight: '6px',
                    color: '#cbd5e1',
                    fontFamily: 'Consolas, "Courier New", monospace',
                  }}
                >
                  {iconLabel}
                </span>
              )}
              {option.command}
            </h3>
          </div>
          <div className="command-preset-inline-value">
            <textarea
              className="command-preset-item-textarea"
              value={formatDraftArguments(option.arguments)}
              readOnly
              aria-label={`${option.command} 인수`}
              placeholder="인수 없음"
              rows={Math.max(2, Math.min(option.arguments.length, 4))}
            />
            <div className="command-preset-item-actions">
              <button type="button" onClick={() => onEdit(option)} aria-label={`${option.command} 수정`}>
                수정
              </button>
              <button type="button" onClick={() => onDelete(option)} aria-label={`${option.command} 삭제`}>
                삭제
              </button>
              <button type="button" onClick={() => onMove(option, 'up')} disabled={index === 0} aria-label={`${option.command} 위로`}>
                위로
              </button>
              <button type="button" onClick={() => onMove(option, 'down')} disabled={index === count - 1} aria-label={`${option.command} 아래로`}>
                아래로
              </button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}

import { useCallback, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { Icon } from '../common/Icon';
import { Button, Field, Select, TextInput } from '../ui';
import { getRecoveryIconLabel } from '../../types/recoveryOption';
import type { RecoveryOption, RecoveryOptionIcon } from '../../types';
import {
  formatRecoveryDraftArguments,
  parseRecoveryDraftArguments,
} from '../../utils/recoveryOptionArguments';
import { useRecoveryOptions } from './useRecoveryOptions';
import { t } from '../../i18n/i18n.ts';
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
  { key: 'bot', label: '🤖' },
  { key: 'terminal', label: '💻' },
  { key: 'brain', label: '🧠' },
  { key: 'code', label: '🧩' },
  { key: 'sparkles', label: '✨' },
];


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
function optionToDraft(option: RecoveryOption): RecoveryOptionDraft {
  return {
    id: option.id,
    command: option.command,
    argumentsText: formatRecoveryDraftArguments(option.arguments),
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
    arguments: parseRecoveryDraftArguments(draft.argumentsText),
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
      const message = t('recovery.msg.enterCommand');
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
      const message = saveError instanceof Error ? saveError.message : t('recovery.msg.saveFailed');
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
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : t('recovery.msg.deleteFailed'));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deleteOption, deleteTarget, editingDraft?.id]);

  const handleMove = useCallback(async (option: RecoveryOption, direction: 'up' | 'down') => {
    setLocalError(null);
    try {
      await moveOption(option.id, direction);
    } catch (moveError) {
      setLocalError(moveError instanceof Error ? moveError.message : t('recovery.msg.moveFailed'));
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
        title={t('recovery.dialog.title')}
        mode="modal"
        defaultRect={{ x: 140, y: 90, width: 800, height: 560 }}
        minSize={{ width: 580, height: 420 }}
        onClose={onClose}
      >
        <div className="command-preset-dialog" data-testid="recovery-option-dialog">
          <div className="recovery-option-toolbar">
            <span className="recovery-option-help">{t('recovery.icon.unsafeHelp')}</span>
            <Button variant="primary" size="md" icon="plus" className="command-preset-primary-button" onClick={handleAdd}>
              {t('recovery.action.add')}
            </Button>
          </div>

          {createDraft && (
            <form className="command-preset-form recovery-option-form" onSubmit={handleSubmitCreate}>
              <RecoveryOptionDraftFields
                idPrefix="recovery-option-new"
                draft={createDraft}
                onChange={handleCreateDraftChange}
                commandLabel={t('recovery.field.command')}
                argumentsLabel={t('recovery.field.arguments')}
                iconLabel={t('recovery.field.icon')}
              />
              <div className="command-preset-form-actions">
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="command-preset-primary-button"
                  disabled={createDraft.saving}
                >
                  {t('recovery.action.register')}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  className="command-preset-secondary-button"
                  onClick={handleCancelDraft}
                  disabled={createDraft.saving}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          )}

          {visibleError && (
            <div className="command-preset-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{visibleError}</span>
            </div>
          )}

          <div className="command-preset-list" aria-label={t('recovery.list.aria')}>
            {loading ? (
              <div className="command-preset-empty">{t('recovery.list.loading')}</div>
            ) : sortedOptions.length === 0 ? (
              <div className="command-preset-empty">{t('recovery.list.empty')}</div>
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
          title={t('common.deleteConfirm')}
          message={t('recovery.delete.message', { command: deleteTarget.command })}
          okLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
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
  idPrefix,
  draft,
  onChange,
  commandLabel,
  argumentsLabel,
  iconLabel,
}: {
  idPrefix: string;
  draft: RecoveryOptionDraft;
  onChange: (draft: RecoveryOptionDraft) => void;
  commandLabel: string;
  argumentsLabel: string;
  iconLabel: string;
}) {
  return (
    <>
      <Field label={commandLabel} htmlFor={`${idPrefix}-command`} className="command-preset-field">
        <TextInput
          id={`${idPrefix}-command`}
          mono
          value={draft.command}
          maxLength={120}
          onChange={(event) => onChange({ ...draft, command: event.target.value, error: null })}
          placeholder={t('recovery.field.commandPlaceholder')}
          readOnly={draft.saving}
        />
      </Field>
      <Field label={argumentsLabel} htmlFor={`${idPrefix}-arguments`} className="command-preset-field">
        <TextInput
          id={`${idPrefix}-arguments`}
          className="recovery-option-arguments-input"
          mono
          value={draft.argumentsText}
          onChange={(event) => onChange({ ...draft, argumentsText: event.target.value, error: null })}
          placeholder={t('recovery.field.argumentsPlaceholder')}
          readOnly={draft.saving}
        />
      </Field>
      <Field label={t('recovery.field.iconMode')} htmlFor={`${idPrefix}-icon-mode`} className="command-preset-field">
        <Select
          id={`${idPrefix}-icon-mode`}
          className="recovery-option-mode-select"
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
        >
          <option value="none">{t('recovery.iconMode.none')}</option>
          <option value="text">{t('recovery.iconMode.text')}</option>
          <option value="builtin">{t('recovery.iconMode.builtin')}</option>
        </Select>
      </Field>
      <Field label={iconLabel} htmlFor={`${idPrefix}-icon`} className="command-preset-field recovery-option-icon-field">
        {draft.iconMode === 'builtin' ? (
          <Select
            id={`${idPrefix}-icon`}
            className="recovery-option-icon-select"
            value={draft.iconValue || BUILTIN_ICON_OPTIONS[0].key}
            onChange={(event) => onChange({ ...draft, iconValue: event.target.value, error: null })}
            disabled={draft.saving}
          >
            {BUILTIN_ICON_OPTIONS.map(option => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </Select>
        ) : (
          <TextInput
            id={`${idPrefix}-icon`}
            className="recovery-option-icon-text-input"
            value={draft.iconMode === 'none' ? '' : draft.iconValue}
            maxLength={4}
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
      </Field>
      {draft.error && (
        <div className="command-preset-error" role="alert" style={{ gridColumn: '1 / -1' }}>
          <Icon name="alert" size={14} />
          <span>{draft.error}</span>
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

  // The row actions are worded buttons rather than icon buttons: the row is
  // where a user-supplied text icon is shown, and it must stay free of drawn
  // glyphs so that one cannot be mistaken for the other.
  return (
    <article
      className="command-preset-item recovery-option-row"
      data-testid="recovery-option-row"
    >
      {editingDraft ? (
        <div className="recovery-option-edit-grid">
          <RecoveryOptionDraftFields
            idPrefix={`recovery-option-edit-${option.id}`}
            draft={editingDraft}
            onChange={onDraftChange}
            commandLabel={t('recovery.item.editCommandAria', { command: option.command })}
            argumentsLabel={t('recovery.item.editArgumentsAria', { command: option.command })}
            iconLabel={t('recovery.field.icon')}
          />
          <div className="command-preset-item-actions">
            <Button
              variant="primary"
              size="md"
              onClick={() => onSaveDraft(editingDraft)}
              disabled={editingDraft.saving}
              aria-label={t('recovery.item.saveAria', { command: option.command })}
            >
              {t('common.save')}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={onCancelDraft}
              disabled={editingDraft.saving}
              aria-label={t('recovery.item.cancelAria', { command: option.command })}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="command-preset-item-header">
            <h3>
              {iconLabel && (
                <span className="recovery-option-icon-label" aria-hidden="true">
                  {iconLabel}
                </span>
              )}
              {option.command}
            </h3>
          </div>
          <div className="command-preset-inline-value">
            <TextInput
              className="recovery-option-arguments-display"
              mono
              value={formatRecoveryDraftArguments(option.arguments)}
              readOnly
              aria-label={t('recovery.item.argumentsAria', { command: option.command })}
              placeholder={t('recovery.item.noArguments')}
              title={formatRecoveryDraftArguments(option.arguments)}
            />
            <div className="command-preset-item-actions">
              <Button variant="secondary" size="md" onClick={() => onEdit(option)} aria-label={t('recovery.item.editAria', { command: option.command })}>
                {t('recovery.item.edit')}
              </Button>
              <Button variant="danger-text" size="md" onClick={() => onDelete(option)} aria-label={t('recovery.item.deleteAria', { command: option.command })}>
                {t('common.delete')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => onMove(option, 'up')}
                disabled={index === 0}
                aria-label={t('recovery.item.moveUpAria', { command: option.command })}
              >
                {t('recovery.item.moveUp')}
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => onMove(option, 'down')}
                disabled={index === count - 1}
                aria-label={t('recovery.item.moveDownAria', { command: option.command })}
              >
                {t('recovery.item.moveDown')}
              </Button>
            </div>
          </div>
        </>
      )}
    </article>
  );
}

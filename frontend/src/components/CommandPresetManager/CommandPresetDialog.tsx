import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { Icon } from '../common/Icon';
import { IconButton } from '../common/IconButton';
import type { IconName } from '../common/iconGlyphs';
import { Button, Field, TextInput } from '../ui';
import { buildTerminalInput } from './commandPresetExecution';
import { buildCommandPresetPasteInput } from './commandPresetPaste';
import { useCommandPresets } from './useCommandPresets';
import type { CommandPreset, CommandPresetKind } from '../../types';
import type { TerminalClipboardActionResult } from '../../utils/terminalClipboardCoordinator';
import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import './CommandPresetDialog.css';

export interface CommandPresetDialogProps {
  open: boolean;
  activeTabId: string | null;
  activeShellType: string | null;
  onClose: () => void;
  onSendTerminalInput: (tabId: string, data: string) => void;
  onPasteTerminalInput: (tabId: string, data: string) => TerminalClipboardActionResult;
}

const ACTIVE_TAB_STORAGE_KEY = 'buildergate.commandPresetManager.activeTab';
const TAB_DEFINITIONS: Array<{ kind: CommandPresetKind; labelKey: MessageKey }> = [
  { kind: 'command', labelKey: 'preset.kind.command' },
  { kind: 'directory', labelKey: 'preset.kind.directory' },
  { kind: 'prompt', labelKey: 'preset.kind.prompt' },
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
      throw new Error(t('preset.msg.clipboardFailed'));
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
  onPasteTerminalInput,
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

  const activeTabLabelKey = TAB_DEFINITIONS.find(tab => tab.kind === activeKind)?.labelKey;
  const activeTabLabel = activeTabLabelKey ? t(activeTabLabelKey) : '';
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
      setLocalError(t('preset.msg.enterLabel'));
      return;
    }
    if (!value.trim()) {
      setLocalError(t('preset.msg.enterValue'));
      return;
    }

    setSaving(true);
    setLocalError(null);
    try {
      await createPreset({ kind: activeKind, label: nextLabel, value });
      showToast(t('preset.msg.added'));
      resetForm();
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : t('common.saveFailed'));
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
        ? { ...current, error: t('preset.msg.enterLabel') }
        : current);
      return;
    }
    if (!draft.value.trim()) {
      setEditingDraft(current => current && current.id === preset.id
        ? { ...current, error: t('preset.msg.enterValue') }
        : current);
      return;
    }

    setEditingDraft(current => current && current.id === preset.id
      ? { ...current, saving: true, error: null }
      : current);
    try {
      await updatePreset(preset.id, { label: nextLabel, value: draft.value });
      setEditingDraft(current => current?.id === preset.id ? null : current);
      showToast(t('preset.msg.updated'));
    } catch (saveError) {
      setEditingDraft(current => current && current.id === preset.id
        ? {
          ...current,
          saving: false,
          error: saveError instanceof Error ? saveError.message : t('common.saveFailed'),
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
      showToast(t('preset.msg.deleted'));
    } catch (deleteError) {
      setDeleteError(deleteError instanceof Error ? deleteError.message : t('preset.msg.deleteFailed'));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deletePreset, deleteTarget, editingDraft?.id, showToast]);

  const handleMove = useCallback(async (preset: CommandPreset, direction: 'up' | 'down') => {
    setLocalError(null);
    try {
      await movePreset(preset.id, direction);
    } catch (moveError) {
      setLocalError(moveError instanceof Error ? moveError.message : t('preset.msg.moveFailed'));
    }
  }, [movePreset]);

  const handleCopy = useCallback(async (preset: CommandPreset) => {
    try {
      await copyTextToClipboard(preset.value);
      showToast(t('preset.msg.copied'));
    } catch {
      showToast(t('preset.msg.copyFailed'));
    }
  }, [showToast]);

  const handleExecute = useCallback((preset: CommandPreset) => {
    if (!activeTabId) {
      showToast(t('preset.msg.noTerminal'));
      return;
    }

    if (preset.kind === 'prompt') {
      const validation = buildCommandPresetPasteInput(preset);
      if (!validation.ok) {
        showToast(t('preset.msg.cannotPaste'));
        return;
      }

      const result = onPasteTerminalInput(activeTabId, validation.data);
      showToast(result.ok ? t('preset.msg.pasted') : t('preset.msg.pasteFailed'));
      return;
    }

    const input = buildTerminalInput(preset.kind, preset.value, activeShellType);
    if (!input) {
      showToast(t('preset.msg.nothingToRun'));
      return;
    }

    onSendTerminalInput(activeTabId, input);
    showToast(t('preset.msg.ran'));
  }, [activeShellType, activeTabId, onPasteTerminalInput, onSendTerminalInput, showToast]);

  if (!open) {
    return null;
  }

  return (
    <>
      <WindowDialog
        dialogId="command-preset-manager"
        title={t('preset.dialog.title')}
        mode="modal"
        defaultRect={{ x: 120, y: 80, width: 760, height: 560 }}
        minSize={{ width: 560, height: 420 }}
        onClose={onClose}
      >
        <div className="command-preset-dialog" data-testid="command-preset-dialog">
          <div className="command-preset-tabs" role="tablist" aria-label={t('preset.dialog.tabsAria')}>
            {TAB_DEFINITIONS.map(tab => (
              <button
                key={tab.kind}
                type="button"
                role="tab"
                className={`command-preset-tab${activeKind === tab.kind ? ' is-active' : ''}`}
                aria-selected={activeKind === tab.kind}
                onClick={() => handleTabClick(tab.kind)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          <form className={`command-preset-form${isPrompt ? ' command-preset-form-prompt' : ''}`} onSubmit={handleSubmit}>
            <Field label={t('preset.field.label')} htmlFor="command-preset-new-label" className="command-preset-field">
              <TextInput
                id="command-preset-new-label"
                value={label}
                maxLength={80}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('preset.field.labelPlaceholder', { kind: activeTabLabel })}
              />
            </Field>
            <Field
              label={activeTabLabel}
              htmlFor="command-preset-new-value"
              className="command-preset-field command-preset-value-field"
            >
              {isPrompt ? (
                <textarea
                  id="command-preset-new-value"
                  className="ui-input command-preset-textarea"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={t('preset.field.promptPlaceholder')}
                  rows={5}
                />
              ) : (
                <TextInput
                  id="command-preset-new-value"
                  mono
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={activeKind === 'directory' ? t('preset.field.directoryPlaceholder') : t('preset.field.commandPlaceholder')}
                />
              )}
            </Field>
            <div className="command-preset-form-actions">
              <Button
                type="submit"
                variant="primary"
                size="md"
                icon="plus"
                className="command-preset-primary-button"
                disabled={saving}
              >
                {t('preset.action.add')}
              </Button>
            </div>
          </form>

          {(localError || error) && (
            <div className="command-preset-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{localError || error}</span>
            </div>
          )}

          <div className="command-preset-list" aria-label={t('preset.list.aria', { kind: activeTabLabel })}>
            {loading ? (
              <div className="command-preset-empty">{t('preset.list.loading')}</div>
            ) : activePresets.length === 0 ? (
              <div className="command-preset-empty">{t('preset.list.empty')}</div>
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
          title={t('common.deleteConfirm')}
          message={t('preset.delete.message', { kind: getPresetKindLabel(deleteTarget.kind), label: deleteTarget.label })}
          okLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          okVariant="danger"
          busy={deleteBusy}
          error={deleteError}
          onOk={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}
      {toast && <div className="command-preset-toast" role="status">{toast}</div>}
    </>
  );
}

function getPresetKindLabel(kind: CommandPresetKind): string {
  const labelKey = TAB_DEFINITIONS.find(tab => tab.kind === kind)?.labelKey;
  return labelKey ? t(labelKey) : t('preset.kind.item');
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
        icon="check"
        label={t('preset.item.saveAria', { label: preset.label })}
        onClick={() => onSaveEdit(preset)}
        disabled={editingDraft.saving}
      />
      <PresetActionButton
        icon="close"
        label={t('preset.item.cancelAria', { label: preset.label })}
        onClick={onCancelEdit}
        disabled={editingDraft.saving}
      />
    </div>
  ) : (
    <div className="command-preset-item-actions">
      <PresetActionButton icon="copy" label={t('preset.item.copyAria', { label: preset.label })} onClick={() => onCopy(preset)} />
      {/* The set has no play or paste glyph; both actions hand the item to the
          active terminal, so both draw the terminal. */}
      {preset.kind === 'prompt' ? (
        <PresetActionButton icon="terminal" label={t('preset.item.applyAria', { label: preset.label })} onClick={() => onExecute(preset)} />
      ) : (
        <PresetActionButton icon="terminal" label={t('preset.item.runAria', { label: preset.label })} onClick={() => onExecute(preset)} />
      )}
      <PresetActionButton icon="edit" label={t('preset.item.editAria', { label: preset.label })} onClick={() => onEdit(preset)} />
      <PresetActionButton icon="trash" label={t('preset.item.deleteAria', { label: preset.label })} onClick={() => onDelete(preset)} />
      {/* No chevron-up in the set: the up button turns chevron-down over. */}
      <PresetActionButton
        icon="chevron-down"
        label={t('preset.item.moveUpAria', { label: preset.label })}
        onClick={() => onMove(preset, 'up')}
        disabled={index === 0}
        className="command-preset-move-up"
      />
      <PresetActionButton
        icon="chevron-down"
        label={t('preset.item.moveDownAria', { label: preset.label })}
        onClick={() => onMove(preset, 'down')}
        disabled={index === count - 1}
      />
    </div>
  );
  const valueControl = isEditing ? (
    preset.kind === 'prompt' ? (
      <textarea
        className="ui-input command-preset-item-textarea"
        value={editingDraft.value}
        onChange={(event) => onEditDraftChange('value', event.target.value)}
        aria-label={t('preset.item.editPromptAria', { label: preset.label })}
        readOnly={editingDraft.saving}
        rows={4}
      />
    ) : (
      <TextInput
        mono
        value={editingDraft.value}
        onChange={(event) => onEditDraftChange('value', event.target.value)}
        aria-label={t('preset.item.editValueAria', { label: preset.label })}
        readOnly={editingDraft.saving}
      />
    )
  ) : (
    preset.kind === 'prompt' ? (
      <textarea className="ui-input command-preset-item-textarea" value={preset.value} readOnly rows={4} />
    ) : (
      <TextInput mono value={preset.value} readOnly />
    )
  );

  return (
    <article className={`command-preset-item command-preset-item-${preset.kind}`}>
      <div className="command-preset-item-header">
        {isEditing ? (
          <TextInput
            className="command-preset-item-label-input"
            value={editingDraft.label}
            maxLength={80}
            onChange={(event) => onEditDraftChange('label', event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={t('preset.item.editLabelAria', { label: preset.label })}
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
              <Icon name="alert" size={14} />
              <span>{editingDraft.error}</span>
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
              <Icon name="alert" size={14} />
              <span>{editingDraft.error}</span>
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
  className,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <IconButton
      icon={icon}
      label={label}
      className={['command-preset-icon-button', className].filter(Boolean).join(' ')}
      onClick={onClick}
      disabled={disabled}
    />
  );
}

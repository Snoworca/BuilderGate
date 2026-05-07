import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { WindowDialog } from '../dialog';
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
  const [editingId, setEditingId] = useState<string | null>(null);
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
    setEditingId(null);
    setLocalError(null);
  }, []);

  const handleTabClick = useCallback((kind: CommandPresetKind) => {
    setActiveKind(kind);
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
      if (editingId) {
        await updatePreset(editingId, { label: nextLabel, value });
        showToast('수정되었습니다.');
      } else {
        await createPreset({ kind: activeKind, label: nextLabel, value });
        showToast('등록되었습니다.');
      }
      resetForm();
    } catch (submitError) {
      setLocalError(submitError instanceof Error ? submitError.message : '저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }, [activeKind, createPreset, editingId, label, resetForm, showToast, updatePreset, value]);

  const handleEdit = useCallback((preset: CommandPreset) => {
    setActiveKind(preset.kind);
    setEditingId(preset.id);
    setLabel(preset.label);
    setValue(preset.value);
    setLocalError(null);
  }, []);

  const handleDelete = useCallback(async (preset: CommandPreset) => {
    setLocalError(null);
    try {
      await deletePreset(preset.id);
      if (editingId === preset.id) {
        resetForm();
      }
      showToast('삭제되었습니다.');
    } catch (deleteError) {
      setLocalError(deleteError instanceof Error ? deleteError.message : '삭제하지 못했습니다.');
    }
  }, [deletePreset, editingId, resetForm, showToast]);

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

          <form className="command-preset-form" onSubmit={handleSubmit}>
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
                  placeholder="여러 줄 프롬프트"
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
              {editingId && (
                <button type="button" className="command-preset-secondary-button" onClick={resetForm}>
                  취소
                </button>
              )}
              <button type="submit" className="command-preset-primary-button" disabled={saving}>
                {editingId ? '저장' : '등록'}
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
                  onCopy={handleCopy}
                  onExecute={handleExecute}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onMove={handleMove}
                />
              ))
            )}
          </div>
        </div>
      </WindowDialog>
      {toast && <div className="command-preset-toast">{toast}</div>}
    </>
  );
}

function PresetItem({
  preset,
  index,
  count,
  onCopy,
  onExecute,
  onEdit,
  onDelete,
  onMove,
}: {
  preset: CommandPreset;
  index: number;
  count: number;
  onCopy: (preset: CommandPreset) => void;
  onExecute: (preset: CommandPreset) => void;
  onEdit: (preset: CommandPreset) => void;
  onDelete: (preset: CommandPreset) => void;
  onMove: (preset: CommandPreset, direction: 'up' | 'down') => void;
}) {
  const actions = (
    <div className="command-preset-item-actions">
      <button type="button" onClick={() => onCopy(preset)} aria-label={`${preset.label} 복사`}>
        복사
      </button>
      <button type="button" onClick={() => onExecute(preset)} aria-label={`${preset.label} 실행`}>
        실행
      </button>
      <button type="button" onClick={() => onEdit(preset)} aria-label={`${preset.label} 수정`}>
        수정
      </button>
      <button type="button" onClick={() => onDelete(preset)} aria-label={`${preset.label} 삭제`}>
        삭제
      </button>
      <button
        type="button"
        onClick={() => onMove(preset, 'up')}
        disabled={index === 0}
        aria-label={`${preset.label} 위로`}
      >
        위
      </button>
      <button
        type="button"
        onClick={() => onMove(preset, 'down')}
        disabled={index === count - 1}
        aria-label={`${preset.label} 아래로`}
      >
        아래
      </button>
    </div>
  );

  return (
    <article className={`command-preset-item command-preset-item-${preset.kind}`}>
      <div className="command-preset-item-header">
        <h3>{preset.label}</h3>
      </div>
      {preset.kind === 'prompt' ? (
        <>
          <textarea className="command-preset-item-textarea" value={preset.value} readOnly rows={4} />
          <div className="command-preset-prompt-actions">
            {actions}
          </div>
        </>
      ) : (
        <div className="command-preset-inline-value">
          <input value={preset.value} readOnly />
          {actions}
        </div>
      )}
    </article>
  );
}

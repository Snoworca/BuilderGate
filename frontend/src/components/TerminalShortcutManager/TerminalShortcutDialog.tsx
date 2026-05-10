import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import type {
  TerminalShortcutAction,
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutProfile,
  TerminalShortcutScope,
} from '../../types';
import {
  buildTerminalShortcutKeyDescriptor,
  getActiveTerminalShortcutProfile,
} from '../../utils/terminalShortcutBindings';
import { useTerminalShortcutContext } from './TerminalShortcutContext';
import { ShortcutBindingList } from './ShortcutBindingList';
import { ShortcutCapturePanel } from './ShortcutCapturePanel';
import {
  TERMINAL_SHORTCUT_PROFILE_OPTIONS,
  TERMINAL_SHORTCUT_SCOPE_OPTIONS,
  actionLabel,
  bindingKeyLabel,
  defaultActionForDescriptor,
  defaultSendAction,
  isCustomControlAction,
  profileLabel,
  scopeLabel,
} from './shortcutBindingViewModel';
import './TerminalShortcutDialog.css';

export interface TerminalShortcutDialogProps {
  open: boolean;
  activeTabId: string | null;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  onClose: () => void;
  onSendTerminalInput: (tabId: string, data: string) => void;
}

type TerminalShortcutTab = 'capture' | 'bindings' | 'profiles';
type CaptureStatus = 'idle' | 'waiting' | 'captured' | 'timeout';

const ACTIVE_TAB_STORAGE_KEY = 'buildergate.terminalShortcutManager.activeTab';
const CAPTURE_TIMEOUT_MS = 5000;
const TAB_DEFINITIONS: Array<{ id: TerminalShortcutTab; label: string }> = [
  { id: 'capture', label: '캡처' },
  { id: 'bindings', label: '등록 목록' },
  { id: 'profiles', label: '프로필' },
];

function readStoredTab(): TerminalShortcutTab {
  try {
    const value = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (value === 'capture' || value === 'bindings' || value === 'profiles') {
      return value;
    }
  } catch {
    // Ignore storage failures.
  }
  return 'capture';
}

function defaultScope(activeWorkspaceId: string | null): TerminalShortcutScope {
  return activeWorkspaceId ? 'workspace' : 'global';
}

export function TerminalShortcutDialog({
  open,
  activeTabId,
  activeWorkspaceId,
  activeSessionId,
  onClose,
  onSendTerminalInput,
}: TerminalShortcutDialogProps) {
  const shortcuts = useTerminalShortcutContext();
  const [activeTab, setActiveTab] = useState<TerminalShortcutTab>(() => readStoredTab());
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>('idle');
  const [capturedDescriptor, setCapturedDescriptor] = useState<TerminalShortcutKeyDescriptor | null>(null);
  const [scope, setScope] = useState<TerminalShortcutScope>(() => defaultScope(activeWorkspaceId));
  const [description, setDescription] = useState('');
  const [action, setAction] = useState<TerminalShortcutAction>(() => defaultSendAction());
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [lastTestResult, setLastTestResult] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TerminalShortcutBinding | null>(null);
  const [editingTarget, setEditingTarget] = useState<TerminalShortcutBinding | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmCustomSave, setConfirmCustomSave] = useState(false);
  const [profileScope, setProfileScope] = useState<TerminalShortcutScope>(() => defaultScope(activeWorkspaceId));
  const activeProfile = getActiveTerminalShortcutProfile(
    shortcuts.state,
    activeWorkspaceId,
    activeSessionId ?? '',
  );
  const [profileDraft, setProfileDraft] = useState<TerminalShortcutProfile>(activeProfile);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRefs = useRef(new Map<TerminalShortcutTab, HTMLButtonElement | null>());

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
    } catch {
      // Ignore storage failures.
    }
  }, [activeTab]);

  useEffect(() => {
    setProfileDraft(activeProfile);
  }, [activeProfile]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const currentError = localError ?? shortcuts.error;
  const visibleBindings = useMemo(() => shortcuts.state?.bindings ?? [], [shortcuts.state]);
  const canUseWorkspaceScope = Boolean(activeWorkspaceId || editingTarget?.scope === 'workspace');
  const canUseSessionScope = Boolean(activeSessionId || editingTarget?.scope === 'session');

  const changeActiveTab = useCallback((nextTab: TerminalShortcutTab) => {
    setActiveTab(nextTab);
    setLocalError(null);
    requestAnimationFrame(() => tabRefs.current.get(nextTab)?.focus());
  }, []);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TAB_DEFINITIONS.findIndex(tab => tab.id === activeTab);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TAB_DEFINITIONS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TAB_DEFINITIONS.length) % TAB_DEFINITIONS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TAB_DEFINITIONS.length - 1;
    else return;

    event.preventDefault();
    changeActiveTab(TAB_DEFINITIONS[nextIndex].id);
  }, [activeTab, changeActiveTab]);

  const startCapture = useCallback(() => {
    setActiveTab('capture');
    setLocalError(null);
    setLastTestResult(null);
    setCapturedDescriptor(null);
    setCaptureStatus('waiting');
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setCaptureStatus(current => current === 'waiting' ? 'timeout' : current);
      setCapturedDescriptor(current => current);
    }, CAPTURE_TIMEOUT_MS);
  }, []);

  const handleCaptureKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (activeTab !== 'capture' || captureStatus !== 'waiting') {
      return false;
    }
    if (event.repeat) {
      return true;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const descriptor = buildTerminalShortcutKeyDescriptor(event);
    setCapturedDescriptor(descriptor);
    if (!editingTarget) {
      setAction(defaultActionForDescriptor(descriptor));
    }
    setCaptureStatus('captured');
    setLocalError(null);
    return true;
  }, [activeTab, captureStatus, editingTarget]);

  const buildScopeTarget = useCallback((targetScope: TerminalShortcutScope, existing?: TerminalShortcutBinding | null) => {
    if (existing?.scope === targetScope) {
      if (targetScope === 'workspace' && existing.workspaceId) {
        return { scope: targetScope, workspaceId: existing.workspaceId };
      }
      if (targetScope === 'session' && existing.sessionId) {
        return { scope: targetScope, sessionId: existing.sessionId };
      }
      if (targetScope === 'global') {
        return { scope: targetScope };
      }
    }
    if (targetScope === 'workspace') {
      if (!activeWorkspaceId) throw new Error('활성 워크스페이스가 없습니다.');
      return { scope: targetScope, workspaceId: activeWorkspaceId };
    }
    if (targetScope === 'session') {
      if (!activeSessionId) throw new Error('활성 세션이 없습니다.');
      return { scope: targetScope, sessionId: activeSessionId };
    }
    return { scope: targetScope };
  }, [activeSessionId, activeWorkspaceId]);

  const runSave = useCallback(async () => {
    if (!capturedDescriptor) {
      setLocalError('먼저 단축키를 감지하세요.');
      return;
    }
    if (action.type === 'send' && action.data.length === 0) {
      setLocalError('전송할 문자열을 입력하세요.');
      return;
    }

    setSaving(true);
    setLocalError(null);
    try {
      const input = {
        ...buildScopeTarget(scope, editingTarget),
        ...capturedDescriptor,
        action,
        description: description.trim() || undefined,
      };
      if (editingTarget) {
        await shortcuts.updateBinding(editingTarget.id, input);
      } else {
        await shortcuts.createBinding(input);
      }
      setCaptureStatus('idle');
      setCapturedDescriptor(null);
      setDescription('');
      setEditingTarget(null);
      setLastTestResult(editingTarget ? '수정되었습니다.' : '저장되었습니다.');
      setActiveTab('bindings');
    } catch (saveError) {
      setLocalError(saveError instanceof Error ? saveError.message : '저장하지 못했습니다.');
    } finally {
      setSaving(false);
      setConfirmCustomSave(false);
    }
  }, [action, buildScopeTarget, capturedDescriptor, description, editingTarget, scope, shortcuts]);

  const handleSave = useCallback(() => {
    if (isCustomControlAction(action)) {
      setConfirmCustomSave(true);
      return;
    }
    void runSave();
  }, [action, runSave]);

  const handleTestSend = useCallback((nextAction: TerminalShortcutAction = action) => {
    if (nextAction.type !== 'send') return;
    if (!activeTabId) {
      setLastTestResult(null);
      setLocalError('활성 터미널이 없습니다.');
      return;
    }
    onSendTerminalInput(activeTabId, nextAction.data);
    setLocalError(null);
    setLastTestResult(`${actionLabel(nextAction)} 완료`);
  }, [action, activeTabId, onSendTerminalInput]);

  const handleToggleBinding = useCallback(async (binding: TerminalShortcutBinding) => {
    setBusyId(binding.id);
    setLocalError(null);
    try {
      await shortcuts.updateBinding(binding.id, { enabled: !binding.enabled });
    } catch (toggleError) {
      setLocalError(toggleError instanceof Error ? toggleError.message : '상태를 바꾸지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  }, [shortcuts]);

  const handleEditBinding = useCallback((binding: TerminalShortcutBinding) => {
    setEditingTarget(binding);
    setCapturedDescriptor({
      key: binding.key,
      code: binding.code,
      ctrlKey: binding.ctrlKey,
      shiftKey: binding.shiftKey,
      altKey: binding.altKey,
      metaKey: binding.metaKey,
      location: binding.location,
      repeat: false,
    });
    setScope(binding.scope);
    setDescription(binding.description ?? '');
    setAction(binding.action);
    setCaptureStatus('captured');
    setLocalError(null);
    setLastTestResult(null);
    setActiveTab('capture');
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingTarget(null);
    setCapturedDescriptor(null);
    setDescription('');
    setAction(defaultSendAction());
    setCaptureStatus('idle');
    setLocalError(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setDeleteError(null);
    try {
      await shortcuts.deleteBinding(deleteTarget.id);
      setDeleteTarget(null);
    } catch (deleteFailure) {
      setDeleteError(deleteFailure instanceof Error ? deleteFailure.message : '삭제하지 못했습니다.');
    } finally {
      setBusyId(null);
    }
  }, [deleteTarget, shortcuts]);

  const handleApplyProfile = useCallback(async () => {
    setSaving(true);
    setLocalError(null);
    try {
      await shortcuts.setProfile({
        ...buildScopeTarget(profileScope),
        profile: profileDraft,
      });
      setLastTestResult(`${scopeLabel(profileScope)} 프로필이 ${profileLabel(profileDraft)}로 변경되었습니다.`);
    } catch (profileError) {
      setLocalError(profileError instanceof Error ? profileError.message : '프로필을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }, [buildScopeTarget, profileDraft, profileScope, shortcuts]);

  if (!open) {
    return null;
  }

  return (
    <>
      <WindowDialog
        dialogId="terminal-shortcut-manager"
        title="터미널 키보드"
        mode="modal"
        defaultRect={{ x: 180, y: 96, width: 760, height: 560 }}
        minSize={{ width: 580, height: 420 }}
        onClose={onClose}
        surfaceClassName="terminal-shortcut-dialog-surface"
        keyboardCapture={{
          active: activeTab === 'capture' && captureStatus === 'waiting',
          onKeyDown: handleCaptureKeyDown,
        }}
      >
        <div className="terminal-shortcut-dialog" data-testid="terminal-shortcut-dialog">
          <div
            className="terminal-shortcut-tabs"
            role="tablist"
            aria-label="터미널 키보드 설정"
            onKeyDown={handleTabKeyDown}
          >
            {TAB_DEFINITIONS.map(tab => (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current.set(tab.id, node);
                }}
                id={`terminal-shortcut-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`terminal-shortcut-panel-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                className={`terminal-shortcut-tab${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => changeActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {shortcuts.loading && (
            <div className="terminal-shortcut-loading" role="status">불러오는 중</div>
          )}

          <section
            id="terminal-shortcut-panel-capture"
            role="tabpanel"
            aria-labelledby="terminal-shortcut-tab-capture"
            hidden={activeTab !== 'capture'}
            className="terminal-shortcut-panel"
          >
            <ShortcutCapturePanel
              captureStatus={captureStatus}
              capturedDescriptor={capturedDescriptor}
              scope={scope}
              description={description}
              action={action}
              saving={saving}
              canUseWorkspaceScope={canUseWorkspaceScope}
              canUseSessionScope={canUseSessionScope}
              error={currentError}
              lastTestResult={lastTestResult}
              editingLabel={editingTarget ? bindingKeyLabel(editingTarget) : null}
              onScopeChange={setScope}
              onDescriptionChange={setDescription}
              onActionChange={setAction}
              onStartCapture={startCapture}
              onSave={handleSave}
              onTestSend={() => handleTestSend(action)}
              onCancelEdit={handleCancelEdit}
            />
          </section>

          <section
            id="terminal-shortcut-panel-bindings"
            role="tabpanel"
            aria-labelledby="terminal-shortcut-tab-bindings"
            hidden={activeTab !== 'bindings'}
            className="terminal-shortcut-panel"
          >
            {currentError && <div className="terminal-shortcut-error" role="alert">{currentError}</div>}
            {lastTestResult && <div className="terminal-shortcut-toast" role="status">{lastTestResult}</div>}
            <ShortcutBindingList
              bindings={visibleBindings}
              busyId={busyId}
              onToggle={handleToggleBinding}
              onEdit={handleEditBinding}
              onDelete={(binding) => {
                setDeleteError(null);
                setDeleteTarget(binding);
              }}
              onTest={(binding) => handleTestSend(binding.action)}
            />
          </section>

          <section
            id="terminal-shortcut-panel-profiles"
            role="tabpanel"
            aria-labelledby="terminal-shortcut-tab-profiles"
            hidden={activeTab !== 'profiles'}
            className="terminal-shortcut-panel terminal-shortcut-profile-panel"
          >
            <div className="terminal-shortcut-profile-current">
              현재 적용: {profileLabel(activeProfile)}
            </div>
            <div className="terminal-shortcut-form-grid">
              <label className="terminal-shortcut-field">
                <span>범위</span>
                <select
                  value={profileScope}
                  onChange={(event) => setProfileScope(event.target.value as TerminalShortcutScope)}
                  aria-label="프로필 적용 범위"
                >
                  {TERMINAL_SHORTCUT_SCOPE_OPTIONS.map(option => (
                    <option
                      key={option.scope}
                      value={option.scope}
                      disabled={(option.scope === 'workspace' && !canUseWorkspaceScope) || (option.scope === 'session' && !canUseSessionScope)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="terminal-shortcut-field">
                <span>프로필</span>
                <select
                  value={profileDraft}
                  onChange={(event) => setProfileDraft(event.target.value as TerminalShortcutProfile)}
                  aria-label="터미널 키보드 프로필"
                >
                  {TERMINAL_SHORTCUT_PROFILE_OPTIONS.map(option => (
                    <option key={option.profile} value={option.profile}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {currentError && <div className="terminal-shortcut-error" role="alert">{currentError}</div>}
            {lastTestResult && <div className="terminal-shortcut-toast" role="status">{lastTestResult}</div>}
            <div className="terminal-shortcut-actions">
              <button
                type="button"
                className="terminal-shortcut-primary-button"
                onClick={handleApplyProfile}
                disabled={saving}
              >
                적용
              </button>
            </div>
          </section>
        </div>
      </WindowDialog>

      {deleteTarget && (
        <MessageBox
          dialogId="terminal-shortcut-delete-confirm"
          title="삭제 확인"
          message={`${bindingKeyLabel(deleteTarget)} 단축키를 삭제합니다.`}
          okLabel="OK"
          cancelLabel="Cancel"
          okVariant="danger"
          busy={busyId === deleteTarget.id}
          error={deleteError}
          onOk={handleConfirmDelete}
          onCancel={() => {
            if (busyId) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
        />
      )}

      {confirmCustomSave && (
        <MessageBox
          dialogId="terminal-shortcut-custom-confirm"
          title="커스텀 전송 확인"
          message="제어 문자가 포함된 사용자 전송 문자열을 저장합니다."
          okLabel="OK"
          cancelLabel="Cancel"
          busy={saving}
          error={localError}
          onOk={() => void runSave()}
          onCancel={() => {
            if (saving) return;
            setConfirmCustomSave(false);
          }}
        />
      )}
    </>
  );
}

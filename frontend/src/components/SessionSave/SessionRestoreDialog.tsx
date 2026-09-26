// FR-AITUI-009 AC-4 — see the command each saved tab will get, pick which to
// resume (exact ids checked by default), resume them, see what happened.
import { useMemo, useState } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { Icon } from '../common/Icon.tsx';
import { Button, Chip, DialogFooter, ProgressBar, SelectableRow, Spinner } from '../ui/index.ts';
import { AgentMark } from './AgentMark.tsx';
import {
  defaultRestoreSelection,
  formatSavedAt,
  groupByWorkspace,
  pendingEntries,
  resumeCommandPreview,
  type SnapshotEntry,
  type SnapshotRestoreState,
  type SnapshotStatus,
} from './sessionSnapshotModel.ts';
import './SessionSave.css';

export interface SessionRestoreDialogProps {
  status: SnapshotStatus;
  onClose: () => void;
  onRestore: (tabIds: string[]) => Promise<Array<{ tabId: string; restore: SnapshotRestoreState }>>;
  onDiscard: () => Promise<void>;
}

type Step = 'select' | 'working' | 'done' | 'error';

function centeredRect(width: number, height: number) {
  const w = Math.min(width, window.innerWidth - 32);
  const h = Math.min(height, window.innerHeight - 32);
  return { x: Math.max(16, Math.round((window.innerWidth - w) / 2)), y: Math.max(16, Math.round((window.innerHeight - h) / 3)), width: w, height: h };
}

function outcome(state: SnapshotRestoreState | undefined) {
  switch (state) {
    case 'restored':
      return { control: <span className="session-save-status-exact"><Icon name="check-circle" size={18} /></span>, text: <span className="session-save-status-exact">이어함</span> };
    case 'skipped':
      return { control: <Icon name="minimize" size={18} />, text: <span className="session-save-status-missing">건너뜀 · 셸만 둠</span> };
    case 'failed':
      return { control: <span className="session-save-status-estimated"><Icon name="alert" size={18} /></span>, text: <span className="session-save-status-estimated">이어하지 못함 · 탭이 없음</span> };
    default:
      return { control: undefined, text: undefined };
  }
}

export function SessionRestoreDialog({ status, onClose, onRestore, onDiscard }: SessionRestoreDialogProps) {
  const entries = useMemo(() => pendingEntries(status), [status]);
  const [snapshotEntries] = useState<SnapshotEntry[]>(entries);
  const [picked, setPicked] = useState<Set<string>>(() => defaultRestoreSelection(entries));
  const [step, setStep] = useState<Step>('select');
  const [results, setResults] = useState<Map<string, SnapshotRestoreState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const savedAt = formatSavedAt(status.snapshot?.savedAt ?? '');
  const allChecked = snapshotEntries.length > 0 && picked.size === snapshotEntries.length;
  const restoredCount = [...results.values()].filter((value) => value === 'restored').length;
  const skippedCount = [...results.values()].filter((value) => value !== 'restored').length;

  const toggle = (tabId: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  };

  const restore = async () => {
    setStep('working');
    setError(null);
    try {
      const processed = await onRestore([...picked]);
      setResults(new Map(processed.map((item) => [item.tabId, item.restore])));
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  return (
    <>
      <WindowDialog
        dialogId="session-restore-dialog"
        title={step === 'done' ? `세션 ${restoredCount}개를 이어했습니다` : '저장된 세션 이어하기'}
        mode="modal"
        defaultRect={centeredRect(760, 620)}
        minSize={{ width: 440, height: 360 }}
        onClose={step === 'working' ? () => undefined : onClose}
        showCloseButton={step !== 'working'}
        persistGeometry={false}
      >
        <div className="session-save-dialog">
          <div className="session-save-body">
            <p className="session-save-lead">
              {step === 'done'
                ? (skippedCount > 0 ? `${skippedCount}개는 셸만 열어 두었습니다. 결과를 저장본에 기록했으니 다음에 다시 묻지 않습니다.` : '저장한 세션을 모두 이어했습니다.')
                : `${savedAt ? `${savedAt}에 ` : ''}저장한 AI 세션 ${snapshotEntries.length}개가 있습니다. 이어할 세션을 고르세요. 고르지 않은 탭은 셸만 열린 채로 둡니다.`}
            </p>
            {step === 'select' && (
              <label className="session-save-all">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(event) => setPicked(event.target.checked ? new Set(snapshotEntries.map((e) => e.tabId)) : new Set())}
                />
                <span className="session-save-all-label">저장된 세션 전체</span>
                <span className="session-save-all-count">{picked.size} / {snapshotEntries.length} 선택</span>
              </label>
            )}
            {step === 'done' && (
              <ProgressBar label={`이어함 ${restoredCount}개 · 건너뜀 ${skippedCount}개`} value={results.size} max={results.size} tone="ok" />
            )}
            {groupByWorkspace(snapshotEntries).map((group) => (
              <div className="session-save-group" key={group.workspaceId}>
                <div className="ui-group-heading"><Icon name="folder" size={13} /><span>{group.workspaceName}</span><span>{group.items.length}개</span></div>
                {group.items.map((entry) => {
                  const done = outcome(results.get(entry.tabId));
                  return (
                    <SelectableRow
                      key={entry.tabId}
                      name={entry.tabName}
                      checkboxLabel={`${entry.tabName} 이어하기`}
                      checked={picked.has(entry.tabId)}
                      onToggle={(checked) => toggle(entry.tabId, checked)}
                      badges={(
                        <>
                          <AgentMark agent={entry.agent} />
                          {entry.confidence === 'exact'
                            ? <Chip tone="ok" icon="check">정확한 ID</Chip>
                            : <Chip tone="warn" icon="alert" title="시각과 경로로 맞춘 값입니다. 명령을 확인하고 고르세요.">추정한 ID · 확인 필요</Chip>}
                        </>
                      )}
                      meta={resumeCommandPreview(entry)}
                      control={step === 'working' && picked.has(entry.tabId) ? <Spinner /> : step === 'done' ? done.control : undefined}
                      highlighted={step === 'select' ? picked.has(entry.tabId) : false}
                      trailing={step === 'working' && picked.has(entry.tabId)
                        ? <span className="session-save-status-active">이어하는 중…</span>
                        : step === 'done' ? done.text : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {step === 'select' && (
            <DialogFooter note={<Button variant="danger-text" icon="trash" onClick={() => setConfirmDiscard(true)}>저장본 버리기</Button>}>
              <Button variant="secondary" onClick={onClose}>나중에</Button>
              <Button variant="primary" icon="resume" disabled={picked.size === 0} onClick={() => { void restore(); }}>
                {picked.size === 0 ? '이어할 세션을 고르세요' : `선택한 ${picked.size}개 이어하기`}
              </Button>
            </DialogFooter>
          )}
          {step === 'working' && (
            <DialogFooter note="탭마다 셸이 준비되면 이어하기 명령을 보냅니다.">
              <Button variant="primary" disabled>이어하는 중…</Button>
            </DialogFooter>
          )}
          {step === 'done' && (
            <DialogFooter note="결과를 저장본에 기록했습니다. 다음에 시작할 때 다시 묻지 않습니다.">
              <Button variant="primary" onClick={onClose}>닫기</Button>
            </DialogFooter>
          )}
          {step === 'error' && (
            <DialogFooter note={`이어하지 못했습니다: ${error ?? ''}`} noteTone="warn">
              <Button variant="secondary" onClick={onClose}>닫기</Button>
              <Button variant="primary" onClick={() => { void restore(); }}>다시 시도</Button>
            </DialogFooter>
          )}
        </div>
      </WindowDialog>
      {confirmDiscard && (
        <MessageBox
          dialogId="session-restore-discard"
          title="저장본을 버릴까요?"
          message={`저장한 세션 ID ${snapshotEntries.length}개가 지워집니다. 탭과 셸은 그대로 남고, 에이전트 대화 기록도 지워지지 않습니다.`}
          okLabel="저장본 버리기"
          cancelLabel="취소"
          okVariant="danger"
          onOk={() => {
            setConfirmDiscard(false);
            void onDiscard().then(onClose);
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}

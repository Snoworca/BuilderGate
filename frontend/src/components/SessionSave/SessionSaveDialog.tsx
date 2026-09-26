// FR-AITUI-009 AC-2 — pick the AI tabs, save their session ids, show how sure
// each answer is. The agents keep running.
import { useMemo, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common/Icon.tsx';
import { Button, DialogFooter, ProgressBar, SelectableRow, Spinner } from '../ui/index.ts';
import { AgentMark } from './AgentMark.tsx';
import { groupByWorkspace, summarizeSaveResults, type AgentTabCandidate, type SaveResultItem } from './sessionSnapshotModel.ts';
import './SessionSave.css';

export interface SessionSaveDialogProps {
  candidates: AgentTabCandidate[];
  onClose: () => void;
  onSave: (tabIds: string[]) => Promise<SaveResultItem[]>;
}

type Step = 'select' | 'saving' | 'done' | 'error';

function centeredRect(width: number, height: number) {
  const w = Math.min(width, window.innerWidth - 32);
  const h = Math.min(height, window.innerHeight - 32);
  return { x: Math.max(16, Math.round((window.innerWidth - w) / 2)), y: Math.max(16, Math.round((window.innerHeight - h) / 3)), width: w, height: h };
}

function resultTrailing(result: SaveResultItem | undefined) {
  if (!result) return null;
  if (result.status !== 'found') return <span className="session-save-status-missing">찾지 못함</span>;
  const short = `${(result.sessionId ?? '').slice(0, 12)}…`;
  return result.confidence === 'exact'
    ? <span className="session-save-status-exact">ID 확인 · {short}</span>
    : <span className="session-save-status-estimated">추정 · {short}</span>;
}

function resultControl(result: SaveResultItem | undefined) {
  if (!result || result.status !== 'found') return <Icon name="info" size={18} />;
  return result.confidence === 'exact'
    ? <span className="session-save-status-exact"><Icon name="check-circle" size={18} /></span>
    : <span className="session-save-status-estimated"><Icon name="alert" size={18} /></span>;
}

export function SessionSaveDialog({ candidates, onClose, onSave }: SessionSaveDialogProps) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.map((c) => c.tabId)));
  const [step, setStep] = useState<Step>('select');
  const [results, setResults] = useState<SaveResultItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const byTab = useMemo(() => new Map(results.map((r) => [r.tabId, r])), [results]);
  const allChecked = candidates.length > 0 && picked.size === candidates.length;
  const summary = summarizeSaveResults(results);

  const toggle = (tabId: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  };

  const save = async () => {
    setStep('saving');
    setError(null);
    try {
      setResults(await onSave([...picked]));
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const visible = step === 'select' ? candidates : candidates.filter((c) => picked.has(c.tabId));

  return (
    <WindowDialog
      dialogId="session-save-dialog"
      title={step === 'done' ? `세션 ${summary.exact + summary.estimated}개를 저장했습니다` : '세션 저장'}
      mode="modal"
      defaultRect={centeredRect(680, 600)}
      minSize={{ width: 420, height: 360 }}
      onClose={step === 'saving' ? () => undefined : onClose}
      showCloseButton={step !== 'saving'}
      persistGeometry={false}
    >
      <div className="session-save-dialog">
        <div className="session-save-body">
          <p className="session-save-lead">
            {step === 'done'
              ? '이제 BuilderGate를 재시작해도 됩니다. 에이전트는 계속 실행 중이니 그대로 작업하셔도 됩니다.'
              : <>지금 실행 중인 AI 세션의 이어하기 ID를 저장합니다. <strong>에이전트는 멈추지 않습니다.</strong> BuilderGate를 재시작해도 저장한 대화로 돌아올 수 있습니다.</>}
          </p>
          {step === 'select' && candidates.length > 0 && (
            <label className="session-save-all">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(event) => setPicked(event.target.checked ? new Set(candidates.map((c) => c.tabId)) : new Set())}
              />
              <span className="session-save-all-label">AI 세션 전체</span>
              <span className="session-save-all-count">{picked.size} / {candidates.length} 선택</span>
            </label>
          )}
          {step === 'done' && (
            <ProgressBar
              label={`정확한 ID ${summary.exact}개 · 추정 ${summary.estimated}개 · 찾지 못함 ${summary.notFound}개`}
              value={results.length}
              max={results.length}
              tone="ok"
            />
          )}
          {candidates.length === 0 && (
            <div className="session-save-empty">실행 중인 AI 세션이 없습니다. Claude, Codex, Hermes, OpenCode를 실행한 탭이 여기에 나옵니다.</div>
          )}
          {groupByWorkspace(visible).map((group) => (
            <div className="session-save-group" key={group.workspaceId}>
              <div className="ui-group-heading"><Icon name="folder" size={13} /><span>{group.workspaceName}</span><span>{group.items.length}개</span></div>
              {group.items.map((candidate) => (
                <SelectableRow
                  key={candidate.tabId}
                  name={candidate.tabName}
                  checkboxLabel={`${candidate.tabName} 저장`}
                  checked={picked.has(candidate.tabId)}
                  onToggle={(checked) => toggle(candidate.tabId, checked)}
                  badges={<AgentMark agent={candidate.agent} />}
                  meta={candidate.cwd ?? ''}
                  control={step === 'saving' ? <Spinner /> : step === 'done' ? resultControl(byTab.get(candidate.tabId)) : undefined}
                  highlighted={step === 'select' ? picked.has(candidate.tabId) : false}
                  trailing={step === 'saving'
                    ? <span className="session-save-status-active">찾는 중…</span>
                    : step === 'done' ? <span className="session-save-trailing">{resultTrailing(byTab.get(candidate.tabId))}</span> : undefined}
                />
              ))}
            </div>
          ))}
        </div>
        {step === 'select' && (
          <DialogFooter note="에이전트는 계속 실행됩니다. 저장은 몇 초 안에 끝납니다.">
            <Button variant="secondary" onClick={onClose}>취소</Button>
            <Button variant="primary" icon="bookmark-plus" disabled={picked.size === 0} onClick={() => { void save(); }}>
              {picked.size === 0 ? '저장할 세션을 고르세요' : '세션 저장'}
            </Button>
          </DialogFooter>
        )}
        {step === 'saving' && (
          <DialogFooter note="에이전트가 남긴 기록에서 지금 쓰는 세션 ID를 찾고 있습니다.">
            <Button variant="primary" disabled>저장하는 중…</Button>
          </DialogFooter>
        )}
        {step === 'done' && (
          <DialogFooter note="재시작하면 이어할 세션을 고르는 창이 뜹니다. 세션을 새로 시작했다면(/clear, /new) 다시 저장하세요.">
            <Button variant="primary" onClick={onClose}>확인</Button>
          </DialogFooter>
        )}
        {step === 'error' && (
          <DialogFooter note={`저장하지 못했습니다: ${error ?? ''}`} noteTone="warn">
            <Button variant="secondary" onClick={onClose}>닫기</Button>
            <Button variant="primary" onClick={() => { void save(); }}>다시 시도</Button>
          </DialogFooter>
        )}
      </div>
    </WindowDialog>
  );
}

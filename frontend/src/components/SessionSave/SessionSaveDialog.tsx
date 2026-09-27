// FR-AITUI-009 AC-2 — pick the AI tabs, save their session ids, show how sure
// each answer is. The agents keep running.
import { useMemo, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common/Icon.tsx';
import { Button, DialogFooter, ProgressBar, SelectableRow, Spinner } from '../ui/index.ts';
import { AgentMark } from './AgentMark.tsx';
import { groupByWorkspace, summarizeSaveResults, type AgentTabCandidate, type SaveResultItem } from './sessionSnapshotModel.ts';
import './SessionSave.css';
import { t, tn } from '../../i18n/i18n.ts';

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
  if (result.status !== 'found') return <span className="session-save-status-missing">{t('sessionSave.save.status.notFound')}</span>;
  const short = `${(result.sessionId ?? '').slice(0, 12)}…`;
  return result.confidence === 'exact'
    ? <span className="session-save-status-exact">{t('sessionSave.save.status.exact', { id: short })}</span>
    : <span className="session-save-status-estimated">{t('sessionSave.save.status.estimated', { id: short })}</span>;
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
      title={step === 'done' ? tn('sessionSave.save.doneTitle', summary.exact + summary.estimated) : t('sessionSave.save.title')}
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
              ? t('sessionSave.save.doneBody')
              : <>{t('sessionSave.save.introLead')} <strong>{t('sessionSave.save.introStrong')}</strong> {t('sessionSave.save.introTail')}</>}
          </p>
          {step === 'select' && candidates.length > 0 && (
            <label className="session-save-all">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(event) => setPicked(event.target.checked ? new Set(candidates.map((c) => c.tabId)) : new Set())}
              />
              <span className="session-save-all-label">{t('sessionSave.save.all')}</span>
              <span className="session-save-all-count">{t('sessionSave.list.selected', { picked: picked.size, total: candidates.length })}</span>
            </label>
          )}
          {step === 'done' && (
            <ProgressBar
              label={t('sessionSave.save.progress', { exact: summary.exact, estimated: summary.estimated, notFound: summary.notFound })}
              value={results.length}
              max={results.length}
              tone="ok"
            />
          )}
          {candidates.length === 0 && (
            <div className="session-save-empty">{t('sessionSave.save.empty')}</div>
          )}
          {groupByWorkspace(visible).map((group) => (
            <div className="session-save-group" key={group.workspaceId}>
              <div className="ui-group-heading"><Icon name="folder" size={13} /><span>{group.workspaceName}</span><span>{tn('sessionSave.list.groupCount', group.items.length)}</span></div>
              {group.items.map((candidate) => (
                <SelectableRow
                  key={candidate.tabId}
                  name={candidate.tabName}
                  checkboxLabel={t('sessionSave.save.rowAria', { name: candidate.tabName })}
                  checked={picked.has(candidate.tabId)}
                  onToggle={(checked) => toggle(candidate.tabId, checked)}
                  badges={<AgentMark agent={candidate.agent} />}
                  meta={candidate.cwd ?? ''}
                  control={step === 'saving' ? <Spinner /> : step === 'done' ? resultControl(byTab.get(candidate.tabId)) : undefined}
                  highlighted={step === 'select' ? picked.has(candidate.tabId) : false}
                  trailing={step === 'saving'
                    ? <span className="session-save-status-active">{t('sessionSave.save.finding')}</span>
                    : step === 'done' ? <span className="session-save-trailing">{resultTrailing(byTab.get(candidate.tabId))}</span> : undefined}
                />
              ))}
            </div>
          ))}
        </div>
        {step === 'select' && (
          <DialogFooter note={t('sessionSave.save.pickNote')}>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" icon="bookmark-plus" disabled={picked.size === 0} onClick={() => { void save(); }}>
              {picked.size === 0 ? t('sessionSave.save.pickPrompt') : t('sessionSave.save.title')}
            </Button>
          </DialogFooter>
        )}
        {step === 'saving' && (
          <DialogFooter note={t('sessionSave.save.runningNote')}>
            <Button variant="primary" disabled>{t('sessionSave.save.saving')}</Button>
          </DialogFooter>
        )}
        {step === 'done' && (
          <DialogFooter note={t('sessionSave.save.doneNote')}>
            <Button variant="primary" onClick={onClose}>{t('common.confirm')}</Button>
          </DialogFooter>
        )}
        {step === 'error' && (
          <DialogFooter note={t('sessionSave.save.error', { error: error ?? '' })} noteTone="warn">
            <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" onClick={() => { void save(); }}>{t('sessionSave.action.retry')}</Button>
          </DialogFooter>
        )}
      </div>
    </WindowDialog>
  );
}

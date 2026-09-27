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
import { t, tn } from '../../i18n/i18n.ts';

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
      return { control: <span className="session-save-status-exact"><Icon name="check-circle" size={18} /></span>, text: <span className="session-save-status-exact">{t('sessionSave.restore.status.resumed')}</span> };
    case 'skipped':
      return { control: <Icon name="minimize" size={18} />, text: <span className="session-save-status-missing">{t('sessionSave.restore.status.skipped')}</span> };
    case 'failed':
      return { control: <span className="session-save-status-estimated"><Icon name="alert" size={18} /></span>, text: <span className="session-save-status-estimated">{t('sessionSave.restore.status.noTab')}</span> };
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
        title={step === 'done' ? tn('sessionSave.restore.doneTitle', restoredCount) : t('sessionSave.restore.title')}
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
                ? (skippedCount > 0 ? tn('sessionSave.restore.doneSkipped', skippedCount) : t('sessionSave.restore.doneAll'))
                : (savedAt ? tn('sessionSave.restore.introAt', snapshotEntries.length, { savedAt }) : tn('sessionSave.restore.intro', snapshotEntries.length))}
            </p>
            {step === 'select' && (
              <label className="session-save-all">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={(event) => setPicked(event.target.checked ? new Set(snapshotEntries.map((e) => e.tabId)) : new Set())}
                />
                <span className="session-save-all-label">{t('sessionSave.restore.all')}</span>
                <span className="session-save-all-count">{t('sessionSave.list.selected', { picked: picked.size, total: snapshotEntries.length })}</span>
              </label>
            )}
            {step === 'done' && (
              <ProgressBar label={t('sessionSave.restore.progress', { restored: restoredCount, skipped: skippedCount })} value={results.size} max={results.size} tone="ok" />
            )}
            {groupByWorkspace(snapshotEntries).map((group) => (
              <div className="session-save-group" key={group.workspaceId}>
                <div className="ui-group-heading"><Icon name="folder" size={13} /><span>{group.workspaceName}</span><span>{tn('sessionSave.list.groupCount', group.items.length)}</span></div>
                {group.items.map((entry) => {
                  const done = outcome(results.get(entry.tabId));
                  return (
                    <SelectableRow
                      key={entry.tabId}
                      name={entry.tabName}
                      checkboxLabel={t('sessionSave.restore.rowAria', { name: entry.tabName })}
                      checked={picked.has(entry.tabId)}
                      onToggle={(checked) => toggle(entry.tabId, checked)}
                      badges={(
                        <>
                          <AgentMark agent={entry.agent} />
                          {entry.confidence === 'exact'
                            ? <Chip tone="ok" icon="check">{t('sessionSave.id.exact')}</Chip>
                            : <Chip tone="warn" icon="alert" title={t('sessionSave.id.estimatedTitle')}>{t('sessionSave.id.estimated')}</Chip>}
                        </>
                      )}
                      meta={resumeCommandPreview(entry)}
                      control={step === 'working' && picked.has(entry.tabId) ? <Spinner /> : step === 'done' ? done.control : undefined}
                      highlighted={step === 'select' ? picked.has(entry.tabId) : false}
                      trailing={step === 'working' && picked.has(entry.tabId)
                        ? <span className="session-save-status-active">{t('sessionSave.restore.resuming')}</span>
                        : step === 'done' ? done.text : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {step === 'select' && (
            <DialogFooter note={<Button variant="danger-text" icon="trash" onClick={() => setConfirmDiscard(true)}>{t('sessionSave.restore.discard')}</Button>}>
              <Button variant="secondary" onClick={onClose}>{t('sessionSave.action.later')}</Button>
              <Button variant="primary" icon="resume" disabled={picked.size === 0} onClick={() => { void restore(); }}>
                {picked.size === 0 ? t('sessionSave.restore.pickPrompt') : tn('sessionSave.restore.resumeSelected', picked.size)}
              </Button>
            </DialogFooter>
          )}
          {step === 'working' && (
            <DialogFooter note={t('sessionSave.restore.runningNote')}>
              <Button variant="primary" disabled>{t('sessionSave.restore.resuming')}</Button>
            </DialogFooter>
          )}
          {step === 'done' && (
            <DialogFooter note={t('sessionSave.restore.doneNote')}>
              <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
            </DialogFooter>
          )}
          {step === 'error' && (
            <DialogFooter note={t('sessionSave.restore.error', { error: error ?? '' })} noteTone="warn">
              <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
              <Button variant="primary" onClick={() => { void restore(); }}>{t('sessionSave.action.retry')}</Button>
            </DialogFooter>
          )}
        </div>
      </WindowDialog>
      {confirmDiscard && (
        <MessageBox
          dialogId="session-restore-discard"
          title={t('sessionSave.discard.title')}
          message={tn('sessionSave.discard.message', snapshotEntries.length)}
          okLabel={t('sessionSave.restore.discard')}
          cancelLabel={t('common.cancel')}
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

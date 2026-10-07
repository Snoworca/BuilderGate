// FR-AITUI-018 AC-4..AC-7 — the restore tab: the auto save on top, the manual
// saves by day below; pick one, pick its terminals, restore them by hand.
// Design: docs/research/2026-10-08.session-restore-tab-design.html
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../common/Icon.tsx';
import { Button, DialogFooter, Spinner } from '../ui/index.ts';
import { ConfirmModal } from '../Modal';
import { AgentMark } from './AgentMark.tsx';
import { ReportResult } from './RestoreReport.tsx';
import { groupByWorkspace } from './sessionSnapshotModel.ts';
import {
  agentCountsText,
  groupManualByDay,
  restoreItems,
  timeLabelOf,
  dayLabelOf,
  type HandRestoreItem,
  type PlannedEntry,
  type SnapshotDetail,
  type SnapshotList,
  type SnapshotSummary,
} from './sessionRestoreModel.ts';
import type { RestoreReportItem } from './sessionSaveAllModel.ts';
import { t, tn } from '../../i18n/i18n.ts';

export interface SessionRestoreTabProps {
  listSnapshots: () => Promise<SnapshotList>;
  getSnapshot: (id: string) => Promise<SnapshotDetail>;
  deleteSnapshot: (id: string) => Promise<void>;
  restoreFrom: (id: string, items: HandRestoreItem[]) => Promise<RestoreReportItem[]>;
  autoSave?: { enabled: boolean; intervalMinutes: number };
  /** Shown when this server start restored something (FR-AITUI-018 AC-7). */
  onOpenLastReport?: () => void;
  onClose: () => void;
}

type Step = 'pick' | 'restoring' | 'done' | 'error';

function summaryLine(item: SnapshotSummary): string {
  const agents = agentCountsText(item.agentCounts);
  return [tn('sessionSave.restore.tabCount', item.tabCount), agents].filter(Boolean).join(' · ');
}

function kindMark(entry: PlannedEntry) {
  if (entry.mode === 'agent' && entry.agent) return <AgentMark agent={entry.agent} />;
  return <span className="agent-mark agent-mark-shell">{entry.mode === 'command' ? t('sessionSave.editor.custom') : t('sessionSave.editor.shellOnly')}</span>;
}

export function SessionRestoreTab({ listSnapshots, getSnapshot, deleteSnapshot, restoreFrom, autoSave, onOpenLastReport, onClose }: SessionRestoreTabProps) {
  const [list, setList] = useState<SnapshotList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SnapshotDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());
  const [commandOn, setCommandOn] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<Step>('pick');
  const [results, setResults] = useState<RestoreReportItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SnapshotSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setListError(null);
    listSnapshots()
      .then((next) => {
        setList(next);
        // The save a restart would restore comes first: the newer of the auto save and the newest manual one.
        setSelectedId((current) => {
          if (current && (current === next.auto?.id || next.manual.some((m) => m.id === current))) return current;
          const newestManual = next.manual[0];
          if (next.auto && (!newestManual || Date.parse(next.auto.savedAt) > Date.parse(newestManual.savedAt))) return next.auto.id;
          return newestManual?.id ?? next.auto?.id ?? null;
        });
      })
      .catch((err: unknown) => setListError(err instanceof Error ? err.message : String(err)));
  }, [listSnapshots]);
  useEffect(loadList, [loadList]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setUnpicked(new Set());
    setCommandOn(new Set());
    setStep('pick');
    setResults([]);
    if (!selectedId) return;
    let live = true;
    getSnapshot(selectedId)
      .then((next) => { if (live) setDetail(next); })
      .catch((err: unknown) => { if (live) setDetailError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [selectedId, getSnapshot]);

  const newestManual = list?.manual[0] ?? null;
  const nextStartId = list?.auto && (!newestManual || Date.parse(list.auto.savedAt) > Date.parse(newestManual.savedAt))
    ? list.auto.id
    : newestManual?.id ?? null;
  const days = useMemo(() => groupManualByDay(list?.manual ?? []), [list]);
  const entries = useMemo(() => detail?.entries ?? [], [detail]);
  const groups = groupByWorkspace(entries);
  const items = restoreItems(entries, unpicked, commandOn);
  const allPicked = entries.length > 0 && unpicked.size === 0;

  const toggle = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const run = async () => {
    if (!detail) return;
    setStep('restoring');
    setError(null);
    try {
      setResults(await restoreFrom(detail.id, items));
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await deleteSnapshot(deleting.id);
      if (selectedId === deleting.id) setSelectedId(null);
      setDeleting(null);
      loadList();
    } catch (err) {
      setDeleteError(t('sessionSave.restore.deleteError', { error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const card = (item: SnapshotSummary, heading: string) => (
    <button
      type="button"
      className="session-restore-card"
      aria-pressed={selectedId === item.id}
      onClick={() => setSelectedId(item.id)}
    >
      <span className="session-restore-card-top">
        <span className="session-restore-card-time">{heading}</span>
        {nextStartId === item.id && <span className="session-restore-pill is-accent">{t('sessionSave.restore.nextStart')}</span>}
        {item.usedForRestore && nextStartId !== item.id && <span className="session-restore-pill is-ok">{t('sessionSave.restore.usedLastStart')}</span>}
      </span>
      <span className="session-restore-card-sub">{summaryLine(item)}</span>
    </button>
  );

  const targetText = (entry: PlannedEntry) => (entry.target === 'tab' ? t('sessionSave.restore.target.tab') : t('sessionSave.restore.target.newTab'));
  const reasonText = (entry: PlannedEntry) => t(
    entry.targetReason === 'idle' ? 'sessionSave.restore.reason.idle'
      : entry.targetReason === 'busy' ? 'sessionSave.restore.reason.busy' : 'sessionSave.restore.reason.missing',
  );

  return (
    <>
      <div className="session-restore">
        <div className="session-restore-side">
          <div className="session-restore-side-scroll">
            {listError && <div className="session-save-empty">{t('sessionSave.restore.loadError', { error: listError })}</div>}
            {!list && !listError && <div className="session-save-empty"><Spinner /> {t('sessionSave.restore.loading')}</div>}
            {list && (
              <>
                <section className="session-restore-sec" aria-label={t('sessionSave.restore.autoHeading')}>
                  <div className="session-restore-sec-head">
                    <span className="session-restore-sec-title">{t('sessionSave.restore.autoHeading')}</span>
                    <span className="session-restore-sec-meta">
                      {autoSave && !autoSave.enabled ? t('sessionSave.restore.autoOff') : t('sessionSave.restore.autoMeta', { minutes: autoSave?.intervalMinutes ?? 5 })}
                    </span>
                  </div>
                  {list.auto
                    ? card(list.auto, `${dayLabelOf(new Date(list.auto.savedAt))} ${timeLabelOf(list.auto.savedAt)}`)
                    : <div className="session-restore-none">{t('sessionSave.restore.autoNone')}</div>}
                </section>
                <section className="session-restore-sec" aria-label={t('sessionSave.restore.manualHeading')}>
                  <div className="session-restore-sec-head">
                    <span className="session-restore-sec-title">{t('sessionSave.restore.manualHeading')}</span>
                    <span className="session-restore-sec-meta">{t('sessionSave.restore.manualMeta', { count: list.manual.length, retention: list.retention })}</span>
                  </div>
                  {list.manual.length === 0 && <div className="session-restore-none">{t('sessionSave.restore.manualNone')}</div>}
                  {days.map((day) => (
                    <div className="session-restore-day" key={day.key}>
                      <span className="session-restore-date">{day.label}</span>
                      {day.items.map((item) => (
                        <div className="session-restore-item" key={item.id}>
                          {card(item, timeLabelOf(item.savedAt))}
                          <button
                            type="button"
                            className="icon-button icon-button-md"
                            aria-label={t('sessionSave.restore.deleteAria')}
                            title={t('sessionSave.restore.deleteAria')}
                            onClick={() => { setDeleteError(null); setDeleting(item); }}
                          >
                            <Icon name="trash" size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              </>
            )}
          </div>
          {onOpenLastReport && (
            <div className="session-restore-side-foot">
              <button type="button" className="session-restore-link" onClick={onOpenLastReport}>{t('sessionSave.restore.lastReport')}</button>
            </div>
          )}
        </div>

        <div className="session-restore-main">
          {!selectedId && list && <div className="session-save-empty session-restore-placeholder">{t('sessionSave.restore.pick')}</div>}
          {selectedId && !detail && !detailError && <div className="session-save-empty session-restore-placeholder"><Spinner /></div>}
          {detailError && <div className="session-save-empty session-restore-placeholder">{t('sessionSave.restore.loadError', { error: detailError })}</div>}
          {detail && (
            <>
              <div className="session-restore-head">
                <div className="session-restore-head-text">
                  <span className="session-restore-sec-title">{detail.origin === 'auto' ? t('sessionSave.restore.kindAuto') : t('sessionSave.restore.kindManual')}</span>
                  <span className="session-restore-title">{`${dayLabelOf(new Date(detail.savedAt))} ${timeLabelOf(detail.savedAt)}`}</span>
                  <span className="session-restore-card-sub">{tn('sessionSave.restore.tabCount', entries.length)}</span>
                </div>
                {step === 'pick' && entries.length > 0 && (
                  <label className="session-save-all-toggle">
                    <input type="checkbox" checked={allPicked} onChange={(event) => setUnpicked(event.target.checked ? new Set() : new Set(entries.map((e) => e.tabId)))} />
                    <span>{t('sessionSave.all.selectAll')}</span>
                  </label>
                )}
              </div>
              {step === 'done' ? (
                <div className="session-restore-rows">
                  {results.map((item) => <ReportResult key={item.tabId} item={item} />)}
                </div>
              ) : (
                <div className="session-restore-rows" role="table" aria-label={t('sessionSave.restore.resultsTitle')}>
                  {entries.length === 0 && <div className="session-save-empty">{t('sessionSave.restore.empty')}</div>}
                  {entries.length > 0 && (
                    <div className="session-restore-grid session-restore-cols" role="row">
                      <span role="columnheader" />
                      <span role="columnheader">{t('sessionSave.restore.col.tab')}</span>
                      <span role="columnheader">{t('sessionSave.restore.col.kind')}</span>
                      <span role="columnheader">{t('sessionSave.restore.col.where')}</span>
                      <span role="columnheader">{t('sessionSave.restore.col.target')}</span>
                    </div>
                  )}
                  {groups.map((group) => (
                    <div key={group.workspaceId} role="rowgroup">
                      <div className="session-restore-ws">{group.workspaceName}</div>
                      {group.items.map((entry) => (
                        <div className="session-restore-grid session-restore-row" role="row" key={entry.tabId}>
                          <span role="cell" className="session-restore-check">
                            <input
                              type="checkbox"
                              aria-label={t('sessionSave.all.rowAria', { name: entry.tabName })}
                              checked={!unpicked.has(entry.tabId)}
                              disabled={step !== 'pick'}
                              onChange={() => setUnpicked((current) => toggle(current, entry.tabId))}
                            />
                          </span>
                          <span role="cell" className="session-restore-name" title={entry.tabName}>{entry.tabName}</span>
                          <span role="cell">{kindMark(entry)}</span>
                          <span role="cell" className="session-restore-stack">
                            <span className="session-restore-mono" title={entry.cwd ?? ''}>{entry.cwd ?? ''}</span>
                            {entry.mode === 'agent' && entry.sessionId && (
                              <span className="session-restore-session">
                                <span className="session-restore-mono is-muted" title={entry.sessionId}>{entry.sessionId}</span>
                                {entry.confidence === 'estimated'
                                  ? <span className="session-restore-pill is-warn">{t('sessionSave.all.status.estimated')}</span>
                                  : <span className="session-restore-pill is-ok">{t('sessionSave.all.status.exact')}</span>}
                              </span>
                            )}
                            {entry.mode === 'command' && <code className="session-restore-command">{[entry.resumeCommand, ...entry.resumeArguments].join(' ')}</code>}
                            {entry.runningCommand && (
                              <label className="session-restore-cmd">
                                <input
                                  type="checkbox"
                                  checked={commandOn.has(entry.tabId)}
                                  disabled={step !== 'pick' || unpicked.has(entry.tabId)}
                                  onChange={() => setCommandOn((current) => toggle(current, entry.tabId))}
                                />
                                <span>{t('sessionSave.restore.includeCommand')}</span>
                                <code className="session-restore-command">{entry.runningCommand}</code>
                              </label>
                            )}
                          </span>
                          <span role="cell" className="session-restore-stack">
                            <span className={entry.target === 'tab' ? 'session-restore-target is-ok' : 'session-restore-target is-new'}>{targetText(entry)}</span>
                            <span className="session-restore-note">{reasonText(entry)}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {step === 'done' ? (
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setStep('pick'); setResults([]); }}>{t('sessionSave.restore.back')}</Button>
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      ) : (
        <DialogFooter note={step === 'error' ? t('sessionSave.restore.error', { error: error ?? '' }) : t('sessionSave.restore.hint')} noteTone={step === 'error' ? 'warn' : undefined}>
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" icon="resume" disabled={!detail || items.length === 0 || step === 'restoring'} onClick={() => { void run(); }}>
            {step === 'restoring' ? t('sessionSave.restore.running') : t('sessionSave.restore.run', { count: items.length })}
          </Button>
        </DialogFooter>
      )}

      {deleting && (
        <ConfirmModal
          title={t('sessionSave.restore.deleteTitle')}
          message={t('sessionSave.restore.deleteMessage', { time: `${dayLabelOf(new Date(deleting.savedAt))} ${timeLabelOf(deleting.savedAt)}` })}
          confirmLabel={t('sessionSave.restore.deleteAria')}
          cancelLabel={t('common.cancel')}
          destructive
          error={deleteError ? { message: deleteError } : null}
          onConfirm={() => { void confirmDelete(); }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

// FR-AITUI-015 AC-1..AC-4 — every terminal of every workspace, how it comes
// back after a restart, and one save for all of them. The agents keep running.
import { useEffect, useMemo, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common/Icon.tsx';
import { Button, DialogFooter, Spinner } from '../ui/index.ts';
import { AgentMark } from './AgentMark.tsx';
import { RestoreEditor } from './RestoreEditor.tsx';
import { SessionRestoreTab, type SessionRestoreTabProps } from './SessionRestoreTab.tsx';
import { groupByWorkspace } from './sessionSnapshotModel.ts';
import {
  initialDraft,
  needsReview,
  restoreCommandPreview,
  rowMatchesFilter,
  rowStatus,
  toSaveItem,
  type PreviewTab,
  type RowDraft,
  type RowFilter,
  type RowStatus,
  type SaveItem,
  type SnapshotPreview,
} from './sessionSaveAllModel.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import './SessionSave.css';
import { t, tn } from '../../i18n/i18n.ts';

export interface SessionSaveDialogProps {
  loadPreview: () => Promise<SnapshotPreview>;
  onClose: () => void;
  onSave: (items: SaveItem[]) => Promise<void>;
  /** FR-AITUI-018 AC-4: the restore tab beside the save tab. */
  restore?: Omit<SessionRestoreTabProps, 'onClose'>;
  initialTab?: 'save' | 'restore';
}

type DialogTab = 'save' | 'restore';

type Step = 'loading' | 'load-error' | 'select' | 'saving' | 'done' | 'error';

const STATUS_LABEL = {
  exact: 'sessionSave.all.status.exact',
  estimated: 'sessionSave.all.status.estimated',
  missing: 'sessionSave.all.status.missing',
  invalid: 'sessionSave.all.status.invalid',
  edited: 'sessionSave.all.status.edited',
  shell: 'sessionSave.all.status.shell',
  command: 'sessionSave.all.status.command',
} satisfies Record<RowStatus, MessageKey>;

const FILTER_LABEL = {
  all: 'sessionSave.all.filter.all',
  review: 'sessionSave.all.filter.review',
  agent: 'sessionSave.all.filter.agent',
  shell: 'sessionSave.all.filter.shell',
} satisfies Record<RowFilter, MessageKey>;

const FILTERS: readonly RowFilter[] = ['all', 'review', 'agent', 'shell'];

function centeredRect(width: number, height: number) {
  const w = Math.min(width, window.innerWidth - 32);
  const h = Math.min(height, window.innerHeight - 32);
  return { x: Math.max(16, Math.round((window.innerWidth - w) / 2)), y: Math.max(16, Math.round((window.innerHeight - h) / 4)), width: w, height: h };
}

function statusIcon(status: RowStatus) {
  if (status === 'exact') return <Icon name="check-circle" size={14} />;
  if (status === 'estimated' || status === 'missing' || status === 'invalid') return <Icon name="alert" size={14} />;
  if (status === 'edited' || status === 'command') return <Icon name="edit" size={14} />;
  return null;
}

function agentLabel(draft: RowDraft) {
  if (draft.mode === 'agent' && draft.agent) {
    return (
      <span className="session-row-agent">
        <AgentMark agent={draft.agent} />
        {draft.launcher && draft.launcher !== draft.agent && <span className="session-row-launcher">{draft.launcher}</span>}
      </span>
    );
  }
  return <span className="agent-mark agent-mark-shell">{draft.mode === 'command' ? t('sessionSave.editor.custom') : t('sessionSave.editor.shellOnly')}</span>;
}

export function SessionSaveDialog({ loadPreview, onClose, onSave, restore, initialTab = 'save' }: SessionSaveDialogProps) {
  const [tab, setTab] = useState<DialogTab>(restore ? initialTab : 'save');
  const [step, setStep] = useState<Step>('loading');
  const [preview, setPreview] = useState<SnapshotPreview | null>(null);
  const [drafts, setDrafts] = useState<Map<string, RowDraft>>(new Map());
  const [filter, setFilter] = useState<RowFilter>('all');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setStep('loading');
    setError(null);
    loadPreview()
      .then((next) => {
        setPreview(next);
        setDrafts(new Map(next.tabs.map((tab) => [tab.tabId, initialDraft(tab)])));
        setStep('select');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStep('load-error');
      });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const tabs = useMemo(() => preview?.tabs ?? [], [preview]);
  const rows = useMemo(
    () => tabs.map((tab) => ({ tab, draft: drafts.get(tab.tabId) ?? initialDraft(tab) })),
    [tabs, drafts],
  );
  const picked = rows.filter(({ draft }) => draft.picked);
  const reviewCount = rows.filter(({ tab, draft }) => draft.picked && needsReview(tab, draft)).length;
  const invalidCount = rows.filter(({ tab, draft }) => draft.picked && rowStatus(tab, draft) === 'invalid').length;
  const counts: Record<RowFilter, number> = {
    all: rows.length,
    review: rows.filter(({ tab, draft }) => rowMatchesFilter('review', tab, draft)).length,
    agent: rows.filter(({ tab, draft }) => rowMatchesFilter('agent', tab, draft)).length,
    shell: rows.filter(({ tab, draft }) => rowMatchesFilter('shell', tab, draft)).length,
  };

  const setDraft = (next: RowDraft) => setDrafts((current) => new Map(current).set(next.tabId, next));
  const setAllPicked = (value: boolean) => setDrafts((current) => {
    const next = new Map(current);
    for (const [tabId, draft] of next) next.set(tabId, { ...draft, picked: value });
    return next;
  });

  const save = async () => {
    setStep('saving');
    setError(null);
    try {
      await onSave(picked.map(({ draft }) => toSaveItem(draft)));
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const visible = step === 'select'
    ? rows.filter(({ tab, draft }) => rowMatchesFilter(filter, tab, draft))
    : rows.filter(({ draft }) => draft.picked);
  const groups = groupByWorkspace(visible.map((row) => ({ ...row, workspaceId: row.tab.workspaceId, workspaceName: row.tab.workspaceName })));

  const renderRow = (tab: PreviewTab, draft: RowDraft) => {
    const status = rowStatus(tab, draft);
    if (step === 'done') {
      const line = restoreCommandPreview(draft);
      return (
        <div className="session-done-row" key={tab.tabId}>
          <span className={line.shellOnly ? 'session-done-mark is-shell' : 'session-done-mark'}><Icon name={line.shellOnly ? 'terminal' : 'resume'} size={14} /></span>
          <span className="session-done-name">{tab.tabName}</span>
          <code className={line.shellOnly ? 'is-shell' : undefined} title={line.text}>{line.shellOnly ? t('sessionSave.editor.shellOnly') : line.text}</code>
        </div>
      );
    }
    const rowClass = ['session-row', status === 'invalid' ? 'is-invalid' : needsReview(tab, draft) ? 'is-review' : '', draft.picked ? '' : 'is-unpicked']
      .filter(Boolean).join(' ');
    const sessionText = draft.mode === 'agent' ? (draft.sessionId || '—') : draft.mode === 'command' ? draft.command : '—';
    return (
      <div className={rowClass} key={tab.tabId}>
        <div className="session-row-main">
          <input
            type="checkbox"
            checked={draft.picked}
            disabled={step !== 'select'}
            aria-label={t('sessionSave.all.rowAria', { name: tab.tabName })}
            onChange={(event) => setDraft({ ...draft, picked: event.target.checked })}
          />
          <span className="session-row-name">
            <strong>{tab.tabName}</strong>
            <span className="session-row-cwd" title={tab.cwd ?? ''}>{tab.cwd ?? ''}</span>
          </span>
          <span className="session-row-command">
            {agentLabel(draft)}
            {tab.runningCommand
              ? <code title={tab.runningCommand}>{tab.runningCommand}</code>
              : <span className="session-row-none">{t('sessionSave.all.noCommand')}</span>}
          </span>
          <span className="session-row-id">
            <span className={`session-row-status is-${status}`}>{statusIcon(status)}{t(STATUS_LABEL[status])}</span>
            <span className="session-row-idtext" title={sessionText}>{sessionText}</span>
          </span>
          {step === 'saving' ? <Spinner /> : (
            <button
              type="button"
              className={draft.open ? 'icon-button icon-button-md is-active' : 'icon-button icon-button-md'}
              aria-label={t('sessionSave.all.edit')}
              aria-expanded={draft.open}
              title={t('sessionSave.all.edit')}
              disabled={step !== 'select'}
              onClick={() => setDraft({ ...draft, open: !draft.open })}
            >
              <Icon name="edit" size={16} />
            </button>
          )}
        </div>
        {draft.open && step === 'select' && preview && (
          <RestoreEditor
            draft={draft}
            launchers={preview.launchers}
            candidates={tab.candidates}
            runningCommand={tab.runningCommand}
            onChange={setDraft}
          />
        )}
      </div>
    );
  };

  const note = invalidCount > 0
    ? { text: tn('sessionSave.all.noteInvalid', invalidCount), tone: 'warn' as const }
    : reviewCount > 0
      ? { text: tn('sessionSave.all.noteReview', reviewCount), tone: 'warn' as const }
      : { text: t('sessionSave.all.noteOk'), tone: undefined };

  return (
    <WindowDialog
      dialogId="session-save-dialog"
      title={tab === 'save' && step === 'done' ? tn('sessionSave.all.doneTitle', picked.length) : t('sessionSave.all.title')}
      mode="modal"
      defaultRect={centeredRect(1120, 720)}
      minSize={{ width: 440, height: 380 }}
      onClose={step === 'saving' ? () => undefined : onClose}
      showCloseButton={step !== 'saving'}
      persistGeometry={false}
    >
      <div className="session-save-dialog">
        {restore && (
          <div className="session-save-tabs" role="tablist" aria-label={t('sessionSave.tab.aria')}>
            {(['save', 'restore'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                className="session-save-tab"
                aria-selected={tab === key}
                disabled={step === 'saving'}
                onClick={() => setTab(key)}
              >
                {t(key === 'save' ? 'sessionSave.tab.save' : 'sessionSave.tab.restore')}
              </button>
            ))}
          </div>
        )}
        {tab === 'restore' && restore && <SessionRestoreTab {...restore} onClose={onClose} />}
        {tab === 'save' && <>
        <div className="session-save-body">
          <p className="session-save-lead">{step === 'done' ? t('sessionSave.all.doneBody') : t('sessionSave.all.lead')}</p>
          {step === 'loading' && <div className="session-save-empty"><Spinner /> {t('sessionSave.all.loading')}</div>}
          {step === 'load-error' && <div className="session-save-empty">{t('sessionSave.all.loadError', { error: error ?? '' })}</div>}
          {step === 'select' && rows.length === 0 && <div className="session-save-empty">{t('sessionSave.all.empty')}</div>}
          {step === 'select' && rows.length > 0 && (
            <div className="session-save-toolbar">
              <div className="session-save-filter" role="group" aria-label={t('sessionSave.all.filterAria')}>
                {FILTERS.map((key) => (
                  <button key={key} type="button" className={filter === key ? 'is-active' : undefined} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                    {t(FILTER_LABEL[key])}
                    <span className={key === 'review' && counts.review > 0 ? 'session-save-filter-count is-warn' : 'session-save-filter-count'}>{counts[key]}</span>
                  </button>
                ))}
              </div>
              <label className="session-save-all-toggle">
                <input type="checkbox" checked={picked.length === rows.length} onChange={(event) => setAllPicked(event.target.checked)} />
                <span>{t('sessionSave.all.selectAll')}</span>
                <span className="session-save-all-count">{t('sessionSave.list.selected', { picked: picked.length, total: rows.length })}</span>
              </label>
            </div>
          )}
          {(step === 'select' || step === 'saving' || step === 'done' || step === 'error') && groups.map((group) => (
            <div className="session-save-group" key={group.workspaceId}>
              <div className="ui-group-heading">
                <Icon name="folder" size={13} />
                <span>{group.workspaceName}</span>
                <span>{tn('sessionSave.all.terminalCount', tabs.filter((tab) => tab.workspaceId === group.workspaceId).length)}</span>
              </div>
              {group.items.map(({ tab, draft }) => renderRow(tab, draft))}
            </div>
          ))}
        </div>
        {step === 'select' && (
          <DialogFooter note={note.text} noteTone={note.tone}>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" icon="bookmark-plus" disabled={picked.length === 0 || invalidCount > 0} onClick={() => { void save(); }}>
              {t('sessionSave.all.saveAll', { count: picked.length })}
            </Button>
          </DialogFooter>
        )}
        {(step === 'loading' || step === 'load-error') && (
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
            {step === 'load-error' && <Button variant="primary" onClick={load}>{t('sessionSave.action.retry')}</Button>}
          </DialogFooter>
        )}
        {step === 'saving' && (
          <DialogFooter>
            <Button variant="primary" disabled>{t('sessionSave.save.saving')}</Button>
          </DialogFooter>
        )}
        {step === 'done' && (
          <DialogFooter>
            <Button variant="primary" onClick={onClose}>{t('common.confirm')}</Button>
          </DialogFooter>
        )}
        {step === 'error' && (
          <DialogFooter note={t('sessionSave.save.error', { error: error ?? '' })} noteTone="warn">
            <Button variant="secondary" onClick={() => setStep('select')}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => { void save(); }}>{t('sessionSave.action.retry')}</Button>
          </DialogFooter>
        )}
        </>}
      </div>
    </WindowDialog>
  );
}

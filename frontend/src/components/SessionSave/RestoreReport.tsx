// FR-AITUI-015 AC-6 — after a restart: a banner that says what came back
// without blocking the shells, and a result window where a failed resume is
// corrected and run again.
import { useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common/Icon.tsx';
import { Banner, Button, DialogFooter, Spinner } from '../ui/index.ts';
import { RestoreEditor } from './RestoreEditor.tsx';
import {
  draftFromReport,
  isRetryable,
  summarizeReport,
  toSaveItem,
  type LauncherMap,
  type RestoreReportItem,
  type RestoreResult,
  type RowDraft,
  type SaveItem,
  type SnapshotPreview,
} from './sessionSaveAllModel.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import './SessionSave.css';
import { t, tn } from '../../i18n/i18n.ts';

export interface RestoreReportBannerProps {
  report: RestoreReportItem[];
  onOpen: () => void;
  onDismiss: () => void;
}

export function RestoreReportBanner({ report, onOpen, onDismiss }: RestoreReportBannerProps) {
  const summary = summarizeReport(report);
  const title = summary.waiting > 0
    ? t('sessionSave.report.titleWaiting')
    : summary.failed > 0
      ? tn('sessionSave.report.titleFailed', summary.failed)
      : tn('sessionSave.report.titleDone', report.length);
  const parts = [
    t('sessionSave.report.shellsOpened'),
    summary.resumed > 0 ? t('sessionSave.report.resumed', { count: summary.resumed }) : null,
    summary.failed > 0 ? t('sessionSave.report.failed', { count: summary.failed }) : null,
    summary.waiting > 0 ? t('sessionSave.report.waiting', { count: summary.waiting }) : null,
    summary.shell > 0 ? t('sessionSave.report.shell', { count: summary.shell }) : null,
  ].filter(Boolean);
  return (
    <Banner
      className="session-restore-banner"
      tone={summary.failed > 0 ? 'warn' : 'info'}
      icon="resume"
      title={title}
      description={parts.join(' · ')}
      actions={(
        <>
          <Button variant="primary" size="md" onClick={onOpen}>{t('sessionSave.report.open')}</Button>
          <Button variant="secondary" size="md" onClick={onDismiss}>{t('common.close')}</Button>
        </>
      )}
    />
  );
}

const RESULT_LABEL = {
  confirmed: 'sessionSave.report.result.confirmed',
  typed: 'sessionSave.report.result.typed',
  shell: 'sessionSave.report.result.shell',
  waiting: 'sessionSave.report.result.waiting',
  unconfirmed: 'sessionSave.report.result.unconfirmed',
  failed: 'sessionSave.report.result.notTyped',
} satisfies Record<RestoreResult, MessageKey>;

function resultText(item: RestoreReportItem): string {
  if (item.result === 'failed' && item.reason === 'tab-missing') return t('sessionSave.report.result.tabMissing');
  return t(RESULT_LABEL[item.result]);
}

function resultMark(result: RestoreResult) {
  if (result === 'confirmed' || result === 'typed') return <span className="session-report-mark is-ok"><Icon name="check" size={14} /></span>;
  if (result === 'failed' || result === 'unconfirmed') return <span className="session-report-mark is-bad"><Icon name="close" size={14} /></span>;
  if (result === 'waiting') return <span className="session-report-mark"><Spinner /></span>;
  return <span className="session-report-mark is-muted"><Icon name="terminal" size={14} /></span>;
}

export interface RestoreReportDialogProps {
  report: RestoreReportItem[];
  loadPreview: () => Promise<SnapshotPreview>;
  onRetry: (item: SaveItem) => Promise<RestoreReportItem>;
  onClose: () => void;
}

const FALLBACK_LAUNCHERS: LauncherMap = { claude: ['claude'], codex: ['codex'], hermes: ['hermes'], opencode: ['opencode'] };

export function RestoreReportDialog({ report, loadPreview, onRetry, onClose }: RestoreReportDialogProps) {
  const [launchers, setLaunchers] = useState<LauncherMap>(FALLBACK_LAUNCHERS);
  const [editing, setEditing] = useState<RowDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPreview().then((preview) => setLaunchers(preview.launchers)).catch(() => undefined);
  }, [loadPreview]);

  const run = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await onRetry(toSaveItem(editing));
      setEditing(null);
    } catch (err) {
      setError(t('sessionSave.report.retryError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <WindowDialog
      dialogId="session-restore-report"
      title={t('sessionSave.report.dialogTitle')}
      mode="modal"
      defaultRect={{
        x: Math.max(16, Math.round((window.innerWidth - Math.min(720, window.innerWidth - 32)) / 2)),
        y: 64,
        width: Math.min(720, window.innerWidth - 32),
        height: Math.min(560, window.innerHeight - 96),
      }}
      minSize={{ width: 420, height: 320 }}
      onClose={onClose}
      persistGeometry={false}
    >
      <div className="session-save-dialog">
        <div className="session-save-body session-report-body">
          {report.map((item) => (
            <div className="session-report-row" key={item.tabId}>
              {resultMark(item.result)}
              <span className="session-report-name" title={`${item.workspaceName} · ${item.tabName}`}>
                <strong>{item.tabName}</strong>
                <span>{item.workspaceName}</span>
              </span>
              <span className="session-report-detail">
                <code title={item.commandLine}>{item.commandLine || t('sessionSave.editor.shellOnly')}</code>
                <span className={isRetryable(item) ? 'is-error' : undefined}>{resultText(item)}</span>
              </span>
              {isRetryable(item) && editing?.tabId !== item.tabId && (
                <Button variant="secondary" size="sm" onClick={() => { setError(null); setEditing(draftFromReport(item)); }}>
                  {t('sessionSave.report.fix')}
                </Button>
              )}
              {editing?.tabId === item.tabId && (
                <div className="session-report-editor">
                  <RestoreEditor draft={editing} launchers={launchers} onChange={setEditing} />
                  <div className="session-report-editor-actions">
                    {error && <span className="session-editor-hint is-error">{error}</span>}
                    <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run(); }}>{t('sessionSave.report.run')}</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </div>
    </WindowDialog>
  );
}

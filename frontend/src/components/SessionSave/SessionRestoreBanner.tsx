// FR-AITUI-009 AC-3 — tells the user saved sessions are waiting, without
// blocking the shells that are already open.
import { Button, Banner } from '../ui/index.ts';
import { formatSavedAt, pendingEntries, type SnapshotStatus } from './sessionSnapshotModel.ts';
import './SessionSave.css';
import { tn, t } from '../../i18n/i18n.ts';

export interface SessionRestoreBannerProps {
  status: SnapshotStatus;
  onReview: () => void;
  onLater: () => void;
}

export function SessionRestoreBanner({ status, onReview, onLater }: SessionRestoreBannerProps) {
  const entries = pendingEntries(status);
  const exact = entries.filter((entry) => entry.confidence === 'exact').length;
  const estimated = entries.length - exact;
  const savedAt = formatSavedAt(status.snapshot?.savedAt ?? '');
  return (
    <Banner
      className="session-restore-banner"
      tone="info"
      icon="resume"
      title={tn('sessionSave.banner.title', entries.length)}
      description={[
        savedAt ? t('sessionSave.banner.savedAt', { savedAt }) : null,
        tn('sessionSave.banner.exactCount', exact),
        estimated > 0 ? tn('sessionSave.banner.estimatedCount', estimated) : null,
        t('sessionSave.banner.shellsOpened'),
      ].filter(Boolean).join(' · ')}
      actions={(
        <>
          <Button variant="primary" size="md" onClick={onReview}>{t('sessionSave.banner.review')}</Button>
          <Button variant="secondary" size="md" onClick={onLater}>{t('sessionSave.action.later')}</Button>
        </>
      )}
    />
  );
}

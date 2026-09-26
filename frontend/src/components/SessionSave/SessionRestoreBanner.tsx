// FR-AITUI-009 AC-3 — tells the user saved sessions are waiting, without
// blocking the shells that are already open.
import { Button, Banner } from '../ui/index.ts';
import { formatSavedAt, pendingEntries, type SnapshotStatus } from './sessionSnapshotModel.ts';
import './SessionSave.css';

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
      title={`지난번 저장한 AI 세션 ${entries.length}개를 이어할 수 있습니다`}
      description={[
        savedAt ? `${savedAt} 저장` : null,
        `정확한 ID ${exact}개`,
        estimated > 0 ? `추정 ${estimated}개` : null,
        '탭은 셸로 먼저 열어 두었습니다',
      ].filter(Boolean).join(' · ')}
      actions={(
        <>
          <Button variant="primary" size="md" onClick={onReview}>검토하고 이어하기</Button>
          <Button variant="secondary" size="md" onClick={onLater}>나중에</Button>
        </>
      )}
    />
  );
}

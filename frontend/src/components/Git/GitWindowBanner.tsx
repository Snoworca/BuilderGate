/**
 * One banner under the Git window's toolbar, by priority: the session ended, the
 * session moved to another folder, the selected commit is gone, or the comparison
 * being shown.
 *
 * @req FR-GIT-004
 * @req FR-GIT-009
 */
import { activeLanguage, t, tn } from '../../i18n/i18n.ts';
import { formatRelativeTime } from '../../utils/relativeTime.ts';
import './gitViewer.css';

export type GitBanner =
  | { kind: 'ended' }
  | { kind: 'moved'; path: string; repo: boolean }
  | { kind: 'vanished'; sha: string; subject: string }
  | { kind: 'compare'; base: string; mergeBase: string; commits: number; fetchedAt: number | null };

export interface GitBannerInput {
  ended: boolean;
  moved: { path: string; repo: boolean } | null;
  vanished: { sha: string; subject: string } | null;
  compare: { base: string; mergeBase: string; commits: number; fetchedAt: number | null } | null;
}

export function pickGitBanner(input: GitBannerInput): GitBanner | null {
  if (input.ended) return { kind: 'ended' };
  if (input.moved) return { kind: 'moved', ...input.moved };
  if (input.vanished) return { kind: 'vanished', ...input.vanished };
  if (input.compare) return { kind: 'compare', ...input.compare };
  return null;
}

export interface GitWindowBannerProps {
  banner: GitBanner | null;
  onFollow: () => void;
  onStay: () => void;
  onLatestHead: () => void;
}

export function GitWindowBanner({ banner, onFollow, onStay, onLatestHead }: GitWindowBannerProps) {
  if (!banner) return null;
  switch (banner.kind) {
    case 'ended':
      return <div className="git-banner" data-tone="warn" role="status">{t('git.banner.ended')}</div>;
    case 'moved':
      return (
        <div className="git-banner" data-tone="info" role="status">
          <span>{t('git.banner.moved', { path: banner.path })}</span>
          {banner.repo && <button type="button" className="git-btn" onClick={onFollow}>{t('git.banner.follow')}</button>}
          <button type="button" className="git-btn" onClick={onStay}>{t('git.banner.stay')}</button>
        </div>
      );
    case 'vanished':
      return (
        <div className="git-banner" data-tone="warn" role="status">
          <span>{t('git.banner.vanished', { sha: banner.sha.slice(0, 7) })}</span>
          <button type="button" className="git-btn" onClick={onLatestHead}>{t('git.banner.latestHead')}</button>
        </div>
      );
    default: {
      const fetched = banner.fetchedAt !== null
        ? t('git.banner.fetched', { time: formatRelativeTime(banner.fetchedAt, Date.now(), activeLanguage(), t('git.time.justNow')) })
        : t('git.banner.neverFetched');
      return (
        <div className="git-banner" data-tone="info">
          {t('git.banner.compare', { base: banner.base, sha: banner.mergeBase.slice(0, 7), commits: tn('git.banner.commits', banner.commits), fetched })}
        </div>
      );
    }
  }
}

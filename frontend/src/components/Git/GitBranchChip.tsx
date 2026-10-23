/**
 * The branch chip in a session's bottom bar: branch, changed paths, ahead/behind.
 * What it shows at each width comes from gitChipModel; this only draws it.
 *
 * @req FR-GIT-001
 * @req FR-GIT-002
 */
import { forwardRef } from 'react';
import type { ChipView } from './gitChipModel.ts';
import type { RepoSummary } from './gitApi.ts';
import { t, tn } from '../../i18n/i18n.ts';
import { localizeApiError } from '../../services/apiErrorMessages.ts';
import './gitViewer.css';

export interface GitBranchChipProps {
  view: ChipView | null;
  /** Server error code when there is nothing to show yet. */
  error: string | null;
  label: string;
  onOpen?: () => void;
}

function BranchIcon({ commit }: { commit: boolean }) {
  return commit ? (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="3" /><path d="M8 1v4M8 11v4" /></svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="4" cy="3" r="1.8" /><circle cx="4" cy="13" r="1.8" /><circle cx="12" cy="5" r="1.8" /><path d="M4 5v6M12 7c0 3-8 2-8 4" /></svg>
  );
}

function ClockIcon() {
  return <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></svg>;
}

export function operationText(op: NonNullable<ChipView['operation']>): string {
  switch (op.kind) {
    case 'rebase': return t('git.op.rebase', { step: op.step ?? '?', total: op.total ?? '?' });
    case 'merge': return t('git.op.merge');
    case 'cherryPick': return t('git.op.cherryPick');
    case 'revert': return t('git.op.revert');
    default: return t('git.op.bisect');
  }
}

export const GitBranchChip = forwardRef<HTMLButtonElement, GitBranchChipProps>(function GitBranchChip({ view, error, label, onOpen }, ref) {
  if (!view) {
    return (
      <button ref={ref} type="button" className="git-chip" data-git-chip="" data-state="error" data-tone="warn" aria-label={label} onClick={onOpen}>
        <BranchIcon commit={false} />
        <span>?</span>
      </button>
    );
  }
  return (
    <button
      ref={ref}
      type="button"
      className="git-chip"
      data-git-chip=""
      data-state={error ? 'stale' : 'ok'}
      data-tone={view.tone}
      aria-label={label}
      onClick={onOpen}
    >
      <BranchIcon commit={view.icon === 'commit'} />
      {view.operation && <span className="git-chip-op">{operationText(view.operation)}</span>}
      {view.branch && <span className="git-chip-branch">{view.branch}</span>}
      {view.dirty && <span className="git-chip-dirty">{view.dirty}</span>}
      {view.ahead && <span className="git-chip-ab">{view.ahead.text}</span>}
      {view.tone === 'stale' && <ClockIcon />}
    </button>
  );
});

/** The chip's full description, whatever the width stage shows. */
export function gitChipLabel(summary: RepoSummary | null, error: string | null, stale: boolean): string {
  if (!summary) return t('git.chip.error', { reason: localizeApiError(error ?? 'GIT_FAILED', undefined) ?? error ?? '' });
  const parts: string[] = [];
  if (summary.operation) parts.push(t('git.chip.inProgress', { op: operationText(summary.operation) }));
  parts.push(summary.detached ? t('git.chip.detached', { sha: (summary.head ?? '').slice(0, 7) }) : t('git.chip.branch', { branch: summary.branch ?? '' }));
  parts.push(summary.counts.paths ? tn('git.chip.changes', summary.counts.paths) : t('git.chip.noChanges'));
  if (summary.upstream && summary.ahead) parts.push(t('git.chip.ahead', { count: summary.ahead }));
  if (summary.upstream && summary.behind) parts.push(t('git.chip.behind', { count: summary.behind }));
  if (!summary.upstream && summary.base?.ahead) parts.push(t('git.chip.baseAhead', { base: summary.base.ref, count: summary.base.ahead }));
  if (summary.untrackedScan === 'off') parts.push(t('git.chip.untrackedOff'));
  if (stale) parts.push(t('git.chip.stale'));
  return `${t('git.chip.open')}. ${parts.join(', ')}. ${t('git.chip.menuHint')}`;
}

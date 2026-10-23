/**
 * The branch chip's menu (right click, Shift+F10, long press). Disabled items stay
 * and say why. When the bottom bar hides the path, its copy and its menu move here,
 * so nothing the path offered is lost.
 *
 * @req FR-GIT-003
 */
import type { ContextMenuItem } from '../ContextMenu/ContextMenu.tsx';
import type { RepoSummary } from './gitApi.ts';
import { t } from '../../i18n/i18n.ts';

export interface GitChipMenuInput {
  summary: RepoSummary;
  cwdHidden: boolean;
  onOpen: () => void;
  onOpenWorktree: () => void;
  onCompare: () => void;
  onCopy: (text: string) => void;
  onCopyPath: () => void;
  onPathMenu: () => void;
}

export function buildGitChipMenu(input: GitChipMenuInput): ContextMenuItem[] {
  const { summary } = input;
  const changes = summary.counts.paths;
  const items: ContextMenuItem[] = [
    { label: t('git.chip.open'), onClick: input.onOpen },
    changes
      ? { label: t('git.menu.uncommitted', { count: changes }), onClick: input.onOpenWorktree }
      : { label: t('git.menu.uncommittedNone'), disabled: true, description: t('git.why.noChanges') },
    'ref' in summary.compare
      ? { label: t('git.menu.compare', { base: summary.compare.ref }), onClick: input.onCompare }
      : { label: t('git.menu.compareNone'), disabled: true, description: t(summary.compare.blocked === 'sameAsBase' ? 'git.why.sameAsBase' : 'git.why.noBase') },
    { separator: true },
    summary.detached
      ? { label: t('git.menu.copySha'), onClick: () => input.onCopy(summary.head ?? '') }
      : { label: t('git.menu.copyBranch'), onClick: () => input.onCopy(summary.branch ?? '') },
  ];
  if (input.cwdHidden) {
    items.push(
      { separator: true },
      { label: t('git.menu.copyPath'), onClick: input.onCopyPath },
      { label: t('git.menu.pathMenu'), onClick: input.onPathMenu },
    );
  }
  return items;
}

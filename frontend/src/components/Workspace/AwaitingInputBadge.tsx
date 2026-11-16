import type { ReactElement } from 'react';
import { t, tn } from '../../i18n/i18n.ts';

/**
 * FR-AITUI-024 AC-5: the orange ? before a tab's name while its agent waits on a
 * choice prompt (a permission request, a question). The server sets and clears it.
 */
// @req FR-AITUI-024
export function TabAwaitingInputBadge(): ReactElement {
  const label = t('workspace.tabBar.awaitingInput');
  return (
    <span className="workspace-tab-awaiting" role="img" aria-label={label} title={label}>?</span>
  );
}

/** FR-AITUI-024 AC-5: how many of a workspace's tabs wait, beside its running count. */
// @req FR-AITUI-024
export function WorkspaceAwaitingInputBadge({ count }: { count: number }): ReactElement | null {
  if (count <= 0) return null;
  const label = tn('workspace.item.awaitingInput', count, { count });
  return (
    <span className="ui-badge workspace-item-awaiting" role="img" aria-label={label} title={label}>?{count}</span>
  );
}

export { countAwaitingInputTabs } from './awaitingInputTabs.ts';

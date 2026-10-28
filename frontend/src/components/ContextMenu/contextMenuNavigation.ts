import type { ContextMenuActionItem, ContextMenuItem } from './ContextMenu';
import { t } from '../../i18n/i18n.ts';

export interface ContextMenuNavigationPage {
  path: string[];
  items: ContextMenuItem[];
}

export function createContextMenuRootPage(
  items: ContextMenuItem[],
  rootLabel: string = t('contextMenu.root'),
): ContextMenuNavigationPage {
  return {
    path: [rootLabel],
    items,
  };
}

export function createContextMenuChildPage(
  currentPage: ContextMenuNavigationPage,
  item: ContextMenuActionItem,
): ContextMenuNavigationPage | null {
  if (!item.children || item.children.length === 0) {
    return null;
  }

  return {
    path: [...currentPage.path, item.label],
    items: item.children,
  };
}

/**
 * The pages a phone menu shows: the root page of the items given now, then each submenu named
 * in `childLabels`, looked up again in those items. A menu's items can change while it is open
 * (the path check of FR-ARCH-013 answers later), so the dialog keeps only the labels and rebuilds
 * its pages from the latest items. A submenu that is gone or empty ends the stack at its parent.
 */
// @req FR-ARCH-013
export function resolveContextMenuPages(
  items: ContextMenuItem[],
  childLabels: readonly string[],
  rootLabel?: string,
): ContextMenuNavigationPage[] {
  const pages = [createContextMenuRootPage(items, rootLabel)];
  for (const label of childLabels) {
    const current = pages[pages.length - 1];
    const item = current.items.find(
      (entry): entry is ContextMenuActionItem => !entry.separator && entry.label === label,
    );
    const child = item ? createContextMenuChildPage(current, item) : null;
    if (!child) break;
    pages.push(child);
  }
  return pages;
}

export function formatContextMenuPath(path: string[]): string {
  return path.join(' > ');
}

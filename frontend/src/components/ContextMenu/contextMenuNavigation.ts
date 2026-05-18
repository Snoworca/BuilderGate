import type { ContextMenuActionItem, ContextMenuItem } from './ContextMenu';

export interface ContextMenuNavigationPage {
  path: string[];
  items: ContextMenuItem[];
}

export function createContextMenuRootPage(
  items: ContextMenuItem[],
  rootLabel = '메뉴',
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

export function formatContextMenuPath(path: string[]): string {
  return path.join(' > ');
}

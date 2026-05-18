import type { ContextMenuActionItem, ContextMenuItem } from './ContextMenu';

export const MAX_CONTEXT_MENU_DEPTH = 5;

export interface NormalizeContextMenuOptions {
  maxDepth?: number;
  onDepthExceeded?: (diagnostic: ContextMenuDepthDiagnostic) => void;
}

export interface ContextMenuDepthDiagnostic {
  path: string[];
  strippedLevel: number;
  strippedLabel: string;
}

export function normalizeContextMenuItems(
  items: ContextMenuItem[],
  options: NormalizeContextMenuOptions = {},
): ContextMenuItem[] {
  const maxDepth = Math.max(1, options.maxDepth ?? MAX_CONTEXT_MENU_DEPTH);
  return normalizeLevel(items, 1, [], maxDepth, options.onDepthExceeded);
}

export function hasRenderableContextMenuItems(items: ContextMenuItem[]): boolean {
  return normalizeContextMenuItems(items).length > 0;
}

function normalizeLevel(
  items: ContextMenuItem[],
  depth: number,
  path: string[],
  maxDepth: number,
  onDepthExceeded: NormalizeContextMenuOptions['onDepthExceeded'],
): ContextMenuItem[] {
  const output: ContextMenuItem[] = [];

  for (const item of items) {
    if (item.separator) {
      if (output.length > 0 && !output[output.length - 1].separator) {
        output.push(item);
      }
      continue;
    }

    const currentPath = [...path, item.label];
    const children = item.children ?? [];
    const normalizedChildren = depth < maxDepth
      ? normalizeLevel(children, depth + 1, currentPath, maxDepth, onDepthExceeded)
      : [];

    if (depth >= maxDepth && children.length > 0) {
      reportDepthExceeded(children, currentPath, depth + 1, onDepthExceeded);
    }

    const hasAction = typeof item.onClick === 'function';
    if (!hasAction && normalizedChildren.length === 0) {
      continue;
    }

    const nextItem: ContextMenuActionItem = { ...item };
    if (normalizedChildren.length > 0) {
      nextItem.children = normalizedChildren;
    } else {
      delete nextItem.children;
    }
    output.push(nextItem);
  }

  while (output.length > 0 && output[output.length - 1].separator) {
    output.pop();
  }

  return output;
}

function reportDepthExceeded(
  children: ContextMenuItem[],
  parentPath: string[],
  strippedLevel: number,
  onDepthExceeded: NormalizeContextMenuOptions['onDepthExceeded'],
): void {
  for (const child of children) {
    if (child.separator) {
      continue;
    }
    onDepthExceeded?.({
      path: [...parentPath, child.label],
      strippedLevel,
      strippedLabel: child.label,
    });
  }
}

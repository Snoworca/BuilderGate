export interface ContextMenuRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ContextMenuViewport {
  width: number;
  height: number;
}

export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuPlacement {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
}

export interface ContextMenuPlacementOptions {
  gap?: number;
  margin?: number;
}

const DEFAULT_GAP = 2;
const DEFAULT_MARGIN = 8;

export function getContextMenuViewportLimits(
  viewport: ContextMenuViewport,
  options: ContextMenuPlacementOptions = {},
): { maxWidth: number; maxHeight: number } {
  const margin = options.margin ?? DEFAULT_MARGIN;
  return {
    maxWidth: Math.max(0, viewport.width - margin * 2),
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
}

export function placeRootContextMenu(
  point: ContextMenuPoint,
  menuSize: { width: number; height: number },
  viewport: ContextMenuViewport,
  options: ContextMenuPlacementOptions = {},
): ContextMenuPlacement {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const limits = getContextMenuViewportLimits(viewport, options);
  const width = Math.min(menuSize.width, limits.maxWidth);
  const height = Math.min(menuSize.height, limits.maxHeight);

  return {
    left: clamp(point.x, margin, viewport.width - margin - width),
    top: clamp(point.y, margin, viewport.height - margin - height),
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
  };
}

export function placeSubContextMenu(
  parentRect: ContextMenuRect,
  menuSize: { width: number; height: number },
  viewport: ContextMenuViewport,
  options: ContextMenuPlacementOptions = {},
): ContextMenuPlacement {
  const gap = options.gap ?? DEFAULT_GAP;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const limits = getContextMenuViewportLimits(viewport, options);
  const width = Math.min(menuSize.width, limits.maxWidth);
  const height = Math.min(menuSize.height, limits.maxHeight);

  let left = parentRect.left + parentRect.width + gap;
  if (left + width > viewport.width - margin) {
    left = parentRect.left - width - gap;
  }
  left = clamp(left, margin, viewport.width - margin - width);

  let top = parentRect.top;
  if (top + height > viewport.height - margin) {
    top = viewport.height - margin - height;
  }
  top = clamp(top, margin, viewport.height - margin - height);

  return {
    left,
    top,
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

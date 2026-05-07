import type { DialogRect, DialogSize } from './types';

interface PersistedDialogGeometry {
  schemaVersion?: number;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

export function getDialogGeometryKey(dialogId: string): string {
  return `buildergate.dialog.${dialogId}.geometry`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeViewport(viewport: DialogSize): DialogSize {
  return {
    width: Math.max(0, Number.isFinite(viewport.width) ? viewport.width : 0),
    height: Math.max(0, Number.isFinite(viewport.height) ? viewport.height : 0),
  };
}

export function clampDialogRect(
  rect: DialogRect,
  viewport: DialogSize,
  minSize: DialogSize,
): DialogRect {
  const safeViewport = normalizeViewport(viewport);
  const effectiveMinWidth = safeViewport.width > 0
    ? Math.min(minSize.width, safeViewport.width)
    : Math.max(0, minSize.width);
  const effectiveMinHeight = safeViewport.height > 0
    ? Math.min(minSize.height, safeViewport.height)
    : Math.max(0, minSize.height);

  const maxWidth = safeViewport.width > 0 ? safeViewport.width : effectiveMinWidth;
  const maxHeight = safeViewport.height > 0 ? safeViewport.height : effectiveMinHeight;

  const width = Math.min(Math.max(rect.width, effectiveMinWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, effectiveMinHeight), maxHeight);
  const maxX = Math.max(0, safeViewport.width - width);
  const maxY = Math.max(0, safeViewport.height - height);

  return {
    x: Math.min(Math.max(rect.x, 0), maxX),
    y: Math.min(Math.max(rect.y, 0), maxY),
    width,
    height,
  };
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseStoredRect(raw: string | null): DialogRect | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PersistedDialogGeometry;
    if (
      !isFiniteNumber(parsed.x)
      || !isFiniteNumber(parsed.y)
      || !isFiniteNumber(parsed.width)
      || !isFiniteNumber(parsed.height)
      || parsed.width <= 0
      || parsed.height <= 0
    ) {
      return null;
    }

    return {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
    };
  } catch {
    return null;
  }
}

export function readDialogGeometry(
  dialogId: string,
  defaultRect: DialogRect,
  viewport: DialogSize,
  minSize: DialogSize,
): DialogRect {
  const storage = getStorage();
  const storedRect = storage
    ? parseStoredRect(storage.getItem(getDialogGeometryKey(dialogId)))
    : null;

  return clampDialogRect(storedRect ?? defaultRect, viewport, minSize);
}

export function writeDialogGeometry(dialogId: string, rect: DialogRect): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(
      getDialogGeometryKey(dialogId),
      JSON.stringify({
        schemaVersion: 1,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    console.warn('[WindowDialog] Failed to persist geometry', error);
  }
}

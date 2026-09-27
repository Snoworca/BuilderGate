import { t } from '../../i18n/i18n.ts';
// Pure model for the image viewer tab (FR-MDE-018, SEC-MDE-001).
//
// Offsets are the image centre relative to the stage centre, in CSS px, so a
// stage point (x, y) shows the image point ((x - offsetX) / scale,
// (y - offsetY) / scale). Zooming about a point keeps that image point fixed.

export type Size = { width: number; height: number };

export type ImageViewState = {
  mode: 'fit' | 'actual' | 'free';
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type ImageFailure = { kind: 'read'; error: unknown } | { kind: 'decode' };

export type BlobUrlSlot = {
  replace(blob: Blob): string;
  current(): string | null;
  dispose(): void;
};

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;

/** Wheel zoom factor per 100px of deltaY. */
const WHEEL_STEP = 1.2;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

// @req FR-MDE-018
export function fitScale(viewport: Size, natural: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1;
  }
  return Math.min(viewport.width / natural.width, viewport.height / natural.height, 1);
}

// @req FR-MDE-018
export function initialViewState(viewport: Size, natural: Size): ImageViewState {
  return { mode: 'fit', scale: fitScale(viewport, natural), offsetX: 0, offsetY: 0 };
}

// @req FR-MDE-018
export function toggleFit(state: ImageViewState, viewport: Size, natural: Size): ImageViewState {
  if (state.mode === 'fit') {
    return { mode: 'actual', scale: 1, offsetX: 0, offsetY: 0 };
  }
  return initialViewState(viewport, natural);
}

/** Rescale to `nextScale` keeping the image point under stage point (x, y) fixed. */
function zoomAbout(state: ImageViewState, nextScale: number, x: number, y: number): ImageViewState {
  const scale = clampScale(nextScale);
  const ratio = scale / state.scale;
  return {
    mode: 'free',
    scale,
    offsetX: x - (x - state.offsetX) * ratio,
    offsetY: y - (y - state.offsetY) * ratio,
  };
}

// @req FR-MDE-018
export function applyWheel(
  state: ImageViewState,
  event: { deltaY: number; x: number; y: number },
): ImageViewState {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return state;
  const factor = Math.pow(WHEEL_STEP, -event.deltaY / 100);
  return zoomAbout(state, state.scale * factor, event.x, event.y);
}

// @req FR-MDE-018
export function applyPinch(
  state: ImageViewState,
  event: { previousDistance: number; distance: number; x: number; y: number },
): ImageViewState {
  if (!(event.previousDistance > 0) || !(event.distance > 0)) return state;
  return zoomAbout(state, state.scale * (event.distance / event.previousDistance), event.x, event.y);
}

// @req FR-MDE-018
export function applyPan(state: ImageViewState, dx: number, dy: number): ImageViewState {
  return { ...state, offsetX: state.offsetX + dx, offsetY: state.offsetY + dy };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// @req FR-MDE-018
export function formatImageInfo(width: number, height: number, bytes: number): string {
  return `${width} × ${height} · ${formatBytes(bytes)}`;
}

// @req FR-MDE-018
export function describeImageError(failure: ImageFailure): string {
  if (failure.kind === 'decode') {
    return t('editor.image.decodeFailed');
  }
  const error = failure.error;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\bFILE_TOO_LARGE\b/.test(message)) {
    return t('editor.image.tooLarge');
  }
  if (/\bPATH_NOT_FOUND\b/.test(message)) {
    return t('editor.image.notFound');
  }
  return t('editor.image.refused');
}

// @req SEC-MDE-001
export function createBlobUrlSlot(): BlobUrlSlot {
  let url: string | null = null;
  return {
    replace(blob) {
      const next = URL.createObjectURL(blob);
      if (url !== null) URL.revokeObjectURL(url);
      url = next;
      return next;
    },
    current() {
      return url;
    },
    dispose() {
      if (url !== null) {
        URL.revokeObjectURL(url);
        url = null;
      }
    },
  };
}

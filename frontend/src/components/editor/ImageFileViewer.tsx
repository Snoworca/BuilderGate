import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  applyPan,
  applyPinch,
  applyWheel,
  createBlobUrlSlot,
  describeImageError,
  formatImageInfo,
  initialViewState,
  toggleFit,
} from './imageViewerModel.ts';
import type { BlobUrlSlot, ImageViewState, Size } from './imageViewerModel.ts';
import './ImageFileViewer.css';

// View-only image tab (FR-MDE-018). The bytes arrive as a Blob fetched with the
// Authorization header and are shown through a blob: URL in an <img> only --
// SVG included, so its scripts never run in the page (SEC-MDE-001).

export type ImageFileViewerProps = {
  /** Image bytes; null while loading or after a read failure. */
  blob: Blob | null;
  /** File size in bytes, for the info line. */
  size: number;
  /** Read failure from fileApi.readImage; null when there is none. */
  error: unknown;
  /** Present for SVG: switches the tab to its XML source. */
  onEditSource?: () => void;
};

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  height: '100%',
};

const TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '2px 8px',
  borderBottom: '1px solid var(--line)',
  flex: '0 0 auto',
  color: 'var(--fg-muted)',
  fontSize: '11px',
};

const BUTTON_STYLE: CSSProperties = {
  background: 'transparent',
  color: 'var(--fg-muted)',
  border: '1px solid var(--line)',
  borderRadius: '3px',
  fontSize: '11px',
  padding: '1px 8px',
  cursor: 'pointer',
};

const MESSAGE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  textAlign: 'center',
  color: 'var(--fg-muted)',
  background: 'var(--bg-surface)',
};

type Point = { x: number; y: number };

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// @req FR-MDE-018
// @req SEC-MDE-001
export function ImageFileViewer({ blob, size, error, onEditSource }: ImageFileViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<BlobUrlSlot | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<number | null>(null);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<ImageViewState>({ mode: 'fit', scale: 1, offsetX: 0, offsetY: 0 });
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [panning, setPanning] = useState(false);

  // One blob: URL per Blob. replace() creates the new URL before revoking the
  // previous one, and the current one is revoked only on unmount
  // (SEC-MDE-001 AC-4).
  useEffect(() => {
    if (blob === null) {
      slotRef.current?.dispose();
      setBlobUrl(null);
      setNatural(null);
      return;
    }
    if (slotRef.current === null) slotRef.current = createBlobUrlSlot();
    setNatural(null);
    setDecodeFailed(false);
    setBlobUrl(slotRef.current.replace(blob));
  }, [blob]);

  useEffect(() => () => {
    slotRef.current?.dispose();
    slotRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return undefined;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setViewport((prev) => (prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // While in fit mode the image follows the window size.
  useEffect(() => {
    if (natural === null) return;
    setView((prev) => (prev.mode === 'fit' ? initialViewState(viewport, natural) : prev));
  }, [natural, viewport]);

  /** Stage point relative to the stage centre. */
  const toStagePoint = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  // React registers wheel listeners as passive, which cannot stop the page
  // from scrolling; a native non-passive listener can.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toStagePoint(event.clientX, event.clientY);
      setView((prev) => applyWheel(prev, { deltaY: event.deltaY, ...point }));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [toStagePoint]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];
    pinchRef.current = points.length === 2 ? distance(points[0], points[1]) : null;
    setPanning(points.length === 1);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (previous === undefined) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);

    if (pointers.size === 1) {
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      setView((prev) => applyPan(prev, dx, dy));
      return;
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const nextDistance = distance(a, b);
      const previousDistance = pinchRef.current;
      pinchRef.current = nextDistance;
      if (previousDistance === null) return;
      const centre = toStagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      setView((prev) => applyPinch(prev, { previousDistance, distance: nextDistance, ...centre }));
    }
  }, [toStagePoint]);

  const onPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    const points = [...pointersRef.current.values()];
    pinchRef.current = points.length === 2 ? distance(points[0], points[1]) : null;
    setPanning(points.length === 1);
  }, []);

  const fit = useCallback(() => {
    if (natural !== null) setView(initialViewState(viewport, natural));
  }, [natural, viewport]);

  const actualSize = useCallback(() => {
    setView({ mode: 'actual', scale: 1, offsetX: 0, offsetY: 0 });
  }, []);

  const onDoubleClick = useCallback(() => {
    if (natural !== null) setView((prev) => toggleFit(prev, viewport, natural));
  }, [natural, viewport]);

  const message = error !== null && error !== undefined
    ? describeImageError({ kind: 'read', error })
    : decodeFailed
      ? describeImageError({ kind: 'decode' })
      : null;

  const imageStyle: CSSProperties = {
    transform: `translate(calc(-50% + ${view.offsetX}px), calc(-50% + ${view.offsetY}px)) scale(${view.scale})`,
    visibility: natural === null ? 'hidden' : 'visible',
  };

  return (
    <div className="image-viewer" style={ROOT_STYLE}>
      <div className="image-viewer-toolbar" style={TOOLBAR_STYLE}>
        <button
          type="button"
          style={BUTTON_STYLE}
          className="image-viewer-fit"
          aria-pressed={view.mode === 'fit'}
          disabled={natural === null}
          onClick={fit}
        >
          창 맞춤
        </button>
        <button
          type="button"
          style={BUTTON_STYLE}
          className="image-viewer-actual"
          aria-pressed={view.mode === 'actual'}
          disabled={natural === null}
          onClick={actualSize}
        >
          100%
        </button>
        <span className="image-viewer-zoom">{Math.round(view.scale * 100)}%</span>
        <span className="image-viewer-info" style={{ marginLeft: 'auto' }}>
          {natural !== null ? formatImageInfo(natural.width, natural.height, size) : ''}
        </span>
        {onEditSource !== undefined && (
          <button
            type="button"
            style={BUTTON_STYLE}
            className="image-viewer-edit-source"
            onClick={onEditSource}
          >
            소스 편집
          </button>
        )}
      </div>
      <div
        ref={stageRef}
        className={`image-viewer-stage image-viewer-checkerboard${panning ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onDoubleClick={onDoubleClick}
      >
        {blobUrl !== null && message === null && (
          <img
            src={blobUrl}
            alt=""
            draggable={false}
            className="image-viewer-image"
            style={imageStyle}
            onLoad={(event) => {
              const img = event.currentTarget;
              const loaded = { width: img.naturalWidth, height: img.naturalHeight };
              setNatural(loaded);
              setView(initialViewState(viewport, loaded));
            }}
            onError={() => setDecodeFailed(true)}
          />
        )}
        {message !== null && (
          <div className="image-viewer-message" role="alert" style={MESSAGE_STYLE}>
            {message}
          </div>
        )}
      </div>
    </div>
  );
}

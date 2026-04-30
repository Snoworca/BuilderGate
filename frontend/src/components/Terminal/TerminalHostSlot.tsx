import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';

interface TerminalHostSlotProps {
  tabId: string;
  isVisible: boolean;
  className?: string;
  style?: React.CSSProperties;
  onContextMenu?: (x: number, y: number) => void;
  onPointerDown?: () => void;
}

export function TerminalHostSlot({
  tabId,
  isVisible,
  className,
  style,
  onContextMenu,
  onPointerDown,
}: TerminalHostSlotProps) {
  const hostId = useId();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rafMeasureRef = useRef<number | null>(null);
  const { rootRef, upsertHost, removeHost, layoutVersion } = useTerminalRuntimeContext();

  const measure = useCallback(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    const hostRect = host.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    upsertHost(
      tabId,
      hostId,
      {
        left: hostRect.left - rootRect.left,
        top: hostRect.top - rootRect.top,
        width: hostRect.width,
        height: hostRect.height,
      },
      isVisible,
      {
        className,
        style,
        onContextMenu,
        onPointerDown,
      },
    );
  }, [className, hostId, isVisible, onContextMenu, onPointerDown, rootRef, style, tabId, upsertHost]);

  const scheduleMeasure = useCallback(() => {
    if (rafMeasureRef.current !== null) {
      cancelAnimationFrame(rafMeasureRef.current);
    }

    rafMeasureRef.current = requestAnimationFrame(() => {
      rafMeasureRef.current = null;
      measure();
    });
  }, [measure]);

  useLayoutEffect(() => {
    measure();
    scheduleMeasure();
  }, [layoutVersion, measure, scheduleMeasure]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const root = rootRef.current;
    if (!host || !root) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      measure();
      scheduleMeasure();
    });

    resizeObserver.observe(host);
    resizeObserver.observe(root);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure, rootRef, scheduleMeasure]);

  useLayoutEffect(() => {
    return () => {
      if (rafMeasureRef.current !== null) {
        cancelAnimationFrame(rafMeasureRef.current);
        rafMeasureRef.current = null;
      }
      removeHost(tabId, hostId);
    };
  }, [hostId, removeHost, tabId]);

  return <div data-terminal-host-slot={tabId} ref={hostRef} style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }} />;
}

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { REVEAL_SETTLE_DELAYS_MS } from './terminalRevealSettle';

interface TerminalHostSlotProps {
  tabId: string;
  isVisible: boolean;
  clipboardContextKey?: string | null;
  className?: string;
  style?: React.CSSProperties;
  onContextMenu?: (x: number, y: number) => void;
  onPointerDown?: () => void;
}

export function TerminalHostSlot({
  tabId,
  isVisible,
  clipboardContextKey,
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
        clipboardContextKey,
        onContextMenu,
        onPointerDown,
      },
    );
  }, [className, clipboardContextKey, hostId, isVisible, onContextMenu, onPointerDown, rootRef, style, tabId, upsertHost]);

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

  // REL-BGSTAB-049: a slot that becomes visible is measured again over the next second. A size
  // observer sees no move of the box (the app shifting as the keyboard closes) and one missed
  // frame would leave the terminal parked off screen -- a blank stage until the next switch.
  useEffect(() => {
    if (!isVisible) return undefined;
    const timers = REVEAL_SETTLE_DELAYS_MS.map((ms) => setTimeout(scheduleMeasure, ms));
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [isVisible, scheduleMeasure]);

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
    // REL-BGSTAB-052 AC-8: a scroll anywhere in the page (a file list, the editor) fires this
    // capture listener per event; measuring there forced a layout per event per slot. One
    // measure on the next frame keeps the terminal in place.
    const onScroll = () => scheduleMeasure();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, { capture: true });
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

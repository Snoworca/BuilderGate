import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalContainer } from './TerminalContainer';
import { useTerminalRuntimeRegistryActions } from '../../contexts/TerminalRuntimeRegistryContext';
import type { WorkspaceTabRuntime } from '../../types/workspace';

export interface TerminalRuntimeRenderItem {
  tab: WorkspaceTabRuntime;
  slotId: string;
  isVisible: boolean;
}

interface HostGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  attached: boolean;
}

interface Props {
  items: TerminalRuntimeRenderItem[];
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange?: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
}

function getHostGeometry(layer: HTMLElement, slotId: string): HostGeometry {
  const searchRoot = layer.parentElement ?? layer;
  const host = searchRoot.querySelector<HTMLElement>(`[data-terminal-host-slot-id="${slotId}"]`);
  if (!host) {
    return { left: 0, top: 0, width: 0, height: 0, attached: false };
  }

  const layerRect = layer.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return {
    left: hostRect.left - layerRect.left,
    top: hostRect.top - layerRect.top,
    width: hostRect.width,
    height: hostRect.height,
    attached: true,
  };
}

function areLayoutsEqual(
  previous: Record<string, HostGeometry>,
  next: Record<string, HostGeometry>,
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;

  return nextKeys.every((key) => {
    const prev = previous[key];
    const current = next[key];
    return Boolean(prev) &&
      prev.left === current.left &&
      prev.top === current.top &&
      prev.width === current.width &&
      prev.height === current.height &&
      prev.attached === current.attached;
  });
}

export function TerminalRuntimeLayer({
  items,
  onStatusChange,
  onCwdChange,
  onAuthError,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [hostLayouts, setHostLayouts] = useState<Record<string, HostGeometry>>({});
  const { ensureTabHandleRef } = useTerminalRuntimeRegistryActions();

  const layoutKey = useMemo(
    () => items.map(({ tab, slotId, isVisible }) => `${tab.id}:${tab.sessionId}:${slotId}:${isVisible ? '1' : '0'}`).join(','),
    [items],
  );

  const recomputeLayouts = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;

    const nextLayouts: Record<string, HostGeometry> = {};
    for (const { tab, slotId } of items) {
      nextLayouts[tab.id] = getHostGeometry(layer, slotId);
    }

    setHostLayouts((previous) => (areLayoutsEqual(previous, nextLayouts) ? previous : nextLayouts));
  }, [items]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const searchRoot = layer.parentElement ?? layer;

    let rafId = requestAnimationFrame(recomputeLayouts);
    const observer = new ResizeObserver(() => {
      recomputeLayouts();
    });

    observer.observe(layer);
    for (const { slotId } of items) {
      const host = searchRoot.querySelector<HTMLElement>(`[data-terminal-host-slot-id="${slotId}"]`);
      if (host) observer.observe(host);
    }

    window.addEventListener('resize', recomputeLayouts);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', recomputeLayouts);
    };
  }, [layoutKey, items, recomputeLayouts]);

  return (
    <div
      ref={layerRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      {items.map(({ tab, isVisible }) => {
        if (tab.status === 'disconnected') {
          return null;
        }

        const geometry = hostLayouts[tab.id] ?? {
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          attached: false,
        };

        return (
          <div
            key={`runtime-${tab.id}-${tab.sessionId}`}
            style={{
              position: 'absolute',
              left: `${geometry.left}px`,
              top: `${geometry.top}px`,
              width: `${geometry.width}px`,
              height: `${geometry.height}px`,
              display: 'flex',
              visibility: isVisible ? 'visible' : 'hidden',
              pointerEvents: isVisible ? 'auto' : 'none',
              zIndex: isVisible ? 1 : 0,
            }}
          >
            <TerminalContainer
              ref={ensureTabHandleRef(tab.id)}
              sessionId={tab.sessionId}
              isVisible={isVisible}
              onStatusChange={onStatusChange}
              onCwdChange={onCwdChange}
              onAuthError={onAuthError}
            />
          </div>
        );
      })}
    </div>
  );
}

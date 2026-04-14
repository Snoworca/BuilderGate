import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  useTerminalRuntimeRegistryActions,
  type TerminalHostSlotKind,
} from '../../contexts/TerminalRuntimeRegistryContext';

interface Props {
  slotId: string;
  tabId: string;
  sessionId: string;
  slotKind: TerminalHostSlotKind;
  visible: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function TerminalHostSlot({
  slotId,
  tabId,
  sessionId,
  slotKind,
  visible,
  children,
  className,
  style,
}: Props) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const { removeHostSlot, upsertHostSlot } = useTerminalRuntimeRegistryActions();

  useEffect(() => {
    upsertHostSlot({
      slotId,
      tabId,
      sessionId,
      slotKind,
      visible,
      attached: Boolean(slotRef.current),
    });

    return () => {
      removeHostSlot(slotId);
    };
  }, [removeHostSlot, sessionId, slotId, slotKind, tabId, upsertHostSlot, visible]);

  return (
    <div
      ref={slotRef}
      className={className}
      data-terminal-host-slot-id={slotId}
      data-terminal-slot-kind={slotKind}
      data-terminal-session-id={sessionId}
      style={{ pointerEvents: 'none', ...style }}
    >
      {children}
    </div>
  );
}

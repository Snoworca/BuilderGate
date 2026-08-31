import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  createTerminalOutputPolicySelectionCoordinator,
  type TerminalOutputPolicySelectionCoordinator,
} from '../../utils/terminalOutputScheduler';

interface HostRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalHostState {
  hostId: string;
  tabId: string;
  rect: HostRect;
  isVisible: boolean;
  clipboardContextKey?: string | null;
  className?: string;
  style?: CSSProperties;
}

interface TerminalHostInteractions {
  onContextMenu?: (x: number, y: number) => void;
  onPointerDown?: () => void;
}

interface TerminalRuntimeContextValue {
  rootRef: React.RefObject<HTMLDivElement | null>;
  hosts: Map<string, TerminalHostState>;
  layoutVersion: number;
  outputPolicySelectionCoordinator: TerminalOutputPolicySelectionCoordinator;
  upsertHost: (
    tabId: string,
    hostId: string,
    rect: HostRect,
    isVisible: boolean,
    extras?: Pick<TerminalHostState, 'className' | 'style' | 'clipboardContextKey'> & TerminalHostInteractions,
  ) => void;
  removeHost: (tabId: string, hostId: string) => void;
  getHostInteractions: (tabId: string) => TerminalHostInteractions | undefined;
  invalidateHostLayouts: () => void;
}

const TerminalRuntimeContext = createContext<TerminalRuntimeContextValue | null>(null);

export function TerminalRuntimeProvider({
  children,
  outputPolicySelectionCoordinator,
}: {
  children: ReactNode;
  outputPolicySelectionCoordinator?: TerminalOutputPolicySelectionCoordinator;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hosts, setHosts] = useState<Map<string, TerminalHostState>>(new Map());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const hostInteractionsRef = useRef<Map<string, TerminalHostInteractions>>(new Map());
  const [defaultOutputPolicySelectionCoordinator] = useState(
    () => createTerminalOutputPolicySelectionCoordinator(),
  );
  const activeOutputPolicySelectionCoordinator = outputPolicySelectionCoordinator
    ?? defaultOutputPolicySelectionCoordinator;

  const upsertHost = useCallback((
    tabId: string,
    hostId: string,
    rect: HostRect,
    isVisible: boolean,
    extras?: Pick<TerminalHostState, 'className' | 'style' | 'clipboardContextKey'> & TerminalHostInteractions,
  ) => {
    hostInteractionsRef.current.set(tabId, {
      onContextMenu: extras?.onContextMenu,
      onPointerDown: extras?.onPointerDown,
    });

    setHosts((prev) => {
      const current = prev.get(tabId);
      const nextState: TerminalHostState = {
        hostId,
        tabId,
        rect,
        isVisible,
        clipboardContextKey: extras?.clipboardContextKey,
        className: extras?.className,
        style: extras?.style,
      };

      if (
        current &&
        current.hostId === nextState.hostId &&
        current.isVisible === nextState.isVisible &&
        current.clipboardContextKey === nextState.clipboardContextKey &&
        current.className === nextState.className &&
        sameRect(current.rect, nextState.rect) &&
        sameStyle(current.style, nextState.style)
      ) {
        return prev;
      }

      const next = new Map(prev);
      next.set(tabId, nextState);
      return next;
    });
  }, []);

  const removeHost = useCallback((tabId: string, hostId: string) => {
    setHosts((prev) => {
      const current = prev.get(tabId);
      if (!current || current.hostId !== hostId) {
        return prev;
      }

      const next = new Map(prev);
      next.delete(tabId);
      hostInteractionsRef.current.delete(tabId);
      return next;
    });
  }, []);

  const getHostInteractions = useCallback((tabId: string) => {
    return hostInteractionsRef.current.get(tabId);
  }, []);

  const invalidateHostLayouts = useCallback(() => {
    setLayoutVersion((current) => current + 1);
  }, []);

  const value = useMemo<TerminalRuntimeContextValue>(() => ({
    rootRef,
    hosts,
    layoutVersion,
    outputPolicySelectionCoordinator: activeOutputPolicySelectionCoordinator,
    upsertHost,
    removeHost,
    getHostInteractions,
    invalidateHostLayouts,
  }), [
    activeOutputPolicySelectionCoordinator,
    getHostInteractions,
    hosts,
    invalidateHostLayouts,
    layoutVersion,
    removeHost,
    upsertHost,
  ]);

  return (
    <TerminalRuntimeContext.Provider value={value}>
      {children}
    </TerminalRuntimeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTerminalRuntimeContext(): TerminalRuntimeContextValue {
  const context = useContext(TerminalRuntimeContext);
  if (!context) {
    throw new Error('useTerminalRuntimeContext must be used within TerminalRuntimeProvider');
  }
  return context;
}

function sameRect(left: HostRect, right: HostRect): boolean {
  return left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height;
}

function sameStyle(left?: CSSProperties, right?: CSSProperties): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;

  return leftEntries.every(([key, value]) => right[key as keyof CSSProperties] === value);
}

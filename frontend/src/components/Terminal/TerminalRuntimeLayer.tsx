import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalContainer } from './TerminalContainer';
import type { TerminalHandle } from './TerminalView';
import { useTerminalRuntimeContext } from './TerminalRuntimeContext';
import { ensureTerminalRef, pruneTerminalRefsMap } from './terminalRuntimeRefs';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { useLongPress } from '../../hooks/useLongPress';
import { dismissSoftKeyboard } from '../../hooks/doubleTap';
import type { TerminalShortcutState } from '../../types';
import { suppressTerminalSecondaryButtonEvent } from '../../utils/terminalPointerPolicy';
import { createTouchTapTracker, shouldFocusTerminalOnPointerDown } from '../../utils/terminalTouchTapPolicy';
import { t } from '../../i18n/i18n.ts';
import { readDroppedSources } from '../fileExplorer/fileDropEntries.ts';
import { startUpload } from '../fileExplorer/fileTransferRuntime.ts';
import { openPathOnLatchedTap } from '../../utils/latchedTapPathOpen.ts';
import { requestTerminalPathOpen } from '../../utils/terminalPathOpen.ts';
import {
  answerTerminalDropConflict,
  createTerminalDropDepth,
  decideTerminalFileDrag,
  readDesktopDropSurface,
  terminalDropDirLabel,
} from './terminalFileDrop';
import './terminalFileDrop.css';

const PARKED_STYLE: React.CSSProperties = {
  position: 'absolute',
  left: -100000,
  top: 0,
  width: 1,
  height: 1,
  overflow: 'hidden',
  pointerEvents: 'none',
  opacity: 0,
};

interface TerminalRuntimeLayerProps {
  tabs: WorkspaceTabRuntime[];
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
  /** REL-BGSTAB-053: the redraw shortcut pressed in this tab's terminal. */
  onRedrawRequest?: (tabId: string) => void;
  terminalShortcutState: TerminalShortcutState | null;
}

interface TerminalRuntimeEntryProps {
  tab: WorkspaceTabRuntime;
  host?: ReturnType<typeof useTerminalRuntimeContext>['hosts'] extends Map<string, infer TValue> ? TValue : never;
  terminalRefsMap: React.MutableRefObject<Map<string, { current: TerminalHandle | null }>>;
  onStatusChange: (sessionId: string, status: WorkspaceTabRuntime['status']) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
  onRedrawRequest?: (tabId: string) => void;
  terminalShortcutState: TerminalShortcutState | null;
}

function TerminalRuntimeEntry({
  tab,
  host,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
  onRedrawRequest,
  terminalShortcutState,
}: TerminalRuntimeEntryProps) {
  const { getHostInteractions, outputPolicySelectionCoordinator } = useTerminalRuntimeContext();
  const tabId = tab.id;
  const onRedrawShortcut = useCallback(() => onRedrawRequest?.(tabId), [onRedrawRequest, tabId]);
  const isVisible = Boolean(host?.isVisible && host.rect.width > 0 && host.rect.height > 0);
  const isGridSurface = Boolean(host?.className?.includes('grid-cell'));
  const style: React.CSSProperties = isVisible && host
    ? {
        position: 'absolute',
        left: host.rect.left,
        top: host.rect.top,
        width: host.rect.width,
        height: host.rect.height,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        pointerEvents: 'auto',
        ...(host.style ?? {}),
      }
    : PARKED_STYLE;

  // FR-ARCH-010: a touch focuses the terminal (and so opens the iOS keyboard)
  // only when it ends as a short tap, never when it begins.
  const touchTapRef = useRef(createTouchTapTracker());
  const lastPointerWasTouchRef = useRef(false);

  const longPress = useLongPress(
    ({ clientX, clientY, gesture }) => {
      touchTapRef.current.longPress();
      // FR-UIDS-013 AC-5: the double tap's first tap opened the keyboard; the menu replaces it.
      if (gesture === 'double-tap') dismissSoftKeyboard();
      getHostInteractions(tab.id)?.onContextMenu?.(clientX, clientY);
    },
    500,
  );

  // FR-FEX-031: operating-system files dragged over the session upload into its folder.
  const dropDepthRef = useRef(createTerminalDropDepth());
  const [fileDropActive, setFileDropActive] = useState(false);
  const isFileUploadDrag = (event: React.DragEvent<HTMLDivElement>) =>
    decideTerminalFileDrag({ types: event.dataTransfer.types, desktop: readDesktopDropSurface() }) === 'upload';

  // AC-2: a drag that ends anywhere else (dropped outside, left the window) clears the overlay.
  useEffect(() => {
    if (!fileDropActive) return;
    const clear = () => {
      dropDepthRef.current.reset();
      setFileDropActive(false);
    };
    const onWindowDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) clear();
    };
    window.addEventListener('drop', clear);
    window.addEventListener('dragend', clear);
    window.addEventListener('dragleave', onWindowDragLeave);
    return () => {
      window.removeEventListener('drop', clear);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('dragleave', onWindowDragLeave);
    };
  }, [fileDropActive]);

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileUploadDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dropDepthRef.current.reset();
    setFileDropActive(false);
    // The DataTransfer is emptied once this event returns; its entries are taken now.
    readDroppedSources(event.dataTransfer.items)
      .then((sources) => {
        if (sources.length === 0) return null;
        return startUpload({
          sessionId: tab.sessionId,
          dir: '',
          dirLabel: terminalDropDirLabel(tab.cwd),
          workspaceId: tab.workspaceId,
          tabId: tab.id,
          sources,
          existingNames: [],
          ask: (detail) => Promise.resolve(answerTerminalDropConflict(detail)),
          onRejected: (items) => console.warn('[terminal-file-drop] refused', items),
        });
      })
      .catch((error: unknown) => console.warn('[terminal-file-drop] upload failed', error));
  };

  const focusTerminal = (fallbackRoot?: EventTarget | null) => {
    const handle = terminalRefsMap.current.get(tab.id)?.current;
    if (handle) {
      handle.focus('runtime-layer');
      return;
    }

    const fallbackTextarea =
      fallbackRoot instanceof Element
        ? fallbackRoot.querySelector('textarea.xterm-helper-textarea')
        : null;
    if (fallbackTextarea instanceof HTMLTextAreaElement) {
      fallbackTextarea.focus();
    }
  };

  return (
    <div
      className={host?.className}
      data-terminal-runtime-entry="true"
      data-session-id={tab.sessionId}
      data-tab-id={tab.id}
      style={style}
      onPointerDownCapture={(event) => {
        if (suppressTerminalSecondaryButtonEvent(event)) {
          return;
        }

        if (event.button === 1 && isGridSurface) {
          event.preventDefault();
          event.stopPropagation();
          terminalRefsMap.current.get(tab.id)?.current?.requestGridRepair?.('manual');
          return;
        }

        lastPointerWasTouchRef.current = !shouldFocusTerminalOnPointerDown(event.pointerType);
        if (lastPointerWasTouchRef.current) {
          // Wait for the click: only a tap may focus.
          return;
        }

        if (isGridSurface) {
          for (const terminalRef of terminalRefsMap.current.values()) {
            terminalRef.current?.invalidateClipboardContext();
          }
        }

        getHostInteractions(tab.id)?.onPointerDown?.();
        focusTerminal(event.currentTarget);
      }}
      onMouseDownCapture={(event) => {
        if (suppressTerminalSecondaryButtonEvent(event)) {
          return;
        }
        // A compatibility mousedown after a touch that was not a tap must not
        // reach xterm, which focuses its input on mousedown.
        if (lastPointerWasTouchRef.current && !touchTapRef.current.isTap()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        if (lastPointerWasTouchRef.current) {
          if (!touchTapRef.current.consumeTap()) {
            event.stopPropagation();
            return;
          }
          // FR-ARCH-013 AC-10: with the key bar's Ctrl latched, a tap on a path opens it.
          if (openPathOnLatchedTap(event.clientX, event.clientY, {
            pathsAt: (x, y) => terminalRefsMap.current.get(tab.id)?.current?.getPathsAt(x, y),
            open: (target) => requestTerminalPathOpen(tab.sessionId, target),
          })) {
            event.stopPropagation();
            return;
          }
          if (isGridSurface) {
            for (const terminalRef of terminalRefsMap.current.values()) {
              terminalRef.current?.invalidateClipboardContext();
            }
          }
        }
        getHostInteractions(tab.id)?.onPointerDown?.();
        focusTerminal(event.currentTarget);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        getHostInteractions(tab.id)?.onContextMenu?.(event.clientX, event.clientY);
      }}
      onContextMenuCapture={(event) => {
        event.preventDefault();
        getHostInteractions(tab.id)?.onContextMenu?.(event.clientX, event.clientY);
      }}
      onTouchStart={(event) => {
        touchTapRef.current.touchStart(event.touches);
        longPress.onTouchStart(event);
      }}
      onTouchMove={(event) => {
        touchTapRef.current.touchMove(event.touches);
        longPress.onTouchMove(event);
      }}
      onTouchEnd={longPress.onTouchEnd}
      onDragEnter={(event) => {
        if (!isFileUploadDrag(event)) return;
        event.preventDefault();
        setFileDropActive(dropDepthRef.current.enter());
      }}
      onDragOver={(event) => {
        if (!isFileUploadDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!isFileUploadDrag(event)) return;
        setFileDropActive(dropDepthRef.current.leave());
      }}
      onDrop={handleFileDrop}
    >
      <TerminalContainer
        ref={ensureTerminalRef(terminalRefsMap.current, tab.id)}
        sessionId={tab.sessionId}
        workspaceId={tab.workspaceId}
        terminalShortcutState={terminalShortcutState}
        isVisible={isVisible}
        isGridSurface={isGridSurface}
        clipboardContextKey={host?.clipboardContextKey}
        outputPolicySelectionCoordinator={outputPolicySelectionCoordinator}
        onStatusChange={onStatusChange}
        onCwdChange={onCwdChange}
        onAuthError={onAuthError}
        onRedrawShortcut={onRedrawShortcut}
      />
      {fileDropActive && (
        <div className="terminal-file-drop-overlay" data-terminal-file-drop="true">
          <span className="terminal-file-drop-overlay-label">{t('terminal.fileDrop.overlay')}</span>
        </div>
      )}
    </div>
  );
}

export function TerminalRuntimeLayer({
  tabs,
  terminalRefsMap,
  onStatusChange,
  onCwdChange,
  onAuthError,
  onRedrawRequest,
  terminalShortcutState,
}: TerminalRuntimeLayerProps) {
  const { rootRef, hosts } = useTerminalRuntimeContext();

  const activeRuntimes = useMemo(
    () => tabs.filter((tab) => tab.status !== 'disconnected'),
    [tabs],
  );
  const activeRuntimeIds = useMemo(
    () => new Set(activeRuntimes.map((tab) => tab.id)),
    [activeRuntimes],
  );

  useEffect(() => {
    pruneTerminalRefsMap(terminalRefsMap.current, activeRuntimeIds);
  }, [activeRuntimeIds, terminalRefsMap]);

  return (
    <>
      <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      {activeRuntimes.map((tab) => {
        return (
          <TerminalRuntimeEntry
            key={`runtime-${tab.id}-${tab.sessionId}`}
            tab={tab}
            host={hosts.get(tab.id)}
            terminalRefsMap={terminalRefsMap}
            onStatusChange={onStatusChange}
            onCwdChange={onCwdChange}
            onAuthError={onAuthError}
            onRedrawRequest={onRedrawRequest}
            terminalShortcutState={terminalShortcutState}
          />
        );
      })}
    </>
  );
}

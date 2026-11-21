// The input box under a session's terminal. The draft lives in a plain textarea, out of the
// PTY's input line, so messages pasted into the session while the user writes cannot split
// it; sending puts the whole draft in at once through the terminal's paste path, then Enter.
// @req FR-CMP-001 FR-CMP-002 FR-CMP-003

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceTabRuntime } from '../../types/workspace';
import { t } from '../../i18n/i18n.ts';
import { Icon } from '../common/Icon';
import { buildTerminalShortcutKeyDescriptor, resolveTerminalShortcut } from '../../utils/terminalShortcutBindings';
import {
  COMPOSER_AUTOGROW_DELAY_MS,
  COMPOSER_ERROR_ROW_PX,
  NOT_BROWSING_HISTORY,
  applyContinueLine,
  clampComposerHeight,
  composerEnterDelayMs,
  composerLayoutHeight,
  composerSendErrorKey,
  countDraftLines,
  countVisualLines,
  decideComposerEnter,
  estimateTerminalRowPx,
  historyCaret,
  isCaretOnFirstLine,
  isImeComposingKey,
  isSendableDraft,
  navigateComposerHistory,
  type ComposerHistoryBrowse,
} from './sessionComposerModel.ts';
import { sessionComposerStore, useComposerHeight, useComposerSession } from './sessionComposerStore.ts';
import { runComposerShortcut, useSessionComposerHost } from './sessionComposerHost.ts';
import './SessionComposer.css';

/** The session status row under the composer (MetadataRow). */
const STATUS_ROW_PX = 28;
const FONT_STORAGE_KEY = 'terminal_font_size';

function readTerminalRowPx(): number {
  try {
    return estimateTerminalRowPx(window.localStorage.getItem(FONT_STORAGE_KEY));
  } catch {
    return estimateTerminalRowPx(null);
  }
}

interface DragState {
  pointerId: number;
  startY: number;
  startHeight: number;
}

export function SessionComposer({ tab }: { tab: WorkspaceTabRuntime }) {
  const host = useSessionComposerHost();
  const session = useComposerSession(tab.id);
  if (!host || !session.open) return null;
  return <OpenSessionComposer tab={tab} />;
}

function OpenSessionComposer({ tab }: { tab: WorkspaceTabRuntime }) {
  const host = useSessionComposerHost()!;
  const tabId = tab.id;
  const session = useComposerSession(tabId);
  const chosenHeight = useComposerHeight();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [browse, setBrowse] = useState<ComposerHistoryBrowse>(NOT_BROWSING_HISTORY);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [tileHeight, setTileHeight] = useState(0);
  const [dragPreview, setDragPreview] = useState<number | null>(null);
  const [tileWidth, setTileWidth] = useState(0);
  const [lineCount, setLineCount] = useState(() => countDraftLines(session.draft));
  const [layoutLines, setLayoutLines] = useState(lineCount);

  // FR-CMP-002 AC-2: wrapped lines count too. The box is measured at zero height for one
  // synchronous read and put back before anything paints.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const style = getComputedStyle(textarea);
    const kept = textarea.style.height;
    textarea.style.height = '0px';
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = kept;
    setLineCount(countVisualLines({
      draft: session.draft,
      scrollHeight,
      paddingY: (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0),
      lineHeightPx: Number.parseFloat(style.lineHeight) || 0,
    }));
  }, [session.draft, tileWidth]);

  // FR-CMP-001 AC-2 AC-3: a toggle, the shortcut or the menu asked for the caret here.
  useEffect(() => {
    if (sessionComposerStore.takeFocusRequest(tabId)) textareaRef.current?.focus();
  }, [session.focusSeq, tabId]);

  // FR-CMP-002 AC-1: the limits follow the tile.
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      setTileHeight(parent.clientHeight);
      setTileWidth(parent.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // FR-CMP-002 AC-2: a new line count reaches the layout -- and so the terminal's size --
  // only once typing settles, not on every keystroke.
  useEffect(() => {
    if (lineCount === layoutLines) return;
    const timer = setTimeout(() => setLayoutLines(lineCount), COMPOSER_AUTOGROW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [lineCount, layoutLines]);

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.setSelectionRange(caret, caret);
  }, [session.draft]);

  const clamp = useCallback((requested: number) => clampComposerHeight({
    requested,
    tileHeight,
    reservedPx: STATUS_ROW_PX,
    terminalRowPx: readTerminalRowPx(),
    mobile: host.mobile,
  }), [tileHeight, host.mobile]);

  const maxHeight = clamp(chosenHeight);
  const boxHeight = composerLayoutHeight({ chosenHeight: maxHeight, lineCount: layoutLines });
  const layoutHeight = boxHeight + (error ? COMPOSER_ERROR_ROW_PX : 0);

  const setDraft = useCallback((draft: string, caret: number | null) => {
    // An unchanged draft does not render again, so its caret is applied here and now; left
    // pending it would move the caret on the next keystroke.
    if (sessionComposerStore.getSession(tabId).draft === draft) {
      pendingCaretRef.current = null;
      if (caret !== null) textareaRef.current?.setSelectionRange(caret, caret);
      return;
    }
    pendingCaretRef.current = caret;
    sessionComposerStore.setDraft(tabId, draft);
  }, [tabId]);

  const disconnected = tab.status === 'disconnected';
  const canSend = isSendableDraft(session.draft) && !sending && !disconnected;

  const send = useCallback(() => {
    const text = sessionComposerStore.getSession(tabId).draft;
    if (!isSendableDraft(text) || sending || disconnected) return;
    const pasted = host.pasteText(tabId, text);
    // The paste path hands focus to the terminal; FR-CMP-003 AC-3 keeps it here.
    textareaRef.current?.focus();
    if (!pasted.ok) {
      setError(t(composerSendErrorKey(pasted.reason)));
      return;
    }
    sessionComposerStore.recordSent(tabId, text);
    setBrowse(NOT_BROWSING_HISTORY);
    setError(null);
    setSending(true);
    // Not cancelled on unmount: once the text is in, its Enter must follow even if the
    // box is closed during the wait.
    setTimeout(() => {
      const entered = host.sendInput(tabId, '\r');
      setSending(false);
      if (!entered?.ok) setError(t('composer.error.enterFailed'));
    }, composerEnterDelayMs(text));
  }, [host, tabId, sending, disconnected]);

  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    // Editing a recalled entry makes it the user's own draft.
    setBrowse(NOT_BROWSING_HISTORY);
    setError(null);
    pendingCaretRef.current = null;
    sessionComposerStore.setDraft(tabId, event.target.value);
  }, [tabId]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (isImeComposingKey(native)) return;
    const textarea = event.currentTarget;
    const shortcut = resolveTerminalShortcut({
      event: buildTerminalShortcutKeyDescriptor(native),
      state: host.shortcutState,
      workspaceId: tab.workspaceId,
      sessionId: tab.sessionId,
      imeActive: false,
      hasSelection: false,
    });
    if (shortcut.kind === 'matched' && shortcut.action.type === 'toggle-composer') {
      event.preventDefault();
      runComposerShortcut(host, tabId, true);
      return;
    }
    if (event.key === 'Escape') {
      // FR-CMP-003 AC-5: only the focus moves; the PTY gets nothing.
      event.preventDefault();
      event.stopPropagation();
      host.focusTerminal(tabId);
      return;
    }
    const { value, selectionStart, selectionEnd } = textarea;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
      && selectionStart === selectionEnd) {
      const step = navigateComposerHistory({
        history: sessionComposerStore.getSession(tabId).history,
        draft: value,
        browse,
        direction: event.key === 'ArrowUp' ? 'prev' : 'next',
        caretOnFirstLine: isCaretOnFirstLine(value, selectionStart),
      });
      if (step.handled) {
        event.preventDefault();
        setBrowse(step.browse);
        setDraft(step.draft, historyCaret(step.draft));
      }
      return;
    }
    const decision = decideComposerEnter({ event: native, mobile: host.mobile, value, selectionStart, selectionEnd });
    if (decision === 'send') {
      event.preventDefault();
      send();
    } else if (decision === 'continue-line') {
      event.preventDefault();
      const next = applyContinueLine(value, selectionStart);
      setBrowse(NOT_BROWSING_HISTORY);
      setDraft(next.value, next.caret);
    }
  }, [host, tab.workspaceId, tab.sessionId, tabId, browse, send, setDraft]);

  // FR-CMP-002 AC-1 AC-3: dragging draws only a preview; the layout -- and with it the
  // terminal's fit and PTY resize -- changes once, when the drag ends.
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: maxHeight };
    setDragPreview(maxHeight);
  }, [maxHeight]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragPreview(clamp(drag.startHeight + (drag.startY - event.clientY)));
  }, [clamp]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const finalHeight = clamp(drag.startHeight + (drag.startY - event.clientY));
    setDragPreview(null);
    if (event.type === 'pointerup') sessionComposerStore.setHeight(finalHeight);
  }, [clamp]);

  const rootRect = dragPreview !== null ? rootRef.current?.getBoundingClientRect() : undefined;

  return (
    <div
      ref={rootRef}
      className="session-composer"
      data-session-composer={tabId}
      style={{ height: layoutHeight }}
      // The tile and the tab wrapper open the terminal menu on a right click or a long press;
      // inside the box those belong to the textarea.
      onContextMenu={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <div
        className="session-composer__handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('composer.resize')}
        title={t('composer.resize')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={() => sessionComposerStore.resetHeight()}
      />
      {error && <div className="session-composer__error" role="alert">{error}</div>}
      <div className="session-composer__body">
        <textarea
          ref={textareaRef}
          className="session-composer__input"
          value={session.draft}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={host.mobile ? t('composer.placeholderMobile') : t('composer.placeholder')}
          aria-label={t('composer.inputLabel')}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="session-composer__send"
          disabled={!canSend}
          aria-label={t('composer.send')}
          title={t('composer.send')}
          // Keeps the caret (and a phone's keyboard) in the textarea.
          onPointerDown={(event) => event.preventDefault()}
          onClick={send}
        >
          <Icon name="upload" size={16} />
        </button>
      </div>
      {dragPreview !== null && rootRect && createPortal(
        <div
          className="session-composer__drag-preview"
          style={{
            left: rootRect.left,
            width: rootRect.width,
            top: rootRect.bottom - dragPreview,
            height: dragPreview,
          }}
        />,
        document.body,
      )}
    </div>
  );
}

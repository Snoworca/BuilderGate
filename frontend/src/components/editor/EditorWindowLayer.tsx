// Mounts the workspace's editor window, decides whether it is on screen, and
// works out where it goes.
//
// The layer never unmounts the window. A window that fails the visibility
// predicate is told to hide and keeps its subtree, because each document's
// editor reads its body once at mount and owns it from then on -- unmounting is
// how unsaved work gets thrown away.
//
// Hiding is handed to the window rather than applied around it. WindowDialog
// puts its surface through createPortal into document.body, so the surface is
// not a DOM descendant of whatever this layer renders and a style set here
// would not reach it. The predicate's answer therefore travels as `hidden` and
// the surface applies it.
//
// Placement is computed here because its input is the measured stage, and that
// measurement comes from a context value only this layer reads.
//
// The layer must render inside TerminalRuntimeProvider: the host registry it
// exposes for debugging is that provider's context value. The consequence is
// that the window and its unsaved documents are destroyed on any commit where
// AppContent has no active workspace -- deleting the last one is the obvious
// way there, but so is a stored workspace id that names a workspace the
// reloaded list does not contain. That is left as a known constraint.
// @req FR-MDE-002
// @req FR-MDE-001
// @req FR-MDE-007

import { Fragment, useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useTerminalRuntimeContext } from '../Terminal/TerminalRuntimeContext';
import { ConfirmModal } from '../Modal/ConfirmModal';
import { MessageBox } from '../dialog/MessageBox';
import type { DialogRect } from '../dialog/types';
// The floor a window is not shrunk below, taken from the window that hands the
// same numbers to `Rnd`. One definition, so the size the layer places a window
// at and the size the window agrees to render at cannot drift.
import { EDITOR_WINDOW_MIN_SIZE } from './EditorWindow.tsx';
import { readEditorProbe, setEditorReadOnly } from './EditorDocumentPanel.tsx';
import type { EditorWindowPlacement } from './editorWindowPlacement.ts';
import { clampToStage, toStageRect } from './editorWindowRect.ts';
import {
  isEditorWindowVisible,
  type EditorWindowScreen,
} from './editorWindowVisibility.ts';
// The editor's only stylesheet entry point, which pulls in the inline-preview and
// KaTeX sheets behind it. Without it the maths renders twice over itself, because
// KaTeX folds its MathML copy away in CSS and nothing else does.
import '../../editor/styles/editor.css';

/**
 * The rect the window holds while the stage has no area to place it in.
 *
 * `EditorWindow` requires a rect, and the window is hidden throughout this
 * state, so the value never reaches the screen. It is exported rather than
 * written at the render site so that "waiting" has one spelling, and it is
 * deliberately not `{0,0,0,0}` -- a zero rect is the shape the placement rules
 * are forbidden to compare against, and one lying around invites exactly that.
 * @req FR-MDE-001
 */
export const EDITOR_WINDOW_WAITING_RECT: DialogRect = {
  x: 0,
  y: 0,
  width: EDITOR_WINDOW_MIN_SIZE.width,
  height: EDITOR_WINDOW_MIN_SIZE.height,
};

/** Resolves a terminal tab to the session it is running at the moment of the call. */
export type EditorWindowTabSessionLookup = (tabId: string) => string | undefined;

/**
 * What the layer reads off the window. The caller keeps whatever else it holds
 * on the same object and gets it back in `renderWindow`.
 * @req FR-MDE-002
 */
export interface EditorWindowLayerWindow {
  workspaceId: string;
  placement: EditorWindowPlacement;
  minimized: boolean;
  floatingRect: DialogRect | null;
}

declare global {
  interface Window {
    /**
     * A read-only view of runtime state the DOM does not carry. Installed by
     * the layer because the terminal host registry is a context value it
     * already holds, so nothing new has to be threaded anywhere to expose it.
     */
    __buildergateEditorWindowDebug?: {
      readTerminalHost(tabId: string): {
        isVisible: boolean;
        rect: { left: number; top: number; width: number; height: number };
      } | undefined;
      /** What the panel holding a path is passing to the editor. */
      readEditorProbe(filePath: string): {
        documentId: string;
        markdownSource: string;
        /** One number per `extensions` array object. Equal means identical. */
        extensionsToken: number;
      } | undefined;
      /** Drives the editor handle that panel holds. False if it reached none. */
      setEditorReadOnly(filePath: string, readOnly: boolean): boolean;
    };
  }
}

/**
 * What the window is told about itself when it renders.
 * @req FR-MDE-002
 */
export interface EditorWindowRenderContext {
  /** The predicate said no. The surface carries `display: none` and stays mounted. */
  hidden: boolean;
  resolveTabSession: EditorWindowTabSessionLookup;
  /**
   * Where the window goes, or null while the stage has no area to go into.
   * A window with no rect is not placed at a zero-size one -- it waits.
   */
  rect: DialogRect | null;
}

/**
 * `resolveTabSession` arrives as a prop rather than through a context on purpose:
 * `useWorkspaceManager` has a single caller and no provider, so a context would exist
 * only to carry this one function past a component that already holds it.
 *
 * `renderWindow` is the seam that keeps the editor's dependencies out of this layer.
 * The layer decides placement and visibility; what the window draws is the caller's.
 * @req FR-MDE-002
 */
export interface EditorWindowLayerProps<TWindow extends EditorWindowLayerWindow> {
  /**
   * One window per workspace that has an open document, not only the active
   * workspace's.
   *
   * Every one of them is mounted and all but one is hidden. A workspace switch
   * that unmounted the others would destroy the editors inside them, and with
   * those the bodies nobody has saved -- the same reason a hidden window is
   * hidden rather than dropped.
   */
  editorWindows: readonly TWindow[];
  screen: EditorWindowScreen;
  activeWorkspaceId: string | null;
  /**
   * Read only to re-measure the stage: switching terminal tabs can change the
   * area the window is confined to. It is deliberately not a visibility term --
   * the window holds documents from several terminals.
   */
  activeTabId: string | null;
  viewMode: 'tab' | 'grid';
  resolveTabSession: EditorWindowTabSessionLookup;
  renderWindow: (
    editorWindow: TWindow,
    context: EditorWindowRenderContext,
  ) => ReactNode;
  /** The file the user was asked about creating, or null when none. */
  createPrompt: { filePath: string } | null;
  onConfirmCreate: () => void;
  onCancelCreate: () => void;
  /** A read failure other than a missing file, or null when none. */
  openError: string | null;
  onDismissOpenError: () => void;
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/**
 * @req FR-MDE-002
 */
export function EditorWindowLayer<TWindow extends EditorWindowLayerWindow>({
  editorWindows,
  screen,
  activeWorkspaceId,
  activeTabId,
  viewMode,
  resolveTabSession,
  renderWindow,
  createPrompt,
  onConfirmCreate,
  onCancelCreate,
  openError,
  onDismissOpenError,
}: EditorWindowLayerProps<TWindow>) {
  const { hosts, rootRef, layoutVersion } = useTerminalRuntimeContext();
  const [overlayRect, setOverlayRect] = useState<DOMRect | null>(null);

  // The runtime overlay fills the stage, so measuring it answers the only
  // placement question left: how big the box the window is confined to is.
  const measureOverlay = useCallback(() => {
    const element = rootRef.current;
    if (element === null) return;
    const next = element.getBoundingClientRect();
    setOverlayRect((current) => {
      if (current !== null
        && current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.height === next.height) {
        return current;
      }
      return next;
    });
  }, [rootRef]);

  useLayoutEffect(() => {
    measureOverlay();
  }, [measureOverlay, layoutVersion, hosts, screen, viewMode, activeTabId]);

  useEffect(() => {
    window.addEventListener('resize', measureOverlay);
    return () => window.removeEventListener('resize', measureOverlay);
  }, [measureOverlay]);

  // A read-only view of runtime state the DOM does not carry.
  //
  // All three are installed here rather than each where its data lives, so the
  // object has one writer. Two components assigning into it would each have to
  // preserve what the other put there, and whichever mounted second while the
  // first was absent would publish an object missing half its methods.
  //
  // The terminal host entry is handed back as it is stored: an absent tab
  // answers `undefined` rather than a zero rect. The editor probe answers the
  // same way for a path no document is open on.
  // @req FR-MDE-001
  // @req FR-MDE-005
  useEffect(() => {
    const installed = {
      readTerminalHost: (tabId: string) => {
        const host = hosts.get(tabId);
        return host === undefined
          ? undefined
          : { isVisible: host.isVisible, rect: { ...host.rect } };
      },
      readEditorProbe,
      setEditorReadOnly,
    };

    window.__buildergateEditorWindowDebug = installed;

    // Taken down with the layer. `readTerminalHost` closes over `hosts`, and a
    // hook left installed after the layer unmounts would keep answering from
    // that dead snapshot -- handing back entries for a registry that no longer
    // exists, where the absent answer is `undefined` and load-bearing.
    return () => {
      if (window.__buildergateEditorWindowDebug === installed) {
        delete window.__buildergateEditorWindowDebug;
      }
    };
  }, [hosts]);

  const stageBounds = overlayRect === null ? null : toStageRect(overlayRect);

  return (
    <>
      {editorWindows.map((editorWindow) => {
        const rect = stageBounds === null
          ? null
          : (editorWindow.placement === 'stage'
            ? stageBounds
            : (editorWindow.floatingRect === null
              ? stageBounds
              : clampToStage(editorWindow.floatingRect, stageBounds)));

        const visible = isEditorWindowVisible({
          minimized: editorWindow.minimized,
          screen,
          activeWorkspaceId,
          windowWorkspaceId: editorWindow.workspaceId,
        });

        return (
          <Fragment key={editorWindow.workspaceId}>
            {renderWindow(editorWindow, {
              // A window with nowhere to go stays hidden even when the three
              // terms say otherwise: placing it at no rect would put a
              // zero-size window on screen.
              hidden: !visible || rect === null,
              resolveTabSession,
              rect,
            })}
          </Fragment>
        );
      })}

      {/* The two answers a read can give that are not a window. They render
          here rather than beside the window because neither belongs to one:
          the question is asked before any window exists, and the failure
          leaves none behind. */}
      {createPrompt !== null && (
        <ConfirmModal
          title="파일 만들기"
          message={`${fileNameOf(createPrompt.filePath)} 파일이 없습니다. 새로 만들까요?`}
          confirmLabel="만들기"
          cancelLabel="취소"
          onConfirm={onConfirmCreate}
          onCancel={onCancelCreate}
        />
      )}

      {openError !== null && (
        <MessageBox
          dialogId="editor-open-error"
          title="파일을 열지 못했습니다"
          message={openError}
          okLabel="확인"
          cancelLabel="닫기"
          onOk={onDismissOpenError}
          onCancel={onDismissOpenError}
        />
      )}
    </>
  );
}

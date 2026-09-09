// Mounts the open editor windows, decides which of them are on screen, and
// works out where each one goes.
//
// The layer never unmounts a window. A window that fails the visibility predicate is
// told to hide and keeps its subtree, because the editor reads its document once at
// mount and owns it from then on -- unmounting is how the unsaved body gets thrown
// away.
//
// Hiding is handed to the window rather than applied around it. WindowDialog puts its
// surface through createPortal into document.body, so the surface is not a DOM
// descendant of whatever this layer renders and a style set here would not reach it.
// The predicate's answer therefore travels as `hidden` and the surface applies it.
//
// Placement is computed here rather than per window because both inputs are
// collection-wide. The cascade has to see the rects its siblings already
// occupy, and those rects are themselves computed in this same pass; and the
// registry the docked rect comes from is a context value only this layer reads.
// A per-window computation would need the registry duplicated into every window
// and would have no way to see its siblings at all.
//
// The layer must render inside TerminalRuntimeProvider: the host registry term 5
// reads is that provider's context value. The consequence is that the windows and
// their unsaved bodies are destroyed on any commit where AppContent has no active
// workspace -- deleting the last one is the obvious way there, but so is a stored
// workspace id that names a workspace the reloaded list does not contain. That is
// left as a known constraint.
// @req FR-MDE-002
// @req FR-MDE-001
// @req FR-MDE-007

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTerminalRuntimeContext } from '../Terminal/TerminalRuntimeContext';
import { ConfirmModal } from '../Modal/ConfirmModal';
import { MessageBox } from '../dialog/MessageBox';
import type { DialogRect } from '../dialog/types';
// The floor a window is not shrunk below by the cascade, taken from the window
// that hands the same numbers to `Rnd`. One definition, so the size the layer
// places a window at and the size the window agrees to render at cannot drift.
import {
  EDITOR_WINDOW_MIN_SIZE,
  editorWindowDialogId,
  readEditorProbe,
  setEditorReadOnly,
} from './EditorWindow.tsx';
import type { EditorWindowRecord } from './editorWindowRecord.ts';
import { restoreEditorWindowStackOrder } from '../../hooks/windowStateStorage.ts';
import { computeCascadeRect, type CascadeWindow } from './editorWindowCascade.ts';
import type { EditorWindowPlacement } from './editorWindowPlacement.ts';
import { clampToStage, toDockedRect, toStageRect } from './editorWindowRect.ts';
import {
  hasUsableTerminalArea,
  isEditorWindowVisible,
  type EditorWindowScreen,
  type EditorWindowTerminalHost,
  type EditorWindowViewMode,
} from './editorWindowVisibility.ts';
// The editor's only stylesheet entry point, which pulls in the inline-preview and
// KaTeX sheets behind it. Without it the maths renders twice over itself, because
// KaTeX folds its MathML copy away in CSS and nothing else does.
//
// It is imported here rather than in EditorWindow because the styles are global:
// one editor stylesheet serves every window, and a per-window import would
// declare the same thing once per window. FR-MDE-005 AC-1 also requires every
// symbol EditorWindow imports from the editor tree to come through the barrel,
// and a stylesheet cannot be re-exported from one.
import '../../editor/styles/editor.css';

/**
 * The rect a window holds while its target has no area to be placed in.
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

/** Resolves a bound tab to the session it is running at the moment of the call. */
export type EditorWindowTabSessionLookup = (tabId: string) => string | undefined;

/**
 * What the layer needs of a window, derived from the persisted record so the shape of
 * a window is declared in one place. `workspaceId` is the one field the record does
 * not carry: it belongs to the bound tab, which the record names but does not copy.
 * @req FR-MDE-002
 */
export type EditorWindowLayerWindow =
  Pick<EditorWindowRecord, 'tabId' | 'filePath' | 'placement' | 'minimized' | 'floatingRect'>
  & { workspaceId: string };

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
      /** What the window open on a path is passing to the editor. */
      readEditorProbe(filePath: string): {
        documentId: string;
        markdownSource: string;
        /** One number per `extensions` array object. Equal means identical. */
        extensionsToken: number;
      } | undefined;
      /** Drives the editor handle that window holds. False if it reached none. */
      setEditorReadOnly(filePath: string, readOnly: boolean): boolean;
    };
  }
}

/**
 * What a window is told about itself when it renders.
 * @req FR-MDE-002
 */
export interface EditorWindowRenderContext {
  /** The predicate said no. The surface carries `display: none` and stays mounted. */
  hidden: boolean;
  resolveTabSession: EditorWindowTabSessionLookup;
  /**
   * The registry entry for the bound tab, or undefined when that tab has none.
   * Carried so a window can be told why it has no rect without reaching for the
   * registry itself.
   */
  host: EditorWindowTerminalHost | undefined;
  /**
   * Where the window goes, or null while its target has no area to go into.
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
 * The layer decides placement and visibility; what a window draws is the caller's.
 * @req FR-MDE-002
 */
export interface EditorWindowLayerProps<TWindow extends EditorWindowLayerWindow> {
  /** In creation order. The layer does not sort -- raising reorders paint, not DOM. */
  windows: readonly TWindow[];
  screen: EditorWindowScreen;
  activeWorkspaceId: string | null;
  activeTabId: string | null;
  viewMode: EditorWindowViewMode;
  resolveTabSession: EditorWindowTabSessionLookup;
  /**
   * The window comes back out with whatever else the caller keeps on it. The
   * layer reads only the fields above; widening its own type instead would
   * make it declare fields it has no rule about, and narrowing the caller's
   * would make the caller look its own windows up again by path to get them
   * back.
   */
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
  /**
   * A window's bound tab has gone, and this is the rectangle it was occupying.
   *
   * Reported rather than applied here: the placement is a fact about the window
   * that `App` also reads, so it belongs in the record. What only this layer
   * knows is the rect, because a docked one is computed from a registry entry
   * that goes when the tab does.
   * @req CON-MDE-002
   */
  onOrphan: (filePath: string, rect: DialogRect) => void;
  /**
   * Windows a restore has just created, waiting to be put back into their
   * stored front-to-back order, or null when none is waiting.
   *
   * The raise happens here rather than where the windows were created because
   * it can only happen after they have mounted: a window registers itself with
   * the modeless stack from its own layout effect, and one that has not
   * registered yet cannot be raised. A child's layout effect runs before this
   * component's effects, so by the time this fires they are all in the stack.
   * @req FR-MDE-009
   */
  pendingStackRestore: readonly EditorWindowRecord[] | null;
  /** Reported back once they have been raised, so the batch is not repeated. */
  onStackRestored: () => void;
}

function fileNameOf(filePath: string): string {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1] || filePath;
}

/**
 * Keyed by the resolved absolute path, which is what identifies a window here: two
 * tabs can share a `cwd`, and save conflicts are deliberately not detected, so two
 * windows onto one file would overwrite each other silently. Keying by the bound tab
 * would instead collide the several windows one tab legitimately has open.
 * @req FR-MDE-002
 */
export function EditorWindowLayer<TWindow extends EditorWindowLayerWindow>({
  windows,
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
  onOrphan,
  pendingStackRestore,
  onStackRestored,
}: EditorWindowLayerProps<TWindow>) {
  const { hosts, rootRef, layoutVersion } = useTerminalRuntimeContext();
  const [overlayRect, setOverlayRect] = useState<DOMRect | null>(null);

  // The restored windows take their stored order in the stack. This runs after
  // they have mounted and registered themselves, which is what makes the raise
  // find them; the batch is reported back so it is not applied a second time.
  // @req FR-MDE-009
  useEffect(() => {
    if (pendingStackRestore === null) return;

    restoreEditorWindowStackOrder(pendingStackRestore, editorWindowDialogId);
    onStackRestored();
  }, [onStackRestored, pendingStackRestore]);

  // The runtime overlay is what the registry measures against, and it fills the
  // stage, so one measurement answers both questions: where the registry's
  // origin is, and how big the stage a floating window is confined to is.
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
  // answers `undefined` rather than a zero rect, which is the distinction the
  // deferral rule turns on. The editor probe answers the same way for a path no
  // window is open on.
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

  // Where each window was last drawn, so a window whose tab closes can inherit
  // the place it was already sitting in. A docked rect is computed from the
  // registry entry for its tab, and that entry goes when the tab does -- this
  // map is the only thing left that remembers where the window was.
  // @req CON-MDE-002
  const lastRectRef = useRef(new Map<string, DialogRect>());

  // The windows already reported as orphaned.
  //
  // The report has to be once per window, not once per commit while its tab is
  // gone. `tabClosed` stays true forever, so a guard that only asked whether
  // the window is floating would fire again the moment it left that state --
  // and 최대화 and 터미널 채움 are the two controls whose whole job is to leave
  // it. Both would appear to do nothing: the window would be pushed straight
  // back to floating at the rect it already had.
  // @req CON-MDE-002
  const reportedOrphansRef = useRef(new Set<string>());

  // One pass over the collection, in creation order. Each docked window is
  // cascaded against the rects already settled in this same pass, so the step
  // it takes is the lowest one no sibling over that terminal occupies.
  const placed: {
    editorWindow: TWindow;
    rect: DialogRect | null;
    placement: EditorWindowPlacement;
    tabClosed: boolean;
  }[] = [];
  const cascadeSoFar: CascadeWindow[] = [];

  for (const editorWindow of windows) {
    const host = hosts.get(editorWindow.tabId);
    const stageBounds = overlayRect === null ? null : toStageRect(overlayRect);
    const tabClosed = resolveTabSession(editorWindow.tabId) === undefined;
    const placement = editorWindow.placement;
    let rect: DialogRect | null = null;

    if (placement === 'docked') {
      if (overlayRect !== null && host !== undefined && hasUsableTerminalArea(host)) {
        rect = computeCascadeRect({
          tabId: editorWindow.tabId,
          target: toDockedRect(host.rect, { left: overlayRect.left, top: overlayRect.top }),
          alreadyDocked: cascadeSoFar,
          minSize: EDITOR_WINDOW_MIN_SIZE,
        });
      }
    } else if (placement === 'stage') {
      rect = stageBounds;
    } else {
      rect = stageBounds !== null && editorWindow.floatingRect !== null
        ? clampToStage(editorWindow.floatingRect, stageBounds)
        : stageBounds;
    }

    placed.push({ editorWindow, rect, placement, tabClosed });
    cascadeSoFar.push({
      tabId: editorWindow.tabId,
      placement,
      minimized: editorWindow.minimized,
      rect,
    });
  }

  // A window whose tab has gone is handed the rect it was last drawn at, once.
  // The record then moves it to `floating` carrying that rect, and from there
  // it is an ordinary floating window: 최대화 and 터미널 채움 move it as they move
  // any other, because this reports the orphaning rather than enforcing it.
  //
  // After the commit, not during the pass: this changes the state the pass
  // reads. `lastRectRef` still holds what the previous render drew, which is
  // the rectangle the window occupied immediately before the close -- this
  // pass has already computed `null` for it, the registry entry being gone.
  // @req CON-MDE-002
  useLayoutEffect(() => {
    const reported = reportedOrphansRef.current;

    for (const { editorWindow, tabClosed } of placed) {
      if (!tabClosed || reported.has(editorWindow.filePath)) {
        continue;
      }

      // The stage stands in for a window that was never drawn -- opened while
      // its tab was already going, so there is no rectangle it occupied. That
      // is a placement rather than an inheritance, and it is the only way such
      // a window reaches the screen at all: left docked it has no registry
      // entry to be placed against, and it would stay hidden holding a body
      // nobody can save. It is not recorded as reported, so the next commit --
      // which has a measurement -- can still place it.
      const occupied = lastRectRef.current.get(editorWindow.filePath)
        ?? (overlayRect === null ? null : toStageRect(overlayRect));
      if (occupied === null) {
        continue;
      }

      reported.add(editorWindow.filePath);
      onOrphan(editorWindow.filePath, occupied);
    }
  });

  // Written after the commit rather than during the pass, so the map holds what
  // the previous render drew while this one is deciding. Entries for windows
  // that have closed are dropped in the same sweep.
  // @req CON-MDE-002
  useLayoutEffect(() => {
    const remembered = lastRectRef.current;
    const open = new Set(placed.map(entry => entry.editorWindow.filePath));

    for (const filePath of Array.from(remembered.keys())) {
      if (!open.has(filePath)) {
        remembered.delete(filePath);
      }
    }
    for (const filePath of Array.from(reportedOrphansRef.current)) {
      if (!open.has(filePath)) {
        reportedOrphansRef.current.delete(filePath);
      }
    }

    for (const { editorWindow, rect } of placed) {
      if (rect !== null) {
        remembered.set(editorWindow.filePath, rect);
      }
    }
  });

  return (
    <>
      {placed.map(({ editorWindow, rect, placement, tabClosed }) => {
        const host = hosts.get(editorWindow.tabId);
        const visible = isEditorWindowVisible({
          minimized: editorWindow.minimized,
          screen,
          activeWorkspaceId,
          windowWorkspaceId: editorWindow.workspaceId,
          viewMode,
          activeTabId,
          windowTabId: editorWindow.tabId,
          placement,
          host,
          tabClosed,
        });

        return (
          <Fragment key={editorWindow.filePath}>
            {renderWindow(editorWindow, {
              // A window with nowhere to go stays hidden even when the five
              // terms say otherwise: placing it at no rect would put a
              // zero-size window on screen.
              hidden: !visible || rect === null,
              resolveTabSession,
              host,
              rect,
            })}
          </Fragment>
        );
      })}

      {/* The two answers a read can give that are not a window. They render
          here rather than beside the layer because they belong to the flow that
          opens a window, and this is that flow's own subtree. */}
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

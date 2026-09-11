import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Rnd } from 'react-rnd';
import {
  clampDialogRect,
  readDialogGeometry,
  writeDialogGeometry,
} from './dialogGeometry';
import { useDialogStack } from './dialogStack';
import { createWindowDialogBehaviorModel, windowDialogTitleText } from './windowDialogModel';
import type { DialogRect, DialogSize, WindowDialogProps } from './types';
import './WindowDialog.css';

function getViewportSize(): DialogSize {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * What a window host adds on top of the shared dialog contract. All five are
 * optional and omitting every one of them leaves the dialog behaving exactly
 * as it did before they existed, which is what keeps the six modal call sites
 * untouched.
 * @req FR-MDE-001
 */
export interface WindowDialogHostProps extends WindowDialogProps {
  /**
   * Controlled coordinates. When supplied they are handed to Rnd verbatim:
   * the host clamps against the stage rather than the viewport, so
   * clampDialogRect is skipped for the whole interaction.
   */
  rect?: DialogRect;
  onRectChange?: (rect: DialogRect) => void;
  /**
   * The window can be moved by its title bar. Defaults to true.
   *
   * Turned off for a window that fills the screen it is in: there is nowhere to
   * move it to, and a drag would still emit a rect, which a host that caches
   * rects would then store.
   */
  movable?: boolean;
  /** Drag boundary for Rnd. Defaults to the viewport, as before. */
  boundsElement?: string | Element;
  /** Rendered in the title bar, to the left of the close button. */
  titlebarActions?: ReactNode;
  /** Marks the surface as holding unsaved content. */
  dirty?: boolean;
}

export function WindowDialog({
  dialogId,
  title,
  mode,
  defaultRect,
  minSize,
  onClose,
  children,
  role,
  ariaDescribedBy,
  showCloseButton,
  resizable,
  persistGeometry,
  surfaceClassName,
  keyboardCapture,
  rect: controlledRect,
  onRectChange,
  movable = true,
  boundsElement,
  titlebarActions,
  dirty,
}: WindowDialogHostProps) {
  const [uncontrolledRect, setUncontrolledRect] = useState<DialogRect>(() =>
    readDialogGeometry(dialogId, defaultRect, getViewportSize(), minSize),
  );
  // readDialogGeometry above runs on every mount whatever persistGeometry
  // says, so a stored rect would reach the screen unless the host supplies a
  // controlled one from the first render. That is why the controlled value
  // wins here rather than being merged in later.
  const isControlled = controlledRect !== undefined;
  const rect = controlledRect ?? uncontrolledRect;
  const stackState = useDialogStack(dialogId, mode);
  const raiseSelf = stackState.raise;
  const behavior = createWindowDialogBehaviorModel({
    role,
    showCloseButton,
    resizable,
    persistGeometry,
    layerIndex: stackState.layerIndex,
    mode,
  });
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const rectRef = useRef(rect);

  const commitRect = useCallback((nextRect: DialogRect) => {
    rectRef.current = nextRect;
    onRectChange?.(nextRect);
    if (!isControlled) {
      setUncontrolledRect(nextRect);
    }
  }, [isControlled, onRectChange]);

  // The single place the clamp is chosen. A controlled rect is already bounded
  // by whatever the host measured, and clamping it again against the viewport
  // would undo that.
  const applyRect = useCallback((nextRect: DialogRect) => {
    commitRect(isControlled ? nextRect : clampDialogRect(nextRect, getViewportSize(), minSize));
  }, [commitRect, isControlled, minSize]);

  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  // A press anywhere inside this window brings it forward.
  //
  // The listener is on the layer and runs in the capture phase, so a press deep
  // inside whatever the window contains is seen on the way down rather than
  // after the content has had it. It is a native listener rather than a React
  // handler because React's synthetic layer is the thing that would give a
  // descendant somewhere to swallow the press before this ran.
  //
  // The body is one call. Raising is an observation of the press, not a
  // substitute for it, so neither stopPropagation nor preventDefault is reached
  // for: the drag handle, the title bar buttons, the resize handles and the
  // content all still get the event they would have had. Raising reorders the
  // stack array and repaints; it re-inserts no DOM node, which is what keeps a
  // text selection drag started by the same press alive.
  //
  // The layer is where the listener goes rather than the surface because
  // react-rnd's positioned root sits between them and carries the resize
  // handles, and a press on one of those is a press on this window too.
  //
  // Modal dialogs listen for nothing. `useDialogStack` already refuses to raise
  // one, so this decides only whether a listener exists at all -- it is not
  // where the rule lives, and deleting it would cost a listener rather than the
  // modal's focus trap.
  // @req FR-MDE-003
  useEffect(() => {
    if (mode !== 'modeless') return undefined;

    const layer = layerRef.current;
    if (layer === null) return undefined;

    const handlePointerDown = () => raiseSelf();
    layer.addEventListener('pointerdown', handlePointerDown, true);
    return () => layer.removeEventListener('pointerdown', handlePointerDown, true);
  }, [mode, raiseSelf]);

  useEffect(() => {
    if (mode !== 'modal') return;

    const layer = layerRef.current;
    if (!layer) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const siblings = Array.from(document.body.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child !== layer);
    const siblingState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));

    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });

    return () => {
      siblingState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', ariaHidden);
        }
      });
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'modal' || !stackState.isTopmost) return;

    const focusFirstDialogElement = () => {
      const surface = surfaceRef.current;
      if (!surface || surface.contains(document.activeElement)) {
        return;
      }

      const firstFocusable = getFocusableElements(surface)[0];
      (firstFocusable ?? closeButtonRef.current ?? surface).focus();
    };

    const animationFrame = requestAnimationFrame(focusFirstDialogElement);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (keyboardCapture?.active && keyboardCapture.onKeyDown(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(surfaceRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        surfaceRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!surfaceRef.current?.contains(event.target as Node)) {
        focusFirstDialogElement();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);

    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, [keyboardCapture, mode, stackState.isTopmost]);

  useEffect(() => {
    // A controlled host recomputes its own rect on resize, so re-emitting the
    // current one here would only fight it.
    if (isControlled) return;

    const handleResize = () => {
      applyRect(rectRef.current);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [applyRect, isControlled]);

  const handleDragStop = useCallback((_event: unknown, data: { x: number; y: number }) => {
    applyRect({
      ...rectRef.current,
      x: data.x,
      y: data.y,
    });
  }, [applyRect]);

  const handleResizeStop = useCallback((
    _event: unknown,
    _direction: unknown,
    ref: HTMLElement,
    _delta: unknown,
    position: { x: number; y: number },
  ) => {
    applyRect({
      x: position.x,
      y: position.y,
      width: ref.offsetWidth,
      height: ref.offsetHeight,
    });
  }, [applyRect]);

  const handleClose = useCallback(() => {
    if (behavior.persistGeometry) {
      writeDialogGeometry(dialogId, clampDialogRect(rectRef.current, getViewportSize(), minSize));
    }
    onClose();
  }, [behavior.persistGeometry, dialogId, minSize, onClose]);

  // What Rnd is allowed to render the box at, which is not always `minSize`.
  //
  // A docked window is placed inside one terminal's area, and that area can be
  // narrower than the editor's own minimum -- three tiles across a narrow stage
  // is enough. Holding the minimum there would render a box wider than the rect
  // the host computed, and the surplus lands on the terminal of the tile beside
  // it: a window that is too small is an inconvenience, a window over someone
  // else's terminal is a defect. Staying inside the target therefore outranks
  // the minimum, and the rect already on screen is what says so.
  //
  // Where the rect is at or above the minimum -- every modal, and every window
  // whose target has room -- this is `minSize` unchanged.
  // @req FR-MDE-004
  const viewportSize = getViewportSize();
  const renderedMinSize: DialogSize = {
    width: lowerFloorTo(minSize.width, rect.width, viewportSize.width),
    height: lowerFloorTo(minSize.height, rect.height, viewportSize.height),
  };

  return createPortal(
    <div
      ref={layerRef}
      className={`window-dialog-layer window-dialog-layer-${mode}`}
      role="presentation"
      style={{ zIndex: behavior.layerZ }}
    >
      {mode === 'modal' && (
        <div
          className="window-dialog-backdrop"
          aria-hidden="true"
          style={{ zIndex: behavior.backdropZ }}
        />
      )}
      <Rnd
        className="window-dialog"
        style={{ zIndex: behavior.dialogZ }}
        bounds={boundsElement ?? 'window'}
        disableDragging={!movable}
        dragHandleClassName="window-dialog-titlebar"
        size={{ width: rect.width, height: rect.height }}
        position={{ x: rect.x, y: rect.y }}
        minWidth={renderedMinSize.width}
        minHeight={renderedMinSize.height}
        enableResizing={behavior.resizable
          ? {
            top: true,
            right: true,
            bottom: true,
            left: true,
            topRight: true,
            bottomRight: true,
            bottomLeft: true,
            topLeft: true,
          }
          : false}
        onDragStop={handleDragStop}
        onResizeStop={handleResizeStop}
      >
        <section
          ref={surfaceRef}
          className={['window-dialog-surface', surfaceClassName].filter(Boolean).join(' ')}
          role={behavior.role}
          aria-modal={mode === 'modal'}
          aria-labelledby={`${dialogId}-title`}
          aria-describedby={ariaDescribedBy}
          data-dirty={dirty ? 'true' : undefined}
          tabIndex={-1}
        >
          <div className="window-dialog-titlebar">
            <h2 id={`${dialogId}-title`} className="window-dialog-title">
              {windowDialogTitleText(title, dirty)}
            </h2>
            {titlebarActions}
            {behavior.showCloseButton && (
              <button
                ref={closeButtonRef}
                type="button"
                className="window-dialog-close"
                aria-label="Close"
                onClick={handleClose}
              >
                x
              </button>
            )}
          </div>
          <div className="window-dialog-body">
            {children}
          </div>
        </section>
      </Rnd>
    </div>,
    document.body,
  );
}

/**
 * The smallest size Rnd may render this box at.
 *
 * The rect lowers the floor but never removes it. `rendered` is the rect the
 * host computed, and a window docked to a terminal narrower than the editor's
 * own minimum has to stay inside that terminal -- a window inflated past its
 * tile covers the terminal of the tile beside it, and being too small is an
 * inconvenience while being over someone else's terminal is a defect.
 *
 * A rect of zero is not a size, though: it is what a window holds while its
 * target has not been measured yet. Taking it literally would hand Rnd a
 * minimum of zero, and since the same rect is also the rendered size, the box
 * would paint with no title bar left to grab it by. So a zero leaves the floor
 * where it was.
 * @req FR-MDE-004
 */
function lowerFloorTo(minimum: number, rendered: number, viewport: number): number {
  const floor = rendered > 0 ? Math.min(minimum, rendered) : minimum;

  return Math.min(floor, viewport);
}

function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];

  const selector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  return Array.from(container.querySelectorAll<HTMLElement>(selector))
    .filter(element => !element.hasAttribute('disabled') && element.offsetParent !== null);
}

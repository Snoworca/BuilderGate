import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Rnd } from 'react-rnd';
import {
  clampDialogRect,
  readDialogGeometry,
  writeDialogGeometry,
} from './dialogGeometry';
import { useDialogStack } from './dialogStack';
import { createWindowDialogBehaviorModel } from './windowDialogModel';
import type { DialogRect, DialogSize, WindowDialogProps } from './types';
import './WindowDialog.css';

function getViewportSize(): DialogSize {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
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
}: WindowDialogProps) {
  const [rect, setRect] = useState<DialogRect>(() =>
    readDialogGeometry(dialogId, defaultRect, getViewportSize(), minSize),
  );
  const stackState = useDialogStack(dialogId, mode === 'modal');
  const behavior = createWindowDialogBehaviorModel({
    role,
    showCloseButton,
    resizable,
    persistGeometry,
    layerIndex: stackState.layerIndex,
  });
  const layerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const rectRef = useRef(rect);

  const commitRect = useCallback((nextRect: DialogRect) => {
    rectRef.current = nextRect;
    setRect(nextRect);
  }, []);

  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

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
  }, [mode, stackState.isTopmost]);

  useEffect(() => {
    const handleResize = () => {
      commitRect(clampDialogRect(rectRef.current, getViewportSize(), minSize));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [commitRect, minSize]);

  const handleDragStop = useCallback((_event: unknown, data: { x: number; y: number }) => {
    commitRect(clampDialogRect({
      ...rectRef.current,
      x: data.x,
      y: data.y,
    }, getViewportSize(), minSize));
  }, [commitRect, minSize]);

  const handleResizeStop = useCallback((
    _event: unknown,
    _direction: unknown,
    ref: HTMLElement,
    _delta: unknown,
    position: { x: number; y: number },
  ) => {
    commitRect(clampDialogRect({
      x: position.x,
      y: position.y,
      width: ref.offsetWidth,
      height: ref.offsetHeight,
    }, getViewportSize(), minSize));
  }, [commitRect, minSize]);

  const handleClose = useCallback(() => {
    if (behavior.persistGeometry) {
      writeDialogGeometry(dialogId, clampDialogRect(rectRef.current, getViewportSize(), minSize));
    }
    onClose();
  }, [behavior.persistGeometry, dialogId, minSize, onClose]);

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
        bounds="window"
        dragHandleClassName="window-dialog-titlebar"
        size={{ width: rect.width, height: rect.height }}
        position={{ x: rect.x, y: rect.y }}
        minWidth={Math.min(minSize.width, getViewportSize().width)}
        minHeight={Math.min(minSize.height, getViewportSize().height)}
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
          tabIndex={-1}
        >
          <div className="window-dialog-titlebar">
            <h2 id={`${dialogId}-title`} className="window-dialog-title">
              {title}
            </h2>
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

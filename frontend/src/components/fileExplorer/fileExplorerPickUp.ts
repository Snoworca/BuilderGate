// Picking explorer entries up by holding them (FR-FEX-032): the held row leaves the list, a card
// follows the pointer, and the release drops on what is under it. A browser drag cannot do this
// (its picture is fixed at the start and touch has none), so the pick runs on pointer events.
//
// The driver does not decide drops. It tells the element under the pointer with PICK_EVENT.over /
// .leave / .drop, and the explorer panels and tabs answer with the same rules an FR-FEX-030 drag
// uses. That keeps one drop path and lets a pick reach a folder in another explorer tab.
// @req FR-FEX-032

/** AC-1: how long a row is held before it is picked up. */
export const PICK_HOLD_MS = 450;
/** AC-1, AC-5: movement within this is still "in place". */
export const PICK_SLOP_PX = 10;
/** AC-4: the band at the top and bottom of the list that scrolls it. */
export const PICK_EDGE_PX = 36;
const PICK_SCROLL_MAX_PX = 16;

export const PICK_EVENT = {
  over: 'fx-pick-over',
  leave: 'fx-pick-leave',
  drop: 'fx-pick-drop',
} as const;

export interface PickKeys {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface PickOverDetail {
  keys: PickKeys;
}

/** `next` is the element the pointer moved to, or null when the pick ended. */
export interface PickLeaveDetail {
  next: Element | null;
}

/** A target that took the drop sets `handled`. */
export interface PickDropDetail {
  keys: PickKeys;
  handled: boolean;
}

export type PickRelease = 'drop' | 'menu' | 'cancel';

/** AC-3, AC-5: what a release means. */
export function decidePickRelease(input: { touch: boolean; moved: boolean }): PickRelease {
  if (input.moved) return 'drop';
  return input.touch ? 'menu' : 'cancel';
}

/** AC-4: pixels to scroll the list per frame for a pointer at `y`; faster nearer the edge. */
export function autoScrollDelta(y: number, rect: { top: number; bottom: number }, edge = PICK_EDGE_PX): number {
  if (y < rect.top || y > rect.bottom) return 0;
  const step = (depth: number) => Math.ceil(PICK_SCROLL_MAX_PX * (1 - depth / edge));
  if (y < rect.top + edge) return -step(y - rect.top);
  if (y > rect.bottom - edge) return step(rect.bottom - y);
  return 0;
}

/**
 * A rule giving `declarations` to the rows of `paths` and everything shown inside them, within
 * `scope` (one panel's list) so another explorer showing the same path is left alone.
 */
export function rowsCss(paths: readonly string[], escape: (value: string) => string, scope: string, declarations: string): string {
  const selectors = paths.flatMap((path) => [
    `${scope} [data-path="${escape(path)}"]`,
    `${scope} [data-path^="${escape(`${path}/`)}"]`,
    `${scope} [data-path^="${escape(`${path}\\`)}"]`,
  ]);
  return selectors.length === 0 ? '' : `${selectors.join(', ')} { ${declarations} }`;
}

/** AC-1: the carried rows, and everything inside a carried folder, leave the list. */
export function hiddenRowsCss(paths: readonly string[], escape: (value: string) => string, scope: string): string {
  return rowsCss(paths, escape, scope, 'display: none;');
}

export interface PickSession {
  /** Ends the pick as a cancel; nothing happens when it already ended. */
  stop: () => void;
}

export interface StartPickOptions {
  doc: Document;
  win: Window;
  /** Where the pick began; a release within PICK_SLOP_PX of it is in place. */
  start: { x: number; y: number };
  /**
   * The element a finger went down on, for a touch pick; none for a mouse. A touch's events go to
   * that element even after it leaves the DOM (a folder opened under the finger), so they are
   * heard there rather than on the document.
   */
  touchTarget?: Element;
  /** The card's text: the name, or how many go. */
  label: string;
  hitTest?: (x: number, y: number) => Element | null;
  /** Called once with the outcome, after the targets were told; `drop` only when one took it. */
  onRelease: (kind: PickRelease, point: { x: number; y: number }) => void;
  /** Called once when the pick is over, before onRelease. */
  onEnd: () => void;
}

const NO_KEYS: PickKeys = { ctrlKey: false, altKey: false, metaKey: false };

function keysOf(event: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): PickKeys {
  return { ctrlKey: event.ctrlKey === true, altKey: event.altKey === true, metaKey: event.metaKey === true };
}

export function startPick(options: StartPickOptions): PickSession {
  const { doc, win, start, touchTarget } = options;
  const touch = touchTarget !== undefined;
  const hitTest = options.hitTest ?? ((x: number, y: number) => doc.elementFromPoint(x, y));
  const CustomEventCtor = (win as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent;

  const ghost = doc.createElement('div');
  ghost.className = 'fx-pick-ghost';
  ghost.textContent = options.label;
  doc.body.appendChild(ghost);
  // The top layer keeps the card above every window without a z-index of its own.
  ghost.setAttribute('popover', 'manual');
  (ghost as HTMLElement & { showPopover?: () => void }).showPopover?.();

  let point = { ...start };
  let keys = NO_KEYS;
  let moved = false;
  let target: Element | null = null;
  let frame: number | null = null;
  let ended = false;

  const place = () => {
    // Above and left of a finger so it stays visible; beside a mouse cursor.
    const x = touch ? point.x - 24 : point.x + 14;
    const y = touch ? point.y - 56 : point.y + 14;
    ghost.style.transform = `translate(${x}px, ${y}px)`;
  };
  place();

  const fire = <T>(el: Element, type: string, detail: T): T => {
    el.dispatchEvent(new CustomEventCtor<T>(type, { bubbles: true, detail }));
    return detail;
  };

  const retarget = () => {
    const next = hitTest(point.x, point.y);
    if (next !== target && target !== null) fire<PickLeaveDetail>(target, PICK_EVENT.leave, { next });
    target = next;
    if (target !== null) fire<PickOverDetail>(target, PICK_EVENT.over, { keys });
  };

  const scrollStep = () => {
    frame = null;
    if (ended) return;
    const list = target?.closest('.fx-scroll') ?? null;
    if (list !== null) {
      const delta = autoScrollDelta(point.y, list.getBoundingClientRect());
      if (delta !== 0) {
        list.scrollTop += delta;
        retarget();
      }
    }
    frame = win.requestAnimationFrame(scrollStep);
  };

  const move = (next: { x: number; y: number }, nextKeys: PickKeys) => {
    point = next;
    keys = nextKeys;
    if (Math.hypot(point.x - start.x, point.y - start.y) > PICK_SLOP_PX) moved = true;
    place();
    retarget();
  };
  const release = (next: { x: number; y: number }, nextKeys: PickKeys) => {
    point = next;
    keys = nextKeys;
    if (Math.hypot(point.x - start.x, point.y - start.y) > PICK_SLOP_PX) moved = true;
    let kind = decidePickRelease({ touch, moved });
    if (kind === 'drop') {
      const under = hitTest(point.x, point.y);
      const taken = under !== null && fire<PickDropDetail>(under, PICK_EVENT.drop, { keys, handled: false }).handled;
      if (!taken) kind = 'cancel';
    }
    finish(kind);
  };
  // A mouse pick follows pointer events; a touch pick follows the touch, which is what a phone
  // reports reliably once the page is told not to scroll.
  const onPointerMove = (event: PointerEvent) => {
    // The button came up where this window could not see it (another window, a frame).
    if (event.buttons === 0) {
      finish('cancel');
      return;
    }
    move({ x: event.clientX, y: event.clientY }, keysOf(event));
  };
  const onPointerUp = (event: PointerEvent) => release({ x: event.clientX, y: event.clientY }, keysOf(event));
  const touchPoint = (event: TouchEvent) => {
    const touch = event.changedTouches?.[0] ?? event.touches?.[0];
    return touch === undefined ? point : { x: touch.clientX, y: touch.clientY };
  };
  // AC-4: the finger carries the card, not the page.
  const onTouchMove = (event: TouchEvent) => {
    event.preventDefault();
    move(touchPoint(event), keys);
  };
  const onTouchEnd = (event: TouchEvent) => release(touchPoint(event), keys);
  const onCancel = () => finish('cancel');
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish('cancel');
      return;
    }
    const next = keysOf(event);
    if (next.ctrlKey === keys.ctrlKey && next.altKey === keys.altKey && next.metaKey === keys.metaKey) return;
    keys = next;
    if (target !== null) fire<PickOverDetail>(target, PICK_EVENT.over, { keys });
  };
  // A long press raises the browser's own contextmenu on Android; the views would open theirs.
  const holdMenu = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const listen = (add: boolean) => {
    const method = add ? 'addEventListener' : 'removeEventListener';
    if (touchTarget !== undefined) {
      touchTarget[method]('touchmove', onTouchMove as EventListener, add ? { passive: false } : undefined);
      touchTarget[method]('touchend', onTouchEnd as EventListener);
      touchTarget[method]('touchcancel', onCancel);
    } else {
      win[method]('pointermove', onPointerMove as EventListener, true);
      win[method]('pointerup', onPointerUp as EventListener, true);
      win[method]('pointercancel', onCancel, true);
      win[method]('blur', onCancel);
    }
    win[method]('keydown', onKey as EventListener, true);
    win[method]('keyup', onKey as EventListener, true);
    win[method]('contextmenu', holdMenu, true);
  };

  // The release raises a click on what is under it; it must not select or open that.
  const swallowClick = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  function finish(kind: PickRelease) {
    if (ended) return;
    ended = true;
    listen(false);
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    if (target !== null) fire<PickLeaveDetail>(target, PICK_EVENT.leave, { next: null });
    target = null;
    ghost.remove();
    win.addEventListener('click', swallowClick, true);
    win.setTimeout(() => win.removeEventListener('click', swallowClick, true), 0);
    options.onEnd();
    options.onRelease(kind, point);
  }

  listen(true);
  frame = win.requestAnimationFrame(scrollStep);
  return { stop: () => finish('cancel') };
}

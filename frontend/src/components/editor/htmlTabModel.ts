// One HTML tab (FR-MDE-028): which files it takes, the frame's sandbox, what the frame shows for
// a saved or an edited document, when it reloads, and the resource summary. Pure, so each rule
// is reachable without a browser; HtmlFileTab.tsx only draws what this returns.
// @req FR-MDE-028
// @req SEC-MDE-002

import { t } from '../../i18n/i18n.ts';

export type HtmlView = 'rendered' | 'source';

/** FR-MDE-028 AC-1: the files the HTML tab opens. */
export function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

/**
 * FR-MDE-028 AC-4: scripts, forms, dialogs and popups run; allow-same-origin is never given, so
 * the page has an opaque origin and cannot reach the app's storage, cookies or API.
 */
export const HTML_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

/** FR-MDE-028 AC-10: the width a narrow view lays the page out at before scaling it down. */
export const HTML_FIT_WIDTH = 1280;

/** 'fit': below HTML_FIT_WIDTH, lay out at that width and scale down. 'actual': the view's width. */
export type HtmlFrameScale = 'fit' | 'actual';

export interface HtmlFrameLayout {
  width: number;
  height: number;
  scale: number;
}

/** FR-MDE-028 AC-10: the toggle is offered only while the view is narrower than the fit width. */
export function canFitHtmlFrame(areaWidth: number): boolean {
  return areaWidth > 0 && areaWidth < HTML_FIT_WIDTH;
}

/**
 * FR-MDE-028 AC-10: the frame's own size and its scale when the page is fitted, so a desktop design
 * looks as it does on a PC; scaled back down the frame is exactly the view's size. Null means the
 * frame fills the view at its real width.
 */
export function htmlFrameLayout(area: { width: number; height: number }, mode: HtmlFrameScale): HtmlFrameLayout | null {
  if (mode !== 'fit' || !canFitHtmlFrame(area.width)) return null;
  const scale = area.width / HTML_FIT_WIDTH;
  return { width: HTML_FIT_WIDTH, height: area.height / scale, scale };
}

/**
 * FR-MDE-028 AC-11: the fitted page's own zoom on a touch screen. The page's touches never reach
 * the app (opaque-origin frame), so a surface over the frame turns pinches and drags into this
 * view: `zoom` multiplies the fit scale, and x/y move the frame, in view pixels.
 */
export interface HtmlFrameView {
  zoom: number;
  x: number;
  y: number;
}

export interface HtmlFramePoint {
  x: number;
  y: number;
}

type FrameArea = { width: number; height: number };

export const HTML_FRAME_VIEW_RESET: HtmlFrameView = { zoom: 1, x: 0, y: 0 };

/** FR-MDE-028 AC-11: the closest the page zooms in, as a multiple of its real size. */
export const HTML_ZOOM_MAX_SCALE = 2;

export function maxHtmlFrameZoom(baseScale: number): number {
  return Math.max(1, HTML_ZOOM_MAX_SCALE / baseScale);
}

function clampView(zoom: number, x: number, y: number, area: FrameArea, baseScale: number): HtmlFrameView {
  const z = Math.min(Math.max(zoom, 1), maxHtmlFrameZoom(baseScale));
  // The zoomed page is area * z; its edges never come inside the view.
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size * (1 - z), value));
  return { zoom: z, x: clamp(x, area.width), y: clamp(y, area.height) };
}

/** FR-MDE-028 AC-11: the page point under the fingers when the pinch began stays under them. */
export function pinchHtmlFrame(
  start: HtmlFrameView,
  area: FrameArea,
  baseScale: number,
  gesture: { from: { distance: number; mid: HtmlFramePoint }; to: { distance: number; mid: HtmlFramePoint } },
): HtmlFrameView {
  const ratio = gesture.from.distance > 0 ? gesture.to.distance / gesture.from.distance : 1;
  const zoom = Math.min(Math.max(start.zoom * ratio, 1), maxHtmlFrameZoom(baseScale));
  const pageX = (gesture.from.mid.x - start.x) / start.zoom;
  const pageY = (gesture.from.mid.y - start.y) / start.zoom;
  return clampView(zoom, gesture.to.mid.x - pageX * zoom, gesture.to.mid.y - pageY * zoom, area, baseScale);
}

/** FR-MDE-028 AC-11: a drag moves the zoomed page, never past its edges. */
export function panHtmlFrame(start: HtmlFrameView, area: FrameArea, baseScale: number, dx: number, dy: number): HtmlFrameView {
  return clampView(start.zoom, start.x + dx, start.y + dy, area, baseScale);
}

/** FR-MDE-028 AC-11: a double tap shows the page at its real size around the tap, or the fit again. */
export function toggleHtmlFrameZoom(view: HtmlFrameView, area: FrameArea, baseScale: number, point: HtmlFramePoint): HtmlFrameView {
  if (view.zoom > 1.01) return HTML_FRAME_VIEW_RESET;
  const zoom = Math.max(1, 1 / baseScale);
  return clampView(zoom, point.x - point.x * zoom, point.y - point.y * zoom, area, baseScale);
}

export function htmlFrameTransform(view: HtmlFrameView, baseScale: number): string {
  return `translate(${view.x}px, ${view.y}px) scale(${baseScale * view.zoom})`;
}

/**
 * FR-MDE-028 AC-11: one step of a drag. The zoomed page moves first; whatever the edges hold back
 * scrolls the page itself, in page pixels (a drag up scrolls down).
 */
export function dragHtmlFrame(
  view: HtmlFrameView,
  area: FrameArea,
  baseScale: number,
  dx: number,
  dy: number,
): { view: HtmlFrameView; scrollX: number; scrollY: number } {
  const next = panHtmlFrame(view, area, baseScale, dx, dy);
  const scale = baseScale * next.zoom;
  return { view: next, scrollX: -(dx - (next.x - view.x)) / scale, scrollY: -(dy - (next.y - view.y)) / scale };
}

/** FR-MDE-028 AC-11: the page's own viewport point under a point of the surface. */
export function framePointOf(view: HtmlFrameView, baseScale: number, point: HtmlFramePoint): HtmlFramePoint {
  const scale = baseScale * view.zoom;
  return { x: (point.x - view.x) / scale, y: (point.y - view.y) / scale };
}

export const HTML_SCROLL_MESSAGE = 'buildergate-html-scroll';
export const HTML_TAP_MESSAGE = 'buildergate-html-tap';

/**
 * FR-MDE-028 AC-11: runs in the page, which the app cannot reach (opaque origin), and scrolls or
 * clicks it when the app's surface asks. It obeys only messages from the app's window, so the page
 * cannot drive it, and it carries nothing back.
 */
export const HTML_VIEWER_HELPER_SCRIPT = `(function () {
  function scrollerAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      var overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  }
  addEventListener('message', function (e) {
    if (e.source !== parent || parent === window) return;
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === '${HTML_SCROLL_MESSAGE}') {
      var target = scrollerAt(d.x, d.y);
      if (target) target.scrollBy(d.dx, d.dy); else scrollBy(d.dx, d.dy);
    } else if (d.type === '${HTML_TAP_MESSAGE}') {
      var el = document.elementFromPoint(d.x, d.y);
      if (el) { if (el.focus) el.focus(); el.click(); }
    }
  });
})();`;

/** FR-MDE-028 AC-11: the text the touch surface's frame loads, the helper after the page. */
export function withViewerHelper(text: string): string {
  return `${text}\n<script>${HTML_VIEWER_HELPER_SCRIPT}</script>\n`;
}

// The view a tab opens in: rendered unless whoever opened it (MCP's view) asked otherwise.
const hints = new Map<string, HtmlView>();

/** Records the view the next tab of `filePath` opens in (FR-MCP-013 view). */
export function setHtmlViewHint(filePath: string, view: HtmlView): void {
  hints.set(filePath, view);
}

/** FR-MDE-028 AC-1: the view a new tab opens in; a hint is used once. */
export function consumeHtmlViewHint(filePath: string): HtmlView {
  const view = hints.get(filePath) ?? 'rendered';
  hints.delete(filePath);
  return view;
}

const viewRequests = new Set<(filePath: string, view: HtmlView) => void>();

/** An open tab asked for again with a view (MCP) switches to it. */
export function subscribeHtmlViewRequests(listener: (filePath: string, view: HtmlView) => void): () => void {
  viewRequests.add(listener);
  return () => {
    viewRequests.delete(listener);
  };
}

export function requestHtmlView(filePath: string, view: HtmlView): void {
  for (const listener of [...viewRequests]) listener(filePath, view);
}

/**
 * FR-MDE-028 AC-5/AC-6: what the frame loads. The saved file is its token URL. Unsaved text is
 * sent to the server as a draft and served at the same path with '?draft=n' (contract §5), so
 * the route's sandbox CSP applies and relative URLs resolve against the file's folder as they
 * do for the saved file. Until the first draft lands the saved file stays on screen.
 *
 * The frame never takes the text inline: such a document would inherit the app's CSP
 * (script-src 'self') and block the page's inline scripts and CDNs only while it is unsaved.
 */
export function renderUrl(input: { dirty: boolean; url: string; draft: number | null }): string {
  return input.dirty && input.draft !== null ? `${input.url}?draft=${input.draft}` : input.url;
}

export const DRAFT_DEBOUNCE_MS = 400;

export interface DraftScheduler {
  /** The text changed: send it once typing pauses for the delay. */
  schedule: (text: string) => void;
  cancel: () => void;
}

/** FR-MDE-028 AC-5: one draft per pause in typing, carrying the latest text only. */
export function createDraftScheduler(deps: {
  delayMs: number;
  send: (text: string) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}): DraftScheduler {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) deps.clearTimer(pending);
    pending = null;
  };
  return {
    schedule(text) {
      cancel();
      pending = deps.setTimer(() => {
        pending = null;
        deps.send(text);
      }, deps.delayMs);
    },
    cancel,
  };
}

/**
 * FR-MDE-028 AC-7/AC-9: the frame's key. A new key remounts the frame, which reruns the page —
 * on 다시 불러오기 and when a save makes the saved file current again.
 */
export function nextFrameKey(key: number, change: { reload?: boolean; wasDirty?: boolean; dirty?: boolean }): number {
  if (change.reload === true) return key + 1;
  if (change.wasDirty === true && change.dirty === false) return key + 1;
  return key;
}

/** FR-MDE-028 AC-8: absolute http(s) URLs the page names in src, href or url(). */
export function externalUrlsOf(html: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\b(?:src|href)\s*=\s*["']?|url\(\s*["']?)(https?:\/\/[^"'\s)>]+)/gi;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** One request the route served for the page (contract §5.4). */
export interface HtmlResourceEntry {
  /** From the session working directory. */
  path: string;
  result: 'loaded' | 'not-found' | 'blocked' | string;
  /** ISO 8601. */
  at: string;
}

export interface ResourceRow {
  name: string;
  state: 'loaded' | 'not-found' | 'blocked' | 'external';
  detail: string;
}

export interface ResourceSummary {
  label: string;
  failed: number;
  rows: ResourceRow[];
}

/** FR-MDE-028 AC-8: one row per path (its last result) and per external URL. */
export function summarizeResources(entries: readonly HtmlResourceEntry[], external: readonly string[]): ResourceSummary {
  const latest = new Map<string, HtmlResourceEntry>();
  for (const entry of entries) {
    latest.delete(entry.path);
    latest.set(entry.path, entry);
  }
  const rows: ResourceRow[] = [...latest.values()].map((entry) => {
    const state: ResourceRow['state'] = entry.result === 'loaded' ? 'loaded' : entry.result === 'blocked' ? 'blocked' : 'not-found';
    const detail = state === 'loaded'
      ? t('editor.html.resourceLoaded')
      : state === 'blocked' ? t('editor.html.resourceBlocked') : t('editor.html.resourceMissing');
    return { name: entry.path, state, detail };
  });
  for (const url of external) rows.push({ name: url, state: 'external', detail: t('editor.html.resourceExternal') });
  const failed = rows.filter((row) => row.state === 'not-found' || row.state === 'blocked').length;
  return {
    label: failed > 0 ? t('editor.html.resourcesFailed', { count: rows.length, failed }) : t('editor.html.resources', { count: rows.length }),
    failed,
    rows,
  };
}

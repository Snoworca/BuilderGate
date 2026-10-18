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

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * FR-MDE-028 AC-5/AC-6: the edited text with a <base> pointing at the file's folder, placed
 * first in <head> (or after <html>, or after the doctype, or at the start) so it precedes every
 * relative URL. Nothing else in the page is rewritten: absolute and /-rooted URLs stay as written.
 */
export function injectBase(html: string, baseUrl: string): string {
  const tag = `<base href="${attr(baseUrl)}">`;
  for (const pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(html);
    if (match !== null) {
      const end = match.index + match[0].length;
      return html.slice(0, end) + tag + html.slice(end);
    }
  }
  return tag + html;
}

export type RenderSource = { kind: 'src'; src: string } | { kind: 'srcdoc'; srcdoc: string };

/** FR-MDE-028 AC-5: the saved file from its token URL; unsaved text as srcdoc with the folder base. */
export function decideRenderSource(input: { dirty: boolean; text: string; url: string; baseUrl: string }): RenderSource {
  return input.dirty ? { kind: 'srcdoc', srcdoc: injectBase(input.text, input.baseUrl) } : { kind: 'src', src: input.url };
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

export interface HtmlResourceEntry {
  path: string;
  status: number;
  result: 'loaded' | 'not-found' | 'blocked' | string;
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
      ? String(entry.status)
      : state === 'blocked' ? t('editor.html.resourceBlocked') : t('editor.html.resourceMissing', { status: entry.status });
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

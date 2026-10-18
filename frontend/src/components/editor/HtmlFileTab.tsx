// One HTML tab (FR-MDE-028): a toolbar with the 렌더링 / 소스 toggle, the resource list, reload
// and open-in-tab, then the rendered page or the source. The source is the document panel's own
// code editor, handed in as children, so save, dirty, Ctrl+S, line endings and read-only are the
// code document's. Both views stay mounted once shown and are hidden with display: none, so
// switching never throws the unsaved source away.
//
// The page runs in a sandboxed frame never given the same-origin flag (AC-4): its scripts run in an
// opaque origin and cannot read the app's token, cookies or API. Its files come from the token
// route of SEC-MDE-002, and the token is revoked when the tab goes away. Unsaved text is shown
// through a server draft at the same URL, never inline, so the page runs under the route's CSP.
// @req FR-MDE-028
// @req SEC-MDE-002

import { t } from '../../i18n/i18n.ts';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { htmlViewApi } from '../../services/api.ts';
import {
  DRAFT_DEBOUNCE_MS,
  HTML_SANDBOX,
  createDraftScheduler,
  externalUrlsOf,
  nextFrameKey,
  renderUrl,
  subscribeHtmlViewRequests,
  summarizeResources,
  type HtmlResourceEntry,
  type HtmlView,
} from './htmlTabModel.ts';
import type { HtmlViewToken } from './htmlViewClient.ts';

export interface HtmlFileTabProps {
  filePath: string;
  tabId: string;
  resolveTabSession: (tabId: string) => string | undefined;
  initialView: HtmlView;
  /** The document differs from the file on disk. */
  dirty: boolean;
  /** The text in the editor now. */
  getText: () => string;
  /** Calls back with the editor text on every change; returns the unsubscribe. */
  subscribeText: (listener: (text: string) => void) => () => void;
  onSave: () => void;
  /** The source view: the panel's code editor. */
  children: ReactNode;
}

const FILL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, height: '100%' };
const HIDDEN_STYLE: CSSProperties = { ...FILL_STYLE, display: 'none' };
// After the page loads, its own requests (scripts, images) keep arriving for a moment.
const RESOURCE_SETTLE_MS = 600;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

// @req FR-MDE-028
export function HtmlFileTab({ filePath, tabId, resolveTabSession, initialView, dirty, getText, subscribeText, onSave, children }: HtmlFileTabProps) {
  const [view, setView] = useState<HtmlView>(initialView);
  // The rendered pane mounts the first time it is shown and stays.
  const [renderedOnce, setRenderedOnce] = useState(initialView === 'rendered');
  const [token, setToken] = useState<HtmlViewToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [resources, setResources] = useState<HtmlResourceEntry[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  // The text the frame shows; read when the view switches to it, not on every keystroke.
  const [renderedText, setRenderedText] = useState('');
  const tokenRef = useRef<HtmlViewToken | null>(null);
  const sessionId = resolveTabSession(tabId);
  // FR-MDE-028 AC-5: the server's number for the last unsaved text it received.
  const [draft, setDraft] = useState<number | null>(null);

  const issue = useCallback(async () => {
    if (sessionId === undefined) return;
    try {
      const next = await htmlViewApi.open(sessionId, filePath);
      const previous = tokenRef.current;
      tokenRef.current = next;
      setToken(next);
      setError(null);
      if (previous !== null) void htmlViewApi.revoke(previous.token).catch(() => undefined);
    } catch (err) {
      setError(t('editor.html.openFailed', { message: messageOf(err) }));
    }
  }, [filePath, sessionId]);

  // The token is asked for when the page is first shown and revoked with the tab (SEC-MDE-002 AC-4).
  useEffect(() => {
    if (renderedOnce && tokenRef.current === null) void issue();
  }, [issue, renderedOnce]);
  useEffect(() => () => {
    const current = tokenRef.current;
    tokenRef.current = null;
    if (current !== null) void htmlViewApi.revoke(current.token).catch(() => undefined);
  }, []);

  // MCP may ask an open tab for a view (FR-MCP-013).
  useEffect(() => subscribeHtmlViewRequests((path, requested) => {
    if (path !== filePath) return;
    if (requested === 'rendered') setRenderedText(getText());
    setView(requested);
    if (requested === 'rendered') setRenderedOnce(true);
  }), [filePath, getText]);

  const show = (next: HtmlView) => {
    if (next === 'rendered') {
      setRenderedText(getText());
      setRenderedOnce(true);
    }
    setView(next);
  };

  // FR-MDE-028 AC-9: a save reloads the frame from the saved file.
  const wasDirtyRef = useRef(dirty);
  useEffect(() => {
    setFrameKey((key) => nextFrameKey(key, { wasDirty: wasDirtyRef.current, dirty }));
    wasDirtyRef.current = dirty;
  }, [dirty]);

  // FR-MDE-028 AC-7: a fresh token and a fresh frame rerun the page from the start.
  const reload = useCallback(() => {
    setRenderedText(getText());
    setFrameKey((key) => nextFrameKey(key, { reload: true }));
    void issue();
  }, [getText, issue]);

  const refreshResources = useCallback(async () => {
    const current = tokenRef.current;
    if (sessionId === undefined || current === null) return;
    try {
      setResources(await htmlViewApi.resources(sessionId, current.token));
    } catch {
      // The list is a convenience; a failed read keeps the last one.
    }
  }, [sessionId]);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
  }, []);
  const onFrameLoad = () => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => { void refreshResources(); }, RESOURCE_SETTLE_MS);
  };

  // FR-MDE-028 AC-5: unsaved text goes to the server as a draft and the frame loads it from the
  // file's own URL; only while the page is on screen, once typing pauses.
  const sendDraft = useCallback(async (text: string) => {
    const current = tokenRef.current;
    if (sessionId === undefined || current === null) return;
    try {
      const number = await htmlViewApi.draft(sessionId, current.token, text);
      if (tokenRef.current === current) {
        setDraft(number);
        setRenderedText(text);
      }
    } catch (err) {
      setError(t('editor.html.openFailed', { message: messageOf(err) }));
    }
  }, [sessionId]);
  const scheduler = useMemo(() => createDraftScheduler({
    delayMs: DRAFT_DEBOUNCE_MS,
    send: (text) => { void sendDraft(text); },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }), [sendDraft]);
  useEffect(() => () => scheduler.cancel(), [scheduler]);
  const showingPage = view === 'rendered';
  useEffect(() => {
    if (!showingPage || token === null) return undefined;
    // On showing the page (or a fresh token) the current text goes at once if it is unsaved.
    if (dirty) void sendDraft(getText());
    return subscribeText((text) => scheduler.schedule(text));
    // `dirty` is read at the moment the page shows; later edits arrive through subscribeText.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingPage, token, scheduler, subscribeText, sendDraft]);
  useEffect(() => {
    if (!dirty) setDraft(null);
  }, [dirty]);

  const summary = useMemo(() => summarizeResources(resources, externalUrlsOf(renderedText)), [renderedText, resources]);
  const frameSrc = token === null ? null : renderUrl({ dirty, url: token.url, draft });

  const onFrameAreaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'F5') return;
    event.preventDefault();
    event.stopPropagation();
    reload();
  };

  return (
    <div style={FILL_STYLE} className="html-file-tab" data-html-view={view}>
      <div className="editor-code-toolbar html-tab-toolbar">
        <div className="html-tab-seg" role="group" aria-label={t('editor.html.view')}>
          <button type="button" className="editor-text-button" aria-pressed={view === 'rendered'} onClick={() => show('rendered')}>
            {t('editor.html.rendered')}
          </button>
          <button type="button" className="editor-text-button" aria-pressed={view === 'source'} onClick={() => show('source')}>
            {t('editor.html.source')}
          </button>
        </div>
        <button
          type="button"
          className={`editor-text-button html-tab-resources${summary.failed > 0 ? ' has-fail' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={() => {
            setPanelOpen((open) => !open);
            void refreshResources();
          }}
        >
          {summary.label}
        </button>
        <button type="button" className="editor-text-button" title={t('editor.html.reloadHint')} onClick={reload}>
          {t('editor.html.reload')}
        </button>
        <button
          type="button"
          className="editor-text-button"
          title={t('editor.html.openTabHint')}
          disabled={token === null}
          // The token URL carries the same sandbox in its response headers (SEC-MDE-002 AC-3).
          onClick={() => { if (token !== null) window.open(token.url, '_blank', 'noopener'); }}
        >
          {t('editor.html.openTab')}
        </button>
      </div>
      {error !== null && <div role="alert" className="svg-file-tab-error">{error}</div>}
      {panelOpen && (
        <div className="html-tab-resource-panel" role="dialog" aria-label={t('editor.html.resourcesTitle')}>
          <h6>{t('editor.html.resourcesTitle')}</h6>
          {summary.rows.length === 0 ? <p>{t('editor.html.resourcesEmpty')}</p> : (
            <ul>
              {summary.rows.map((row) => (
                <li key={row.name}>
                  <span>{row.name}</span>
                  <em className={`html-resource-${row.state}`}>{row.detail}</em>
                </li>
              ))}
            </ul>
          )}
          <p className="html-tab-resource-note">{t('editor.html.resourcesNote')}</p>
        </div>
      )}
      {renderedOnce && (
        <div style={view === 'rendered' ? FILL_STYLE : HIDDEN_STYLE} className="html-tab-render" tabIndex={-1} onKeyDown={onFrameAreaKeyDown}>
          {dirty && (
            <div role="status" className="html-tab-unsaved">
              <span>{t('editor.html.unsaved')}</span>
              <button type="button" className="editor-text-button" onClick={onSave}>{t('editor.html.save')}</button>
            </div>
          )}
          {frameSrc !== null && (
            <iframe
              key={frameKey}
              className="html-tab-frame"
              title={t('editor.html.frameTitle', { name: baseName(filePath) })}
              sandbox={HTML_SANDBOX}
              src={frameSrc}
              onLoad={onFrameLoad}
            />
          )}
        </div>
      )}
      <div style={view === 'source' ? FILL_STYLE : HIDDEN_STYLE} className="html-tab-source">
        {children}
      </div>
    </div>
  );
}

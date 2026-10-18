// FR-MDE-028 AC-1~AC-9 (#141): an HTML file opens in an editor tab that shows the rendered page in
// a sandboxed frame or the source in the code editor. SEC-MDE-002 is the server's route; the
// client half pinned here is the sandbox, the token lifecycle and the calls it makes.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveEditorMode } from '../../src/editor/editorMode.ts';
import { parseEditorOpenRequest, planEditorRemoteOpen } from '../../src/components/editor/editorRemoteOpen.ts';
import {
  HTML_SANDBOX,
  consumeHtmlViewHint,
  DRAFT_DEBOUNCE_MS,
  createDraftScheduler,
  externalUrlsOf,
  isHtmlFile,
  nextFrameKey,
  renderUrl,
  setHtmlViewHint,
  summarizeResources,
} from '../../src/components/editor/htmlTabModel.ts';
import { createHtmlViewClient } from '../../src/components/editor/htmlViewClient.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TAB = '../../src/components/editor/HtmlFileTab.tsx';
const CSS = '../../src/components/editor/EditorWindow.css';

test('FR-MDE-028 AC-1: .html/.htm open as an HTML tab, rendered first from the explorer and the path menu; MCP asks for its view', () => {
  for (const name of ['a.html', 'B.HTM', '/w/x/report.html']) assert.equal(isHtmlFile(name), true, name);
  for (const name of ['a.xhtml', 'a.vue', 'html', 'a.html.bak']) assert.equal(isHtmlFile(name), false, name);
  assert.equal(consumeHtmlViewHint('/w/a.html'), 'rendered', 'the default is the rendered page');
  setHtmlViewHint('/w/a.html', 'source');
  assert.equal(consumeHtmlViewHint('/w/a.html'), 'source');
  assert.equal(consumeHtmlViewHint('/w/a.html'), 'rendered', 'a hint is used once');
  const request = parseEditorOpenRequest({ workspaceId: 'w1', terminalId: 't1', filePath: '/w/a.html', kind: 'html', view: 'source' });
  assert.deepEqual(request, { workspaceId: 'w1', terminalId: 't1', filePath: '/w/a.html', kind: 'html', view: 'source' });
  assert.equal(parseEditorOpenRequest({ workspaceId: 'w1', terminalId: 't1', filePath: '/w/a.html', kind: 'html' })?.view, 'rendered');
  assert.deepEqual(planEditorRemoteOpen(request!, { activeWorkspaceId: 'w1', tabs: [{ id: 't1', workspaceId: 'w1' }] }), { action: 'open', filePath: '/w/a.html', tabId: 't1', view: 'source' });
});

test('FR-MDE-028 AC-2: a 렌더링 / 소스 segmented toggle with text labels and aria-pressed; both views stay mounted', () => {
  const tab = read(TAB);
  assert.match(tab, /role="group"/);
  assert.equal((tab.match(/aria-pressed=\{/g) ?? []).length >= 2, true);
  assert.match(tab, /t\('editor\.html\.rendered'\)/);
  assert.match(tab, /t\('editor\.html\.source'\)/);
  assert.match(tab, /display: 'none'|HIDDEN_STYLE/, 'hidden, not unmounted');
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['editor.html.rendered'], '렌더링');
  assert.equal(ko['editor.html.source'], '소스');
});

test('FR-MDE-028 AC-3: 소스 is the code editor in HTML mode', () => {
  assert.deepEqual(resolveEditorMode('report.html'), { kind: 'code', language: 'html' });
  assert.deepEqual(resolveEditorMode('index.htm'), { kind: 'code', language: 'html' });
});

test('FR-MDE-028 AC-4: the frame is sandboxed with scripts, forms, modals and popups, never same-origin', () => {
  assert.equal(HTML_SANDBOX, 'allow-scripts allow-forms allow-modals allow-popups');
  assert.doesNotMatch(HTML_SANDBOX, /same-origin/);
  const tab = read(TAB);
  assert.match(tab, /sandbox=\{HTML_SANDBOX\}/);
  assert.doesNotMatch(tab, /allow-same-origin/);
});

test('FR-MDE-028 AC-5: the saved file loads from its token URL; unsaved text renders from a server draft with a 저장 note', () => {
  const url = '/api/html-view/t/docs/a%20b.html';
  assert.equal(renderUrl({ dirty: false, url, draft: 7 }), url, 'saved: the file itself');
  assert.equal(renderUrl({ dirty: true, url, draft: 3 }), `${url}?draft=3`);
  assert.equal(renderUrl({ dirty: true, url, draft: null }), url, 'until the first draft lands, the saved file');
  // srcdoc would inherit the app's CSP (script-src 'self') and block the page's inline scripts.
  const tab = read(TAB);
  assert.doesNotMatch(tab, /srcdoc|srcDoc/);
  assert.doesNotMatch(read('../../src/components/editor/htmlTabModel.ts'), /srcdoc|srcDoc|injectBase/);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['editor.html.unsaved'], '저장하지 않은 수정을 보여 주는 중');
  assert.match(tab, /editor\.html\.save/);
});

test('FR-MDE-028 AC-5: drafts are sent 400 ms after the last change, only the latest text', () => {
  const sent: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const scheduler = createDraftScheduler({
    delayMs: DRAFT_DEBOUNCE_MS,
    send: (text) => sent.push(text),
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  assert.equal(DRAFT_DEBOUNCE_MS, 400);
  scheduler.schedule('a');
  scheduler.schedule('ab');
  scheduler.schedule('abc');
  for (const timer of timers) if (!timer.cleared) timer.fn();
  assert.deepEqual(sent, ['abc']);
  scheduler.schedule('abcd');
  scheduler.cancel();
  for (const timer of timers.slice(3)) if (!timer.cleared) timer.fn();
  assert.deepEqual(sent, ['abc'], 'a cancelled draft is not sent');
});

test('FR-MDE-028 AC-6: a draft is served at the file path itself, so relative URLs resolve against its folder; nothing is rewritten', () => {
  const url = '/api/html-view/t/docs/a.html';
  const resolved = new URL('css/a.css', new URL(renderUrl({ dirty: true, url, draft: 1 }), 'https://app.example'));
  assert.equal(resolved.pathname, '/api/html-view/t/docs/css/a.css');
  const page = '<link href="css/a.css"><script src="https://cdn.example.com/x.js"></script><img src="/static/l.png"><a href="http://example.org/">e</a><style>@font-face{src:url("https://f.example/x.woff2")}</style>';
  assert.deepEqual(externalUrlsOf(page), ['https://cdn.example.com/x.js', 'http://example.org/', 'https://f.example/x.woff2']);
});

test('FR-MDE-028 AC-7: 다시 불러오기 (and F5 on the frame area) reruns the page; 새 탭에서 열기 opens the token URL isolated', () => {
  assert.equal(nextFrameKey(3, { reload: true }), 4);
  const tab = read(TAB);
  assert.match(tab, /'F5'/);
  assert.match(tab, /window\.open\([^)]*'_blank'[^)]*noopener/);
  const ko = JSON.parse(read('../../public/locales/messages.ko.json')) as Record<string, string>;
  assert.equal(ko['editor.html.reload'], '다시 불러오기');
  assert.equal(ko['editor.html.openTab'], '새 탭에서 열기');
});

test('FR-MDE-028 AC-8: 자원 n lists what the page requested with results and external URLs, warning when any failed', () => {
  // Contract §5.4: entries carry path, result and the time; external URLs come from the source.
  const at = '2026-10-19T00:00:00.000Z';
  const ok = summarizeResources([{ path: 'css/a.css', result: 'loaded', at }], ['https://cdn.example.com/x.js']);
  assert.equal(ok.label, '자원 2');
  assert.equal(ok.failed, 0);
  assert.deepEqual(ok.rows.map((r) => [r.name, r.state]), [['css/a.css', 'loaded'], ['https://cdn.example.com/x.js', 'external']]);
  const bad = summarizeResources([
    { path: 'css/a.css', result: 'loaded', at },
    { path: 'js/x.js', result: 'not-found', at },
    { path: '.ssh/config', result: 'blocked', at },
    { path: 'css/a.css', result: 'loaded', at },
  ], []);
  assert.equal(bad.label, '자원 3 · 실패 2', 'repeated requests count once, by their last result');
  assert.equal(bad.failed, 2);
  assert.deepEqual(bad.rows.map((r) => [r.name, r.detail]), [['js/x.js', '없음'], ['.ssh/config', '차단됨'], ['css/a.css', '불러옴']]);
  assert.match(read(TAB), /aria-haspopup="dialog"/);
});

test('FR-MDE-028 AC-9: saving re-renders the page; on a phone the toggle fills the toolbar width', () => {
  assert.equal(nextFrameKey(1, { wasDirty: true, dirty: false }), 2, 'a save reloads the saved file');
  assert.equal(nextFrameKey(1, { wasDirty: false, dirty: true }), 1, 'typing does not reload the frame');
  assert.match(read(CSS), /@media \(max-width: 767px\)[\s\S]*\.html-tab-seg\s*\{[^}]*flex:\s*1/);
});

test('SEC-MDE-002 AC-1/AC-4/AC-5 (client): the token is asked with JWT, resources read with JWT, and revoked on close', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const client = createHtmlViewClient({
    apiBase: '/api',
    authFetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'PUT') return new Response(JSON.stringify({ draft: 4 }), { status: 200 });
      const body = String(input).endsWith('/resources')
        ? { entries: [{ path: 'a.css', result: 'loaded', at: '2026-10-19T00:00:00.000Z' }] }
        : { token: 't1', url: '/api/html-view/t1/a.html', baseUrl: '/api/html-view/t1/' };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    getAuthHeaders: () => ({ Authorization: 'Bearer T' }),
    parseError: async (res) => new Error(`HTTP ${res.status}`),
  });
  assert.equal((await client.open('s1', '/w/a.html')).token, 't1');
  assert.equal(await client.draft('s1', 't1', '<p>draft</p>'), 4);
  assert.deepEqual(await client.resources('s1', 't1'), [{ path: 'a.css', result: 'loaded', at: '2026-10-19T00:00:00.000Z' }]);
  await client.revoke('t1');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'POST /api/sessions/s1/files/html-view',
    'PUT /api/sessions/s1/files/html-view/t1/draft',
    'GET /api/sessions/s1/files/html-view/t1/resources',
    'DELETE /api/html-view/t1',
  ]);
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { path: '/w/a.html' });
  assert.equal(calls[1].body, '<p>draft</p>', 'the draft body is the text itself');
});

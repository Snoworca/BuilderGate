// The editor's client for the HTML view route (SEC-MDE-002): a token for one HTML file, the
// resources its page requested, and the revoke when the tab closes. Network and auth are
// injected (api.ts wires the real ones), as in fileJobClient.ts.
// @req SEC-MDE-002
// @req FR-MDE-028

import type { HtmlResourceEntry } from './htmlTabModel.ts';

export interface HtmlViewToken {
  token: string;
  /** The file itself: /api/html-view/<token>/<path from the session folder>. */
  url: string;
  /** The file's folder, ending in '/'. */
  baseUrl: string;
}

export interface HtmlViewClientDeps {
  apiBase: string;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getAuthHeaders: () => HeadersInit;
  parseError: (res: Response) => Promise<Error>;
}

export interface HtmlViewClient {
  open(sessionId: string, path: string): Promise<HtmlViewToken>;
  resources(sessionId: string, token: string): Promise<HtmlResourceEntry[]>;
  /** FR-MDE-028 AC-5: the unsaved text, served at the file URL with ?draft=<n>; answers n. */
  draft(sessionId: string, token: string, text: string): Promise<number>;
  revoke(token: string): Promise<void>;
}

/** @req SEC-MDE-002 */
export function createHtmlViewClient(deps: HtmlViewClientDeps): HtmlViewClient {
  const { apiBase, authFetch, getAuthHeaders, parseError } = deps;
  return {
    async open(sessionId, path) {
      const res = await authFetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/files/html-view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) throw await parseError(res);
      return await res.json() as HtmlViewToken;
    },
    async draft(sessionId, token, text) {
      const res = await authFetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/files/html-view/${encodeURIComponent(token)}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...getAuthHeaders() },
        body: text,
      });
      if (!res.ok) throw await parseError(res);
      const body = await res.json() as { draft: number };
      return body.draft;
    },
    async resources(sessionId, token) {
      const res = await authFetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/files/html-view/${encodeURIComponent(token)}/resources`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw await parseError(res);
      const body = await res.json() as { entries?: HtmlResourceEntry[] };
      return body.entries ?? [];
    },
    async revoke(token) {
      const res = await authFetch(`${apiBase}/html-view/${encodeURIComponent(token)}`, { method: 'DELETE', headers: getAuthHeaders() });
      // 204 when revoked; 404 when already gone (expired, revoked, or not this user's) is fine too.
      if (!res.ok && res.status !== 404) throw await parseError(res);
    },
  };
}

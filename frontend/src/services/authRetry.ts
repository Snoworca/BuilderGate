// REL-BGSTAB-037 AC-4: with several tabs open, one tab's refresh rotates the token all tabs share
// in localStorage. A request another tab sent a moment earlier still carries the old token and
// gets 401; that is not an expired login, so it is retried once with the stored token.

export interface AuthRetryDeps {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readToken: () => string | null;
  onExpired: () => void;
}

export async function authFetchWithRetry(deps: AuthRetryDeps, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await deps.fetch(input, init);
  if (res.status !== 401) return res;
  const headers = new Headers(init?.headers);
  const sent = headers.get('Authorization');
  const current = deps.readToken();
  if (current && sent !== `Bearer ${current}`) {
    headers.set('Authorization', `Bearer ${current}`);
    const retried = await deps.fetch(input, { ...init, headers });
    if (retried.status !== 401) return retried;
    deps.onExpired();
    return retried;
  }
  deps.onExpired();
  return res;
}

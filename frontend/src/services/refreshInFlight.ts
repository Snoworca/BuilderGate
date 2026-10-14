// REL-BGSTAB-045 AC-3: the token refresh this page has in flight, if any. A request that gets 401
// while it runs most likely carried the token being replaced; it waits instead of logging out.
let inFlight: Promise<unknown> | null = null;

export function trackRefresh<T>(refresh: Promise<T>): Promise<T> {
  inFlight = refresh;
  const clear = () => { if (inFlight === refresh) inFlight = null; };
  refresh.then(clear, clear);
  return refresh;
}

export async function waitForRefreshInFlight(): Promise<void> {
  const current = inFlight;
  if (!current) return;
  try {
    await current;
  } catch {
    // a failed refresh brings no new token; the caller decides
  }
}

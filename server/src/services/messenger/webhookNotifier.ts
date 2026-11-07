// FR-MSG-015 (contract §10): POST {text} (Google Chat incoming webhook format). The URL carries
// secrets (key, token), so it is never logged — not even from an error message.

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

export function createWebhookNotifier(deps: { fetch?: Fetch; log?: (event: Record<string, unknown>) => void } = {}) {
  const fetchImpl: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const log = deps.log ?? ((event) => console.warn('[Messenger Webhook]', JSON.stringify(event)));
  return async (url: string, text: string): Promise<void> => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) log({ event: 'messenger.webhook.failed', status: response.status });
    } catch (error) {
      log({ event: 'messenger.webhook.failed', error: error instanceof Error ? error.name : 'Error' });
    }
  };
}

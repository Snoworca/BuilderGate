import { expect, test } from '@playwright/test';

import { openAc6BrowserAckProbe } from '../support/perfBgstab010Ac6BrowserAckHarness';
import { login } from './helpers';

test.describe('PERF-BGSTAB-010 AC-6 server ACK fault evidence', () => {
  test.describe.configure({ retries: 0 });

  test('actual browser WSS rejects an unknown fair-delivery ACK without workspace mutation', async ({ page }) => {
    test.setTimeout(30_000);
    const workspaceMutations: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/workspaces') && request.method() !== 'GET') {
        workspaceMutations.push(`${request.method()} ${url.pathname}`);
      }
    });

    await login(page);
    expect(new URL(page.url()).origin).toBe('https://localhost:2222');

    const probe = await openAc6BrowserAckProbe(page);
    try {
      await expect(probe.sendUnknownLaneAck()).resolves.toEqual({
        type: 'terminal-delivery:ack-rejected',
        sessionId: probe.sessionId,
        connectionEpoch: probe.connectionEpoch,
        deliverySeq: probe.deliverySeq,
        reason: 'ACK_UNKNOWN_LANE',
      });
    } finally {
      await probe.close();
    }

    expect(workspaceMutations).toEqual([]);
  });
});

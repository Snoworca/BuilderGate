// FR-USAGE-005 AC-2 / FR-USAGE-006 AC-5 — the REST surface. Served over withLocalHttpServer's pipe/socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createUsageLimitsRoutes } from './usageLimitsRoutes.js';
import { UsageSettingsError } from '../services/usage/UsageLimitsService.js';

function fakeService() {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    service: {
      getState: async () => ({ view: { agents: [] }, settings: { refreshSeconds: 60 } }),
      refresh: async () => { calls.push(['refresh', null]); },
      updateSettings: async (input: { refreshSeconds?: number }) => {
        calls.push(['update', input]);
        if (input.refreshSeconds === 1) throw new UsageSettingsError('refreshSeconds');
      },
      testChannel: async (channel: string, values: unknown) => { calls.push(['test', [channel, values]]); return { ok: false, status: 401, error: 'Unauthorized' }; },
    },
  };
}

async function withRoutes(run: (req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, calls: Array<[string, unknown]>) => Promise<void>) {
  const { service, calls } = fakeService();
  const app = express();
  app.use(express.json());
  app.use('/api/usage-limits', createUsageLimitsRoutes(service as never));
  await withLocalHttpServer(app, async (fixture) => {
    await run(async (method, path, body) => {
      const response = await fixture.request({ method, path, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
    }, calls);
  });
}

test('FR-USAGE-005 AC-2: GET returns the state; POST /refresh rereads first', async () => {
  await withRoutes(async (req, calls) => {
    assert.equal((await req('GET', '/api/usage-limits')).json.settings.refreshSeconds, 60);
    const refreshed = await req('POST', '/api/usage-limits/refresh');
    assert.equal(refreshed.status, 200);
    assert.deepEqual(calls[0], ['refresh', null]);
  });
});

test('FR-USAGE-005 AC-1: PUT /settings saves, and an out-of-range value answers 400 with the field', async () => {
  await withRoutes(async (req) => {
    assert.equal((await req('PUT', '/api/usage-limits/settings', { refreshSeconds: 30 })).status, 200);
    const bad = await req('PUT', '/api/usage-limits/settings', { refreshSeconds: 1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.details.field, 'refreshSeconds');
  });
});

test('FR-USAGE-006 AC-5: POST /test sends with the typed values and returns the outcome as 200', async () => {
  await withRoutes(async (req, calls) => {
    const result = await req('POST', '/api/usage-limits/test', { channel: 'telegram', values: { chatId: '-100' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: false, status: 401, error: 'Unauthorized' });
    assert.deepEqual(calls.at(-1), ['test', ['telegram', { chatId: '-100' }]]);
    assert.equal((await req('POST', '/api/usage-limits/test', { channel: 'sms' })).status, 400);
  });
});

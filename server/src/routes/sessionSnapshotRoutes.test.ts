// FR-AITUI-013 AC-1/AC-3 · FR-AITUI-014 AC-5/AC-6 — the REST surface of the session snapshot.
// Served over withLocalHttpServer's pipe/socket, so no TCP port is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createSessionSnapshotRoutes } from './sessionSnapshotRoutes.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function fakeService() {
  const calls: Array<[string, unknown]> = [];
  const service = {
    getStatus: () => ({ snapshot: null, pendingCount: 0, restorable: false, report: [{ tabId: 't1', result: 'confirmed' }] }),
    getCandidates: () => [],
    preview: async () => ({ tabs: [{ tabId: 't1' }], launchers: { claude: ['claude'] } }),
    save: async (tabIds: string[]) => { calls.push(['save', tabIds]); return { snapshot: {}, results: [] }; },
    saveAll: async (items: unknown[]) => {
      calls.push(['saveAll', items]);
      if ((items as Array<{ tabId: string }>).some((item) => item.tabId === 'bad')) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'Some terminals cannot be saved', { tabIds: ['bad'], reasons: { bad: 'session-id-invalid' } });
      }
      return { snapshot: { entries: [] } };
    },
    retry: async (item: unknown) => { calls.push(['retry', item]); return { tabId: 't1', result: 'waiting' }; },
    restore: async () => ({ snapshot: null, results: [] }),
    discard: async () => undefined,
  };
  return { service, calls };
}

async function withRoutes(run: (req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, calls: Array<[string, unknown]>) => Promise<void>) {
  const { service, calls } = fakeService();
  const app = express();
  app.use(express.json());
  app.use('/api/session-snapshot', createSessionSnapshotRoutes(service as never));
  await withLocalHttpServer(app, async (fixture) => {
    await run(async (method, path, body) => {
      const response = await fixture.request({
        method,
        path,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
    }, calls);
  });
}

test('FR-AITUI-013 AC-1: GET /preview returns every tab and the launchers', async () => {
  await withRoutes(async (req) => {
    const response = await req('GET', '/api/session-snapshot/preview');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.tabs, [{ tabId: 't1' }]);
    assert.deepEqual(response.json.launchers, { claude: ['claude'] });
  });
});

test('FR-AITUI-013 AC-3: POST with items saves them all; a bad item answers 400 with its tab id', async () => {
  await withRoutes(async (req, calls) => {
    const ok = await req('POST', '/api/session-snapshot', { items: [{ tabId: 't1', mode: 'shell' }] });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls.at(-1), ['saveAll', [{ tabId: 't1', mode: 'shell' }]]);
    const bad = await req('POST', '/api/session-snapshot', { items: [{ tabId: 'bad', mode: 'agent', agent: 'codex', sessionId: 'x' }] });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.error.details.tabIds, ['bad']);
    const malformed = await req('POST', '/api/session-snapshot', { items: [{ mode: 'shell' }] });
    assert.equal(malformed.status, 400, 'an item without a tab id is refused before the service');
    const legacy = await req('POST', '/api/session-snapshot', { tabIds: ['t1'] });
    assert.equal(legacy.status, 200);
    assert.deepEqual(calls.at(-1), ['save', ['t1']]);
  });
});

test('FR-AITUI-014 AC-5/AC-6: GET returns the restore report, POST /retry resumes one tab', async () => {
  await withRoutes(async (req, calls) => {
    const status = await req('GET', '/api/session-snapshot');
    assert.deepEqual(status.json.report, [{ tabId: 't1', result: 'confirmed' }]);
    const retry = await req('POST', '/api/session-snapshot/retry', { tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claude', args: [], sessionId: 'id' });
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json.item, { tabId: 't1', result: 'waiting' });
    assert.equal(calls.at(-1)?.[0], 'retry');
    const noTab = await req('POST', '/api/session-snapshot/retry', { mode: 'shell' });
    assert.equal(noTab.status, 400);
  });
});

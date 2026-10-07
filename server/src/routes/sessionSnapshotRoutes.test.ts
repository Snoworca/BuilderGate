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
    listSnapshots: () => ({ manual: [{ id: 'm1', origin: 'manual' }], auto: { id: 'auto', origin: 'auto' }, retention: 10 }),
    getSnapshot: (id: string) => {
      if (id !== 'm1' && id !== 'auto') throw new AppError(ErrorCode.SNAPSHOT_NOT_FOUND);
      return { id, entries: [{ tabId: 't1', target: 'tab', targetReason: 'idle' }] };
    },
    deleteSnapshot: async (id: string) => {
      calls.push(['deleteSnapshot', id]);
      if (id !== 'm1') throw new AppError(ErrorCode.SNAPSHOT_NOT_FOUND);
    },
    restoreFrom: async (id: string, items: unknown, options: unknown) => {
      calls.push(['restoreFrom', [id, items, options]]);
      return [{ tabId: 't1', result: 'typed' }];
    },
    acknowledgeReport: async (reportId: string) => { calls.push(['acknowledgeReport', reportId]); },
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

test('FR-AITUI-017 AC-4/AC-5: GET /list lists the saves; DELETE /list/:id removes one, an unknown id is 404', async () => {
  await withRoutes(async (req, calls) => {
    const list = await req('GET', '/api/session-snapshot/list');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.manual.map((m: { id: string }) => m.id), ['m1']);
    assert.equal(list.json.auto.id, 'auto');
    const removed = await req('DELETE', '/api/session-snapshot/list/m1');
    assert.equal(removed.status, 200);
    assert.deepEqual(calls.at(-1), ['deleteSnapshot', 'm1']);
    const missing = await req('DELETE', '/api/session-snapshot/list/zz');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'SNAPSHOT_NOT_FOUND');
  });
});

test('FR-AITUI-018 AC-5/AC-6: GET /list/:id shows where each entry goes; POST /list/:id/restore restores the picked ones', async () => {
  await withRoutes(async (req, calls) => {
    const detail = await req('GET', '/api/session-snapshot/list/auto');
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.entries, [{ tabId: 't1', target: 'tab', targetReason: 'idle' }]);
    assert.equal((await req('GET', '/api/session-snapshot/list/zz')).status, 404);
    const restored = await req('POST', '/api/session-snapshot/list/auto/restore', {
      items: [{ tabId: 't1', includeCommand: true }, { tabId: 't2' }],
      activeWorkspaceId: 'w9',
    });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.json.results, [{ tabId: 't1', result: 'typed' }]);
    assert.deepEqual(calls.at(-1), ['restoreFrom', ['auto', [{ tabId: 't1', includeCommand: true }, { tabId: 't2', includeCommand: false }], { fallbackWorkspaceId: 'w9' }]]);
    const bad = await req('POST', '/api/session-snapshot/list/auto/restore', { items: [{ includeCommand: true }] });
    assert.equal(bad.status, 400, 'an item without a tab id is refused before the service');
  });
});

test('FR-AITUI-018 AC-3: POST /report/ack records that the restore notice was shown', async () => {
  await withRoutes(async (req, calls) => {
    const ack = await req('POST', '/api/session-snapshot/report/ack', { reportId: 'r-1' });
    assert.equal(ack.status, 200);
    assert.deepEqual(calls.at(-1), ['acknowledgeReport', 'r-1']);
    assert.equal((await req('POST', '/api/session-snapshot/report/ack', {})).status, 400);
  });
});

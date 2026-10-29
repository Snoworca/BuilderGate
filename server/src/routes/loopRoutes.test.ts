// FR-LOOP-001 AC-5 — the REST surface of loops. Served over withLocalHttpServer's pipe/socket,
// so no TCP port is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createLoopRoutes } from './loopRoutes.js';
import { LoopService, type LoopRuntimePort } from '../services/loop/LoopService.js';

const runtime: LoopRuntimePort = {
  workspaceExists: () => true,
  countTabs: () => 0,
  maxTabsPerWorkspace: () => 8,
  createWorkspace: async () => 'ws',
  openTab: async () => ({ tabId: 't', sessionId: 's' }),
  closeTab: async () => undefined,
  tabExists: () => true,
  submit: async () => true,
  sleep: async () => undefined,
  directoryExists: async () => true,
};

const body = {
  name: '시황',
  enabled: true,
  schedule: { kind: 'weekly', days: [1], times: ['08:30'] },
  shell: 'bash',
  cwd: '/work',
  steps: [{ kind: 'command', text: 'codex' }],
};

async function withRoutes(run: (req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-loop-routes-'));
  const service = new LoopService({ dataPath: path.join(dir, 'loops.json'), runtime, startTimer: false });
  await service.initialize();
  const app = express();
  app.use(express.json());
  app.use('/api/loops', createLoopRoutes(service));
  try {
    await withLocalHttpServer(app, async (fixture) => {
      await run(async (method, p, data) => {
        const response = await fixture.request({
          method,
          path: p,
          headers: data === undefined ? {} : { 'content-type': 'application/json' },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
      });
    });
  } finally {
    service.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-LOOP-001 AC-5: create, list, update, run now, read the history, delete', async () => {
  await withRoutes(async (req) => {
    const created = await req('POST', '/api/loops', body);
    assert.equal(created.status, 201);
    const id = created.json.loop.id;
    assert.equal(typeof created.json.loop.nextRunAt, 'string');

    const listed = await req('GET', '/api/loops');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.loops.map((loop: { id: string }) => loop.id), [id]);

    const updated = await req('PUT', `/api/loops/${id}`, { ...body, name: '시황 2' });
    assert.equal(updated.json.loop.name, '시황 2');

    // A run can wait for hours, so the request answers as soon as it has started.
    const run = await req('POST', `/api/loops/${id}/run`);
    assert.equal(run.status, 202);
    assert.equal(run.json.run.result, 'running');
    let runs = await req('GET', `/api/loops/${id}/runs`);
    for (let i = 0; i < 100 && runs.json.runs[0]?.result !== 'success'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      runs = await req('GET', `/api/loops/${id}/runs`);
    }
    assert.equal(runs.json.runs.length, 1);
    assert.equal(runs.json.runs[0].result, 'success');
    // The list carries each loop's latest run for the manager's "last result" column.
    assert.equal((await req('GET', '/api/loops')).json.loops[0].lastRun.result, 'success');

    assert.equal((await req('DELETE', `/api/loops/${id}`)).status, 200);
    assert.deepEqual((await req('GET', '/api/loops')).json.loops, []);
  });
});

test('FR-LOOP-001 AC-2/AC-3: an invalid loop answers 400 with the reason; an unknown id answers 404', async () => {
  await withRoutes(async (req) => {
    const bad = await req('POST', '/api/loops', { ...body, steps: [{ kind: 'end' }, { kind: 'command', text: 'x' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'LOOP_INVALID');
    assert.equal(bad.json.error.details.reason, 'endNotLast');
    assert.equal((await req('PUT', '/api/loops/nope', body)).status, 404);
    assert.equal((await req('POST', '/api/loops/nope/run')).json.error.code, 'LOOP_NOT_FOUND');
  });
});

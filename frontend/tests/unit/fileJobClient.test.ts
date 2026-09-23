import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as ClientModule from '../../src/components/fileExplorer/fileJobClient.ts';
import type * as EventsModule from '../../src/components/fileExplorer/fileJobEvents.ts';
import type { ConfirmPort } from '../../src/components/fileExplorer/fileExplorerPorts.ts';
import type * as ClipboardModule from '../../src/components/fileExplorer/fileExplorerClipboard.ts';
import type { ServerWsMessage } from '../../src/types/ws-protocol.ts';

// FR-FEX-005 AC-1·AC-4·AC-5 / FR-FEX-001 AC-6 — the explorer's client for the
// server's file jobs, the routing of the three file-job WS events, and the
// confirm port that stands in front of delete.
//
// The server contract is server/src/routes/fileJobRoutes.ts:
//   POST   /api/file-jobs                     {operation, sourceSessionId, sources, destSessionId?, destPath?} -> 202 {jobId}
//   POST   /api/file-jobs/:jobId/decision     {decisionId, choice, applyToAll?}
//   DELETE /api/file-jobs/:jobId              cancel
//   GET    /api/file-jobs[?sessionId=]        {jobs: [...pendingDecision]}
// Sources and destPath must be absolute: the server validates against the
// session cwd but operates relative to its own process cwd, so it answers 400
// to a relative path. The client refuses one before any request, so a tree bug
// that leaks a relative path is caught here rather than as a server 400.
//
// fetch is never real: the client takes {authFetch, getAuthHeaders, parseError,
// apiBase} (the injection shape of workspaceCapacityApi.test.ts), and the
// confirm port and job client below are fakes the tests own.
//
// Modules are loaded inside each test so a missing module fails each contract
// by name instead of killing the runner. The `import type` lines are erased at
// runtime and let tsc check the calls once the modules land.
const CLIENT_PATH = '../../src/components/fileExplorer/fileJobClient.ts';
const EVENTS_PATH = '../../src/components/fileExplorer/fileJobEvents.ts';
const CLIPBOARD_PATH = '../../src/components/fileExplorer/fileExplorerClipboard.ts';
type Client = typeof ClientModule;
type Events = typeof EventsModule;
type Clipboard = typeof ClipboardModule;
type FileJobClient = ReturnType<Client['createFileJobClient']>;

const loadClient = async (): Promise<Client> => await import(CLIENT_PATH) as Client;
const loadEvents = async (): Promise<Events> => await import(EVENTS_PATH) as Events;
async function loadClipboard(): Promise<Clipboard> {
  const m = await import(CLIPBOARD_PATH) as Clipboard;
  m.clearFileExplorerClipboard();
  return m;
}

interface RecordedRequest { url: string; init: RequestInit | undefined }

function harness(client: Client, reply: { status: number; body?: unknown } = { status: 202, body: { jobId: 'job-1' } }) {
  const requests: RecordedRequest[] = [];
  let jsonCalls = 0;
  const httpError = new Error(`HTTP ${reply.status}`);
  const response = {
    ok: reply.status < 400,
    status: reply.status,
    async json() { jsonCalls += 1; return reply.body; },
  } as unknown as Response;
  const api = client.createFileJobClient({
    apiBase: '/api',
    getAuthHeaders: () => ({ Authorization: 'Bearer test-only-token' }),
    authFetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return response;
    },
    parseError: async (value: Response) => { assert.equal(value, response); return httpError; },
  });
  return { api, requests, httpError, jsonCalls: () => jsonCalls };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function bodyOf(request: RecordedRequest): unknown {
  assert.equal(typeof request.init?.body, 'string', 'body is JSON text');
  return JSON.parse(request.init?.body as string);
}

test('TC-REQ-FR-FEX-005-AC4-03 createFileJobClient.submit 이 POST /api/file-jobs 에 buildPasteJobRequest 바디를 보내고 jobId 를 돌려준다', async (t) => {
  await t.test('submit sends the paste request unchanged and returns the jobId', async () => {
    const client = await loadClient();
    const clipboard = await loadClipboard();
    const cb = clipboard.copySelection({ sessionId: 's-1', paths: ['/work/a.txt', '/work/dir'] });
    assert.ok(cb);
    const request = clipboard.buildPasteJobRequest(cb, { destSessionId: 's-2', destPath: '/other/target' });
    assert.ok(request);
    const h = harness(client);

    assert.deepEqual(await h.api.submit(request), { jobId: 'job-1' });

    assert.equal(h.requests.length, 1);
    const [sent] = h.requests;
    assert.equal(sent.url, '/api/file-jobs');
    assert.equal(sent.init?.method, 'POST');
    const headers = headersOf(sent.init);
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.authorization, 'Bearer test-only-token');
    assert.deepEqual(bodyOf(sent), {
      operation: 'copy',
      sourceSessionId: 's-1',
      sources: ['/work/a.txt', '/work/dir'],
      destSessionId: 's-2',
      destPath: '/other/target',
    });
  });

  await t.test('submit sends a delete request without destination fields', async () => {
    const client = await loadClient();
    const h = harness(client, { status: 202, body: { jobId: 'job-del' } });
    const del = { operation: 'delete' as const, sourceSessionId: 's-1', sources: ['C:\\work\\old.log'] };

    assert.deepEqual(await h.api.submit(del), { jobId: 'job-del' });
    assert.deepEqual(bodyOf(h.requests[0]), del);
  });

  await t.test('a non-ok response rejects with parseError and is not read as a job', async () => {
    const client = await loadClient();
    const h = harness(client, { status: 400, body: { error: { code: 'INVALID_INPUT' } } });
    await assert.rejects(
      h.api.submit({ operation: 'delete', sourceSessionId: 's-1', sources: ['/work/x'] }),
      (err: unknown) => err === h.httpError,
    );
    assert.equal(h.jsonCalls(), 0, 'the error body belongs to parseError, not to submit');
  });

  await t.test('relative sources or destPath are refused before any request (server requires absolute paths)', async () => {
    const client = await loadClient();
    const relative: Parameters<FileJobClient['submit']>[0][] = [
      { operation: 'copy', sourceSessionId: 's-1', sources: ['src/a.ts'], destSessionId: 's-1', destPath: '/work' },
      { operation: 'copy', sourceSessionId: 's-1', sources: ['/work/a.ts'], destSessionId: 's-1', destPath: 'sub' },
      { operation: 'move', sourceSessionId: 's-1', sources: ['./a.ts'], destSessionId: 's-1', destPath: '/work' },
      { operation: 'delete', sourceSessionId: 's-1', sources: ['/work/ok', '..\\up'] },
      // drive-relative: resolves against that drive's current directory
      { operation: 'delete', sourceSessionId: 's-1', sources: ['C:foo'] },
    ];
    for (const request of relative) {
      const h = harness(client);
      await assert.rejects(h.api.submit(request), Error, JSON.stringify(request));
      assert.equal(h.requests.length, 0, `no request for ${JSON.stringify(request)}`);
    }
    // absolute forms the server accepts still go out
    for (const source of ['/work/a', 'C:\\work\\a', 'C:/work/a', '\\\\server\\share\\a']) {
      const h = harness(client);
      await h.api.submit({ operation: 'delete', sourceSessionId: 's-1', sources: [source] });
      assert.equal(h.requests.length, 1, source);
    }
  });

  await t.test('decide, cancel and list hit the decision, cancel and list routes', async () => {
    const client = await loadClient();

    const decide = harness(client, { status: 200, body: { ok: true } });
    await decide.api.decide('job/1', { decisionId: 'd-1', choice: 'rename', applyToAll: true });
    assert.equal(decide.requests.length, 1);
    assert.equal(decide.requests[0].url, '/api/file-jobs/job%2F1/decision', 'jobId is URL-encoded');
    assert.equal(decide.requests[0].init?.method, 'POST');
    assert.equal(headersOf(decide.requests[0].init).authorization, 'Bearer test-only-token');
    assert.deepEqual(bodyOf(decide.requests[0]), { decisionId: 'd-1', choice: 'rename', applyToAll: true });

    const cancel = harness(client, { status: 200, body: { outcome: 'cancelled' } });
    await cancel.api.cancel('job-1');
    assert.equal(cancel.requests[0].url, '/api/file-jobs/job-1');
    assert.equal(cancel.requests[0].init?.method, 'DELETE');
    assert.equal(headersOf(cancel.requests[0].init).authorization, 'Bearer test-only-token');

    const jobs = [{ jobId: 'job-1', pendingDecision: null }];
    const list = harness(client, { status: 200, body: { jobs } });
    assert.deepEqual(await list.api.list('s 1'), jobs);
    assert.equal(list.requests[0].url, '/api/file-jobs?sessionId=s%201');
    assert.ok(list.requests[0].init?.method === undefined || list.requests[0].init?.method === 'GET');
  });
});

test("TC-REQ-FR-FEX-005-AC5-03 requestDelete 는 confirm 포트가 'confirm' 일 때만 operation 'delete' 작업을 제출하고 'cancel' 이면 요청 0건", async () => {
  const client = await loadClient();
  for (const answer of ['confirm', 'cancel'] as const) {
    const submitted: unknown[] = [];
    const asked: unknown[][] = [];
    const confirm: ConfirmPort = async (...args) => { asked.push(args); return answer; };
    const fake = { submit: async (request: unknown) => { submitted.push(request); return { jobId: 'job-del' }; } };

    const result = await client.requestDelete({
      client: fake,
      confirm,
      selection: { sessionId: 's-1', paths: ['/work/..', '/work/a.txt', '/work/b'] },
    });

    assert.equal(asked.length, 1, `${answer}: asked exactly once`);
    assert.equal(asked[0][0], 'delete');
    assert.deepEqual((asked[0][1] as { paths: string[] }).paths, ['/work/a.txt', '/work/b'], "'..' is never a delete target");
    if (answer === 'confirm') {
      assert.deepEqual(submitted, [{ operation: 'delete', sourceSessionId: 's-1', sources: ['/work/a.txt', '/work/b'] }]);
      assert.deepEqual(result, { jobId: 'job-del' });
    } else {
      assert.deepEqual(submitted, [], 'cancel sends nothing');
      assert.equal(result, null);
    }
  }

  // nothing deletable: no question, no request
  const asked: unknown[] = [];
  const submitted: unknown[] = [];
  const result = await client.requestDelete({
    client: { submit: async (r: unknown) => { submitted.push(r); return { jobId: 'x' }; } },
    confirm: async (...args) => { asked.push(args); return 'confirm'; },
    selection: { sessionId: 's-1', paths: ['/work/..'] },
  });
  assert.equal(result, null);
  assert.deepEqual(asked, []);
  assert.deepEqual(submitted, []);
});

test('TC-REQ-FR-FEX-001-AC6-05 routeFileJobMessage(file-job:done) → {kind:\'invalidate\', sessionId, directories: affectedDirectories}', async () => {
  const events = await loadEvents();

  for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
    const done: ServerWsMessage = {
      type: 'file-job:done', sessionId: 's-2', jobId: 'job-1', outcome, processedEntries: 3,
      affectedDirectories: ['/work', '/other/target'],
      ...(outcome === 'failed' ? { errorCode: 'EACCES' } : {}),
    };
    // A cancelled or failed job may still have changed some files: refresh anyway.
    assert.deepEqual(events.routeFileJobMessage(done), {
      kind: 'invalidate', sessionId: 's-2', directories: ['/work', '/other/target'],
    }, outcome);
  }

  const decision: ServerWsMessage = {
    type: 'file-job:decision-required', sessionId: 's-1', jobId: 'job-1', decisionId: 'd-1',
    kind: 'conflict', path: '/other/target/a.txt', detail: null, choices: ['overwrite', 'rename', 'skip'],
  };
  assert.deepEqual(events.routeFileJobMessage(decision), {
    kind: 'decide', sessionId: 's-1', jobId: 'job-1', decisionId: 'd-1',
    detail: { kind: 'conflict', path: '/other/target/a.txt', choices: ['overwrite', 'rename', 'skip'] },
  });

  const progress: ServerWsMessage = {
    type: 'file-job:progress', sessionId: 's-1', jobId: 'job-1', phase: 'transferring',
    processedBytes: 10, totalBytes: 20, processedEntries: 1, totalEntries: 2, currentPath: '/work/a.txt',
  };
  const routed = events.routeFileJobMessage(progress);
  assert.ok(routed && routed.kind === 'progress');
  assert.equal(routed.sessionId, 's-1');
  assert.equal(routed.jobId, 'job-1');

  const other: ServerWsMessage = { type: 'cwd', sessionId: 's-1', cwd: '/work' };
  assert.equal(events.routeFileJobMessage(other), null, 'non file-job messages are not routed');
});

test('TC-REQ-FR-FEX-005-AC1-03 cut 붙여넣기 제출 성공 후 클립보드가 비고, copy 는 유지된다', async () => {
  const client = await loadClient();
  const clipboard = await loadClipboard();
  const target = { destSessionId: 's-1', destPath: '/other' };

  function fakeClient(fail = false) {
    const submitted: unknown[] = [];
    return {
      submitted,
      submit: async (request: unknown) => {
        submitted.push(request);
        if (fail) throw new Error('HTTP 400');
        return { jobId: 'job-p' };
      },
    };
  }

  // cut → move, then the clipboard is emptied
  clipboard.cutSelection({ sessionId: 's-1', paths: ['/work/a.txt'] });
  const cut = fakeClient();
  assert.deepEqual(await client.pasteFromClipboard({ client: cut, target }), { jobId: 'job-p' });
  assert.deepEqual(cut.submitted, [{ operation: 'move', sourceSessionId: 's-1', sources: ['/work/a.txt'], destSessionId: 's-1', destPath: '/other' }]);
  assert.equal(clipboard.getFileExplorerClipboard(), null, 'cut is consumed by a successful paste');

  // copy → copy, the clipboard stays for another paste
  const copied = clipboard.copySelection({ sessionId: 's-1', paths: ['/work/b.txt'] });
  const copy = fakeClient();
  assert.deepEqual(await client.pasteFromClipboard({ client: copy, target }), { jobId: 'job-p' });
  assert.equal((copy.submitted[0] as { operation: string }).operation, 'copy');
  assert.equal(clipboard.getFileExplorerClipboard(), copied, 'copy stays after paste');

  // a failed cut paste keeps the clipboard so the user can retry
  const cutAgain = clipboard.cutSelection({ sessionId: 's-1', paths: ['/work/c.txt'] });
  await assert.rejects(client.pasteFromClipboard({ client: fakeClient(true), target }));
  assert.equal(clipboard.getFileExplorerClipboard(), cutAgain, 'failed submit does not consume the cut');

  // empty clipboard: nothing to send
  clipboard.clearFileExplorerClipboard();
  const none = fakeClient();
  assert.equal(await client.pasteFromClipboard({ client: none, target }), null);
  assert.deepEqual(none.submitted, []);
});

test('FX3-007 잘라낸 폴더를 그 안으로 붙여넣으면 보내지 않고 짧은 이유로 거절하며 클립보드는 그대로다', async () => {
  const client = await loadClient();
  const clipboard = await loadClipboard();
  const cut = clipboard.cutSelection({ sessionId: 's-1', paths: ['/work/docs'] });
  const submitted: unknown[] = [];
  const fake = { submit: async (request: unknown) => { submitted.push(request); return { jobId: 'job-p' }; } };
  await assert.rejects(
    client.pasteFromClipboard({ client: fake, target: { destSessionId: 's-1', destPath: '/work/docs/sub' } }),
    (error: unknown) => error instanceof Error && error.message !== '' && !/HTTP/.test(error.message),
  );
  assert.deepEqual(submitted, [], 'a move into its own source reached the server');
  assert.equal(clipboard.getFileExplorerClipboard(), cut, 'a refused paste must not consume the cut');
});

test('FX3-007 붙여넣기 단일 비행: 첫 제출이 끝나기 전의 두 번째 누름은 무시된다', async () => {
  const client = await loadClient();
  const flight = client.createSingleFlight();
  let release: (value: { jobId: string }) => void = () => {};
  let calls = 0;
  const first = flight.run(() => {
    calls += 1;
    return new Promise<{ jobId: string }>((resolve) => { release = resolve; });
  });
  const second = await flight.run(async () => { calls += 1; return { jobId: 'job-2' }; });
  assert.equal(second, null, 'the second press was not ignored');
  assert.equal(calls, 1);
  release({ jobId: 'job-1' });
  assert.deepEqual(await first, { jobId: 'job-1' });

  // Settled — including by failure — the next press goes through.
  await assert.rejects(flight.run(async () => { throw new Error('HTTP 400'); }));
  assert.deepEqual(await flight.run(async () => ({ jobId: 'job-3' })), { jobId: 'job-3' });
});

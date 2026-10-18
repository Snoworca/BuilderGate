// FR-FEX-024 AC-1 / FR-FEX-025 AC-2·AC-3·AC-6 (#139): the client speaks the transfer contract in
// docs/design/file-transfer.api-contract.md. Network and auth are injected, as in fileJobClient.
import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileTransferClient, TransferError, type XhrLike } from '../../src/components/fileExplorer/fileTransferClient.ts';

interface Call { url: string; init?: RequestInit }

class FakeXhr implements XhrLike {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  aborted = false;
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}

function harness(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: Call[] = [];
  const client = createFileTransferClient({
    apiBase: '/api',
    authFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'Content-Type': 'application/json' } });
    },
    getAuthHeaders: () => ({ Authorization: 'Bearer T' }),
    parseError: async (res) => new Error(`HTTP ${res.status}`),
    createXhr: () => new FakeXhr(),
  });
  return { client, calls };
}

test('FR-FEX-024 AC-1: a file goes up as a raw PUT with progress, the folder and path in the query', async () => {
  const { client } = harness();
  const progress: number[] = [];
  const controller = new AbortController();
  const done = client.putFile({ sessionId: 's1', dir: '/w/src', path: 'assets/a b.png', conflict: 'overwrite', body: new Blob(['abcd']), signal: controller.signal, onProgress: (sent) => progress.push(sent) });
  const xhr = FakeXhr.last!;
  assert.equal(xhr.method, 'PUT');
  assert.equal(xhr.url, '/api/sessions/s1/files/upload?dir=%2Fw%2Fsrc&path=assets%2Fa%20b.png&conflict=overwrite');
  assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.equal(xhr.headers.Authorization, 'Bearer T');
  xhr.upload.onprogress?.({ loaded: 2 });
  xhr.respond(200, { name: 'a b.png', path: '/w/src/assets/a b.png', size: 4, skipped: false });
  assert.deepEqual(await done, { name: 'a b.png', path: '/w/src/assets/a b.png', size: 4, skipped: false });
  assert.deepEqual(progress, [2]);
});

test('FR-FEX-024 AC-3: a refused PUT carries the server code; a dropped connection is a network error; abort rejects', async () => {
  const { client } = harness();
  const refused = client.putFile({ sessionId: 's1', dir: 'd', path: 'x.exe', conflict: 'fail', body: new Blob(['x']), signal: new AbortController().signal, onProgress: () => {} });
  FakeXhr.last!.respond(403, { error: { code: 'PATH_BLOCKED', message: 'blocked' } });
  await assert.rejects(refused, (error: unknown) => error instanceof TransferError && error.status === 403 && error.code === 'PATH_BLOCKED');

  const dropped = client.putFile({ sessionId: 's1', dir: 'd', path: 'a', conflict: 'fail', body: new Blob(['x']), signal: new AbortController().signal, onProgress: () => {} });
  FakeXhr.last!.onerror?.();
  await assert.rejects(dropped, (error: unknown) => error instanceof TransferError && error.status === 0 && error.code === 'NETWORK');

  const controller = new AbortController();
  const aborted = client.putFile({ sessionId: 's1', dir: 'd', path: 'a', conflict: 'fail', body: new Blob(['x']), signal: controller.signal, onProgress: () => {} });
  const xhr = FakeXhr.last!;
  controller.abort();
  assert.equal(xhr.aborted, true);
  await assert.rejects(aborted, (error: unknown) => error instanceof Error && error.name === 'AbortError');
});

test('FR-FEX-022/FR-FEX-024: the pre-check posts the folder and the relative paths with sizes', async () => {
  const { client, calls } = harness([{ status: 200, body: { conflicts: [], rejected: [{ path: 'x.exe', code: 'PATH_BLOCKED' }] } }]);
  const result = await client.checkUpload('s1', { dir: '/w', files: [{ path: 'a.png', size: 3 }] });
  assert.equal(calls[0].url, '/api/sessions/s1/files/upload/check');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { dir: '/w', files: [{ path: 'a.png', size: 3 }] });
  assert.deepEqual(result.rejected, [{ path: 'x.exe', code: 'PATH_BLOCKED' }]);
});

test('FR-FEX-025 AC-2·AC-3·AC-6: precount, token, job status and cancel follow the contract', async () => {
  const { client, calls } = harness([
    { status: 200, body: { name: 'src.zip', fileCount: 3, totalBytes: 10, excluded: ['.git', 'node_modules'], skippedBlocked: 0 } },
    { status: 200, body: { token: 't', url: '/api/downloads/t', name: 'src.zip', jobId: 'j1' } },
    { status: 200, body: { state: 'streaming', sentBytes: 4, totalBytes: 10 } },
    { status: 200, body: {} },
  ]);
  assert.equal((await client.zipPrecount('s1', ['/w/src'])).fileCount, 3);
  assert.equal((await client.zipToken('s1', ['/w/src'])).jobId, 'j1');
  assert.equal((await client.zipJob('s1', 'j1')).sentBytes, 4);
  await client.zipCancel('s1', 'j1');
  assert.deepEqual(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`), [
    'POST /api/sessions/s1/files/zip/precount',
    'POST /api/sessions/s1/files/zip/token',
    'GET /api/sessions/s1/files/zip/jobs/j1',
    'DELETE /api/sessions/s1/files/zip/jobs/j1',
  ]);
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { paths: ['/w/src'] });
});

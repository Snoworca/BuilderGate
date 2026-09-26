import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileApi } from '../../src/services/api.ts';

// IR-MDE-003 AC-3 / AC-5 — the front-end reader for the image byte route.
// The route must be fetched with the Authorization header (never a ?token=
// query on an <img src>, which would leave the JWT in the URL), and the bytes
// come back as a Blob for URL.createObjectURL.

const SESSION_ID = 'session-4b2e71';
const IMAGE_PATH = '/workspace/assets/logo mark.png';
const READ_IMAGE_URL = `/api/sessions/${SESSION_ID}/files/read-image?path=${encodeURIComponent(IMAGE_PATH)}`;
const AUTH_TOKEN = 'jwt-token-for-the-image-route';
const AUTH_TOKEN_KEY = 'cws_auth_token';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff]);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

interface RecordedFetchCall {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}

type ReadImage = (sessionId: string, path: string) => Promise<unknown>;

/** fileApi.readImage does not exist yet; resolve it dynamically and fail loudly when absent. */
function resolveReadImage(): ReadImage {
  const candidate = (fileApi as Record<string, unknown>).readImage;
  assert.equal(typeof candidate, 'function', 'fileApi must expose readImage(sessionId, path)');
  return candidate as ReadImage;
}

async function withStubbedBrowserGlobals(
  respond: () => Response,
  run: (calls: readonly RecordedFetchCall[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: RecordedFetchCall[] = [];

  const storage = new MemoryStorage();
  storage.setItem(AUTH_TOKEN_KEY, AUTH_TOKEN);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: (): boolean => true },
  });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return respond();
  };

  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }

  assert.equal(globalThis.fetch, originalFetch, 'the fetch stub must be restored');
}

test('fileApi.readImage(sessionId, path) 가 /api/sessions/:id/files/read-image?path= 로 Authorization 헤더와 함께 요청하고 Blob 을 돌려준다', async () => {
  await withStubbedBrowserGlobals(
    () => new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    async (calls) => {
      const readImage = resolveReadImage();

      const result = await readImage(SESSION_ID, IMAGE_PATH);

      assert.equal(calls.length, 1, 'readImage must issue exactly one request');
      const [call] = calls;
      assert.equal(String(call.input), READ_IMAGE_URL, 'readImage must target the read-image route with an encoded path query');
      assert.ok(
        call.init?.method === undefined || call.init.method === 'GET',
        `readImage must use GET, got ${String(call.init?.method)}`,
      );
      assert.ok(!String(call.input).includes('token='), 'the JWT must never be put in the URL');

      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${AUTH_TOKEN}`, 'readImage must carry the stored auth token');

      assert.ok(result instanceof Blob, 'readImage must resolve to a Blob');
      assert.equal(result.type, 'image/png', 'the Blob must keep the response image MIME type');
      const bytes = new Uint8Array(await result.arrayBuffer());
      assert.deepEqual(Array.from(bytes), Array.from(PNG_BYTES), 'the Blob must hold the raw response bytes unchanged');
    },
  );
});

test('오류 응답(FILE_TOO_LARGE 등)은 parseError 로 code 를 담아 throw', async () => {
  await withStubbedBrowserGlobals(
    () => new Response(
      JSON.stringify({ error: { code: 'FILE_TOO_LARGE', message: 'File is too large', timestamp: '2026-09-26T00:00:00.000Z' } }),
      { status: 413, statusText: 'Payload Too Large', headers: { 'Content-Type': 'application/json' } },
    ),
    async (calls) => {
      const readImage = resolveReadImage();

      await assert.rejects(
        readImage(SESSION_ID, IMAGE_PATH),
        (error: unknown) => {
          assert.ok(error instanceof Error, 'readImage must reject with an Error');
          assert.match(error.message, /FILE_TOO_LARGE/, 'the rejection must carry the server error code');
          assert.match(error.message, /File is too large/, 'the rejection must carry the server message');
          return true;
        },
      );
      assert.equal(calls.length, 1, 'the rejecting call must have reached the server exactly once');
    },
  );
});

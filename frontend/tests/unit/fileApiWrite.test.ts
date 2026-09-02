import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileApi } from '../../src/services/api.ts';

const SESSION_ID = 'session-7f3c9a';
const FILE_PATH = '/workspace/docs/release-notes.md';
const FILE_CONTENT = '# Release notes\n\n- markdown editor write path\n';
const WRITE_URL = `/api/sessions/${SESSION_ID}/files/write`;
const AUTH_TOKEN = 'jwt-token-for-the-write-route';
const AUTH_TOKEN_KEY = 'cws_auth_token';

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

type WriteFile = (sessionId: string, path: string, content: string) => Promise<unknown>;

/**
 * fileApi.writeFile does not exist yet, so it cannot be reached through the
 * exported object type. Resolve it dynamically and fail loudly when absent.
 */
function resolveWriteFile(): WriteFile {
  const candidate = (fileApi as Record<string, unknown>).writeFile;
  assert.equal(
    typeof candidate,
    'function',
    'fileApi must expose writeFile(sessionId, path, content)',
  );
  return candidate as WriteFile;
}

/**
 * Installs a recording fetch stub, an in-memory localStorage (getAuthHeaders
 * reads the token through tokenStorage) and a window whose dispatched event
 * types are recorded (authFetch announces an expired token through it),
 * restores all three, and then asserts the restoration actually happened so no
 * global state survives the test.
 */
async function withStubbedBrowserGlobals(
  respond: () => Response,
  run: (
    calls: readonly RecordedFetchCall[],
    dispatched: readonly string[],
    storage: Storage,
  ) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: RecordedFetchCall[] = [];
  const dispatched: string[] = [];

  const storage = new MemoryStorage();
  storage.setItem(AUTH_TOKEN_KEY, AUTH_TOKEN);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent(event: Event): boolean {
        dispatched.push(event.type);
        return true;
      },
    },
  });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return respond();
  };

  try {
    await run(calls, dispatched, storage);
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

  assert.equal(
    globalThis.fetch,
    originalFetch,
    'the fetch stub must leave globalThis.fetch at its original value',
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    originalLocalStorageDescriptor,
    'the localStorage stub must leave globalThis.localStorage at its original property descriptor',
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, 'window'),
    originalWindowDescriptor,
    'the window stub must leave globalThis.window at its original property descriptor',
  );
}

test('IR-MDE-001 fileApi.writeFile issues one POST to the session write route', async () => {
  await withStubbedBrowserGlobals(
    () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    async (calls) => {
      const writeFile = resolveWriteFile();

      await writeFile(SESSION_ID, FILE_PATH, FILE_CONTENT);

      assert.equal(calls.length, 1, 'writeFile must issue exactly one request');

      const [call] = calls;
      assert.equal(
        String(call.input),
        WRITE_URL,
        'writeFile must target the session-scoped write route with sessionId as its first argument',
      );
      assert.equal(call.init?.method, 'POST', 'writeFile must use the POST method');

      const headers = new Headers(call.init?.headers);
      assert.equal(
        headers.get('content-type'),
        'application/json',
        'writeFile must declare a JSON content type like the neighbouring mutating calls',
      );
      assert.equal(
        headers.get('authorization'),
        `Bearer ${AUTH_TOKEN}`,
        'writeFile must carry the stored auth token like the neighbouring mutating calls',
      );

      const body = call.init?.body;
      assert.equal(typeof body, 'string', 'writeFile must send a JSON string body');

      const payload: unknown = JSON.parse(body as string);
      assert.equal(typeof payload, 'object');
      assert.notEqual(payload, null);

      const fields = payload as Record<string, unknown>;
      assert.equal(fields.path, FILE_PATH, 'the body path must be the second argument');
      assert.equal(fields.content, FILE_CONTENT, 'the body content must be the third argument');
    },
  );
});

test('IR-MDE-001 fileApi.writeFile rejects on an error response', async () => {
  await withStubbedBrowserGlobals(
    () => new Response(JSON.stringify({ error: 'write failed' }), {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'Content-Type': 'application/json' },
    }),
    async (calls) => {
      const writeFile = resolveWriteFile();

      await assert.rejects(
        writeFile(SESSION_ID, FILE_PATH, FILE_CONTENT),
        (error: unknown) => error instanceof Error,
        'writeFile must reject when the server answers with an error status',
      );

      assert.equal(calls.length, 1, 'the rejecting call must still have reached the server exactly once');
    },
  );
});

test('IR-MDE-001 fileApi.writeFile routes a rejected token through the re-authentication path', async () => {
  await withStubbedBrowserGlobals(
    () => new Response(JSON.stringify({ error: 'token expired' }), {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'application/json' },
    }),
    async (calls, dispatched, storage) => {
      const writeFile = resolveWriteFile();

      await assert.rejects(
        writeFile(SESSION_ID, FILE_PATH, FILE_CONTENT),
        (error: unknown) => error instanceof Error,
        'writeFile must reject when the server rejects the token',
      );

      assert.equal(calls.length, 1, 'the rejected call must have reached the server exactly once');
      assert.equal(
        storage.getItem(AUTH_TOKEN_KEY),
        null,
        'a 401 must clear the stored token, which only happens when writeFile goes through authFetch',
      );
      assert.deepEqual(
        dispatched,
        ['auth-expired'],
        'a 401 must announce auth-expired exactly once so the app can re-authenticate',
      );
    },
  );
});

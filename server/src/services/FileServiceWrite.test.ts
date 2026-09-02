/**
 * IR-MDE-001 — session file write endpoint.
 *
 * The criteria are phrased in terms of the response the caller receives, so the
 * cases go through the mounted route rather than calling the service directly.
 * The route delegates to the write method on FileService, so a failure on
 * either surface is visible here.
 *
 * server/src/test-runner.ts does not discover *.test.ts, so this file is run
 * per-file with node:test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import express from 'express';
import { FileService } from './FileService.js';
import { createFileRoutes } from '../routes/fileRoutes.js';
import {
  createJsonBodyParser,
  requestBodyLimitBytes,
  respondIfRequestEntityTooLarge,
} from '../middleware/requestBodyLimit.js';
import type { FileManagerConfig } from '../types/file.types.js';

const SESSION_ID = 'session-write-1';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface WriteResponse {
  status: number;
  text: string;
}

interface WriteHarness {
  cwd: string;
  write(sessionId: string, filePath: string, content: string): Promise<WriteResponse>;
  close(): Promise<void>;
}

const DEFAULT_FILE_MANAGER_CONFIG: FileManagerConfig = {
  maxFileSize: 1048576,
  maxCodeFileSize: 524288,
  maxDirectoryEntries: 10000,
  blockedExtensions: [],
  blockedPaths: [],
  cwdCacheTtlMs: 1000,
};

interface ServiceOnTempCwd {
  cwd: string;
  service: FileService;
}

async function createServiceOnTempCwd(
  overrides: Partial<FileManagerConfig> = {}
): Promise<ServiceOnTempCwd> {
  // realpath because Windows temp paths can differ in form from the value
  // mkdtemp returns, and the path validator compares against the resolved form.
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-file-write-')));

  const sessionManager = {
    getSession: (id: string): unknown => (id === SESSION_ID ? { id } : null),
    getPtyPid: (): number | null => null,
    getInitialCwd: (): string | null => cwd,
    getCwdFilePath: (): string | null => null,
  };

  const service = new FileService(sessionManager, { ...DEFAULT_FILE_MANAGER_CONFIG, ...overrides });
  return { cwd, service };
}

interface RunningApp {
  port: number;
  close(): Promise<void>;
}

async function listenOnEphemeralPort(app: express.Express): Promise<RunningApp> {
  const server = app.listen(0, '127.0.0.1');
  // Waiting on 'listening' alone would never settle if listen fails, turning a
  // bind failure into a timeout instead of an error.
  await Promise.race([once(server, 'listening'), once(server, 'error').then(([err]) => { throw err; })]);
  const { port } = server.address() as AddressInfo;

  return {
    port,
    async close(): Promise<void> {
      // fetch keeps connections alive; dropping them first keeps close() from
      // waiting on a socket the test is done with.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function postWriteBody(port: number, sessionId: string, body: string): Promise<WriteResponse> {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/files/write`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }
  );
  return { status: response.status, text: await response.text() };
}

async function createWriteHarness(
  overrides: Partial<FileManagerConfig> = {}
): Promise<WriteHarness> {
  const { cwd, service } = await createServiceOnTempCwd(overrides);

  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createFileRoutes(service));

  const running = await listenOnEphemeralPort(app);

  return {
    cwd,
    async write(sessionId: string, filePath: string, content: string): Promise<WriteResponse> {
      return postWriteBody(running.port, sessionId, JSON.stringify({ path: filePath, content }));
    },
    async close(): Promise<void> {
      await running.close();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

test('IR-MDE-001 write path encodes UTF-8 without a BOM', async () => {
  const harness = await createWriteHarness();
  const content = '# 제목\n본문 with ASCII, 한글, é and ✓.\n';

  try {
    const response = await harness.write(SESSION_ID, 'note.md', content);
    assert.equal(response.status, 200, `write was not answered with a success: ${response.text}`);

    const bytes = await fs.readFile(path.join(harness.cwd, 'note.md'));
    assert.equal(
      bytes.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM),
      false,
      'the file begins with a UTF-8 BOM'
    );
    assert.equal(bytes.toString('utf-8'), content, 'the bytes do not decode from UTF-8 to the submitted content');
    assert.ok(
      bytes.equals(Buffer.from(content, 'utf-8')),
      'the bytes differ from the UTF-8 encoding of the submitted content'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path preserves mixed CRLF and LF bytes', async () => {
  const harness = await createWriteHarness();
  const content = 'first\r\nsecond\nthird\r\n\nfifth\ntrailing\r\n';

  try {
    const response = await harness.write(SESSION_ID, 'mixed-endings.md', content);
    assert.equal(response.status, 200, `write was not answered with a success: ${response.text}`);

    const bytes = await fs.readFile(path.join(harness.cwd, 'mixed-endings.md'));
    assert.deepEqual(
      Array.from(bytes),
      Array.from(Buffer.from(content, 'utf-8')),
      'a line ending was added, removed or converted'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path creates a new file and truncates on overwrite', async () => {
  const harness = await createWriteHarness();
  const createdBody = 'created through the write path\n';
  const longerBody = 'a previous body that is decidedly longer than what replaces it\n';
  const shorterBody = 'short\n';

  try {
    assert.deepEqual(await fs.readdir(harness.cwd), [], 'the harness cwd was not empty before the create case');

    const createResponse = await harness.write(SESSION_ID, 'created.md', createdBody);
    assert.equal(createResponse.status, 200, `create was not answered with a success: ${createResponse.text}`);
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'created.md'), 'utf-8'),
      createdBody,
      'the created file does not hold the submitted content'
    );

    const overwriteTarget = path.join(harness.cwd, 'overwritten.md');
    await fs.writeFile(overwriteTarget, longerBody, 'utf-8');

    const overwriteResponse = await harness.write(SESSION_ID, 'overwritten.md', shorterBody);
    assert.equal(overwriteResponse.status, 200, `overwrite was not answered with a success: ${overwriteResponse.text}`);

    const overwritten = await fs.readFile(overwriteTarget);
    assert.equal(
      overwritten.byteLength,
      Buffer.byteLength(shorterBody, 'utf-8'),
      'the resulting length does not equal the length of the submitted content'
    );
    assert.equal(
      overwritten.toString('utf-8'),
      shorterBody,
      'the tail of the previous body survived the overwrite'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path rejects a directory escape and still accepts a legal control write', async () => {
  const harness = await createWriteHarness();
  const content = 'a body that must never land above the session cwd\n';
  const stamp = `${process.pid}-${Date.now()}`;
  // The parent of the harness cwd is the OS temp directory, so both escape
  // targets are removable by this test whether or not they get created.
  const outside = path.dirname(harness.cwd);
  const traversalName = `buildergate-escape-relative-${stamp}.md`;
  const traversalTarget = path.join(outside, traversalName);
  const absoluteTarget = path.join(outside, `buildergate-escape-absolute-${stamp}.md`);

  try {
    const traversal = await harness.write(SESSION_ID, `../${traversalName}`, content);
    assert.ok(
      traversal.status >= 400,
      `the parent-directory traversal was answered with ${traversal.status} rather than an error: ${traversal.text}`
    );
    assert.equal(
      existsSync(traversalTarget),
      false,
      'the parent-directory traversal created a file above the session cwd'
    );

    const absolute = await harness.write(SESSION_ID, absoluteTarget, content);
    assert.ok(
      absolute.status >= 400,
      `the absolute path outside the session cwd was answered with ${absolute.status} rather than an error: ${absolute.text}`
    );
    assert.equal(
      existsSync(absoluteTarget),
      false,
      'the absolute path outside the session cwd created a file there'
    );

    // Control. Without it an endpoint that refuses every write would satisfy
    // the two rejections above.
    const control = await harness.write(SESSION_ID, 'inside.md', content);
    assert.equal(control.status, 200, `the legal control write was refused: ${control.text}`);
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'inside.md'), 'utf-8'),
      content,
      'the legal control write did not put the submitted content inside the session cwd'
    );
  } finally {
    await fs.rm(traversalTarget, { force: true });
    await fs.rm(absoluteTarget, { force: true });
    await harness.close();
  }
});

test('IR-MDE-001 write path rejects a blocked extension and still accepts the same content on a .md path', async () => {
  const harness = await createWriteHarness({ blockedExtensions: ['.exe', '.dll', '.so', '.bin'] });
  const content = 'the identical content is submitted on both halves of this case\n';

  try {
    const blocked = await harness.write(SESSION_ID, 'payload.exe', content);
    assert.ok(
      blocked.status >= 400,
      `a write to a blocked extension was answered with ${blocked.status} rather than an error: ${blocked.text}`
    );
    assert.equal(
      existsSync(path.join(harness.cwd, 'payload.exe')),
      false,
      'the blocked extension was written to disk'
    );

    // Control: identical content, .md path. resolveAndValidate never inspects
    // the extension, so an implementation that omits the extension stage would
    // pass this half and fail the half above.
    const control = await harness.write(SESSION_ID, 'payload.md', content);
    assert.equal(control.status, 200, `the .md control write was refused: ${control.text}`);
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'payload.md'), 'utf-8'),
      content,
      'the .md control write did not hold the submitted content'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path rejects a blocked path and still accepts a legal control write', async () => {
  const harness = await createWriteHarness({ blockedPaths: ['.ssh', '.gnupg', '.aws'] });
  const content = 'the identical content is submitted on both halves of this case\n';

  try {
    // The directory has to exist first. Without it an unvalidated write fails
    // on a missing directory, and the rejection below would be satisfied by
    // that failure rather than by any blocked-path check.
    await fs.mkdir(path.join(harness.cwd, '.ssh'));

    const blocked = await harness.write(SESSION_ID, '.ssh/notes.md', content);
    assert.ok(
      blocked.status >= 400,
      `a write inside a blocked path was answered with ${blocked.status} rather than an error: ${blocked.text}`
    );
    assert.equal(
      existsSync(path.join(harness.cwd, '.ssh', 'notes.md')),
      false,
      'the write inside the blocked path reached disk'
    );

    const control = await harness.write(SESSION_ID, 'notes.md', content);
    assert.equal(control.status, 200, `the control write outside every blocked path was refused: ${control.text}`);
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'notes.md'), 'utf-8'),
      content,
      'the control write did not hold the submitted content'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path rejects an unknown session ahead of any path resolution', async () => {
  const harness = await createWriteHarness();
  const content = 'a body submitted under a session that does not exist\n';
  const outside = path.dirname(harness.cwd);
  const escapeName = `buildergate-unknown-session-${process.pid}-${Date.now()}.md`;
  const escapeTarget = path.join(outside, escapeName);

  try {
    // The path carried by this request would itself fail path validation, so
    // the answer names which check ran first: the session check produces
    // SESSION_NOT_FOUND, while path resolution would produce PATH_TRAVERSAL.
    const unknown = await harness.write('session-that-does-not-exist', `../${escapeName}`, content);
    assert.equal(
      unknown.status,
      404,
      `the unknown session was answered with ${unknown.status} rather than the 404 the session check produces: ${unknown.text}`
    );
    assert.match(
      unknown.text,
      /SESSION_NOT_FOUND/,
      'the rejection did not come from the session existence check that runs ahead of path resolution'
    );
    assert.equal(existsSync(escapeTarget), false, 'the unknown session write created a file outside the session cwd');
    assert.deepEqual(await fs.readdir(harness.cwd), [], 'the unknown session write left a file inside the session cwd');

    const control = await harness.write(SESSION_ID, 'known-session.md', content);
    assert.equal(control.status, 200, `the write under the session that does exist was refused: ${control.text}`);
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'known-session.md'), 'utf-8'),
      content,
      'the write under the session that does exist did not hold the submitted content'
    );
  } finally {
    await fs.rm(escapeTarget, { force: true });
    await harness.close();
  }
});

// ============================================================================
// Size limits, measured through the assembly the server actually mounts.
// ============================================================================

// Neither the body-parser default (100KB) nor the maxFileSize default (1MB),
// so an assembly that hard-codes either one fails these cases instead of
// matching them by coincidence. Large enough that the transport bound derived
// from it clears the floor, so the cases below measure that derivation.
const ASSEMBLY_MAX_FILE_SIZE = 262144;

// A control character leaves JSON as \u00XX: six bytes carrying one. No input
// expands further, so a document made of these is the widest gap that can
// exist between a file's size and the size of the request carrying it.
const WORST_CASE_ESCAPING_CHARACTER = '\u0001';

interface DeployedAssemblyHarness {
  cwd: string;
  service: FileService;
  writeBody(sessionId: string, body: string): Promise<WriteResponse>;
  write(sessionId: string, filePath: string, content: string): Promise<WriteResponse>;
  read(sessionId: string, filePath: string): Promise<WriteResponse>;
  close(): Promise<void>;
}

/**
 * The pieces index.ts puts around these routes, in the order it puts them: the
 * JSON body parser, then the app error handler, then the routers. A size limit
 * has to be measured through all of them, because the limit a caller meets is
 * the one this assembly enforces rather than the one any single layer names.
 *
 * The order is load-bearing. index.ts registers the error handler at :939 and
 * the routers at :1472, so the handler sits ahead of the routes and only an
 * error raised before it — the body parser's — can reach it. Mounting it after
 * the routes here would let a case pass through a path deployment never takes.
 */
async function createDeployedAssemblyHarness(
  overrides: Partial<FileManagerConfig> = {},
  options: { mountAppErrorHandler?: boolean } = {}
): Promise<DeployedAssemblyHarness> {
  const { cwd, service } = await createServiceOnTempCwd({
    maxFileSize: ASSEMBLY_MAX_FILE_SIZE,
    ...overrides,
  });

  const app = express();
  app.use(createJsonBodyParser(() => service.maxFileSize));
  if (options.mountAppErrorHandler ?? true) {
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (respondIfRequestEntityTooLarge(err, res)) {
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    });
  }
  app.use('/api/sessions', createFileRoutes(service));

  const running = await listenOnEphemeralPort(app);

  return {
    cwd,
    service,
    async writeBody(sessionId: string, body: string): Promise<WriteResponse> {
      return postWriteBody(running.port, sessionId, body);
    },
    async write(sessionId: string, filePath: string, content: string): Promise<WriteResponse> {
      return postWriteBody(running.port, sessionId, JSON.stringify({ path: filePath, content }));
    },
    async read(sessionId: string, filePath: string): Promise<WriteResponse> {
      const response = await fetch(
        `http://127.0.0.1:${running.port}/api/sessions/${encodeURIComponent(sessionId)}` +
          `/files/read?path=${encodeURIComponent(filePath)}`
      );
      return { status: response.status, text: await response.text() };
    },
    async close(): Promise<void> {
      await running.close();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

/** A markdown-shaped document of exactly the requested number of UTF-8 bytes. */
function newlineHeavyDocumentOfExactly(byteLength: number): string {
  // A newline every 60 columns is ordinary for prose, and it is also the shape
  // that expands under JSON escaping in a real document: a newline leaves as
  // two bytes where the letters around it leave as one.
  const columns: string[] = [];
  for (let column = 0; column < byteLength; column += 1) {
    columns.push(column % 60 === 59 ? '\n' : 'a');
  }
  const document = columns.join('');
  assert.equal(
    Buffer.byteLength(document, 'utf-8'),
    byteLength,
    'the constructed document is not the size this case asked for'
  );
  return document;
}

test('IR-MDE-001 write path stores content of exactly maxFileSize and refuses one byte more', async () => {
  const harness = await createDeployedAssemblyHarness();
  const limit = ASSEMBLY_MAX_FILE_SIZE;
  const atLimit = 'a'.repeat(limit);

  try {
    // The read path serves a file whose size equals maxFileSize, so the write
    // path has to accept content of that size. Anything less leaves a document
    // that can be opened and cannot be saved.
    const accepted = await harness.write(SESSION_ID, 'at-limit.md', atLimit);
    assert.equal(
      accepted.status,
      200,
      `content of exactly the ${limit} byte limit was answered with ${accepted.status}: ${accepted.text}`
    );

    const stored = await fs.readFile(path.join(harness.cwd, 'at-limit.md'));
    assert.equal(stored.byteLength, limit, 'the stored file is not the size of the submitted content');
    assert.equal(stored.toString('utf-8'), atLimit, 'the stored file does not hold the submitted content');

    const readBack = await harness.read(SESSION_ID, 'at-limit.md');
    assert.equal(
      readBack.status,
      200,
      `the read path refused the file the write path had just accepted: ${readBack.text}`
    );

    // One byte over. The pair brackets the enforced bound at maxFileSize
    // without reading any constant out of the implementation.
    const rejected = await harness.write(SESSION_ID, 'over-limit.md', 'a'.repeat(limit + 1));
    assert.equal(
      rejected.status,
      413,
      `content of ${limit + 1} bytes, over the ${limit} byte limit, was answered with ${rejected.status}: ${rejected.text}`
    );
    assert.match(
      rejected.text,
      /FILE_TOO_LARGE/,
      'the rejection did not come from the file size check that the read path also applies'
    );
    assert.equal(
      existsSync(path.join(harness.cwd, 'over-limit.md')),
      false,
      'the content that exceeded the limit was written to disk'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path stores a newline-heavy document of exactly maxFileSize', async () => {
  const harness = await createDeployedAssemblyHarness();
  const document = newlineHeavyDocumentOfExactly(ASSEMBLY_MAX_FILE_SIZE);

  try {
    // The serialized request is larger than the document, because every
    // newline leaves as two bytes. A transport bound set to maxFileSize
    // refuses this document while accepting an all-letter one of the same
    // size, which is a limit that depends on what the user typed.
    const body = JSON.stringify({ path: 'newline-heavy.md', content: document });
    assert.ok(
      Buffer.byteLength(body, 'utf-8') > ASSEMBLY_MAX_FILE_SIZE,
      'the constructed request is not larger than the file limit, so this case would not measure escaping'
    );

    const response = await harness.writeBody(SESSION_ID, body);
    assert.equal(
      response.status,
      200,
      `a newline-heavy document of exactly ${ASSEMBLY_MAX_FILE_SIZE} bytes was answered with ${response.status}: ${response.text}`
    );

    const stored = await fs.readFile(path.join(harness.cwd, 'newline-heavy.md'));
    assert.deepEqual(
      Array.from(stored),
      Array.from(Buffer.from(document, 'utf-8')),
      'the stored bytes differ from the submitted document'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path stores content whose JSON escaping expands the most', async () => {
  const harness = await createDeployedAssemblyHarness();
  const document = WORST_CASE_ESCAPING_CHARACTER.repeat(ASSEMBLY_MAX_FILE_SIZE);

  try {
    const body = JSON.stringify({ path: 'worst-case-escaping.md', content: document });
    // Without this the case could pass on a bound that ignores maxFileSize
    // entirely and merely sits above the floor.
    assert.ok(
      Buffer.byteLength(body, 'utf-8') > 1048576,
      'the constructed request is not larger than the floor, so this case would not measure the escaping allowance'
    );

    const response = await harness.writeBody(SESSION_ID, body);
    assert.equal(
      response.status,
      200,
      `a document of ${ASSEMBLY_MAX_FILE_SIZE} bytes carried in a request of ${Buffer.byteLength(body, 'utf-8')} bytes was answered with ${response.status}: ${response.text}`
    );

    const stored = await fs.readFile(path.join(harness.cwd, 'worst-case-escaping.md'));
    assert.deepEqual(
      Array.from(stored),
      Array.from(Buffer.from(document, 'utf-8')),
      'the stored bytes differ from the submitted document'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 write path follows maxFileSize after it is raised at runtime', async () => {
  const harness = await createDeployedAssemblyHarness();
  const raised = 1048576;
  const document = 'a'.repeat(500000);

  try {
    // Over the limit the harness started with, so the refusal here is what the
    // raise below has to overturn.
    const beforeRaise = await harness.write(SESSION_ID, 'raised.md', document);
    assert.equal(
      beforeRaise.status,
      413,
      `content of 500000 bytes, over the starting ${ASSEMBLY_MAX_FILE_SIZE} byte limit, was answered with ${beforeRaise.status}: ${beforeRaise.text}`
    );
    assert.match(
      beforeRaise.text,
      /FILE_TOO_LARGE/,
      'the refusal before the raise did not come from the file size check'
    );

    // fileManager.maxFileSize applies immediately, so this is what a settings
    // change does to a running server. A bound fixed when the parser was built
    // would not move with it.
    harness.service.updateConfig({ ...DEFAULT_FILE_MANAGER_CONFIG, maxFileSize: raised });

    const afterRaise = await harness.write(SESSION_ID, 'raised.md', document);
    assert.equal(
      afterRaise.status,
      200,
      `content of 500000 bytes, under the raised ${raised} byte limit, was answered with ${afterRaise.status}: ${afterRaise.text}`
    );
    assert.equal(
      await fs.readFile(path.join(harness.cwd, 'raised.md'), 'utf-8'),
      document,
      'the file stored after the raise does not hold the submitted content'
    );
    assert.equal(
      (await harness.read(SESSION_ID, 'raised.md')).status,
      200,
      'the read path refused the file the write path accepted under the raised limit'
    );

    // The raise moves the bound; it does not remove it.
    const stillBounded = await harness.write(SESSION_ID, 'past-raised.md', 'a'.repeat(raised + 1));
    assert.equal(
      stillBounded.status,
      413,
      `content of ${raised + 1} bytes, over the raised limit, was answered with ${stillBounded.status}: ${stillBounded.text}`
    );
    assert.equal(
      existsSync(path.join(harness.cwd, 'past-raised.md')),
      false,
      'content over the raised limit was written to disk'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 a request past the transport bound is answered as too large by the app error handler', async () => {
  const harness = await createDeployedAssemblyHarness();
  // Past the escaping allowance as well as past the file limit, so the parser
  // refuses it before the route is given a body.
  const body = JSON.stringify({
    path: 'past-transport.md',
    content: WORST_CASE_ESCAPING_CHARACTER.repeat(300000),
  });

  try {
    const response = await harness.writeBody(SESSION_ID, body);
    assert.equal(
      response.status,
      413,
      `a request of ${Buffer.byteLength(body, 'utf-8')} bytes was answered with ${response.status} rather than reporting the body as too large: ${response.text}`
    );
    // The generic fallback answers 500 and the framework's own last-resort
    // handler answers HTML. Either one means the branch that names an
    // oversized body never ran.
    assert.match(
      response.text,
      /Request body too large/,
      'the oversized request was not answered by the branch that reports an oversized body'
    );
    assert.equal(
      existsSync(path.join(harness.cwd, 'past-transport.md')),
      false,
      'the request past the transport bound was written to disk'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 lowering maxFileSize does not narrow the transport bound below the floor', async () => {
  // The config schema lets maxFileSize go down to 1 KB. Requests that carry no
  // file at all — a settings patch, a workspace layout — share this parser, so
  // a bound derived from maxFileSize alone would take those down with it.
  const harness = await createDeployedAssemblyHarness({ maxFileSize: 1024 });

  try {
    const body = JSON.stringify({ path: 'far-over.md', content: 'a'.repeat(200000) });
    const response = await harness.writeBody(SESSION_ID, body);

    // The file itself is far over its own 1 KB limit, so it is refused either
    // way. Which refusal arrives is the measurement: the file size check can
    // only answer once the parser has handed the route a body.
    assert.equal(response.status, 413, `the oversized file was answered with ${response.status}: ${response.text}`);
    assert.match(
      response.text,
      /FILE_TOO_LARGE/,
      'a 200000 byte request was refused by the parser, so the transport bound followed maxFileSize down instead of holding at the floor'
    );

    const control = await harness.write(SESSION_ID, 'at-small-limit.md', 'a'.repeat(1024));
    assert.equal(control.status, 200, `content of exactly the 1024 byte limit was refused: ${control.text}`);
    assert.equal(
      (await fs.readFile(path.join(harness.cwd, 'at-small-limit.md'))).byteLength,
      1024,
      'the control write did not store the submitted content'
    );
  } finally {
    await harness.close();
  }
});

test('IR-MDE-001 the write route answers an oversized file itself, without the app error handler', async () => {
  // A route's error never reaches that handler: index.ts registers it at :939
  // and the routers at :1472, so an error raised inside a route has no error
  // middleware left ahead of it and falls to the framework's own default. The
  // size refusal therefore has to be a response the route writes, not an error
  // it hands onward, and a harness carrying no handler at all is what shows
  // the difference — one that carried a handler would answer in its place.
  const harness = await createDeployedAssemblyHarness({}, { mountAppErrorHandler: false });
  const limit = ASSEMBLY_MAX_FILE_SIZE;

  try {
    const rejected = await harness.write(SESSION_ID, 'no-handler.md', 'a'.repeat(limit + 1));
    assert.equal(
      rejected.status,
      413,
      `content of ${limit + 1} bytes was answered with ${rejected.status} where no app error handler is mounted: ${rejected.text}`
    );
    assert.match(
      rejected.text,
      /FILE_TOO_LARGE/,
      'the refusal did not carry the file size code, so the route did not answer it'
    );
    // The framework's default handler answers HTML and leaks a stack trace.
    assert.doesNotMatch(
      rejected.text,
      /<!DOCTYPE html>/i,
      'the refusal came from the framework default handler, so the route handed the error onward instead of answering it'
    );
    assert.equal(
      existsSync(path.join(harness.cwd, 'no-handler.md')),
      false,
      'the content that exceeded the limit was written to disk'
    );

    // Control. Without it a route that refused every write would satisfy the
    // rejection above.
    const control = await harness.write(SESSION_ID, 'no-handler-ok.md', 'a'.repeat(limit));
    assert.equal(control.status, 200, `content of exactly the ${limit} byte limit was refused: ${control.text}`);
    assert.equal(
      (await fs.readFile(path.join(harness.cwd, 'no-handler-ok.md'))).byteLength,
      limit,
      'the control write did not store the submitted content'
    );
  } finally {
    await harness.close();
  }
});

// ============================================================================
// What the deployed assembly mounts.
//
// The cases above call the parser and the oversize responder directly, so they
// show those two behave correctly. They cannot show that index.ts still mounts
// them: swapping its parser back for a bare express.json() leaves every one of
// them green while returning the transport bound to the body-parser default.
// The only reader of that fact is the assembly source itself.
// ============================================================================

/**
 * The directory holding `src/index.ts`, found by walking up from `from`.
 *
 * Deliberately not `new URL('../index.ts', import.meta.url)`. Under a dist
 * build this file sits in `dist/services/`, where that path names a .ts file
 * that was never emitted, and the check would then fail for a reason that has
 * nothing to do with what it measures — the trap
 * TerminalAuthorityProductionRegression.test.ts already sits in. Walking up to
 * the directory that owns `src/` reaches the same source from either location,
 * and `from` need not exist for the walk to work.
 */
function findServerRoot(from: string): string | null {
  let directory = from;
  for (;;) {
    if (existsSync(path.join(directory, 'src', 'index.ts'))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

test('IR-MDE-001 the deployed assembly mounts the shared body parser and the shared oversize responder', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = findServerRoot(here);

  // Not finding the source means the check cannot run, which is a different
  // thing from the check passing. Reporting it as success is how a guard like
  // this quietly stops guarding.
  assert.notEqual(
    serverRoot,
    null,
    `could not locate src/index.ts by walking up from ${here}, so the assembly could not be checked`
  );

  // The walk reaches the same source from where a dist build puts this file.
  // dist/ need not exist for this to hold, which is the point: the check does
  // not depend on the layout of the run that happens to be executing it.
  assert.equal(
    findServerRoot(path.join(serverRoot as string, 'dist', 'services')),
    serverRoot,
    'the walk does not reach the same source from a dist-shaped location, so a dist run would check a different file or none'
  );
  // And it reports absence rather than climbing forever or inventing a hit.
  assert.equal(
    findServerRoot(path.parse(here).root),
    null,
    'the walk claimed to find a server root above the filesystem root'
  );

  const assembly = readFileSync(path.join(serverRoot as string, 'src', 'index.ts'), 'utf-8');

  assert.match(
    assembly,
    /app\.use\(createJsonBodyParser\(/,
    'index.ts does not mount the shared body parser, so the transport bound it applies is not the one these cases measure'
  );
  // Catches the bare express.json() that bounds every body at 100KB and the
  // hard-coded express.json({ limit: n }) that a source check looking only for
  // empty parentheses would let through.
  assert.doesNotMatch(
    assembly,
    /app\.use\(\s*express\.json\(/,
    'index.ts mounts a body parser with a limit of its own, so the bound no longer follows maxFileSize'
  );
  assert.match(
    assembly,
    /respondIfRequestEntityTooLarge\(/,
    'the app error handler no longer answers an oversized body, so it falls through to a generic 500'
  );

  // Order, not position. Comparing where the two mounts sit relative to each
  // other survives any amount of code moving in between, which a line number
  // would not.
  //
  // Both names also appear in the import block, so the markers carry the
  // syntax that only the mount has. Searching for the bare names would
  // compare the two imports and hold no matter how the mounts were ordered.
  const parserMount = 'app.use(createJsonBodyParser(';
  const oversizeBranch = 'if (respondIfRequestEntityTooLarge(';
  const parserAt = assembly.indexOf(parserMount);
  const branchAt = assembly.indexOf(oversizeBranch);

  assert.notEqual(parserAt, -1, `index.ts does not contain ${parserMount}, so the order below would compare nothing`);
  assert.notEqual(branchAt, -1, `index.ts does not contain ${oversizeBranch}, so the order below would compare nothing`);
  assert.equal(parserAt, assembly.lastIndexOf(parserMount), 'the body parser is mounted more than once, so which one this checks is ambiguous');
  assert.equal(branchAt, assembly.lastIndexOf(oversizeBranch), 'the oversize branch appears more than once, so which one this checks is ambiguous');

  // The parser has to be registered first. An error handler mounted ahead of
  // it never sees what it raises, and the framework's own default handler
  // answers instead. Measured, because the difference is narrower than it
  // looks: the status stays 413 either way, since that default handler honours
  // the status body-parser puts on the error. What changes is the body — the
  // JSON error the rest of the API returns becomes an HTML error page with a
  // stack trace in it.
  assert.ok(
    parserAt < branchAt,
    'index.ts registers the body parser after the app error handler, so an oversized body is answered by the framework default handler with an HTML page and a stack trace instead of the JSON error'
  );
});

test('IR-MDE-001 the transport bound stays the tight allowance around maxFileSize', () => {
  // The bound guards memory as well as correctness, so it is meant to be the
  // largest request that can carry an acceptable file and no larger. The
  // behavioural cases notice the factor moving in either direction, but
  // nothing notices the envelope headroom drifting upward, because a looser
  // bound refuses nothing. Both constants are pinned here instead.
  assert.equal(
    requestBodyLimitBytes(262144),
    262144 * 6 + 8192,
    'the bound is no longer six times maxFileSize plus the envelope headroom'
  );
  assert.equal(
    requestBodyLimitBytes(1024),
    1048576,
    'the floor no longer holds the bound up at the schema minimum for maxFileSize'
  );

  // Where the two regimes meet: 6n + 8192 = 1048576.
  const crossover = (1048576 - 8192) / 6;
  const belowCrossover = Math.floor(crossover);
  const aboveCrossover = Math.ceil(crossover) + 1;
  assert.equal(
    requestBodyLimitBytes(belowCrossover),
    1048576,
    'the floor no longer wins just below the point where the derived bound overtakes it'
  );
  assert.equal(
    requestBodyLimitBytes(aboveCrossover),
    aboveCrossover * 6 + 8192,
    'the derived bound no longer wins just above the point where it overtakes the floor'
  );
});

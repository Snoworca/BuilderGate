import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function guardedSnapshot({ bytesByPath, failPostForPath } = {}) {
  const events = [];
  const reads = new Map();
  const guards = new Map();
  const fs = {
    readFileSync(absolutePath) {
      const canonical = String(absolutePath).replaceAll('\\', '/');
      events.push(['read', canonical]);
      reads.set(canonical, (reads.get(canonical) ?? 0) + 1);
      const bytes = bytesByPath.get(canonical);
      assert.ok(bytes, `test fixture must define bytes for ${canonical}`);
      return bytes;
    },
  };
  const reparseGuard = {
    assertSafeMany(paths, options) {
      assert.equal(paths.length, 1, 'a protected snapshot read guards one canonical path at a time');
      assert.deepEqual(options, { forceFresh: true });
      const canonical = String(paths[0]).replaceAll('\\', '/');
      events.push(['guard', canonical]);
      const count = (guards.get(canonical) ?? 0) + 1;
      guards.set(canonical, count);
      if (count === 2 && failPostForPath?.(canonical)) {
        throw new Error(`identity changed after read: ${canonical}`);
      }
    },
  };
  return { fs, reparseGuard, events, reads, guards };
}

test('SDS-AC-1 snapshots one canonical protected path through one force-fresh pre/read/post miss and zero-operation hits', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const canonicalPath = 'C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts';
  const bytes = Buffer.from('export const fair = true;\n', 'utf8');
  const fixture = guardedSnapshot({ bytesByPath: new Map([[canonicalPath, bytes]]) });

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  const snapshot = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  const first = snapshot.read({
    absolutePath: 'C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\ws\\WsRouter.ts',
    kind: 'source',
    path: 'server/src/ws/WsRouter.ts',
  });
  const second = snapshot.read({
    absolutePath: canonicalPath,
    kind: 'source',
    path: 'server/src/ws/WsRouter.ts',
  });

  assert.equal(first.sha256, sha256(bytes));
  assert.equal(second.sha256, sha256(bytes));
  assert.deepEqual(first.bytes, bytes);
  assert.deepEqual(second.bytes, bytes);
  assert.notStrictEqual(first.bytes, second.bytes, 'each caller must receive a defensive Buffer copy');
  assert.deepEqual(fixture.events, [
    ['guard', canonicalPath],
    ['read', canonicalPath],
    ['guard', canonicalPath],
  ]);
  assert.equal(fixture.reads.get(canonicalPath), 1);
  assert.equal(fixture.guards.get(canonicalPath), 2);
});

test('SDS-AC-2 discards a post-guard-failed protected read and retries as a complete new miss', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const canonicalPath = 'C:/Work/git/_Snoworca/ProjectMaster/server/config.json5';
  const bytes = Buffer.from('{ "locked": true }\n', 'utf8');
  let failPost = true;
  const fixture = guardedSnapshot({
    bytesByPath: new Map([[canonicalPath, bytes]]),
    failPostForPath: () => failPost,
  });

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  const snapshot = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  const input = { absolutePath: canonicalPath, kind: 'config_lock', path: 'server/config.json5' };

  assert.throws(
    () => snapshot.read(input),
    /identity|changed|reparse|guard/i,
    'a failed post-read identity check must withhold bytes, digest, row, and cache entry',
  );
  assert.equal(fixture.reads.get(canonicalPath), 1);
  assert.equal(fixture.guards.get(canonicalPath), 2);

  failPost = false;
  const recovered = snapshot.read(input);
  const cached = snapshot.read(input);
  assert.equal(recovered.sha256, sha256(bytes));
  assert.equal(cached.sha256, sha256(bytes));
  assert.equal(fixture.reads.get(canonicalPath), 2, 'retry must perform a new byte read rather than reuse failed bytes');
  assert.equal(fixture.guards.get(canonicalPath), 4, 'retry must execute a new force-fresh pre/read/post cycle');
});

test('SDS-AC-3 keeps source, config, and fixture parsing plus manifest rows on private verified snapshot bytes', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const inputs = [
    {
      absolutePath: 'C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts',
      kind: 'source',
      path: 'server/src/ws/WsRouter.ts',
      bytes: Buffer.from('export const scheduler = "fair";\n', 'utf8'),
      parse: value => value.includes('scheduler = "fair"'),
    },
    {
      absolutePath: 'C:/Work/git/_Snoworca/ProjectMaster/server/config.json5',
      kind: 'config_lock',
      path: 'server/config.json5',
      bytes: Buffer.from('{ "policy": "locked" }\n', 'utf8'),
      parse: value => JSON.parse(value).policy === 'locked',
    },
    {
      absolutePath: 'C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json',
      kind: 'fixture',
      path: 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json',
      bytes: Buffer.from('{ "decision": "accept" }\n', 'utf8'),
      parse: value => JSON.parse(value).decision === 'accept',
    },
  ];
  const bytesByPath = new Map(inputs.map(input => [input.absolutePath, input.bytes]));
  const fixture = guardedSnapshot({ bytesByPath });

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  const firstCapture = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  const rows = inputs.map(input => {
    const result = firstCapture.read(input);
    const text = Buffer.from(result.bytes).toString('utf8');
    assert.equal(input.parse(text), true, `${input.kind} parsing must receive snapshot bytes`);
    return { kind: result.kind, path: result.path, sha256: result.sha256 };
  });

  assert.deepEqual(
    rows,
    inputs.map(input => ({ kind: input.kind, path: input.path, sha256: sha256(input.bytes) })),
    'source/config/fixture manifest rows must preserve the digest of their exact parsed snapshot bytes',
  );
  const sourceResult = firstCapture.read(inputs[0]);
  sourceResult.bytes.fill(0);
  const unmodified = firstCapture.read(inputs[0]);
  assert.deepEqual(unmodified.bytes, inputs[0].bytes, 'a consumer cannot mutate the retained snapshot bytes or digest');
  assert.equal(fixture.reads.get(inputs[0].absolutePath), 1);

  const secondCapture = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  const secondCaptureResult = secondCapture.read(inputs[0]);
  assert.deepEqual(secondCaptureResult.bytes, inputs[0].bytes);
  assert.equal(fixture.reads.get(inputs[0].absolutePath), 2, 'a new capture must not inherit another capture\'s cache');
});

test('SDS-AC-3 retains no already-guarded protected-read bypass while ingress consumers move to the snapshot', () => {
  const collectorSource = readFileSync(fileURLToPath(new URL('./fair-readmission-closure-v3.mjs', import.meta.url)), 'utf8');

  assert.equal(
    /\balreadyGuarded\b/.test(collectorSource),
    false,
    'every protected-byte consumer must enter the snapshot or execute its own full force-fresh pre/read/post sequence',
  );
});

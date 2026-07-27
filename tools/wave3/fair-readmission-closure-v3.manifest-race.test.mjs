import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const analysisRoot = path.win32.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);
const firstLeaf = path.win32.join(analysisRoot, 'manifest-race-first.json');
const secondLeaf = path.win32.join(analysisRoot, 'manifest-race-second.json');

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function canonicalPath(value) {
  return path.win32.normalize(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function directoryState(overrides = {}) {
  return {
    dev: 101,
    ino: 202,
    mode: 0o040755,
    ctimeMs: 1_000,
    mtimeMs: 2_000,
    size: 4_096,
    type: 'directory',
    reparse: false,
    ...overrides,
  };
}

function fileState(overrides = {}) {
  return {
    dev: 101,
    ino: 303,
    mode: 0o100644,
    ctimeMs: 3_000,
    mtimeMs: 4_000,
    size: 512,
    type: 'file',
    reparse: false,
    ...overrides,
  };
}

function asStat(state) {
  return {
    dev: state.dev,
    ino: state.ino,
    mode: state.mode,
    ctimeMs: state.ctimeMs,
    mtimeMs: state.mtimeMs,
    size: state.size,
    isDirectory: () => state.type === 'directory',
    isFile: () => state.type === 'file',
    isSymbolicLink: () => state.type === 'link',
    isReparsePoint: () => state.reparse,
  };
}

function missingError(candidate) {
  const error = new Error(`ENOENT: ${candidate}`);
  error.code = 'ENOENT';
  return error;
}

function fakeManifestFs({ leaves = [] } = {}) {
  const states = new Map();
  const defaultDirectory = directoryState();
  const key = candidate => canonicalPath(candidate);
  const directoryKey = key(analysisRoot);
  states.set(directoryKey, directoryState());
  for (const leaf of leaves) states.set(key(leaf), fileState());

  return {
    states,
    readDirectory() {
      return { ...states.get(directoryKey) };
    },
    replaceDirectory(next) {
      states.set(directoryKey, { ...next });
    },
    churnDirectoryForSiblingLeaf() {
      const current = states.get(directoryKey);
      states.set(directoryKey, {
        ...current,
        ctimeMs: current.ctimeMs + 1,
        mtimeMs: current.mtimeMs + 1,
      });
    },
    lstatSync(candidate) {
      const canonical = key(candidate);
      if (states.has(canonical)) return asStat(states.get(canonical));
      if (canonical === key(firstLeaf) || canonical === key(secondLeaf)) throw missingError(candidate);
      return asStat(defaultDirectory);
    },
    mkdirSync() {},
    writeFileSync(candidate, _text, options) {
      assert.equal(options?.flag, 'wx');
      const canonical = key(candidate);
      if (states.has(canonical)) throw new Error(`EEXIST: ${candidate}`);
      states.set(canonical, fileState({ ino: 303 + states.size }));
      this.churnDirectoryForSiblingLeaf();
    },
  };
}

test('SDS-AC-1 tolerates only directory mtime and ctime churn from a sibling manifest leaf', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const fs = fakeManifestFs({ leaves: [firstLeaf] });
  let probeCalls = 0;
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch() {
      probeCalls += 1;
      fs.churnDirectoryForSiblingLeaf();
    },
  });

  assert.doesNotThrow(
    () => guard.assertSafeMany([firstLeaf], { forceFresh: true }),
    'a sibling wx leaf may update only parent directory timestamps during the batch probe',
  );
  assert.equal(probeCalls > 0, true, 'the assertion must exercise the reparse batch frontier');
});

test('SDS-AC-2 rejects directory structural, type, and reparse changes even when timestamp churn is tolerated', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const mutations = [
    ['dev', state => ({ ...state, dev: state.dev + 1 })],
    ['ino', state => ({ ...state, ino: state.ino + 1 })],
    ['mode', state => ({ ...state, mode: state.mode ^ 0o100 })],
    ['type', state => ({ ...state, type: 'file' })],
    ['reparse', state => ({ ...state, reparse: true })],
  ];

  for (const [label, mutate] of mutations) {
    const fs = fakeManifestFs({ leaves: [firstLeaf] });
    const guard = createSegmentReparseGuard({
      fs,
      probeBatch() {
        fs.replaceDirectory(mutate(fs.readDirectory()));
      },
    });

    assert.throws(
      () => guard.assertSafeMany([firstLeaf], { forceFresh: true }),
      /identity|changed|reparse|link|guard/i,
      `${label} replacement must fail closed rather than being treated as benign directory churn`,
    );
  }
});

test('SDS-AC-2 rejects a regular manifest leaf full-identity change', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const fs = fakeManifestFs({ leaves: [firstLeaf] });
  const firstLeafKey = canonicalPath(firstLeaf);
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch() {
      const current = fs.states.get(firstLeafKey);
      fs.states.set(firstLeafKey, { ...current, mtimeMs: current.mtimeMs + 1 });
    },
  });

  assert.throws(
    () => guard.assertSafeMany([firstLeaf], { forceFresh: true }),
    /identity|changed|reparse|guard/i,
    'a file leaf must retain the full identity contract, including timestamps',
  );
});

test('SDS-AC-3 admits interleaved outer manifest captures without serializing benign sibling leaf churn', async () => {
  const { createSegmentReparseGuard, writeCapturedManifest } = await loadCollector();
  const fs = fakeManifestFs();
  let interleavedSiblingCreates = 0;
  const reparseGuard = createSegmentReparseGuard({
    fs,
    probeBatch() {
      interleavedSiblingCreates += 1;
      fs.churnDirectoryForSiblingLeaf();
    },
  });
  const manifest = { schemaVersion: 'manifest-race-test', protectedInput: { sha256: 'a'.repeat(64) } };

  const captures = await Promise.all([
    Promise.resolve().then(() => writeCapturedManifest({
      workspaceRoot,
      manifestPath: firstLeaf,
      manifest,
      fs,
      reparseGuard,
    })),
    Promise.resolve().then(() => writeCapturedManifest({
      workspaceRoot,
      manifestPath: secondLeaf,
      manifest,
      fs,
      reparseGuard,
    })),
  ]);

  assert.deepEqual(captures, [manifest, manifest]);
  assert.equal(interleavedSiblingCreates > 1, true, 'both captures must retain their own active frontier checks');
});

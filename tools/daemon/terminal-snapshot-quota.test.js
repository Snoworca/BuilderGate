const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

class FakeStorage {
  constructor() {
    this.values = new Map();
    this.failNextKey = null;
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failNextKey === key) {
      this.failNextKey = null;
      throw new DOMException('synthetic quota exceeded', 'QuotaExceededError');
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function loadTerminalSnapshotModule() {
  const sourcePath = path.join(ROOT, 'frontend', 'src', 'utils', 'terminalSnapshot.ts');
  const ts = require(path.join(ROOT, 'frontend', 'node_modules', 'typescript'));
  const source = fs.readFileSync(sourcePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    console,
    DOMException,
    localStorage: new FakeStorage(),
    module,
    exports: module.exports,
  };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  return module.exports;
}

function snapshotValue(sessionId, savedAt, content = 'content') {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId,
    content,
    savedAt,
  });
}

test('terminal snapshot eviction removes old snapshots while preserving the current session save', () => {
  const mod = loadTerminalSnapshotModule();
  const storage = new FakeStorage();
  storage.setItem('terminal_snapshot_old-1', snapshotValue('old-1', '2020-01-01T00:00:00.000Z', 'old-1'));
  storage.setItem('terminal_snapshot_old-2', snapshotValue('old-2', '2021-01-01T00:00:00.000Z', 'old-2'));
  storage.setItem('terminal_snapshot_current', snapshotValue('current', '2022-01-01T00:00:00.000Z', 'previous'));

  const nextValue = snapshotValue('current', '2026-04-29T00:00:00.000Z', 'next-current');
  const result = mod.setTerminalSnapshotWithQuotaRecovery('current', nextValue, {
    storage,
    maxTotalChars: 1,
  });

  assert.equal(result.saved, true);
  assert.equal(storage.getItem('terminal_snapshot_current'), nextValue);
  assert.equal(storage.getItem('terminal_snapshot_old-1'), null);
  assert.equal(storage.getItem('terminal_snapshot_old-2'), null);
});

test('terminal snapshot eviction removes corrupt snapshot entries before valid entries', () => {
  const mod = loadTerminalSnapshotModule();
  const storage = new FakeStorage();
  storage.setItem('terminal_snapshot_corrupt', '{not-json');
  storage.setItem('terminal_snapshot_valid', snapshotValue('valid', '2020-01-01T00:00:00.000Z', 'valid'));

  const result = mod.evictTerminalSnapshots({
    storage,
    targetMaxChars: Number.MAX_SAFE_INTEGER,
    minEntriesToRemove: 1,
  });

  assert.equal(result.removedCount, 1);
  assert.equal(result.removedKeys.length, 1);
  assert.equal(result.removedKeys[0], 'terminal_snapshot_corrupt');
  assert.equal(storage.getItem('terminal_snapshot_corrupt'), null);
  assert.notEqual(storage.getItem('terminal_snapshot_valid'), null);
});

test('terminal snapshot save retries once after quota and evicts another session snapshot', () => {
  const mod = loadTerminalSnapshotModule();
  const storage = new FakeStorage();
  storage.setItem('terminal_snapshot_old', snapshotValue('old', '2020-01-01T00:00:00.000Z', 'old'));
  storage.failNextKey = 'terminal_snapshot_current';

  const nextValue = snapshotValue('current', '2026-04-29T00:00:00.000Z', 'current');
  const result = mod.setTerminalSnapshotWithQuotaRecovery('current', nextValue, {
    storage,
    maxTotalChars: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(result.saved, true);
  assert.equal(result.retried, true);
  assert.equal(result.retryEviction.removedCount, 1);
  assert.equal(storage.getItem('terminal_snapshot_old'), null);
  assert.equal(storage.getItem('terminal_snapshot_current'), nextValue);
});

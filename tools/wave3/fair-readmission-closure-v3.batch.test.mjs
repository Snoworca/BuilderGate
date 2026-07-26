import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const batchEnvKey = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_BATCH_PATHS_BASE64';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalPathJson(paths) {
  return JSON.stringify(paths);
}

function decodeBatch(options) {
  return JSON.parse(Buffer.from(options.env[batchEnvKey], 'base64').toString('utf8'));
}

function successRecord(paths) {
  const canonical = canonicalPathJson(paths);
  return `FRRPB1:${paths.length}:${sha256(canonical)}\n`;
}

function recordSpawn(result = options => ({ status: 0, stdout: successRecord(decodeBatch(options)), stderr: '' })) {
  const calls = [];
  return {
    calls,
    spawnSync(executable, argv, options) {
      calls.push({ executable, argv, options });
      const value = typeof result === 'function' ? result(options, calls.length - 1) : result;
      if (value instanceof Error) return { error: value, status: null, stdout: '', stderr: '' };
      return value;
    },
  };
}

function trustedPowerShellFs() {
  return {
    lstatSync(candidate) {
      const isLeaf = path.win32.normalize(candidate) === trustedPowerShell;
      return {
        isFile: () => isLeaf,
        isSymbolicLink: () => false,
        isReparsePoint: () => false,
      };
    },
    realpathSync: {
      native: () => trustedPowerShell,
    },
  };
}

function batchProbeOptions(spawnSync, paths) {
  return {
    paths,
    spawnSync,
    fs: trustedPowerShellFs(),
    platform: 'win32',
  };
}

function assertFixedPowerShellBatchInvocation(call, paths) {
  const canonical = canonicalPathJson(paths);
  const base64 = Buffer.from(canonical, 'utf8').toString('base64');
  const commandIndex = call.argv.indexOf('-EncodedCommand');

  assert.equal(
    call.executable,
    trustedPowerShell,
  );
  assert.equal(commandIndex >= 0, true, 'the fixed PowerShell program must use encoded argv');
  assert.match(call.argv[commandIndex + 1], /^[A-Za-z0-9+/]+={0,2}$/);
  for (const candidate of paths) {
    assert.equal(call.argv.includes(candidate), false, 'a dynamic path must not appear in argv');
    assert.equal(call.argv.includes(Buffer.from(candidate, 'utf8').toString('base64')), false, 'a dynamic path Base64 value must not appear in argv');
  }
  assert.equal(call.argv.includes(base64), false, 'the dynamic canonical JSON must not appear in argv');
  assert.equal(call.options.env[batchEnvKey], base64);
  assert.deepEqual(decodeBatch(call.options), paths, 'the child input must preserve path case and order');
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false, 'the probe must not invoke a shell');
  assert.equal(Number.isFinite(call.options.timeout) && call.options.timeout > 0, true);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'], 'the probe must capture stderr and reject it');

  const encodedProgram = Buffer.from(call.argv[commandIndex + 1], 'base64').toString('utf16le');
  assert.match(encodedProgram, new RegExp(`\\$env:${batchEnvKey}`));
  assert.match(encodedProgram, /\[System\.IO\.File\]::GetAttributes/);
  assert.match(encodedProgram, /\[System\.IO\.FileAttributes\]::ReparsePoint/);
  assert.match(encodedProgram, /FRRPB1/);
}

function childError(message, properties = {}) {
  return Object.assign(new Error(message), properties);
}

function identity(seed) {
  return {
    dev: 1,
    ino: seed,
    mode: 0o100644,
    ctimeMs: 1000 + seed,
    mtimeMs: 2000 + seed,
    size: 3000 + seed,
  };
}

function stat(seed) {
  return {
    ...identity(seed),
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  };
}

function stableFs() {
  const calls = [];
  return {
    calls,
    lstatSync(candidate) {
      calls.push(candidate);
      return stat(1);
    },
  };
}

function expectedSplit(paths, { maxCount = 64, maxBytes = 8 * 1024 } = {}) {
  const batches = [];
  let batch = [];
  for (const candidate of paths) {
    const proposed = [...batch, candidate];
    if (batch.length > 0 && (proposed.length > maxCount || Buffer.byteLength(canonicalPathJson(proposed), 'utf8') > maxBytes)) {
      batches.push(batch);
      batch = [candidate];
      continue;
    }
    batch = proposed;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

test('SDS-AC-1 runs the fixed batch protocol with case-preserving canonical JSON only in Base64 child env', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  const firstPaths = ['C:/Work/closure/Case', 'C:/Work/closure/lower'];
  const secondPaths = ['C:/Work/closure/Other'];
  const first = recordSpawn();
  const second = recordSpawn();

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  assert.doesNotThrow(() => probeWindowsReparsePoints(batchProbeOptions(first.spawnSync, firstPaths)));
  assert.doesNotThrow(() => probeWindowsReparsePoints(batchProbeOptions(second.spawnSync, secondPaths)));
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assertFixedPowerShellBatchInvocation(first.calls[0], firstPaths);
  assertFixedPowerShellBatchInvocation(second.calls[0], secondPaths);
  assert.deepEqual(first.calls[0].argv, second.calls[0].argv, 'the encoded program and argv must stay fixed across batches');
});

test('SDS-AC-1 accepts only the exact LF-terminated FRRPB1 count-and-digest success record', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  const paths = ['C:/Work/closure/exact-one', 'C:/Work/closure/exact-two'];
  const cases = [
    ['missing LF', () => `FRRPB1:2:${sha256(canonicalPathJson(paths))}`],
    ['wrong protocol', () => `FRRPB0:2:${sha256(canonicalPathJson(paths))}\n`],
    ['extra output', () => `${successRecord(paths)}extra\n`],
    ['count mismatch', () => `FRRPB1:1:${sha256(canonicalPathJson(paths))}\n`],
    ['digest mismatch', () => `FRRPB1:2:${'0'.repeat(64)}\n`],
  ];

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  for (const [label, result] of cases) {
    const probe = recordSpawn(result);
    assert.throws(
      () => probeWindowsReparsePoints(batchProbeOptions(probe.spawnSync, paths)),
      /reparse|probe|FRRPB1|fail.closed|PowerShell/i,
      `${label} must fail closed`,
    );
    assert.equal(probe.calls.length, 1);
  }
});

test('SDS-AC-2 fails closed on reparse, nonzero, child error, timeout, or captured stderr', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  const paths = ['C:/Work/closure/failure'];
  const cases = [
    ['reparse point', { status: 1, stdout: '', stderr: 'ReparsePoint\n' }],
    ['nonzero exit', { status: 2, stdout: '', stderr: '' }],
    ['child process error', childError('spawn failure', { code: 'ENOENT' })],
    ['timeout', childError('timed out', { code: 'ETIMEDOUT' })],
    ['stderr', { status: 0, stdout: successRecord(paths), stderr: 'warning\n' }],
  ];

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  for (const [label, result] of cases) {
    const probe = recordSpawn(result);
    assert.throws(
      () => probeWindowsReparsePoints(batchProbeOptions(probe.spawnSync, paths)),
      /reparse|probe|fail.closed|PowerShell|stderr|timeout/i,
      `${label} must fail closed`,
    );
    assert.equal(probe.calls.length, 1);
  }
});

test('SDS-AC-2 invalidates an otherwise safe batch when a pre/post lstat identity changes', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/closure/identity-change';
  const stats = [stat(1), stat(2), stat(2), stat(2)];
  const fs = {
    calls: [],
    lstatSync(pathname) {
      this.calls.push(pathname);
      return stats.shift();
    },
  };
  const batches = [];
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch(paths) {
      batches.push(paths);
    },
  });

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.equal(typeof guard?.assertSafeMany, 'function');
  assert.throws(() => guard.assertSafeMany([candidate]), /identity|changed|reparse|unsafe|fail.closed/i);
  assert.doesNotThrow(() => guard.assertSafeMany([candidate]));
  assert.deepEqual(batches, [[candidate], [candidate]], 'a changed post-probe identity must not be cached as safe');
  assert.equal(fs.calls.length, 4);
});

test('SDS-AC-3 deduplicates a frontier without case folding and forceFresh bypasses only the guard-local cache', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const canonical = 'C:/Work/closure/CaseSensitive/Segment';
  const sameSegmentWithBackslashes = canonical.replaceAll('/', '\\');
  const caseVariant = 'C:/Work/closure/CaseSensitive/segment';
  const fs = stableFs();
  const batches = [];
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch(paths) {
      batches.push(paths);
    },
  });

  assert.equal(typeof guard?.assertSafeMany, 'function');
  guard.assertSafeMany([canonical, sameSegmentWithBackslashes, caseVariant]);
  guard.assertSafeMany([canonical, caseVariant]);
  guard.assertSafeMany([canonical, caseVariant], { forceFresh: true });
  assert.deepEqual(
    batches,
    [[canonical, caseVariant], [canonical, caseVariant]],
    'only exact normalized duplicates may coalesce; casing and discovery order are significant',
  );
  assert.equal(fs.calls.length, 14, 'every frontier check must lstat before and after batching');

  const secondGuard = createSegmentReparseGuard({
    fs: stableFs(),
    probeBatch(paths) {
      batches.push(paths);
    },
  });
  secondGuard.assertSafeMany([canonical]);
  assert.deepEqual(batches.at(-1), [canonical], 'a new public guard must not reuse another capture cache');
});

test('SDS-AC-4 splits by 64 unique segments with stable case-preserving order', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const paths = Array.from({ length: 65 }, (_, index) => `C:/Work/closure/Count/${String(index).padStart(2, '0')}Case`);
  const batches = [];
  const guard = createSegmentReparseGuard({
    fs: stableFs(),
    probeBatch(batch) {
      batches.push(batch);
    },
  });

  guard.assertSafeMany(paths);
  assert.deepEqual(batches, [paths.slice(0, 64), paths.slice(64)]);
  assert.deepEqual(batches.flat(), paths);
});

test('SDS-AC-4 deterministically splits below 64 paths when canonical JSON exceeds 8 KiB', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const paths = Array.from(
    { length: 63 },
    (_, index) => `C:/Work/closure/Bytes/${String(index).padStart(2, '0')}${index % 2 === 0 ? 'Case' : 'case'}-${'x'.repeat(105)}`,
  );
  const expected = expectedSplit(paths);
  const first = [];
  const second = [];
  const firstGuard = createSegmentReparseGuard({ fs: stableFs(), probeBatch: batch => first.push(batch) });
  const secondGuard = createSegmentReparseGuard({ fs: stableFs(), probeBatch: batch => second.push(batch) });

  assert.equal(Buffer.byteLength(canonicalPathJson(paths), 'utf8') > 8 * 1024, true, 'the fixture must exercise the byte split rather than the count split');
  firstGuard.assertSafeMany(paths);
  secondGuard.assertSafeMany(paths);
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected, 'a fresh guard must calculate the same deterministic batches');
  assert.equal(first.every(batch => batch.length <= 64 && Buffer.byteLength(canonicalPathJson(batch), 'utf8') <= 8 * 1024), true);
  assert.deepEqual(first.flat(), paths, 'splitting must preserve aggregate case and discovery order');
});

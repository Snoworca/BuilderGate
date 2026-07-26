import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const closureRoot = 'C:/Work/closure-v3-wave';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function canonicalPath(value) {
  return String(value).replaceAll('\\', '/');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableIdentity(candidate) {
  const seed = [...canonicalPath(candidate)].reduce((total, character) => total + character.codePointAt(0), 0);
  return {
    dev: 1,
    ino: seed,
    mode: 0o100644,
    ctimeMs: 1_000 + seed,
    mtimeMs: 2_000 + seed,
    size: 3_000 + seed,
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  };
}

function windowsFrontier(paths) {
  const frontier = [];
  const seen = new Set();
  for (const candidate of paths) {
    const normalized = canonicalPath(candidate);
    const parsed = path.win32.parse(normalized);
    const segments = path.win32.relative(parsed.root, normalized).split(path.win32.sep).filter(Boolean);
    let current = parsed.root;
    for (const segment of segments) {
      current = path.win32.join(current, segment);
      const value = canonicalPath(current);
      if (seen.has(value)) continue;
      seen.add(value);
      frontier.push(value);
    }
  }
  return frontier;
}

function splitBatches(paths, { maxCount = 64, maxBytes = 8 * 1024 } = {}) {
  const batches = [];
  let batch = [];
  for (const candidate of paths) {
    const proposed = [...batch, candidate];
    if (batch.length > 0 && (proposed.length > maxCount || Buffer.byteLength(JSON.stringify(proposed), 'utf8') > maxBytes)) {
      batches.push(batch);
      batch = [candidate];
      continue;
    }
    batch = proposed;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function request(relativePath, kind = 'source') {
  return {
    absolutePath: `${closureRoot}/${relativePath}`,
    kind,
    path: relativePath,
  };
}

function waveFixture({ bytesByPath, afterGuardFailure } = {}) {
  const events = [];
  const reads = new Map();
  let guardCalls = 0;
  const fs = {
    lstatSync(candidate) {
      return stableIdentity(candidate);
    },
    readFileSync(candidate) {
      const normalized = canonicalPath(candidate);
      events.push(['read', normalized]);
      reads.set(normalized, (reads.get(normalized) ?? 0) + 1);
      const value = bytesByPath.get(normalized);
      if (value instanceof Error) throw value;
      assert.ok(value, `test fixture must define bytes for ${normalized}`);
      return Buffer.from(value);
    },
  };
  return {
    fs,
    events,
    reads,
    probeBatches: [],
    reparseGuard: {
      assertSafeMany(paths, options) {
        guardCalls += 1;
        const normalized = paths.map(canonicalPath);
        events.push(['guard', normalized]);
        assert.deepEqual(options, { forceFresh: true }, 'each wave bracket must bypass only capture-local identity cache');
        const failure = afterGuardFailure?.({ call: guardCalls, paths: normalized });
        if (failure) throw failure;
      },
    },
  };
}

function admittedRows(results) {
  return results.map(result => ({
    kind: result.kind,
    path: result.path,
    sha256: result.sha256,
  }));
}

test('SDS-AC-1 admits a deterministically sorted, deduplicated wave only after one full pre/read/post wave bracket', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const alpha = request('source/alpha.ts');
  const beta = request('source/beta.ts');
  const duplicateAlpha = { ...alpha, absolutePath: alpha.absolutePath.replaceAll('/', '\\') };
  const sortedLeaves = [alpha.absolutePath, beta.absolutePath].map(canonicalPath);
  const bytesByPath = new Map([
    [canonicalPath(alpha.absolutePath), Buffer.from('export const alpha = 1;\n', 'utf8')],
    [canonicalPath(beta.absolutePath), Buffer.from('export const beta = 2;\n', 'utf8')],
  ]);
  const fixture = waveFixture({ bytesByPath });

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  const snapshot = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  assert.equal(typeof snapshot.readWave, 'function', 'the snapshot must expose the wave ingress API');

  const results = snapshot.readWave([beta, duplicateAlpha, alpha]);
  assert.deepEqual(
    admittedRows(results),
    [alpha, beta].map(input => ({ kind: input.kind, path: input.path, sha256: digest(bytesByPath.get(canonicalPath(input.absolutePath))) })),
    'deduplication and publication order must be canonical and deterministic rather than discovery-order dependent',
  );
  assert.deepEqual(
    fixture.events,
    [
      ['guard', sortedLeaves],
      ['read', sortedLeaves[0]],
      ['read', sortedLeaves[1]],
      ['guard', sortedLeaves],
    ],
    'all leaf bytes stay private until the exact same full wave frontier has passed the post-read guard',
  );
  assert.equal(fixture.reads.get(sortedLeaves[0]), 1);
  assert.equal(fixture.reads.get(sortedLeaves[1]), 1);
});

test('SDS-AC-1 and SDS-AC-4 batch every existing ancestor/leaf frontier once per bracket instead of once per path', async () => {
  const { createProtectedInputSnapshot, createSegmentReparseGuard } = await loadCollector();
  const requests = Array.from(
    { length: 65 },
    (_, index) => request(`source/cap/${String(64 - index).padStart(2, '0')}-Case.ts`),
  );
  const sortedLeaves = requests.map(input => canonicalPath(input.absolutePath)).sort();
  const bytesByPath = new Map(sortedLeaves.map((candidate, index) => [candidate, Buffer.from(`export const cap${index} = true;\n`, 'utf8')]));
  const events = [];
  const probeBatches = [];
  const reads = new Map();
  const fs = {
    lstatSync(candidate) {
      return stableIdentity(candidate);
    },
    readFileSync(candidate) {
      const normalized = canonicalPath(candidate);
      events.push(['read', normalized]);
      reads.set(normalized, (reads.get(normalized) ?? 0) + 1);
      return Buffer.from(bytesByPath.get(normalized));
    },
  };
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch(batch) {
      const normalized = batch.map(canonicalPath);
      events.push(['probe', normalized]);
      probeBatches.push(normalized);
    },
  });
  const expectedFrontier = windowsFrontier(sortedLeaves);
  const expectedProbeBatches = splitBatches(expectedFrontier);

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  assert.equal(typeof createSegmentReparseGuard, 'function');
  const snapshot = createProtectedInputSnapshot({ fs, reparseGuard: guard });
  assert.equal(typeof snapshot.readWave, 'function');

  const results = snapshot.readWave([...requests].reverse());
  assert.equal(results.length, sortedLeaves.length);
  assert.deepEqual(
    probeBatches,
    [...expectedProbeBatches, ...expectedProbeBatches],
    'the complete deterministic ancestor/leaf identity vector must be split only by the fixed batch contract before and after all private reads',
  );
  assert.equal(probeBatches.length, expectedProbeBatches.length * 2, 'probe launches must scale with bounded batch chunks, not protected leaves');
  assert.deepEqual(events.slice(expectedProbeBatches.length, expectedProbeBatches.length + sortedLeaves.length), sortedLeaves.map(candidate => ['read', candidate]));
  assert.equal([...reads.values()].every(count => count === 1), true, 'every unique wave leaf must have exactly one private read');
});

test('SDS-AC-2 rejects every failed wave atomically and retries every member without cache, digest, row, parser, or discovery admission', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const first = request('source/first.ts');
  const second = request('source/second.ts');
  const inputs = [first, second];
  const failureCases = [
    ['identity changed', () => new Error('identity changed during post vector')],
    ['reparse member', () => new Error('reparse point discovered during post vector')],
    ['probe protocol', () => new Error('FRRPB1 protocol failure during post vector')],
  ];

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  for (const [label, createFailure] of failureCases) {
    let fail = true;
    const bytesByPath = new Map(inputs.map(input => [canonicalPath(input.absolutePath), Buffer.from(`${label}:${input.path}\n`, 'utf8')]));
    const fixture = waveFixture({
      bytesByPath,
      afterGuardFailure({ call }) {
        return fail && call === 2 ? createFailure() : undefined;
      },
    });
    const snapshot = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
    const parserRows = [];
    const discovered = [];
    const consume = () => snapshot.readWave(inputs).map(result => {
      parserRows.push(result.path);
      discovered.push(request(`discovered/${result.path}.dep.ts`));
      return result;
    });

    assert.throws(consume, /identity|reparse|FRRPB1|protocol|fail/i, `${label} must withhold the entire provisional wave`);
    assert.deepEqual(parserRows, [], `${label} must not release a parser result`);
    assert.deepEqual(discovered, [], `${label} must not enqueue a discovered path`);
    assert.equal(fixture.reads.get(canonicalPath(first.absolutePath)), 1);
    assert.equal(fixture.reads.get(canonicalPath(second.absolutePath)), 1);

    fail = false;
    const recovered = consume();
    assert.equal(recovered.length, 2, `${label} retry must admit only a complete fresh wave`);
    assert.equal(fixture.reads.get(canonicalPath(first.absolutePath)), 2, `${label} must not cache a rejected member`);
    assert.equal(fixture.reads.get(canonicalPath(second.absolutePath)), 2, `${label} must retry every member, not only the reported member`);
  }

  const missingFirst = request('source/missing-first.ts');
  const presentSecond = request('source/present-second.ts');
  const bytesByPath = new Map([
    [canonicalPath(missingFirst.absolutePath), new Error('ENOENT missing wave member')],
    [canonicalPath(presentSecond.absolutePath), Buffer.from('export const present = true;\n', 'utf8')],
  ]);
  const missingFixture = waveFixture({ bytesByPath });
  const missingSnapshot = createProtectedInputSnapshot({ fs: missingFixture.fs, reparseGuard: missingFixture.reparseGuard });
  assert.throws(() => missingSnapshot.readWave([missingFirst, presentSecond]), /ENOENT|missing/i);
  bytesByPath.set(canonicalPath(missingFirst.absolutePath), Buffer.from('export const restored = true;\n', 'utf8'));
  assert.equal(missingSnapshot.readWave([missingFirst, presentSecond]).length, 2);
  assert.equal(missingFixture.reads.get(canonicalPath(missingFirst.absolutePath)), 2, 'a missing member must retry as a new full wave');
  assert.equal(missingFixture.reads.get(canonicalPath(presentSecond.absolutePath)), 2, 'a peer of a missing member must not enter cache before the whole wave admits');
});

test('SDS-AC-3 parses only published wave bytes, schedules discovery for a later wave, and serves cache hits with defensive copies and zero I/O', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const entry = request('source/entry.ts');
  const discovered = request('source/discovered.ts');
  const bytesByPath = new Map([
    [canonicalPath(entry.absolutePath), Buffer.from('import "./discovered";\n', 'utf8')],
    [canonicalPath(discovered.absolutePath), Buffer.from('export const discovered = true;\n', 'utf8')],
  ]);
  const fixture = waveFixture({ bytesByPath });
  const snapshot = createProtectedInputSnapshot({ fs: fixture.fs, reparseGuard: fixture.reparseGuard });
  const parserRows = [];
  const nextWave = [];

  assert.equal(typeof snapshot.readWave, 'function');
  const firstWave = snapshot.readWave([entry]);
  assert.equal(fixture.reads.get(canonicalPath(discovered.absolutePath)) ?? 0, 0, 'a parser-discovered path must not enter the source wave before its producer publishes');
  for (const result of firstWave) {
    parserRows.push(Buffer.from(result.bytes).toString('utf8'));
    nextWave.push(discovered);
  }
  assert.deepEqual(parserRows, ['import "./discovered";\n']);
  assert.deepEqual(nextWave, [discovered], 'admitted parsing must schedule a separate later wave rather than mutate the active frontier');

  const secondWave = snapshot.readWave(nextWave);
  assert.equal(secondWave.length, 1);
  const ioBeforeHit = fixture.events.length;
  const firstHit = snapshot.read(entry);
  firstHit.bytes.fill(0);
  const secondHit = snapshot.read(entry);
  assert.equal(fixture.events.length, ioBeforeHit, 'a canonical cache hit must not probe, stat, or read the filesystem');
  assert.notStrictEqual(firstHit.bytes, secondHit.bytes, 'each hit must return a defensive copy');
  assert.deepEqual(secondHit.bytes, bytesByPath.get(canonicalPath(entry.absolutePath)), 'a caller mutation must not alter retained admitted bytes');
});

test('SDS-AC-4 publishes the deterministic focused regression command and 120-second evidence boundary without nested test-runner flakiness', t => {
  const focusedFiles = [
    'tools/wave3/fair-readmission-closure-v3.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.remediation.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.reparse.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.batch.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.hardening.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.strict.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.ingress.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs',
    'tools/wave3/fair-readmission-closure-v3.wave.test.mjs',
  ];
  const command = `${process.execPath} --test ${focusedFiles.join(' ')}`;

  assert.equal(focusedFiles.length, 9, 'the wave contract extends the existing focused eight-file closure regression');
  assert.equal(focusedFiles.every(file => file.startsWith('tools/wave3/fair-readmission-closure-v3')), true);
  t.diagnostic(`SDS-AC-4 evidence command (must finish <120s): ${command}`);
  t.diagnostic('This contract intentionally does not spawn the full suite from inside node:test; nesting would create duplicate concurrent runs and an unreliable time measurement. Record elapsed wall-clock evidence from the command above in GREEN verification.');
});

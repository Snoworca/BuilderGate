import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const internalCoreUrl = new URL('./internal/fair-readmission-closure-v3-internal-core.mjs', import.meta.url);

async function loadCore() {
  return import(internalCoreUrl);
}

function ticket(opaqueId, byteBudget = 1) {
  return Object.freeze({ opaqueId, byteBudget });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function wavePort({ bytesById, failRead = undefined, failFinish = undefined } = {}) {
  const events = [];
  const reads = new Map();
  let begins = 0;
  return {
    events,
    reads,
    port: {
      beginWave(tickets) {
        const ids = tickets.map(candidate => candidate.opaqueId);
        events.push(['begin', ids]);
        begins += 1;
        return Object.freeze({ begins, ids });
      },
      readTicket(candidate) {
        events.push(['read', candidate.opaqueId]);
        reads.set(candidate.opaqueId, (reads.get(candidate.opaqueId) ?? 0) + 1);
        const failure = failRead?.({ candidate, reads, events });
        if (failure) throw failure;
        return Buffer.from(bytesById.get(candidate.opaqueId));
      },
      finishWave(wave) {
        events.push(['finish', wave.ids]);
        const failure = failFinish?.({ wave, events });
        if (failure) throw failure;
      },
      digestBytes(bytes) {
        events.push(['digest', Buffer.from(bytes).toString('utf8')]);
        return digest(bytes);
      },
    },
  };
}

function parentState(overrides = {}) {
  return {
    role: 'directory',
    dev: 11,
    ino: 22,
    mode: 0o040755,
    ctimeMs: 100,
    mtimeMs: 200,
    ...overrides,
  };
}

function leafState(role = 'missing', overrides = {}) {
  return {
    role,
    ...(role === 'regular' ? {
      dev: 11,
      ino: 33,
      mode: 0o100644,
      ctimeMs: 300,
      mtimeMs: 400,
      size: 512,
    } : {}),
    ...overrides,
  };
}

function allowedManifestState(overrides = {}) {
  return {
    transition: ['ensure-parent', 'preflight', 'exclusive-write', 'postflight'],
    parentBefore: parentState(),
    parentAfter: parentState({ ctimeMs: 101, mtimeMs: 201 }),
    leafBefore: leafState('missing'),
    leafAfter: leafState('regular'),
    ...overrides,
  };
}

test('SDS-AC-1 keeps the opaque core internal and rejects authority-shaped inputs', async () => {
  const collector = await import('./fair-readmission-closure-v3.mjs');
  const core = await loadCore();
  assert.deepEqual(
    Object.keys(core).sort(),
    ['createOpaqueWaveCache', 'evaluateManifestWriteState'],
    'the internal module has exactly the two agreed implementation-only APIs',
  );
  for (const name of ['createOpaqueWaveCache', 'evaluateManifestWriteState']) {
    assert.equal(Object.hasOwn(collector, name), false, `${name} must never become a public collector export`);
  }

  const { port } = wavePort({ bytesById: new Map([['safe', Buffer.from('safe', 'utf8')]]) });
  assert.throws(
    () => core.createOpaqueWaveCache({
      beginWave: port.beginWave,
      readTicket: port.readTicket,
      finishWave: port.finishWave,
      digestBytes: port.digestBytes,
      fs: Object.freeze({}),
    }),
    /opaque|unsupported|authority|filesystem|port/i,
    'the core cannot receive a filesystem or another authority-shaped option',
  );
  const cache = core.createOpaqueWaveCache(port);
  assert.throws(
    () => cache.readWave([{ opaqueId: 'unsafe', byteBudget: 1, absolutePath: 'C:/must-not-enter-core' }]),
    /opaque|ticket|path|unsupported/i,
    'an opaque ticket cannot smuggle a physical path into the core',
  );

  const extraPortKeys = [
    ['events', []],
    ['reads', new Map()],
    ['unexpected', true],
    [Symbol('unexpected-port-key'), true],
  ];
  const acceptedPortKeys = [];
  for (const [key, value] of extraPortKeys) {
    const candidate = { ...port, [key]: value };
    try {
      core.createOpaqueWaveCache(candidate);
      acceptedPortKeys.push(String(key));
    } catch {
      // Expected: the four fixed callbacks are the entire implementation-only port.
    }
  }
  assert.deepEqual(
    acceptedPortKeys,
    [],
    'the opaque core must reject every own port key other than beginWave/readTicket/finishWave/digestBytes',
  );
});

test('SDS-AC-2 deterministically deduplicates opaque tickets and plans fixed 64-ticket or 8-KiB waves', async () => {
  const { createOpaqueWaveCache } = await loadCore();
  const bytesById = new Map([
    ['alpha', Buffer.from('alpha', 'utf8')],
    ['beta', Buffer.from('beta', 'utf8')],
  ]);
  const { port, events } = wavePort({ bytesById });
  const cache = createOpaqueWaveCache(port);
  const results = cache.readWave([ticket('beta', 12), ticket('alpha', 12), ticket('alpha', 12)]);

  assert.deepEqual(results.map(result => result.opaqueId), ['alpha', 'beta'], 'publication order and deduplication use opaque identity only');
  assert.deepEqual(results.map(result => result.sha256), [digest(bytesById.get('alpha')), digest(bytesById.get('beta'))]);
  assert.deepEqual(events, [
    ['begin', ['alpha', 'beta']],
    ['read', 'alpha'],
    ['digest', 'alpha'],
    ['read', 'beta'],
    ['digest', 'beta'],
    ['finish', ['alpha', 'beta']],
  ], 'a complete wave begins once, reads/digests every miss, then finishes before publication');

  const { port: countPort, events: countEvents } = wavePort({
    bytesById: new Map(Array.from({ length: 65 }, (_, index) => [`count-${String(index).padStart(3, '0')}`, Buffer.from(String(index), 'utf8')])),
  });
  createOpaqueWaveCache(countPort).readWave(
    Array.from({ length: 65 }, (_, index) => ticket(`count-${String(64 - index).padStart(3, '0')}`, 1)),
  );
  assert.deepEqual(
    countEvents.filter(([phase]) => phase === 'begin').map(([, ids]) => ids.length),
    [64, 1],
    'a canonical wave splits at the fixed 64-ticket boundary',
  );

  const { port: bytePort, events: byteEvents } = wavePort({
    bytesById: new Map([['byte-a', Buffer.from('a', 'utf8')], ['byte-b', Buffer.from('b', 'utf8')]]),
  });
  createOpaqueWaveCache(bytePort).readWave([ticket('byte-b', 4_097), ticket('byte-a', 4_097)]);
  assert.deepEqual(
    byteEvents.filter(([phase]) => phase === 'begin').map(([, ids]) => ids),
    [['byte-a'], ['byte-b']],
    'a canonical wave splits before opaque-ticket byte budgets exceed 8 KiB',
  );
});

test('SDS-AC-2 publishes no provisional row or cache after read/post failure and retries every miss freshly', async () => {
  const { createOpaqueWaveCache } = await loadCore();
  const entries = new Map([
    ['first', Buffer.from('first', 'utf8')],
    ['second', Buffer.from('second', 'utf8')],
  ]);
  let failRead = true;
  const { port: readPort, events: readEvents, reads: readCounts } = wavePort({
    bytesById: entries,
    failRead({ candidate }) {
      return failRead && candidate.opaqueId === 'second' ? new Error('read failed') : undefined;
    },
  });
  const readCache = createOpaqueWaveCache(readPort);
  assert.throws(() => readCache.readWave([ticket('second'), ticket('first')]), /read failed/);
  assert.deepEqual(readEvents, [
    ['begin', ['first', 'second']],
    ['read', 'first'],
    ['digest', 'first'],
    ['read', 'second'],
  ], 'read failure aborts before finish and exposes no provisional result');
  failRead = false;
  assert.deepEqual(readCache.readWave([ticket('first'), ticket('second')]).map(row => row.opaqueId), ['first', 'second']);
  assert.equal(readCounts.get('first'), 2, 'a failed peer must not enter the cache');
  assert.equal(readCounts.get('second'), 2, 'a failed ticket must be read again by a fresh wave');
  assert.equal(readEvents.filter(([phase]) => phase === 'begin').length, 2, 'retry starts a new wave after read failure');

  let failFinish = true;
  const { port: postPort, reads: postReads } = wavePort({
    bytesById: entries,
    failFinish() {
      return failFinish ? new Error('postflight failed') : undefined;
    },
  });
  const postCache = createOpaqueWaveCache(postPort);
  assert.throws(() => postCache.readWave([ticket('first'), ticket('second')]), /postflight failed/);
  assert.equal(postReads.get('first'), 1);
  assert.equal(postReads.get('second'), 1);
  failFinish = false;
  assert.deepEqual(postCache.readWave([ticket('second'), ticket('first')]).map(row => row.opaqueId), ['first', 'second']);
  assert.equal(postReads.get('first'), 2, 'postflight failure must discard all provisional cache entries');
  assert.equal(postReads.get('second'), 2, 'postflight retry must re-read every miss');
});

test('SDS-AC-2 holds later waves until requested and returns defensive cache copies without port calls', async () => {
  const { createOpaqueWaveCache } = await loadCore();
  const { port, events, reads } = wavePort({
    bytesById: new Map([
      ['entry', Buffer.from('entry bytes', 'utf8')],
      ['later', Buffer.from('later bytes', 'utf8')],
    ]),
  });
  const cache = createOpaqueWaveCache(port);
  const firstWave = cache.readWave([ticket('entry')]);
  assert.deepEqual(events.map(([phase, value]) => [phase, value]), [
    ['begin', ['entry']],
    ['read', 'entry'],
    ['digest', 'entry bytes'],
    ['finish', ['entry']],
  ], 'a later ticket cannot be read before a caller requests its next wave');

  const eventCountBeforeHit = events.length;
  firstWave[0].bytes.fill(0);
  const cached = cache.readWave([ticket('entry')]);
  assert.equal(events.length, eventCountBeforeHit, 'cache hits invoke no begin/read/finish/digest callback');
  assert.deepEqual(cached[0].bytes, Buffer.from('entry bytes', 'utf8'), 'a caller cannot mutate retained cached bytes');
  assert.notStrictEqual(cached[0].bytes, firstWave[0].bytes, 'each result exposes a defensive byte copy');

  assert.deepEqual(cache.readWave([ticket('later')]).map(row => row.opaqueId), ['later']);
  assert.equal(reads.get('later'), 1, 'the later wave receives a distinct fresh transaction');
});

test('SDS-AC-2 discards every earlier 65-ticket and 8-KiB batch row after a later-batch failure', async () => {
  const { createOpaqueWaveCache } = await loadCore();
  const countTickets = Array.from({ length: 65 }, (_, index) => ticket(`count-${String(index).padStart(3, '0')}`, 1));
  const countBytes = new Map(countTickets.map(candidate => [candidate.opaqueId, Buffer.from(candidate.opaqueId, 'utf8')]));
  let failCountPostflight = true;
  const { port: countPort, reads: countReads, events: countEvents } = wavePort({
    bytesById: countBytes,
    failFinish({ wave }) {
      return failCountPostflight && wave.ids.includes('count-064') ? new Error('later 65-ticket postflight failed') : undefined;
    },
  });
  const countCache = createOpaqueWaveCache(countPort);
  assert.throws(
    () => countCache.readWave([...countTickets].reverse()),
    /later 65-ticket postflight failed/,
    'a failure in the second fixed count wave cannot return partial rows',
  );
  failCountPostflight = false;
  assert.equal(countCache.readWave(countTickets).length, 65, 'the complete retry is the first publication');
  assert.deepEqual(
    [...countReads.values()].sort((left, right) => left - right),
    Array.from({ length: 65 }, () => 2),
    'every miss, including the first completed batch, is read again after a later count-batch failure',
  );
  assert.deepEqual(
    countEvents.filter(([phase]) => phase === 'begin').map(([, ids]) => ids.length),
    [64, 1, 64, 1],
    'retry starts fresh 64/1 wave transactions instead of retaining an earlier completed batch',
  );

  const byteTickets = [ticket('byte-first', 4_097), ticket('byte-later', 4_097)];
  let failByteRead = true;
  const { port: bytePort, reads: byteReads, events: byteEvents } = wavePort({
    bytesById: new Map(byteTickets.map(candidate => [candidate.opaqueId, Buffer.from(candidate.opaqueId, 'utf8')])),
    failRead({ candidate }) {
      return failByteRead && candidate.opaqueId === 'byte-later' ? new Error('later 8-KiB read failed') : undefined;
    },
  });
  const byteCache = createOpaqueWaveCache(bytePort);
  assert.throws(
    () => byteCache.readWave([...byteTickets].reverse()),
    /later 8-KiB read failed/,
    'a failure in the second byte-budget wave cannot publish the first row',
  );
  failByteRead = false;
  assert.equal(byteCache.readWave(byteTickets).length, 2, 'the byte-budget retry is the first publication');
  assert.deepEqual([...byteReads.values()].sort((left, right) => left - right), [2, 2]);
  assert.deepEqual(
    byteEvents.filter(([phase]) => phase === 'begin').map(([, ids]) => ids),
    [['byte-first'], ['byte-later'], ['byte-first'], ['byte-later']],
    'the 8-KiB retry re-begins both misses rather than caching the first single-ticket wave',
  );
});

test('SDS-AC-3 evaluates only the exact safe manifest transition and tolerates sibling timestamp churn', async () => {
  const { evaluateManifestWriteState } = await loadCore();
  assert.deepEqual(
    evaluateManifestWriteState(allowedManifestState()),
    {
      allowed: true,
      transition: ['ensure-parent', 'preflight', 'exclusive-write', 'postflight'],
    },
    'only the documented native adapter transition is allowed',
  );

  const rejected = [
    ['out-of-order transition', allowedManifestState({ transition: ['preflight', 'ensure-parent', 'exclusive-write', 'postflight'] })],
    ['directory leaf', allowedManifestState({ leafBefore: leafState('directory') })],
    ['special leaf', allowedManifestState({ leafBefore: leafState('special') })],
    ['link leaf', allowedManifestState({ leafBefore: leafState('link') })],
    ['reparse leaf', allowedManifestState({ leafBefore: leafState('reparse') })],
    ['structural parent replacement', allowedManifestState({ parentAfter: parentState({ ino: 23 }) })],
    ['structural parent role change', allowedManifestState({ parentAfter: parentState({ role: 'regular', mode: 0o100644 }) })],
  ];
  for (const [label, state] of rejected) {
    assert.throws(
      () => evaluateManifestWriteState(state),
      /manifest|role|leaf|parent|identity|transition|reparse|link|special/i,
      `${label} must be rejected before the native adapter probes or writes`,
    );
  }

  const nestedAuthorityStates = [
    ['parent filesystem', allowedManifestState({ parentBefore: parentState({ fs: Object.freeze({}) }) })],
    ['parent path', allowedManifestState({ parentAfter: parentState({ path: 'C:/must-not-enter-core' }) })],
    ['leaf capability', allowedManifestState({ leafBefore: leafState('missing', { capability: Object.freeze({}) }) })],
  ];
  const acceptedNestedAuthorityStates = [];
  for (const [label, state] of nestedAuthorityStates) {
    try {
      evaluateManifestWriteState(state);
      acceptedNestedAuthorityStates.push(label);
    } catch {
      // Expected: nested role records are data-only and have no authority-shaped fields.
    }
  }
  assert.deepEqual(
    acceptedNestedAuthorityStates,
    [],
    'the manifest evaluator must reject nested filesystem, path, and capability-shaped state before acceptance',
  );
});

test('SDS-AC-3 accepts a missing analysis parent only across ensure-parent before preflight', async () => {
  const { evaluateManifestWriteState } = await loadCore();
  assert.deepEqual(
    evaluateManifestWriteState(allowedManifestState({
      parentBefore: { role: 'missing' },
      parentAfter: parentState(),
    })),
    {
      allowed: true,
      transition: ['ensure-parent', 'preflight', 'exclusive-write', 'postflight'],
    },
    'a first capture may create its fixed analysis parent and only then run preflight',
  );
});

test('SDS-AC-3 rejects a post-wx manifest leaf replacement before acceptance', async () => {
  const { evaluateManifestWriteState } = await loadCore();
  const leafWritten = leafState('regular');
  assert.throws(
    () => evaluateManifestWriteState(allowedManifestState({
      leafWritten,
      leafAfter: leafState('regular', { ino: leafWritten.ino + 1 }),
    })),
    /manifest|leaf|identity|replacement|postflight/i,
    'the postflight leaf must retain the identity returned by the exclusive wx write',
  );
});

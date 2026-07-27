import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const fixedFixtureRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function regularStat({ file = false, link = false, reparse = false } = {}) {
  return {
    isFile: () => file,
    isSymbolicLink: () => link,
    isReparsePoint: () => reparse,
  };
}

function fixedPowerShellFs({ reparseLeaf = false } = {}) {
  return {
    lstatSync(candidate) {
      const isLeaf = path.win32.normalize(candidate) === trustedPowerShell;
      return regularStat({ file: isLeaf, reparse: isLeaf && reparseLeaf });
    },
    realpathSync: {
      native: () => trustedPowerShell,
    },
  };
}

function noFilesystemAccess() {
  const calls = [];
  const deny = operation => () => {
    calls.push(operation);
    throw new Error(`unexpected filesystem ${operation}`);
  };
  return {
    calls,
    existsSync: deny('existsSync'),
    statSync: deny('statSync'),
    lstatSync: deny('lstatSync'),
    readFileSync: deny('readFileSync'),
  };
}

test('SDS-AC-1 executes an actual safe C: one-path probe through the strict batch protocol', {
  skip: process.platform !== 'win32',
}, async () => {
  const { probeWindowsReparsePoint } = await loadCollector();

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(
    probeWindowsReparsePoint({ path: 'C:/Windows', platform: 'win32' }),
    false,
    'an existing safe local C: path must complete through the shared batch protocol',
  );
});

test('SDS-AC-1 rejects the legacy injected leaf-only probe fallback before it can claim a path safe', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const fs = {
    lstatSync() {
      throw new Error('legacy fallback must be rejected before lstat');
    },
  };
  let legacyCalls = 0;

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.throws(
    () => createSegmentReparseGuard({
      fs,
      probe() {
        legacyCalls += 1;
        return false;
      },
    }),
    /probeBatch|batch|legacy|unsupported/i,
  );
  assert.equal(legacyCalls, 0, 'a caller-supplied leaf-only probe must never admit a candidate');
});

test('SDS-AC-1 keeps every protected input kind behind native capture ownership', async () => {
  const collector = await loadCollector();
  const protectedKinds = ['source', 'fixture', 'config_lock', 'collector', 'node_runtime'];

  assert.equal(Object.hasOwn(collector, 'createProtectedInputSnapshot'), false, 'callers must not construct a protected snapshot for any input kind');
  for (const kind of protectedKinds) {
    const events = [];
    const bytes = Buffer.from(`${kind} bytes`, 'utf8');
    const reparseGuard = {
      assertSafeMany(paths, options) {
        events.push(['guard', paths, options]);
      },
    };
    const fs = {
      readFileSync(candidate) {
        events.push(['read', candidate]);
        return bytes;
      },
    };

    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath: `${workspaceRoot}/docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3/ingress-${kind}.json`,
        phase: `ingress-${kind}`,
        fs,
        reparseGuard,
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
      `${kind} caller authority must be rejected before a protected digest can be published`,
    );
    assert.deepEqual(events, [], `${kind} caller filesystem and guard seams must remain untouched`);
  }
});

test('SDS-AC-1 rejects staged caller snapshot authority before a protected row can be published', async () => {
  const collector = await loadCollector();
  const protectedKinds = ['source', 'fixture', 'config_lock', 'collector', 'node_runtime'];

  assert.equal(Object.hasOwn(collector, 'createProtectedInputSnapshot'), false);
  for (const kind of protectedKinds) {
    const events = [];
    let guardCalls = 0;
    const reparseGuard = {
      assertSafeMany(paths, options) {
        guardCalls += 1;
        events.push(['guard', paths, options]);
        if (guardCalls === 2) throw new Error('identity changed after protected read');
      },
    };
    const fs = {
      readFileSync(candidate) {
        events.push(['read', candidate]);
        return Buffer.from('staged content', 'utf8');
      },
    };

    assert.throws(
      () => collector.captureFrozenProvenance({
        workspaceRoot,
        manifestPath: `${workspaceRoot}/docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3/ingress-staged-${kind}.json`,
        phase: `ingress-staged-${kind}`,
        fs,
        reparseGuard,
        snapshot: Object.freeze({ readWave() { throw new Error('caller snapshot must not run'); } }),
      }),
      /capture options|native|authority|unsupported|forbid|reject/i,
      `${kind} caller snapshot must be rejected before a protected row can be published`,
    );
    assert.deepEqual(events, [], `${kind} caller guard and filesystem seams must not run`);
  }
});

test('SDS-AC-1 keeps config-lock hashing private while fixture resolution remains frozen-root only', async () => {
  const { captureFrozenProvenance, resolveFixturePath } = await loadCollector();
  const safeValue = 'raw/observed.json';
  const outsideFs = noFilesystemAccess();

  assert.equal(typeof resolveFixturePath, 'function');
  assert.equal(Object.hasOwn(await loadCollector(), 'hashConfigLockFile'), false, 'config-lock hashing must remain private to native capture');
  assert.equal(
    resolveFixturePath({ workspaceRoot, value: safeValue }),
    path.win32.join(workspaceRoot, fixedFixtureRoot, 'raw', 'observed.json'),
    'an in-bound fixture value must keep its exact frozen-root resolution',
  );
  assert.throws(
    () => resolveFixturePath({ workspaceRoot, fixtureRoot: 'docs/analysis/other-fixture', value: safeValue }),
    /fixture|frozen|root|derived/i,
    'a caller must not substitute another otherwise-relative fixture root',
  );
  assert.throws(
    () => captureFrozenProvenance({
      fs: outsideFs,
      workspaceRoot: 'C:/Work/git/_Snoworca/outside-project',
      manifestPath: `${workspaceRoot}/docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3/ingress-outside.json`,
      phase: 'ingress-outside',
    }),
    /capture options|native|authority|unsupported|forbid|reject/i,
    'caller filesystem authority must fail before any protected config operation',
  );
  assert.deepEqual(outsideFs.calls, []);
});

test('SDS-AC-4 rejects superscript COM and LPT device components with suffixes while resolving a normal fixture child', async () => {
  const { resolveFixturePath } = await loadCollector();
  const superscripts = ['¹', '²', '³'];

  assert.equal(typeof resolveFixturePath, 'function');
  assert.equal(
    resolveFixturePath({ workspaceRoot, value: 'raw/ordinary-evidence.json' }),
    path.win32.join(workspaceRoot, fixedFixtureRoot, 'raw', 'ordinary-evidence.json'),
  );
  for (const prefix of ['COM', 'LPT']) {
    for (const suffix of superscripts) {
      const value = `raw/${prefix}${suffix}.evidence.json`;
      assert.throws(
        () => resolveFixturePath({ workspaceRoot, value }),
        /fixture|unsafe|component|device/i,
        `${value} must be rejected before a read or hash`,
      );
    }
  }
});

test('SDS-AC-5 rejects positive bootstrap reparse evidence without treating missing Node metadata as proof of safety', async () => {
  const { resolveTrustedWindowsPowerShell } = await loadCollector();

  assert.equal(typeof resolveTrustedWindowsPowerShell, 'function');
  assert.throws(
    () => resolveTrustedWindowsPowerShell({ fs: fixedPowerShellFs({ reparseLeaf: true }), platform: 'win32' }),
    /PowerShell|trusted|link|reparse|inspect/i,
    'positive reparse evidence must fail before a probe can launch',
  );
});

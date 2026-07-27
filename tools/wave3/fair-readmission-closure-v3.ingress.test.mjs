import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const fixedFixtureRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

test('SDS-AC-2 uses one low-level protected snapshot wave for every protected input kind', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const protectedInputs = [
    ['source', 'server/src/ws/WsRouter.ts', 'C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts'],
    ['fixture', `${fixedFixtureRoot}/fair-scheduler-decision.json`, `C:/Work/git/_Snoworca/ProjectMaster/${fixedFixtureRoot}/fair-scheduler-decision.json`],
    ['config_lock', 'server/config.json5', 'C:/Work/git/_Snoworca/ProjectMaster/server/config.json5'],
    ['collector', 'tools/wave3/fair-readmission-closure-v3.mjs', 'C:/Work/git/_Snoworca/ProjectMaster/tools/wave3/fair-readmission-closure-v3.mjs'],
    ['node_runtime', 'C:/Program Files/nodejs/node.exe', 'C:/Program Files/nodejs/node.exe'],
  ];

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  for (const [kind, rowPath, absolutePath] of protectedInputs) {
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

    const input = createProtectedInputSnapshot({ fs, reparseGuard }).read({ absolutePath, kind, path: rowPath });
    assert.deepEqual(
      { kind: input.kind, path: input.path, sha256: input.sha256 },
      { kind, path: rowPath, sha256: sha256(bytes) },
      `${kind} must return a digest only after its guarded byte read completes`,
    );
    assert.deepEqual(
      events,
      [
        ['guard', [absolutePath], { forceFresh: true }],
        ['read', absolutePath],
        ['guard', [absolutePath], { forceFresh: true }],
      ],
      `${kind} must full-frontier force-fresh guard immediately before and after its read`,
    );
  }
});

test('SDS-AC-2 low-level protected snapshot returns no row when a post-read force-fresh guard detects a staged change', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const protectedInputs = [
    ['source', 'server/src/ws/WsRouter.ts', 'C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts'],
    ['fixture', `${fixedFixtureRoot}/fair-scheduler-decision.json`, `C:/Work/git/_Snoworca/ProjectMaster/${fixedFixtureRoot}/fair-scheduler-decision.json`],
    ['config_lock', 'server/config.json5', 'C:/Work/git/_Snoworca/ProjectMaster/server/config.json5'],
    ['collector', 'tools/wave3/fair-readmission-closure-v3.mjs', 'C:/Work/git/_Snoworca/ProjectMaster/tools/wave3/fair-readmission-closure-v3.mjs'],
    ['node_runtime', 'C:/Program Files/nodejs/node.exe', 'C:/Program Files/nodejs/node.exe'],
  ];

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  for (const [kind, rowPath, absolutePath] of protectedInputs) {
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
      () => createProtectedInputSnapshot({ fs, reparseGuard }).read({ absolutePath, kind, path: rowPath }),
      /identity|changed|reparse|guard/i,
      `${kind} must withhold its digest when the post-read frontier changes`,
    );
    assert.deepEqual(events, [
      ['guard', [absolutePath], { forceFresh: true }],
      ['read', absolutePath],
      ['guard', [absolutePath], { forceFresh: true }],
    ]);
  }
});

test('SDS-AC-3 binds exported fixture and workspace helpers to the derived repository and fixed fixture root before filesystem access', async () => {
  const { hashConfigLockFile, resolveFixturePath } = await loadCollector();
  const safeValue = 'raw/observed.json';
  const outsideFs = noFilesystemAccess();

  assert.equal(typeof resolveFixturePath, 'function');
  assert.equal(typeof hashConfigLockFile, 'function');
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
    () => hashConfigLockFile({
      fs: outsideFs,
      workspaceRoot: 'C:/Work/git/_Snoworca/outside-project',
      relativePath: 'server/config.json5',
    }),
    /admission|native|minted|capabilit|strict|protected/i,
    'an outside workspace must fail before any filesystem operation',
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

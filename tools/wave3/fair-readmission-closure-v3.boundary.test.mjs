import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const analysisRoot = path.win32.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function regularStat(seed = 1, { file = false } = {}) {
  return {
    dev: 1,
    ino: seed,
    mode: file ? 0o100755 : 0o040755,
    ctimeMs: 10_000 + seed,
    mtimeMs: 20_000 + seed,
    size: 30_000 + seed,
    isFile: () => file,
    isSymbolicLink: () => false,
    isReparsePoint: () => false,
  };
}

function trustedPowerShellFs() {
  return {
    lstatSync(candidate) {
      return regularStat(1, { file: path.win32.normalize(candidate) === trustedPowerShell });
    },
    realpathSync: {
      native: () => trustedPowerShell,
    },
  };
}

function batchSuccess(paths) {
  const canonical = JSON.stringify(paths.map(candidate => candidate.replaceAll('\\', '/')));
  return `FRRPB1:${paths.length}:${sha256(canonical)}\n`;
}

test('SDS-AC-1 rejects raw child strings, caps a singleton before launch, and invalidates a failed wave cache', async () => {
  const { createSegmentReparseGuard, probeWindowsReparsePoint, probeWindowsReparsePoints } = await loadCollector();
  const candidate = 'C:/Work/closure/boundary/leaf.json';
  let rawChildCalls = 0;

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.throws(
    () => probeWindowsReparsePoint({
      path: candidate,
      fs: trustedPowerShellFs(),
      platform: 'win32',
      spawnSync() {
        rawChildCalls += 1;
        return batchSuccess([candidate]);
      },
    }),
    /object|child|reparse|probe|fail.closed/i,
    'a raw child string invents missing status/stderr fields and must never be coerced into success',
  );
  assert.equal(rawChildCalls, 1, 'the strict result check belongs after the single injected child call');

  let oversizedLaunches = 0;
  assert.throws(
    () => probeWindowsReparsePoints({
      paths: [`C:/${'a'.repeat(8 * 1024)}`],
      fs: trustedPowerShellFs(),
      platform: 'win32',
      spawnSync() {
        oversizedLaunches += 1;
        throw new Error('an oversized singleton must fail before launch');
      },
    }),
    /count|byte|limit|cap|reparse/i,
    'a singleton above the fixed JSON byte cap must fail before any injected probe',
  );
  assert.equal(oversizedLaunches, 0);

  let present = true;
  let probeCalls = 0;
  const guard = createSegmentReparseGuard({
    fs: {
      lstatSync() {
        if (!present) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        return regularStat();
      },
    },
    probeBatch() {
      probeCalls += 1;
    },
  });
  guard.assertSafe(candidate);
  const token = guard.prepareWave([candidate]);
  present = false;
  assert.throws(
    () => guard.completeWave(token),
    /identity|changed|reparse|wave/i,
    'a disappeared member invalidates the whole token before post-probe admission',
  );
  present = true;
  guard.assertSafe(candidate);
  assert.equal(
    probeCalls,
    3,
    'a failed wave must evict its prior safe cache identity so the next assertion probes again',
  );
});

test('SDS-AC-1 keeps closure ingress private and rejects caller filesystem authority before metadata I/O', async () => {
  const collector = await loadCollector();
  const preflightCalls = [];
  const unguardedFs = {
    existsSync() {
      preflightCalls.push('existsSync');
      throw new Error('unsafe metadata preflight');
    },
    statSync() {
      preflightCalls.push('statSync');
      throw new Error('unsafe metadata preflight');
    },
    lstatSync() {
      preflightCalls.push('lstatSync');
      throw new Error('unguarded lstat path');
    },
    readFileSync() {
      preflightCalls.push('readFileSync');
      throw new Error('unguarded source read');
    },
  };

  assert.equal(Object.hasOwn(collector, 'collectSourceClosure'), false, 'source closure collection must remain behind native capture');
  assert.throws(
    () => collector.captureFrozenProvenance({
      workspaceRoot,
      manifestPath: path.win32.join(analysisRoot, 'boundary-private-ingress.json'),
      phase: 'boundary-private-ingress',
      fs: unguardedFs,
    }),
    /capture options|native|authority|unsupported|forbid|reject/i,
    'native capture must refuse caller filesystem authority before metadata admission',
  );
  assert.deepEqual(
    preflightCalls,
    [],
    'public closure must reject an unguarded call before exists/stat/lstat can select a protected input',
  );
});

test('SDS-AC-2 keeps protected snapshot ownership private while lexical discovery remains explicit', async () => {
  const {
    createProtectedInputSnapshot,
    parseAdmittedImportSpecifiers,
    resolveAdmittedRelativeSpecifier,
  } = await loadCollector();
  assert.equal(Object.hasOwn(await loadCollector(), 'createProtectedInputSnapshot'), false, 'a caller must not mint or read a protected snapshot');
  assert.deepEqual(
    parseAdmittedImportSpecifiers({ sourceText: 'import "./boundary-child.ts";\n', fromPath: 'server/src/boundary-entry.ts' }),
    ['./boundary-child.ts'],
    'collector-owned lexical discovery may schedule a relative dependency without exposing protected bytes',
  );
  assert.equal(typeof resolveAdmittedRelativeSpecifier, 'function');
  assert.equal(
    resolveAdmittedRelativeSpecifier({
      workspaceRoot,
      fromPath: 'server/src/boundary-entry.ts',
      specifier: './boundary-child.ts',
    }),
    'server/src/boundary-child.ts',
  );
  for (const specifier of ['react', '@server/boundary-child', '/outside.ts', '../outside.ts']) {
    assert.throws(
      () => resolveAdmittedRelativeSpecifier({ workspaceRoot, fromPath: 'server/src/boundary-entry.ts', specifier }),
      /relative|alias|package|workspace|unsafe|contained/i,
      `${specifier} must fail rather than fall back to host package or alias resolution`,
    );
  }
});

test('SDS-AC-3 keeps manifest writing private and rejects caller writer or guard authority before admission', async () => {
  const collector = await loadCollector();
  const destination = path.win32.join(analysisRoot, 'boundary-manifest.json');
  const events = [];
  const fs = {
    mkdirSync(candidate, options) {
      events.push(['mkdir', candidate, options]);
    },
    writeFileSync(candidate, text, options) {
      events.push(['write', candidate, text, options]);
    },
  };
  const reparseGuard = {
    assertSafeMany(paths, options) {
      events.push(['guard', paths, options]);
    },
  };

  assert.equal(Object.hasOwn(collector, 'writeCapturedManifest'), false, 'a caller must not inject a manifest writer');
  assert.throws(
    () => collector.captureFrozenProvenance({
      workspaceRoot,
      manifestPath: destination,
      fs: {
        mkdirSync() { events.push(['mkdir']); },
        writeFileSync() {
          events.push(['write']);
        },
      },
      reparseGuard,
      phase: 'boundary-private-writer',
    }),
    /capture options|native|authority|unsupported|forbid|reject/i,
    'caller writer or guard authority must be rejected before native manifest admission',
  );
  assert.deepEqual(events, [], 'rejected caller authority must not reach caller mkdir, write, or guard seams');
});

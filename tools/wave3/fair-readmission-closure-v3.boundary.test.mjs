import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

test('SDS-AC-2 public closure rejects unguarded ingress before metadata I/O and uses only supplied admitted snapshot bytes', async () => {
  const { collectSourceClosure } = await loadCollector();
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

  assert.equal(typeof collectSourceClosure, 'function');
  assert.throws(
    () => collectSourceClosure({
      workspaceRoot,
      sourceRoots: ['server/src/boundary-entry.ts'],
      fs: unguardedFs,
    }),
    /guard|snapshot|strict|reparse|admitted/i,
    'the public closure entrypoint must refuse an absent strict full-frontier guard',
  );
  assert.deepEqual(
    preflightCalls,
    [],
    'public closure must reject an unguarded call before exists/stat/lstat can select a protected input',
  );

  const reads = [];
  const bytesByPath = new Map([
    ['server/src/boundary-entry.ts', 'import "./boundary-child.ts";\n'],
    ['server/src/boundary-child.ts', 'export const child = true;\n'],
    ['server/tsconfig.json', '{ "compilerOptions": {} }\n'],
  ]);
  const strictGuard = {
    prepareWave(paths) {
      return { paths: [...paths] };
    },
    completeWave() {},
    assertSafeMany() {},
  };
  const snapshot = {
    readWave(requests) {
      reads.push(requests.map(request => request.path));
      return requests.map(request => {
        const bytes = bytesByPath.get(request.path);
        assert.ok(bytes, `the admitted fixture must define ${request.path}`);
        return {
          ...request,
          bytes: Buffer.from(bytes, 'utf8'),
          sha256: sha256(bytes),
        };
      });
    },
  };
  const guardedFs = {
    existsSync() {
      throw new Error('existsSync must not run before or alongside admitted snapshot bytes');
    },
    statSync() {
      throw new Error('statSync must not run before or alongside admitted snapshot bytes');
    },
    readFileSync() {
      throw new Error('host source bytes must not be read when a snapshot is supplied');
    },
    lstatSync() {
      throw new Error('the supplied strict guard, not a lstat-only fallback, owns admission');
    },
  };
  const typescript = {
    get sys() {
      throw new Error('ts.sys host fallback is forbidden');
    },
    preProcessFile(sourceText) {
      const specifier = /import\s+["']([^"']+)["']/.exec(sourceText)?.[1];
      return { importedFiles: specifier ? [{ fileName: specifier }] : [] };
    },
    parseJsonConfigFileContent() {
      return { options: {}, errors: [] };
    },
  };

  assert.deepEqual(
    collectSourceClosure({
      workspaceRoot,
      sourceRoots: ['server/src/boundary-entry.ts'],
      fs: guardedFs,
      reparseGuard: strictGuard,
      snapshot,
      typescript,
    }).sourceClosureRows.map(row => row.path).sort(),
    ['server/src/boundary-child.ts', 'server/src/boundary-entry.ts'],
    'relative dependencies must be discovered from previously admitted source bytes and admitted in a later snapshot wave',
  );
  assert.equal(reads.length >= 2, true, 'the relative dependency must enter a later snapshot wave');

  const { resolveAdmittedRelativeSpecifier } = await loadCollector();
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

  const collectorSource = readFileSync(new URL('./fair-readmission-closure-v3.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(collectorSource, /\bts\.sys\b|\bresolveModuleName\b|\bcreateRequire\b/);
});

test('SDS-AC-3 writes a manifest only after fresh parent-and-leaf admission and rejects a failed post-write admission', async () => {
  const { writeCapturedManifest } = await loadCollector();
  const destination = path.win32.join(analysisRoot, 'boundary-manifest.json');
  const manifest = { schemaVersion: 'boundary-test', protectedInput: { sha256: 'a'.repeat(64) } };
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

  assert.equal(typeof writeCapturedManifest, 'function');
  assert.deepEqual(
    writeCapturedManifest({ workspaceRoot, manifestPath: destination, manifest, fs, reparseGuard }),
    manifest,
  );
  assert.deepEqual(
    events,
    [
      ['mkdir', analysisRoot, { recursive: true }],
      ['guard', [analysisRoot, destination], { forceFresh: true }],
      ['write', destination, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' }],
      ['guard', [analysisRoot, destination], { forceFresh: true }],
    ],
    'the writer must create the root, force-fresh validate parent plus leaf around wx, and only then accept output',
  );

  let writeCalls = 0;
  let guardCalls = 0;
  assert.throws(
    () => writeCapturedManifest({
      workspaceRoot,
      manifestPath: destination,
      manifest,
      fs: {
        mkdirSync() {},
        writeFileSync() {
          writeCalls += 1;
        },
      },
      reparseGuard: {
        assertSafeMany(_paths, options) {
          guardCalls += 1;
          assert.deepEqual(options, { forceFresh: true });
          if (guardCalls === 2) throw new Error('manifest destination identity changed after wx');
        },
      },
    }),
    /identity|changed|manifest|reparse|guard/i,
    'a post-write destination change must reject the output rather than return evidence',
  );
  assert.equal(writeCalls, 1, 'the fake writer proves post-write rejection without touching a real external path');
});

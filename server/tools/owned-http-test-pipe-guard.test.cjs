'use strict';
// The B0 listen guard's only self-check lived in `test-owned-http-test-pipe.cjs`,
// which no glob, npm script or workflow collected — the guard had no automatic
// regression surface. This wrapper puts it under `server/tools/*.test.*`, which
// the `test:tools` script in server/package.json collects at concurrency 1.
// It runs the self-check as a child so the self-check keeps substituting
// `net.Server.prototype.listen` in a process of its own, never in this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TOOLS_DIR = __dirname;
const SELF_CHECK = path.join(TOOLS_DIR, 'test-owned-http-test-pipe.cjs');
const GUARD = path.join(TOOLS_DIR, 'require-owned-http-test-pipe.cjs');
// posix carries four clauses win32 does not (owned directory, `.sock` suffix and
// the two directory-shape cases), so the corpus is larger there.
const EXPECTED_REJECTIONS = { linux: 36, darwin: 36, win32: 32 };
const EXPECTED_FORWARDS = 2;

// The child must not inherit an operator's guard log or a `node --test` context.
function childEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  if (!extra || !('BUILDERGATE_B0_GUARD_LOG' in extra)) delete env.BUILDERGATE_B0_GUARD_LOG;
  return env;
}

// Running the self-check under a forced platform is the only way to reach the
// branch of `ownedEndpoint` that this lane does not take. Without it the posix
// lane never evaluates the named-pipe clause and the win32 lane never evaluates
// the owned-directory and `.sock` clauses.
function platformShim(dir, platform) {
  const file = path.join(dir, 'force-platform.cjs');
  writeFileSync(file, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });\n`, 'utf8');
  return file;
}

function runSelfCheck({ platform, guardLog } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'b0-guard-check-'));
  try {
    const args = [];
    if (platform) args.push('--require', platformShim(dir, platform));
    args.push(SELF_CHECK);
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      cwd: TOOLS_DIR,
      env: childEnv(guardLog ? { BUILDERGATE_B0_GUARD_LOG: guardLog } : undefined),
    });
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('B0 listen guard self-check passes with the exact corpus it claims', () => {
  const result = runSelfCheck();
  assert.equal(result.status, 0, `self-check exited ${result.status}: ${result.stderr}`);

  const report = JSON.parse(result.stdout.trim());
  const expected = EXPECTED_REJECTIONS[process.platform];
  assert.ok(expected, `no expected corpus size recorded for platform ${process.platform}`);
  // An inequality would let the cases that cover the anchors and the directory
  // clauses be deleted without the suite noticing, so this is exact.
  assert.equal(report.rejected, expected);
  assert.equal(report.forwardedToCapturedOriginal, EXPECTED_FORWARDS);
  assert.equal(report.openHandles, false, 'the self-check opens no real endpoint');
});

test('the self-check actually drives the guard, counted from the guard own log', () => {
  // Without this the previous test passes against a self-check that prints the
  // right JSON and exercises nothing: the numbers it reports are the child own.
  // The guard writes this log itself, one line per intercepted listen.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'b0-guard-log-'));
  try {
    const logPath = path.join(dir, 'guard-events.log');
    const result = runSelfCheck({ guardLog: logPath });
    assert.equal(result.status, 0, `self-check exited ${result.status}: ${result.stderr}`);

    const events = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const rejects = events.filter((event) => event.event === 'reject-before-tcp-bind');
    const forwards = events.filter((event) => event.event === 'forward-owned-local-listen');
    assert.equal(rejects.length, EXPECTED_REJECTIONS[process.platform]);
    assert.equal(forwards.length, EXPECTED_FORWARDS);
    assert.equal(rejects.length + forwards.length, events.length, 'the guard emits no other event kind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the self-check covers the platform branch this lane does not take', () => {
  const other = process.platform === 'win32' ? 'linux' : 'win32';
  const result = runSelfCheck({ platform: other });
  assert.equal(result.status, 0, `self-check under forced ${other} exited ${result.status}: ${result.stderr}`);

  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.platform, other, 'the shim must actually take effect');
  assert.equal(report.rejected, EXPECTED_REJECTIONS[other]);
  assert.equal(report.forwardedToCapturedOriginal, EXPECTED_FORWARDS);
});

test('B0 listen guard refuses to load a kind that is not a regex literal', () => {
  // The kind set is interpolated into a RegExp. A metacharacter there would
  // silently widen the accepted names, so the guard rejects it at load time.
  // This covers the kind array only; a widening written into the pattern
  // template around it is caught by the corpus cases for non-member kinds.
  const probe = [
    "const fs=require('node:fs');",
    `const src=fs.readFileSync(${JSON.stringify(GUARD)},'utf8');`,
    "const mutated=src.replace(\"['http', 'ws']\", \"['http', 'ws', 'w.']\");",
    "if (mutated === src) { console.error('anchor-missing'); process.exit(2); }",
    "const m=new (require('node:module'))(require('node:path').join(__dirname,'mutant.cjs'));",
    "m.filename=m.id; m.paths=module.paths;",
    "try { m._compile(mutated, m.filename); } catch (error) { console.log(error.code || error.message); process.exit(0); }",
    "console.error('loaded-without-error'); process.exit(3);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: TOOLS_DIR, env: childEnv() });
  assert.equal(result.status, 0, `probe exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^B0_INVALID_OWNED_ENDPOINT_KIND:/);
});

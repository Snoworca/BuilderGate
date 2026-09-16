'use strict';
// The B0 listen guard's only self-check lived in `test-owned-http-test-pipe.cjs`,
// which no glob, npm script or workflow collected — the guard had no automatic
// regression surface. This wrapper puts it inside `server/tools/*.test.*`, which
// the server tools suite does collect. It runs the self-check as a child so the
// self-check keeps substituting `net.Server.prototype.listen` in a process of
// its own, never in this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SELF_CHECK = path.join(__dirname, 'test-owned-http-test-pipe.cjs');

test('B0 listen guard self-check passes and reports only measured fields', () => {
  const result = spawnSync(process.execPath, [SELF_CHECK], { encoding: 'utf8' });
  assert.equal(result.status, 0, `self-check exited ${result.status}: ${result.stderr}`);

  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.platform, process.platform);
  assert.ok(report.rejected > 20, `expected a broad rejection corpus, saw ${report.rejected}`);
  assert.equal(report.forwardedToCapturedOriginal, 2, 'exactly the two owned endpoints are forwarded');
  assert.equal(report.openHandles, false, 'the self-check opens no real endpoint');
});

test('B0 listen guard refuses to load a kind that is not a regex literal', () => {
  // The kind set is interpolated into a RegExp. A metacharacter there would
  // silently widen the accepted names, so the guard rejects it at load time.
  const probe = [
    "const fs=require('node:fs');",
    `const src=fs.readFileSync(${JSON.stringify(path.join(__dirname, 'require-owned-http-test-pipe.cjs'))},'utf8');`,
    "const mutated=src.replace(\"['http', 'ws']\", \"['http', 'ws', 'w.']\");",
    "if (mutated === src) { console.error('anchor-missing'); process.exit(2); }",
    "const m=new (require('node:module'))(require('node:path').join(__dirname,'mutant.cjs'));",
    "m.filename=m.id; m.paths=module.paths;",
    "try { m._compile(mutated, m.filename); } catch (error) { console.log(error.code || error.message); process.exit(0); }",
    "console.error('loaded-without-error'); process.exit(3);",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: __dirname });
  assert.equal(result.status, 0, `probe exited ${result.status}: ${result.stderr}`);
  assert.match(result.stdout.trim(), /^B0_INVALID_OWNED_ENDPOINT_KIND:/);
});

#!/usr/bin/env node
// Mutation battery for the B0 listen guard's test surfaces.
//
// Each mutant plants one defect in a COPY of `require-owned-http-test-pipe.cjs`
// and runs the test surfaces against the copy. A mutant that SURVIVES means the
// surface does not cover that invariant. Nothing here touches the repository:
// every run happens in a fresh temp directory and no socket is ever bound,
// because the self-check substitutes `net.Server.prototype.listen` before the
// guard loads.
//
// Usage:
//   node docs/analysis/2026-09-17.rg06-regression/guard-mutation-battery.mjs \
//     [--self-check <path>] [--wrapper <path>] [--guard <path>]
//
// Defaults point at the committed files under `server/tools/`. Pass an older
// `--self-check` to measure what an earlier corpus did or did not cover. The
// wrapper resolves the self-check by its own fixed basename, so when
// `--self-check` points at a corpus the committed wrapper does not match, pass
// `--wrapper` too — otherwise the wrapper column measures a mismatched pair and
// says so through a killed CONTROL row.

import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a path`);
    process.exit(2);
  }
  return resolve(value);
};
const GUARD = argOf('--guard', join(REPO, 'server/tools/require-owned-http-test-pipe.cjs'));
const SELF_CHECK = argOf('--self-check', join(REPO, 'server/tools/test-owned-http-test-pipe.cjs'));
const WRAPPER = argOf('--wrapper', join(REPO, 'server/tools/owned-http-test-pipe-guard.test.cjs'));

const replaceOnce = (needle, replacement) => (src) => {
  if (!src.includes(needle)) return null;
  return src.replace(needle, replacement);
};

const MUTANTS = [
  ['anchor-start', 'drop the ^ anchor on the name pattern', replaceOnce('`^buildergate-', '`buildergate-')],
  ['anchor-end', 'drop the $ anchor on the name pattern', replaceOnce('[0-9a-f]{12}$`', '[0-9a-f]{12}`')],
  ['kind-open', 'open the kind set to .*', replaceOnce("['http', 'ws']", "['.*']")],
  ['kind-metachar', 'add a metacharacter kind', replaceOnce("['http', 'ws']", "['http', 'ws', 'w.']")],
  ['kind-shrink', 'revert the kind set to http only', replaceOnce("['http', 'ws']", "['http']")],
  ['kind-template-widen', 'widen the alternation in the pattern template, bypassing the kind check',
    replaceOnce("${OWNED_ENDPOINT_KINDS.join('|')})-", "${OWNED_ENDPOINT_KINDS.join('|')}|zz)-")],
  ['pid-separator-optional', 'make the kind/pid separator optional',
    replaceOnce("})-${process.pid}", "})-?${process.pid}")],
  ['pid-any', 'drop the pid binding', replaceOnce('${process.pid}-[0-9a-f]{8}', '[0-9]+-[0-9a-f]{8}')],
  ['uuid-any', 'relax the uuid shape to .+',
    replaceOnce('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '.+')],
  ['kind-validation-removed', 'delete the load-time kind literal check',
    (src) => {
      const start = src.indexOf('for (const kind of OWNED_ENDPOINT_KINDS)');
      if (start === -1) return null;
      const end = src.indexOf('\n}\n', start);
      if (end === -1) return null;
      return src.slice(0, start) + src.slice(end + 3);
    }],
  ['dir-exact-to-prefix', 'accept any directory whose path starts with tmpdir',
    replaceOnce('path.dirname(value) === path.resolve(os.tmpdir())',
      'path.dirname(value).startsWith(path.resolve(os.tmpdir()))')],
  ['dir-dropped', 'drop the owned-directory clause',
    replaceOnce('path.dirname(value) === path.resolve(os.tmpdir())', 'true')],
  ['suffix-dropped', 'drop the .sock suffix clause', replaceOnce("value.endsWith('.sock')", 'true')],
  ['suffix-split-first-dot', 'strip from the first dot instead of a fixed five characters',
    replaceOnce('path.basename(value).slice(0, -5)', "path.basename(value).split('.')[0]")],
  // EQUIVALENT: on the posix branch `dirname(value) === resolve(tmpdir())` can
  // only hold for an absolute path, and the win32 branch never evaluates this
  // clause. The mutant changes no observable behaviour, so surviving it is not
  // a coverage gap. The clause is kept as defence in depth.
  ['absolute-dropped', 'drop the isAbsolute clause', replaceOnce('path.isAbsolute(value)', 'true'), true],
  ['win32-prefix-dropped', 'drop the named-pipe prefix clause',
    replaceOnce("return value.startsWith(prefix) && namePattern.test(value.slice(prefix.length));",
      'return namePattern.test(value.slice(prefix.length));')],
  ['win32-allow-all', 'accept everything on the win32 branch',
    replaceOnce("return value.startsWith(prefix) && namePattern.test(value.slice(prefix.length));",
      'return true;')],
  ['posix-allow-all', 'accept every string on the posix branch',
    replaceOnce('return path.isAbsolute(value)', 'return true || path.isAbsolute(value)')],
  ['string-check-dropped', 'accept non-string first arguments',
    replaceOnce("if (typeof value !== 'string') return false;", "if (typeof value !== 'string') return true;")],
  ['guard-disabled', 'forward every listen call', replaceOnce('if (!allowed) {', 'if (false) {')],
  ['error-code-changed', 'change the thrown error code',
    replaceOnce("error.code = 'B0_FORBIDDEN_TCP_LISTEN';", "error.code = 'B0_SOMETHING_ELSE';")],
  // The four below attack the `allowed` expression rather than the predicate.
  // A corpus built on one subject class or on arity-one calls alone is blind to
  // them, which is why the self-check carries an http.Server subject and a
  // zero-argument call.
  ['subject-class-escape', 'allow any subject that is not a bare net.Server',
    replaceOnce('const allowed = ownedEndpoint(args[0]);',
      'const allowed = ownedEndpoint(args[0]) || this.constructor !== net.Server;')],
  ['zero-arity-escape', 'allow a listen() call with no arguments',
    replaceOnce('const allowed = ownedEndpoint(args[0]);',
      'const allowed = args.length === 0 || ownedEndpoint(args[0]);')],
  ['env-backdoor', 'allow everything when an environment variable is absent',
    replaceOnce('const allowed = ownedEndpoint(args[0]);',
      "const allowed = ownedEndpoint(args[0]) || !process.env.BUILDERGATE_B0_STRICT;")],
  ['later-argument-escape', 'allow when any later argument opts out',
    replaceOnce('const allowed = ownedEndpoint(args[0]);',
      'const allowed = ownedEndpoint(args[0]) || args.some((a) => a && a.allowTcp === true);')],
  ['https-subject-escape', 'allow any https.Server subject',
    replaceOnce('const allowed = ownedEndpoint(args[0]);',
      "const allowed = ownedEndpoint(args[0]) || this instanceof require('node:https').Server;")],
  // The two below corrupt the guard's own event log rather than its decision.
  // The log is what proves the self-check drove the guard, so a log that records
  // every call identically would make that proof vacuous.
  ['log-first-field-nulled', 'record every intercepted value as null',
    replaceOnce("first: typeof args[0] === 'number' || typeof args[0] === 'string' ? args[0] : null,",
      'first: null,')],
  ['log-firsttype-const', 'record every intercepted argument as a string',
    replaceOnce('firstType: typeof args[0],', "firstType: 'string',")],
];

// A `node --test` child that inherits NODE_TEST_CONTEXT hits node's recursion
// guard, runs zero files and exits 0 — which would report every mutant as
// SURVIVED on a wrapper column that never ran. Strip it, and refuse to report a
// wrapper verdict at all if the child produced no test output.
function childEnv() {
  const env = { ...process.env, BUILDERGATE_B0_GUARD_LOG: undefined };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_')) delete env[key];
  }
  return env;
}

function runSurfaces(dir) {
  const selfCheck = spawnSync(process.execPath, [join(dir, basename(SELF_CHECK))],
    { encoding: 'utf8', cwd: dir, env: childEnv() });
  const wrapper = spawnSync(process.execPath, ['--test', join(dir, basename(WRAPPER))],
    { encoding: 'utf8', cwd: dir, env: childEnv() });
  // A `# tests 1` line can come from a file with no `test()` calls at all, so the
  // detector also requires a test name the wrapper owns.
  const out = wrapper.stdout || '';
  const ranTests = /^(?:#|ℹ) tests [1-9]\d*$/m.test(out) && out.includes('B0 listen guard');
  if (!ranTests) {
    const error = new Error('the wrapper child ran no tests of its own; its column would be vacuous');
    error.code = 'B0_BATTERY_VACUOUS_WRAPPER';
    throw error;
  }
  return { selfCheck: selfCheck.status === 0, wrapper: wrapper.status === 0 };
}

// The temp directory is created and torn down inside one try/finally so a
// failure while staging cannot leak it.
function withStagedGuard(guardSource, body) {
  const dir = mkdtempSync(join(tmpdir(), 'b0-mutation-'));
  try {
    writeFileSync(join(dir, basename(GUARD)), guardSource, 'utf8');
    copyFileSync(SELF_CHECK, join(dir, basename(SELF_CHECK)));
    copyFileSync(WRAPPER, join(dir, basename(WRAPPER)));
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A vacuous wrapper column is a bad invocation, not a survivor: exit 2. The
// throw keeps the staging try/finally in charge of the temp directory.
process.on('uncaughtException', (error) => {
  if (error && error.code === 'B0_BATTERY_VACUOUS_WRAPPER') {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
});

const guardSource = readFileSync(GUARD, 'utf8');
console.log('# B0 guard mutation battery');
console.log(`# generated_at    ${new Date().toISOString()}`);
console.log(`# node            ${process.version}  platform=${process.platform}`);
console.log(`# guard           ${GUARD.slice(REPO.length + 1)}`);
console.log(`# self_check      ${SELF_CHECK.startsWith(REPO) ? SELF_CHECK.slice(REPO.length + 1) : SELF_CHECK}`);
console.log(`# wrapper         ${WRAPPER.startsWith(REPO) ? WRAPPER.slice(REPO.length + 1) : WRAPPER}`);
console.log('#');
console.log('# killed   = the surface failed, so it covers this invariant');
console.log('# SURVIVED = the surface passed against a defective guard, so it does NOT');
console.log('# n/a      = the surface could not run at all against this mutant');
console.log('# equivalent mutants change no observable behaviour; surviving them is expected');
console.log('#');
console.log(`# ${'mutant'.padEnd(26)} ${'self-check'.padEnd(10)} ${'wrapper'.padEnd(10)} description`);

let survivors = 0;
let anchorFailures = 0;
for (const [id, description, apply, equivalent] of MUTANTS) {
  const mutated = apply(guardSource);
  if (mutated === null || mutated === guardSource) {
    anchorFailures += 1;
    console.log(`  ${id.padEnd(26)} ${'ANCHOR-MISSING'.padEnd(10)} ${''.padEnd(10)} ${description}`);
    continue;
  }
  const { selfCheck, wrapper } = withStagedGuard(mutated, runSurfaces);
  if (selfCheck && wrapper && !equivalent) survivors += 1;
  const suffix = equivalent ? ` [equivalent] ${description}` : ` ${description}`;
  console.log(`  ${id.padEnd(26)} ${(selfCheck ? 'SURVIVED' : 'killed').padEnd(10)} ${(wrapper ? 'SURVIVED' : 'killed').padEnd(10)}${suffix}`);
}

const control = withStagedGuard(guardSource, runSurfaces);
console.log(`  ${'CONTROL (unmutated)'.padEnd(26)} ${(control.selfCheck ? 'SURVIVED' : 'killed').padEnd(10)} ${(control.wrapper ? 'SURVIVED' : 'killed').padEnd(10)} both surfaces must SURVIVE here`);
console.log('#');
console.log(`# mutants=${MUTANTS.length} anchor_missing=${anchorFailures} non_equivalent_survived_on_both_surfaces=${survivors}`);
console.log('# a mutant killed on one surface and surviving on the other is covered: the two');
console.log('# surfaces are complementary, the wrapper reaching what the self-check cannot.');
console.log(`# control_self_check=${control.selfCheck ? 'SURVIVED' : 'killed'} control_wrapper=${control.wrapper ? 'SURVIVED' : 'killed'}`);

// Exit 0 = PASS, 1 = a mutant or the control needs review, 2 = the script could
// not run (bad arguments). A consumer reading only $? can tell the three apart.
const ok = control.selfCheck && control.wrapper && anchorFailures === 0 && survivors === 0;
console.log(`# result=${ok ? 'PASS' : 'REVIEW'}`);
console.log('# exit 0=PASS  1=REVIEW  2=bad invocation');
process.exit(ok ? 0 : 1);

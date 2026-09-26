// FR-BGSTAB-021 — the clipboard verifying surface must stay connected.
//
// Both clipboard unit test files were green and neither ran: they were absent
// from tsconfig.test.json's `files` allowlist (so `npm run typecheck:tests`
// never saw them) and named by no npm script. Twelve passing tests that nothing
// invokes are indistinguishable from twelve tests that do not exist.
//
// What this guard does NOT establish, stated here because the omission is
// silent: it only runs when something runs it, and the only executor today is
// the very `test:unit:clipboard` script it validates. `tsconfig.test.json` is
// deliberately absent from tsconfig.json's `references` (see the comment at the
// top of that file), so `tsc -b` does not compile these files either, and the
// release workflow invokes only `build:*` scripts. Deleting `test:unit:clipboard`
// outright therefore still reddens nothing. Closing that requires a CI change
// with repo-wide blast radius and is not in this requirement's scope.
//
// The enumeration reads the directory rather than a fixed list, so a newly added
// clipboard unit test is wired or this fails. Its bound is `tests/unit`: a
// clipboard test placed elsewhere is not seen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const UNIT_DIR = `${FRONTEND_ROOT}tests/unit`;

// The repo's tsconfigs carry `//` line comments, `/* */` block comments and
// trailing commas. Stripping only line comments parsed tsconfig.test.json (which
// happens to have none of the others) and threw on tsconfig.app.json.
const readJsonc = (relativePath: string): unknown => JSON.parse(
  readFileSync(`${FRONTEND_ROOT}${relativePath}`, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1'),
);

// Both sides of every comparison go through this. The tsconfig clause used to
// strip a leading "./" while the script clause did not, so a script written as
// `--test ./tests/unit/x.test.ts` -- a perfectly valid node --test argument --
// went red with correct wiring.
const normalisePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');

// Case-insensitive, and .tsx as well as .ts: a file named clipboardPaste.test.ts
// or TerminalClipboard.test.tsx is exactly as disconnectable as the two known
// suites, and a guard that cannot see it reports a clean result over a subset.
const clipboardTestFiles = readdirSync(UNIT_DIR)
  .filter(name => /clipboard/i.test(name) && /\.test\.tsx?$/.test(name))
  .sort();

test('FR-BGSTAB-021: the clipboard unit tests are discoverable at all', () => {
  // Without this the two assertions below are vacuously true over an empty list,
  // which is the same shape of empty-set pass the guard exists to prevent.
  assert.ok(
    clipboardTestFiles.length >= 2,
    `expected the clipboard unit tests to be present, found ${JSON.stringify(clipboardTestFiles)}`,
  );
  assert.ok(
    clipboardTestFiles.includes('terminalClipboardCoordinator.test.ts')
    && clipboardTestFiles.includes('terminalClipboardAdapterContract.test.ts'),
    `expected both clipboard suites, found ${JSON.stringify(clipboardTestFiles)}`,
  );
});

test('FR-BGSTAB-021: every clipboard unit test is in the tsconfig.test.json program', () => {
  const files = (readJsonc('tsconfig.test.json') as { files?: unknown }).files;
  assert.ok(Array.isArray(files), 'tsconfig.test.json must declare a "files" allowlist');
  // Entries are written with and without a leading "./" in this file, and a path
  // separator difference must not read as a missing entry.
  const declared = new Set((files as string[]).map(normalisePath));

  const missing = clipboardTestFiles.filter(name => !declared.has(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    'clipboard unit tests absent from tsconfig.test.json "files" are never typechecked: '
    + `${JSON.stringify(missing)}`,
  );
});

test('FR-BGSTAB-021: test:unit:clipboard runs every clipboard unit test as a runner argument', () => {
  const scripts = (readJsonc('package.json') as { scripts?: Record<string, string> }).scripts ?? {};
  const script = scripts['test:unit:clipboard'];
  assert.equal(
    typeof script,
    'string',
    'package.json must define test:unit:clipboard; frontend unit suites run only from explicit scripts',
  );

  // Substring matching would accept `echo tests/unit/foo.test.ts`, which names
  // every file and runs none. Tokenise and require an actual test-runner
  // invocation with each file as its own argument.
  const tokens = script.split(/\s+/).filter(Boolean);

  // Scanned on the RAW string, not on whitespace-separated tokens. Tokenising on
  // /\s+/ cannot see `||true`, `;true`, or a newline-separated compound, and all
  // three run the suite and then exit 0 on a red one -- connected and inert,
  // which is this requirement's original defect wearing a different hat.
  // Scanned OUTSIDE quoted regions. A bare character-class scan over the whole
  // string false-reds two legitimate wirings -- `--test-name-pattern='copy|paste'`
  // and any path containing `&` -- and a maintainer meeting that red is tempted
  // to weaken the clause rather than quote correctly.
  const unquoted = script.replace(/'[^']*'|"[^"]*"/g, '');
  const shellControl = unquoted.match(/[;&|\n\r$`!]/g) ?? [];
  assert.deepEqual(
    shellControl,
    [],
    'test:unit:clipboard must be a single command that propagates the runner exit code; '
    + `these shell control characters can discard or invert it: ${JSON.stringify(shellControl)} in ${script}`,
  );
  // What this clause does NOT cover, stated here rather than left implicit.
  // Widening the character class cannot reach either of these:
  //   - npm `pre`/`post` hooks wrap this script without appearing in its text, so
  //     scanning the script string is structurally unable to see them. (npm does
  //     skip `post` and propagate when the main script fails, so this is a limit
  //     of the approach rather than a known hole.)
  //   - any exit-code discard expressible without [;&|$`!] or a newline.
  // The class has already grown once: it began as whitespace-separated tokens,
  // which missed `||true`, `;true` and a newline compound.

  // The runner must lead its command, after a known prefix set. Accepting a
  // runner token at ANY position let `echo node --test <paths>` satisfy every
  // clause while running nothing -- the round-2 evasion, one token longer.
  const RUNNER_PREFIXES = /^(npx|cross-env|[A-Z_][A-Z0-9_]*=.*)$/;
  const command = [...tokens];
  while (command.length > 0 && RUNNER_PREFIXES.test(command[0]!)) {
    command.shift();
  }
  assert.ok(
    command.length > 0 && /(^|\/)node(\.exe)?$/.test(command[0]!),
    'test:unit:clipboard must lead with the node test runner after any npx, cross-env or '
    + `VAR= prefix, got: ${script}`,
  );
  assert.ok(
    command.includes('--test'),
    `test:unit:clipboard must pass --test to the runner, got: ${script}`,
  );

  const args = new Set(tokens.map(normalisePath));

  const missing = clipboardTestFiles.filter(name => !args.has(`tests/unit/${name}`));
  assert.deepEqual(
    missing,
    [],
    `clipboard unit tests absent from test:unit:clipboard are run by nothing: ${JSON.stringify(missing)}`,
  );
});

test('FR-BGSTAB-021: the tsconfig.test.json program still type-checks strictly', () => {
  // Membership is not the whole property. Leaving the files in `files[]` while
  // relaxing the compiler options keeps `typecheck:tests` at exit 0 and silently
  // stops it catching anything -- the program would still contain these files and
  // would no longer be a check.
  const testConfig = readJsonc('tsconfig.test.json') as {
    extends?: string;
    compilerOptions?: Record<string, unknown>;
  };
  assert.equal(
    testConfig.extends,
    './tsconfig.app.json',
    'tsconfig.test.json must inherit the app compiler options rather than redefine them',
  );

  const appOptions = (readJsonc('tsconfig.app.json') as {
    compilerOptions?: Record<string, unknown>;
  }).compilerOptions ?? {};
  assert.equal(appOptions.strict, true, 'tsconfig.app.json must keep strict: true');

  // An override in the derived config wins over the base, so absence is the
  // requirement here, not merely a true value in the base.
  const overrides = testConfig.compilerOptions ?? {};
  for (const option of ['strict', 'noImplicitAny', 'strictNullChecks'] as const) {
    assert.ok(
      !(option in overrides) || overrides[option] === true,
      `tsconfig.test.json must not relax ${option}; got ${JSON.stringify(overrides[option])}`,
    );
  }
});

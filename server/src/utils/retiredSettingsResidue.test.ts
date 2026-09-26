import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as constants from './constants.js';

// @req FR-BGSTAB-025
//
// The removal of the thirteen unused configuration leaves is already guarded at the
// schema, template, runtime-store and settings-service boundaries. What none of those
// guards cover is the gap the survey left open: a shipped surface that reaches the same
// key by string path (a .mjs/.cjs tool script re-parsing config.json5, a README example an
// operator copies, or a defaults constant that outlived its schema block). This file scans
// the shipped surfaces directly so residue cannot creep back in through a non-schema path.
//
// It shells out to `git ls-files` against the checkout three levels above this module, so it
// needs that checkout to exist at that relative position. That holds for both src/ and the
// compiled dist/ copy (dist/utils/ is the same three levels down), but not for a packaged or
// relocated runtime where the repository tree is absent.

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const RETIRED_LEAF_PATHS = [
  'logging.level', 'logging.audit', 'logging.directory', 'logging.maxSize', 'logging.maxFiles',
  'bruteForce.rateLimit.windowMs', 'bruteForce.rateLimit.maxRequests',
  'bruteForce.lockout.maxAttempts', 'bruteForce.lockout.lockoutDurationMs', 'bruteForce.lockout.progressiveDelay',
  'auth.maxDurationMs', 'fileManager.maxCodeFileSize', 'resourceLimits.telemetry.sampleIntervalMs',
] as const;

// Leaf names unique enough that any occurrence in a shipped surface is a config reference.
// `maxAttempts` is deliberately excluded: it is a common retry-loop name with unrelated
// live uses, and its config path is covered by the dotted-path scan below.
const RETIRED_LEAF_TOKENS = [
  'bruteForce', 'lockoutDurationMs', 'progressiveDelay',
  'maxDurationMs', 'maxCodeFileSize', 'sampleIntervalMs',
] as const;

// The retired defaults constants were UPPER_SNAKE, so the camelCase tokens above never saw
// them — the very threat class named in the header went unscanned. These are the members of
// the deleted RATE_LIMIT_DEFAULTS / LOGGING_DEFAULTS blocks that have no live namesake today
// (verified by sweeping the scanned set). WINDOW_MS, MAX_REQUESTS and MAX_ATTEMPTS are left
// out for the same reason `maxAttempts` is: they are ordinary rate-limit vocabulary with
// unrelated live uses (BOOTSTRAP_RATE_LIMIT_WINDOW_MS, RECONNECT_MAX_ATTEMPTS, ...), and the
// distinctive members below already anchor both families.
const RETIRED_CONSTANT_TOKENS = [
  'LOG_LEVEL', 'LOG_DIRECTORY', 'MAX_LOG_SIZE', 'MAX_LOG_FILES',
  'LOCKOUT_DURATION_MS', 'PROGRESSIVE_DELAY', 'AUTO_BLACKLIST_THRESHOLD',
  'MAX_DURATION_MS', 'MAX_CODE_FILE_SIZE', 'SAMPLE_INTERVAL_MS',
] as const;

// The five logging.* leaves are `level`, `audit`, `directory`, `maxSize` and `maxFiles` —
// all far too generic to scan for on their own, which left the whole family with no anchor:
// re-adding it as a nested object literal (`logging: z.object({ level, audit })`) matched
// nothing above. The family name only carries meaning in object-key position, so the needle
// requires a following colon. That deliberately ignores `logging` used as a string *value*
// (server/tools/test-exclusive-runtime-port.cjs passes it as a scenario name), which is how
// the pattern stays narrow instead of the allowlist growing.
//
// The colon may be preceded by a TypeScript optional (`?`) or definite-assignment (`!`)
// marker. Requiring the colon to sit immediately after the name let the dominant idiom of
// server/src/types/config.types.ts — `logging?: { level: string; audit: boolean }` — declare
// the whole retired family unseen, so the marker is matched explicitly.
const RETIRED_KEY_PATTERNS = [
  { label: 'logging (object key)', pattern: /(?<![A-Za-z0-9_$])(?:logging|'logging'|"logging")\s*[?!]?\s*:/ },
] as const;

/**
 * The one shipped surface that must name a retired key: AC-2 requires an explicit migration
 * that strips resourceLimits.telemetry.sampleIntervalMs from existing configuration files.
 *
 * Allowlisting "this file may say sampleIntervalMs" would also wave through the key being
 * reinstated as a live schema field in the same file — the single most likely place that
 * would happen. So the exception is pinned to the two shapes that make up the migration:
 * the presence probe, and the destructure that discards the key into a throwaway binding.
 * Any other mention is an offence, and a missing shape means the AC-2 migration was dropped.
 *
 * The shapes deliberately match only what distinguishes stripping from reinstating, not the
 * exact formatting of the two lines. Pinning the literal single-line source (including the
 * local binding name `_retired`) meant that reformatting the destructure across several
 * lines — a zero-behaviour prettier-style refactor — turned this release gate red. What
 * carries the meaning is `sampleIntervalMs` flowing into an underscore-prefixed discard
 * binding; a reinstated live field (`sampleIntervalMs: countLimit(...)`) still matches
 * neither shape and is still reported. Each shape must stay within one line.
 *
 * The counts are asserted as "at least one" rather than "exactly one": a second occurrence
 * of a discard destructure would still be migration code, so the exact number is not
 * load-bearing, while zero still means the migration is gone.
 */
const MIGRATION_FILE = 'server/src/schemas/config.schema.ts';
const MIGRATION_LINE_SHAPES = [
  /Object\.hasOwn\(\s*value\s*,\s*'sampleIntervalMs'\s*\)/,
  /sampleIntervalMs\s*:\s*_[A-Za-z0-9_]*/,
] as const;

/**
 * Surfaces that ship to an operator or run in production, named once and used twice: to build
 * the `git ls-files` pathspec, and to assert that every root actually contributed a file.
 *
 * A single numeric floor cannot carry that second job. Measured 2026-09-16 against this
 * checkout, the sweep lists 381 files, of which frontend/src holds 216 and server/src 114 —
 * so dropping either root trips any sensible floor, while dropping server/tools (→372),
 * tools (→345), README.md / server/config.json5.example / dev.js / stop.js (→380 each) or
 * *.bat (→379) leaves the sweep looking healthy. That is not hypothetical: with `tools`
 * removed from the pathspec, an injected tools/*.mjs reading fileManager.maxCodeFileSize
 * passed both tests (measured 2026-09-16). Per-root coverage closes that, and names the root
 * that vanished instead of reporting a number that moved slightly.
 *
 * `matches` restates each root's shape so the coverage check can attribute a listed path
 * without re-invoking git; it is the only place the two halves may drift, and a drift there
 * fails loudly (the root reports zero files) rather than silently.
 *
 * SCOPE LIMIT: deleting a whole entry from this list still removes that root from the sweep
 * without any test failing — the list is the contract, and dropping an entry is a visible
 * edit to it. What the coverage check catches is the silent drift: a mistyped spec, a root
 * renamed on disk, or an exclusion pathspec that swallows a root. Measured 2026-09-16, a
 * single-character typo (`tools` → `toolz`) turns this test red naming `toolz`, where before
 * it stayed green.
 */
const SHIPPED_SURFACE_ROOTS = [
  { spec: 'server/src', matches: (file: string) => file.startsWith('server/src/') },
  { spec: 'server/tools', matches: (file: string) => file.startsWith('server/tools/') },
  { spec: 'frontend/src', matches: (file: string) => file.startsWith('frontend/src/') },
  { spec: 'tools', matches: (file: string) => file.startsWith('tools/') },
  { spec: 'README.md', matches: (file: string) => file === 'README.md' },
  { spec: 'server/config.json5.example', matches: (file: string) => file === 'server/config.json5.example' },
  { spec: 'dev.js', matches: (file: string) => file === 'dev.js' },
  { spec: 'stop.js', matches: (file: string) => file === 'stop.js' },
  { spec: '*.bat', matches: (file: string) => /^[^/]+\.bat$/.test(file) },
] as const;

/**
 * Test files are excluded because the retirement guards must keep naming the retired keys to
 * assert their absence.
 *
 * `--others --exclude-standard` is listed alongside `--cached` because a residue introduced
 * by a new, not-yet-staged tool script is invisible to the index — which is exactly the
 * moment this guard should object. `--exclude-standard` applies .gitignore, so node_modules
 * and build output stay out.
 */
const SHIPPED_SURFACE_EXCLUSIONS = [
  ':!server/src/test-runner.ts',
  ':!**/*.test.ts', ':!**/*.test.tsx', ':!**/*.test.mjs', ':!**/*.test.cjs', ':!**/*.test.js',
  ':!frontend/src/editor/**',
] as const;

function shippedSurfaceFiles(): string[] {
  const tracked = execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
    ...SHIPPED_SURFACE_ROOTS.map((root) => root.spec),
    ...SHIPPED_SURFACE_EXCLUSIONS,
  ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return [...new Set(tracked.split('\0').filter((entry) => entry.length > 0))];
}

// The floor stays as a second, coarser net: it catches a `git ls-files` that returns nothing
// at all, or an exclusion pathspec that swallows most of the tree — failures that leave every
// root at zero or near it. It is set well below the measured 381 so ordinary growth and
// deletion do not trip it.
const MEASURED_SHIPPED_SURFACE_COUNT = 381; // 2026-09-16
const MINIMUM_SHIPPED_SURFACE_COUNT = 300;

test('FR-BGSTAB-025 no shipped surface references a retired configuration path', () => {
  const files = shippedSurfaceFiles();

  const emptyRoots = SHIPPED_SURFACE_ROOTS
    .filter((root) => !files.some((file) => root.matches(file)))
    .map((root) => root.spec);
  assert.deepEqual(emptyRoots, [],
    'a shipped-surface root contributed no file — the pathspec entry was mistyped, dropped, or '
    + 'swallowed by an exclusion, and everything under that root went unscanned');

  assert.equal(files.length >= MINIMUM_SHIPPED_SURFACE_COUNT, true,
    `the shipped-surface sweep collapsed: ${files.length} files listed, floor is `
    + `${MINIMUM_SHIPPED_SURFACE_COUNT} (${MEASURED_SHIPPED_SURFACE_COUNT} measured 2026-09-16)`);

  const offences: string[] = [];
  // `--cached --others` lists paths from the index, so a file deleted in the working tree but
  // not yet staged appears here and cannot be read. That is an ordinary mid-refactor state and
  // a deleted file carries no residue, so such paths are skipped rather than failed. The real
  // concern behind the old hard assertion — a silently collapsed sweep — is carried by the
  // file-count floor above, which a collapse trips and a handful of deletions does not.
  const migrationHits = MIGRATION_LINE_SHAPES.map(() => 0);

  for (const relativePath of files) {
    const absolute = resolve(REPO_ROOT, relativePath);
    if (!existsSync(absolute)) {
      continue;
    }
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const needle of [...RETIRED_LEAF_PATHS, ...RETIRED_LEAF_TOKENS, ...RETIRED_CONSTANT_TOKENS]) {
        if (!line.includes(needle)) continue;
        if (relativePath === MIGRATION_FILE && needle === 'sampleIntervalMs') {
          const shapeIndex = MIGRATION_LINE_SHAPES.findIndex((shape) => shape.test(line));
          if (shapeIndex >= 0) {
            migrationHits[shapeIndex] += 1;
            continue;
          }
        }
        offences.push(`${relativePath}:${index + 1}: ${needle}`);
      }
      for (const { label, pattern } of RETIRED_KEY_PATTERNS) {
        if (pattern.test(line)) offences.push(`${relativePath}:${index + 1}: ${label}`);
      }
    });
  }

  // Asserted before the offences: if a migration shape stops matching, every sampleIntervalMs
  // line in the migration file becomes an "offence" and the offences assertion would accuse
  // the very migration code this exception exists to protect, never naming the real cause.
  migrationHits.forEach((hits, index) => {
    assert.equal(hits >= 1, true,
      `the AC-2 sampleIntervalMs migration shape ${MIGRATION_LINE_SHAPES[index]} no longer matches `
      + `any line of ${MIGRATION_FILE} — the migration was dropped, or it was reformatted past the shape`);
  });
  assert.deepEqual(offences, [], 'retired configuration keys must not survive on a shipped surface');
});

/**
 * The deleted blocks mirrored logging.* and bruteForce.* one-for-one. With the schema blocks
 * retired they have no consumer, and leaving them reads as "the feature is configured
 * somewhere else" — the exact impression the removal was meant to end.
 *
 * Asserting the two old export names are absent only restates the deletion: reinstating the
 * same block under a new name would pass. So the members are checked instead. Two members of
 * one retired family in a single constant object is the signature; one is not, because names
 * like MAX_ATTEMPTS and WINDOW_MS have unrelated live uses.
 *
 * KNOWN SCOPE LIMIT — do not over-trust this check. It imports one module, `./constants.js`,
 * so the member-shape signature is only detected there. The text sweep in the first test is
 * what covers every other shipped file, and three of the bruteForce members below —
 * WINDOW_MS, MAX_REQUESTS and MAX_ATTEMPTS — are deliberately absent from its needle list
 * because live namesakes exist (BOOTSTRAP_RATE_LIMIT_WINDOW_MS, RECONNECT_MAX_ATTEMPTS, ...)
 * and scanning for them would produce false alarms on a release gate. Consequence, measured
 * 2026-09-16: a NEW module (e.g. server/src/utils/bruteForceDefaults.ts) exporting exactly
 * `{ WINDOW_MS, MAX_REQUESTS, MAX_ATTEMPTS }` passes both tests. The distinctive members
 * (LOCKOUT_DURATION_MS, PROGRESSIVE_DELAY, AUTO_BLACKLIST_THRESHOLD, and the whole logging
 * family) are caught anywhere by the text sweep, so a faithful reinstatement of either block
 * is still reported; only that three-name subset escapes.
 */
const RETIRED_CONSTANT_MEMBERS: Record<string, readonly string[]> = {
  'logging.*': ['LOG_LEVEL', 'LOG_DIRECTORY', 'MAX_LOG_SIZE', 'MAX_LOG_FILES'],
  'bruteForce.*': [
    'WINDOW_MS', 'MAX_REQUESTS', 'LOCKOUT_DURATION_MS', 'MAX_ATTEMPTS',
    'PROGRESSIVE_DELAY_BASE_MS', 'PROGRESSIVE_DELAY_MAX_MS', 'AUTO_BLACKLIST_THRESHOLD',
  ],
};

test('FR-BGSTAB-025 defaults constants for the retired logging and bruteForce blocks are gone', () => {
  const exported = Object.keys(constants);
  assert.equal(exported.includes('RATE_LIMIT_DEFAULTS'), false,
    'RATE_LIMIT_DEFAULTS mirrored the retired bruteForce block and has no consumer');
  assert.equal(exported.includes('LOGGING_DEFAULTS'), false,
    'LOGGING_DEFAULTS mirrored the retired logging block and has no consumer');

  const offences: string[] = [];
  for (const [exportName, value] of Object.entries(constants as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const members = new Set(Object.keys(value as Record<string, unknown>));
    for (const [family, retiredMembers] of Object.entries(RETIRED_CONSTANT_MEMBERS)) {
      const present = retiredMembers.filter((member) => members.has(member));
      if (present.length >= 2) {
        offences.push(`${exportName} reinstates ${family}: ${present.join(', ')}`);
      }
    }
  }

  assert.deepEqual(offences, [],
    'no exported constant object may carry the member shape of a retired configuration block');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
// It reads repository sources, so it must run against src/ (`npx tsx --test src/...`);
// dist/ carries no .ts sources and no repository tree.

const REPO_ROOT = resolve(new URL('../../../', import.meta.url).pathname);

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

/**
 * The one shipped surface that must name a retired key: AC-2 requires an explicit migration
 * that strips resourceLimits.telemetry.sampleIntervalMs from existing configuration files.
 * Allowlisting the mechanism keeps the guard from forbidding the removal it enforces.
 */
const ALLOWED_REFERENCES = new Set<string>([
  'server/src/schemas/config.schema.ts: sampleIntervalMs',
]);

/**
 * Surfaces that ship to an operator or run in production. Test files are excluded because
 * the retirement guards must keep naming the retired keys to assert their absence.
 */
function shippedSurfaceFiles(): string[] {
  const tracked = execFileSync('git', [
    'ls-files', '-z', '--',
    'server/src', 'frontend/src', 'tools', 'README.md',
    'server/config.json5.example', 'dev.js',
    ':!server/src/test-runner.ts',
    ':!**/*.test.ts', ':!**/*.test.tsx', ':!**/*.test.mjs', ':!**/*.test.cjs', ':!**/*.test.js',
    ':!frontend/src/editor/**',
  ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return tracked.split('\0').filter((entry) => entry.length > 0);
}

test('FR-BGSTAB-025 no shipped surface references a retired configuration path', () => {
  const files = shippedSurfaceFiles();
  assert.equal(files.length > 100, true, 'the shipped-surface file set must not be empty or collapsed');

  const offences: string[] = [];
  for (const relativePath of files) {
    const absolute = resolve(REPO_ROOT, relativePath);
    if (!existsSync(absolute)) continue;
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const needle of [...RETIRED_LEAF_PATHS, ...RETIRED_LEAF_TOKENS]) {
        if (!line.includes(needle)) continue;
        if (ALLOWED_REFERENCES.has(`${relativePath}: ${needle}`)) continue;
        offences.push(`${relativePath}:${index + 1}: ${needle}`);
      }
    });
  }

  assert.deepEqual(offences, [], 'retired configuration keys must not survive on a shipped surface');
});

test('FR-BGSTAB-025 defaults constants for the retired logging and bruteForce blocks are gone', () => {
  // These two blocks mirrored logging.* and bruteForce.* one-for-one. With the schema blocks
  // retired they have no consumer, and leaving them reads as "the feature is configured
  // somewhere else" — the exact impression the removal was meant to end.
  const exported = Object.keys(constants);
  assert.equal(exported.includes('RATE_LIMIT_DEFAULTS'), false,
    'RATE_LIMIT_DEFAULTS mirrored the retired bruteForce block and has no consumer');
  assert.equal(exported.includes('LOGGING_DEFAULTS'), false,
    'LOGGING_DEFAULTS mirrored the retired logging block and has no consumer');
});

/**
 * OPS-BGSTAB-017 — find `import.meta.url` reads that do not survive CJS bundling.
 *
 * The packaged build runs the server sources through esbuild with
 * `format: 'cjs'`. CJS has no `import.meta`, so esbuild substitutes an empty
 * object and `fileURLToPath(import.meta.url)` becomes `fileURLToPath(undefined)`,
 * which throws. esbuild emits a warning and the build still succeeds, so the
 * defect never shows up until someone runs the executable — and until
 * OPS-BGSTAB-017 nothing did.
 *
 * The working shape is already used in three places (`SSLService.ts`,
 * `utils/config.ts`, `SessionManager.ts`):
 *
 *     const MODULE_DIR = typeof __dirname === 'string'
 *       ? __dirname
 *       : dirname(fileURLToPath(import.meta.url));
 *
 * It is correct under both module systems: in real ESM `__dirname` is not
 * defined, so the ternary falls through to `import.meta.url`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** How many lines above the read may carry the guard. The shape above spans 3. */
const GUARD_LOOKBEHIND_LINES = 2;

const GUARD_PATTERN = /typeof\s+__(?:dirname|filename)\s*===?\s*['"]string['"]/;

/**
 * Blank out comments while preserving every line break.
 *
 * Without this the scanner reads its own prose. That is not hypothetical: a
 * guard written in this repository on 2026-09-20 counted a call named in an
 * explanatory comment as a call site, and the resulting red sent a lane off to
 * fix a contract violation that did not exist. Line count is preserved so the
 * reported line numbers still point at the source.
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  let state = 'code';
  let quote = '';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block-comment';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        state = 'string';
        quote = char;
        out += char;
        index += 1;
        continue;
      }
      out += char;
      index += 1;
      continue;
    }

    if (state === 'string') {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) {
        state = 'code';
        quote = '';
      }
      index += 1;
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }

    // block-comment
    if (char === '*' && next === '/') {
      state = 'code';
      out += '  ';
      index += 2;
      continue;
    }
    out += char === '\n' ? '\n' : ' ';
    index += 1;
  }

  return out;
}

/** Every `.ts` file under `rootDir` that is not a test. */
export function collectBundledSources(rootDir) {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      found.push(full);
    }
  };

  if (!statSync(rootDir).isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }
  walk(rootDir);
  return found;
}

/**
 * Unguarded `import.meta.url` reads, as `{ file, line, text }`.
 *
 * `file` is relative to `rootDir` so the message reads the same on every host.
 */
export function findUnguardedImportMetaSites(rootDir) {
  const violations = [];

  for (const file of collectBundledSources(rootDir)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes('import.meta.url')) continue;

      const from = Math.max(0, index - GUARD_LOOKBEHIND_LINES);
      const window = lines.slice(from, index + 1).join('\n');
      if (GUARD_PATTERN.test(window)) continue;

      violations.push({
        file: relative(rootDir, file).split(sep).join('/'),
        line: index + 1,
        text: lines[index].trim(),
      });
    }
  }

  return violations;
}

export function formatViolations(violations) {
  return violations
    .map((violation) => `  ${violation.file}:${violation.line}  ${violation.text}`)
    .join('\n');
}

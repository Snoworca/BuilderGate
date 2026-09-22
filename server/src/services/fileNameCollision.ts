import path from 'node:path';

/**
 * Names a copy when the name it wants is taken (FR-FOP-004 AC-1, AC-2).
 *
 * The suffix starts at two because the original is the first. It goes before
 * the extension so the result still opens in whatever opened the original —
 * `report.md (2)` opens in nothing.
 *
 * Nothing here reads a directory. The caller passes a predicate, which is what
 * lets the job that owns the real destination decide what "taken" means: a
 * listing it already has, a stat, or a set it is building as it copies.
 */

/** Matches a name that already carries a suffix, so copies of copies count on. */
const EXISTING_SUFFIX = /^(.*?) \((\d+)\)$/;

/**
 * Splits a name into the part the suffix attaches to and the extension.
 *
 * `path.extname` reads only the last extension, so `archive.tar.gz` keeps
 * `archive.tar` as its stem. A dotfile has no extension at all — `.gitignore`
 * is one name rather than an empty name with a `.gitignore` extension — and
 * `path.parse` already answers that way.
 */
function split(name: string): { stem: string; ext: string } {
  const { name: stem, ext } = path.parse(name);
  return { stem, ext };
}

export function resolveNameCollision(
  name: string,
  isTaken: (candidate: string) => boolean,
): string {
  if (!isTaken(name)) return name;

  const { stem, ext } = split(name);

  // A name that already ends in ` (n)` continues from n rather than nesting a
  // second suffix inside the first.
  const carried = EXISTING_SUFFIX.exec(stem);
  const base = carried ? carried[1] : stem;
  let counter = carried ? Number(carried[2]) + 1 : 2;

  let candidate = `${base} (${counter})${ext}`;
  while (isTaken(candidate)) {
    counter += 1;
    candidate = `${base} (${counter})${ext}`;
  }

  return candidate;
}

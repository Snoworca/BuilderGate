/**
 * Names a copy when the name it wants is taken (FR-FOP-004 AC-1, AC-2).
 *
 * The suffix starts at two because the original is the first. It goes before
 * the extension so the result still opens in whatever opened the original —
 * `report.md (2)` opens in nothing.
 *
 * The argument is one path segment, not a path. Splitting a path here dropped
 * the directory, so the same argument came back as a whole path when the name
 * was free and as a bare name when it was taken — one input, two shapes,
 * decided by the predicate. Callers split the path and pass the leaf.
 *
 * Nothing here reads a directory. The caller passes a predicate, which is what
 * lets the job that owns the real destination decide what "taken" means: a
 * listing it already has, a stat, or a set it is building as it copies.
 */

/** The original holds the first place, so the first copy is the second. */
const FIRST_COPY = 2;

/**
 * How many names to try before refusing to try more.
 *
 * A predicate that answers "taken" to everything — a bug in the caller, or a
 * directory being filled faster than this counts — would otherwise spin
 * forever. This loop is synchronous, so that spin takes the whole process with
 * it rather than the one request that asked. Ten thousand is far past any real
 * directory and still settles in well under a millisecond.
 */
const MAX_ATTEMPTS = 10_000;

/** Matches a name that ends in a parenthesised number, suffix or not. */
const TRAILING_NUMBER = /^(.*?) \((\d+)\)$/;

/** A path separator on either platform. Neither belongs in a single segment. */
const SEPARATOR = /[/\\]/;

/**
 * Splits a name into the part the suffix attaches to and the extension.
 *
 * Only the last extension counts, so `archive.tar.gz` keeps `archive.tar` as
 * its stem. A dotfile has no extension at all — `.gitignore` is one name
 * rather than an empty name with a `.gitignore` extension — which is why the
 * dot has to be past the first character to separate anything.
 *
 * Done here rather than with `node:path` because that module resolves to
 * `path.win32` on Windows, where a name like `c:report.md` reads as a drive
 * root and the stem loses the `c:`. The rule has to read the same on both.
 */
function split(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * The number a name already carries, if counting on from it would work.
 *
 * Four ways it would not, and all four end the same way — the digits stay part
 * of the name and a fresh ` (2)` goes after them:
 *
 * - past 2^53 the value is no longer the integer that was written;
 * - at exactly 2^53-1 adding one returns the same number, so the counter
 *   stalls and every later candidate reads like the one before it;
 * - a value large enough to print in exponent form would name the copy
 *   `r (1e+21).md`, which is not a number anybody wrote;
 * - a leading zero is somebody's own naming, because we never write one, and
 *   counting from `(007)` returns `(8)` and loses the padding it was chosen
 *   for.
 *
 * `(0)` and `(1)` are refused for a different reason: they are the original's
 * own places, and a copy that took one would announce itself as the first.
 */
function carriedCount(digits: string): number | null {
  const value = Number(digits);

  if (!Number.isSafeInteger(value)) return null;
  if (!Number.isSafeInteger(value + 1)) return null;
  if (String(value) !== digits) return null;
  if (value < FIRST_COPY) return null;

  return value;
}

export function resolveNameCollision(
  name: string,
  isTaken: (candidate: string) => boolean,
): string {
  // Before the predicate, so a free path is refused too. Refusing only the
  // taken ones would leave the shape of the answer depending on the answer.
  if (SEPARATOR.test(name)) {
    throw new TypeError(`resolveNameCollision names a single path segment, not a path: ${name}`);
  }

  if (!isTaken(name)) return name;

  const { stem, ext } = split(name);

  // A name that already ends in a suffix we could have written continues from
  // it rather than nesting a second suffix inside the first.
  const trailing = TRAILING_NUMBER.exec(stem);
  const carried = trailing ? carriedCount(trailing[2]) : null;
  const base = carried === null ? stem : trailing![1];
  let counter = carried === null ? FIRST_COPY : carried + 1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!Number.isSafeInteger(counter)) {
      throw new RangeError(
        `counting past ${Number.MAX_SAFE_INTEGER} would name "${name}" the same way twice`,
      );
    }

    const candidate = `${base} (${counter})${ext}`;
    if (!isTaken(candidate)) return candidate;

    counter += 1;
  }

  throw new Error(`no free name for "${name}" within ${MAX_ATTEMPTS} attempts`);
}

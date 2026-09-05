import { createHash } from 'crypto';

/**
 * The canonical input contract for `retainedStateDigest`.
 *
 * IR-BGSTAB-002 AC-1 keeps this input free of anything the transport chose. The
 * previous shape folded the parser tail's base64 text straight into the digest,
 * which tied the value to the data plane encoding: change the encoding and an
 * old client and a new one compute different digests for identical state, and
 * the browser's fail-closed check then holds the view stale and asks for a fresh
 * recovery generation forever.
 *
 * Bumping this version is a contract change. AC-6 requires a verifier that meets
 * a version it does not know to say so rather than treat the digest as sound.
 */
export const RETAINED_STATE_DIGEST_VERSION = 2;

export interface RetainedStateCursor {
  x: number;
  y: number;
}

export interface RetainedStateDigestInput {
  /** Digest of the checkpoint body, itself computed over the source string. */
  dataDigest: string;
  /** The pending escape tail exactly as the terminal model holds it. */
  parserTailSource: string;
  cols: number;
  rows: number;
  modes: Readonly<Record<string, boolean>>;
  activeBuffer: 'normal' | 'alternate';
  cursor: RetainedStateCursor;
  savedCursor: RetainedStateCursor | null;
}

export interface RetainedStateDigestCanonicalInput {
  version: number;
  dataDigest: string;
  parserTailDigest: string;
  cols: number;
  rows: number;
  modes: Readonly<Record<string, boolean>>;
  activeBuffer: 'normal' | 'alternate';
  cursor: RetainedStateCursor;
  savedCursor: RetainedStateCursor | null;
}

/**
 * The modes the canonical input carries, in the order it carries them.
 *
 * Leaving the order to the caller made the two sides agree by coincidence: the
 * adapter's array and the browser's list simply happened to match.
 */
export const RETAINED_STATE_MODE_NAMES: readonly string[] = Object.freeze([
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'wraparoundMode',
]);

function canonicalModes(modes: Readonly<Record<string, boolean>>): Record<string, boolean> {
  return Object.fromEntries(
    RETAINED_STATE_MODE_NAMES.flatMap(name => (typeof modes[name] === 'boolean' ? [[name, modes[name]]] : [])),
  );
}

function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The parser tail enters the digest as a hash of its source bytes.
 *
 * A hash keeps the input a fixed-width scalar while staying independent of any
 * wire representation, which is what AC-1 asks for.
 */
function parserTailDigest(source: string): string {
  return `sha256:${sha256Hex(Buffer.from(source, 'utf8'))}`;
}

/**
 * Narrow the cursor to the two coordinates the contract fixes.
 *
 * The browser already rebuilds the cursor as `{x, y}` while the server used to
 * pass the model's object through, so a key added to that model would have
 * silently split the two sides. AC-5 closes that by making both ends name the
 * same keys.
 */
function canonicalCursor(cursor: RetainedStateCursor): RetainedStateCursor {
  return { x: cursor.x, y: cursor.y };
}

export function buildRetainedStateDigestCanonicalInput(
  input: RetainedStateDigestInput,
): RetainedStateDigestCanonicalInput {
  return {
    version: RETAINED_STATE_DIGEST_VERSION,
    dataDigest: input.dataDigest,
    parserTailDigest: parserTailDigest(input.parserTailSource),
    cols: input.cols,
    rows: input.rows,
    modes: canonicalModes(input.modes),
    activeBuffer: input.activeBuffer,
    cursor: canonicalCursor(input.cursor),
    savedCursor: input.savedCursor === null ? null : canonicalCursor(input.savedCursor),
  };
}

export function computeRetainedStateDigest(input: RetainedStateDigestInput): string {
  const canonical = buildRetainedStateDigestCanonicalInput(input);
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(canonical), 'utf8'))}`;
}

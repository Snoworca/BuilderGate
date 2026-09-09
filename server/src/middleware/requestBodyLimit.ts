/**
 * Request body size limits.
 *
 * Two different things get measured here. `maxFileSize` bounds the bytes a
 * file occupies on disk. A request that carries a file carries more than those
 * bytes: a JSON envelope around them, and whatever escaping the content needs
 * on the way out. Binding the transport to `maxFileSize` therefore refuses
 * files the read path serves, so the transport bound is derived from it rather
 * than set equal to it, and the file bound itself is applied to the decoded
 * content by FileService.
 *
 * @req IR-MDE-001
 */

import express from 'express';
import type { RequestHandler, Response } from 'express';

/**
 * JSON writes a control character as \u00XX: six bytes carrying one. Nothing
 * expands further — a quote or a backslash doubles, and a multi-byte UTF-8
 * character is copied through unchanged — so six times a file's size is the
 * largest a request carrying that file can be.
 *
 * This is the tight bound rather than a safety margin, and the read path
 * really does reach it: the binary check counts only NUL bytes, and only
 * across the first 8 KB, so a file of control characters is served in full.
 * A smaller factor would pick which of those files can be read but not saved.
 */
export const JSON_ESCAPE_WORST_CASE_FACTOR = 6;

/**
 * Room for the JSON around the content: the two keys, the braces, the quotes
 * and the file path. Longer than any path a filesystem accepts.
 */
export const REQUEST_ENVELOPE_HEADROOM_BYTES = 8192;

/**
 * The bound a request body gets whenever the derived one would be smaller.
 * Requests that carry no file at all — a settings patch, a workspace layout —
 * share this parser, and the config schema lets maxFileSize go down to 1 KB,
 * so a bound derived from that value alone would take those requests down
 * with it.
 */
export const REQUEST_BODY_FLOOR_BYTES = 1048576;

/**
 * The transport bound for a file of `maxFileSize` bytes: large enough to carry
 * any such file with its envelope and its escaping, and never smaller than the
 * floor the remaining routes need.
 */
export function requestBodyLimitBytes(maxFileSize: number): number {
  return Math.max(
    REQUEST_BODY_FLOOR_BYTES,
    maxFileSize * JSON_ESCAPE_WORST_CASE_FACTOR + REQUEST_ENVELOPE_HEADROOM_BYTES
  );
}

/**
 * A JSON body parser bounded by {@link requestBodyLimitBytes} of whatever
 * `maxFileSize` is in force at the time of the request. Reading the value per
 * request rather than at mount time is what lets a settings change reach this
 * bound, because the parser is mounted long before the first such change.
 */
export function createJsonBodyParser(readMaxFileSize: () => number): RequestHandler {
  let parser: RequestHandler | null = null;
  let parserLimit = -1;

  return (req, res, next) => {
    const limit = requestBodyLimitBytes(readMaxFileSize());
    // Rebuilt only when the bound actually moves, which a settings change does
    // and an ordinary request does not.
    if (parser === null || limit !== parserLimit) {
      parser = express.json({ limit });
      parserLimit = limit;
    }
    parser(req, res, next);
  };
}

/**
 * Answer an oversized request body, reporting whether this error was one.
 *
 * body-parser raises its own error for a body past the bound. Letting it fall
 * through to a generic 500 would tell the caller nothing about the limit it
 * crossed.
 */
export function respondIfRequestEntityTooLarge(err: unknown, res: Response): boolean {
  if ((err as { type?: string } | null)?.type !== 'entity.too.large') {
    return false;
  }
  res.status(413).json({ error: 'Request body too large' });
  return true;
}

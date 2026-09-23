/**
 * Path Security Validator
 * Phase 4: File Manager Core
 *
 * Prevents path traversal attacks and blocks sensitive paths.
 * Uses path.resolve() + path.relative() pattern (ADR-009).
 */

import path from 'path';
import fs from 'fs/promises';
import { AppError, ErrorCode } from './errors.js';

/**
 * Validate and resolve a target path against a base directory.
 * Throws PATH_TRAVERSAL if the resolved path escapes the base.
 */
export function validatePath(basePath: string, targetPath: string): string {
  const resolved = path.resolve(basePath, targetPath);
  const relative = path.relative(basePath, resolved);

  // Path escapes base directory if relative starts with '..'
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError(ErrorCode.PATH_TRAVERSAL);
  }

  return resolved;
}

/**
 * Fold one path segment to the name the filesystem will actually use, so the
 * block list cannot be bypassed by a spelling the OS treats as the same entry.
 * NTFS and APFS are case-insensitive, so '.GIT' is '.git'. Win32 also drops
 * trailing dots and spaces ('.git.' and '.git ' open '.git'), and a ':' suffix
 * addresses a stream of the entry before it ('.git::$INDEX_ALLOCATION' is the
 * .git directory itself).
 */
function foldSegment(seg: string, platform: NodeJS.Platform): string {
  let out = seg;
  if (platform === 'win32') {
    const colon = out.indexOf(':');
    if (colon > 0) out = out.slice(0, colon);
    out = out.replace(/[. ]+$/, '');
  }
  if (platform === 'win32' || platform === 'darwin') out = out.toLowerCase();
  return out;
}

/**
 * Check if a path contains any blocked path segments.
 * platform defaults to the host; tests pass it to cover other filesystems' rules.
 */
export function isPathBlocked(
  targetPath: string,
  blockedPaths: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  const blocked = new Set(blockedPaths.map(b => foldSegment(b, platform)).filter(b => b !== ''));
  const normalized = targetPath.replace(/\\/g, '/');
  return normalized.split('/').some(seg => seg !== '' && blocked.has(foldSegment(seg, platform)));
}

/**
 * Check if a file extension is blocked.
 */
export function isBlockedExtension(ext: string, blockedExtensions: string[]): boolean {
  return blockedExtensions.includes(ext.toLowerCase());
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/** A realpath failure that is not "does not exist" must not fall back to the unresolved path. */
function realpathFailure(err: unknown): AppError {
  const code = errnoCode(err);
  if (code === 'EACCES' || code === 'EPERM') return new AppError(ErrorCode.PERMISSION_DENIED);
  return new AppError(ErrorCode.FILE_OPERATION_FAILED, `Path resolution failed: ${code ?? 'unknown error'}`);
}

/**
 * Resolve, validate, and check blocked paths in one call.
 * Links are resolved so neither an existing target nor a path that does not
 * exist yet can reach outside the base or into a blocked directory through a
 * link whose own name passes the string checks.
 */
export async function resolveAndValidate(
  basePath: string,
  targetPath: string,
  blockedPaths: string[]
): Promise<string> {
  return (await resolveAndValidateEntry(basePath, targetPath, blockedPaths)).realPath;
}

/** Both locations a validated path has; see resolveAndValidateEntry. */
export interface ValidatedEntry {
  /** Where the path really leads, every link followed. Use it to read or write content. */
  realPath: string;
  /**
   * The directory entry the caller named, with links in its parent chain
   * followed but the final name left as is. Use it to delete, rename or move:
   * if the named entry is itself a link, this is the link, not its target.
   */
  entryPath: string;
}

function isOutside(realBase: string, p: string): boolean {
  const rel = path.relative(realBase, p);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * resolveAndValidate for operations that act on the entry itself rather than
 * on its content. The real location is validated exactly as resolveAndValidate
 * does; the entry's own location (its real parent plus its name) is validated
 * too, because a link can sit outside the base or in a blocked directory while
 * pointing back inside — removing it would then touch something outside.
 */
export async function resolveAndValidateEntry(
  basePath: string,
  targetPath: string,
  blockedPaths: string[]
): Promise<ValidatedEntry> {
  // String checks first: whatever can be refused without touching the disk is.
  const resolved = validatePath(basePath, targetPath);

  if (isPathBlocked(resolved, blockedPaths)) {
    throw new AppError(ErrorCode.PATH_BLOCKED);
  }

  // A path that does not exist yet (write, copy/move destination) is judged by
  // its nearest existing ancestor: the remaining names will be created under
  // wherever that ancestor really is, so that real location is what must lie
  // inside the base and outside the block list.
  const missing: string[] = [];
  let existing = resolved;
  let real: string;
  for (;;) {
    try {
      real = await fs.realpath(existing);
      break;
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw realpathFailure(err);
    }
    // realpath failed but lstat sees an entry: a link whose target is gone.
    // Creating under it lands wherever it points, which cannot be judged.
    if (await fs.lstat(existing).then(() => true, () => false)) {
      throw new AppError(ErrorCode.PATH_TRAVERSAL);
    }
    const parent = path.dirname(existing);
    // Reached the filesystem root without an existing ancestor: the base itself is gone.
    if (parent === existing) throw new AppError(ErrorCode.PATH_TRAVERSAL);
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  // Compare against the real base as well; a base reached through a link or an
  // 8.3 short name would otherwise make every real path look outside it.
  const realBase = await fs.realpath(basePath).catch(() => basePath);
  const full = missing.length === 0 ? real : path.join(real, ...missing);
  if (isOutside(realBase, full)) {
    throw new AppError(ErrorCode.PATH_TRAVERSAL);
  }
  // The real path can reveal a blocked directory (through a link, or a long
  // name hidden behind an 8.3 alias) that the requested string did not name.
  if (isPathBlocked(full, blockedPaths)) {
    throw new AppError(ErrorCode.PATH_BLOCKED);
  }

  // A missing tail cannot contain a link, so the entry is the real path. The
  // base itself has no parent inside the base to judge; it is named as is.
  if (missing.length > 0 || resolved === path.resolve(basePath)) {
    return { realPath: full, entryPath: missing.length > 0 ? full : real };
  }
  const realParent = await fs.realpath(path.dirname(resolved)).catch((err: unknown) => {
    throw realpathFailure(err);
  });
  const entryPath = path.join(realParent, path.basename(resolved));
  if (isOutside(realBase, entryPath)) {
    throw new AppError(ErrorCode.PATH_TRAVERSAL);
  }
  if (isPathBlocked(entryPath, blockedPaths)) {
    throw new AppError(ErrorCode.PATH_BLOCKED);
  }
  return { realPath: full, entryPath };
}

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
 * Check if a path contains any blocked path segments.
 */
export function isPathBlocked(targetPath: string, blockedPaths: string[]): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments.some(seg => blockedPaths.includes(seg));
}

/**
 * Check if a file extension is blocked.
 */
export function isBlockedExtension(ext: string, blockedExtensions: string[]): boolean {
  return blockedExtensions.includes(ext.toLowerCase());
}

/**
 * Resolve, validate, and check blocked paths in one call.
 * Also resolves symlinks to ensure they don't escape the base.
 */
export async function resolveAndValidate(
  basePath: string,
  targetPath: string,
  blockedPaths: string[]
): Promise<string> {
  const resolved = validatePath(basePath, targetPath);

  if (isPathBlocked(resolved, blockedPaths)) {
    throw new AppError(ErrorCode.PATH_BLOCKED);
  }

  // Resolve symlinks and re-validate
  try {
    const real = await fs.realpath(resolved);
    const realRelative = path.relative(basePath, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new AppError(ErrorCode.PATH_TRAVERSAL);
    }
    return real;
  } catch (err) {
    // If file doesn't exist yet (e.g., copy destination), that's okay
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    if (err instanceof AppError) throw err;
    return resolved;
  }
}

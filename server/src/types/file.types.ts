/**
 * File Manager Types
 * Phase 4: File Manager Core
 */

// ============================================================================
// Configuration
// ============================================================================

export interface FileManagerConfig {
  maxFileSize: number;
  maxDirectoryEntries: number;
  blockedExtensions: string[];
  blockedPaths: string[];
  cwdCacheTtlMs: number;
  /** Raw image read limit in bytes (IR-MDE-003). Absent means 20 MiB. */
  maxImageFileSize?: number;
}

// ============================================================================
// Directory & File Types
// ============================================================================

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  modified: string; // ISO 8601
}

/** FR-FEX-018: one path's attributes for the information modal. */
export interface PathStat {
  name: string;
  /** Absolute path on the server. */
  path: string;
  /** Relative to the session root, '.' for the root itself. */
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  extension?: string;
  modified: string;
  accessed: string;
  changed: string;
  /** Absent where the filesystem does not record it. */
  created?: string;
  /** Octal permission bits, e.g. '0644'. */
  mode: string;
  /** rwxr-xr-x form of `mode`. */
  permissions: string;
  /** Direct entries, for a directory. */
  childCount?: number;
  /** Where a symlink points, for a symlink. */
  linkTarget?: string;
}

export interface DirectoryListing {
  cwd: string;
  path: string;
  entries: DirectoryEntry[];
  totalEntries: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  encoding: 'utf-8' | 'unknown';
  extension: string;
  mimeType: string;
}

// ============================================================================
// Request Types
// ============================================================================

export interface CopyRequest {
  source: string;
  destination: string;
}

export interface MoveRequest {
  source: string;
  destination: string;
}

export interface CwdResponse {
  cwd: string;
}

export interface MkdirRequest {
  path: string;
  name: string;
}

export interface WriteRequest {
  path: string;
  content: string;
}

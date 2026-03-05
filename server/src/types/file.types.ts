/**
 * File Manager Types
 * Phase 4: File Manager Core
 */

// ============================================================================
// Configuration
// ============================================================================

export interface FileManagerConfig {
  maxFileSize: number;
  maxCodeFileSize: number;
  maxDirectoryEntries: number;
  blockedExtensions: string[];
  blockedPaths: string[];
  cwdCacheTtlMs: number;
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
  encoding: string;
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

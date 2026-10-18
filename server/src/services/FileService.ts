/**
 * File Service
 * Phase 4: File Manager Core
 *
 * Independent service for file system operations (ADR-007).
 * Uses pathValidator for security (ADR-009).
 */

import fs from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { FileManagerConfig, DirectoryEntry, DirectoryListing, FileContent, PathStat } from '../types/file.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { resolveAndValidate, resolveAndValidateEntry, isBlockedExtension, isPathBlocked, isSessionRootTarget, toHostPath } from '../utils/pathValidator.js';
import { isFileJobTempName } from './fileJobs/fileJobRunner.js';
import { isUploadTempName, validateUploadRelativePath } from './upload/uploadTemp.js';

/** A file job's or an upload's in-progress temp file: not the user's file, never listed or counted. */
export function isTransientFileName(name: string): boolean {
  return isFileJobTempName(name) || isUploadTempName(name);
}

// Upper bound on fs.stat calls in flight for one directory listing. libuv runs
// fs work on a small thread pool (4 by default), so a few dozen pending requests
// already keep it saturated; more would only lengthen the queue that every other
// fs call in the server waits in.
const LIST_STAT_CONCURRENCY = 32;

/**
 * Map items through an async fn with at most `limit` calls pending, keeping
 * result order aligned with input order.
 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// MIME type mapping for common extensions
const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/jsx',
  '.tsx': 'text/tsx',
  '.json': 'application/json',
  '.json5': 'application/json5',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.py': 'text/x-python',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.sh': 'text/x-shellscript',
  '.bat': 'text/x-bat',
  '.ps1': 'text/x-powershell',
  '.sql': 'text/x-sql',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.toml': 'text/toml',
  '.ini': 'text/ini',
  '.cfg': 'text/plain',
  '.log': 'text/plain',
  '.env': 'text/plain',
};

// Extensions served as raw image bytes. Same set as the editor's image mode
// (FR-MDE-013 AC-5); anything else is refused by readImageFile.
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg',
]);

/** Image size limit used when the configuration carries no maxImageFileSize. */
export const DEFAULT_MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;

/** FR-FOP-007 AC-4: extraction limits used when the configuration carries none. */
export const DEFAULT_MAX_EXTRACT_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_EXTRACT_ENTRIES = 100_000;

/** FR-FEX-023 AC-4: upload size limit used when the configuration carries no maxUploadFileSize. */
export const DEFAULT_MAX_UPLOAD_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/** Where an upload lands, every part of it validated (FR-FEX-023 AC-2, AC-3). */
export interface UploadTarget {
  /** The session root's real path; response paths are relative to it. */
  realCwd: string;
  /** The destination folder's real path. */
  dirPath: string;
  /** The relative path's segments under dirPath. */
  segments: string[];
  /** The entry to create or replace (a link at this name is replaced, not followed). */
  target: string;
}

/** One selected item of a ZIP download (FR-FEX-025). */
export interface ArchiveItem {
  /** The entry itself; a link stays a link. */
  path: string;
  /** The archive name the item's entries start with. */
  entryName: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface ImageFileContent {
  buffer: Buffer;
  mimeType: string;
  size: number;
}

// SessionManager type - we only need a subset of its interface
interface SessionManagerLike {
  getSession(id: string): unknown;
  getPtyPid(sessionId: string): number | null;
  getInitialCwd(sessionId: string): string | null;
  getCwdFilePath(sessionId: string): string | null;
}

export class FileService {
  private cwdCache = new Map<string, { cwd: string; timestamp: number }>();
  private config: FileManagerConfig;

  constructor(
    private sessionManager: SessionManagerLike,
    config: FileManagerConfig
  ) {
    this.config = cloneFileManagerConfig(config);
  }

  updateConfig(next: FileManagerConfig): void {
    this.config = cloneFileManagerConfig(next);
  }

  /**
   * The largest file either path will handle, as it stands right now. The body
   * parser derives its own bound from this so that a request can always carry
   * a file of this size, which is what makes a document that can be opened a
   * document that can also be saved.
   *
   * @req IR-MDE-001
   */
  get maxFileSize(): number {
    return this.config.maxFileSize;
  }

  /** FR-FEX-023 AC-4: the largest file one upload may carry, as it stands right now. */
  get maxUploadFileSize(): number {
    return this.config.maxUploadFileSize ?? DEFAULT_MAX_UPLOAD_FILE_SIZE;
  }

  /** FR-FOP-007 AC-4: the extraction limits as they stand right now. */
  get extractLimits(): { maxBytes: number; maxEntries: number } {
    return {
      maxBytes: this.config.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES,
      maxEntries: this.config.maxExtractEntries ?? DEFAULT_MAX_EXTRACT_ENTRIES,
    };
  }

  /** The block lists as they stand right now, for walks that check every entry (FR-FEX-025 AC-5). */
  get blockRules(): { blockedPaths: readonly string[]; blockedExtensions: readonly string[] } {
    return { blockedPaths: this.config.blockedPaths, blockedExtensions: this.config.blockedExtensions };
  }

  /**
   * FR-FEX-023 AC-2, AC-3: resolves an upload's destination folder and relative path with the file
   * API rules. The relative path is checked first (INVALID_UPLOAD_PATH), the folder must exist,
   * and the joined path is judged by its real location: inside the session root, outside the
   * block list, with no blocked extension. Nothing is created here.
   */
  async resolveUploadTarget(sessionId: string, dir: string, relativePath: string): Promise<UploadTarget> {
    this.assertSessionExists(sessionId);
    const segments = validateUploadRelativePath(relativePath);
    if (segments === null) throw new AppError(ErrorCode.INVALID_UPLOAD_PATH);
    const cwd = await this.getCwd(sessionId);
    const dirPath = await resolveAndValidate(cwd, dir === '' ? '.' : dir, this.config.blockedPaths);
    const dirStat = await fs.stat(dirPath).catch(() => null);
    if (dirStat === null) throw new AppError(ErrorCode.PATH_NOT_FOUND);
    if (!dirStat.isDirectory()) throw new AppError(ErrorCode.PATH_NOT_FOUND, 'Path is not a directory');
    // dirPath is a real path; judging it against the real root keeps a session root reached
    // through a link from looking like an escape.
    const realCwd = await fs.realpath(cwd).catch(() => cwd);
    const entry = await resolveAndValidateEntry(realCwd, path.join(dirPath, ...segments), this.config.blockedPaths);
    if (isBlockedExtension(path.extname(segments[segments.length - 1]).toLowerCase(), this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }
    return { realCwd, dirPath, segments, target: entry.entryPath };
  }

  /**
   * FR-FEX-023 AC-2: after the missing folders are made, the folder that will hold the file is
   * judged again by its real location, so a link raced into the chain cannot carry the write out.
   */
  async revalidateUploadParent(sessionId: string, realCwd: string, parent: string): Promise<void> {
    this.assertSessionExists(sessionId);
    await resolveAndValidate(realCwd, parent, this.config.blockedPaths);
  }

  /**
   * FR-FEX-025 AC-3, AC-4: the selected items of a ZIP download, each checked with the file API
   * rules, and the archive name: '{name}.zip' for one directory, otherwise the common parent
   * folder's name. A selection inside another selection is dropped; equal entry names from
   * different folders get the FR-FOP-004 suffix.
   */
  async resolveArchiveSelection(sessionId: string, paths: readonly string[]): Promise<{ items: ArchiveItem[]; name: string; realCwd: string }> {
    this.assertSessionExists(sessionId);
    if (paths.length === 0) throw new AppError(ErrorCode.INVALID_INPUT, 'paths is empty');
    const cwd = await this.getCwd(sessionId);
    const realCwd = await fs.realpath(cwd).catch(() => cwd);
    const resolved: Array<{ path: string; kind: ArchiveItem['kind'] }> = [];
    for (const requested of paths) {
      const entry = await resolveAndValidateEntry(cwd, requested === '' ? '.' : requested, this.config.blockedPaths);
      // The session root itself is archived under its real name, even when the cwd is a link.
      const isRoot = samePath(path.resolve(cwd, requested === '' ? '.' : requested), cwd);
      const itemPath = isRoot ? realCwd : entry.entryPath;
      const stat = await fs.lstat(itemPath).catch(() => null);
      if (stat === null) throw new AppError(ErrorCode.PATH_NOT_FOUND);
      const kind: ArchiveItem['kind'] = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      if (kind === 'file' && isBlockedExtension(path.extname(itemPath).toLowerCase(), this.config.blockedExtensions)) {
        throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
      }
      resolved.push({ path: itemPath, kind });
    }
    // Drop duplicates and items inside another selected directory.
    const kept = resolved.filter((item, index) => !resolved.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      if (samePath(other.path, item.path)) return otherIndex < index;
      return other.kind === 'directory' && isInside(other.path, item.path);
    }));
    const taken = new Set<string>();
    const items = kept.map((item): ArchiveItem => {
      const base = path.basename(item.path);
      let entryName = base;
      let counter = 2;
      while (taken.has(entryName.toLowerCase())) {
        const dot = base.lastIndexOf('.');
        entryName = dot > 0 && item.kind !== 'directory' ? `${base.slice(0, dot)} (${counter})${base.slice(dot)}` : `${base} (${counter})`;
        counter += 1;
      }
      taken.add(entryName.toLowerCase());
      return { path: item.path, entryName, kind: item.kind };
    });
    let folder: string;
    if (items.length === 1 && items[0].kind === 'directory') {
      folder = items[0].path;
    } else {
      folder = items.map((item) => path.dirname(item.path)).reduce(commonAncestor);
      if (!samePath(folder, realCwd) && !isInside(realCwd, folder)) folder = realCwd;
    }
    return { items, name: `${path.basename(folder) || 'download'}.zip`, realCwd };
  }

  /**
   * Get the current working directory for a session's PTY process.
   * Uses OS-specific methods with caching (ADR-008).
   */
  async getCwd(sessionId: string): Promise<string> {
    this.assertSessionExists(sessionId);

    // Check cache
    const cached = this.cwdCache.get(sessionId);
    if (cached && Date.now() - cached.timestamp < this.config.cwdCacheTtlMs) {
      return cached.cwd;
    }

    let cwd: string | null = null;

    // Read CWD from prompt hook file (Windows PowerShell, WSL bash)
    const cwdFile = this.sessionManager.getCwdFilePath(sessionId);
    if (cwdFile) {
      try {
        const fileCwd = readFileSync(cwdFile, 'utf-8').trim();
        // Remove UTF-8 BOM if present
        const cleaned = fileCwd.replace(/^\uFEFF/, '');
        if (cleaned) {
          // WSL bash writes Linux paths (e.g., /home/user/...) — convert to Windows path
          const resolved = this.resolveWslPath(cleaned);
          if (resolved && existsSync(resolved)) {
            cwd = resolved;
          }
        }
      } catch { /* file not yet created or read error */ }
    }

    // Non-Windows: use OS-specific process CWD detection
    if (!cwd) {
      const pid = this.sessionManager.getPtyPid(sessionId);
      if (pid) {
        cwd = this.getProcessCwd(pid);
      }
    }

    // Fallback to initial CWD
    if (!cwd) {
      cwd = this.sessionManager.getInitialCwd(sessionId) || process.cwd();
    }

    // Update cache
    this.cwdCache.set(sessionId, { cwd, timestamp: Date.now() });
    return cwd;
  }

  /**
   * List directory contents with security validation.
   */
  async listDirectory(sessionId: string, targetPath?: string): Promise<DirectoryListing> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    const dirPath = targetPath
      ? await resolveAndValidate(cwd, targetPath, this.config.blockedPaths)
      : cwd;

    // Verify directory exists
    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }
    if (!stat.isDirectory()) {
      throw new AppError(ErrorCode.PATH_NOT_FOUND, 'Path is not a directory');
    }

    // Read directory entries. A file job's in-progress temp file (and one left
    // behind by a crash) is not the user's file: it is hidden, and not counted.
    const dirents = (await fs.readdir(dirPath, { withFileTypes: true })).filter(dirent => !isTransientFileName(dirent.name));
    // FR-FEX-017: ".." only below a filesystem root AND below the session root. At the session
    // root the parent listing is refused (PATH_TRAVERSAL), so offering it only produced an error.
    const hasParent = path.parse(dirPath).root !== dirPath && !(await isSamePath(dirPath, cwd));
    const totalEntries = dirents.length + (hasParent ? 1 : 0);

    // Limit entries
    const limited = dirents.slice(0, this.config.maxDirectoryEntries);

    // Build entry list with stats
    const entries: DirectoryEntry[] = [];

    // Add ".." entry (unless at a filesystem root or the session root)
    if (hasParent) {
      entries.push({
        name: '..',
        type: 'directory',
        size: 0,
        modified: new Date().toISOString(),
      });
    }

    // The stats are independent and were the whole cost of a large listing when
    // awaited one by one (design decision 24). They run in a bounded pool, not an
    // unbounded Promise.all: maxDirectoryEntries allows 10000, and that many
    // simultaneous requests would queue every other fs call in the server behind
    // them. Results land by index so the pre-sort order stays readdir order.
    const statted = await mapWithConcurrency(limited, LIST_STAT_CONCURRENCY, async (dirent): Promise<DirectoryEntry | null> => {
      try {
        const fullPath = path.join(dirPath, dirent.name);
        const entryStat = await fs.stat(fullPath);
        const ext = path.extname(dirent.name).toLowerCase();

        const entry: DirectoryEntry = {
          name: dirent.name,
          type: dirent.isDirectory() ? 'directory' : 'file',
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        };

        if (!dirent.isDirectory() && ext) {
          entry.extension = ext;
        }

        return entry;
      } catch {
        // Skip entries we can't stat (permission errors, etc.)
        return null;
      }
    });
    for (const entry of statted) {
      if (entry) entries.push(entry);
    }

    // Sort: ".." first, then directories first, then alphabetical (case-insensitive)
    entries.sort((a, b) => {
      if (a.name === '..') return -1;
      if (b.name === '..') return 1;
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return {
      cwd,
      path: dirPath,
      entries,
      totalEntries,
    };
  }

  /**
   * Read file contents with size and binary checks.
   */
  // @req FR-FEX-013
  /** The session root and a validated directory under it, for a search to start from. */
  async resolveSearchRoot(sessionId: string, targetPath: string): Promise<{ sessionRoot: string; dir: string }> {
    this.assertSessionExists(sessionId);
    const cwd = await this.getCwd(sessionId);
    const dir = targetPath ? await resolveAndValidate(cwd, targetPath, this.config.blockedPaths) : cwd;
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }
    if (!stat.isDirectory()) throw new AppError(ErrorCode.PATH_NOT_FOUND, 'Path is not a directory');
    return { sessionRoot: cwd, dir };
  }

  // @req FR-FEX-018
  async statPath(sessionId: string, targetPath: string): Promise<PathStat> {
    this.assertSessionExists(sessionId);
    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, targetPath, this.config.blockedPaths);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }
    // The link itself, when the requested path named one (resolveAndValidate returns the target).
    const requested = path.resolve(cwd, targetPath);
    let linkTarget: string | undefined;
    try {
      if ((await fs.lstat(requested)).isSymbolicLink()) linkTarget = await fs.readlink(requested);
    } catch {
      // No link to report.
    }
    const kind: PathStat['kind'] = linkTarget !== undefined
      ? 'symlink'
      : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    let childCount: number | undefined;
    if (stat.isDirectory()) {
      try {
        childCount = (await fs.readdir(resolved)).filter(name => !isTransientFileName(name)).length;
      } catch {
        childCount = undefined;
      }
    }
    const realCwd = await fs.realpath(cwd).catch(() => cwd);
    const relative = path.relative(realCwd, resolved);
    const permBits = stat.mode & 0o777;
    const rwx = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
    const extension = stat.isFile() ? path.extname(resolved) : '';
    return {
      name: path.basename(linkTarget !== undefined ? requested : resolved),
      path: linkTarget !== undefined ? requested : resolved,
      relativePath: relative === '' ? '.' : relative,
      kind,
      size: stat.size,
      ...(extension ? { extension } : {}),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
      changed: stat.ctime.toISOString(),
      // birthtime is epoch 0 where the filesystem has no creation time.
      ...(stat.birthtimeMs > 0 ? { created: stat.birthtime.toISOString() } : {}),
      mode: `0${permBits.toString(8).padStart(3, '0')}`,
      permissions: rwx(permBits >> 6) + rwx(permBits >> 3) + rwx(permBits),
      ...(childCount !== undefined ? { childCount } : {}),
      ...(linkTarget !== undefined ? { linkTarget } : {}),
    };
  }

  async readFile(sessionId: string, filePath: string): Promise<FileContent> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, filePath, this.config.blockedPaths);
    const ext = path.extname(resolved).toLowerCase();

    if (isBlockedExtension(ext, this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }

    if (stat.size > this.config.maxFileSize) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE);
    }

    const buffer = await fs.readFile(resolved);

    if (this.isBinaryFile(buffer)) {
      throw new AppError(ErrorCode.BINARY_FILE);
    }

    const content = buffer.toString('utf-8');
    const mimeType = MIME_TYPES[ext] || 'text/plain';
    // Content is still decoded leniently above; the flag only reports whether
    // the bytes were valid UTF-8 so the client can refuse to save them.
    let encoding: FileContent['encoding'] = 'utf-8';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      encoding = 'unknown';
    }

    return {
      path: resolved,
      content,
      size: stat.size,
      encoding,
      extension: ext,
      mimeType,
    };
  }

  /**
   * Read an image file's raw bytes. Path resolution, blocked paths and blocked
   * extensions follow readFile exactly; the size limit is maxImageFileSize
   * rather than the text limit, and there is no binary or encoding check.
   *
   * @req IR-MDE-003
   */
  async readImageFile(sessionId: string, filePath: string): Promise<ImageFileContent> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, filePath, this.config.blockedPaths);
    const ext = path.extname(resolved).toLowerCase();

    if (isBlockedExtension(ext, this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }

    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Not an image file');
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }

    const limit = this.config.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE;
    if (stat.size > limit) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE);
    }

    const buffer = await fs.readFile(resolved);
    return {
      buffer,
      mimeType: MIME_TYPES[ext] ?? 'application/octet-stream',
      size: stat.size,
    };
  }

  /**
   * Write file contents, creating the file when it does not exist and
   * replacing it in full when it does.
   *
   * The validation stages run in the order the read path uses them: the
   * session first, then path resolution, then the extension, then the size.
   * Nothing is written until all four have passed.
   *
   * @req IR-MDE-001
   */
  /**
   * FR-MCP-012 AC-5: resolves a path the way readFile and writeFile do (inside the session's
   * working directory, not a blocked path or extension) and says what is there, without reading it.
   */
  async inspectPath(sessionId: string, filePath: string): Promise<{ path: string; exists: boolean; isFile: boolean }> {
    this.assertSessionExists(sessionId);
    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, filePath, this.config.blockedPaths);
    if (isBlockedExtension(path.extname(resolved).toLowerCase(), this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }
    const stat = await fs.stat(resolved).catch(() => null);
    return { path: resolved, exists: stat !== null, isFile: stat?.isFile() ?? false };
  }

  /**
   * FR-FEX-021 AC-2: a file to download, resolved and checked as readFile does, without reading
   * it. The size is not held to maxFileSize: the download streams.
   */
  async resolveDownload(sessionId: string, filePath: string): Promise<{ path: string; name: string; size: number }> {
    const info = await this.inspectPath(sessionId, filePath);
    if (!info.exists) throw new AppError(ErrorCode.PATH_NOT_FOUND);
    if (!info.isFile) throw new AppError(ErrorCode.NOT_A_FILE);
    const stat = await fs.stat(info.path);
    return { path: info.path, name: path.basename(info.path), size: stat.size };
  }

  /**
   * SEC-MDE-002 AC-2: a file the HTML view route may serve: under `root` (the session folder fixed
   * when the token was issued), not a blocked path or extension, no link leaving the root, a regular
   * file. A name Win32 would read as another file (a trailing dot or space, a ':' stream) is refused
   * on every host. Missing files and folders are PATH_NOT_FOUND; there is no listing.
   */
  async resolveHtmlViewFile(sessionId: string, root: string, relativePath: string): Promise<{ path: string; size: number }> {
    this.assertSessionExists(sessionId);
    if (relativePath.includes('\u0000') || relativePath.includes(':')) throw new AppError(ErrorCode.PATH_TRAVERSAL);
    const segments = relativePath.split(/[\\/]/).filter((s) => s !== '');
    if (segments.some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s))) throw new AppError(ErrorCode.PATH_BLOCKED);
    if (segments.length === 0) throw new AppError(ErrorCode.PATH_NOT_FOUND);
    const resolved = await resolveAndValidate(root, segments.join('/'), this.config.blockedPaths);
    if (isBlockedExtension(path.extname(resolved).toLowerCase(), this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat === null || !stat.isFile()) throw new AppError(ErrorCode.PATH_NOT_FOUND);
    return { path: resolved, size: stat.size };
  }

  /** SEC-MDE-002 AC-1: the session folder's real path, fixed in an HTML view token. */
  async realCwd(sessionId: string): Promise<string> {
    this.assertSessionExists(sessionId);
    const cwd = await this.getCwd(sessionId);
    return fs.realpath(cwd).catch(() => cwd);
  }

  /** FR-MCP-012 AC-2: writeFile that first creates the missing parent directories. */
  async writeFileCreatingDirectories(sessionId: string, filePath: string, content: string): Promise<string> {
    const { path: resolved } = await this.inspectPath(sessionId, filePath);
    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') throw new AppError(ErrorCode.PERMISSION_DENIED);
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Create directory failed: ${(err as Error).message}`);
    }
    await this.writeFile(sessionId, resolved, content);
    return resolved;
  }

  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    // Called here rather than left to getCwd: the ordering this method promises
    // would otherwise rest on an implementation detail of that method.
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, filePath, this.config.blockedPaths);
    const ext = path.extname(resolved).toLowerCase();

    // resolveAndValidate never inspects the extension, so a blocked type
    // reaches disk unless this stage runs.
    if (isBlockedExtension(ext, this.config.blockedExtensions)) {
      throw new AppError(ErrorCode.PATH_BLOCKED, 'File type is blocked');
    }

    // The bytes that will land on disk, compared against the same bound and
    // with the same boundary the read path applies to the bytes already there.
    // Measuring the request instead would move the ceiling every time the
    // content needed more JSON escaping.
    if (Buffer.byteLength(content, 'utf-8') > this.config.maxFileSize) {
      throw new AppError(ErrorCode.FILE_TOO_LARGE);
    }

    try {
      // 'w' truncates. Without it the tail of a longer previous body survives
      // the write, which looks like a save that partly failed.
      await fs.writeFile(resolved, content, { encoding: 'utf-8', flag: 'w' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Copy a file or directory.
   */
  async copyFile(sessionId: string, source: string, destination: string): Promise<void> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    const srcResolved = await resolveAndValidate(cwd, source, this.config.blockedPaths);
    const destResolved = await resolveAndValidate(cwd, destination, this.config.blockedPaths);

    // Check source exists
    let srcStat;
    try {
      srcStat = await fs.stat(srcResolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND, 'Source path not found');
    }

    // Check destination doesn't exist
    try {
      await fs.stat(destResolved);
      throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // ENOENT is expected - destination doesn't exist
    }

    try {
      if (srcStat.isDirectory()) {
        await fs.cp(srcResolved, destResolved, { recursive: true });
      } else {
        await fs.copyFile(srcResolved, destResolved);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Copy failed: ${(err as Error).message}`);
    }
  }

  /**
   * Move/rename a file or directory.
   */
  async moveFile(sessionId: string, source: string, destination: string): Promise<void> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    // Rename the entry the user named: if the source is a link, the link moves,
    // not its target. Its real location is still validated.
    const srcResolved = (await resolveAndValidateEntry(cwd, source, this.config.blockedPaths)).entryPath;
    // Moving the session folder itself would move the folder the session stands
    // in (or, for a link cwd, leave a link that points into itself).
    if (await isSessionRootTarget(cwd, { resolved: path.resolve(cwd, source), entryPath: srcResolved })) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Cannot move the session folder itself');
    }
    const destResolved = await resolveAndValidate(cwd, destination, this.config.blockedPaths);

    // Check source exists (lstat: the entry itself, not what a link points to)
    try {
      await fs.lstat(srcResolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND, 'Source path not found');
    }

    // Check destination doesn't exist
    try {
      await fs.stat(destResolved);
      throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
    } catch (err) {
      if (err instanceof AppError) throw err;
    }

    try {
      await fs.rename(srcResolved, destResolved);
    } catch (err) {
      // Cross-device move: copy then delete
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        await this.copyFile(sessionId, source, destination);
        await this.deleteFile(sessionId, source);
        return;
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Move failed: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a file or directory.
   */
  async deleteFile(sessionId: string, filePath: string): Promise<void> {
    this.assertSessionExists(sessionId);

    const cwd = await this.getCwd(sessionId);
    // Remove the entry the user named. The validator judges the real location,
    // but acting on it would delete a link's target (a junction to a folder
    // would empty that folder); entryPath is the link itself.
    const resolved = (await resolveAndValidateEntry(cwd, filePath, this.config.blockedPaths)).entryPath;
    // Deleting the session folder itself would remove the whole project (or,
    // for a link cwd, the link out of its parent directory).
    if (await isSessionRootTarget(cwd, { resolved: path.resolve(cwd, filePath), entryPath: resolved })) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Cannot delete the session folder itself');
    }

    // lstat so a link to a directory is not taken for a directory: it is
    // unlinked, never removed recursively.
    let stat;
    try {
      stat = await fs.lstat(resolved);
    } catch {
      throw new AppError(ErrorCode.PATH_NOT_FOUND);
    }

    try {
      if (stat.isDirectory()) {
        await fs.rm(resolved, { recursive: true });
      } else {
        await fs.unlink(resolved);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Delete failed: ${(err as Error).message}`);
    }
  }

  /**
   * Create a new directory.
   */
  async createDirectory(sessionId: string, basePath: string, name: string): Promise<void> {
    this.assertSessionExists(sessionId);

    // Validate name doesn't contain path separators or traversal
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      throw new AppError(ErrorCode.PATH_TRAVERSAL, 'Invalid directory name');
    }

    const cwd = await this.getCwd(sessionId);
    const resolved = await resolveAndValidate(cwd, basePath, this.config.blockedPaths);
    const dirPath = path.join(resolved, name);
    // Only basePath went through the validator; the new name is appended after
    // it, so a blocked name ('.ssh', or '.SSH.' on Windows) needs its own check.
    if (isPathBlocked(dirPath, this.config.blockedPaths)) {
      throw new AppError(ErrorCode.PATH_BLOCKED);
    }

    try {
      await fs.stat(dirPath);
      throw new AppError(ErrorCode.FILE_ALREADY_EXISTS);
    } catch (err) {
      if (err instanceof AppError) throw err;
    }

    try {
      await fs.mkdir(dirPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new AppError(ErrorCode.PERMISSION_DENIED);
      }
      throw new AppError(ErrorCode.FILE_OPERATION_FAILED, `Mkdir failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get free disk space for a path (best effort).
   */
  async getDiskFreeSpace(targetPath: string): Promise<number> {
    try {
      if (process.platform === 'win32') {
        const drive = path.parse(targetPath).root || 'C:\\';
        const output = execSync(
          `powershell -Command "(Get-PSDrive ${drive[0]}).Free"`,
          { encoding: 'utf-8', timeout: 5000, windowsHide: true }
        ).trim();
        return parseInt(output, 10) || 0;
      } else {
        const output = execSync(
          `df -B1 "${targetPath}" | tail -1 | awk '{print $4}'`,
          { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        return parseInt(output, 10) || 0;
      }
    } catch {
      return 0;
    }
  }

  /**
   * Check if a buffer contains binary data.
   */
  private isBinaryFile(buffer: Buffer): boolean {
    const checkLength = Math.min(buffer.length, 8192);
    let nullCount = 0;
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0x00) nullCount++;
    }
    return checkLength > 0 && nullCount / checkLength > 0.1;
  }

  /**
   * Get CWD of a process by PID using OS-specific methods.
   */
  private getProcessCwd(pid: number): string | null {
    try {
      if (process.platform === 'win32') {
        // Windows has no reliable API to get another process's CWD.
        // MainModule.FileName returns the executable path, NOT the CWD.
        // Fall back to initialCwd (set at session creation time).
        return null;
      } else if (process.platform === 'linux') {
        const link = execSync(`readlink /proc/${pid}/cwd`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        return link || null;
      } else {
        // macOS
        const output = execSync(`lsof -p ${pid} -Fn | grep '^fcwd' -A1 | tail -1 | cut -c2-`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        return output || null;
      }
    } catch {
      return null;
    }
  }

  /**
   * Convert a potentially WSL Linux path to a Windows path.
   * e.g., /mnt/c/Users/... → C:\Users\...
   * Non-/mnt paths (e.g., /home/user) → \\wsl$\<distro>\ path via wslpath
   * On non-Windows or already-Windows paths, returns as-is.
   */
  private resolveWslPath(p: string): string {
    if (process.platform !== 'win32') return p;

    // Already a Windows path
    if (/^[A-Za-z]:[\\/]/.test(p)) return p;

    // WSL /mnt/<drive>/... → <DRIVE>:\...
    const mounted = toHostPath(p);
    if (mounted !== p) return mounted;

    // Other Linux paths (e.g., /home/user/...) — use wslpath to convert
    try {
      const winPath = execSync(`wsl.exe wslpath -w "${p}"`, {
        encoding: 'utf-8',
        timeout: 3000,
        windowsHide: true,
      }).trim();
      return winPath || p;
    } catch {
      return p;
    }
  }

  private assertSessionExists(sessionId: string): void {
    if (!this.sessionManager.getSession(sessionId)) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    }
  }
}

function cloneFileManagerConfig(config: FileManagerConfig): FileManagerConfig {
  return {
    maxFileSize: config.maxFileSize,
    maxDirectoryEntries: config.maxDirectoryEntries,
    blockedExtensions: [...config.blockedExtensions],
    blockedPaths: [...config.blockedPaths],
    cwdCacheTtlMs: config.cwdCacheTtlMs,
    maxImageFileSize: config.maxImageFileSize ?? DEFAULT_MAX_IMAGE_FILE_SIZE,
    maxUploadFileSize: config.maxUploadFileSize ?? DEFAULT_MAX_UPLOAD_FILE_SIZE,
    maxExtractBytes: config.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES,
    maxExtractEntries: config.maxExtractEntries ?? DEFAULT_MAX_EXTRACT_ENTRIES,
  };
}

function foldCase(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

function samePath(a: string, b: string): boolean {
  return foldCase(a) === foldCase(b);
}

/** True when child lies strictly under parent. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(foldCase(parent), foldCase(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function commonAncestor(a: string, b: string): string {
  let candidate = a;
  while (!samePath(candidate, b) && !isInside(candidate, b)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

/** FR-FEX-017: the same directory, compared through realpath so symlinks and case agree. */
async function isSamePath(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => {
    try {
      return await fs.realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [ra, rb] = await Promise.all([real(a), real(b)]);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

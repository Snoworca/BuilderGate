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
import type { FileManagerConfig, DirectoryEntry, DirectoryListing, FileContent } from '../types/file.types.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { resolveAndValidate, isBlockedExtension } from '../utils/pathValidator.js';

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
  '.toml': 'text/toml',
  '.ini': 'text/ini',
  '.cfg': 'text/plain',
  '.log': 'text/plain',
  '.env': 'text/plain',
};

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

    // Read directory entries
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const totalEntries = dirents.length + 1; // +1 for ".."

    // Limit entries
    const limited = dirents.slice(0, this.config.maxDirectoryEntries);

    // Build entry list with stats
    const entries: DirectoryEntry[] = [];

    // Add ".." entry (unless at root)
    const parsed = path.parse(dirPath);
    if (parsed.root !== dirPath) {
      entries.push({
        name: '..',
        type: 'directory',
        size: 0,
        modified: new Date().toISOString(),
      });
    }

    for (const dirent of limited) {
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

        entries.push(entry);
      } catch {
        // Skip entries we can't stat (permission errors, etc.)
      }
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

    return {
      path: resolved,
      content,
      size: stat.size,
      encoding: 'utf-8',
      extension: ext,
      mimeType,
    };
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
    const srcResolved = await resolveAndValidate(cwd, source, this.config.blockedPaths);
    const destResolved = await resolveAndValidate(cwd, destination, this.config.blockedPaths);

    // Check source exists
    try {
      await fs.stat(srcResolved);
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
    const resolved = await resolveAndValidate(cwd, filePath, this.config.blockedPaths);

    let stat;
    try {
      stat = await fs.stat(resolved);
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
    const mntMatch = p.match(/^\/mnt\/([a-z])(\/.*)?$/);
    if (mntMatch) {
      const drive = mntMatch[1].toUpperCase();
      const rest = (mntMatch[2] || '').replace(/\//g, '\\');
      return `${drive}:${rest || '\\'}`;
    }

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
    maxCodeFileSize: config.maxCodeFileSize,
    maxDirectoryEntries: config.maxDirectoryEntries,
    blockedExtensions: [...config.blockedExtensions],
    blockedPaths: [...config.blockedPaths],
    cwdCacheTtlMs: config.cwdCacheTtlMs,
  };
}

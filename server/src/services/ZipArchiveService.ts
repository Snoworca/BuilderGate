// FR-FEX-025 (#139): several items or a directory as one ZIP. The pre-count and the archive walk
// the same tree the same way: .git and node_modules are left out, blocked paths and extensions are
// left out, symbolic links are not followed. The archive is written while it streams (yazl,
// deflate level 1), one file open at a time, so neither the archive nor a file is held whole.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import type { Response } from 'express';
import yazl from 'yazl';
import type { ArchiveItem, FileService } from './FileService.js';
import { isTransientFileName } from './FileService.js';
import type { ZipDownloadTarget } from './DownloadTokenStore.js';
import { isBlockedExtension, isPathBlocked } from '../utils/pathValidator.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { contentDisposition } from '../routes/downloadRoutes.js';

/** Left out of every archive and every count (FR-FEX-025 AC-5). */
export const ZIP_EXCLUDED_NAMES: readonly string[] = ['.git', 'node_modules'];
const EXCLUDED = new Set(ZIP_EXCLUDED_NAMES);
const SKIPPED_REPORT_NAME = '_skipped.txt';
const COMPRESSION_LEVEL = 1;

export type ZipJobState = 'pending' | 'streaming' | 'done' | 'cancelled' | 'failed';

export interface ZipJobView {
  state: ZipJobState;
  /** Original (uncompressed) bytes read into the archive so far. */
  sentBytes: number;
  totalBytes: number;
}

export interface ZipPrecount {
  name: string;
  fileCount: number;
  totalBytes: number;
  excluded: string[];
  skippedBlocked: number;
}

interface Job extends ZipJobView {
  sessionId: string;
  createdAt: number;
  finishedAt?: number;
  abort?: () => void;
}

type WalkEvent =
  | { type: 'directory'; entry: string }
  | { type: 'file'; abs: string; entry: string; size: number; mtime: Date }
  | { type: 'blocked' }
  | { type: 'unreadable'; entry: string; reason: string };

export interface ZipArchiveOptions {
  now?: () => number;
  /** Opens a file to archive; tests replace it to make a file unreadable. */
  openForRead?: (filePath: string) => Promise<fs.FileHandle>;
  /** A finished job is forgotten this long after it ends. */
  jobRetentionMs?: number;
  /** A job whose token was never spent is forgotten this long after it was made. */
  pendingTtlMs?: number;
}

function reasonOf(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? (err as Error | null)?.message ?? 'unknown error';
}

export class ZipArchiveService {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => number;
  private readonly openForRead: (filePath: string) => Promise<fs.FileHandle>;
  private readonly jobRetentionMs: number;
  private readonly pendingTtlMs: number;

  constructor(private readonly files: FileService, options: ZipArchiveOptions = {}) {
    this.now = options.now ?? Date.now;
    this.openForRead = options.openForRead ?? ((filePath) => fs.open(filePath, 'r'));
    this.jobRetentionMs = options.jobRetentionMs ?? 60_000;
    this.pendingTtlMs = options.pendingTtlMs ?? 120_000;
  }

  /** FR-FEX-025 AC-2: what the archive would hold, without reading any file. */
  async precount(sessionId: string, paths: readonly string[]): Promise<ZipPrecount> {
    const selection = await this.files.resolveArchiveSelection(sessionId, paths);
    let fileCount = 0;
    let totalBytes = 0;
    let skippedBlocked = 0;
    for await (const event of this.walk(selection.items)) {
      if (event.type === 'file') {
        fileCount += 1;
        totalBytes += event.size;
      } else if (event.type === 'blocked') {
        skippedBlocked += 1;
      }
    }
    return { name: selection.name, fileCount, totalBytes, excluded: [...ZIP_EXCLUDED_NAMES], skippedBlocked };
  }

  createJob(sessionId: string, totalBytes: number): string {
    this.sweep();
    const jobId = randomBytes(12).toString('base64url');
    this.jobs.set(jobId, { sessionId, state: 'pending', sentBytes: 0, totalBytes, createdAt: this.now() });
    return jobId;
  }

  getJob(sessionId: string, jobId: string): ZipJobView | null {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (job === undefined || job.sessionId !== sessionId) return null;
    return { state: job.state, sentBytes: job.sentBytes, totalBytes: job.totalBytes };
  }

  /** FR-FEX-025 AC-6: ends the stream (or the download that has not started) and marks it cancelled. */
  cancelJob(sessionId: string, jobId: string): boolean {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (job === undefined || job.sessionId !== sessionId) return false;
    if (job.state === 'streaming' && job.abort) {
      job.abort();
    } else if (job.state === 'pending') {
      this.finish(job, 'cancelled');
    }
    return true;
  }

  /**
   * FR-FEX-025 AC-3..AC-6: resolves the token's paths again (throwing the file API's error before
   * any byte is sent), then streams the archive into the response.
   */
  async stream(target: ZipDownloadTarget, res: Response): Promise<void> {
    const job = this.jobs.get(target.jobId);
    if (job === undefined || job.state !== 'pending') throw new AppError(ErrorCode.DOWNLOAD_TOKEN_INVALID);
    let items: ArchiveItem[];
    try {
      items = (await this.files.resolveArchiveSelection(target.sessionId, target.paths)).items;
    } catch (err) {
      this.finish(job, 'failed');
      throw err;
    }
    job.state = 'streaming';
    res.status(200);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(target.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });

    const zip = new yazl.ZipFile();
    const skipped: string[] = [];
    let stopped = false;
    let current: { source: NodeJS.ReadableStream & { destroy(): void }; release: () => void } | null = null;
    const stop = (state: ZipJobState): void => {
      if (stopped) return;
      stopped = true;
      this.finish(job, state);
      zip.outputStream.unpipe(res);
      current?.source.destroy();
      current?.release();
      res.destroy();
    };
    job.abort = () => stop('cancelled');
    // A closed connection (the browser's own cancel, a lost network) ends the job too.
    res.on('close', () => {
      if (!res.writableFinished) stop('cancelled');
    });
    zip.outputStream.on('error', (err) => {
      console.error('[ZipArchive] Archive stream failed:', (err as Error).message);
      stop('failed');
    });
    zip.outputStream.pipe(res);

    try {
      for await (const event of this.walk(items)) {
        if (stopped) return;
        if (event.type === 'directory') {
          zip.addEmptyDirectory(event.entry);
        } else if (event.type === 'unreadable') {
          skipped.push(`${event.entry}\t${event.reason}`);
        } else if (event.type === 'file') {
          let handle: fs.FileHandle;
          try {
            handle = await this.openForRead(event.abs);
          } catch (err) {
            skipped.push(`${event.entry}\t${reasonOf(err)}`);
            continue;
          }
          if (stopped) {
            await handle.close().catch(() => undefined);
            return;
          }
          const source = handle.createReadStream();
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              job.sentBytes += chunk.length;
              callback(null, chunk);
            },
          });
          // A read that fails part-way keeps what was read and says so in the report.
          source.on('error', (err) => {
            skipped.push(`${event.entry}\t${reasonOf(err)} (partial)`);
            counter.end();
          });
          source.pipe(counter);
          await new Promise<void>((resolve) => {
            current = { source, release: resolve };
            counter.once('end', resolve);
            counter.once('error', () => resolve());
            zip.addReadStreamLazy(event.entry, { mtime: event.mtime, compressionLevel: COMPRESSION_LEVEL }, (cb) => cb(null, counter));
          });
          current = null;
        }
      }
      if (stopped) return;
      if (skipped.length > 0) {
        zip.addBuffer(Buffer.from(`${skipped.join('\n')}\n`, 'utf8'), SKIPPED_REPORT_NAME, { compressionLevel: COMPRESSION_LEVEL });
      }
      zip.end();
      await new Promise<void>((resolve) => {
        if (res.writableFinished) resolve();
        res.once('finish', () => resolve());
        res.once('close', () => resolve());
      });
      if (!stopped && res.writableFinished) {
        stopped = true;
        this.finish(job, 'done');
      }
    } catch (err) {
      console.error('[ZipArchive] Archive failed:', (err as Error).message);
      stop('failed');
    }
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.abort?.();
    this.jobs.clear();
  }

  private finish(job: Job, state: ZipJobState): void {
    job.state = state;
    job.finishedAt = this.now();
    job.abort = undefined;
  }

  private sweep(): void {
    const now = this.now();
    for (const [jobId, job] of this.jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt > this.jobRetentionMs) this.jobs.delete(jobId);
      else if (job.state === 'pending' && now - job.createdAt > this.pendingTtlMs) this.jobs.delete(jobId);
    }
  }

  private async *walk(items: readonly ArchiveItem[]): AsyncGenerator<WalkEvent> {
    for (const item of items) {
      // A selected link is not followed either (AC-5).
      if (item.kind === 'directory') {
        yield* this.walkDirectory(item.path, item.entryName);
      } else if (item.kind === 'file') {
        const stat = await fs.lstat(item.path).catch((err: unknown) => err as Error);
        if (stat instanceof Error) yield { type: 'unreadable', entry: item.entryName, reason: reasonOf(stat) };
        else yield { type: 'file', abs: item.path, entry: item.entryName, size: stat.size, mtime: stat.mtime };
      }
    }
  }

  private async *walkDirectory(abs: string, entry: string): AsyncGenerator<WalkEvent> {
    yield { type: 'directory', entry };
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      yield { type: 'unreadable', entry: `${entry}/`, reason: reasonOf(err) };
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const { blockedPaths, blockedExtensions } = this.files.blockRules;
    for (const dirent of dirents) {
      if (EXCLUDED.has(process.platform === 'win32' ? dirent.name.toLowerCase() : dirent.name)) continue;
      if (isTransientFileName(dirent.name) || dirent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, dirent.name);
      const childEntry = `${entry}/${dirent.name}`;
      if (isPathBlocked(childAbs, blockedPaths)) {
        yield { type: 'blocked' };
        continue;
      }
      if (dirent.isDirectory()) {
        yield* this.walkDirectory(childAbs, childEntry);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isBlockedExtension(path.extname(dirent.name), [...blockedExtensions])) {
        yield { type: 'blocked' };
        continue;
      }
      const stat = await fs.lstat(childAbs).catch((err: unknown) => err as Error);
      if (stat instanceof Error) yield { type: 'unreadable', entry: childEntry, reason: reasonOf(stat) };
      else yield { type: 'file', abs: childAbs, entry: childEntry, size: stat.size, mtime: stat.mtime };
    }
  }
}

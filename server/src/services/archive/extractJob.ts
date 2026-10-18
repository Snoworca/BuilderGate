// FR-FOP-007 (#140), FR-FEX-027 AC-2, AC-3: archive extraction as a file job.
//
// Two passes over the archive. The pre-count reads every header (for a gzip tar that is the whole
// stream) and refuses the archive before anything is written: too many entries, too many bytes,
// an unpacked-to-packed ratio over 1000, an encrypted or split ZIP, a damaged archive. The second
// pass writes: each file entry streams into a hidden upload temp file in its destination folder,
// is held to its declared size, and is placed only when complete — exclusively unless the user
// chose to overwrite. Entries that are unsafe (a path out of the target, a forbidden name, a link,
// a device, a blocked path) are not written and are reported in the result's skipped list rather
// than asked about one by one.
//
// smart puts the entries in one new folder next to the archive: the archive's single top folder
// when there is one, otherwise a folder named after the archive; an existing name takes the
// FR-FOP-004 '(2)' name. here writes into the archive's folder and asks about each existing name
// with the copy job's questions (overwrite, rename, skip; a file and a folder meeting: rename, skip).
//
// Cancelling stops the current entry, deletes its temp file and keeps the entries already placed
// (FR-FOP-005).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveNameCollision } from '../fileNameCollision.js';
import { newUploadTempName, type UploadTempRegistry } from '../upload/uploadTemp.js';
import { placeExclusively } from '../upload/placeExclusively.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { transition, type FileJobState } from '../fileJobs/fileJobState.js';
import type {
  FileJobConflictChoice,
  FileJobProgress,
  FileJobResult,
  FileJobRunnerDeps,
  FileJobSpec,
} from '../fileJobs/fileJobRunner.js';
import { ARCHIVE_ENTRY_REFUSAL, normalizeEntryPath } from './archiveEntryName.js';
import { archiveError, archiveFormatOf, archiveStem, forEachArchiveEntry, packedSize, type ArchiveEntry, type ArchiveFormat } from './archiveReader.js';

/** AC-4: an archive that unpacks to more than this many times its own size is refused... */
export const MAX_EXTRACT_RATIO = 1000;
/** ...once it unpacks to more than this; a small archive of zeros or logs is no threat to the disk. */
export const EXTRACT_RATIO_FLOOR_BYTES = 64 * 1024 * 1024;

const CONFLICT_CHOICES: readonly FileJobConflictChoice[] = Object.freeze(['overwrite', 'rename', 'skip']);
const KIND_MISMATCH_CHOICES: readonly FileJobConflictChoice[] = Object.freeze(['rename', 'skip']);

// @req FR-FOP-007
export interface ArchiveJobDeps {
  limits(): { maxBytes: number; maxEntries: number };
  /** True for a file name whose extension the file API blocks. */
  isBlockedExtension(name: string): boolean;
  /** Where in-flight temp files are recorded so a restart can delete them (FR-FEX-023 AC-6). */
  tempRegistry?: UploadTempRegistry;
  /** Test seam: runs between the pre-count and the write pass. */
  afterPrecount?: (archivePath: string) => Promise<void>;
}

/** The skipped list keeps this many entries; the rest are only counted. */
export const EXTRACT_SKIPPED_LIMIT = 1000;
/** A reported entry name is cut to this many characters. */
export const EXTRACT_SKIPPED_NAME_LIMIT = 512;

export interface ArchivePrecount {
  format: ArchiveFormat;
  entryCount: number;
  unpackedBytes: number;
  packedBytes: number;
  /** The one top-level folder every entry lies under, or null. */
  singleTopFolder: string | null;
  /** The archive name without its extension. */
  stem: string;
}

export interface ExtractSkip {
  /** The entry's name as the archive holds it. */
  path: string;
  reason: string;
}

/**
 * AC-4, AC-5: reads every header and refuses the archive before anything is written. onEntry is
 * called per entry so a job can show the count growing.
 */
// @req FR-FOP-007
export async function precountArchive(
  archivePath: string,
  limits: { maxBytes: number; maxEntries: number },
  onEntry?: (entryCount: number) => void,
  signal?: AbortSignal,
): Promise<ArchivePrecount> {
  const name = path.basename(archivePath);
  const format = archiveFormatOf(name);
  if (format === null) throw archiveError(ErrorCode.ARCHIVE_UNSUPPORTED, 'only .zip, .tar, .tar.gz and .tgz archives are supported');
  const packedBytes = await packedSize(archivePath);
  let entryCount = 0;
  let unpackedBytes = 0;
  let top: string | null = null;
  let single = true;
  await forEachArchiveEntry(archivePath, format, async (entry) => {
    if (signal?.aborted) throw abortError();
    if (entry.unsupported !== null) throw archiveError(ErrorCode.ARCHIVE_UNSUPPORTED, entry.unsupported);
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      throw archiveError(ErrorCode.ARCHIVE_TOO_LARGE, `the archive holds more than ${limits.maxEntries} entries`);
    }
    // Every entry's declared size counts, whatever its kind: the limits bound what the archive
    // carries, not only what this extraction happens to write.
    unpackedBytes += entry.size;
    if (unpackedBytes > limits.maxBytes) {
      throw archiveError(ErrorCode.ARCHIVE_TOO_LARGE, `the archive unpacks to more than ${limits.maxBytes} bytes`);
    }
    const normalized = normalizeEntryPath(entry.name);
    if (normalized.kind === 'path') {
      const first = normalized.segments[0];
      const under = normalized.segments.length > 1 || entry.kind === 'directory' || normalized.isDirectory;
      if (!under || (top !== null && top !== first)) single = false;
      top = first;
    }
    onEntry?.(entryCount);
  });
  if (unpackedBytes > EXTRACT_RATIO_FLOOR_BYTES && packedBytes > 0 && unpackedBytes / packedBytes > MAX_EXTRACT_RATIO) {
    throw archiveError(ErrorCode.ARCHIVE_TOO_LARGE, `the unpacked size is more than ${MAX_EXTRACT_RATIO} times the archive size (compression ratio)`);
  }
  return { format, entryCount, unpackedBytes, packedBytes, singleTopFolder: single ? top : null, stem: archiveStem(name) };
}

function abortError(): Error {
  const err = new Error('The operation was aborted') as Error & { code: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s: string): string => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);

/** Raised when an entry produced more bytes than it declared (AC-4). */
function overflowError(): AppError {
  return archiveError(ErrorCode.ARCHIVE_TOO_LARGE, 'an entry is larger than the archive says it is');
}

class ExtractRun {
  private state: FileJobState = 'queued';
  private phase: FileJobProgress['phase'] = 'scanning';
  private totalEntries = 0;
  private totalBytes = 0;
  private processedEntries = 0;
  private processedBytes = 0;
  private readonly skipped: ExtractSkip[] = [];
  private skippedCount = 0;
  /** What the pre-count found; the write pass may not go past it (AC-4). */
  private countedEntries = Infinity;
  private countedBytes = Infinity;
  private seenEntries = 0;
  private writtenBytes = 0;
  private readonly createdPaths: string[] = [];
  /** Archive-relative folder (folded) -> where it really is. */
  private readonly folders = new Map<string, string>();
  /** Archive-relative folders the user chose to skip, with everything under them. */
  private readonly skippedFolders = new Set<string>();
  private readonly folderTimes: Array<{ path: string; mtime: Date; depth: number }> = [];

  constructor(private readonly spec: FileJobSpec, private readonly deps: FileJobRunnerDeps, private readonly archive: ArchiveJobDeps) {}

  async run(): Promise<FileJobResult> {
    this.moveTo('running');
    try {
      const archivePath = this.spec.sources[0];
      const destDir = this.spec.destDir ?? path.dirname(archivePath);
      if (this.spec.sources.length !== 1) throw new AppError(ErrorCode.INVALID_INPUT, 'extract takes exactly one archive');
      this.report(null);
      const counted = await precountArchive(archivePath, this.archive.limits(), (n) => {
        this.totalEntries = n;
        this.report(null);
      }, this.deps.signal);
      this.totalEntries = counted.entryCount;
      this.totalBytes = counted.unpackedBytes;
      this.countedEntries = counted.entryCount;
      this.countedBytes = counted.unpackedBytes;
      await this.archive.afterPrecount?.(archivePath);
      this.phase = 'transferring';
      this.report(null);

      const mode = this.spec.mode ?? 'smart';
      let root: string;
      let strip = false;
      if (mode === 'smart') {
        strip = counted.singleTopFolder !== null;
        root = await this.createUniqueFolder(destDir, counted.singleTopFolder ?? counted.stem);
        this.createdPaths.push(root);
      } else {
        root = destDir;
      }
      this.folders.set('', root);

      await forEachArchiveEntry(archivePath, counted.format, (entry, open) => this.extractEntry(entry, open, mode, strip));
      await this.restoreFolderTimes();
      this.moveTo('completed');
      return this.result('completed');
    } catch (error) {
      if (this.deps.signal?.aborted) {
        this.moveTo('cancelled');
        return this.result('cancelled');
      }
      this.moveTo('failed');
      return { ...this.result('failed'), error };
    }
  }

  private result(outcome: FileJobResult['outcome']): FileJobResult {
    return {
      outcome,
      processedEntries: this.processedEntries,
      skipped: [...this.skipped],
      skippedCount: this.skippedCount,
      createdPaths: [...this.createdPaths],
    };
  }

  private moveTo(to: FileJobState): void {
    const result = transition(this.state, to);
    if ('ignored' in result) return;
    this.state = result.next;
    this.deps.onStateChange?.(this.state);
  }

  private throwIfAborted(): void {
    if (this.deps.signal?.aborted) throw abortError();
  }

  private report(currentPath: string | null): void {
    this.deps.onProgress({
      phase: this.phase,
      processedBytes: this.phase === 'scanning' ? 0 : Math.min(this.processedBytes, this.totalBytes),
      totalBytes: this.totalBytes,
      processedEntries: this.processedEntries,
      totalEntries: this.totalEntries,
      currentPath,
    });
  }

  private skip(entry: ArchiveEntry, reason: string): void {
    this.noteSkipped(entry, reason);
    this.done(entry);
  }

  /** Keeps the first EXTRACT_SKIPPED_LIMIT names, cut short; counts every one. */
  private noteSkipped(entry: ArchiveEntry, reason: string): void {
    this.skippedCount += 1;
    if (this.skipped.length < EXTRACT_SKIPPED_LIMIT) this.skipped.push({ path: entry.name.slice(0, EXTRACT_SKIPPED_NAME_LIMIT), reason });
  }

  /** The entry is finished (written, skipped or refused): it counts toward the bar. */
  private done(entry: ArchiveEntry, written = 0): void {
    this.processedEntries += 1;
    this.processedBytes += entry.size - written;
    this.report(null);
  }

  private async ask(kind: 'conflict', target: string, choices: readonly FileJobConflictChoice[]): Promise<FileJobConflictChoice> {
    this.moveTo('awaiting-decision');
    try {
      const pending = this.deps.decide({ kind, path: target, choices });
      const signal = this.deps.signal;
      const { choice } = signal
        ? await new Promise<{ choice: FileJobConflictChoice }>((resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          const onAbort = (): void => reject(abortError());
          signal.addEventListener('abort', onAbort, { once: true });
          pending.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); });
        })
        : await pending;
      if (!choices.includes(choice)) throw new AppError(ErrorCode.INVALID_INPUT, `Unknown conflict choice: ${String(choice)}`);
      return choice;
    } finally {
      if (this.state === 'awaiting-decision') this.moveTo(this.deps.signal?.aborted ? 'cancelled' : 'running');
    }
  }

  private async createUniqueFolder(parent: string, name: string): Promise<string> {
    for (;;) {
      this.throwIfAborted();
      const taken = new Set((await fsp.readdir(parent)).map(fold));
      const target = path.join(parent, resolveNameCollision(name, (candidate) => taken.has(fold(candidate))));
      await this.deps.validatePath(target);
      try {
        await fsp.mkdir(target);
        return target;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }

  private async extractEntry(entry: ArchiveEntry, open: () => Promise<Readable>, mode: 'smart' | 'here', strip: boolean): Promise<void> {
    this.throwIfAborted();
    // AC-4: the archive changed after the pre-count (more entries than were counted and checked).
    this.seenEntries += 1;
    if (this.seenEntries > this.countedEntries) {
      throw archiveError(ErrorCode.ARCHIVE_TOO_LARGE, 'the archive holds more than the pre-count found');
    }
    const normalized = normalizeEntryPath(entry.name);
    if (normalized.kind === 'refused') return this.skip(entry, normalized.reason);
    if (entry.kind === 'symlink' || entry.kind === 'hardlink') return this.skip(entry, ARCHIVE_ENTRY_REFUSAL.link);
    if (entry.kind !== 'file' && entry.kind !== 'directory') return this.skip(entry, ARCHIVE_ENTRY_REFUSAL.special);
    let segments = normalized.kind === 'root' ? [] : normalized.segments;
    if (strip) segments = segments.slice(1);
    const isDirectory = entry.kind === 'directory';

    // AC-3: blocked paths and extensions, judged on where the entry would land.
    const landing = path.join(this.folders.get('')!, ...segments);
    if (segments.length > 0 && (this.deps.isBlocked?.(landing) === true || (!isDirectory && this.archive.isBlockedExtension(segments[segments.length - 1])))) {
      return this.skip(entry, ARCHIVE_ENTRY_REFUSAL.blocked);
    }

    if (isDirectory) {
      const folder = await this.ensureFolder(segments, mode, entry);
      // The target folder itself keeps its time when extracting here: it is the user's folder.
      if (folder !== null && entry.mtime !== null && (segments.length > 0 || mode === 'smart')) this.folderTimes.push({ path: folder, mtime: entry.mtime, depth: segments.length });
      return this.done(entry);
    }
    const parent = await this.ensureFolder(segments.slice(0, -1), mode, entry);
    if (parent === null) return this.done(entry);
    await this.writeFile(entry, open, parent, segments[segments.length - 1], mode);
  }

  /**
   * The real folder for archive-relative segments, created as needed. Null when the user skipped it
   * (or, in smart mode, a file of that name came first in the archive).
   */
  private async ensureFolder(segments: string[], mode: 'smart' | 'here', entry: ArchiveEntry): Promise<string | null> {
    let current = this.folders.get('')!;
    for (let i = 0; i < segments.length; i += 1) {
      const key = fold(segments.slice(0, i + 1).join('/'));
      if (this.skippedFolders.has(key)) return null;
      const known = this.folders.get(key);
      if (known !== undefined) {
        current = known;
        continue;
      }
      let candidate = path.join(current, segments[i]);
      for (;;) {
        this.throwIfAborted();
        // lstat before the path check: an existing link is a name taken, never a way through, and
        // the check would refuse the whole job for a link that points out of the session.
        const existing = await fsp.lstat(candidate).catch(() => null);
        if (existing === null) {
          await this.deps.validatePath(candidate);
          try {
            await fsp.mkdir(candidate);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
          }
          if (mode === 'here' && i === 0) this.noteCreated(candidate);
          break;
        }
        if (existing.isDirectory()) {
          await this.deps.validatePath(candidate);
          if (mode === 'here' && i === 0) this.noteCreated(candidate);
          break;
        }
        // A file or a link where a folder of the archive goes. A link is never followed.
        if (mode === 'smart') {
          this.skippedFolders.add(key);
          this.noteSkipped(entry, ARCHIVE_ENTRY_REFUSAL.kindMismatch);
          return null;
        }
        const choice = await this.ask('conflict', candidate, KIND_MISMATCH_CHOICES);
        if (choice === 'skip') {
          this.skippedFolders.add(key);
          return null;
        }
        candidate = await this.freeSiblingName(candidate);
      }
      this.folders.set(key, candidate);
      current = candidate;
    }
    return current;
  }

  private noteCreated(p: string): void {
    if (this.createdPaths.length === 0) this.createdPaths.push(p);
  }

  private async freeSiblingName(target: string): Promise<string> {
    const parent = path.dirname(target);
    const taken = new Set((await fsp.readdir(parent)).map(fold));
    return path.join(parent, resolveNameCollision(path.basename(target), (name) => taken.has(fold(name))));
  }

  private async writeFile(entry: ArchiveEntry, open: () => Promise<Readable>, parent: string, leaf: string, mode: 'smart' | 'here'): Promise<void> {
    let target = path.join(parent, leaf);
    let replace = false;
    for (;;) {
      this.throwIfAborted();
      const existing = await fsp.lstat(target).catch(() => null);
      if (existing === null) {
        await this.deps.validatePath(target);
        break;
      }
      if (mode === 'smart') return this.skip(entry, ARCHIVE_ENTRY_REFUSAL.duplicate);
      const choice = await this.ask('conflict', target, existing.isFile() ? CONFLICT_CHOICES : KIND_MISMATCH_CHOICES);
      if (choice === 'skip') return this.done(entry);
      if (choice === 'overwrite') {
        // Only offered for a regular file; a link at the name is never replaced through.
        await this.deps.validatePath(target);
        replace = true;
        break;
      }
      target = await this.freeSiblingName(target);
    }

    const temp = path.join(parent, newUploadTempName());
    await this.deps.validatePath(temp);
    const registry = this.archive.tempRegistry;
    await registry?.add(temp);
    let written = 0;
    try {
      const declared = entry.size;
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          written += chunk.length;
          this.writtenBytes += chunk.length;
          if (written > declared || this.writtenBytes > this.countedBytes) {
            callback(overflowError());
            return;
          }
          this.processedBytes += chunk.length;
          this.report(target);
          callback(null, chunk);
        },
      });
      let source: Readable;
      try {
        source = await open();
      } catch (err) {
        throw err instanceof AppError ? err : archiveError(ErrorCode.ARCHIVE_CORRUPT, 'an entry could not be read');
      }
      const sink = fs.createWriteStream(temp, { flags: 'wx' });
      try {
        // Read through async iteration: the tar entry is a streamx stream, which node's pipeline does
        // not treat as one of its own.
        const chunks = (async function* () {
          for await (const chunk of source as AsyncIterable<Buffer>) yield chunk;
        })();
        await pipeline(chunks, counter, sink, this.deps.signal ? { signal: this.deps.signal } : {});
      } catch (err) {
        if (!sink.closed) await once(sink, 'close').catch(() => undefined);
        if (this.deps.signal?.aborted) throw abortError();
        if (err instanceof AppError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        // A file system error is the job's error; anything else came from reading the archive.
        if (typeof code === 'string' && /^E[A-Z]+$/.test(code) && code !== 'ERR_STREAM_PREMATURE_CLOSE') throw err;
        throw archiveError(ErrorCode.ARCHIVE_CORRUPT, 'an entry could not be read');
      }
      if (written < declared) throw archiveError(ErrorCode.ARCHIVE_CORRUPT, 'an entry is shorter than the archive says it is');

      if (replace) {
        await fsp.rename(temp, target);
      } else {
        try {
          target = await placeExclusively(temp, target, false);
        } catch (err) {
          // Taken while the bytes arrived: in smart mode it is a duplicate, here it is a new rename.
          if (!(err instanceof AppError && err.code === ErrorCode.FILE_ALREADY_EXISTS)) throw err;
          if (mode === 'smart') {
            this.noteSkipped(entry, ARCHIVE_ENTRY_REFUSAL.duplicate);
          } else {
            target = await placeExclusively(temp, await this.freeSiblingName(target), true);
          }
        }
        await fsp.unlink(temp).catch(() => undefined);
      }
      if (entry.mtime !== null) await fsp.utimes(target, entry.mtime, entry.mtime).catch(() => undefined);
      if (mode === 'here' && path.dirname(target) === this.folders.get('')) this.noteCreated(target);
      await registry?.remove(temp);
      this.done(entry, written);
    } catch (err) {
      this.processedBytes -= written;
      await fsp.unlink(temp).catch(() => undefined);
      await registry?.remove(temp);
      throw err;
    }
  }

  private async restoreFolderTimes(): Promise<void> {
    // Deepest first: setting a child's time does not change its parent's, but writing into a folder does.
    for (const { path: folder, mtime } of this.folderTimes.sort((a, b) => b.depth - a.depth)) {
      await fsp.utimes(folder, mtime, mtime).catch(() => undefined);
    }
  }
}

// @req FR-FOP-007
export function runExtractJob(spec: FileJobSpec, deps: FileJobRunnerDeps): Promise<FileJobResult> {
  const archive = deps.archive;
  if (archive === undefined) return Promise.resolve({ outcome: 'failed', processedEntries: 0, error: new AppError(ErrorCode.INTERNAL_ERROR, 'extraction is not configured') });
  return new ExtractRun(spec, deps, archive).run();
}

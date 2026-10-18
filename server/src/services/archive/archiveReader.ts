// FR-FOP-007 (#140): reads .zip, .tar, .tar.gz and .tgz archives as one sequence of entries. ZIP
// through yauzl (the central directory, then one entry's data at a time), tar through tar-stream
// behind a gunzip when compressed. Entry names come out decoded but not judged; the extractor
// decides what may be written. Archive-level failures become AppErrors with a public reason.
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import tar from 'tar-stream';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { decodeZipEntryName } from './archiveEntryName.js';

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

/** The format an archive name says it is, or null. */
export function archiveFormatOf(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

/** The archive name without its archive extension: 'bundle.tar.gz' -> 'bundle'. */
export function archiveStem(fileName: string): string {
  const stem = fileName.replace(/(\.tar\.gz|\.tgz|\.tar|\.zip)$/i, '');
  return stem === '' ? fileName : stem;
}

export interface ArchiveEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'hardlink' | 'device' | 'fifo' | 'other';
  /** The uncompressed size the archive declares. */
  size: number;
  mtime: Date | null;
  /** Why this entry cannot be read at all (encryption, compression method), or null. */
  unsupported: string | null;
}

/** An AppError whose reason is safe to show: it names no path. */
export function archiveError(code: ErrorCode, reason: string): AppError {
  return Object.assign(new AppError(code, reason), { publicReason: reason });
}

export function isArchiveError(err: unknown): err is AppError & { publicReason: string } {
  return err instanceof AppError && typeof (err as { publicReason?: unknown }).publicReason === 'string';
}

function corrupt(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return archiveError(ErrorCode.ARCHIVE_CORRUPT, `the archive could not be read (${(err as Error)?.message ?? 'unknown error'})`.slice(0, 200));
}

/**
 * Visits every entry in order. `open` gives the entry's data once; a visitor that does not open it
 * (a directory, a skipped entry) leaves it unread. Stops early when the visitor throws.
 */
export async function forEachArchiveEntry(
  archivePath: string,
  format: ArchiveFormat,
  visit: (entry: ArchiveEntry, open: () => Promise<Readable>) => Promise<void>,
): Promise<void> {
  if (format === 'zip') await forEachZipEntry(archivePath, visit);
  else await forEachTarEntry(archivePath, format === 'tar.gz', visit);
}

// ── ZIP ───────────────────────────────────────────────────────────────────

const S_IFMT = 0o170000;

function zipEntryKind(entry: yauzl.Entry, name: string): ArchiveEntry['kind'] {
  // Unix mode bits sit in the high half of the external attributes when the entry was made on Unix.
  const madeOnUnix = entry.versionMadeBy >> 8 === 3;
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  if (madeOnUnix && mode !== 0) {
    if (mode === 0o120000) return 'symlink';
    if (mode === 0o020000 || mode === 0o060000) return 'device';
    if (mode === 0o010000) return 'fifo';
    if (mode === 0o140000) return 'other';
    if (mode === 0o040000) return 'directory';
  }
  return name.endsWith('/') || name.endsWith('\\') ? 'directory' : 'file';
}

function zipUnsupported(entry: yauzl.Entry): string | null {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) return 'the archive is encrypted';
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) return `compression method ${entry.compressionMethod} is not supported`;
  return null;
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: false, validateEntrySizes: false, autoClose: false }, (err, zipfile) => {
      if (err) {
        if (/multi-disk/i.test(err.message)) reject(archiveError(ErrorCode.ARCHIVE_UNSUPPORTED, 'split (multi-disk) ZIP archives are not supported'));
        else reject(corrupt(err));
        return;
      }
      resolve(zipfile);
    });
  });
}

async function forEachZipEntry(archivePath: string, visit: (entry: ArchiveEntry, open: () => Promise<Readable>) => Promise<void>): Promise<void> {
  const zipfile = await openZip(archivePath);
  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (err: unknown): void => {
        if (failed) return;
        failed = true;
        reject(err);
      };
      zipfile.on('error', (err) => fail(corrupt(err)));
      zipfile.on('end', () => {
        if (!failed) resolve();
      });
      zipfile.on('entry', (raw: yauzl.Entry) => {
        const name = decodeZipEntryName(raw.fileNameRaw ?? (raw.fileName as unknown as Buffer), raw.generalPurposeBitFlag, raw.extraFields);
        let mtime: Date | null = null;
        try {
          mtime = raw.getLastModDate();
        } catch {
          mtime = null;
        }
        const entry: ArchiveEntry = { name, kind: zipEntryKind(raw, name), size: raw.uncompressedSize, mtime, unsupported: zipUnsupported(raw) };
        const open = (): Promise<Readable> => new Promise((resolveOpen, rejectOpen) => {
          zipfile.openReadStream(raw, (err, stream) => {
            if (err || !stream) rejectOpen(corrupt(err));
            else resolveOpen(stream);
          });
        });
        visit(entry, open).then(() => {
          if (!failed) zipfile.readEntry();
        }, fail);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
}

// ── tar ───────────────────────────────────────────────────────────────────

function tarEntryKind(type: tar.Header['type'] | undefined): ArchiveEntry['kind'] {
  switch (type) {
    case 'file':
    case 'contiguous-file':
    case undefined:
      return 'file';
    case 'directory':
      return 'directory';
    case 'symlink':
      return 'symlink';
    case 'link':
      return 'hardlink';
    case 'character-device':
    case 'block-device':
      return 'device';
    case 'fifo':
      return 'fifo';
    default:
      return 'other';
  }
}

async function forEachTarEntry(
  archivePath: string,
  gzip: boolean,
  visit: (entry: ArchiveEntry, open: () => Promise<Readable>) => Promise<void>,
): Promise<void> {
  const source = fs.createReadStream(archivePath);
  const extract = tar.extract();
  const fail = (err: unknown): void => {
    extract.destroy(corrupt(err) as Error);
  };
  source.on('error', fail);
  if (gzip) {
    const gunzip = zlib.createGunzip();
    gunzip.on('error', fail);
    source.pipe(gunzip).pipe(extract as unknown as NodeJS.WritableStream);
  } else {
    source.pipe(extract as unknown as NodeJS.WritableStream);
  }
  try {
    for await (const stream of extract) {
      const header = stream.header;
      const entry: ArchiveEntry = {
        name: header.name,
        kind: tarEntryKind(header.type),
        size: header.size ?? 0,
        mtime: header.mtime ?? null,
        unsupported: null,
      };
      // The next entry comes only after this one's data is read through, opened or not.
      const finished = new Promise<void>((resolve) => {
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
        stream.once('error', () => resolve());
      });
      await visit(entry, async () => stream as unknown as Readable);
      stream.resume();
      await finished;
    }
  } catch (err) {
    throw err instanceof AppError ? err : corrupt(err);
  } finally {
    source.destroy();
    if (!extract.destroyed) extract.destroy();
  }
}

/** The archive's size on disk, for the unpacked-to-packed ratio. */
export async function packedSize(archivePath: string): Promise<number> {
  return (await fs.promises.stat(archivePath)).size;
}

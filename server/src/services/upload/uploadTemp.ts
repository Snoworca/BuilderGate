// FR-FEX-023 (#139): an upload writes into a hidden temporary file in the destination folder and
// renames it into place after the last byte. This module names those files, checks the relative
// path a folder upload sends, and keeps the record of temp files in flight so that a restart can
// delete what a crash left behind (AC-6).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const UPLOAD_TEMP_NAME = /^\.bgupload-[0-9a-f]{16}\.part$/;

/** True for a name this module hands out; the listing and the search hide these (AC-5). */
export function isUploadTempName(name: string): boolean {
  return UPLOAD_TEMP_NAME.test(name);
}

export function newUploadTempName(): string {
  return `.bgupload-${randomBytes(8).toString('hex')}.part`;
}

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9: Win32 opens a device for these, whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The segments of a folder upload's relative path, or null when it must be refused with
 * INVALID_UPLOAD_PATH (AC-3): empty, '.', '..', an absolute or drive-qualified start, a ':'
 * (a drive or an NTFS stream), a NUL, a trailing dot or space, or a Windows reserved device name. The check is the same
 * on every host, so a path that would misbehave on Windows is refused on Linux too.
 */
export function validateUploadRelativePath(relativePath: string): string[] | null {
  if (relativePath === '' || relativePath.includes('\u0000') || relativePath.includes(':')) return null;
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) return null;
  const segments = relativePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    // Win32 drops trailing dots and spaces, so 'tool.exe.' would land as 'tool.exe' past the
    // extension check. Refused on every host, like the rest of these rules.
    if (/[. ]$/.test(segment)) return null;
    // The device name is the part before the first dot.
    const device = segment.split('.')[0];
    if (WINDOWS_RESERVED.test(device)) return null;
    if (isUploadTempName(segment)) return null;
  }
  return segments;
}

/**
 * The temp files of the uploads in flight, mirrored to a JSON file. Writes are queued so the file
 * always ends in the latest state.
 */
export class UploadTempRegistry {
  private readonly paths = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  list(): string[] {
    return [...this.paths];
  }

  add(tempPath: string): Promise<void> {
    this.paths.add(tempPath);
    return this.persist();
  }

  remove(tempPath: string): Promise<void> {
    if (!this.paths.delete(tempPath)) return this.queue;
    return this.persist();
  }

  /**
   * At startup: delete every recorded temp file and empty the record. Only a path whose name is
   * an upload temp name is deleted, so a damaged or edited record cannot remove a user's file.
   */
  async cleanupStale(): Promise<string[]> {
    let recorded: unknown = [];
    try {
      recorded = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[Upload] The upload temp record could not be read:', (err as Error).message);
      }
    }
    const removed: string[] = [];
    for (const entry of Array.isArray(recorded) ? recorded : []) {
      if (typeof entry !== 'string' || !isUploadTempName(path.basename(entry))) continue;
      try {
        await fs.unlink(entry);
        removed.push(entry);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[Upload] A stale upload temp file could not be deleted:', entry, (err as Error).message);
        }
      }
    }
    this.paths.clear();
    if (Array.isArray(recorded) && recorded.length > 0) await this.persist();
    return removed;
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      const snapshot = JSON.stringify(this.list());
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const next = `${this.filePath}.${process.pid}.tmp`;
        await fs.writeFile(next, snapshot, 'utf8');
        await fs.rename(next, this.filePath);
      } catch (err) {
        console.warn('[Upload] The upload temp record could not be written:', (err as Error).message);
      }
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }
}

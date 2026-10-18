// FR-FOP-007 AC-2, AC-6 (#140): an archive entry's name is chosen by whoever made the archive. This
// module turns the raw name into path segments under the target folder, or into the reason it is not
// written. Nothing here touches the disk.
import zlib from 'node:zlib';
import iconv from 'iconv-lite';
import { validateUploadRelativePath } from '../upload/uploadTemp.js';

/** Why an entry is not written. Sentences without paths, like the file job refusals. */
export const ARCHIVE_ENTRY_REFUSAL = Object.freeze({
  outside: 'entry path leaves the target folder',
  absolute: 'entry path is absolute',
  invalidName: 'entry name is not allowed',
  link: 'links are not extracted',
  special: 'device and pipe entries are not extracted',
  blocked: 'path is blocked',
  duplicate: 'another entry already has this name',
  kindMismatch: 'a file and a folder of this name meet',
});

export type EntryPath =
  | { kind: 'path'; segments: string[]; isDirectory: boolean }
  /** './' and the like: the target folder itself, nothing to create. */
  | { kind: 'root' }
  | { kind: 'refused'; reason: string };

/**
 * AC-2: a '/' or '\' separated entry name as segments. '.' and empty segments are dropped (tar
 * writes './a'); '..', an absolute start, a drive letter, NUL, a Windows reserved name, a ':' or a
 * segment ending in a dot or space refuse the entry. The segment rules are the upload rules.
 */
export function normalizeEntryPath(name: string): EntryPath {
  if (name.includes('\u0000')) return { kind: 'refused', reason: ARCHIVE_ENTRY_REFUSAL.invalidName };
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return { kind: 'refused', reason: ARCHIVE_ENTRY_REFUSAL.absolute };
  const isDirectory = unified.endsWith('/');
  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { kind: 'refused', reason: ARCHIVE_ENTRY_REFUSAL.outside };
  if (segments.length === 0) return { kind: 'root' };
  if (validateUploadRelativePath(segments.join('/')) === null) return { kind: 'refused', reason: ARCHIVE_ENTRY_REFUSAL.invalidName };
  return { kind: 'path', segments, isDirectory };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * AC-6: a ZIP entry name from its raw bytes. The Info-ZIP Unicode Path field (0x7075) wins when its
 * CRC matches the raw name; then the UTF-8 flag (bit 11); then bytes that are valid UTF-8 (many
 * tools write UTF-8 without the flag); anything else is CP949, which is what Korean Windows tools
 * write.
 */
export function decodeZipEntryName(raw: Buffer, generalPurposeBitFlag: number, extraFields: ReadonlyArray<{ id: number; data: Buffer }> = []): string {
  for (const field of extraFields) {
    if (field.id !== 0x7075 || field.data.length < 6 || field.data.readUInt8(0) !== 1) continue;
    if (zlib.crc32(raw) !== field.data.readUInt32LE(1)) continue;
    try {
      return UTF8.decode(field.data.subarray(5));
    } catch {
      // A broken Unicode field falls back to the raw name.
    }
  }
  if ((generalPurposeBitFlag & 0x800) !== 0) return raw.toString('utf8');
  try {
    return UTF8.decode(raw);
  } catch {
    return iconv.decode(raw, 'cp949');
  }
}

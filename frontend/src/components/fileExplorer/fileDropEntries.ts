// What an operating-system drop or a file picker hands the explorer, turned into upload
// sources with paths relative to the target folder (FR-FEX-022). A dropped folder is walked
// through the entries API; its files keep their subfolders. The entries must be taken while the
// drop event is still being dispatched — the DataTransfer is emptied right after it.
// @req FR-FEX-022

import type { UploadSource } from './fileUploadController.ts';

interface FileEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: FileEntryLike[]) => void, failure?: (error: unknown) => void) => void };
}

interface DropItemLike {
  kind: string;
  getAsFile: () => File | null;
  webkitGetAsEntry?: () => FileEntryLike | null;
}

function fileOf(entry: FileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file?.(resolve, reject));
}

function readAll(entry: FileEntryLike): Promise<FileEntryLike[]> {
  const reader = entry.createReader?.();
  if (reader === undefined) return Promise.resolve([]);
  // readEntries answers in batches (100 in Chrome) until it answers an empty one.
  const all: FileEntryLike[] = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) {
        resolve(all);
        return;
      }
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

async function walk(entry: FileEntryLike, prefix: string, out: UploadSource[]): Promise<void> {
  const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    out.push({ file: await fileOf(entry), relPath });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readAll(entry)) await walk(child, relPath, out);
  }
}

/** The sources of a drop. Entries are read synchronously first; the walk follows. */
export function readDroppedSources(items: ArrayLike<DropItemLike>): Promise<UploadSource[]> {
  const taken = Array.from(items)
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }));
  return (async () => {
    const out: UploadSource[] = [];
    for (const { entry, file } of taken) {
      if (entry !== null && entry.isDirectory) await walk(entry, '', out);
      else if (file !== null) out.push({ file, relPath: file.name });
    }
    return out;
  })();
}

/** The sources of a picker: a folder pick carries webkitRelativePath, which already starts at the folder. */
export function readPickedSources(files: ArrayLike<File>): UploadSource[] {
  return Array.from(files).map((file) => ({ file, relPath: file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name }));
}

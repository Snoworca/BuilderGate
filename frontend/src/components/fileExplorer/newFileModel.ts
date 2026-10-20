// The name check of the 새 파일 window (FR-FEX-029), run on every keystroke.
//
// Only what the client can see is judged: the listing it already holds. A name
// that matches no listed entry may still be taken on disk (a file made since the
// listing, or a case-insensitive filesystem), and the server's exclusive create
// (FR-FOP-008) is what finally refuses it.
// @req FR-FEX-029

export type NewFileNameCheck =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: 'separator' | 'reserved' }
  | { kind: 'exists'; name: string; isDir: boolean }
  | { kind: 'ok'; name: string };

export interface ListedEntry {
  name: string;
  type: 'file' | 'directory';
}

export function validateNewFileName(input: string, entries: readonly ListedEntry[]): NewFileNameCheck {
  const name = input.trim();
  if (name === '') return { kind: 'empty' };
  if (/[\\/]/.test(name)) return { kind: 'invalid', reason: 'separator' };
  if (name === '.' || name === '..') return { kind: 'invalid', reason: 'reserved' };
  const hit = entries.find((entry) => entry.name === name);
  if (hit !== undefined) return { kind: 'exists', name, isDir: hit.type === 'directory' };
  return { kind: 'ok', name };
}

/** The server said the name is taken (409 FILE_ALREADY_EXISTS, FR-FOP-008 AC-2). */
export function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'FILE_ALREADY_EXISTS';
}

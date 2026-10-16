// FR-MDE-027: the images beside an image tab's file, and where the tab stands among them.
import { activeLanguage } from '../../i18n/i18n.ts';
import { resolveEditorMode } from '../../editor/editorMode.ts';

export interface ImageNavigation {
  /** 0-based position of the current file; -1 when it is not in the list. */
  index: number;
  count: number;
  previous: string | null;
  next: string | null;
}

function isWindowsPath(filePath: string): boolean {
  return /^[A-Za-z]:/.test(filePath) || filePath.startsWith('\\');
}

/** The directory part of an absolute path, without the trailing separator. */
export function imageDirectoryOf(filePath: string): string {
  const cut = isWindowsPath(filePath)
    ? Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    : filePath.lastIndexOf('/');
  if (cut < 0) return '';
  const dir = filePath.slice(0, cut);
  // A root keeps its separator: "/" and "C:\".
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? filePath.slice(0, cut + 1) : dir;
}

/**
 * The image files of a directory listing as absolute paths, ordered by name in the active UI
 * language (FR-I18N-008). An image is what the editor opens in its image viewer.
 */
export function listSiblingImages(
  directory: string,
  entries: readonly { name: string; type: string }[],
  language: string = activeLanguage(),
): string[] {
  const separator = isWindowsPath(directory) ? '\\' : '/';
  const base = directory.endsWith('/') || directory.endsWith('\\') ? directory : `${directory}${separator}`;
  const collator = new Intl.Collator(language, { numeric: true });
  return entries
    .filter(entry => entry.type === 'file' && resolveEditorMode(entry.name).kind === 'image')
    .map(entry => entry.name)
    .sort((a, b) => collator.compare(a, b))
    .map(name => `${base}${name}`);
}

/** Paths compare without case on Windows, as the file system does. */
function samePath(a: string, b: string): boolean {
  return isWindowsPath(a) ? a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase() : a === b;
}

export function imageNavigation(siblings: readonly string[], current: string): ImageNavigation {
  const index = siblings.findIndex(candidate => samePath(candidate, current));
  if (index < 0) return { index: -1, count: siblings.length, previous: null, next: null };
  return {
    index,
    count: siblings.length,
    previous: index > 0 ? siblings[index - 1] : null,
    next: index < siblings.length - 1 ? siblings[index + 1] : null,
  };
}

/** The buttons' handlers: none past either end, and none while `locked` (an unsaved SVG, AC-4). */
export function imageStepHandlers(
  place: ImageNavigation,
  locked: boolean,
  onNavigate: (toPath: string) => void,
): { onPrevious: (() => void) | null; onNext: (() => void) | null } {
  const { previous, next } = place;
  return {
    onPrevious: previous !== null && !locked ? () => onNavigate(previous) : null,
    onNext: next !== null && !locked ? () => onNavigate(next) : null,
  };
}

/**
 * AC-2 / AC-3: a step replaces the tab in place, unless the target is already open somewhere, in
 * which case that document is brought forward instead of being opened twice.
 */
export function planImageStep(
  openPaths: readonly string[],
  fromPath: string,
  toPath: string,
): 'replace' | 'select' | 'ignore' {
  if (fromPath === toPath || !openPaths.includes(fromPath)) return 'ignore';
  return openPaths.includes(toPath) ? 'select' : 'replace';
}

// How the document toolbar shows a path that does not fit: `...` plus the
// separator the path itself uses, then the file name (FR-MDE-020 AC-6).
// @req FR-MDE-020

/** The last segment of a path, split on either separator. */
export function pathFileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** `...\name` or `.../name`, following the separator in front of the name. */
export function truncatedPathLabel(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) return path;
  return `...${path[cut]}${path.slice(cut + 1)}`;
}

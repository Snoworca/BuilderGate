/**
 * Path utilities (shared across FileManager components)
 * Extracts common path separator logic to avoid DRY violations.
 */

/**
 * Detect path separator from a path string.
 * Returns '/' for Unix-style paths, '\\' for Windows-style.
 */
export function getPathSeparator(path: string): string {
  return path.includes('/') ? '/' : '\\';
}

/**
 * Join a base path and a child name using the correct separator.
 */
export function joinPath(basePath: string, name: string): string {
  const sep = getPathSeparator(basePath);
  return `${basePath}${sep}${name}`;
}

/**
 * Extract the last segment (folder/file name) from a path.
 * e.g. "C:\\Work\\git\\Project" → "Project"
 *      "/home/user/project"    → "project"
 */
export function getLastSegment(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Truncate a path from the left to fit within maxLen characters.
 * e.g. truncatePathLeft("C:\\Work\\git\\Project\\src", 20) → "...\\Project\\src"
 */
export function truncatePathLeft(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const sep = getPathSeparator(path);
  const parts = path.split(/[/\\]/).filter(Boolean);

  // Try removing segments from left until it fits
  let result = parts.join(sep);
  let i = 0;
  while (result.length > maxLen - 3 && i < parts.length - 1) {
    i++;
    result = parts.slice(i).join(sep);
  }
  return `...${sep}${result}`;
}

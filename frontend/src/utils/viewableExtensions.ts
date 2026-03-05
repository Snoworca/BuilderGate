const VIEWABLE_EXTENSIONS = new Set([
  // Markdown
  '.md', '.markdown', '.mdx',
  // Code (matches EXTENSION_MAP in CodeViewer)
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.java', '.c', '.h', '.cpp', '.cc', '.hpp',
  '.go', '.rs', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss',
  '.json', '.json5', '.yml', '.yaml', '.xml', '.svg', '.sql',
]);

export function isViewableExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return VIEWABLE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

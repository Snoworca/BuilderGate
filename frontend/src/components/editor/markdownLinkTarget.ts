// FR-MDE-033 AC-2..AC-4: what a click on a rendered markdown link opens. No I/O, no DOM.

export type MarkdownLinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'document'; filePath: string }
  | { kind: 'none' };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const DRIVE = /^[a-z]:[\\/]/i;
const NONE: MarkdownLinkTarget = { kind: 'none' };
/** Only these open in a browser tab; javascript:, data: and the like would run in this origin. */
const WEB_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel']);

export function resolveMarkdownLink(rawUrl: string, fromFilePath: string): MarkdownLinkTarget {
  const url = rawUrl.trim();
  if (url === '' || url.startsWith('#')) return NONE;
  if (url.startsWith('//')) return { kind: 'external', url };

  let path = url;
  const scheme = SCHEME.exec(url);
  if (scheme !== null && !DRIVE.test(url)) {
    const name = scheme[1].toLowerCase();
    if (WEB_SCHEMES.has(name)) return { kind: 'external', url };
    if (name !== 'file') return NONE;
    // file:///C:/x and file:///x both name a path; the host part is dropped.
    path = url.slice('file:'.length).replace(/^\/\/[^/]*/, '');
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  }

  path = decodePercent(path.replace(/[?#].*$/s, ''));
  if (path === '') return NONE;

  const windows = fromFilePath.includes('\\') || DRIVE.test(fromFilePath);
  const separator = windows ? '\\' : '/';
  const absolute = DRIVE.test(path) || path.startsWith('/') || path.startsWith('\\');
  // A rooted path with no drive (/docs/a.md) stays on the current file's drive.
  const drive = windows && !DRIVE.test(path) ? (/^[a-z]:/i.exec(fromFilePath)?.[0] ?? '') : '';
  const base = absolute ? drive : fromFilePath.replace(/[\\/][^\\/]*$/, '');
  return { kind: 'document', filePath: normalize(`${base}${separator}${path}`, separator) };
}

/** Joins the segments with the separator, folding `.` and `..`; `..` stops at the root. */
function normalize(joined: string, separator: string): string {
  const trimmed = joined.replace(/^[\\/]+/, '');
  const drive = /^[a-z]:/i.exec(trimmed)?.[0];
  const segments: string[] = [];
  for (const segment of (drive === undefined ? trimmed : trimmed.slice(drive.length)).split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `${drive === undefined ? '' : drive.toUpperCase()}${separator}${segments.join(separator)}`;
}

/** Decodes each run of %XX that is valid UTF-8; any other run stays as written. */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split('%'), (hex) => parseInt(hex, 16));
    return isUtf8(bytes) ? new TextDecoder().decode(bytes) : run;
  });
}

function isUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i];
    const length = lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 && lead >= 0xc2 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length === 0 || i + length > bytes.length) return false;
    for (let k = 1; k < length; k += 1) if ((bytes[i + k] & 0xc0) !== 0x80) return false;
    i += length;
  }
  return true;
}

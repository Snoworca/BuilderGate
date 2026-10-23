/**
 * OSC 8 hyperlinks and the browser terminal's memory (REL-BGSTAB-052 AC-1, AC-2).
 *
 * xterm keeps a marker, its listeners and a link entry for every OSC 8 link that has no id,
 * and frees them only when the line leaves scrollback. A TUI that redraws a link in place
 * adds a record per frame (~3-9 KB), and reset() frees none of them — through their markers
 * the previous buffer stays alive too (~20 MB per reset with a full 10,000-line scrollback).
 *
 * Two fixes, both keeping the links clickable:
 *  - assignOscLinkIds gives an id-less link an id derived from its URI, so redrawing the
 *    same link reuses one record. Different links to the same URI now share a record, so
 *    hovering one underlines the others too. (A hash collision changes nothing: xterm keys
 *    records by id and URI together.)
 *  - releaseTerminalOscLinks disposes the link markers right before a reset, when the
 *    screen they belong to is being thrown away anyway: the app's own resets and a reset
 *    the shell sends (RIS, ESC c, as `reset` or `tput reset` do).
 */

const OSC8 = '\x1b]8;';
const encoder = new TextEncoder();
/** One char per byte. Not TextDecoder('latin1'): that is windows-1252 and remaps 0x80-0x9F. */
function bytesToChars(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function linkId(uriUtf8: string): string {
  // FNV-1a over the URI's UTF-8 bytes (one char per byte here), so text and byte input agree.
  let hash = 0x811c9dc5;
  for (let i = 0; i < uriUtf8.length; i += 1) {
    hash ^= uriUtf8.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return `bg${(hash >>> 0).toString(36)}`;
}

/**
 * Where the OSC that starts at `from` ends, as xterm reads it: at BEL, at ESC (ESC \\ is ST;
 * ESC + anything else also ends the OSC), or at C1 ST U+009C. -1 when it does not end in this
 * chunk or is cut short (CAN, SUB, or another C1 control, which xterm acts on in the middle of
 * a sequence): such a sequence is left exactly as it is, so the screen cannot change.
 * `bytes`: the text is UTF-8 one char per byte, so a C1 control is C2 followed by 80-9F; a
 * lone 80-BF byte is a continuation byte (as in E2 80 9C), not a control.
 */
function oscEnd(text: string, from: number, bytes: boolean): number {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07 || code === 0x1b) return i;
    if (code === 0x18 || code === 0x1a) return -1;
    if (bytes) {
      if (code !== 0xc2 || i + 1 >= text.length) continue;
      const next = text.charCodeAt(i + 1);
      if (next === 0x9c) return i;
      if (next >= 0x80 && next <= 0x9f) return -1;
    } else if (code >= 0x80 && code <= 0x9f) {
      return code === 0x9c ? i : -1;
    }
  }
  return -1;
}

// What xterm drops inside an OSC before it reads it: C0 controls (the ones that end or abort
// it never reach here) and, from text, a BOM.
const DROPPED_IN_OSC = /[\x00-\x1f\ufeff]/g;

/**
 * The URI as xterm will read it, or '' when it reads none (so the sequence closes a link).
 * From bytes only printable ASCII is trusted: invalid UTF-8 or a BOM there is dropped by
 * xterm's decoder, and a URI made only of such bytes must stay a close.
 */
function effectiveUri(raw: string, bytes: boolean): string {
  const uri = raw.replace(DROPPED_IN_OSC, '');
  if (bytes && !/[\x20-\x7f]/.test(uri)) return '';
  return uri;
}

/**
 * Params as xterm reads them (C0 and BOM dropped, trimmed, ':'-separated, first id= wins)
 * with an id set when that first id= is missing or empty; null when the link has its id.
 */
function paramsWithId(raw: string, id: string): string | null {
  const entries = raw.replace(DROPPED_IN_OSC, '').trim().split(':').filter((entry) => entry !== '');
  const at = entries.findIndex((entry) => entry.startsWith('id='));
  if (at >= 0 && entries[at] !== 'id=') return null; // xterm takes any non-empty id, spaces included
  if (at >= 0) entries[at] = `id=${id}`;
  else entries.push(`id=${id}`);
  return entries.join(':');
}

/** `ESC ] 8 ; params ; URI ST` -> the same with an id in params when it has none. */
function assignInText(text: string, uriOf: (uri: string) => string, bytes: boolean): string {
  let at = text.indexOf(OSC8);
  if (at < 0) return text;
  let out = '';
  let copied = 0;
  while (at >= 0) {
    const paramsStart = at + OSC8.length;
    const end = oscEnd(text, paramsStart, bytes);
    // The params end at the first ';' inside this sequence; the URI may itself contain ';'.
    const paramsEnd = end < 0 ? -1 : text.indexOf(';', paramsStart);
    // A close (a URI xterm reads as empty), a malformed or a split sequence is left as it is.
    const uri = paramsEnd >= 0 && paramsEnd < end ? effectiveUri(text.slice(paramsEnd + 1, end), bytes) : '';
    if (uri !== '') {
      const params = paramsWithId(text.slice(paramsStart, paramsEnd), linkId(uriOf(uri)));
      if (params !== null) {
        out += `${text.slice(copied, paramsStart)}${params}`;
        copied = paramsEnd;
      }
    }
    at = text.indexOf(OSC8, paramsStart);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const utf8PerChar = (uri: string) => bytesToChars(encoder.encode(uri));

function hasOsc8(bytes: Uint8Array): boolean {
  for (let i = bytes.indexOf(0x1b); i >= 0 && i + 3 < bytes.length; i = bytes.indexOf(0x1b, i + 1)) {
    if (bytes[i + 1] === 0x5d && bytes[i + 2] === 0x38 && bytes[i + 3] === 0x3b) return true;
  }
  return false;
}

/** The same data with an id on every OSC 8 link that has none; the very same value when there is none. */
export function assignOscLinkIds<T extends string | Uint8Array>(data: T): T {
  if (typeof data === 'string') return assignInText(data, utf8PerChar, false) as T;
  if (!hasOsc8(data)) return data; // the common case: colours and cursor moves, no links
  // Bytes are handled one char per byte, which is lossless: a BOM, or a chunk split inside a
  // UTF-8 character, passes through untouched while the ASCII sequence is rewritten.
  const text = bytesToChars(data);
  const rewritten = assignInText(text, (uri) => uri, true);
  if (rewritten === text) return data;
  const bytes = new Uint8Array(rewritten.length);
  for (let i = 0; i < rewritten.length; i += 1) bytes[i] = rewritten.charCodeAt(i);
  return bytes as T;
}

interface OscLinkInternals {
  _core?: { _oscLinkService?: { _dataByLinkId?: Map<number, { lines?: Array<{ dispose(): void }> }> } };
}

/** Disposes the link markers of a terminal about to be reset. A no-op when xterm's internals differ. */
export function releaseTerminalOscLinks(terminal: unknown): void {
  const entries = (terminal as OscLinkInternals)._core?._oscLinkService?._dataByLinkId;
  if (!(entries instanceof Map)) return;
  for (const entry of [...entries.values()]) {
    for (const marker of [...(entry.lines ?? [])]) marker.dispose();
  }
}

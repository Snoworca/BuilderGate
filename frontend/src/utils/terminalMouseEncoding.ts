// REL-BGSTAB-039 — a restored terminal keeps the mouse report encoding, and every mouse report
// reaches the PTY.
//
// Claude Code runs in the alternate screen with mouse tracking and SGR reports (?1006h). The
// serialize addon restores the tracking mode but not the encoding, so a terminal rebuilt from a
// snapshot fell back to the default encoding. xterm sends default-encoding reports through
// onBinary, not onData, and nothing listened there, so the wheel did nothing until a resize made
// the application send ?1006h again.

export type TerminalMouseEncoding = 'DEFAULT' | 'SGR' | 'SGR_PIXELS';

/** xterm keeps the encoding on its core and does not expose it; read it there. */
export function readTerminalMouseEncoding(terminal: unknown): TerminalMouseEncoding | null {
  const encoding = (terminal as { _core?: { coreMouseService?: { activeEncoding?: unknown } } } | null)
    ?._core?.coreMouseService?.activeEncoding;
  return encoding === 'DEFAULT' || encoding === 'SGR' || encoding === 'SGR_PIXELS' ? encoding : null;
}

/** The DECSET that re-selects `encoding` on a rehydrated terminal; nothing for the default. */
export function mouseEncodingRestoreSequence(encoding: TerminalMouseEncoding | null): string {
  if (encoding === 'SGR') return '\x1b[?1006h';
  if (encoding === 'SGR_PIXELS') return '\x1b[?1016h';
  return '';
}

export type BinaryMouseReportDecision =
  | { forward: true; data: string }
  | { forward: false; reason: 'empty' | 'non-ascii-byte' };

/**
 * A default-encoding report carries each coordinate as one raw byte. The input path is text and
 * reaches the PTY as UTF-8, which keeps a 7-bit byte as it is but turns a byte above 0x7F into
 * two, so only a report whose bytes are all 7-bit can be forwarded unchanged.
 */
export function decideBinaryMouseReport(data: string): BinaryMouseReportDecision {
  if (data.length === 0) return { forward: false, reason: 'empty' };
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) > 0x7f) return { forward: false, reason: 'non-ascii-byte' };
  }
  return { forward: true, data };
}

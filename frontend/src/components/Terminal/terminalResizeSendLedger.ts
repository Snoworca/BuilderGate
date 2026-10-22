// A resize is only sent when the size changes. That leaves the PTY at the wrong
// size for good when a resize never reached the server, when the server rebuilt
// the PTY at its default size while the browser was reconnecting, or when another
// view resized the shared PTY while this terminal was hidden: the browser
// terminal does not change size again, so nothing sends it.
import type { TerminalGeometry } from './terminalRedrawNudge';

export interface ResizeSendLedger {
  needsSend(geometry: TerminalGeometry): boolean;
  recordSend(geometry: TerminalGeometry, delivered: boolean): void;
  /** Forgets what was sent and returns the size to send again, if there is one. */
  forgetAndResend(lastRequested: TerminalGeometry | null): TerminalGeometry | null;
  reset(): void;
}

// @req REL-BGSTAB-038
export function createResizeSendLedger(): ResizeSendLedger {
  let lastSent: TerminalGeometry | null = null;
  return {
    needsSend(geometry) {
      return !lastSent || lastSent.cols !== geometry.cols || lastSent.rows !== geometry.rows;
    },
    recordSend(geometry, delivered) {
      if (delivered) lastSent = { cols: geometry.cols, rows: geometry.rows };
    },
    forgetAndResend(lastRequested) {
      lastSent = null;
      return lastRequested ? { cols: lastRequested.cols, rows: lastRequested.rows } : null;
    },
    reset() {
      lastSent = null;
    },
  };
}

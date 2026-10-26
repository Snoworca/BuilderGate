// What happens to a path picked from terminal output (FR-ARCH-012 AC-8): the
// server resolves it against the session folder with the file API rules, and
// only a file the editor can open is opened. A missing path, a folder, a path
// outside the session folder (and outside every other worktree of its git
// repository, SEC-FOP-002) or an unsupported file is refused with a reason,
// so the editor never offers to create a file the output merely mentioned.
// @req FR-ARCH-012
// @req FR-ARCH-013
// @req SEC-FOP-002

import { isOpenableFile } from '../components/fileExplorer/fileRowInteraction.ts';
import { t } from '../i18n/i18n.ts';
import type { PathStat } from '../types/index.ts';
import { fileNameOf, type TerminalPathTarget } from './terminalPathDetection.ts';

export type TerminalPathOpenDecision =
  | { kind: 'open'; path: string }
  | { kind: 'refuse'; path: string; reason: string };

/** Why one candidate cannot be opened, or null when it can. */
async function check(path: string, stat: (path: string) => Promise<PathStat>): Promise<{ path: string } | { reason: string }> {
  let resolved: PathStat;
  try {
    resolved = await stat(path);
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
  if (resolved.kind === 'directory') return { reason: t('terminalPath.isDirectory') };
  if ((resolved.kind !== 'file' && resolved.kind !== 'symlink') || !isOpenableFile(fileNameOf(resolved.path))) {
    return { reason: t('terminalPath.unsupported') };
  }
  return { path: resolved.path };
}

/**
 * The path first, then its fallbacks in order (pieces of a path joined across a
 * TUI's wrap indent). The first that is an openable file opens; when none is,
 * the refusal names the path and the reason it gave.
 */
export async function decideTerminalPathOpen(
  target: TerminalPathTarget,
  stat: (path: string) => Promise<PathStat>,
): Promise<TerminalPathOpenDecision> {
  let firstReason: string | null = null;
  for (const candidate of [target.path, ...target.alternatives]) {
    const result = await check(candidate, stat);
    if ('path' in result) return { kind: 'open', path: result.path };
    firstReason ??= result.reason;
  }
  return { kind: 'refuse', path: target.path, reason: firstReason ?? t('terminalPath.unsupported') };
}

// Opening goes through one subscriber (App), so the terminal view only reports
// the path and the tab it came from, as the HTML view requests do.
type OpenListener = (sessionId: string, target: TerminalPathTarget) => void;
const openListeners = new Set<OpenListener>();

export function subscribeTerminalPathOpen(listener: OpenListener): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

export function requestTerminalPathOpen(sessionId: string, target: TerminalPathTarget): void {
  for (const listener of [...openListeners]) listener(sessionId, target);
}

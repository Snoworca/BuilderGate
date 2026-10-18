// Pure decisions behind uploads and ZIP downloads in the explorer (#139): where a drop goes,
// whether folder upload exists here, what a failed transfer becomes, what the download button
// says, when the phone bar shows. Free of React and of the DOM beyond the shapes passed in, so
// each rule can be tested without a browser.
// @req FR-FEX-022
// @req FR-FEX-024
// @req FR-FEX-025
// @req FR-FEX-026

import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';

/**
 * FR-FEX-022 AC-3: folder selection exists when an input knows webkitdirectory. Feature
 * detection, never pointer type or screen size: Android Chrome supports it, iOS Safari not.
 */
export function isFolderUploadSupported(createInput: () => object): boolean {
  return 'webkitdirectory' in createInput();
}

/** FR-FEX-022 AC-7: only a drag that carries files is an upload. */
export function hasDraggedFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (types === null || types === undefined) return false;
  return Array.from(types).includes('Files');
}

export type DropDecision = 'upload' | 'blocked' | 'ignore';

/** FR-FEX-022 AC-6/AC-7: a modal over the explorer blocks the drop; a drag without files is not ours. */
export function decideDropAllowed(input: { hasFiles: boolean; modalOpen: boolean }): DropDecision {
  if (!input.hasFiles) return 'ignore';
  return input.modalOpen ? 'blocked' : 'upload';
}

export interface DropTarget {
  /** The folder the files go into. */
  dir: string;
  /** The row drawn as the target, or null when the shown folder itself is. */
  highlightPath: string | null;
}

/**
 * FR-FEX-022 AC-4: empty space or a file row targets the folder on screen; a directory row,
 * in the list or the tree, targets that directory.
 */
export function resolveDropTarget(input: { row: { path: string; isDir: boolean } | null; shownFolder: string }): DropTarget {
  if (input.row !== null && input.row.isDir) return { dir: input.row.path, highlightPath: input.row.path };
  return { dir: input.shownFolder, highlightPath: null };
}

export const SPRING_TREE_MS = 700;
export const SPRING_TAB_MS = 500;

/** FR-FEX-022 AC-5: how long a dragged file must hover before the target opens, or null. */
export function springDelay(
  target: { kind: 'tree-dir'; expanded: boolean } | { kind: 'tab'; active: boolean } | { kind: 'other' },
): number | null {
  if (target.kind === 'tree-dir') return target.expanded ? null : SPRING_TREE_MS;
  if (target.kind === 'tab') return target.active ? null : SPRING_TAB_MS;
  return null;
}

export type UploadFailureClass = 'retry' | 'failed' | 'interrupted';

// Codes the server answers for a request it will refuse every time.
const FINAL_CODES: ReadonlySet<string> = new Set(['PATH_BLOCKED', 'PATH_TRAVERSAL', 'INVALID_UPLOAD_PATH', 'FILE_TOO_LARGE', 'FILE_ALREADY_EXISTS']);

/**
 * FR-FEX-024 AC-3/AC-6: a failure is retried once unless the server refused the file; a
 * transfer cut while the page was in the background is interrupted, never retried behind the
 * user's back and never shown as completed.
 */
export function classifyUploadFailure(input: { status: number; code: string | null; hiddenDuringAttempt: boolean; attempts: number }): UploadFailureClass {
  if (input.hiddenDuringAttempt) return 'interrupted';
  if (input.code !== null && FINAL_CODES.has(input.code)) return 'failed';
  if (input.status >= 400 && input.status < 500 && input.status !== 408 && input.status !== 429) return 'failed';
  return input.attempts < 2 ? 'retry' : 'failed';
}

export type DroppedUploadOutcome = 'arrived' | 'retry' | 'unsure' | 'in-the-way';

/**
 * FR-FEX-024 AC-3: a connection that dropped (status 0) may have dropped after the server had
 * already put the file in place, so a second PUT is not idempotent: with conflict=rename it
 * leaves a second copy, with conflict=fail it answers 409 for a file that arrived. Before the
 * automatic retry the folder is asked again (`found`, the check's answer for this path, or null
 * when it is not there). A rename, or a file inside a folder — the check names top-level items
 * only — cannot be verified and is left to the user's 재시도.
 */
export function decideDroppedUpload(input: {
  conflict: 'fail' | 'overwrite' | 'rename' | 'skip';
  nested: boolean;
  size: number;
  found: { size: number | null; isDirectory: boolean } | null;
}): DroppedUploadOutcome {
  if (input.conflict === 'rename' || input.nested) return 'unsure';
  if (input.found === null) return 'retry';
  if (!input.found.isDirectory && input.found.size === input.size) return 'arrived';
  return input.conflict === 'fail' ? 'in-the-way' : 'retry';
}

/** FR-FEX-024 AC-2: the list follows the arrival unless the user moved meanwhile. */
export function decideArrivalScroll(input: { userSelected: boolean; userScrolled: boolean }): 'scroll' | 'toast-only' {
  return input.userSelected || input.userScrolled ? 'toast-only' : 'scroll';
}

const REASON_KEYS = {
  PATH_BLOCKED: 'fileTransfer.reason.PATH_BLOCKED',
  PATH_TRAVERSAL: 'fileTransfer.reason.PATH_TRAVERSAL',
  INVALID_UPLOAD_PATH: 'fileTransfer.reason.INVALID_UPLOAD_PATH',
  FILE_TOO_LARGE: 'fileTransfer.reason.FILE_TOO_LARGE',
  FILE_ALREADY_EXISTS: 'fileTransfer.reason.exists',
  UPLOAD_BUSY: 'fileTransfer.reason.busy',
  NETWORK: 'fileTransfer.reason.network',
  INTERRUPTED: 'fileTransfer.reason.interrupted',
  UNSURE: 'fileTransfer.reason.unsure',
} satisfies Record<string, MessageKey>;

/** The line a refused or failed file carries (FR-FEX-024 AC-3/AC-8). */
export function transferReasonText(code: string): string {
  const key = (REASON_KEYS as Record<string, MessageKey | undefined>)[code];
  return key === undefined ? t('fileTransfer.reason.server', { code }) : t(key);
}

/** Sizes in the transfer UI: B, KB, MB, GB with one decimal from KB up. */
export function formatTransferBytes(bytes: number): string {
  if (!(bytes >= 0)) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * FR-FEX-025 AC-1: one regular file keeps 다운로드 (FR-FEX-021); one directory or several items
 * download as a ZIP, with the count for several.
 */
export function downloadButtonLabel(input: { count: number; singleFile: boolean }): string {
  if (input.count <= 1 && (input.singleFile || input.count === 0)) return t('fileExplorer.menu.download');
  if (input.count === 1) return t('fileExplorer.menu.downloadZip');
  return tn('fileExplorer.menu.downloadZipCount', input.count);
}

/** FR-FEX-026 AC-2: the selection band's count. */
export function selectionBandText(count: number): string {
  return tn('fileTransfer.selection.count', count);
}

/** FR-FEX-026 AC-6: the phone bar and its bands give way to the mobile terminal keyboard. */
export function shouldShowMobileFileBar(input: { isMobile: boolean; terminalKeyboardOpen: boolean }): boolean {
  return input.isMobile && !input.terminalKeyboardOpen;
}

/** The first segment of a relative upload path: the item that lands in the target folder. */
export function topLevelOf(relPath: string): string {
  const parts = relPath.split('/').filter((part) => part !== '');
  return parts[0] ?? relPath;
}

/**
 * A free name for a folder that keeps both: `name (2)`, `name (3)`… as FR-FOP-004 names files.
 * Only top-level folders need it; the server renames files itself.
 */
export function keepBothName(name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

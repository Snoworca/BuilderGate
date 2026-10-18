// Extracting one archive from the explorer (FR-FEX-027): which files count as archives, the
// server job that extracts them (FR-FOP-007), the confirm before a large one, and what the end of
// the job selects and reports. Extraction is a server file job like copy and move, so its
// progress, questions and cancel go through fileJobStore; only the decisions live here.
// @req FR-FEX-027

import { t, tn } from '../../i18n/i18n.ts';
import { localizeApiError } from '../../services/apiErrorMessages.ts';
import { parentPathOf } from './fileTreeState.ts';
import { rootLabel } from './fileExplorerPathBarModel.ts';

export type ExtractMode = 'smart' | 'here';

/** FR-FEX-027 AC-1: the formats the server extracts. Judged by name only. */
export function isExtractableArchive(name: string): boolean {
  return /\.(?:zip|tar|tar\.gz|tgz)$/i.test(name);
}

export interface ExtractJobRequest {
  operation: 'extract';
  sourceSessionId: string;
  sources: string[];
  destSessionId: string;
  /** The folder that holds the archive: both modes extract next to it. */
  destPath: string;
  mode: ExtractMode;
}

/** FR-FEX-027 AC-2/AC-3: smart makes one folder beside the archive; here writes into its folder. */
export function buildExtractJobRequest(sessionId: string, archive: string, mode: ExtractMode): ExtractJobRequest {
  return {
    operation: 'extract',
    sourceSessionId: sessionId,
    sources: [archive],
    destSessionId: sessionId,
    destPath: parentPathOf(archive),
    mode,
  };
}

export const EXTRACT_CONFIRM_BYTES = 1024 ** 3;
export const EXTRACT_CONFIRM_ENTRIES = 10_000;

/** FR-FEX-027 AC-5: over 1 GiB unpacked or 10,000 entries asks before anything is written. */
export function decideExtractConfirm(input: { unpackedBytes: number; entryCount: number }): 'direct' | 'confirm' {
  return input.unpackedBytes > EXTRACT_CONFIRM_BYTES || input.entryCount > EXTRACT_CONFIRM_ENTRIES ? 'confirm' : 'direct';
}

export interface ExtractRefusal {
  /** ARCHIVE_TOO_LARGE | ARCHIVE_UNSUPPORTED | ARCHIVE_CORRUPT */
  code: string;
  /** An English sentence without paths (contract §4.1). */
  reason: string;
}

/** POST …/files/extract/precount (contract §4.1): what extracting would make, or why it cannot. */
export interface ExtractPrecount {
  format: string;
  entryCount: number;
  unpackedBytes: number;
  packedBytes: number;
  singleTopFolder: string | null;
  /** smart: the folder it would make ('(2)' applied); here: the archive's folder. */
  targetName: string;
  refusal: null;
}

export type ExtractPrecountResult = ExtractPrecount | { refusal: ExtractRefusal };

export interface ExtractDeps {
  precount: (sessionId: string, archive: string, mode: ExtractMode) => Promise<ExtractPrecountResult>;
  /** The confirm row: size, count and target folder; true on 풀기. */
  confirm: (summary: ExtractPrecount) => Promise<boolean>;
  submit: (request: ExtractJobRequest) => Promise<{ jobId: string }>;
}

/**
 * Pre-count, ask when large, then submit. Resolves null when the user declined and the refusal
 * when the server would not extract it — in both cases no job was sent and nothing written
 * (FR-FEX-027 AC-5, FR-FOP-007 AC-4/AC-5).
 */
export async function runExtract(
  input: { sessionId: string; archive: string; mode: ExtractMode },
  deps: ExtractDeps,
): Promise<{ jobId: string } | { refused: ExtractRefusal } | null> {
  const request = buildExtractJobRequest(input.sessionId, input.archive, input.mode);
  const summary = await deps.precount(input.sessionId, input.archive, input.mode);
  if (summary.refusal !== null) return { refused: summary.refusal };
  if (decideExtractConfirm(summary) === 'confirm' && !(await deps.confirm(summary))) return null;
  return deps.submit(request);
}

/** The error line for a refused archive: its code in words, or the server's sentence in English. */
export function extractRefusalMessage(refusal: ExtractRefusal): string {
  return t('fileTransfer.extract.failed', { message: localizeApiError(refusal.code, refusal.reason) ?? refusal.reason });
}

// Contract §4.3: the fixed English reasons of a skipped entry, as reason codes the transfer
// reasons table words (fileTransferModel.ts). An unknown sentence is passed on as is.
const SKIP_REASON_CODES: Readonly<Record<string, string>> = {
  'entry path leaves the target folder': 'EXTRACT_LEAVES_TARGET',
  'entry path is absolute': 'EXTRACT_ABSOLUTE',
  'entry name is not allowed': 'EXTRACT_NAME_NOT_ALLOWED',
  'links are not extracted': 'EXTRACT_LINK',
  'device and pipe entries are not extracted': 'EXTRACT_DEVICE',
  'path is blocked': 'PATH_BLOCKED',
  'another entry already has this name': 'EXTRACT_DUPLICATE',
  'a file and a folder of this name meet': 'EXTRACT_KIND_CLASH',
};

export interface ExtractDoneInput {
  destPath: string;
  /** Top-level items the job made, as the server reports them. */
  createdPaths: readonly string[];
  processedEntries: number;
  skipped: readonly { path: string; reason: string }[];
  /** How many were skipped in all; `skipped` lists only the first of them (contract §4.3). */
  skippedCount?: number;
}

export interface ExtractDoneView {
  /** The row to select: the created folder, or the first extracted item for 여기에 풀기. */
  select: string | null;
  toast: string;
  /** For 처리하지 못한 항목. */
  skipped: { path: string; code: string }[];
  /** Skipped entries the job did not list, for the 외 n개 line. */
  moreSkipped: number;
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/** FR-FEX-027 AC-6: what the end of a job selects and says. */
export function describeExtractDone(input: ExtractDoneInput): ExtractDoneView {
  const first = input.createdPaths[0];
  return {
    select: first === undefined ? null : lastSegment(first),
    toast: tn('fileTransfer.toast.extracted', input.processedEntries, { folder: rootLabel(input.destPath) }),
    skipped: input.skipped.map((entry) => ({ path: entry.path, code: SKIP_REASON_CODES[entry.reason] ?? entry.reason })),
    moreSkipped: Math.max(0, (input.skippedCount ?? input.skipped.length) - input.skipped.length),
  };
}

export interface ExtractFinishedEvent extends ExtractDoneInput {
  jobId: string;
  sessionId: string;
  workspaceId: string;
  tabId: string;
  outcome: 'completed' | 'cancelled' | 'failed';
}

const listeners = new Set<(event: ExtractFinishedEvent) => void>();

/** The tab that started an extraction listens, to select what it made (FR-FEX-027 AC-6). */
export function subscribeExtractFinished(listener: (event: ExtractFinishedEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitExtractFinished(event: ExtractFinishedEvent): void {
  for (const listener of [...listeners]) listener(event);
}

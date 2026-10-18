// Extracting one archive from the explorer (FR-FEX-027): which files count as archives, the
// server job that extracts them (FR-FOP-007), the confirm before a large one, and what the end of
// the job selects and reports. Extraction is a server file job like copy and move, so its
// progress, questions and cancel go through fileJobStore; only the decisions live here.
// @req FR-FEX-027

import { tn } from '../../i18n/i18n.ts';
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
export function decideExtractConfirm(input: { totalBytes: number; entryCount: number }): 'direct' | 'confirm' {
  return input.totalBytes > EXTRACT_CONFIRM_BYTES || input.entryCount > EXTRACT_CONFIRM_ENTRIES ? 'confirm' : 'direct';
}

export interface ExtractPrecount {
  entryCount: number;
  totalBytes: number;
  /** The top-level name 압축 풀기 would create. */
  rootName?: string;
}

export interface ExtractDeps {
  precount: (sessionId: string, archive: string) => Promise<ExtractPrecount>;
  /** The confirm row: size, count and target folder; true on 풀기. */
  confirm: (summary: ExtractPrecount & { destPath: string }) => Promise<boolean>;
  submit: (request: ExtractJobRequest) => Promise<{ jobId: string }>;
}

/**
 * Pre-count, ask when large, then submit. Resolves null when the user declined, so nothing was
 * written (FR-FEX-027 AC-5).
 */
export async function runExtract(input: { sessionId: string; archive: string; mode: ExtractMode }, deps: ExtractDeps): Promise<{ jobId: string } | null> {
  const request = buildExtractJobRequest(input.sessionId, input.archive, input.mode);
  const summary = await deps.precount(input.sessionId, input.archive);
  if (decideExtractConfirm(summary) === 'confirm' && !(await deps.confirm({ ...summary, destPath: request.destPath }))) return null;
  return deps.submit(request);
}

export interface ExtractDoneInput {
  destPath: string;
  /** Top-level items the job made, as the server reports them. */
  createdPaths: readonly string[];
  processedEntries: number;
  skipped: readonly { path: string; reason: string }[];
}

export interface ExtractDoneView {
  /** The row to select: the created folder, or the first extracted item for 여기에 풀기. */
  select: string | null;
  toast: string;
  /** For 처리하지 못한 항목. */
  skipped: { path: string; code: string }[];
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
    skipped: input.skipped.map((entry) => ({ path: entry.path, code: entry.reason })),
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

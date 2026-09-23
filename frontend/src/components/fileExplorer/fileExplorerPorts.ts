// Seams the explorer asks through when a file job needs a person: confirming a
// delete, answering a conflict or error the server raised mid-job, and showing
// progress. This increment ships provisional defaults (an in-window confirm
// line); FR-FEX-007 (confirm modal) and FR-FEX-008 (progress/decision dialog)
// replace them without touching the callers.
// @req FR-FEX-005

export type ConfirmKind = 'delete';

export interface ConfirmDetail {
  /** Targets, already stripped of '..'. */
  paths: readonly string[];
}

/** @req FR-FEX-005 */
export type ConfirmPort = (kind: ConfirmKind, detail: ConfirmDetail) => Promise<'confirm' | 'cancel'>;

export type FileJobChoice = 'overwrite' | 'rename' | 'skip' | 'retry';

export interface DecideDetail {
  kind: 'conflict' | 'error';
  path: string;
  choices: readonly FileJobChoice[];
}

export interface DecideAnswer {
  choice: FileJobChoice;
  applyToAll: boolean;
}

/** @req FR-FEX-005 */
export type DecidePort = (detail: DecideDetail) => Promise<DecideAnswer>;

export interface FileJobProgress {
  sessionId: string;
  jobId: string;
  phase: 'scanning' | 'transferring';
  processedBytes: number;
  totalBytes: number;
  processedEntries: number;
  totalEntries: number;
  currentPath: string | null;
}

export interface ProgressSink {
  progress(update: FileJobProgress): void;
  done(jobId: string): void;
}

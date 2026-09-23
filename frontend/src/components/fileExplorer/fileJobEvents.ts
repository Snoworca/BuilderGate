// Turns the three file-job WS events into what the explorer does with them:
// a finished job (whatever its outcome -- a cancelled or failed job may still
// have changed some files) invalidates the directories it touched, a pending
// question goes to the decide port, and progress goes to the progress sink.
// @req FR-FEX-001
// @req FR-FEX-005

import type { ServerWsMessage } from '../../types/ws-protocol.ts';
import type { DecideDetail, FileJobProgress } from './fileExplorerPorts.ts';

export type FileJobServerMessage = Extract<ServerWsMessage, { type: `file-job:${string}` }>;

export type FileJobRoute =
  | { kind: 'invalidate'; sessionId: string; directories: string[] }
  | { kind: 'decide'; sessionId: string; jobId: string; decisionId: string; detail: DecideDetail }
  | ({ kind: 'progress' } & FileJobProgress);

/** @req FR-FEX-001 */
export function isFileJobMessage(msg: { type: string }): msg is FileJobServerMessage {
  return msg.type.startsWith('file-job:');
}

/** @req FR-FEX-001 */
export function routeFileJobMessage(msg: ServerWsMessage): FileJobRoute | null {
  switch (msg.type) {
    case 'file-job:done':
      return { kind: 'invalidate', sessionId: msg.sessionId, directories: [...msg.affectedDirectories] };
    case 'file-job:decision-required':
      return {
        kind: 'decide',
        sessionId: msg.sessionId,
        jobId: msg.jobId,
        decisionId: msg.decisionId,
        detail: { kind: msg.kind, path: msg.path, choices: [...msg.choices] },
      };
    case 'file-job:progress':
      return {
        kind: 'progress',
        sessionId: msg.sessionId,
        jobId: msg.jobId,
        phase: msg.phase,
        processedBytes: msg.processedBytes,
        totalBytes: msg.totalBytes,
        processedEntries: msg.processedEntries,
        totalEntries: msg.totalEntries,
        currentPath: msg.currentPath,
      };
    default:
      return null;
  }
}

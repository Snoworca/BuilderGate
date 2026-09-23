// Feeds the app-wide file-job store from the socket and the server's job list.
// It runs once at the app level, not per explorer window: a closed or
// minimized window must not stop the store from hearing about its jobs
// (FR-FEX-009), and one handler means one dispatch per event.
//
// Whenever the socket becomes connected — on mount and after every reconnect —
// the server's live jobs are listed and adopted (SYNC_LIST): a reload leaves no
// JOB_STARTED behind, and a done lost while the socket was down would otherwise
// keep a job on the status bar forever.
// @req FR-FEX-008
// @req FR-FEX-009

import { useEffect, useRef } from 'react';
import { dispatchFileJob, getFileJobSnapshot, type FileJobListedJob } from '../components/fileExplorer/fileJobStore.ts';
import { routeFileJobMessage, type FileJobServerMessage } from '../components/fileExplorer/fileJobEvents.ts';
import { useWebSocketActions, useWebSocketState } from '../contexts/WebSocketContext';
import { fileJobApi } from '../services/api.ts';

export interface FileJobSyncTab {
  sessionId: string;
  workspaceId: string;
}

/** @req FR-FEX-008 */
function handleFileJobMessage(msg: FileJobServerMessage): void {
  const route = routeFileJobMessage(msg);
  if (route === null) return;
  if (route.kind === 'progress') {
    dispatchFileJob({ type: 'PROGRESS', route });
  } else if (route.kind === 'decide') {
    dispatchFileJob({ type: 'DECISION_REQUIRED', route });
  } else if (msg.type === 'file-job:done') {
    // The route only carries the directories to refresh; the outcome is the message's.
    dispatchFileJob({
      type: 'DONE',
      jobId: msg.jobId,
      sessionId: msg.sessionId,
      outcome: msg.outcome,
      ...(msg.errorCode === undefined ? {} : { errorCode: msg.errorCode }),
    });
  }
}

function workspaceBySession(tabs: readonly FileJobSyncTab[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tab of tabs) out[tab.sessionId] = tab.workspaceId;
  return out;
}

/** @req FR-FEX-008 @req FR-FEX-009 */
export function useFileJobStoreSync(tabs: readonly FileJobSyncTab[]): void {
  const { registerFileJobHandler } = useWebSocketActions();
  const { status } = useWebSocketState();

  // Read when the list answers, not when it was asked: tabs can arrive meanwhile.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // After a reload the socket can connect before the workspaces load; listing
  // then would find no window for any job, so the first tabs list again. Only
  // that edge re-lists — every SYNC_LIST reaps jobs the list does not name.
  const hasTabs = tabs.length > 0;

  useEffect(() => registerFileJobHandler(handleFileJobMessage), [registerFileJobHandler]);

  useEffect(() => {
    if (status !== 'connected') return undefined;
    let stale = false;
    // A job started while the list is in flight cannot be in it; the seq taken
    // here lets the reap spare it.
    const sinceSeq = getFileJobSnapshot().seq;
    fileJobApi.list().then((jobs) => {
      if (stale) return;
      dispatchFileJob({
        type: 'SYNC_LIST',
        sinceSeq,
        jobs: jobs as FileJobListedJob[],
        workspaceOfSession: workspaceBySession(tabsRef.current),
      });
    }).catch((error: unknown) => {
      console.warn('[file-job] listing live jobs failed', error);
    });
    return () => {
      stale = true;
    };
  }, [status, hasTabs]);
}

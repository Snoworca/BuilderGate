// While an upload runs, leaving the page would cut it: the browser's leave warning is
// registered then and only then (FR-FEX-024 AC-5), and a phone is asked to keep the screen on
// where the Wake Lock API exists (AC-6). Mounted once, at the app.
// @req FR-FEX-024

import { useEffect, useSyncExternalStore } from 'react';
import { getFileTransferSnapshot, selectUploadRunning, subscribeFileTransfers } from '../components/fileExplorer/fileTransferStore.ts';

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

export function useFileTransferPageGuards(): void {
  const running = useSyncExternalStore(subscribeFileTransfers, () => selectUploadRunning(getFileTransferSnapshot()));

  useEffect(() => {
    if (!running) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines show the prompt only when returnValue is set.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [running]);

  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!running || wakeLock === undefined) return undefined;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = () => {
      wakeLock.request('screen')
        .then((lock) => {
          if (disposed) void lock.release();
          else sentinel = lock;
        })
        .catch(() => {
          // Refused (battery saver, no gesture): the upload goes on without it.
        });
    };
    acquire();
    // The lock is released whenever the page is hidden; it is asked for again on return.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
    };
  }, [running]);
}

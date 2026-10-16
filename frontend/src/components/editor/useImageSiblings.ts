// FR-MDE-027: lists the images beside an image tab's file, once per path, through the tab's session.
import { useEffect, useState } from 'react';
import { fileApi } from '../../services/api';
import { imageDirectoryOf, listSiblingImages } from './imageSiblings.ts';

/** The sibling images in order, or null until (or unless) the directory was read. */
export function useImageSiblings(
  filePath: string,
  tabId: string,
  resolveTabSession: (tabId: string) => string | undefined,
  enabled: boolean,
): string[] | null {
  const [siblings, setSiblings] = useState<string[] | null>(null);
  useEffect(() => {
    setSiblings(null);
    if (!enabled) return undefined;
    const sessionId = resolveTabSession(tabId);
    const directory = imageDirectoryOf(filePath);
    if (sessionId === undefined || directory === '') return undefined;
    let cancelled = false;
    // A failed listing leaves the buttons out; the image itself is unaffected.
    fileApi.listDirectory(sessionId, directory)
      .then((listing) => {
        if (!cancelled) setSiblings(listSiblingImages(directory, listing.entries));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // The session is resolved per read; only the path and the tab decide what to list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, tabId, enabled]);
  return siblings;
}

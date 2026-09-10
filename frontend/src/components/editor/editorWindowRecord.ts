// The persisted shape of a modeless editor window, plus the lookup that turns
// its tab binding back into a session id at the moment an API call is made.
//
// restartTab keeps tab.id and replaces tab.sessionId, so a stored session id
// would be stale after a restart while the tab binding survives it. The record
// therefore carries the tab id and the session is resolved again per call.
// @req CON-MDE-002

import type { EditorWindowPlacement } from './editorWindowPlacement.ts';

export interface EditorWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What survives a reload. It holds no session id, no cascade step -- that is
 * recomputed on every entry into `docked` -- and no body text.
 * @req CON-MDE-002
 */
export interface EditorWindowRecord {
  tabId: string;
  filePath: string;
  placement: EditorWindowPlacement;
  /** The placement recorded on entry to `stage`, or null when none was. */
  placementBeforeStage: EditorWindowPlacement | null;
  minimized: boolean;
  floatingRect: EditorWindowRect | null;
  stackOrder: number;
}

// Keyed by the placement union, so a value added to it has to be given an
// entry here before this compiles. A plain array of the two strings would
// stay assignable while silently rejecting the new one at runtime.
const PLACEMENT_VALUES: Record<EditorWindowPlacement, true> = {
  stage: true,
  floating: true,
};

function isPlacement(value: unknown): value is EditorWindowPlacement {
  return typeof value === 'string' && Object.hasOwn(PLACEMENT_VALUES, value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRect(value: unknown): value is EditorWindowRect {
  if (value === null || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return isFiniteNumber(candidate.x)
    && isFiniteNumber(candidate.y)
    && isFiniteNumber(candidate.width)
    && isFiniteNumber(candidate.height);
}

/**
 * Projects a live window onto the persisted record, field by field. A spread
 * would carry the session id, the cascade step and the unsaved body into
 * storage, which is the failure this projection exists to prevent.
 * @req CON-MDE-002
 */
export function toEditorWindowRecord(window: EditorWindowRecord): EditorWindowRecord {
  return {
    tabId: window.tabId,
    filePath: window.filePath,
    placement: window.placement,
    placementBeforeStage: window.placementBeforeStage,
    minimized: window.minimized,
    floatingRect: window.floatingRect === null ? null : { ...window.floatingRect },
    stackOrder: window.stackOrder,
  };
}

/**
 * True when a value read back from storage is a usable record. Persisted state
 * is untrusted text, so the shape is checked before the tab filter runs.
 * @req CON-MDE-002
 */
export function isEditorWindowRecord(value: unknown): value is EditorWindowRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return isNonEmptyString(candidate.tabId)
    && isNonEmptyString(candidate.filePath)
    && isPlacement(candidate.placement)
    && (candidate.placementBeforeStage === null || isPlacement(candidate.placementBeforeStage))
    && typeof candidate.minimized === 'boolean'
    && (candidate.floatingRect === null || isRect(candidate.floatingRect))
    && isFiniteNumber(candidate.stackOrder);
}

/**
 * Keeps the stored records whose tab still exists, in their stored order, and
 * drops the rest. A window naming a tab that is gone has no terminal rect to
 * dock to and no session to save through, so it is not restored at all.
 * @req CON-MDE-002
 */
export function restoreEditorWindowRecords(
  stored: readonly unknown[],
  existingTabIds: Iterable<string>,
): EditorWindowRecord[] {
  const liveTabIds = new Set(existingTabIds);

  return stored
    .filter(isEditorWindowRecord)
    .filter(record => liveTabIds.has(record.tabId))
    .map(toEditorWindowRecord);
}

/**
 * Builds the tab-to-session lookup that `AppContent` hands down to the window
 * layer. It is called at API-call time rather than at restore time, so a tab
 * restart between the two is invisible to the caller.
 * @req CON-MDE-002
 */
export function createTabSessionLookup(
  tabs: readonly { id: string; sessionId: string }[],
): (tabId: string) => string | undefined {
  return (tabId: string) => tabs.find(tab => tab.id === tabId)?.sessionId;
}

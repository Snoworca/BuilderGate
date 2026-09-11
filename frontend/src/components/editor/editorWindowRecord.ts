// The persisted shape of an open editor document, plus the lookup that turns
// its tab binding back into a session id at the moment an API call is made.
//
// restartTab keeps tab.id and replaces tab.sessionId, so a stored session id
// would be stale after a restart while the tab binding survives it. The record
// therefore carries the tab id and the session is resolved again per call.
// @req CON-MDE-002

/**
 * What survives a reload: which file, opened from which tab. Nothing else.
 *
 * No session id and no body text, for the reasons above and because a stored
 * body would make every reload a question against whatever is on disk now.
 *
 * No placement either. The window's position and size are remembered once,
 * globally, by `editorWindowGeometryCache`; a copy here would be a per-workspace
 * answer to a question that has one answer, and the two could disagree. Which
 * placement state the window was in, and whether it was minimized, are not
 * remembered at all -- a reload opens the window in its default placement,
 * which is what `FR-MDE-009` AC-11 states.
 * @req CON-MDE-002
 * @req FR-MDE-009
 */
export interface EditorWindowRecord {
  tabId: string;
  filePath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Projects a live document onto the persisted record, field by field. A spread
 * would carry the session id, the unsaved body and the window's placement into
 * storage, which is the failure this projection exists to prevent.
 * @req CON-MDE-002
 */
export function toEditorWindowRecord(document: EditorWindowRecord): EditorWindowRecord {
  return {
    tabId: document.tabId,
    filePath: document.filePath,
  };
}

/**
 * True when a value read back from storage is a usable record. Persisted state
 * is untrusted text, so the shape is checked before the tab filter runs.
 *
 * Only the two fields the record carries are checked. A value written by the
 * build that also stored placement passes, and `toEditorWindowRecord` drops the
 * four extra fields; refusing it instead would empty the tab row of everyone
 * who reloads once after that change, which is a worse answer than ignoring
 * fields nobody reads.
 * @req CON-MDE-002
 */
export function isEditorWindowRecord(value: unknown): value is EditorWindowRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return isNonEmptyString(candidate.tabId) && isNonEmptyString(candidate.filePath);
}

/**
 * Keeps the stored records whose tab still exists, in their stored order, and
 * drops the rest. A record naming a tab that is gone has no session to save
 * through, so it is not reopened at all.
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

// Which of the reopened documents are actually put on screen.
//
// The reopen reads each stored record from disk, which takes as long as the
// reads take, and the user is looking at the screen throughout. Whatever they
// do in that gap has already happened by the time the results land, so the
// reopen cannot simply add what it read: it has to add what the user has not
// since decided against.
//
// Measured on 2026-09-22 with the read delayed to 5s -- the user opened a file
// by hand into the still-empty screen, closed it, and the reopen put it back.
// Comparing only against the documents that are open at that moment cannot see
// the difference between one that was closed on purpose and one that was never
// opened at all.
// @req FR-MDE-009

export interface EditorRestoreAdmissionInput<T extends { readonly filePath: string }> {
  /** What the reopen managed to read. */
  readonly restored: readonly T[];
  /** Paths that already have a document; adding again would duplicate the tab. */
  readonly alreadyOpen: Iterable<string>;
  /** Paths the user has closed in this page load. */
  readonly closedByUser: Iterable<string>;
}

/**
 * Filters rather than stops. A user who closes one document has said nothing
 * about the others, and a reopen that gave up on the rest would lose documents
 * for a press aimed at one of them.
 * @req FR-MDE-009
 */
export function selectRestorableDocuments<T extends { readonly filePath: string }>(
  input: EditorRestoreAdmissionInput<T>,
): T[] {
  const open = new Set(input.alreadyOpen);
  const closed = new Set(input.closedByUser);

  return input.restored.filter(
    document => !open.has(document.filePath) && !closed.has(document.filePath),
  );
}

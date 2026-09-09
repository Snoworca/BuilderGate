// The body of an open editor window, its dirty flag, and the one function that
// writes it back.
//
// The body lives here and nowhere else. The editor does not treat its
// `markdownSource` prop as a controlled value, so a second copy in React state
// would leave no basis for deciding which of the two is current -- the host
// keeps this controller in a ref and reads the body back through it.
//
// The session is resolved from the bound tab at the moment of the call rather
// than captured when the controller is built: restarting a tab keeps `tab.id`
// and replaces `tab.sessionId`, so a stored id writes to a session that is gone.
// @req FR-MDE-006

/** The tab the window is bound to, and the file it is showing. */
export interface EditorWindowSaveBinding {
  tabId: string;
  filePath: string;
}

/**
 * What the controller needs from the host. `writeFile` is the shape of
 * `fileApi.writeFile`; passing it in keeps this module free of the transport.
 * @req FR-MDE-006
 */
export interface EditorWindowSaveDeps {
  /** Resolves the bound tab to the session it is running right now. */
  resolveTabSession: (tabId: string) => string | undefined;
  writeFile: (sessionId: string, path: string, content: string) => Promise<{ success: boolean }>;
}

/**
 * `no-session` means the bound tab is gone, so nothing was written and there is
 * nothing to retry -- the title bar badge says so and the close prompt differs.
 * `failed` means a write was attempted and the window keeps its banner.
 * @req FR-MDE-006
 */
export type EditorWindowSaveOutcome =
  | { status: 'saved' }
  | { status: 'failed'; message: string }
  | { status: 'no-session' };

/**
 * The one save path. Both the title bar button and the focus-scoped `Ctrl+S`
 * call `save`; there is deliberately no second entry point for either of them
 * to diverge from.
 * @req FR-MDE-006
 */
export interface EditorWindowSaveController {
  getBody: () => string;
  isDirty: () => boolean;
  /** The banner text under the title bar, or null when there is none. */
  getError: () => string | null;
  /** The editor's change callback. */
  handleEditorChange: (nextBody: string) => void;
  save: () => Promise<EditorWindowSaveOutcome>;
}

export interface EditorWindowSaveInput {
  binding: EditorWindowSaveBinding;
  /** The content read from disk when the window opened. */
  bodyAtOpen: string;
  deps: EditorWindowSaveDeps;
  /** Called whenever `isDirty` or `getError` changes, so the host can repaint. */
  onStateChange?: () => void;
}

/**
 * Turns a rejected write into the banner text. The cause reaches the user, so a
 * cause that carries no message falls back to its own string form rather than
 * showing an empty banner.
 * @req FR-MDE-006
 */
const TAB_CLOSED_MESSAGE = '결속된 탭이 닫혀 저장할 수 없습니다.';
const WRITE_REJECTED_MESSAGE = '서버가 저장을 받아들이지 않았습니다.';

function describeWriteFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  const described = String(cause);
  return described.length > 0 ? described : '파일을 저장하지 못했습니다.';
}

/**
 * @req FR-MDE-006
 */
export function createEditorWindowSaveController(
  input: EditorWindowSaveInput,
): EditorWindowSaveController {
  const { binding, deps, onStateChange } = input;

  let body = input.bodyAtOpen;
  let dirty = false;
  let error: string | null = null;

  const publish = (nextDirty: boolean, nextError: string | null) => {
    if (nextDirty === dirty && nextError === error) return;
    dirty = nextDirty;
    error = nextError;
    onStateChange?.();
  };

  const handleEditorChange = (nextBody: string) => {
    body = nextBody;
    publish(true, error);
  };

  // `written` is the body as it stood when the press happened, so a press
  // writes what was on screen at that moment even if it waits behind another
  // write. The session is resolved here rather than at the press, so a queued
  // write goes to whatever session is live when it actually leaves.
  const runSave = async (written: string): Promise<EditorWindowSaveOutcome> => {
    const sessionId = deps.resolveTabSession(binding.tabId);
    if (sessionId === undefined) {
      // The window is still on screen, so this failure gets a banner like every
      // other one. Returning silently would leave a press with no trace at all.
      publish(dirty, TAB_CLOSED_MESSAGE);
      return { status: 'no-session' };
    }

    let accepted: { success: boolean };
    try {
      accepted = await deps.writeFile(sessionId, binding.filePath, written);
    } catch (cause) {
      const message = describeWriteFailure(cause);
      // The prior dirty state is kept rather than forced true: a failed write
      // reports the error without inventing unsaved content.
      publish(dirty, message);
      return { status: 'failed', message };
    }

    if (accepted?.success !== true) {
      publish(dirty, WRITE_REJECTED_MESSAGE);
      return { status: 'failed', message: WRITE_REJECTED_MESSAGE };
    }

    publish(body !== written, null);
    return { status: 'saved' };
  };

  // Writes are serialized. Two overlapping writes have no ordering guarantee on
  // the wire, so the older body can land last while the marker already says the
  // document is saved -- stale content on disk, presented as current.
  let queue: Promise<EditorWindowSaveOutcome> = Promise.resolve({ status: 'saved' });
  const save = (): Promise<EditorWindowSaveOutcome> => {
    const written = body;
    const run = () => runSave(written);
    queue = queue.then(run, run);
    return queue;
  };

  return {
    getBody: () => body,
    isDirty: () => dirty,
    getError: () => error,
    handleEditorChange,
    save,
  };
}

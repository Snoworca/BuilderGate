/**
 * Issue #83 — a clipboard copy that did not happen must not look like one that did.
 *
 * `MetadataRow` wrapped `navigator.clipboard.writeText` in a bare catch. On
 * failure nothing was recorded and nothing was shown: the "✓ Copied" badge
 * simply never appeared, which is indistinguishable from not having clicked. The
 * user then pasted whatever was in the clipboard before.
 *
 * Two dialogs in this codebase already had the right shape — try the async API,
 * fall back to `execCommand`, throw if neither worked — but each carried its own
 * copy of it and `MetadataRow` had neither the fallback nor the throw. This is
 * that shape, once, with its dependencies injectable so the failure paths are
 * testable without a browser clipboard.
 */

export interface ClipboardCopyDeps {
  writeText: (text: string) => Promise<void>;
  /** Legacy synchronous path. Returns false when the copy did not happen. */
  execCommandCopy: (text: string) => boolean;
}

export type CopyOutcome = 'idle' | 'copied' | 'failed';

function defaultExecCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
}

const defaultDeps: ClipboardCopyDeps = {
  writeText: text => navigator.clipboard.writeText(text),
  execCommandCopy: defaultExecCommandCopy,
};

/**
 * Copies `text`, falling back to the legacy path when the async API is refused —
 * which it routinely is without a user gesture or on an insecure origin.
 *
 * Throws when neither path copied. The throw is the point: a caller that wants
 * to ignore the failure now has to say so.
 */
export async function copyTextToClipboard(
  text: string,
  deps: ClipboardCopyDeps = defaultDeps,
): Promise<void> {
  try {
    await deps.writeText(text);
    return;
  } catch {
    // Fall through to the legacy path rather than failing here; the async API is
    // refused for reasons that have nothing to do with whether a copy is possible.
  }
  if (!deps.execCommandCopy(text)) {
    throw new Error('clipboard-copy-failed');
  }
}

/**
 * Maps a completed attempt to the state the UI renders. `null` means no attempt
 * has been made.
 *
 * `failed` exists as its own value on purpose: implementing failure as "stay
 * idle" is precisely the defect, because idle is what the user sees when they
 * have not clicked at all.
 */
export function resolveCopyOutcome(attempt: { ok: boolean } | null): CopyOutcome {
  if (attempt === null) return 'idle';
  return attempt.ok ? 'copied' : 'failed';
}

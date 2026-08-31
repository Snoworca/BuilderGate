export type TerminalClipboardSource =
  | 'keyboard'
  | 'tab-context-menu'
  | 'grid-context-menu'
  | 'command-preset';

export interface TerminalClipboardTarget {
  terminalIdentity: object;
  sessionId: string;
  sessionGeneration: number;
  viewGeneration: number;
}

export interface TerminalClipboardSelection {
  text: string;
  rangeKey: string;
}

export type TerminalClipboardActionResult =
  | {
      ok: true;
      action: 'copy' | 'paste';
      source: TerminalClipboardSource;
    }
  | {
      ok: false;
      action: 'copy' | 'paste';
      source: TerminalClipboardSource;
      reason:
        | 'no-selection'
        | 'clipboard-read-failed'
        | 'clipboard-write-failed'
        | 'context-changed'
        | string;
    };

export interface TerminalClipboardObservation {
  action: 'copy' | 'paste';
  source: TerminalClipboardSource;
  outcome: 'accepted' | 'rejected';
  reason?: string;
  payloadBytes: number;
  sessionId?: string;
  sessionGeneration?: number;
  viewGeneration?: number;
}

export interface TerminalClipboardCoordinatorOptions {
  captureTarget: () => TerminalClipboardTarget | null;
  isTargetCurrent: (target: TerminalClipboardTarget) => boolean;
  captureSelection: (target: TerminalClipboardTarget) => TerminalClipboardSelection | null;
  isSelectionCurrent: (
    target: TerminalClipboardTarget,
    selection: TerminalClipboardSelection,
  ) => boolean;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  admitPaste: (
    target: TerminalClipboardTarget,
    text: string,
    source: TerminalClipboardSource,
  ) => { ok: true } | { ok: false; reason: string };
  clearSelection: (target: TerminalClipboardTarget) => void;
  focus: (target: TerminalClipboardTarget) => void;
  observe: (event: TerminalClipboardObservation) => void;
}

export interface TerminalClipboardCoordinator {
  copySelection(source: TerminalClipboardSource): Promise<TerminalClipboardActionResult>;
  pasteClipboard(source: TerminalClipboardSource): Promise<TerminalClipboardActionResult>;
  pasteText(text: string, source: TerminalClipboardSource): TerminalClipboardActionResult;
  activate(): void;
  dispose(): void;
}

const textEncoder = new TextEncoder();

export function createTerminalClipboardCoordinator(
  options: TerminalClipboardCoordinatorOptions,
): TerminalClipboardCoordinator {
  let disposed = false;
  let lifecycleGeneration = 1;

  const observe = (
    action: 'copy' | 'paste',
    source: TerminalClipboardSource,
    outcome: 'accepted' | 'rejected',
    payloadBytes: number,
    target: TerminalClipboardTarget | null,
    reason?: string,
  ): void => {
    options.observe({
      action,
      source,
      outcome,
      ...(reason ? { reason } : {}),
      payloadBytes,
      ...(target
        ? {
            sessionId: target.sessionId,
            sessionGeneration: target.sessionGeneration,
            viewGeneration: target.viewGeneration,
          }
        : {}),
    });
  };

  const reject = (
    action: 'copy' | 'paste',
    source: TerminalClipboardSource,
    reason: string,
    payloadBytes: number,
    target: TerminalClipboardTarget | null,
  ): TerminalClipboardActionResult => {
    observe(action, source, 'rejected', payloadBytes, target, reason);
    return { ok: false, action, source, reason };
  };

  const isCurrent = (
    target: TerminalClipboardTarget,
    operationGeneration: number,
  ): boolean => (
    !disposed
    && lifecycleGeneration === operationGeneration
    && options.isTargetCurrent(target)
  );

  const pasteCapturedText = (
    target: TerminalClipboardTarget,
    text: string,
    source: TerminalClipboardSource,
    operationGeneration: number,
  ): TerminalClipboardActionResult => {
    const payloadBytes = textEncoder.encode(text).byteLength;
    if (!isCurrent(target, operationGeneration)) {
      return reject('paste', source, 'context-changed', payloadBytes, target);
    }

    const admission = options.admitPaste(target, text, source);
    if (!admission.ok) {
      return reject('paste', source, admission.reason, payloadBytes, target);
    }

    if (isCurrent(target, operationGeneration)) {
      options.focus(target);
    }
    observe('paste', source, 'accepted', payloadBytes, target);
    return { ok: true, action: 'paste', source };
  };

  return {
    async copySelection(source) {
      const operationGeneration = lifecycleGeneration;
      const target = disposed ? null : options.captureTarget();
      if (!target || !isCurrent(target, operationGeneration)) {
        return reject('copy', source, 'context-changed', 0, target);
      }

      const selection = options.captureSelection(target);
      if (!selection || selection.text.length === 0) {
        return reject('copy', source, 'no-selection', 0, target);
      }
      const payloadBytes = textEncoder.encode(selection.text).byteLength;

      try {
        await options.writeClipboardText(selection.text);
      } catch {
        return reject('copy', source, 'clipboard-write-failed', payloadBytes, target);
      }

      if (
        !isCurrent(target, operationGeneration)
        || !options.isSelectionCurrent(target, selection)
      ) {
        return reject('copy', source, 'context-changed', payloadBytes, target);
      }

      options.clearSelection(target);
      options.focus(target);
      observe('copy', source, 'accepted', payloadBytes, target);
      return { ok: true, action: 'copy', source };
    },

    async pasteClipboard(source) {
      const operationGeneration = lifecycleGeneration;
      const target = disposed ? null : options.captureTarget();
      if (!target || !isCurrent(target, operationGeneration)) {
        return reject('paste', source, 'context-changed', 0, target);
      }

      let text: string;
      try {
        text = await options.readClipboardText();
      } catch {
        return reject('paste', source, 'clipboard-read-failed', 0, target);
      }

      if (!isCurrent(target, operationGeneration)) {
        return reject(
          'paste',
          source,
          'context-changed',
          textEncoder.encode(text).byteLength,
          target,
        );
      }
      return pasteCapturedText(target, text, source, operationGeneration);
    },

    pasteText(text, source) {
      const operationGeneration = lifecycleGeneration;
      const target = disposed ? null : options.captureTarget();
      if (!target) {
        return reject(
          'paste',
          source,
          'context-changed',
          textEncoder.encode(text).byteLength,
          null,
        );
      }
      return pasteCapturedText(target, text, source, operationGeneration);
    },

    activate() {
      if (!disposed) {
        return;
      }
      disposed = false;
      lifecycleGeneration += 1;
    },

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      lifecycleGeneration += 1;
    },
  };
}

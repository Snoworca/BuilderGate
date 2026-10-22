// FR-ARCH-014 AC-3: the notice over a terminal whose program waits on a GUI
// editor open on the server's desktop.
import { t } from '../../i18n/i18n.ts';
import type { EditorWaitInfo } from '../../types/ws-protocol.ts';

export interface EditorWaitNotice {
  message: string;
  closeLabel: string;
}

export function describeEditorWait(editor: EditorWaitInfo | null): EditorWaitNotice | null {
  if (!editor) return null;
  return {
    message: t('editorWait.message', { name: editor.name }),
    closeLabel: t('editorWait.close'),
  };
}

// FR-ARCH-014 AC-3·AC-4: says that the session waits on an editor nobody here
// can see, and closes that editor on request.
import { useState } from 'react';
import { t } from '../../i18n/i18n.ts';
import { sessionApi } from '../../services/api';
import type { EditorWaitInfo } from '../../types/ws-protocol.ts';
import { describeEditorWait } from './editorWaitNotice.ts';
import './EditorWaitBanner.css';

interface EditorWaitBannerProps {
  sessionId: string;
  editor: EditorWaitInfo | null;
}

export function EditorWaitBanner({ sessionId, editor }: EditorWaitBannerProps) {
  const [closing, setClosing] = useState(false);
  const [failed, setFailed] = useState(false);
  const notice = describeEditorWait(editor);
  if (!editor || !notice) return null;

  const handleClose = async () => {
    setClosing(true);
    setFailed(false);
    try {
      await sessionApi.closeEditorWait(sessionId, editor.pid);
    } catch {
      setFailed(true);
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="editor-wait-banner" role="status">
      <span className="editor-wait-banner__message">
        {failed ? t('editorWait.closeFailed') : notice.message}
      </span>
      <button
        type="button"
        className="editor-wait-banner__close"
        disabled={closing}
        onClick={() => { void handleClose(); }}
      >
        {notice.closeLabel}
      </button>
    </div>
  );
}

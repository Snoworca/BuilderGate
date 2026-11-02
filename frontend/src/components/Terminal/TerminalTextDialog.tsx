// FR-ARCH-017: the terminal text as plain text, opened from the terminal menu on a touch
// screen. The terminal canvas has no selection handles; this text has the OS ones.
import { useLayoutEffect, useRef, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { copyAllTerminalText } from '../../utils/terminalTextExport.ts';
import './TerminalTextDialog.css';

interface TerminalTextDialogProps {
  /** AC-5: a copy taken when the menu item was chosen; the terminal is not read again. */
  text: string;
  onClose: () => void;
}

function defaultRect() {
  const margin = 8;
  const width = Math.min(window.innerWidth - margin * 2, 720);
  const height = Math.min(window.innerHeight - margin * 2, 640);
  return {
    x: Math.max(margin, Math.round((window.innerWidth - width) / 2)),
    y: margin,
    width,
    height,
  };
}

export function TerminalTextDialog({ text, onClose }: TerminalTextDialogProps) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const [rect] = useState(defaultRect);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // AC-3: start at the last line, where the latest output is.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, []);

  const copyAll = async () => {
    setCopyState(await copyAllTerminalText(text, navigator.clipboard));
  };

  return (
    <WindowDialog
      dialogId="terminal-text"
      title={t('terminalText.title')}
      mode="modal"
      defaultRect={rect}
      minSize={{ width: 240, height: 200 }}
      persistGeometry={false}
      onClose={onClose}
    >
      <div className="terminal-text-dialog" data-testid="terminal-text-dialog">
        <p className="terminal-text-hint">{t('terminalText.hint')}</p>
        {text === ''
          ? <p className="terminal-text-empty">{t('terminalText.empty')}</p>
          : <pre ref={bodyRef} className="terminal-text-body">{text}</pre>}
        <div className="terminal-text-actions">
          {copyState === 'copied' && <span className="terminal-text-status" role="status">{t('terminalText.copied')}</span>}
          {copyState === 'failed' && <span className="terminal-text-error" role="alert">{t('terminalText.copyFailed')}</span>}
          <Button variant="secondary" size="md" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" size="md" disabled={text === ''} onClick={() => void copyAll()}>{t('terminalText.copyAll')}</Button>
        </div>
      </div>
    </WindowDialog>
  );
}

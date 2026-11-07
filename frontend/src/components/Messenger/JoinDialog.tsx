// Mockup ⑤: the invitation toast and the join dialog — with sessions, or as a
// person only, and whether received messages are entered at once.
// @req FR-MSG-010 FR-MSG-004
import { useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common';
import { Button } from '../ui';
import { t, tn } from '../../i18n/i18n.ts';
import { messengerApi } from '../../services/api.ts';
import type { McpSessionRecord } from '../../types';
import { SessionPicker, type PickerWorkspace } from './SessionPicker.tsx';
import { errorText } from './messengerFormat.ts';
import type { Invite } from './messengerTypes.ts';

interface InviteToastProps {
  invite: Invite;
  onJoin: () => void;
  onDecline: () => void;
  onDismiss: () => void;
}

export function InviteToast({ invite, onJoin, onDecline, onDismiss }: InviteToastProps) {
  const members = [...invite.room.people, ...invite.room.sessions].join(', ');
  return (
    <div className="msgr-toast" role="status">
      <div className="msgr-toast-h">
        <span className="msgr-av msgr-av-sm msgr-av-human" aria-hidden="true">{Array.from(invite.invitedBy)[0]}</span>
        <b>{t('messenger.invite.card.title', { name: invite.invitedBy })}</b>
        <button type="button" className="msgr-x" aria-label={t('common.close')} onClick={onDismiss}><Icon name="close" size={12} /></button>
      </div>
      <div className="msgr-toast-room">{invite.room.name}</div>
      {invite.message && <p>{`“${invite.message}”`}</p>}
      {members !== '' && <p className="msgr-faint">{t('messenger.invite.participants', { list: members })}</p>}
      <div className="msgr-card-acts">
        <Button size="sm" variant="secondary" onClick={onDecline}>{t('messenger.invite.decline')}</Button>
        <Button size="sm" variant="primary" onClick={onJoin}>{t('messenger.invite.join')}</Button>
      </div>
    </div>
  );
}

interface JoinDialogProps {
  invite: Invite;
  sessions: McpSessionRecord[];
  workspaces: PickerWorkspace[];
  onClose: () => void;
  onJoined: (roomId: string) => void;
}

export function JoinDialog({ invite, sessions, workspaces, onClose, onJoined }: JoinDialogProps) {
  const [personOnly, setPersonOnly] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [enter, setEnter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canJoin = !busy && (personOnly || chosen.size > 0);

  const join = async () => {
    if (!canJoin) return;
    setBusy(true);
    setError(null);
    try {
      const result = await messengerApi.acceptInvite(invite.id, { sessions: personOnly ? [] : [...chosen], personOnly, enter });
      onJoined(result.room?.id ?? invite.room.id);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  };

  return (
    <WindowDialog
      dialogId="messenger-join"
      title={t('messenger.join.title', { room: invite.room.name })}
      mode="modal"
      defaultRect={{ x: 240, y: 90, width: 460, height: 560 }}
      minSize={{ width: 320, height: 400 }}
      onClose={onClose}
    >
      <div className="msgr-dialog">
        <div className="msgr-dlg-b">
          <div className="msgr-seg-choice" role="radiogroup">
            <label className={!personOnly ? 'is-on' : undefined}>
              <input type="radio" name="msgr-join-mode" checked={!personOnly} onChange={() => setPersonOnly(false)} />
              {' '}<b>{t('messenger.join.withSessions')}</b>
              <div className="msgr-hint">{t('messenger.join.withSessionsHint')}</div>
            </label>
            <label className={personOnly ? 'is-on' : undefined}>
              <input type="radio" name="msgr-join-mode" checked={personOnly} onChange={() => setPersonOnly(true)} />
              {' '}<b>{t('messenger.join.personOnly')}</b>
              <div className="msgr-hint">{t('messenger.join.personOnlyHint')}</div>
            </label>
          </div>
          {!personOnly && (
            <>
              <SessionPicker
                sessions={sessions}
                workspaces={workspaces}
                query=""
                selected={chosen}
                onToggle={(key) => setChosen((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                })}
              />
              <label className="msgr-check">
                <input type="checkbox" checked={enter} onChange={(event) => setEnter(event.target.checked)} />
                <span>{t('messenger.join.enter')}<div className="msgr-hint">{t('messenger.join.enterHint')}</div></span>
              </label>
            </>
          )}
          <div className="msgr-hint">{t('messenger.join.keptOn', { host: invite.room.hostNode })}</div>
          {error !== null && <div className="msgr-err" role="alert">{error}</div>}
        </div>
        <div className="msgr-dlg-f">
          <Button variant="secondary" size="md" onClick={onClose}>{t('messenger.join.later')}</Button>
          <Button variant="primary" size="md" disabled={!canJoin} onClick={() => void join()}>
            {personOnly ? t('messenger.invite.join') : tn('messenger.join.submitSessions', chosen.size)}
          </Button>
        </div>
      </div>
    </WindowDialog>
  );
}

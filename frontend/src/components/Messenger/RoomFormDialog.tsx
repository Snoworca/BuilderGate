// Mockup ③: a new room, or ＋ 초대 into an existing one. My sessions join at
// once; people get an invitation and choose their own sessions (⑤).
// @req FR-MSG-001 FR-MSG-009
import { useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common';
import { Button, Switch, TextInput } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { messengerApi, MessengerError } from '../../services/api.ts';
import { inviteOutcome, sessionDisplayName, sessionSelections, validateRoomName } from './messengerModel.ts';
import { copyTextToClipboard } from '../../utils/clipboardCopy.ts';
import type { McpSessionRecord } from '../../types';
import { SessionPicker, type PickerWorkspace } from './SessionPicker.tsx';
import { errorText } from './messengerFormat.ts';
import type { Contact, Room } from './messengerTypes.ts';

interface RoomFormDialogProps {
  /** Absent for a new room. */
  room?: Room;
  me: string;
  contacts: Contact[];
  sessions: McpSessionRecord[];
  workspaces: PickerWorkspace[];
  onClose: () => void;
  onDone: (roomId: string) => void;
}

const toggle = (set: ReadonlySet<string>, value: string) => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
};

export function RoomFormDialog({ room, me, contacts, sessions, workspaces, onClose, onDone }: RoomFormDialogProps) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [chosenSessions, setChosenSessions] = useState<Set<string>>(() => new Set());
  const [people, setPeople] = useState<Set<string>>(() => new Set());
  const [contactMenu, setContactMenu] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverNameError, setServerNameError] = useState(false);
  // FR-MSG-001 AC-1: 「받은 메시지를 바로 입력」 per chosen session, on unless switched off.
  const [enterOff, setEnterOff] = useState<Set<string>>(() => new Set());
  const sessionName = (key: string) => {
    const record = sessions.find((candidate) => candidate.sessionKey === key);
    return record ? sessionDisplayName(record) : key;
  };
  const [waitingHost, setWaitingHost] = useState(false);
  const [copied, setCopied] = useState(false);

  const inRoom = new Set(room?.sessions.filter((session) => session.node === me).map((session) => session.sessionKey) ?? []);
  const peopleInRoom = new Set(room?.people.map((person) => person.node.toLowerCase()) ?? []);
  const candidates = contacts.filter((contact) => !people.has(contact.name) && !peopleInRoom.has(contact.name.toLowerCase()));
  const trimmed = name.trim();
  const nameError = room !== undefined ? null : serverNameError ? 'messenger.form.nameInvalidChar' : validateRoomName(name);
  const nameOk = nameError === null;
  const canSubmit = !busy && !waitingHost && nameOk && (room === undefined || chosenSessions.size + people.size > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const input = { sessions: sessionSelections(chosenSessions, enterOff), people: [...people], message: message.trim() || undefined };
      if (room) {
        const result = await messengerApi.invite(room.id, input);
        // The storage PC is off: the invitation is queued, which is not the same as sent (mockup ⑨).
        if (inviteOutcome(result) === 'waiting-host') {
          setWaitingHost(true);
          setBusy(false);
          return;
        }
        onDone(room.id);
      } else {
        const created = await messengerApi.createRoom({ name: trimmed, ...input });
        onDone(created.room.id);
      }
    } catch (reason) {
      if (!room && reason instanceof MessengerError && reason.code === 'NAME_INVALID_CHAR') {
        setServerNameError(true);
      } else {
        setError(errorText(reason));
      }
      setBusy(false);
    }
  };

  const copyInviteCode = async () => {
    if (!room) return;
    setError(null);
    try {
      const result = await messengerApi.inviteCode(room.id, message.trim() || undefined);
      await copyTextToClipboard(result.code);
      setCopied(true);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <WindowDialog
      dialogId={room ? 'messenger-invite' : 'messenger-new-room'}
      title={room ? t('messenger.invite.title', { room: room.name }) : t('messenger.newRoom')}
      mode="modal"
      defaultRect={{ x: 200, y: 80, width: 540, height: 600 }}
      minSize={{ width: 320, height: 420 }}
      onClose={onClose}
    >
      <div className="msgr-dialog">
        <div className="msgr-dlg-b">
          {!room && (
            <div className="msgr-field">
              <label htmlFor="msgr-room-name">{t('messenger.form.name')}</label>
              <div>
                <TextInput id="msgr-room-name" value={name} maxLength={60} onChange={(event) => { setName(event.target.value); setServerNameError(false); }} autoFocus />
                <div className="msgr-hint">{t('messenger.form.nameHint')}</div>
              </div>
            </div>
          )}
          <div className="msgr-field">
            <label htmlFor="msgr-room-sessions">{t('messenger.form.sessions')}</label>
            <div>
              <TextInput id="msgr-room-sessions" value={query} placeholder={t('messenger.form.sessionSearch')} onChange={(event) => setQuery(event.target.value)} />
              <SessionPicker
                sessions={sessions}
                workspaces={workspaces}
                query={query}
                selected={chosenSessions}
                disabled={inRoom}
                onToggle={(key) => setChosenSessions((current) => toggle(current, key))}
              />
              {chosenSessions.size > 0 && (
                <div className="msgr-enter-list">
                  {[...chosenSessions].map((key) => (
                    <Switch key={key} checked={!enterOff.has(key)} onChange={() => setEnterOff((current) => toggle(current, key))}>
                      {t('messenger.form.enterFor', { session: sessionName(key) })}
                    </Switch>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="msgr-field">
            <span className="msgr-field-label">{t('messenger.form.people')}</span>
            <div>
              <div className="msgr-chips">
                {[...people].map((node) => (
                  <span key={node} className="msgr-chip">
                    {node}
                    <button type="button" aria-label={t('messenger.composer.removeTarget')} onClick={() => setPeople((current) => toggle(current, node))}><Icon name="close" size={12} /></button>
                  </span>
                ))}
                <Button size="sm" variant="secondary" icon="plus" aria-expanded={contactMenu} onClick={() => setContactMenu((open) => !open)}>
                  {t('messenger.form.pickContact')}
                </Button>
              </div>
              {contactMenu && (
                <div className="msgr-contact-menu" role="listbox">
                  {candidates.length === 0 && <div className="msgr-faint msgr-pad">{t('messenger.form.noContacts')}</div>}
                  {candidates.map((contact) => (
                    <button
                      key={contact.name}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="msgr-contact msgr-contact-pick"
                      onClick={() => { setPeople((current) => toggle(current, contact.name)); setContactMenu(false); }}
                    >
                      <span className={`msgr-dot ${contact.state === 'connected' ? 'is-on' : 'is-off'}`} aria-hidden="true" />
                      {contact.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="msgr-hint">{t('messenger.form.message')}</div>
              <TextInput value={message} onChange={(event) => setMessage(event.target.value)} />
              {room && (
                <div className="msgr-row">
                  <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyInviteCode()}>
                    {copied ? t('messenger.copied') : t('messenger.invite.code')}
                  </Button>
                  <span className="msgr-hint">{t('messenger.invite.codeHint')}</span>
                </div>
              )}
            </div>
          </div>
          {nameError !== null && trimmed !== '' && <div className="msgr-err" role="alert">{t(nameError)}</div>}
          {waitingHost && room && (
            <div className="msgr-banner msgr-banner-warn" role="status">{t('messenger.invite.waitingHost', { host: room.hostNode })}</div>
          )}
          {error !== null && <div className="msgr-err" role="alert">{error}</div>}
        </div>
        <div className="msgr-dlg-f">
          {waitingHost && room
            ? <Button variant="primary" size="md" onClick={() => onDone(room.id)}>{t('common.close')}</Button>
            : (
              <>
                <Button variant="secondary" size="md" onClick={onClose}>{t('common.cancel')}</Button>
                <Button variant="primary" size="md" disabled={!canSubmit} onClick={() => void submit()}>
                  {room ? t('messenger.invite.submit') : t('messenger.form.create')}
                </Button>
              </>
            )}
        </div>
      </div>
    </WindowDialog>
  );
}

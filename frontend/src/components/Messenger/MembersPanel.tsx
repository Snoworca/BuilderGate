// Mockup ⑨: people with their sessions indented, per-session toggles, removal,
// room settings, moving the storage PC, continuing elsewhere and leaving.
// @req FR-MSG-001 FR-MSG-004 FR-MSG-006 FR-MSG-009 FR-MSG-012
import { useState } from 'react';
import { WindowDialog } from '../dialog';
import { Icon } from '../common';
import { Button, NumberInput, Select, Switch } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { messengerApi } from '../../services/api.ts';
import { errorText, useViewportRect } from './messengerFormat.ts';
import { sessionAgentNote } from './messengerModel.ts';
import type { Contact, InvitePolicy, Room, RoomDetail } from './messengerTypes.ts';

interface MembersPanelProps {
  detail: RoomDetail;
  me: string;
  contacts: Contact[];
  isMobile: boolean;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => Promise<void>;
  onContinued: (room: Room) => Promise<void>;
  onAddContact: (node: string) => void;
}

export function MembersPanel({ detail, me, contacts, isMobile, onClose, onChanged, onLeft, onContinued, onAddContact }: MembersPanelProps) {
  const room = detail.room;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [holdLimit, setHoldLimit] = useState(String(room.settings.holdLimit));
  const isCreator = room.createdBy === me;
  const contactNames = new Set(contacts.map((contact) => contact.name.toLowerCase()));
  const connected = new Set(contacts.filter((contact) => contact.state === 'connected').map((contact) => contact.name.toLowerCase()));
  const people = room.people;
  const joined = people.filter((person) => person.state === 'joined');
  const moveTargets = joined.filter((person) => person.node !== room.hostNode);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const kick = (node: string) => {
    if (!window.confirm(t('messenger.members.removeConfirm', { name: node }))) return;
    void run(() => messengerApi.removeMember(room.id, node));
  };

  const leave = () => {
    if (!window.confirm(t('messenger.settings.leaveConfirm', { room: room.name }))) return;
    // Not through run(): its onChanged would reload the room just left.
    setBusy(true);
    setError(null);
    messengerApi.leave(room.id)
      .then(() => onLeft())
      .catch((reason) => { setError(errorText(reason)); setBusy(false); });
  };

  const viewport = useViewportRect();
  const rect = isMobile ? viewport : { x: Math.max(viewport.width - 360, 0), y: 80, width: 340, height: 560 };

  return (
    <WindowDialog
      dialogId="messenger-members"
      title={`${t('messenger.room.members')} · ${room.name}`}
      mode="modeless"
      defaultRect={rect}
      minSize={{ width: 280, height: 320 }}
      onClose={onClose}
      {...(isMobile ? { rect, movable: false, resizable: false, persistGeometry: false } : {})}
    >
      <div className="msgr-members-panel">
        <div className="msgr-sec"><span>{t('messenger.members.section')}</span><span>{`${joined.length} · ${room.sessions.length}`}</span></div>
        {people.map((person) => {
          const isMe = person.node === me;
          const isContact = isMe || contactNames.has(person.node.toLowerCase());
          const online = isMe || connected.has(person.node.toLowerCase()) || (person.node === room.hostNode && detail.host.online);
          const sessions = room.sessions.filter((session) => session.node === person.node);
          const note = isMe
            ? [t('messenger.members.me'), person.node === room.hostNode ? t('messenger.members.keeps') : ''].filter(Boolean).join(' · ')
            : person.state === 'invited' ? t('messenger.members.invitePending')
              : person.state === 'approval' ? t('messenger.members.approvalPending')
                : person.invitedBy && person.invitedBy !== room.createdBy ? t('messenger.members.invitedBy', { name: person.invitedBy })
                  : isContact ? t('messenger.members.contact') : '';
          return (
            <div key={person.node} className="msgr-member">
              <div className="msgr-contact">
                <span className={`msgr-dot ${online ? 'is-on' : 'is-off'}`} aria-hidden="true" />
                <b>{person.node}</b>
                {!isContact && <span className="msgr-pill msgr-pill-neutral">{t('messenger.members.notContact')}</span>}
                <span className="msgr-faint msgr-contact-state">{note}</span>
              </div>
              {sessions.map((session) => {
                const canRemove = isCreator || session.node === me;
                return (
                  <div key={session.id} className={`msgr-member-session${sessionAgentNote(session) ? ' is-no-agent' : ''}`}>
                    <div className="msgr-contact msgr-indent">
                      <span className={`msgr-term-ic ${session.node === me ? 'is-local' : 'is-remote'}`} aria-hidden="true"><Icon name="terminal" size={14} /></span>
                      <span className="msgr-contact-name">{session.name}</span>
                      {sessionAgentNote(session) !== null && <span className="msgr-faint msgr-no-agent">{t('messenger.members.noAgent')}</span>}
                      {canRemove && (
                        <Button size="sm" variant="danger-text" disabled={busy} onClick={() => void run(() => messengerApi.removeMember(room.id, session.id))}>
                          {t('messenger.members.removeSession')}
                        </Button>
                      )}
                    </div>
                    {session.node === me && (
                      <div className="msgr-indent msgr-toggles">
                        <Switch
                          checked={session.enter}
                          disabled={busy}
                          onChange={(event) => void run(() => messengerApi.updateSession(room.id, session.sessionKey, { enter: event.target.checked }))}
                        >
                          {t('messenger.members.enter')}
                        </Switch>
                        <Switch
                          checked={session.pasteAll}
                          disabled={busy}
                          onChange={(event) => void run(() => messengerApi.updateSession(room.id, session.sessionKey, { pasteAll: event.target.checked }))}
                        >
                          {t('messenger.members.pasteAll')}
                        </Switch>
                      </div>
                    )}
                  </div>
                );
              })}
              {!isMe && (!isContact || isCreator) && (
                <div className="msgr-row msgr-indent-row">
                  {!isContact && <Button size="sm" variant="secondary" onClick={() => onAddContact(person.node)}>{t('messenger.members.addContact', { name: person.node })}</Button>}
                  {isCreator && <Button size="sm" variant="danger-text" disabled={busy} onClick={() => kick(person.node)}>{t('messenger.members.remove')}</Button>}
                </div>
              )}
            </div>
          );
        })}

        <div className="msgr-sec"><span>{t('messenger.settings.title')}</span></div>
        <div className="msgr-settings">
          <span className="msgr-faint">{t('messenger.settings.invitedByOthers')}</span>
          <div className="msgr-seg" role="radiogroup">
            {(['auto', 'approve'] as InvitePolicy[]).map((policy) => (
              <button
                key={policy}
                type="button"
                role="radio"
                aria-checked={room.settings.invitePolicy === policy}
                className={room.settings.invitePolicy === policy ? 'is-on' : undefined}
                disabled={!isCreator || busy}
                onClick={() => void run(() => messengerApi.updateSettings(room.id, { invitePolicy: policy }))}
              >
                {t(policy === 'auto' ? 'messenger.settings.auto' : 'messenger.settings.approve')}
              </button>
            ))}
          </div>
          <span className="msgr-hint">{t('messenger.settings.autoHint')}</span>
          <label className="msgr-faint" htmlFor="msgr-hold-limit">{t('messenger.settings.holdLimit')}</label>
          <div className="msgr-row">
            <NumberInput id="msgr-hold-limit" min={1} max={1000} value={holdLimit} disabled={!isCreator || busy} onChange={(event) => setHoldLimit(event.target.value)} />
            <Button
              size="sm"
              variant="secondary"
              disabled={!isCreator || busy || Number(holdLimit) === room.settings.holdLimit || !(Number(holdLimit) >= 1)}
              onClick={() => void run(() => messengerApi.updateSettings(room.id, { holdLimit: Number(holdLimit) }))}
            >
              {t('common.save')}
            </Button>
          </div>
          {!isCreator && <span className="msgr-hint">{t('messenger.settings.creatorOnly')}</span>}

          {isCreator && (
            <>
              <span className="msgr-faint">{t('messenger.settings.transfer')}</span>
              <div className="msgr-row">
                <Select value={moveTo} disabled={busy || !detail.host.online || moveTargets.length === 0} onChange={(event) => setMoveTo(event.target.value)} aria-label={t('messenger.settings.transferTo')}>
                  <option value="">{t('messenger.settings.transferTo')}</option>
                  {moveTargets.map((person) => <option key={person.node} value={person.node}>{person.node}</option>)}
                </Select>
                <Button size="sm" variant="secondary" disabled={busy || moveTo === '' || !detail.host.online} onClick={() => void run(() => messengerApi.transfer(room.id, moveTo))}>
                  {t('messenger.settings.transferConfirm')}
                </Button>
              </div>
              <span className="msgr-hint">{t('messenger.settings.transferHint')}</span>
            </>
          )}

          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(async () => { const result = await messengerApi.continueRoom(room.id); await onContinued(result.room); })}>
            {t('messenger.settings.continue')}
          </Button>
          <span className="msgr-hint">{t('messenger.settings.continueHint')}</span>
          <Button size="sm" variant="danger-text" disabled={busy} onClick={leave}>{t('messenger.settings.leave')}</Button>
          {error !== null && <div className="msgr-err" role="alert">{error}</div>}
        </div>
      </div>
    </WindowDialog>
  );
}

// The left pane (mockups ①, ⑧): search, cards waiting for me, rooms by last
// message with their badges, and contacts with their link state.
// @req FR-MSG-001 FR-MSG-005 FR-MSG-009 FR-MSG-010 FR-MSG-013
import { useEffect, useState } from 'react';
import { Button } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { messengerApi } from '../../services/api.ts';
import { contactStatus, roomBadge, sortRooms } from './messengerModel.ts';
import { errorText, formatAgo, formatListTime } from './messengerFormat.ts';
import type { Contact, Invite, MessengerState, SearchResult } from './messengerTypes.ts';

interface RoomListProps {
  state: MessengerState;
  openRoomId: string | null;
  onOpenRoom: (roomId: string) => void;
  onNewRoom: () => void;
  onJoin: (invite: Invite) => void;
  onChanged: () => void;
}

export function RoomList({ state, openRoomId, onOpenRoom, onNewRoom, onJoin, onChanged }: RoomListProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q === '') { setFound(null); return undefined; }
    let alive = true;
    const timer = window.setTimeout(() => {
      messengerApi.search(q)
        .then((result) => { if (alive) { setFound(result); setError(null); } })
        .catch((reason) => { if (alive) setError(errorText(reason)); });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const rooms = sortRooms(state.rooms);
  return (
    <div className="msgr-rooms">
      <div className="msgr-rooms-tools">
        <input
          className="msgr-search"
          type="search"
          value={query}
          placeholder={t('messenger.search.placeholder')}
          aria-label={t('messenger.search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="primary" size="sm" icon="plus" aria-label={t('messenger.newRoom')} title={t('messenger.newRoom')} onClick={onNewRoom} />
      </div>
      <div className="msgr-rooms-scroll">
        {error !== null && <div className="msgr-err msgr-err-pad" role="alert">{error}</div>}

        {state.invites.map((invite) => (
          <div key={invite.id} className="msgr-card">
            <div className="msgr-card-h"><b>{t('messenger.invite.card.title', { name: invite.invitedBy })}</b></div>
            <div className="msgr-card-room">{invite.room.name}</div>
            {invite.message && <p className="msgr-card-quote">{invite.message}</p>}
            <div className="msgr-card-acts">
              <Button size="sm" variant="secondary" onClick={() => void act(() => messengerApi.declineInvite(invite.id))}>{t('messenger.invite.decline')}</Button>
              <Button size="sm" variant="primary" disabled={invite.accepting === true} onClick={() => onJoin(invite)}>{t('messenger.invite.join')}</Button>
            </div>
          </div>
        ))}
        {state.approvals.map((approval) => (
          <div key={approval.id} className="msgr-card">
            <div className="msgr-card-h">{t('messenger.approval.title', { inviter: approval.invitedBy, invitee: approval.invitee, room: approval.roomName })}</div>
            {approval.message && <p className="msgr-card-quote">{approval.message}</p>}
            <div className="msgr-card-acts">
              <Button size="sm" variant="secondary" onClick={() => void act(() => messengerApi.approve(approval.id, false))}>{t('messenger.approval.reject')}</Button>
              <Button size="sm" variant="primary" onClick={() => void act(() => messengerApi.approve(approval.id, true))}>{t('messenger.approval.approve')}</Button>
            </div>
          </div>
        ))}
        {state.requests.map((request) => (
          <div key={request.id} className="msgr-card">
            <div className="msgr-card-h">{t('messenger.request.title', { name: request.fromNode })}</div>
            {request.fromAddress && <div className="msgr-mono msgr-faint">{request.fromAddress}</div>}
            <div className="msgr-card-acts">
              <Button size="sm" variant="secondary" onClick={() => void act(() => messengerApi.answerRequest(request.id, false))}>{t('messenger.request.decline')}</Button>
              <Button size="sm" variant="primary" onClick={() => void act(() => messengerApi.answerRequest(request.id, true))}>{t('messenger.request.accept')}</Button>
            </div>
          </div>
        ))}

        {found !== null ? (
          <>
            <div className="msgr-sec"><span>{t('messenger.section.rooms')}</span><span>{found.rooms.length}</span></div>
            {found.rooms.map((room) => (
              <button key={room.id} type="button" className="msgr-room" onClick={() => onOpenRoom(room.id)}>
                <span className="msgr-room-n">{room.name}</span>
              </button>
            ))}
            <div className="msgr-sec"><span>{t('messenger.search.messages')}</span><span>{found.messages.length}</span></div>
            {found.messages.map((message) => (
              <button key={`${message.roomId}:${message.seq}`} type="button" className="msgr-room" onClick={() => onOpenRoom(message.roomId)}>
                <span className="msgr-room-n">{message.roomName}</span>
                <span className="msgr-room-l">{message.text}</span>
              </button>
            ))}
            {found.rooms.length + found.messages.length === 0 && <div className="msgr-empty">{t('messenger.search.none')}</div>}
          </>
        ) : (
          <>
            <div className="msgr-sec"><span>{t('messenger.section.rooms')}</span><span>{rooms.length}</span></div>
            {rooms.length === 0 && <div className="msgr-empty msgr-empty-left">{t('messenger.rooms.empty')}</div>}
            {rooms.map((room) => {
              const badge = roomBadge(room);
              const last = room.held
                ? t('messenger.room.heldLine')
                : room.lastText === '' ? '' : room.lastFrom === state.me.name
                  ? t('messenger.room.lastFromMe', { text: room.lastText })
                  : t('messenger.room.lastFrom', { from: room.lastFrom, text: room.lastText });
              return (
                <button
                  key={room.id}
                  type="button"
                  className={`msgr-room${room.id === openRoomId ? ' is-active' : ''}`}
                  aria-current={room.id === openRoomId ? 'true' : undefined}
                  onClick={() => onOpenRoom(room.id)}
                >
                  <span className="msgr-room-n">{room.name}</span>
                  <span className="msgr-room-t">{formatListTime(room.lastAt)}</span>
                  <span className="msgr-room-l">{last}</span>
                  {badge ? <span className={`msgr-room-u msgr-room-u-${badge.tone}`}>{badge.text}</span> : <span />}
                </button>
              );
            })}
          </>
        )}

        <div className="msgr-sec"><span>{t('messenger.section.contacts')}</span><span>{state.contacts.length}</span></div>
        {state.contacts.map((contact) => (
          <div key={contact.name} className="msgr-contact">
            <span className={`msgr-dot ${contactDot(contact)}`} aria-hidden="true" />
            <span className="msgr-contact-name">{contact.name}</span>
            <span className="msgr-faint msgr-contact-state">{contactStateText(contact)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function contactDot(contact: Contact): string {
  if (contact.error !== undefined) return 'is-wait';
  if (contact.state === 'connected') return 'is-on';
  if (contact.state === 'disconnected') return 'is-off';
  return 'is-wait';
}

export function contactStateText(contact: Contact): string {
  const status = contactStatus(contact, new Date());
  return status.ago === undefined ? t(status.key) : t(status.key, { ago: formatAgo(status.ago) });
}

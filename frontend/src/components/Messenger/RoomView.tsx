// The conversation pane (mockups ①, ⑥, ⑨, ⑩): header with members, the hold
// and host-offline banners, the log with day separators and folds, the composer.
// @req FR-MSG-002 FR-MSG-005 FR-MSG-009 FR-MSG-011 FR-MSG-013
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui';
import { t, tn } from '../../i18n/i18n.ts';
import { messengerApi } from '../../services/api.ts';
import type { McpSessionRecord } from '../../types';
import { Composer } from './Composer.tsx';
import { MessageItem, SystemLine } from './MessageItem.tsx';
import type { MentionRoom } from './mentions.ts';
import type { PickerSource } from './mentionPicker.ts';
import { agentChip, foldAgentRuns, moveSuggestion, senderView, sessionAgentNote } from './messengerModel.ts';
import { dayKey, errorText, formatDay, formatTime } from './messengerFormat.ts';
import type { MessengerState, RoomSummary } from './messengerTypes.ts';
import type { UseRoomDetailResult } from './useMessenger.ts';

interface RoomViewProps {
  summary: RoomSummary | undefined;
  state: MessengerState;
  room: UseRoomDetailResult;
  localSessions: McpSessionRecord[];
  showBack: boolean;
  onBack: () => void;
  onOpenMembers: () => void;
  onInvite: () => void;
}

export function RoomView({ summary, state, room, localSessions, showBack, onBack, onOpenMembers, onInvite }: RoomViewProps) {
  const me = state.me.name;
  const detail = room.detail;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const readSeqRef = useRef(0);

  const roomData = detail?.room;
  const sessions = roomData?.sessions ?? [];
  const joinedPeople = roomData?.people.filter((person) => person.state === 'joined') ?? [];
  const hostOnline = detail?.host.online ?? summary?.hostOnline ?? true;
  const hostNode = roomData?.hostNode ?? summary?.hostNode ?? '';

  const mentionRoom = useMemo<MentionRoom>(() => ({
    me,
    people: joinedPeople.map((person) => person.node),
    sessions: sessions.map((session) => ({ id: session.id, node: session.node, name: session.name })),
  }), [me, joinedPeople, sessions]);

  const pickerSource = useMemo<PickerSource>(() => {
    const connected = new Set(state.contacts.filter((contact) => contact.state === 'connected').map((contact) => contact.name.toLowerCase()));
    const statusOf = (sessionKey: string) => {
      const record = localSessions.find((candidate) => candidate.sessionKey === sessionKey);
      if (!record) return undefined;
      const chip = agentChip(record);
      return t(chip.key, chip.params);
    };
    return {
      people: joinedPeople
        .filter((person) => person.node !== me)
        .map((person) => ({
          node: person.node,
          connected: connected.has(person.node.toLowerCase()) || person.node === hostNode,
          sessions: sessions.filter((session) => session.node === person.node).map((session) => ({ name: session.name })),
        })),
      mine: sessions.filter((session) => session.node === me).map((session) => ({ name: session.name, status: statusOf(session.sessionKey) })),
    };
  }, [state.contacts, localSessions, joinedPeople, sessions, me, hostNode]);

  const items = useMemo(() => foldAgentRuns(room.messages, expanded), [room.messages, expanded]);
  const lastSeq = room.messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0);

  // Read when the bottom of the log is visible (mockup ① 읽음 처리).
  const markReadIfAtBottom = () => {
    const log = logRef.current;
    if (!log || !roomData) return;
    atBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    if (atBottomRef.current && lastSeq > readSeqRef.current) {
      readSeqRef.current = lastSeq;
      void messengerApi.markRead(roomData.id, lastSeq).catch(() => undefined);
    }
  };

  useEffect(() => {
    readSeqRef.current = 0;
    atBottomRef.current = true;
    setExpanded(new Set());
    setNotice(null);
  }, [roomData?.id]);

  useEffect(() => {
    const log = logRef.current;
    if (log && atBottomRef.current) log.scrollTop = log.scrollHeight;
    markReadIfAtBottom();
  });

  if (!detail || !roomData) {
    return (
      <div className="msgr-chat">
        <div className="msgr-chat-h">
          {showBack && <BackButton onClick={onBack} />}
          <div className="msgr-ttl"><b>{summary?.name ?? ''}</b></div>
        </div>
        <div className="msgr-empty">{room.error ?? ''}</div>
      </div>
    );
  }

  const isCreator = roomData.createdBy === me;
  const move = moveSuggestion(roomData, me);
  const heldCount = room.messages.filter((message) => message.held).length;

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await room.reload();
    } catch (reason) {
      setActionError(errorText(reason));
    }
  };

  const send = async (text: string): Promise<string | null> => {
    try {
      const result = await messengerApi.send(roomData.id, text);
      setNotice(result.status === 'waiting-host' ? t('messenger.composer.waitingHost') : null);
      atBottomRef.current = true;
      await room.reload();
      return null;
    } catch (reason) {
      // AMBIGUOUS_TARGET and TARGET_NOT_FOUND arrive worded, with their candidates and name.
      return errorText(reason);
    }
  };

  const avatars = [
    ...joinedPeople.map((person) => ({ key: person.node, tone: 'human' as const, title: person.node, initial: Array.from(person.node)[0] ?? '?', dim: false })),
    ...sessions.map((session) => {
      const view = senderView({ node: session.node, kind: 'agent', sessionKey: session.sessionKey }, me, sessions);
      const note = sessionAgentNote(session);
      return { key: session.id, tone: view.tone, title: note === null ? view.name : `${view.name} · ${t(note)}`, initial: view.initial, dim: note !== null };
    }),
  ];

  let lastDay = '';
  return (
    <div className="msgr-chat">
      <div className="msgr-chat-h">
        {showBack && <BackButton onClick={onBack} />}
        <div className="msgr-ttl">
          <b>{roomData.name}</b>
          <span>{t('messenger.room.info', { host: roomData.hostNode, people: joinedPeople.length, sessions: sessions.length })}</span>
        </div>
        <button type="button" className="msgr-members" aria-label={t('messenger.room.members')} title={t('messenger.room.members')} onClick={onOpenMembers}>
          {avatars.slice(0, 6).map((avatar) => (
            <span key={avatar.key} className={`msgr-av msgr-av-sm msgr-av-${avatar.tone}${avatar.dim ? ' is-no-agent' : ''}`} title={avatar.title}>{avatar.initial}</span>
          ))}
          {avatars.length > 6 && <span className="msgr-av msgr-av-sm msgr-av-more">{`+${avatars.length - 6}`}</span>}
        </button>
        <Button size="sm" icon="plus" onClick={onInvite}>{t('messenger.room.invite')}</Button>
      </div>

      {!hostOnline && (
        <div className="msgr-banner msgr-banner-warn" role="status">
          <span aria-hidden="true">⏾</span>
          <span>
            <b>{t('messenger.hostOff.title', { host: hostNode, time: formatTime(detail.host.offlineSince) || '?' })}</b>{' '}
            {tn('messenger.hostOff.body', detail.outbox.length)}
          </span>
        </div>
      )}
      {move !== null && (
        <div className="msgr-banner msgr-banner-info" role="status">
          <span aria-hidden="true">ⓘ</span>
          <span>{t('messenger.room.moveSuggested', { hours: move.hours })}</span>
          <Button size="sm" variant="secondary" onClick={onOpenMembers}>{t('messenger.settings.transfer')}</Button>
        </div>
      )}
      {(summary?.invitesWaitingHost?.length ?? 0) > 0 && (
        <div className="msgr-banner msgr-banner-warn" role="status">
          <span aria-hidden="true">⏾</span>
          <span>{t('messenger.room.invitesWaitingHost', { names: summary?.invitesWaitingHost?.join(', ') ?? '', host: hostNode })}</span>
        </div>
      )}
      {(summary?.invitedPending.length ?? 0) > 0 && (
        <div className="msgr-pending">
          {summary?.invitedPending.map((node) => (
            <span key={node} className="msgr-pill msgr-pill-wait">{t('messenger.room.invitePending', { name: node })}</span>
          ))}
        </div>
      )}

      <div className="msgr-log" ref={logRef} onScroll={markReadIfAtBottom}>
        {room.hasOlder && (
          <Button size="sm" variant="secondary" className="msgr-older" onClick={() => { atBottomRef.current = false; void room.loadOlder(); }}>
            {t('messenger.room.loadOlder')}
          </Button>
        )}
        {items.length === 0 && <div className="msgr-empty">{t('messenger.room.empty')}</div>}
        {items.map((item) => {
          const at = item.kind === 'fold' ? item.firstAt : item.message.at;
          const day = dayKey(at);
          const separator = day !== lastDay ? <div className="msgr-day-sep">{formatDay(at)}</div> : null;
          lastDay = day;
          if (item.kind === 'fold') {
            return (
              <Fragment key={`fold:${item.key}`}>
                {separator}
                <div className="msgr-folded">
                  {t('messenger.fold.summary', { count: item.count, from: formatTime(item.firstAt), to: formatTime(item.lastAt) })}
                  <Button size="sm" variant="secondary" onClick={() => setExpanded((current) => new Set(current).add(item.key))}>{t('messenger.fold.expand')}</Button>
                </div>
              </Fragment>
            );
          }
          const message = item.message;
          const kickable = isCreator && message.system?.event === 'invited' && message.system.subject !== undefined
            && message.system.actor !== me
            && roomData.people.some((person) => person.node === message.system?.subject);
          return (
            <Fragment key={message.clientMsgId}>
              {separator}
              {message.system !== undefined || message.from.kind === 'system'
                ? <SystemLine message={message} me={me} sessions={sessions} onKick={kickable ? (node) => void run(() => messengerApi.removeMember(roomData.id, node)) : undefined} />
                : <MessageItem message={message} room={mentionRoom} me={me} sessions={sessions} delivery={{ hostOnline, hostNode }} holdLimit={roomData.settings.holdLimit} />}
            </Fragment>
          );
        })}
        {roomData.held && (
          <div className="msgr-banner msgr-banner-warn msgr-hold" role="alert">
            <span aria-hidden="true">⏸</span>
            <span>
              <b>{t('messenger.hold.title', { count: roomData.agentRun })}</b><br />
              {t('messenger.hold.body')}{heldCount > 0 ? ` ${tn('messenger.hold.heldCount', heldCount)}` : ''}
            </span>
            <Button size="sm" onClick={() => void run(() => messengerApi.resume(roomData.id))}>{t('messenger.hold.resume')}</Button>
          </div>
        )}
      </div>
      {actionError !== null && <div className="msgr-err msgr-err-pad" role="alert">{actionError}</div>}
      <Composer room={mentionRoom} picker={pickerSource} onSend={send} notice={notice} />
    </div>
  );
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="msgr-back" aria-label={t('messenger.back')} title={t('messenger.back')} onClick={onClick}>‹</button>;
}

// One line of the room log: a message, a system line or a fold (mockups ①, ⑥, ⑨).
// @req FR-MSG-002 FR-MSG-003 FR-MSG-009 FR-MSG-013
import { Button } from '../ui';
import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import { labelMentions, splitMessageText, stripControlChars, type MentionRoom } from './mentions.ts';
import { agentRunLabel, deliveryLabel, localReceiptLabel, memberLabel, senderView, skipReasonHints, type DeliveryContext } from './messengerModel.ts';
import { formatTime } from './messengerFormat.ts';
import type { RoomMessage, RoomSession, SystemEvent } from './messengerTypes.ts';

/** A body with code rendered and mentions shown by the current names of the members in `to`. */
export function MessageText({ text, to, room }: { text: string; to: string[]; room: MentionRoom }) {
  return (
    <div className="msgr-text">
      {labelMentions(splitMessageText(stripControlChars(text)), to, room).map((segment, index) => {
        if (segment.kind === 'code') return <code key={index}>{segment.text}</code>;
        if (segment.kind === 'block') return <pre key={index} className="msgr-block"><code>{segment.text}</code></pre>;
        if (segment.kind === 'mention') {
          return (
            <span key={index} className="msgr-mt" title={segment.text}>
              {segment.shownNode !== null ? <span className="msgr-mt-pc">@{segment.shownNode}::</span> : '@'}
              {segment.shownName}
            </span>
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </div>
  );
}

const SYSTEM_KEYS: Record<SystemEvent, MessageKey> = {
  joined: 'messenger.system.joined',
  left: 'messenger.system.left',
  removed: 'messenger.system.removed',
  invited: 'messenger.system.invited',
  declined: 'messenger.system.declined',
  'session-added': 'messenger.system.sessionAdded',
  'session-removed': 'messenger.system.sessionRemoved',
  'host-moved': 'messenger.system.hostMoved',
  continued: 'messenger.system.continued',
};

interface SystemLineProps {
  message: RoomMessage;
  me: string;
  sessions: RoomSession[];
  /** Set for an 'invited' line the room creator may undo (FR-MSG-009 AC-4). */
  onKick?: (node: string) => void;
}

export function SystemLine({ message, me, sessions, onKick }: SystemLineProps) {
  const system = message.system;
  const label = (id: string | undefined) => (id === undefined ? '' : memberLabel(id, me, sessions));
  const text = system ? t(SYSTEM_KEYS[system.event], { actor: label(system.actor), subject: label(system.subject) }) : message.text;
  const subject = system?.subject;
  return (
    <div className={`msgr-sys${onKick && subject ? ' msgr-sys-action' : ''}`}>
      <span>{text}</span>
      {onKick && subject && (
        <Button size="sm" variant="danger-text" onClick={() => onKick(subject)}>{t('messenger.members.remove')}</Button>
      )}
    </div>
  );
}

interface MessageItemProps {
  message: RoomMessage;
  room: MentionRoom;
  me: string;
  sessions: RoomSession[];
  delivery: DeliveryContext;
  /** The room's hold limit, for 「연속 n/limit」. */
  holdLimit: number;
}

export function MessageItem({ message, room, me, sessions, delivery, holdLimit }: MessageItemProps) {
  const sender = senderView(message.from, me, sessions);
  const label = deliveryLabel(message, delivery);
  const pastedHere = localReceiptLabel(message);
  const run = agentRunLabel(message, holdLimit);
  const sessionTargets = message.to.filter((id) => id.includes('::')).length;
  return (
    <div className={`msgr-msg${message.seq === null ? ' is-sending' : ''}`}>
      <span className={`msgr-av msgr-av-${sender.tone}`} aria-hidden="true">{sender.initial}</span>
      <div className="msgr-msg-body">
        <div className="msgr-meta">
          <span className={`msgr-who msgr-who-${sender.tone}`}>{sender.name}</span>
          <span className="msgr-kind">{t(message.from.kind === 'agent' ? 'messenger.kind.agent' : 'messenger.kind.human')}</span>
          <span className="msgr-time">{formatTime(message.at)}</span>
        </div>
        <MessageText text={message.text} to={message.to} room={room} />
        {label !== null && (
          <div className="msgr-deliv">
            {pastedHere !== null && <span className={`msgr-deliv-${pastedHere.tone}`}>{t(pastedHere.key)}</span>}
            <span className={`msgr-deliv-${label.tone}`}>{t(label.key, label.params)}</span>
            {skipReasonHints(message.receipts ?? (message.localReceipt && { targets: 0, delivered: 0, ...message.localReceipt })).map((hint) => (
              <span key={hint.key} className="msgr-deliv-wait">{tn(hint.key, hint.count)}</span>
            ))}
            {sessionTargets > 0 && <span>{`1:${sessionTargets}`}</span>}
            {run !== null && <span>{t(run.key, run.params)}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

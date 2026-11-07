// FR-MSG-002 AC-2, FR-MSG-005: only the host (storage PC) numbers messages, and it counts the
// agent messages since the last human one (contract §4.1). Pure.
import type { Room, RoomMessage } from './types.js';

export function sequenceMessage(room: Room, message: RoomMessage): { room: Room; message: RoomMessage } {
  const seq = room.lastSeq + 1;
  const kind = message.from.kind;
  if (kind === 'human') {
    return { room: { ...room, lastSeq: seq, agentRun: 0, held: false }, message: { ...message, seq } };
  }
  if (kind === 'agent') {
    // FR-MSG-005 AC-2: the message that reaches the limit is itself held ('연속 n/상한').
    const agentRun = room.agentRun + 1;
    const limit = room.settings.holdLimit;
    return {
      room: { ...room, lastSeq: seq, agentRun, held: agentRun >= limit },
      message: { ...message, seq, agentRun, ...(agentRun >= limit ? { held: true } : {}) },
    };
  }
  return { room: { ...room, lastSeq: seq }, message: { ...message, seq } };
}

/** FR-MSG-005 AC-3: '기록만 두고 이어서 붙여넣기'. */
export function resumeRoom(room: Room): Room {
  return { ...room, agentRun: 0, held: false };
}

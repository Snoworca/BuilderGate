// FR-MSG-002 AC-2, FR-MSG-016: only the host (storage PC) numbers messages, and it counts the
// agent messages since the last human one (contract §4.1). Nothing is held any more. Pure.
import type { Room, RoomMessage } from './types.js';

export function sequenceMessage(room: Room, message: RoomMessage): { room: Room; message: RoomMessage } {
  const seq = room.lastSeq + 1;
  const kind = message.from.kind;
  if (kind === 'human') {
    return { room: { ...room, lastSeq: seq, agentRun: 0, held: false }, message: { ...message, seq } };
  }
  if (kind === 'agent') {
    // FR-MSG-016 AC-1/AC-3: counted, never held; a room an older version left held is freed here.
    const agentRun = room.agentRun + 1;
    return { room: { ...room, lastSeq: seq, agentRun, held: false }, message: { ...message, seq, agentRun } };
  }
  return { room: { ...room, lastSeq: seq }, message: { ...message, seq } };
}

/** '기록만 두고 이어서 붙여넣기' -- frees a room an older version held (FR-MSG-016 AC-3). */
export function resumeRoom(room: Room): Room {
  return { ...room, agentRun: 0, held: false };
}

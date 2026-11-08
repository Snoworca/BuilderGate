// FR-MSG-004 AC-2/AC-3: how a room message is written into a session.
//
// The MCP Enter policy (SessionInputGateway evaluateEnterPolicy) refuses any CR/LF unless the
// write is a submit with mcp:message.submit — it applies to agent sources only. The messenger is a
// trusted local caller with its own source, and keeps line breaks from acting as Enter another way:
// the text goes as a bracketed paste (the program asked for DECSET 2004), so the program receives it
// as pasted text. Enter, when the member has it on, is a write of its own. Callers paste only into
// sessions where an AI agent is detected (roomService deliverLocally); the detection can run ahead
// of the screen (it starts from the typed command), so DECSET 2004 is also the readiness check:
// agent TUIs set it, ex/vim/less do not, and without it nothing is written (AGENT_NOT_READY).

export const ROOM_PASTE_SOURCE = 'messenger-room';

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

export type RoomPaste = { ok: true; body: string; enter: boolean } | { ok: false; code: 'AGENT_NOT_READY' };

export function buildRoomPaste(text: string, mode: { bracketed: boolean; submit: boolean }): RoomPaste {
  if (mode.bracketed) {
    // A paste marker inside the text would end the paste early and let the rest act as typed input.
    const inner = text.split(PASTE_END).join('').split(PASTE_START).join('');
    return { ok: true, body: `${PASTE_START}${inner}${PASTE_END}`, enter: mode.submit };
  }
  return { ok: false, code: 'AGENT_NOT_READY' };
}

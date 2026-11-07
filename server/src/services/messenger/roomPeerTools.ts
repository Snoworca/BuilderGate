// Contract §3: buildergate.room.peer.* — server-to-server calls of the messenger. Not listed in MCP
// tools/list; callable only by an 'mcp-peer' actor (a request that arrived over a peer link). The
// room service checks that the calling node is a member (or the host) of the room.
import { ROOM_PEER, type RoomService } from './roomService.js';

type Rec = Record<string, unknown>;

export const ROOM_PEER_TOOL_NAMES: readonly string[] = Object.freeze(Object.values(ROOM_PEER));

export function isRoomPeerTool(name: string): boolean {
  return ROOM_PEER_TOOL_NAMES.includes(name);
}

export async function callRoomPeerTool(service: RoomService, tool: string, args: Rec, actor: Rec): Promise<Rec> {
  if (actor.type !== 'mcp-peer' || typeof actor.peer !== 'string' || !actor.peer) return { ok: false, code: 'INVALID_SCOPE' };
  const from = actor.peer;
  switch (tool) {
    case ROOM_PEER.invite: return service.peerInvite(from, args);
    case ROOM_PEER.join: return service.peerJoin(from, args);
    case ROOM_PEER.decline: return service.peerDecline(from, args);
    case ROOM_PEER.sync: return service.peerSync(from, args);
    case ROOM_PEER.post: return service.peerPost(from, args);
    case ROOM_PEER.deliver: return service.peerDeliver(from, args);
    case ROOM_PEER.member: return service.peerMember(from, args);
    case ROOM_PEER.ticket: return service.peerTicket(from, args);
    case ROOM_PEER.forwardInvite: return service.peerForwardInvite(from, args);
    case ROOM_PEER.adopt: return service.peerAdopt(from, args);
    case ROOM_PEER.hosted: return service.peerHosted(from, args);
    case ROOM_PEER.receipt: return service.peerReceipt(from, args);
    case ROOM_PEER.approval: return service.peerApproval(from, args);
    default: return { ok: false, code: 'UNKNOWN_TOOL' };
  }
}

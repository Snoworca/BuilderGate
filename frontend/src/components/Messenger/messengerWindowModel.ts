// The messenger window's small decisions as values: when the open room is gone, which room opens
// on its own, how a burst of broadcasts merges, which Enter is an IME one, the tab dot, the LAN port.
// @req FR-MSG-013 FR-MSG-014
import { messengerLayout, sortRooms } from './messengerModel.ts';
import { clampDialogRect } from '../dialog/dialogGeometry.ts';
import type { DialogRect, DialogSize } from '../dialog/types.ts';

/** The open room left the list (I left, or was removed). Unknown while the list has not loaded. */
/**
 * The name of the open room when it vanished from the list without my leaving it (I was removed or
 * the room ended), so the window can say why it closed; null otherwise.
 */
export function removedRoomNotice(
  previousRooms: Array<{ id: string; name: string }>,
  roomIds: string[] | null,
  openRoomId: string | null,
  leftByMe: boolean,
): string | null {
  if (leftByMe || !openRoomGone(roomIds, openRoomId)) return null;
  return previousRooms.find((room) => room.id === openRoomId)?.name ?? null;
}

export function openRoomGone(roomIds: string[] | null, openRoomId: string | null): boolean {
  return roomIds !== null && openRoomId !== null && !roomIds.includes(openRoomId);
}

/**
 * The room the split layout opens by itself: the newest, once the width is measured and only
 * when nothing is open. A guessed width would open a room on a window that shows one pane.
 */
export function autoOpenRoomId(
  width: number | null,
  isMobile: boolean,
  openRoomId: string | null,
  rooms: Array<{ id: string; lastAt: string }>,
): string | null {
  if (width === null || openRoomId !== null) return null;
  if (messengerLayout(width, isMobile) !== 'split') return null;
  return sortRooms(rooms)[0]?.id ?? null;
}

/**
 * The room a burst of `messenger:changed` broadcasts names. `null` is "no broadcast yet";
 * `undefined` is "anything may have changed".
 */
export function mergeChangedRoom(pending: string | undefined | null, roomId: string | undefined): string | undefined {
  if (pending === null) return roomId;
  return pending === roomId ? roomId : undefined;
}

/** Chrome marks a composing Enter with isComposing; Safari ends a Hangul composition with keyCode 229. */
export function isImeEnter(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** What the room dot on a tab or grid tile says, or null for a session in no room. */
export function roomDotLabelInput(sessionRooms: Record<string, string[]> | undefined, sessionKey: string | undefined): { count: number; rooms: string } | null {
  if (!sessionRooms || sessionKey === undefined) return null;
  const rooms = sessionRooms[sessionKey] ?? [];
  return rooms.length === 0 ? null : { count: rooms.length, rooms: rooms.join(', ') };
}

/** The LAN port field: empty keeps the current port. */
export function parseLanPort(text: string): { ok: true; port: number | undefined } | { ok: false } {
  const value = text.trim();
  if (value === '') return { ok: true, port: undefined };
  if (!/^\d{1,5}$/.test(value)) return { ok: false };
  const port = Number(value);
  return port >= 1 && port <= 65535 ? { ok: true, port } : { ok: false };
}

/** D3: my connection code is shown only while company-network connections are accepted. */
export function visibleConnectionCode(code: string | null, receiving: boolean): string | null {
  return receiving ? code : null;
}

export const MESSENGER_MIN_SIZE: DialogSize = { width: 300, height: 360 };

/** D6: the window rect fitted to the viewport, so no edge (the bottom included) leaves the screen. */
export function fitMessengerWindow(rect: DialogRect, viewport: DialogSize): DialogRect {
  return clampDialogRect(rect, viewport, MESSENGER_MIN_SIZE);
}

/**
 * FR-MSG-013 AC-2: the rect to keep after a move or resize. The window is drawn fitted to the
 * viewport; a move of that fitted rect keeps the size the user chose, so widening the browser again
 * brings it back. A change of size is the user's new size.
 */
export function nextPlacedRect(
  placed: { x: number; y: number; width: number; height: number },
  rendered: { width: number; height: number },
  next: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const moved = next.width === rendered.width && next.height === rendered.height;
  return moved ? { x: next.x, y: next.y, width: placed.width, height: placed.height } : { ...next };
}

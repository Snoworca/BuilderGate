// The messenger's state (`GET /api/messenger/state`), refetched on the
// `messenger:changed` broadcast (debounced) and when the window opens.
// @req FR-MSG-013
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocketActions, useWebSocketState } from '../../contexts/WebSocketContext';
import { messengerApi } from '../../services/api.ts';
import { mergeRoomMessages } from './messengerModel.ts';
import { mergeChangedRoom } from './messengerWindowModel.ts';
import type { MessengerState, RoomDetail, RoomMessage } from './messengerTypes.ts';

export const MESSENGER_CHANGED_EVENT = 'messenger:changed';
const REFETCH_DEBOUNCE_MS = 150;

export interface MessengerChange {
  /** Bumps on every broadcast, so a room view can refetch. */
  seq: number;
  /** The room the broadcast named; undefined means "anything may have changed". */
  roomId?: string;
}

export interface UseMessengerResult {
  state: MessengerState | null;
  error: string | null;
  change: MessengerChange;
  refresh: () => Promise<void>;
}

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function useMessenger(): UseMessengerResult {
  const { registerAppEventHandler } = useWebSocketActions();
  const { status } = useWebSocketState();
  const [state, setState] = useState<MessengerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<MessengerChange>({ seq: 0 });
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await messengerApi.state();
      if (request !== requestRef.current) return;
      setState(next);
      setError(null);
    } catch (reason) {
      if (request === requestRef.current) setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') void refresh();
  }, [status, refresh]);

  // A burst of broadcasts becomes one refetch of the state and one of the open room. Rooms named
  // in the burst merge: one room stays named, two or more become "anything".
  const pendingRoomRef = useRef<string | undefined | null>(null);
  useEffect(() => registerAppEventHandler(MESSENGER_CHANGED_EVENT, (data) => {
    const raw = (data as { roomId?: unknown } | null)?.roomId;
    const roomId = typeof raw === 'string' ? raw : undefined;
    pendingRoomRef.current = mergeChangedRoom(pendingRoomRef.current, roomId);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const named = pendingRoomRef.current ?? undefined;
      pendingRoomRef.current = null;
      setChange((current) => ({ seq: current.seq + 1, roomId: named }));
      void refresh();
    }, REFETCH_DEBOUNCE_MS);
  }), [registerAppEventHandler, refresh]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { state, error, change, refresh };
}

export interface UseRoomDetailResult {
  detail: RoomDetail | null;
  error: string | null;
  /** Messages and my unsequenced outbox, oldest first, without duplicates. */
  messages: RoomMessage[];
  reload: () => Promise<void>;
  loadOlder: () => Promise<void>;
  hasOlder: boolean;
}

const PAGE = 50;

/** One room's log and members, refetched when a broadcast names it (or names nothing). */
export function useRoomDetail(roomId: string | null, change: MessengerChange): UseRoomDetailResult {
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [older, setOlder] = useState<RoomMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    if (roomId === null) return;
    const request = ++requestRef.current;
    try {
      const next = await messengerApi.room(roomId);
      if (request !== requestRef.current) return;
      setDetail(next);
      setError(null);
      setHasOlder((current) => current || next.messages.length >= PAGE);
    } catch (reason) {
      if (request === requestRef.current) setError(errorText(reason));
    }
  }, [roomId]);

  useEffect(() => {
    setDetail(null);
    setOlder([]);
    setHasOlder(false);
    setError(null);
    void reload();
  }, [reload]);

  // Only broadcasts that arrive after this room was opened refetch it; the open itself already did.
  const seenChangeRef = useRef(change.seq);
  useEffect(() => {
    if (change.seq === seenChangeRef.current) return;
    seenChangeRef.current = change.seq;
    if (change.roomId === undefined || change.roomId === roomId) void reload();
  }, [change, roomId, reload]);

  const messages = useMemo(() => mergeRoomMessages(older, detail?.messages ?? [], detail?.outbox ?? []), [older, detail]);

  // A page that comes back after the user switched rooms belongs to the old room: drop it.
  const roomRef = useRef(roomId);
  roomRef.current = roomId;
  const loadOlder = useCallback(async () => {
    if (roomId === null) return;
    const first = messages.find((message) => message.seq !== null)?.seq;
    if (first === undefined || first === null) return;
    try {
      const page = await messengerApi.room(roomId, first);
      if (roomRef.current !== roomId) return;
      setOlder((current) => [...page.messages, ...current]);
      setHasOlder(page.messages.length >= PAGE);
    } catch (reason) {
      if (roomRef.current === roomId) setError(errorText(reason));
    }
  }, [roomId, messages]);

  return { detail, error, messages, reload, loadOlder, hasOlder };
}

// Mockup ①/⑧: the modeless messenger window. Room list on the left, the open
// room on the right; narrower than 640px (or on a phone) one pane at a time.
// The layer also hosts what must show while the window is closed: the
// invitation toast and the dialogs.
// @req FR-MSG-013 FR-MSG-010
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { messengerApi } from '../../services/api.ts';
import { ContactsDialog } from './ContactsDialog.tsx';
import { InviteToast, JoinDialog } from './JoinDialog.tsx';
import { MembersPanel } from './MembersPanel.tsx';
import { RoomFormDialog } from './RoomFormDialog.tsx';
import { RoomList } from './RoomList.tsx';
import { BackButton, RoomView } from './RoomView.tsx';
import type { PickerWorkspace } from './SessionPicker.tsx';
import { messengerLayout, visiblePanes } from './messengerModel.ts';
import { autoOpenRoomId, fitMessengerWindow, MESSENGER_MIN_SIZE, openRoomGone, removedRoomNotice } from './messengerWindowModel.ts';
import { readDialogGeometry, writeDialogGeometry } from '../dialog/dialogGeometry';
import type { DialogRect } from '../dialog/types';
import { errorText, useLocalSessions, useViewportRect } from './messengerFormat.ts';
import type { Invite } from './messengerTypes.ts';
import { useRoomDetail, type UseMessengerResult } from './useMessenger.ts';
import './Messenger.css';

const MESSENGER_DEFAULT_RECT: DialogRect = { x: 160, y: 70, width: 720, height: 540 };

type MessengerDialog =
  | { kind: 'new-room' }
  | { kind: 'invite' }
  | { kind: 'contacts'; name?: string }
  | { kind: 'join'; invite: Invite };

interface MessengerLayerProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  messenger: UseMessengerResult;
  workspaces: PickerWorkspace[];
  isMobile: boolean;
}

export function MessengerLayer({ open, onOpen, onClose, messenger, workspaces, isMobile }: MessengerLayerProps) {
  const [dialog, setDialog] = useState<MessengerDialog | null>(null);
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [toastError, setToastError] = useState<string | null>(null);
  const { state, refresh } = messenger;

  // FR-MSG-013: the window refetches whenever it opens.
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const toastInvite = state?.invites.find((invite) => !dismissed.has(invite.id)) ?? null;
  const dismiss = (id: string) => setDismissed((current) => new Set(current).add(id));

  // The list must hold the room before it is opened, or the window would close it as gone.
  const openRoom = async (roomId: string) => {
    await refresh();
    setOpenRoomId(roomId);
    onOpen();
  };

  return (
    <>
      {open && (
        <MessengerWindow
          messenger={messenger}
          isMobile={isMobile}
          openRoomId={openRoomId}
          onOpenRoom={setOpenRoomId}
          onClose={onClose}
          onDialog={setDialog}
        />
      )}
      {toastInvite && dialog === null && (
        <div className="msgr-toast-host">
          <InviteToast
            invite={toastInvite}
            onDismiss={() => dismiss(toastInvite.id)}
            onJoin={() => { dismiss(toastInvite.id); setDialog({ kind: 'join', invite: toastInvite }); }}
            onDecline={() => {
              dismiss(toastInvite.id);
              messengerApi.declineInvite(toastInvite.id).then(() => refresh()).catch((reason) => setToastError(errorText(reason)));
            }}
          />
          {toastError !== null && <div className="msgr-err" role="alert">{toastError}</div>}
        </div>
      )}
      {state && dialog?.kind === 'contacts' && (
        <ContactsDialog
          state={state}
          initialName={dialog.name}
          onInvite={(invite) => { void refresh(); setDialog({ kind: 'join', invite }); }}
          onClose={() => setDialog(null)}
          onChanged={() => void refresh()}
        />
      )}
      {state && (dialog?.kind === 'new-room' || dialog?.kind === 'invite') && (
        <RoomFormHost
          kind={dialog.kind}
          roomId={openRoomId}
          messenger={messenger}
          workspaces={workspaces}
          onClose={() => setDialog(null)}
          onDone={(roomId) => { setDialog(null); void openRoom(roomId); }}
        />
      )}
      {dialog?.kind === 'join' && (
        <JoinHost
          invite={dialog.invite}
          workspaces={workspaces}
          onClose={() => setDialog(null)}
          onJoined={(roomId) => { setDialog(null); void openRoom(roomId); }}
        />
      )}
    </>
  );
}

function RoomFormHost({ kind, roomId, messenger, workspaces, onClose, onDone }: {
  kind: 'new-room' | 'invite';
  roomId: string | null;
  messenger: UseMessengerResult;
  workspaces: PickerWorkspace[];
  onClose: () => void;
  onDone: (roomId: string) => void;
}) {
  const { sessions } = useLocalSessions();
  const room = useRoomDetail(kind === 'invite' ? roomId : null, messenger.change);
  if (!messenger.state || (kind === 'invite' && !room.detail)) return null;
  return (
    <RoomFormDialog
      room={kind === 'invite' ? room.detail?.room : undefined}
      me={messenger.state.me.name}
      contacts={messenger.state.contacts}
      sessions={sessions}
      workspaces={workspaces}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function JoinHost({ invite, workspaces, onClose, onJoined }: { invite: Invite; workspaces: PickerWorkspace[]; onClose: () => void; onJoined: (roomId: string) => void }) {
  const { sessions } = useLocalSessions();
  return <JoinDialog invite={invite} sessions={sessions} workspaces={workspaces} onClose={onClose} onJoined={onJoined} />;
}

interface MessengerWindowProps {
  messenger: UseMessengerResult;
  isMobile: boolean;
  openRoomId: string | null;
  onOpenRoom: (roomId: string | null) => void;
  onClose: () => void;
  onDialog: (dialog: MessengerDialog) => void;
}

function MessengerWindow({ messenger, isMobile, openRoomId, onOpenRoom, onClose, onDialog }: MessengerWindowProps) {
  const { state, error, change, refresh } = messenger;
  const rootRef = useRef<HTMLDivElement>(null);
  // Unknown until measured: a guess would pick the split layout and open a room on a narrow window.
  const [width, setWidth] = useState<number | null>(null);
  const viewport = useViewportRect();
  const [placed, setPlaced] = useState<DialogRect>(() => readDialogGeometry('messenger', MESSENGER_DEFAULT_RECT, viewport, MESSENGER_MIN_SIZE));
  const placeWindow = (next: DialogRect) => {
    const fitted = fitMessengerWindow(next, viewport);
    setPlaced(fitted);
    writeDialogGeometry('messenger', fitted);
  };
  const [membersOpen, setMembersOpen] = useState(false);
  const { sessions: localSessions } = useLocalSessions();
  const room = useRoomDetail(openRoomId, change);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    setWidth(root.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? root.clientWidth));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // In the split layout a room is always open: the newest one, until the user picks.
  const rooms = state?.rooms ?? [];
  const layout = messengerLayout(width ?? 0, isMobile);
  const autoRoomId = autoOpenRoomId(width, isMobile, openRoomId, rooms);
  useEffect(() => {
    if (autoRoomId !== null) onOpenRoom(autoRoomId);
  }, [autoRoomId, onOpenRoom]);
  // A room I left or was removed from drops out of the list; stop showing it.
  const roomIds = state ? rooms.map((candidate) => candidate.id) : null;
  const roomGone = openRoomGone(roomIds, openRoomId);
  // FR-MSG-001 AC-4: when the open room vanishes without my leaving it, say so instead of just closing it.
  const previousRoomsRef = useRef<Array<{ id: string; name: string }>>([]);
  const leftByMeRef = useRef(false);
  const [removedNotice, setRemovedNotice] = useState<string | null>(null);
  useEffect(() => {
    if (roomGone) {
      setRemovedNotice(removedRoomNotice(previousRoomsRef.current, roomIds, openRoomId, leftByMeRef.current));
      leftByMeRef.current = false;
      setMembersOpen(false);
      onOpenRoom(null);
    }
  }, [roomGone, onOpenRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state) previousRoomsRef.current = rooms.map((candidate) => ({ id: candidate.id, name: candidate.name }));
  });

  const panes = visiblePanes(layout, openRoomId);
  const summary = rooms.find((candidate) => candidate.id === openRoomId);

  return (
    <>
    <WindowDialog
      dialogId="messenger"
      title={state ? `${t('messenger.title')} · ${state.me.name}` : t('messenger.title')}
      mode="modeless"
      defaultRect={MESSENGER_DEFAULT_RECT}
      minSize={MESSENGER_MIN_SIZE}
      onClose={onClose}
      titlebarActions={(
        <Button size="sm" variant="secondary" onClick={() => onDialog({ kind: 'contacts' })} disabled={!state}>
          {t('messenger.contacts.title')}
        </Button>
      )}
      {...(isMobile
        ? { rect: viewport, movable: false, resizable: false, persistGeometry: false }
        // D6: held here and fitted to the viewport, so a smaller screen pulls the bottom back in.
        // FR-MSG-013 AC-2: the dialog's own saving would store its first rect, so this window saves itself.
        : { rect: fitMessengerWindow(placed, viewport), onRectChange: placeWindow, persistGeometry: false })}
    >
      <div className={`msgr msgr-${layout}`} ref={rootRef} data-testid="messenger-window">
        {!state ? (
          <div className="msgr-empty">{error !== null ? t('messenger.loadError', { error }) : ''}</div>
        ) : (
          <>
            {removedNotice !== null && (
              <div className="msgr-removed-notice" role="status">
                <span>{t('messenger.room.removedNotice', { room: removedNotice })}</span>
                <Button size="sm" variant="secondary" onClick={() => setRemovedNotice(null)}>{t('messenger.room.removedNoticeClose')}</Button>
              </div>
            )}
            {panes.list && (
              <RoomList
                state={state}
                openRoomId={openRoomId}
                onOpenRoom={(roomId) => onOpenRoom(roomId)}
                onNewRoom={() => onDialog({ kind: 'new-room' })}
                onJoin={(invite) => onDialog({ kind: 'join', invite })}
                onChanged={() => void refresh()}
              />
            )}
            {panes.room && openRoomId !== null && (
              <RoomView
                key={openRoomId}
                summary={summary}
                state={state}
                room={room}
                localSessions={localSessions}
                showBack={layout === 'single'}
                onBack={() => onOpenRoom(null)}
                onOpenMembers={() => setMembersOpen(true)}
                onInvite={() => onDialog({ kind: 'invite' })}
              />
            )}
            {panes.room && openRoomId === null && (
              <div className="msgr-chat msgr-empty">
                {layout === 'single' && <BackButton onClick={() => onOpenRoom(null)} />}
                {t('messenger.room.pick')}
              </div>
            )}
          </>
        )}
      </div>
    </WindowDialog>
      {membersOpen && state && room.detail && (
        <MembersPanel
          key={room.detail.room.id}
          detail={room.detail}
          me={state.me.name}
          contacts={state.contacts}
          isMobile={isMobile}
          onClose={() => setMembersOpen(false)}
          onChanged={() => { void room.reload(); void refresh(); }}
          onLeft={async () => { leftByMeRef.current = true; await refresh(); setMembersOpen(false); onOpenRoom(null); leftByMeRef.current = false; }}
          onContinued={async (next) => { await refresh(); setMembersOpen(false); onOpenRoom(next.id); }}
          onAddContact={(node) => onDialog({ kind: 'contacts', name: node })}
        />
      )}
    </>
  );
}

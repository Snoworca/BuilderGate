// FR-MSG-001..013, 015 (contract §9): the messenger REST surface for the window, mounted at
// /api/messenger behind the JWT middleware. Contacts, codes and LAN live in messengerNetRoutes.ts
// (same prefix); /state merges their views. Every result is { ok, ... } or { ok: false, code }.
import { Router, type Request, type Response } from 'express';
import type { RoomService } from '../services/messenger/roomService.js';

type Rec = Record<string, unknown>;

export interface MessengerRoutesDeps {
  rooms: RoomService;
  net?: { contactsView(): unknown[]; requestsView(): unknown[] };
  lan?: () => { receiving: boolean } | Promise<{ receiving: boolean }>;
}

const STATUS_BY_CODE: Record<string, number> = {
  ROOM_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  APPROVAL_NOT_FOUND: 404,
  NOT_CREATOR: 403,
  HOST_OFFLINE: 409,
  TARGET_OFFLINE: 409,
};

function reply(res: Response, result: Rec): void {
  if (result.ok === false) {
    res.status(STATUS_BY_CODE[String(result.code)] ?? 400).json(result);
    return;
  }
  res.json(result.ok === true ? result : { ok: true, ...result });
}

function handle(work: (req: Request) => Promise<Rec> | Rec) {
  return async (req: Request, res: Response) => {
    try {
      reply(res, await work(req));
    } catch (error) {
      console.error('[Messenger] Request failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
    }
  };
}

function body(req: Request): Rec {
  return req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Rec : {};
}

function numberQuery(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createMessengerRoutes(deps: MessengerRoutesDeps): Router {
  const router = Router();
  const { rooms } = deps;

  router.get('/state', handle(async () => ({
    ok: true,
    ...rooms.state(),
    lan: deps.lan ? await deps.lan() : { receiving: false },
    contacts: deps.net?.contactsView() ?? [],
    requests: deps.net?.requestsView() ?? [],
  })));

  router.post('/rooms', handle((req) => rooms.createRoom(body(req) as Parameters<RoomService['createRoom']>[0])));
  router.get('/rooms/:id', handle((req) => rooms.getRoom(req.params.id, { before: numberQuery(req.query.before), limit: numberQuery(req.query.limit) })));
  router.post('/rooms/:id/messages', handle((req) => rooms.postFromUi(req.params.id, body(req).text)));
  router.post('/rooms/:id/read', handle((req) => rooms.markRead(req.params.id, body(req).seq)));
  router.post('/rooms/:id/invite', handle((req) => rooms.invite(req.params.id, body(req))));
  router.post('/rooms/:id/invite-code', handle((req) => rooms.inviteCode(req.params.id, body(req).message)));
  router.delete('/rooms/:id/members/:memberId', handle((req) => rooms.removeMember(req.params.id, req.params.memberId)));
  router.post('/rooms/:id/leave', handle((req) => rooms.leave(req.params.id)));
  router.patch('/rooms/:id/settings', handle(async (req) => {
    const result = await rooms.updateSettings(req.params.id, body(req));
    if (result.ok === false) return result;
    const view = await rooms.getRoom(req.params.id, { limit: 1 });
    return { ok: true, room: view.room };
  }));
  router.patch('/rooms/:id/sessions/:sessionKey', handle((req) => rooms.updateSession(req.params.id, req.params.sessionKey, body(req))));
  router.post('/rooms/:id/resume', handle((req) => rooms.resume(req.params.id)));
  router.post('/rooms/:id/transfer', handle((req) => rooms.transfer(req.params.id, String(body(req).node ?? ''))));
  router.post('/rooms/:id/continue', handle((req) => rooms.continueRoom(req.params.id)));
  router.post('/invites/:id/accept', handle((req) => rooms.acceptInvite(req.params.id, body(req))));
  router.post('/invites/:id/decline', handle((req) => rooms.declineInvite(req.params.id)));
  router.post('/approvals/:id', handle((req) => rooms.decideApproval(req.params.id, body(req).approve === true)));
  router.patch('/settings', handle((req) => rooms.setWebhook(body(req).webhookUrl)));
  router.get('/search', handle((req) => rooms.search(typeof req.query.q === 'string' ? req.query.q : '')));

  return router;
}

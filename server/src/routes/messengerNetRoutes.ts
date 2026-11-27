// FR-MSG-008, FR-MSG-014 (contract §9): contacts, connection codes and LAN receiving over REST.
// Mounted at /api/messenger behind the JWT middleware; the room routes share the prefix.
import { Router, type Request, type Response } from 'express';
import type { MessengerNet, NetResult } from '../services/messenger/contacts.js';
import type { LanProtocol } from '../services/messenger/lanListener.js';

type Handler = (req: Request) => Promise<NetResult> | NetResult;

export function createMessengerNetRoutes(net: MessengerNet): Router {
  const router = Router();
  const route = (handler: Handler) => async (req: Request, res: Response) => {
    try {
      send(res, await handler(req));
    } catch (error) {
      console.error('[Messenger] request failed:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ ok: false, code: 'INTERNAL_ERROR' });
    }
  };

  router.patch('/me', route((req) => {
    const name = stringField(req, 'name');
    return name === undefined ? invalidInput() : net.renameMe(name);
  }));

  router.get('/code', route(() => net.connectionCode()));

  router.post('/codes/redeem', route((req) => {
    const code = stringField(req, 'code');
    return code === undefined ? invalidInput() : net.redeemCode(code);
  }));

  router.post('/contacts', route((req) => {
    const name = stringField(req, 'name');
    const address = stringField(req, 'address');
    return name === undefined || address === undefined ? invalidInput() : net.addContactByAddress({ name, address });
  }));

  router.delete('/contacts/:name', route((req) => net.removeContact(String(req.params.name))));
  router.post('/requests/:id/accept', route((req) => net.acceptRequest(String(req.params.id))));
  router.post('/requests/:id/decline', route((req) => net.declineRequest(String(req.params.id))));

  router.get('/lan', route(() => net.lan()));
  router.patch('/lan', route((req) => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const { receiving, port, protocol, allowList } = body;
    if (typeof receiving !== 'boolean' || (port !== undefined && typeof port !== 'number')) return invalidInput();
    // FR-MSG-014 AC-3/AC-4: the values themselves are checked by the receiver (LAN_PROTOCOL_INVALID, LAN_ALLOW_LIST_INVALID).
    if (protocol !== undefined && typeof protocol !== 'string') return invalidInput();
    if (allowList !== undefined && !(Array.isArray(allowList) && allowList.every((entry) => typeof entry === 'string'))) return invalidInput();
    return net.setLan({
      receiving,
      ...(port === undefined ? {} : { port }),
      ...(protocol === undefined ? {} : { protocol: protocol as LanProtocol }),
      ...(allowList === undefined ? {} : { allowList: allowList as string[] }),
    });
  }));

  return router;
}

function send(res: Response, result: NetResult): void {
  if (result.ok !== false) {
    res.json(result);
    return;
  }
  res.status(typeof result.code === 'string' && result.code.endsWith('_NOT_FOUND') ? 404 : 400).json(result);
}

function stringField(req: Request, name: string): string | undefined {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

function invalidInput(): NetResult {
  return { ok: false, code: 'INVALID_INPUT' };
}

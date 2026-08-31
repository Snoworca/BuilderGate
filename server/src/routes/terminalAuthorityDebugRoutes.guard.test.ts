import assert from 'node:assert/strict';
import test from 'node:test';
import type express from 'express';
import {
  ensureDebugCaptureSessionExists,
  requireLocalDebugCapture,
} from '../middleware/debugCaptureGuards.js';
import {
  registerTerminalAuthorityDebugRoutes,
  type TerminalAuthorityDebugMiddleware,
} from './terminalAuthorityDebugRoutes.js';

interface RegisteredRoute {
  path: string;
  handlers: TerminalAuthorityDebugMiddleware[];
}

function createResponseRecorder(): {
  response: Record<string, unknown>;
  read: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown = null;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  };
  return { response, read: () => ({ status, body }) };
}

function registerHarness(input: {
  auth: TerminalAuthorityDebugMiddleware;
  locality: TerminalAuthorityDebugMiddleware;
  session: TerminalAuthorityDebugMiddleware;
  handler: TerminalAuthorityDebugMiddleware;
}): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  registerTerminalAuthorityDebugRoutes({
    registrar: {
      post(path, ...handlers) {
        routes.push({ path, handlers });
      },
    },
    authMiddleware: input.auth,
    requireLocalDebugCapture: input.locality,
    requireExistingDebugSession: input.session,
    handleTestIsolation: input.handler,
    handleRollback: input.handler,
    handleFault: input.handler,
  });
  return routes;
}

function invokeChain(
  handlers: readonly TerminalAuthorityDebugMiddleware[],
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  let index = -1;
  const next = (): void => {
    index += 1;
    handlers[index]?.(request, response, next);
  };
  next();
}

test('terminal authority debug routes register the exact three mutation paths with one fixed guard chain', () => {
  const auth = () => undefined;
  const locality = () => undefined;
  const session = () => undefined;
  const handler = () => undefined;
  const routes = registerHarness({ auth, locality, session, handler });

  assert.deepEqual(routes.map(route => route.path), [
    '/api/sessions/debug-capture/:id/terminal-authority-test-isolation',
    '/api/sessions/debug-capture/:id/terminal-authority-rollback',
    '/api/sessions/debug-capture/:id/terminal-authority-fault',
  ]);
  for (const route of routes) {
    assert.deepEqual(route.handlers, [auth, locality, session, handler]);
  }
});

test('terminal authority debug route authentication rejection short-circuits locality session and handler', () => {
  const calls: string[] = [];
  const routes = registerHarness({
    auth: (_request, response) => {
      calls.push('auth');
      const responseWithStatus = (response.status as (code: number) => Record<string, unknown>)(401);
      (responseWithStatus.json as (body: unknown) => unknown)({
        error: { code: 'MISSING_TOKEN' },
      });
    },
    locality: (_request, _response, next) => {
      calls.push('locality');
      next();
    },
    session: (_request, _response, next) => {
      calls.push('session');
      next();
    },
    handler: () => calls.push('handler'),
  });
  const recorder = createResponseRecorder();
  invokeChain(routes[0]!.handlers, { ip: '127.0.0.1', params: { id: 'session-1' } }, recorder.response);

  assert.deepEqual(calls, ['auth']);
  assert.equal(recorder.read().status, 401);
});

test('terminal authority debug route remote rejection short-circuits session lookup and handler', () => {
  const calls: string[] = [];
  const locality = ((request, response, next) => {
    calls.push('locality');
    requireLocalDebugCapture(
      request as unknown as express.Request,
      response as unknown as express.Response,
      next,
    );
  }) satisfies TerminalAuthorityDebugMiddleware;
  const routes = registerHarness({
    auth: (_request, _response, next) => {
      calls.push('auth');
      next();
    },
    locality,
    session: (_request, _response, next) => {
      calls.push('session');
      next();
    },
    handler: () => calls.push('handler'),
  });
  const recorder = createResponseRecorder();
  invokeChain(routes[0]!.handlers, { ip: '192.168.10.25', params: { id: 'session-1' } }, recorder.response);

  assert.deepEqual(calls, ['auth', 'locality']);
  assert.equal(recorder.read().status, 403);
  assert.equal(
    (recorder.read().body as { error?: { code?: string } }).error?.code,
    'LOCALHOST_ONLY',
  );
});

test('terminal authority debug route runs session guard before handler and rejects a missing session', () => {
  const calls: string[] = [];
  const locality = ((request, response, next) => {
    calls.push('locality');
    requireLocalDebugCapture(
      request as unknown as express.Request,
      response as unknown as express.Response,
      next,
    );
  }) satisfies TerminalAuthorityDebugMiddleware;
  const sessionGuard = ensureDebugCaptureSessionExists({
    hasSession: () => {
      calls.push('session');
      return false;
    },
  });
  const routes = registerHarness({
    auth: (_request, _response, next) => {
      calls.push('auth');
      next();
    },
    locality,
    session: (request, response, next) => sessionGuard(
      request as unknown as express.Request,
      response as unknown as express.Response,
      next,
    ),
    handler: () => calls.push('handler'),
  });
  const recorder = createResponseRecorder();
  invokeChain(routes[0]!.handlers, { ip: '127.0.0.1', params: { id: 'missing' } }, recorder.response);

  assert.deepEqual(calls, ['auth', 'locality', 'session']);
  assert.equal(recorder.read().status, 404);
  assert.equal(
    (recorder.read().body as { error?: { code?: string } }).error?.code,
    'SESSION_NOT_FOUND',
  );
});

test('terminal authority debug route invokes the handler only after auth locality and existing-session guards', () => {
  const calls: string[] = [];
  const locality = ((request, response, next) => {
    calls.push('locality');
    requireLocalDebugCapture(
      request as unknown as express.Request,
      response as unknown as express.Response,
      next,
    );
  }) satisfies TerminalAuthorityDebugMiddleware;
  const sessionGuard = ensureDebugCaptureSessionExists({
    hasSession: () => {
      calls.push('session');
      return true;
    },
  });
  const routes = registerHarness({
    auth: (_request, _response, next) => {
      calls.push('auth');
      next();
    },
    locality,
    session: (request, response, next) => sessionGuard(
      request as unknown as express.Request,
      response as unknown as express.Response,
      next,
    ),
    handler: () => calls.push('handler'),
  });
  const recorder = createResponseRecorder();
  invokeChain(routes[0]!.handlers, { ip: '::1', params: { id: 'session-1' } }, recorder.response);

  assert.deepEqual(calls, ['auth', 'locality', 'session', 'handler']);
  assert.equal(recorder.read().status, 200);
});

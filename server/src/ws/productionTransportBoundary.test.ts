import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { WsRouter } from './WsRouter.js';
import { isBinaryNegotiable, decideTerminalWireFormat } from './terminalWireFormat.js';
import type { AuthService } from '../services/AuthService.js';
import type { SessionManager } from '../services/SessionManager.js';

// @req REL-BGSTAB-024
//
// GitHub issue #3 closed the split contract drift as 0B: the split transport is
// deferred, not restored and not deleted. That decision only means something if
// the boundary it names is observable, so this file pins the boundary rather
// than the split behaviour itself.
//
// Nothing here changes production behaviour. Every assertion below already held
// at the commit that introduced it; they exist so that a later change which
// quietly moves split into the production wiring cannot pass unnoticed. That is
// why there is no red-first commit for this file: REL-BGSTAB-024 contracts an
// existing boundary, and a characterization test for an existing boundary is
// green on its first run by construction.
//
// Four of the assertions read sibling TypeScript sources. Like
// TerminalAuthorityController.test.ts, TerminalResourcePolicyCanary.test.ts,
// benchmarks/terminalFairnessCharacterization.test.ts and
// TerminalAuthorityProductionRegression.test.ts, this file is therefore
// src-only: `node --test dist/...` cannot run it, because the build emits .d.ts
// without copying the .ts sources. Run it as
// `npx tsx --test src/ws/productionTransportBoundary.test.ts` from `server/`.

const INDEX_SOURCE_URL = new URL('../index.ts', import.meta.url);
const TEST_RUNNER_SOURCE_URL = new URL('../test-runner.ts', import.meta.url);
const WS_ROUTER_SOURCE_URL = new URL('./WsRouter.ts', import.meta.url);
const WEB_SOCKET_URL_SOURCE_URL = new URL(
  '../../../frontend/src/utils/webSocketUrl.ts',
  import.meta.url,
);

/**
 * The same guard TerminalResourcePolicyCanary.test.ts uses: assert that the
 * sources really are here, so a dist run fails loudly on its own terms instead
 * of reporting a vacuous pass or a bare ENOENT.
 */
function readSource(url: URL): string {
  assert.equal(
    existsSync(url),
    true,
    `${url.pathname} must exist; this suite reads TypeScript sources and is src-only`,
  );
  return readFileSync(url, 'utf8');
}

/**
 * The production option object, sliced exactly the way the existing
 * `assert.doesNotMatch(construction, /wsTransportMode/u)` check in
 * test-runner.ts slices it, including that check's own guard against a slice
 * that stops early at a nested `});` and makes every negative assertion vacuous.
 */
function readProductionWsRouterConstruction(): string {
  const source = readSource(INDEX_SOURCE_URL);
  const start = source.indexOf('new WsRouter(authService, sessionManager, {');
  assert.notEqual(start, -1, 'the production WsRouter construction site must exist');
  const end = source.indexOf('});', start);
  assert.notEqual(end, -1, 'the construction site must close');
  const construction = source.slice(start, end);
  assert.match(
    construction,
    /terminalResourcePolicyAuthority:/u,
    'the slice must span the whole option object, or the negative checks go vacuous',
  );
  return construction;
}

function createRouter(realtime?: { wsTransportMode?: 'unified' | 'split-shadow' | 'split' }): WsRouter {
  const authServiceStub = {
    verifyToken: () => ({ valid: true, payload: { sub: 'user-1', jti: 'token-1' } }),
  } as unknown as AuthService;
  const sessionManagerStub = {
    getSession: (sessionId: string) => ({ id: sessionId, status: 'idle' }),
    getLastCwd: () => undefined,
    getScreenSnapshot: () => null,
    subscribe: () => () => {},
    on: () => {},
    off: () => {},
  } as unknown as SessionManager;
  return new WsRouter(
    authServiceStub,
    sessionManagerStub,
    realtime ? { realtime } : {},
  );
}

// @req REL-BGSTAB-024 AC-1
test('REL-BGSTAB-024 the production WsRouter construction withholds the configured transport mode', () => {
  const construction = readProductionWsRouterConstruction();

  // The whole 0B decision rests on this omission. index.ts hands the router
  // realtime.terminalWireFormat and nothing else off realtime, so the router's
  // own transport mode falls back to its literal default.
  assert.doesNotMatch(
    construction,
    /wsTransportMode/u,
    'production must not wire realtime.wsTransportMode into the router; see REL-BGSTAB-024 AC-1',
  );

  // The positive half. Without this, deleting the realtime option entirely
  // would also satisfy the assertion above, and the two keys would stop being
  // orthogonal in the direction IR-BGSTAB-001 AC-7 cares about.
  assert.match(
    construction,
    /realtime:\s*\{[^}]*terminalWireFormat:\s*config\.realtime\?\.terminalWireFormat/u,
    'the wire format setting must still reach the router',
  );
});

// @req REL-BGSTAB-024 AC-1
test('REL-BGSTAB-024 the existing test-runner assertion that pins the omission is still present', () => {
  const source = readSource(TEST_RUNNER_SOURCE_URL);

  // AC-1 names this assertion as the transition metric for the deferral. If the
  // assertion is deleted, the boundary stops being observed even while the
  // construction site above happens to remain correct, so the metric itself is
  // pinned rather than only its current outcome.
  assert.match(
    source,
    /assert\.doesNotMatch\(construction,\s*\/wsTransportMode\/u\)/u,
    'test-runner.ts must keep the assertion REL-BGSTAB-024 AC-1 names as the transition metric',
  );
});

// @req REL-BGSTAB-024 AC-2
test('REL-BGSTAB-024 a router built the way production builds it resolves to unified', () => {
  const router = createRouter();
  try {
    assert.equal(
      (router as unknown as { wsTransportMode: string }).wsTransportMode,
      'unified',
      'omitting realtime.wsTransportMode must leave the router on the unified path',
    );
  } finally {
    router.destroy();
  }
});

// @req REL-BGSTAB-024 AC-3
test('REL-BGSTAB-024 split survives as a standalone capability when the router is constructed with it', () => {
  // AC-3 is the half of the deferral that is easy to lose: 0B defers the
  // contract, it does not delete the code, and REL-BGSTAB-008 AC-10 and the
  // MIG-BGSTAB-002 suites still exercise this path.
  for (const mode of ['split', 'split-shadow'] as const) {
    const router = createRouter({ wsTransportMode: mode });
    try {
      assert.equal(
        (router as unknown as { wsTransportMode: string }).wsTransportMode,
        mode,
        `an explicitly constructed ${mode} router must keep that mode`,
      );
    } finally {
      router.destroy();
    }
  }
});

// @req REL-BGSTAB-024 AC-4
test('REL-BGSTAB-024 the browser and the server disagree on the transport query parameter name', () => {
  const frontend = readSource(WEB_SOCKET_URL_SOURCE_URL);
  const router = readSource(WS_ROUTER_SOURCE_URL);

  // buildControlWebSocketUrl writes `mode`; the upgrade path reads
  // `wsTransportMode`. A browser-built URL therefore cannot select split at all.
  // AC-4 records this as a limitation of the deferred contract rather than a
  // defect resolved by it, so the test pins the divergence in both directions:
  // if either side is renamed to match the other, split becomes browser
  // reachable and this contract no longer describes production.
  const controlUrlBuilder = frontend.slice(frontend.indexOf('export function buildControlWebSocketUrl'));
  assert.notEqual(controlUrlBuilder, '', 'buildControlWebSocketUrl must exist');
  assert.match(
    controlUrlBuilder,
    /params\.set\('mode',\s*'split'\)/u,
    'the browser must still emit the parameter named mode',
  );

  assert.match(
    router,
    /url\.searchParams\.get\('wsTransportMode'\)/u,
    'the upgrade path must still read the parameter named wsTransportMode',
  );
  assert.doesNotMatch(
    controlUrlBuilder,
    /params\.set\('wsTransportMode'/u,
    'if the browser starts emitting wsTransportMode, split becomes browser reachable and AC-4 is void',
  );
});

// @req REL-BGSTAB-024 AC-5
test('REL-BGSTAB-024 the canonical transport parser is absent from the production upgrade path', () => {
  const router = readSource(WS_ROUTER_SOURCE_URL);

  // parseWsTransportRequest is the function that would return the
  // `split-disabled` 400 when the configured mode is unified. It is only
  // reachable from its own unit test, so that rejection is not production
  // behaviour, and AC-5 says so explicitly rather than leaving a reader to
  // assume the guard is live.
  assert.doesNotMatch(
    router,
    /parseWsTransportRequest/u,
    'WsRouter must not reference parseWsTransportRequest; AC-5 records the parser as off the production path',
  );
});

// @req REL-BGSTAB-024 AC-6
test('REL-BGSTAB-024 the binary wire format is eligible only on the unified transport', () => {
  // This is the assertion that decides 0A against 0B. Restoring split in
  // production would switch the adopted binary data plane off, because
  // isTransportEligible admits `unified` and nothing else.
  assert.equal(isBinaryNegotiable('binary-optin', 'unified'), true);
  assert.equal(isBinaryNegotiable('binary-optin', 'split'), false);
  assert.equal(isBinaryNegotiable('binary-optin', 'split-shadow'), false);
  assert.equal(isBinaryNegotiable('binary', 'split'), false);

  for (const transportMode of ['split', 'split-shadow'] as const) {
    const decision = decideTerminalWireFormat({
      configured: 'binary',
      transportMode,
      clientNegotiatedBinary: true,
    });
    assert.equal(decision.encodeBinary, false);
    assert.equal(decision.sendBinary, false);
    assert.equal(
      decision.reason,
      'transport-not-eligible',
      `${transportMode} must be refused by the transport gate, not by some later branch`,
    );
  }

  // The control: the same input on the unified transport does reach binary, so
  // the four refusals above are the transport gate speaking and not a wire
  // format that simply never turns on.
  const unified = decideTerminalWireFormat({
    configured: 'binary',
    transportMode: 'unified',
    clientNegotiatedBinary: true,
  });
  assert.equal(unified.sendBinary, true);
  assert.equal(unified.reason, 'binary-negotiated');
});

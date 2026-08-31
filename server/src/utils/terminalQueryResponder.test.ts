import assert from 'node:assert/strict';
import { test } from 'node:test';
import headlessModule from '@xterm/headless';
import {
  createHeadlessTerminalState,
  type HeadlessTerminalState,
} from './headlessTerminal.js';

const { Terminal: HeadlessTerminal } = headlessModule;

type TerminalViewRgb = readonly [number, number, number];

interface TerminalViewAttributesFixture {
  readonly foreground: TerminalViewRgb;
  readonly background: TerminalViewRgb;
  readonly cursor: TerminalViewRgb;
  readonly ansi: readonly TerminalViewRgb[];
  readonly cursorStyle: 'block' | 'underline' | 'bar';
  readonly cursorBlink: boolean;
  readonly colorSchemeMode: 'dark' | 'light';
}

interface TerminalQueryWriteResult {
  readonly replies: readonly string[];
  readonly disposition:
    | 'answered'
    | 'not-query'
    | 'suppressed'
    | 'known-silent'
    | 'unsupported'
    | 'view-attributes-unavailable';
  readonly promotionEligible: boolean;
}

interface TerminalQueryResponder {
  readonly attachedHeadlessState: HeadlessTerminalState;
  write(
    data: string,
    options: { source: 'live' | 'seed' | 'replay' },
  ): TerminalQueryWriteResult | Promise<TerminalQueryWriteResult>;
  pushViewAttributes(input: {
    identity: DriverViewAttributesPushIdentity;
    attributes: TerminalViewAttributesFixture;
  }): { accepted: boolean; reason?: string };
  getCapabilityState(): {
    structuralCore: '@xterm/headless';
    promotionEligible: boolean;
    blocker?: string;
  };
  detach(): void;
}

interface DriverViewIdentity {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly viewGeneration: number;
  readonly driverLeaseId: string;
  readonly driverLeaseGeneration: string;
  readonly expectedViewAttributesGeneration: string;
  readonly serverAcceptedViewAttributesGeneration: string | null | undefined;
}

interface DriverViewAttributesPushIdentity {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly viewGeneration: number;
  readonly driverLeaseId: string;
  readonly driverLeaseGeneration: string;
  readonly viewAttributesGeneration: string;
}

interface TerminalQueryResponderModule {
  installTerminalQueryResponder(options: {
    headlessState: HeadlessTerminalState;
    provider: {
      source: 'session-manager-spawn-record';
      backend: 'conpty' | 'winpty' | 'wsl' | 'posix' | 'remote';
      spawnRecordId: string;
    };
    readDriverViewIdentity: () => DriverViewIdentity | null;
  }): TerminalQueryResponder;
}

const EXPECTED_FAILURE =
  'MIG-BGSTAB-002 AC-3 query responder byte parity contract missing';

async function loadContract(): Promise<TerminalQueryResponderModule> {
  const modulePath = './terminalQueryResponder.js';
  try {
    return await import(modulePath) as TerminalQueryResponderModule;
  } catch (cause) {
    const expectedUrl = new URL(modulePath, import.meta.url).href;
    const isExpectedMissingContract = typeof cause === 'object'
      && cause !== null
      && 'code' in cause
      && cause.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in cause
      && cause.url === expectedUrl;
    if (isExpectedMissingContract) {
      throw new Error(EXPECTED_FAILURE, { cause });
    }
    throw cause;
  }
}

function createViewAttributes(): TerminalViewAttributesFixture {
  const ansi = [
    [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
    [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
    [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
    [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
  ] as TerminalViewRgb[];
  const cube = [0, 95, 135, 175, 215, 255];
  for (const red of cube) {
    for (const green of cube) {
      for (const blue of cube) ansi.push([red, green, blue]);
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const level = 8 + index * 10;
    ansi.push([level, level, level]);
  }
  return {
    foreground: [0xd0, 0xd0, 0xd0],
    background: [0x1e, 0x1e, 0x2e],
    cursor: [0xff, 0x99, 0x00],
    ansi,
    cursorStyle: 'bar',
    cursorBlink: true,
    colorSchemeMode: 'dark',
  };
}

const DRIVER_IDENTITY: DriverViewIdentity = Object.freeze({
  sessionId: 'session-query-responder',
  clientId: 'client-driver',
  connectionId: 'connection-driver',
  viewGeneration: 3,
  driverLeaseId: 'driver-lease-7',
  driverLeaseGeneration: '7',
  expectedViewAttributesGeneration: '7',
  serverAcceptedViewAttributesGeneration: '7',
});

function toViewAttributesPushIdentity(
  identity: DriverViewIdentity,
): DriverViewAttributesPushIdentity {
  return {
    sessionId: identity.sessionId,
    clientId: identity.clientId,
    connectionId: identity.connectionId,
    viewGeneration: identity.viewGeneration,
    driverLeaseId: identity.driverLeaseId,
    driverLeaseGeneration: identity.driverLeaseGeneration,
    viewAttributesGeneration: identity.expectedViewAttributesGeneration,
  };
}

const DRIVER_PUSH_IDENTITY = Object.freeze(toViewAttributesPushIdentity(DRIVER_IDENTITY));

function createResponder(
  contract: TerminalQueryResponderModule,
  provider: Parameters<TerminalQueryResponderModule['installTerminalQueryResponder']>[0]['provider'] = {
    source: 'session-manager-spawn-record',
    backend: 'posix',
    spawnRecordId: 'spawn-posix-1',
  },
  readDriverViewIdentity: () => DriverViewIdentity | null = () => DRIVER_IDENTITY,
): TerminalQueryResponder {
  const headlessState = createHeadlessTerminalState({
    cols: 80,
    rows: 24,
    scrollbackLines: 5000,
  });
  const responder = contract.installTerminalQueryResponder({
    headlessState,
    provider,
    readDriverViewIdentity,
  });
  assert.equal(
    responder.attachedHeadlessState,
    headlessState,
    'query responder must attach to the existing authoritative HeadlessTerminalState',
  );
  assert.equal(
    responder.attachedHeadlessState.terminal,
    headlessState.terminal,
    'query responder must use the existing authoritative xterm parser instance',
  );
  assert.equal(
    'dispose' in responder,
    false,
    'query responder must not own the authoritative terminal lifecycle',
  );
  return responder;
}

function disposeResponder(responder: TerminalQueryResponder): void {
  const terminal = responder.attachedHeadlessState.terminal;
  responder.detach();
  assert.doesNotThrow(
    () => terminal.write('detached-terminal-remains-owned-by-session'),
    'detaching query handlers must not dispose the session-owned terminal',
  );
  terminal.dispose();
}

async function write(
  responder: TerminalQueryResponder,
  data: string,
  source: 'live' | 'seed' | 'replay' = 'live',
): Promise<TerminalQueryWriteResult> {
  return await responder.write(data, { source });
}

async function writeCoreOracle(chunks: readonly string[]): Promise<string[]> {
  const terminal = new HeadlessTerminal({
    cols: 80,
    rows: 24,
    allowProposedApi: true,
  });
  const replies: string[] = [];
  const disposable = terminal.onData(data => replies.push(data));
  try {
    for (const chunk of chunks) {
      await new Promise<void>(resolve => terminal.write(chunk, resolve));
    }
    return replies;
  } finally {
    disposable.dispose();
    terminal.dispose();
  }
}

test('terminal query responder matches Orca static and model-state replies with ConPTY override and seed silence', async () => {
  const contract = await loadContract();
  assert.equal(typeof contract.installTerminalQueryResponder, 'function', EXPECTED_FAILURE);

  const staticFixtures = [
    ['DA1', '\x1b[c', ['\x1b[?1;2c']],
    ['DA1 zero variant', '\x1b[0c', ['\x1b[?1;2c']],
    ['DA2', '\x1b[>c', ['\x1b[>0;276;0c']],
    ['DSR 5n', '\x1b[5n', ['\x1b[0n']],
    ['CPR 6n', '\x1b[6n', ['\x1b[1;1R']],
    ['DECXCPR ?6n', '\x1b[?6n', ['\x1b[?1;1R']],
    ['DECRQM private default', '\x1b[?2004$p', ['\x1b[?2004;2$y']],
    ['DECRQM ANSI default', '\x1b[4$p', ['\x1b[4;2$y']],
    ['DECRQSS margins', '\x1bP$qr\x1b\\', ['\x1bP1$r1;24r\x1b\\']],
    ['DECRQSS cursor', '\x1bP$q q\x1b\\', ['\x1bP1$r2 q\x1b\\']],
    ['DECRQSS SGR', '\x1bP$qm\x1b\\', ['\x1bP1$r0m\x1b\\']],
  ] as const;

  for (const [label, query, expectedReplies] of staticFixtures) {
    const responder = createResponder(contract);
    try {
      const result = await write(responder, query);
      assert.deepEqual(result.replies, expectedReplies, label);
      assert.deepEqual(result.replies, await writeCoreOracle([query]), `${label} structural xterm-core parity`);
      assert.equal(result.disposition, 'answered', label);
      assert.equal(result.promotionEligible, true, label);
    } finally {
      disposeResponder(responder);
    }
  }

  const model = createResponder(contract);
  try {
    await write(model, 'hello\r\nworld');
    assert.equal(
      model.attachedHeadlessState.terminal.buffer.active.cursorX,
      5,
      'model-state queries must read the same terminal instance that committed ordinary output',
    );
    assert.deepEqual((await write(model, '\x1b[6n')).replies, ['\x1b[2;6R']);
    assert.deepEqual((await write(model, '\x1b[6n')).replies, await writeCoreOracle(['hello\r\nworld', '\x1b[6n']));
    await write(model, '\x1b[?2004h\x1b[5;20r');
    assert.deepEqual((await write(model, '\x1b[?2004$p')).replies, ['\x1b[?2004;1$y']);
    assert.deepEqual((await write(model, '\x1bP$qr\x1b\\')).replies, ['\x1bP1$r5;20r\x1b\\']);
  } finally {
    disposeResponder(model);
  }

  const split = createResponder(contract);
  try {
    assert.deepEqual((await write(split, '\x1b[')).replies, []);
    const splitCsi = await write(split, '6n');
    assert.deepEqual(splitCsi.replies, await writeCoreOracle(['\x1b[', '6n']));
    assert.deepEqual(splitCsi.replies, ['\x1b[1;1R']);

    assert.deepEqual((await write(split, '\x1bP$q')).replies, []);
    const splitDcs = await write(split, 'm\x1b\\');
    assert.deepEqual(splitDcs.replies, await writeCoreOracle(['\x1bP$q', 'm\x1b\\']));
    assert.deepEqual(splitDcs.replies, ['\x1bP1$r0m\x1b\\']);
  } finally {
    disposeResponder(split);
  }

  const conpty = createResponder(contract, {
    source: 'session-manager-spawn-record',
    backend: 'conpty',
    spawnRecordId: 'spawn-conpty-1',
  });
  try {
    assert.deepEqual((await write(conpty, '\x1b[c')).replies, ['\x1b[?61;4c']);
    assert.deepEqual((await write(conpty, '\x1b[>c')).replies, ['\x1b[>0;276;0c']);
  } finally {
    disposeResponder(conpty);
  }

  for (const backend of ['winpty', 'wsl', 'posix', 'remote'] as const) {
    const nonConpty = createResponder(contract, {
      source: 'session-manager-spawn-record',
      backend,
      spawnRecordId: `spawn-${backend}-1`,
    });
    try {
      assert.deepEqual((await write(nonConpty, '\x1b[c')).replies, ['\x1b[?1;2c'], backend);
    } finally {
      disposeResponder(nonConpty);
    }
  }

  const unavailableOwner = createResponder(contract, undefined, () => null);
  try {
    assert.equal(unavailableOwner.pushViewAttributes({
      identity: DRIVER_PUSH_IDENTITY,
      attributes: createViewAttributes(),
    }).accepted, false, 'a view-attribute push cannot self-claim ownership when no driver is available');
    const unavailableOwnerQuery = await write(
      unavailableOwner,
      '\x1b]11;?\x07\x1b[?996n',
    );
    assert.deepEqual(unavailableOwnerQuery.replies, []);
    assert.equal(unavailableOwnerQuery.disposition, 'view-attributes-unavailable');
    assert.equal(unavailableOwnerQuery.promotionEligible, false);
    assert.deepEqual(unavailableOwner.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
    });
  } finally {
    disposeResponder(unavailableOwner);
  }

  for (const generationState of [
    { expectedViewAttributesGeneration: '7', serverAcceptedViewAttributesGeneration: null },
    { expectedViewAttributesGeneration: '7', serverAcceptedViewAttributesGeneration: undefined },
    { expectedViewAttributesGeneration: '7', serverAcceptedViewAttributesGeneration: '07' },
    {
      expectedViewAttributesGeneration: null as unknown as string,
      serverAcceptedViewAttributesGeneration: '7',
    },
    {
      expectedViewAttributesGeneration: undefined as unknown as string,
      serverAcceptedViewAttributesGeneration: '7',
    },
    { expectedViewAttributesGeneration: '07', serverAcceptedViewAttributesGeneration: '07' },
  ] as const) {
    const unavailableGeneration = createResponder(contract, undefined, () => ({
      ...DRIVER_IDENTITY,
      ...generationState,
    }));
    try {
      const unavailableGenerationQuery = await write(
        unavailableGeneration,
        '\x1b]11;?\x07\x1b[?996n',
      );
      assert.deepEqual(unavailableGenerationQuery.replies, []);
      assert.equal(unavailableGenerationQuery.disposition, 'view-attributes-unavailable');
      assert.deepEqual(unavailableGeneration.getCapabilityState(), {
        structuralCore: '@xterm/headless',
        promotionEligible: false,
        blocker: 'driver-view-attributes-unavailable',
      }, 'null, undefined, and malformed expected or server-accepted generations must silence view queries and block promotion');
    } finally {
      disposeResponder(unavailableGeneration);
    }
  }

  let currentDriverIdentity: DriverViewIdentity = {
    ...DRIVER_IDENTITY,
    serverAcceptedViewAttributesGeneration: null,
  };
  const view = createResponder(contract, undefined, () => currentDriverIdentity);
  try {
    const beforePush = await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    );
    assert.deepEqual(beforePush.replies, []);
    assert.equal(beforePush.disposition, 'view-attributes-unavailable');
    assert.equal(beforePush.promotionEligible, false);

    for (const identity of [
      { ...DRIVER_PUSH_IDENTITY, sessionId: 'peer-session' },
      { ...DRIVER_PUSH_IDENTITY, clientId: 'peer-client' },
      { ...DRIVER_PUSH_IDENTITY, connectionId: 'peer-connection' },
      { ...DRIVER_PUSH_IDENTITY, viewGeneration: DRIVER_IDENTITY.viewGeneration + 1 },
      { ...DRIVER_PUSH_IDENTITY, driverLeaseId: 'stale-driver-lease' },
      { ...DRIVER_PUSH_IDENTITY, driverLeaseGeneration: '6' },
      { ...DRIVER_PUSH_IDENTITY, viewAttributesGeneration: '6' },
      { ...DRIVER_PUSH_IDENTITY, viewAttributesGeneration: '07' },
      {
        ...DRIVER_PUSH_IDENTITY,
        viewAttributesGeneration: null as unknown as string,
      },
      {
        ...DRIVER_PUSH_IDENTITY,
        viewAttributesGeneration: undefined as unknown as string,
      },
      {
        ...DRIVER_PUSH_IDENTITY,
        viewAttributesGeneration: 7 as unknown as string,
      },
    ]) {
      assert.equal(view.pushViewAttributes({ identity, attributes: createViewAttributes() }).accepted, false);
      assert.equal(
        currentDriverIdentity.serverAcceptedViewAttributesGeneration,
        null,
        'rejected pushes cannot advance server acceptance',
      );
      assert.equal((await write(view, '\x1b]11;?\x07')).disposition, 'view-attributes-unavailable');
    }
    currentDriverIdentity = {
      ...DRIVER_IDENTITY,
      serverAcceptedViewAttributesGeneration: '07',
    };
    assert.equal(view.pushViewAttributes({
      identity: DRIVER_PUSH_IDENTITY,
      attributes: createViewAttributes(),
    }).accepted, false, 'a malformed server-accepted generation cannot be repaired by an unvalidated push');
    assert.equal(currentDriverIdentity.serverAcceptedViewAttributesGeneration, '07');
    currentDriverIdentity = {
      ...DRIVER_IDENTITY,
      serverAcceptedViewAttributesGeneration: null,
    };
    for (const ansiLength of [15, 16, 255]) {
      const incomplete = createViewAttributes();
      assert.deepEqual(view.pushViewAttributes({
        identity: DRIVER_PUSH_IDENTITY,
        attributes: { ...incomplete, ansi: incomplete.ansi.slice(0, ansiLength) },
      }), { accepted: false, reason: 'view-attributes-shape-invalid' });
      assert.equal(
        currentDriverIdentity.serverAcceptedViewAttributesGeneration,
        null,
        'an incomplete palette cannot advance the server-accepted generation',
      );
    }
    const malformed = createViewAttributes();
    const malformedAnsi = [...malformed.ansi];
    malformedAnsi[196] = [256, 0, 0];
    assert.deepEqual(view.pushViewAttributes({
      identity: DRIVER_PUSH_IDENTITY,
      attributes: { ...malformed, ansi: malformedAnsi },
    }), { accepted: false, reason: 'view-attributes-shape-invalid' });
    const initialValidatedPush = view.pushViewAttributes({
      identity: DRIVER_PUSH_IDENTITY,
      attributes: createViewAttributes(),
    });
    assert.deepEqual(
      initialValidatedPush,
      { accepted: true },
      'the exact expected generation may be validated while server acceptance is still null',
    );
    if (initialValidatedPush.accepted) {
      currentDriverIdentity = {
        ...currentDriverIdentity,
        serverAcceptedViewAttributesGeneration:
          currentDriverIdentity.expectedViewAttributesGeneration,
      };
    }
    assert.equal(
      currentDriverIdentity.serverAcceptedViewAttributesGeneration,
      '7',
      'only a validated exact-identity push may advance server acceptance',
    );
    assert.deepEqual((await write(view, '\x1b]11;')).replies, []);
    assert.deepEqual((await write(view, '?\x07')).replies, ['\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\']);
    const afterPush = await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    );
    assert.deepEqual(afterPush.replies, [
      '\x1b]4;1;rgb:cdcd/3131/3131\x1b\\',
      '\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\',
      '\x1b]12;rgb:ffff/9999/0000\x1b\\',
      '\x1b[?997;1n',
    ]);
    assert.equal(afterPush.disposition, 'answered');
    assert.equal(afterPush.promotionEligible, true);
    currentDriverIdentity = {
      ...currentDriverIdentity,
      clientId: 'client-driver-replacement',
    };
    assert.deepEqual(view.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
    }, 'a same-connection owner replacement must invalidate cached attributes');
    assert.equal(
      (await write(view, '\x1b]11;?\x07')).disposition,
      'view-attributes-unavailable',
      'a same-connection owner replacement cannot reuse the previous owner attributes',
    );
    currentDriverIdentity = {
      ...currentDriverIdentity,
      clientId: DRIVER_IDENTITY.clientId,
    };
    assert.deepEqual((await write(
      view,
      '\x1b]4;0;?\x07\x1b]4;15;?\x07\x1b]4;16;?\x07\x1b]4;196;?\x07\x1b]4;232;?\x07\x1b]4;255;?\x07',
    )).replies, [
      '\x1b]4;0;rgb:0000/0000/0000\x1b\\',
      '\x1b]4;15;rgb:ffff/ffff/ffff\x1b\\',
      '\x1b]4;16;rgb:0000/0000/0000\x1b\\',
      '\x1b]4;196;rgb:ffff/0000/0000\x1b\\',
      '\x1b]4;232;rgb:0808/0808/0808\x1b\\',
      '\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\',
    ]);
    assert.deepEqual((await write(
      view,
      '\x1b]4;196;rgb:1212/3434/5656\x1b\\\x1b]4;196;?\x07',
    )).replies, ['\x1b]4;196;rgb:1212/3434/5656\x1b\\']);
    assert.deepEqual((await write(
      view,
      '\x1b]104;196\x1b\\\x1b]4;196;?\x07',
    )).replies, ['\x1b]4;196;rgb:ffff/0000/0000\x1b\\']);

    const oldDriverPushIdentity = toViewAttributesPushIdentity(currentDriverIdentity);
    currentDriverIdentity = {
      ...DRIVER_IDENTITY,
      connectionId: 'connection-next-driver',
      viewGeneration: DRIVER_IDENTITY.viewGeneration + 1,
      driverLeaseId: 'driver-lease-8',
      driverLeaseGeneration: '8',
      expectedViewAttributesGeneration: '8',
      serverAcceptedViewAttributesGeneration: null,
    };
    assert.deepEqual(view.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
    }, 'driver identity mutation must invalidate eligibility before any later output or push');
    const afterDriverHandoffBeforePush = await write(view, '\x1b]11;?\x07');
    assert.deepEqual(afterDriverHandoffBeforePush.replies, []);
    assert.equal(afterDriverHandoffBeforePush.disposition, 'view-attributes-unavailable');
    assert.equal(afterDriverHandoffBeforePush.promotionEligible, false);
    assert.deepEqual(view.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
    });
    assert.equal(view.pushViewAttributes({
      identity: oldDriverPushIdentity,
      attributes: createViewAttributes(),
    }).accepted, false, 'old driver cannot refresh global attributes after lease handoff');
    const nextAttributes = createViewAttributes();
    const nextBackground: TerminalViewRgb = [0x12, 0x34, 0x56];
    const nextViewAttributes: TerminalViewAttributesFixture = {
      ...nextAttributes,
      background: nextBackground,
    };
    const nextDriverPushIdentity = toViewAttributesPushIdentity(currentDriverIdentity);
    const nextDriverPush = view.pushViewAttributes({
      identity: nextDriverPushIdentity,
      attributes: nextViewAttributes,
    });
    assert.deepEqual(nextDriverPush, { accepted: true });
    if (nextDriverPush.accepted) {
      currentDriverIdentity = {
        ...currentDriverIdentity,
        serverAcceptedViewAttributesGeneration:
          currentDriverIdentity.expectedViewAttributesGeneration,
      };
    }
    assert.deepEqual((await write(view, '\x1b]11;?\x07')).replies, [
      '\x1b]11;rgb:1212/3434/5656\x1b\\',
    ]);
    assert.deepEqual(view.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: true,
    });

    const setSequences = [
      '\x1b]4;1;rgb:1111/2222/3333\x1b\\',
      '\x1b]10;rgb:1010/2020/3030\x1b\\',
      '\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\',
      '\x1b]12;rgb:4040/5050/6060\x1b\\',
    ];
    for (const sequence of setSequences) {
      assert.deepEqual((await write(view, sequence)).replies, [], 'OSC SET must mutate model state without replying');
    }
    assert.deepEqual((await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    )).replies, [
      '\x1b]4;1;rgb:1111/2222/3333\x1b\\',
      '\x1b]10;rgb:1010/2020/3030\x1b\\',
      '\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\',
      '\x1b]12;rgb:4040/5050/6060\x1b\\',
      '\x1b[?997;2n',
    ], 'view-attribute replies must reflect per-session OSC mutations and mutated luminance');

    assert.deepEqual(view.pushViewAttributes({
      identity: nextDriverPushIdentity,
      attributes: {
        ...nextViewAttributes,
        foreground: [...nextViewAttributes.foreground] as TerminalViewRgb,
        background: [...nextViewAttributes.background] as TerminalViewRgb,
        cursor: [...nextViewAttributes.cursor] as TerminalViewRgb,
        ansi: nextViewAttributes.ansi.map(rgb => [...rgb] as TerminalViewRgb),
      },
    }), { accepted: true }, 'a same-generation structurally identical push must be idempotent');
    assert.deepEqual((await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    )).replies, [
      '\x1b]4;1;rgb:1111/2222/3333\x1b\\',
      '\x1b]10;rgb:1010/2020/3030\x1b\\',
      '\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\',
      '\x1b]12;rgb:4040/5050/6060\x1b\\',
      '\x1b[?997;2n',
    ], 'an identical same-generation push must not clear OSC overrides');
    assert.equal(view.pushViewAttributes({
      identity: nextDriverPushIdentity,
      attributes: {
        ...nextViewAttributes,
        colorSchemeMode: 'light',
      },
    }).accepted, false, 'a changed same-generation push must be rejected, including colorSchemeMode-only changes');
    assert.deepEqual((await write(view, '\x1b]11;?\x07')).replies, [
      '\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\',
    ], 'a rejected changed same-generation push cannot clear OSC state');

    const previousViewAttributesIdentity = nextDriverPushIdentity;
    currentDriverIdentity = {
      ...currentDriverIdentity,
      expectedViewAttributesGeneration: '9',
      serverAcceptedViewAttributesGeneration: null,
    };
    assert.deepEqual(view.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'driver-view-attributes-unavailable',
    }, 'a newer expected view-attributes generation must fence the prior pushed attributes immediately');
    const afterAttributesGenerationBeforePush = await write(
      view,
      '\x1b]11;?\x07\x1b[?996n',
    );
    assert.deepEqual(afterAttributesGenerationBeforePush.replies, []);
    assert.equal(afterAttributesGenerationBeforePush.disposition, 'view-attributes-unavailable');
    assert.equal(afterAttributesGenerationBeforePush.promotionEligible, false);
    assert.equal(view.pushViewAttributes({
      identity: previousViewAttributesIdentity,
      attributes: createViewAttributes(),
    }).accepted, false, 'an out-of-order view-attributes push cannot cross the generation fence');
    assert.equal(view.pushViewAttributes({
      identity: {
        ...toViewAttributesPushIdentity(currentDriverIdentity),
        viewAttributesGeneration: '7',
      },
      attributes: createViewAttributes(),
    }).accepted, false, 'a stale same-driver view-attributes generation must be rejected');
    const identicalNewerPush = view.pushViewAttributes({
      identity: toViewAttributesPushIdentity(currentDriverIdentity),
      attributes: {
        ...nextViewAttributes,
        foreground: [...nextViewAttributes.foreground] as TerminalViewRgb,
        background: [...nextViewAttributes.background] as TerminalViewRgb,
        cursor: [...nextViewAttributes.cursor] as TerminalViewRgb,
        ansi: nextViewAttributes.ansi.map(rgb => [...rgb] as TerminalViewRgb),
      },
    });
    assert.deepEqual(identicalNewerPush, { accepted: true }, 'a structurally identical newer push must be accepted without resetting OSC state');
    if (identicalNewerPush.accepted) {
      currentDriverIdentity = {
        ...currentDriverIdentity,
        serverAcceptedViewAttributesGeneration:
          currentDriverIdentity.expectedViewAttributesGeneration,
      };
    }
    assert.deepEqual((await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    )).replies, [
      '\x1b]4;1;rgb:1111/2222/3333\x1b\\',
      '\x1b]10;rgb:1010/2020/3030\x1b\\',
      '\x1b]11;rgb:f0f0/f0f0/f0f0\x1b\\',
      '\x1b]12;rgb:4040/5050/6060\x1b\\',
      '\x1b[?997;2n',
    ], 'an identical newer push must preserve existing OSC overrides');

    const identicalViewAttributesIdentity = toViewAttributesPushIdentity(currentDriverIdentity);
    currentDriverIdentity = {
      ...currentDriverIdentity,
      expectedViewAttributesGeneration: '10',
      serverAcceptedViewAttributesGeneration: null,
    };
    const changedAttributesGenerationBeforePush = await write(
      view,
      '\x1b]11;?\x07\x1b[?996n',
    );
    assert.deepEqual(changedAttributesGenerationBeforePush.replies, []);
    assert.equal(changedAttributesGenerationBeforePush.disposition, 'view-attributes-unavailable');
    assert.equal(view.pushViewAttributes({
      identity: identicalViewAttributesIdentity,
      attributes: nextViewAttributes,
    }).accepted, false, 'the prior identical generation cannot cross a newer generation fence');
    const refreshedAttributes = createViewAttributes();
    const refreshedAnsi = [...refreshedAttributes.ansi];
    refreshedAnsi[1] = [0x22, 0x44, 0x66];
    const changedNewerPush = view.pushViewAttributes({
      identity: toViewAttributesPushIdentity(currentDriverIdentity),
      attributes: {
        ...refreshedAttributes,
        ansi: refreshedAnsi,
        foreground: [0xaa, 0xbb, 0xcc],
        background: [0x14, 0x25, 0x36],
        cursor: [0x77, 0x88, 0x99],
      },
    });
    assert.deepEqual(changedNewerPush, { accepted: true });
    if (changedNewerPush.accepted) {
      currentDriverIdentity = {
        ...currentDriverIdentity,
        serverAcceptedViewAttributesGeneration:
          currentDriverIdentity.expectedViewAttributesGeneration,
      };
    }
    assert.deepEqual((await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    )).replies, [
      '\x1b]4;1;rgb:2222/4444/6666\x1b\\',
      '\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\',
      '\x1b]11;rgb:1414/2525/3636\x1b\\',
      '\x1b]12;rgb:7777/8888/9999\x1b\\',
      '\x1b[?997;1n',
    ], 'only a changed newer same-driver push may clear prior OSC overrides and expose new base colors');

    for (const sequence of [
      '\x1b]104;1\x1b\\',
      '\x1b]110\x1b\\',
      '\x1b]111\x1b\\',
      '\x1b]112\x1b\\',
    ]) {
      assert.deepEqual((await write(view, sequence)).replies, [], 'OSC reset must restore base attributes without replying');
    }
    assert.deepEqual((await write(
      view,
      '\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x1b\\\x1b[?996n',
    )).replies, [
      '\x1b]4;1;rgb:2222/4444/6666\x1b\\',
      '\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\',
      '\x1b]11;rgb:1414/2525/3636\x1b\\',
      '\x1b]12;rgb:7777/8888/9999\x1b\\',
      '\x1b[?997;1n',
    ], 'OSC resets must fall back to the current driver push');
  } finally {
    disposeResponder(view);
  }

  for (const source of ['seed', 'replay'] as const) {
    const responder = createResponder(contract);
    try {
      responder.pushViewAttributes({ identity: DRIVER_PUSH_IDENTITY, attributes: createViewAttributes() });
      const result = await write(
        responder,
        '\x1b[c\x1b[5n\x1b[?2004$p\x1bP$qm\x1b\\\x1b]11;?\x07\x1b[?996n',
        source,
      );
      assert.deepEqual(result.replies, [], `${source} must not emit a PTY side effect`);
      assert.equal(result.disposition, 'suppressed', source);
      assert.deepEqual((await write(responder, '\x1b[', source)).replies, []);
      assert.deepEqual((await write(responder, '6n', source)).replies, [], `${source} split completion must stay silent`);
      assert.deepEqual((await write(responder, '\x1b[?2004h', source)).replies, []);
      assert.deepEqual((await write(responder, '\x1b[?2004$p', 'live')).replies, ['\x1b[?2004;1$y'], `${source} bytes must update model state despite reply silence`);
    } finally {
      disposeResponder(responder);
    }

    for (const [label, prefix, completion, expectedReply] of [
      ['CSI', '\x1b[', '6n', '\x1b[1;1R'],
      ['DCS', '\x1bP$q', 'm\x1b\\', '\x1bP1$r0m\x1b\\'],
      ['OSC', '\x1b]11;', '?\x07', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'],
    ] as const) {
      const replayPrefix = createResponder(contract);
      try {
        replayPrefix.pushViewAttributes({ identity: DRIVER_PUSH_IDENTITY, attributes: createViewAttributes() });
        assert.deepEqual((await write(replayPrefix, prefix, source)).replies, [], `${source} ${label} prefix`);
        assert.deepEqual(
          (await write(replayPrefix, completion, 'live')).replies,
          [expectedReply],
          `${source} ${label} prefix followed by live completion must reply exactly once from the completion write`,
        );
      } finally {
        disposeResponder(replayPrefix);
      }

      const replayCompletion = createResponder(contract);
      try {
        replayCompletion.pushViewAttributes({ identity: DRIVER_PUSH_IDENTITY, attributes: createViewAttributes() });
        assert.deepEqual((await write(replayCompletion, prefix, 'live')).replies, [], `live ${label} prefix`);
        assert.deepEqual(
          (await write(replayCompletion, completion, source)).replies,
          [],
          `live ${label} prefix followed by ${source} completion must stay silent`,
        );
        assert.deepEqual(
          (await write(replayCompletion, 'ordinary-live-output', 'live')).replies,
          [],
          `${source} ${label} completion reply must not leak into a later live write`,
        );
      } finally {
        disposeResponder(replayCompletion);
      }
    }
  }

  const unsupported = createResponder(contract);
  try {
    for (const query of [
      '\x1b[14t',
      '\x1bP+q544e\x1b\\',
      '\x1b[?15n',
      '\x1b[?25n',
      '\x1b[?26n',
      '\x1b[?53n',
    ]) {
      const result = await write(unsupported, query);
      assert.deepEqual(result.replies, [], query);
      assert.deepEqual(result.replies, await writeCoreOracle([query]), `${query} structural known-silent parity`);
      assert.equal(result.disposition, 'known-silent', query);
      assert.equal(result.promotionEligible, true, query);
    }
    assert.deepEqual(unsupported.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: true,
    });

    const unknown = await write(unsupported, '\x1b[?9999n');
    assert.equal(unknown.disposition, 'unsupported');
    assert.equal(unknown.promotionEligible, false);
    await write(unsupported, '\x1b[c');
    assert.deepEqual(unsupported.getCapabilityState(), {
      structuralCore: '@xterm/headless',
      promotionEligible: false,
      blocker: 'unknown-query-class',
    }, 'an unknown structural mismatch is a sticky promotion blocker');
  } finally {
    disposeResponder(unsupported);
  }
});

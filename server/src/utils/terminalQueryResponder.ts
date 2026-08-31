import { isCanonicalOrdinal64 } from '../types/ws-protocol.js';
import type { HeadlessTerminalState } from './headlessTerminal.js';

interface Disposable {
  dispose(): void;
}

export type TerminalViewRgb = readonly [number, number, number];

export interface TerminalViewAttributes {
  readonly foreground: TerminalViewRgb;
  readonly background: TerminalViewRgb;
  readonly cursor: TerminalViewRgb;
  readonly ansi: readonly TerminalViewRgb[];
  readonly cursorStyle: 'block' | 'underline' | 'bar';
  readonly cursorBlink: boolean;
  readonly colorSchemeMode: 'dark' | 'light';
}

export interface DriverViewIdentity {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly viewGeneration: number;
  readonly driverLeaseId: string;
  readonly driverLeaseGeneration: string;
  readonly expectedViewAttributesGeneration: string;
  readonly serverAcceptedViewAttributesGeneration: string | null | undefined;
}

export interface DriverViewAttributesPushIdentity {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly viewGeneration: number;
  readonly driverLeaseId: string;
  readonly driverLeaseGeneration: string;
  readonly viewAttributesGeneration: string;
}

export interface TerminalQueryWriteResult {
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

export interface TerminalQueryResponder {
  readonly attachedHeadlessState: HeadlessTerminalState;
  write(
    data: string,
    options: { source: 'live' | 'seed' | 'replay' },
  ): Promise<TerminalQueryWriteResult>;
  captureCommittedWrite(
    data: string,
    options: { source: 'live' | 'seed' | 'replay' },
    commit: () => Promise<void>,
  ): Promise<TerminalQueryWriteResult>;
  pushViewAttributes(input: {
    identity: DriverViewAttributesPushIdentity;
    attributes: TerminalViewAttributes;
  }): { accepted: boolean; reason?: string };
  getCapabilityState(): {
    structuralCore: '@xterm/headless';
    promotionEligible: boolean;
    blocker?: string;
  };
  hasAcceptedViewAttributes(): boolean;
  detach(): void;
}

export interface InstallTerminalQueryResponderOptions {
  headlessState: HeadlessTerminalState;
  provider: {
    source: 'session-manager-spawn-record';
    backend: 'conpty' | 'winpty' | 'wsl' | 'posix' | 'remote';
    spawnRecordId: string;
  };
  readDriverViewIdentity: () => DriverViewIdentity | null;
}

interface WriteCapture {
  replies: string[];
  viewQueryObserved: boolean;
  knownSilentObserved: boolean;
  unknownQueryObserved: boolean;
}

interface CachedViewAttributes {
  readonly identity: DriverViewAttributesPushIdentity;
  readonly attributes: TerminalViewAttributes;
  readonly serializedAttributes: string;
}

type SpecialColorSlot = 'foreground' | 'background' | 'cursor';

const MAX_ANSI_COLORS = 256;
const SPECIAL_COLOR_SLOTS: readonly SpecialColorSlot[] = [
  'foreground',
  'background',
  'cursor',
];
const SPECIAL_COLOR_IDENT: Readonly<Record<SpecialColorSlot, string>> = {
  foreground: '10',
  background: '11',
  cursor: '12',
};
const KNOWN_SILENT_PRIVATE_DSR = new Set([15, 25, 26, 53]);
const STRUCTURAL_PRIVATE_DSR = new Set([6]);

function isValidViewAttributes(attributes: TerminalViewAttributes): boolean {
  const isRgb = (value: unknown): value is TerminalViewRgb => (
    Array.isArray(value)
    && value.length === 3
    && value.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)
  );
  return isRgb(attributes.foreground)
    && isRgb(attributes.background)
    && isRgb(attributes.cursor)
    && Array.isArray(attributes.ansi)
    && attributes.ansi.length === MAX_ANSI_COLORS
    && attributes.ansi.every(isRgb)
    && ['block', 'underline', 'bar'].includes(attributes.cursorStyle)
    && typeof attributes.cursorBlink === 'boolean'
    && ['dark', 'light'].includes(attributes.colorSchemeMode);
}

function samePushIdentity(
  left: DriverViewAttributesPushIdentity,
  right: DriverViewAttributesPushIdentity,
): boolean {
  return left.sessionId === right.sessionId
    && left.clientId === right.clientId
    && left.connectionId === right.connectionId
    && left.viewGeneration === right.viewGeneration
    && left.driverLeaseId === right.driverLeaseId
    && left.driverLeaseGeneration === right.driverLeaseGeneration
    && left.viewAttributesGeneration === right.viewAttributesGeneration;
}

function sameDriverIdentity(
  cached: DriverViewAttributesPushIdentity,
  current: DriverViewIdentity,
): boolean {
  return cached.sessionId === current.sessionId
    && cached.clientId === current.clientId
    && cached.connectionId === current.connectionId
    && cached.viewGeneration === current.viewGeneration
    && cached.driverLeaseId === current.driverLeaseId
    && cached.driverLeaseGeneration === current.driverLeaseGeneration
    && cached.viewAttributesGeneration === current.expectedViewAttributesGeneration;
}

function isValidDriverIdentity(identity: DriverViewIdentity | null): identity is DriverViewIdentity {
  return identity !== null
    && identity.sessionId.length > 0
    && identity.clientId.length > 0
    && identity.connectionId.length > 0
    && Number.isSafeInteger(identity.viewGeneration)
    && identity.viewGeneration >= 0
    && identity.driverLeaseId.length > 0
    && isCanonicalOrdinal64(identity.driverLeaseGeneration)
    && isCanonicalOrdinal64(identity.expectedViewAttributesGeneration)
    && (identity.serverAcceptedViewAttributesGeneration === null
      || (isCanonicalOrdinal64(identity.serverAcceptedViewAttributesGeneration)
        && identity.serverAcceptedViewAttributesGeneration
          === identity.expectedViewAttributesGeneration));
}

function pushMatchesDriver(
  push: DriverViewAttributesPushIdentity,
  driver: DriverViewIdentity,
): boolean {
  return push.sessionId === driver.sessionId
    && push.clientId === driver.clientId
    && push.connectionId === driver.connectionId
    && push.viewGeneration === driver.viewGeneration
    && push.driverLeaseId === driver.driverLeaseId
    && push.driverLeaseGeneration === driver.driverLeaseGeneration
    && push.viewAttributesGeneration === driver.expectedViewAttributesGeneration
    && isCanonicalOrdinal64(push.driverLeaseGeneration)
    && isCanonicalOrdinal64(push.viewAttributesGeneration);
}

function formatRgb(rgb: TerminalViewRgb): string {
  return `rgb:${rgb.map(channel => {
    const byte = Math.max(0, Math.min(255, Math.trunc(channel)));
    const doubled = (byte << 8) | byte;
    return doubled.toString(16).padStart(4, '0');
  }).join('/')}`;
}

function parseColorComponent(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/iu.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  if (value.length <= 2) {
    const max = (1 << (value.length * 4)) - 1;
    return Math.round((parsed / max) * 255);
  }
  const max = (1 << (value.length * 4)) - 1;
  return Math.round((parsed / max) * 255);
}

function parseColor(value: string): TerminalViewRgb | null {
  if (/^#[0-9a-f]{6}$/iu.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ];
  }
  const rgbMatch = /^rgb:([^/]+)\/([^/]+)\/([^/]+)$/iu.exec(value);
  if (!rgbMatch) return null;
  const components = rgbMatch.slice(1).map(parseColorComponent);
  if (components.some(component => component === null)) return null;
  return [components[0]!, components[1]!, components[2]!] as TerminalViewRgb;
}

function relativeLuminance(rgb: TerminalViewRgb): number {
  const linear = (channel: number): number => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return linear(rgb[0]) * 0.2126
    + linear(rgb[1]) * 0.7152
    + linear(rgb[2]) * 0.0722;
}

/**
 * Installs query-side-effect capture on the session-owned xterm parser.
 * The responder never creates or disposes a second terminal model.
 *
 * @req MIG-BGSTAB-002 AC-4 AC-3
 */
export function installTerminalQueryResponder(
  options: InstallTerminalQueryResponderOptions,
): TerminalQueryResponder {
  const { headlessState, provider, readDriverViewIdentity } = options;
  const terminal = headlessState.terminal;
  const disposables: Disposable[] = [];
  const ansiOverrides = new Map<number, TerminalViewRgb>();
  const specialOverrides = new Map<SpecialColorSlot, TerminalViewRgb>();
  let activeCapture: WriteCapture | null = null;
  let cachedViewAttributes: CachedViewAttributes | null = null;
  let detached = false;
  let writeChain = Promise.resolve<TerminalQueryWriteResult>({
    replies: [],
    disposition: 'not-query',
    promotionEligible: true,
  });
  let viewCapabilityObserved = false;
  let unknownQueryBlocker = false;

  const emitReply = (reply: string): void => {
    activeCapture?.replies.push(reply);
  };

  const readUsableAttributes = (): TerminalViewAttributes | null => {
    const current = readDriverViewIdentity();
    if (!cachedViewAttributes || !isValidDriverIdentity(current)) return null;
    if (current.serverAcceptedViewAttributesGeneration === null) return null;
    return sameDriverIdentity(cachedViewAttributes.identity, current)
      ? cachedViewAttributes.attributes
      : null;
  };

  const reportColor = (ident: string, rgb: TerminalViewRgb): void => {
    emitReply(`\x1b]${ident};${formatRgb(rgb)}\x1b\\`);
  };

  const handleSpecialColor = (data: string, initialOffset: number): boolean => {
    if (activeCapture) activeCapture.viewQueryObserved ||= data.split(';').includes('?');
    let offset = initialOffset;
    for (const item of data.split(';')) {
      const slot = SPECIAL_COLOR_SLOTS[offset];
      if (!slot) break;
      if (item === '?') {
        const attributes = readUsableAttributes();
        if (attributes) reportColor(SPECIAL_COLOR_IDENT[slot], specialOverrides.get(slot) ?? attributes[slot]);
      } else {
        const parsed = parseColor(item);
        if (parsed) specialOverrides.set(slot, parsed);
      }
      offset += 1;
    }
    return true;
  };

  disposables.push(terminal.onData(reply => emitReply(reply)));
  if (provider.backend === 'conpty') {
    disposables.push(terminal.parser.registerCsiHandler({ final: 'c' }, params => {
      const isPrimaryQuery = params.length === 0 || (params.length === 1 && params[0] === 0);
      if (!isPrimaryQuery) return false;
      emitReply('\x1b[?61;4c');
      return true;
    }));
  }

  disposables.push(terminal.parser.registerOscHandler(4, data => {
    const items = data.split(';');
    while (items.length > 1) {
      const rawIndex = items.shift()!;
      const value = items.shift()!;
      if (!/^\d+$/u.test(rawIndex)) continue;
      const index = Number.parseInt(rawIndex, 10);
      if (index < 0 || index >= MAX_ANSI_COLORS) continue;
      if (value === '?') {
        if (activeCapture) activeCapture.viewQueryObserved = true;
        const attributes = readUsableAttributes();
        const color = attributes?.ansi[index];
        if (color) reportColor(`4;${index}`, ansiOverrides.get(index) ?? color);
      } else {
        const parsed = parseColor(value);
        if (parsed) ansiOverrides.set(index, parsed);
      }
    }
    return true;
  }));
  disposables.push(terminal.parser.registerOscHandler(10, data => handleSpecialColor(data, 0)));
  disposables.push(terminal.parser.registerOscHandler(11, data => handleSpecialColor(data, 1)));
  disposables.push(terminal.parser.registerOscHandler(12, data => handleSpecialColor(data, 2)));
  disposables.push(terminal.parser.registerOscHandler(104, data => {
    if (data.length === 0) ansiOverrides.clear();
    for (const rawIndex of data.split(';')) {
      if (/^\d+$/u.test(rawIndex)) ansiOverrides.delete(Number.parseInt(rawIndex, 10));
    }
    return true;
  }));
  disposables.push(terminal.parser.registerOscHandler(110, () => {
    specialOverrides.delete('foreground');
    return true;
  }));
  disposables.push(terminal.parser.registerOscHandler(111, () => {
    specialOverrides.delete('background');
    return true;
  }));
  disposables.push(terminal.parser.registerOscHandler(112, () => {
    specialOverrides.delete('cursor');
    return true;
  }));
  disposables.push(terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, params => {
    const firstParameter = params[0];
    const code = Array.isArray(firstParameter) ? firstParameter[0] : firstParameter;
    if (code === 996) {
      if (activeCapture) activeCapture.viewQueryObserved = true;
      const attributes = readUsableAttributes();
      if (attributes) {
        const background = specialOverrides.get('background') ?? attributes.background;
        const foreground = specialOverrides.get('foreground') ?? attributes.foreground;
        emitReply(`\x1b[?997;${relativeLuminance(background) < relativeLuminance(foreground) ? 1 : 2}n`);
      }
      return true;
    }
    if (KNOWN_SILENT_PRIVATE_DSR.has(code)) {
      if (activeCapture) activeCapture.knownSilentObserved = true;
    } else if (!STRUCTURAL_PRIVATE_DSR.has(code)) {
      if (activeCapture) activeCapture.unknownQueryObserved = true;
    }
    return false;
  }));

  const capabilityState = () => {
    if (unknownQueryBlocker) {
      return {
        structuralCore: '@xterm/headless' as const,
        promotionEligible: false,
        blocker: 'unknown-query-class',
      };
    }
    if (viewCapabilityObserved && readUsableAttributes() === null) {
      return {
        structuralCore: '@xterm/headless' as const,
        promotionEligible: false,
        blocker: 'driver-view-attributes-unavailable',
      };
    }
    return {
      structuralCore: '@xterm/headless' as const,
      promotionEligible: true,
    };
  };

  const writeOnce = async (
    data: string,
    source: 'live' | 'seed' | 'replay',
    commit: () => Promise<void> = () => new Promise<void>(resolve => terminal.write(data, resolve)),
  ): Promise<TerminalQueryWriteResult> => {
    if (detached) {
      return { replies: [], disposition: 'suppressed', promotionEligible: false };
    }
    const capture: WriteCapture = {
      replies: [],
      viewQueryObserved: false,
      knownSilentObserved: false,
      unknownQueryObserved: false,
    };
    activeCapture = capture;
    try {
      await commit();
    } finally {
      activeCapture = null;
    }

    if (capture.viewQueryObserved) viewCapabilityObserved = true;
    if (capture.unknownQueryObserved) unknownQueryBlocker = true;
    const capability = capabilityState();
    if (source !== 'live' && capture.replies.length > 0) {
      return { replies: [], disposition: 'suppressed', promotionEligible: capability.promotionEligible };
    }
    if (source !== 'live') {
      return { replies: [], disposition: 'suppressed', promotionEligible: capability.promotionEligible };
    }
    if (capture.viewQueryObserved && readUsableAttributes() === null) {
      return { replies: [], disposition: 'view-attributes-unavailable', promotionEligible: false };
    }
    if (capture.unknownQueryObserved) {
      return { replies: [], disposition: 'unsupported', promotionEligible: false };
    }
    if (capture.replies.length > 0) {
      return { replies: capture.replies, disposition: 'answered', promotionEligible: capability.promotionEligible };
    }
    const knownSilentByText = data.includes('\x1b[14t') || data.includes('\x1bP+q');
    if (capture.knownSilentObserved || knownSilentByText) {
      return { replies: [], disposition: 'known-silent', promotionEligible: capability.promotionEligible };
    }
    return { replies: [], disposition: 'not-query', promotionEligible: capability.promotionEligible };
  };

  return {
    attachedHeadlessState: headlessState,
    write(data, writeOptions) {
      const result = writeChain.then(() => writeOnce(data, writeOptions.source));
      writeChain = result;
      return result;
    },
    captureCommittedWrite(data, writeOptions, commit) {
      const result = writeChain.then(() => writeOnce(data, writeOptions.source, commit));
      writeChain = result;
      return result;
    },
    pushViewAttributes(input) {
      const driver = readDriverViewIdentity();
      if (!isValidDriverIdentity(driver) || !pushMatchesDriver(input.identity, driver)) {
        return { accepted: false, reason: 'driver-identity-mismatch' };
      }
      if (!isValidViewAttributes(input.attributes)) {
        return { accepted: false, reason: 'view-attributes-shape-invalid' };
      }
      if (driver.serverAcceptedViewAttributesGeneration !== null
        && driver.serverAcceptedViewAttributesGeneration !== input.identity.viewAttributesGeneration) {
        return { accepted: false, reason: 'server-accepted-generation-mismatch' };
      }
      const serializedAttributes = JSON.stringify(input.attributes);
      if (cachedViewAttributes && samePushIdentity(cachedViewAttributes.identity, input.identity)) {
        return cachedViewAttributes.serializedAttributes === serializedAttributes
          ? { accepted: true }
          : { accepted: false, reason: 'same-generation-attributes-changed' };
      }

      const sameDriver = cachedViewAttributes !== null
        && cachedViewAttributes.identity.sessionId === input.identity.sessionId
        && cachedViewAttributes.identity.connectionId === input.identity.connectionId
        && cachedViewAttributes.identity.viewGeneration === input.identity.viewGeneration
        && cachedViewAttributes.identity.driverLeaseId === input.identity.driverLeaseId
        && cachedViewAttributes.identity.driverLeaseGeneration === input.identity.driverLeaseGeneration;
      const attributesChanged = cachedViewAttributes?.serializedAttributes !== serializedAttributes;
      if (!sameDriver || attributesChanged) {
        ansiOverrides.clear();
        specialOverrides.clear();
      }
      cachedViewAttributes = {
        identity: { ...input.identity },
        attributes: structuredClone(input.attributes),
        serializedAttributes,
      };
      terminal.options.cursorStyle = input.attributes.cursorStyle;
      terminal.options.cursorBlink = input.attributes.cursorBlink;
      viewCapabilityObserved = true;
      return { accepted: true };
    },
    getCapabilityState: capabilityState,
    hasAcceptedViewAttributes: () => readUsableAttributes() !== null,
    detach() {
      if (detached) return;
      detached = true;
      activeCapture = null;
      for (const disposable of disposables.splice(0)) disposable.dispose();
    },
  };
}

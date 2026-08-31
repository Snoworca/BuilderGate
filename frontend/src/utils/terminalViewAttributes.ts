import type {
  TerminalAuthorityViewAttributesMessage,
  TerminalCheckpointCapabilityMessage,
  TerminalViewAttributes,
} from '../types/ws-protocol';
import type { TerminalResourceLimitsRuntimeConfig } from './inputReliabilityMode';

// @req MIG-BGSTAB-002 AC-4 AC-3
// AC-4 hard-reload recovery can cross into AC-3 single query authority only
// after the browser and server agree on this complete ordered appearance.
export const TERMINAL_XTERM_THEME = Object.freeze({
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
});

const RGB_THEME_KEYS = Object.freeze([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const);

function hexToRgb(value: string): readonly [number, number, number] {
  return Object.freeze([
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ]) as readonly [number, number, number];
}

function createXtermPalette(): readonly (readonly [number, number, number])[] {
  const ansi = RGB_THEME_KEYS.map(key => hexToRgb(TERMINAL_XTERM_THEME[key]));
  const cube = [0, 95, 135, 175, 215, 255] as const;
  for (const red of cube) for (const green of cube) for (const blue of cube) {
    ansi.push(Object.freeze([red, green, blue]));
  }
  for (let index = 0; index < 24; index += 1) {
    const level = 8 + index * 10;
    ansi.push(Object.freeze([level, level, level]));
  }
  return Object.freeze(ansi);
}

export const TERMINAL_AUTHORITY_VIEW_ATTRIBUTES: TerminalViewAttributes = Object.freeze({
  foreground: hexToRgb(TERMINAL_XTERM_THEME.foreground),
  background: hexToRgb(TERMINAL_XTERM_THEME.background),
  cursor: hexToRgb(TERMINAL_XTERM_THEME.cursor),
  ansi: createXtermPalette(),
  cursorStyle: 'block',
  cursorBlink: true,
  colorSchemeMode: 'dark',
});

// @req REL-BGSTAB-007 AC-1
// Keep the browser's retained range derived from the same public terminal
// resource policy used by the server-side retained model.
export function resolveTerminalXtermOptions(
  limits: Readonly<Pick<TerminalResourceLimitsRuntimeConfig, 'scrollbackLines'>>,
): Readonly<{ scrollback: number }> {
  return Object.freeze({ scrollback: limits.scrollbackLines });
}

// Query responder negotiation belongs to the control connection, not to an
// xterm renderer lifetime. Repeated same-generation capabilities intentionally
// produce the same idempotent registration response.
// @req MIG-BGSTAB-002 AC-4 AC-3
export function buildTerminalAuthorityViewAttributeMessages(
  capability: TerminalCheckpointCapabilityMessage,
): TerminalAuthorityViewAttributesMessage[] {
  return (capability.registeredViews ?? []).flatMap(registration => (
    registration.driverLeaseGeneration
      && registration.acceptedViewAttributesGeneration
      && registration.viewAttributesChallengeId
      ? [{
          type: 'terminal-authority:view-attributes' as const,
          sessionId: registration.sessionId,
          viewGeneration: registration.viewGeneration,
          driverLeaseGeneration: registration.driverLeaseGeneration,
          viewAttributesGeneration: registration.acceptedViewAttributesGeneration,
          viewAttributesChallengeId: registration.viewAttributesChallengeId,
          attributes: TERMINAL_AUTHORITY_VIEW_ATTRIBUTES,
        }]
      : []
  ));
}

export function respondToTerminalAuthorityViewAttributeCapability(
  capability: TerminalCheckpointCapabilityMessage,
  send: (message: TerminalAuthorityViewAttributesMessage) => {
    ok: boolean;
    reason?: string;
  },
): {
  attempted: number;
  accepted: number;
  failures: Array<{ sessionId: string; viewGeneration: number; reason: string }>;
} {
  const messages = buildTerminalAuthorityViewAttributeMessages(capability);
  const failures: Array<{ sessionId: string; viewGeneration: number; reason: string }> = [];
  let accepted = 0;
  for (const message of messages) {
    const result = send(message);
    if (result.ok) {
      accepted += 1;
    } else {
      failures.push({
        sessionId: message.sessionId,
        viewGeneration: message.viewGeneration,
        reason: result.reason ?? 'terminal-view-attributes-send-failed',
      });
    }
  }
  return { attempted: messages.length, accepted, failures };
}

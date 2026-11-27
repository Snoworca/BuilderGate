import type {
  TerminalAuthorityViewAttributesMessage,
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointRegisteredView,
  TerminalViewAttributes,
} from '../types/ws-protocol';
import type { ResolvedTheme } from '../theme/appTheme';
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

export type TerminalXtermTheme = Readonly<Record<keyof typeof TERMINAL_XTERM_THEME, string>>;

// @req FR-UIDS-019 AC-1
// The terminal under the light theme. The background is the light --bg-sunken, the
// well the dark terminal also sits in (#1e1e1e there). Each of the 16 ANSI colours
// keeps 4.5:1 on it (tests/unit/terminalLightTheme.test.ts prints the ratios); SGR 37
// "white", PSReadLine's default input colour, becomes a dark grey so typed text reads.
export const TERMINAL_XTERM_LIGHT_THEME: TerminalXtermTheme = Object.freeze({
  background: '#ffffff',
  foreground: '#1f1f1f',
  cursor: '#1f1f1f',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#795e26',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0e7490',
  white: '#3b3b3b',
  brightBlack: '#5f5f5f',
  brightRed: '#a31515',
  brightGreen: '#14892c',
  brightYellow: '#8a6d00',
  brightBlue: '#0451a5',
  brightMagenta: '#a21caf',
  brightCyan: '#0b6e85',
  brightWhite: '#1f1f1f',
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

function createXtermPalette(theme: TerminalXtermTheme): readonly (readonly [number, number, number])[] {
  const ansi = RGB_THEME_KEYS.map(key => hexToRgb(theme[key]));
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
  ansi: createXtermPalette(TERMINAL_XTERM_THEME),
  cursorStyle: 'block',
  cursorBlink: true,
  colorSchemeMode: 'dark',
});

// @req FR-UIDS-019 AC-4
export const TERMINAL_AUTHORITY_LIGHT_VIEW_ATTRIBUTES: TerminalViewAttributes = Object.freeze({
  foreground: hexToRgb(TERMINAL_XTERM_LIGHT_THEME.foreground),
  background: hexToRgb(TERMINAL_XTERM_LIGHT_THEME.background),
  cursor: hexToRgb(TERMINAL_XTERM_LIGHT_THEME.cursor),
  ansi: createXtermPalette(TERMINAL_XTERM_LIGHT_THEME),
  cursorStyle: 'block',
  cursorBlink: true,
  colorSchemeMode: 'light',
});

// @req FR-UIDS-019 AC-2
// Dark sets exactly xterm's default (1, off), which is what ran before the option was
// set at all. Light asks for 4.5:1 (WCAG AA): colours a program picks itself
// (256-colour, truecolor, its own backgrounds) can be pale on a white terminal, and
// xterm then shifts the text colour until it reads.
const DARK_XTERM_THEME_OPTIONS = Object.freeze({
  theme: TERMINAL_XTERM_THEME,
  minimumContrastRatio: 1,
});
const LIGHT_XTERM_THEME_OPTIONS = Object.freeze({
  theme: TERMINAL_XTERM_LIGHT_THEME,
  minimumContrastRatio: 4.5,
});

// @req FR-UIDS-019 AC-1 AC-2 AC-3
// The appearance options of a theme, given to xterm when it is created and again when
// the theme switches (TerminalView).
export function resolveTerminalXtermThemeOptions(
  theme: ResolvedTheme,
): Readonly<{ theme: TerminalXtermTheme; minimumContrastRatio: number }> {
  return theme === 'light' ? LIGHT_XTERM_THEME_OPTIONS : DARK_XTERM_THEME_OPTIONS;
}

// @req FR-UIDS-019 AC-4
export function resolveTerminalAuthorityViewAttributes(theme: ResolvedTheme): TerminalViewAttributes {
  return theme === 'light' ? TERMINAL_AUTHORITY_LIGHT_VIEW_ATTRIBUTES : TERMINAL_AUTHORITY_VIEW_ATTRIBUTES;
}

// @req REL-BGSTAB-007 AC-1
// Keep the browser's retained range derived from the same public terminal
// resource policy used by the server-side retained model.
export function resolveTerminalXtermOptions(
  limits: Readonly<Pick<TerminalResourceLimitsRuntimeConfig, 'scrollbackLines'>>,
): Readonly<{ scrollback: number }> {
  return Object.freeze({ scrollback: limits.scrollbackLines });
}

export type TerminalViewAttributesResolver = (
  registration: TerminalCheckpointRegisteredView,
) => TerminalViewAttributes;

// @req FR-UIDS-019 AC-4
// The view attributes sent for each registration in server mode. The default (legacy)
// mode answers colour queries in the browser, from the live xterm theme, and needs
// none of this. The server keeps the first attributes of a registration identity and
// refuses different ones for it (same-generation-attributes-changed,
// server/src/utils/terminalQueryResponder.ts), so after a theme switch a registration
// re-sends what it first sent, and the new theme goes out with the next registration:
// a reconnect or reload, a new view, lease or attributes generation. The key is the
// part of that identity the client sees; the server's also holds the driver lease id,
// which only splits identities further, so a pinned re-send is never refused.
export function createTerminalViewAttributesPin(
  readTheme: () => ResolvedTheme,
  maxEntries = 256,
): Readonly<{
  resolve(connectionId: string, registration: TerminalCheckpointRegisteredView): TerminalViewAttributes;
}> {
  let pinnedConnectionId: string | null = null;
  const pinned = new Map<string, TerminalViewAttributes>();
  return Object.freeze({
    resolve(connectionId: string, registration: TerminalCheckpointRegisteredView): TerminalViewAttributes {
      if (connectionId !== pinnedConnectionId) {
        // A registration does not outlive its connection.
        pinnedConnectionId = connectionId;
        pinned.clear();
      }
      const key = JSON.stringify([
        registration.sessionId,
        registration.viewGeneration,
        registration.driverLeaseGeneration ?? null,
        registration.acceptedViewAttributesGeneration ?? null,
      ]);
      const existing = pinned.get(key);
      if (existing) {
        // The one used last now, so the bound below lets go of the registration unused
        // longest rather than one still answering capabilities.
        pinned.delete(key);
        pinned.set(key, existing);
        return existing;
      }
      const attributes = resolveTerminalAuthorityViewAttributes(readTheme());
      pinned.set(key, attributes);
      if (pinned.size > maxEntries) {
        const unusedLongest = pinned.keys().next().value;
        if (unusedLongest !== undefined) pinned.delete(unusedLongest);
      }
      return attributes;
    },
  });
}

// Query responder negotiation belongs to the control connection, not to an
// xterm renderer lifetime. Repeated same-generation capabilities intentionally
// produce the same idempotent registration response; with a resolver from
// createTerminalViewAttributesPin that holds across a theme switch too.
// @req MIG-BGSTAB-002 AC-4 AC-3
export function buildTerminalAuthorityViewAttributeMessages(
  capability: TerminalCheckpointCapabilityMessage,
  resolveAttributes: TerminalViewAttributesResolver = () => TERMINAL_AUTHORITY_VIEW_ATTRIBUTES,
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
          attributes: resolveAttributes(registration),
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
  resolveAttributes?: TerminalViewAttributesResolver,
): {
  attempted: number;
  accepted: number;
  failures: Array<{ sessionId: string; viewGeneration: number; reason: string }>;
} {
  const messages = buildTerminalAuthorityViewAttributeMessages(capability, resolveAttributes);
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

// FR-MCP-020 (#233): the Remote links tab of the MCP settings window. The form edits seconds; the
// server keeps milliseconds and does the full validation.
import { t, type MessageKey } from '../../i18n/i18n.ts';

export interface PeerLinkView {
  name: string;
  url: string;
  hasAccessKey: boolean;
  tlsFingerprintSha256?: string;
  enabled: boolean;
}

export interface PeerLinksSettingsView {
  nodeName: string;
  heartbeatMs: number;
  timeoutMs: number | null;
  queueTtlMs: number;
  keyQueueTtlMs: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  inboundScopes: string[];
  links: PeerLinkView[];
}

export type PeerLinkState = 'connecting' | 'connected' | 'disconnected';

export interface PeerLinkStatus {
  name: string;
  direction: 'outbound' | 'inbound';
  state: PeerLinkState;
  queued: number;
  lastError?: string;
  connectedAt?: string;
}

export interface PeerLinksResponse {
  ok: true;
  settings: PeerLinksSettingsView;
  peers: PeerLinkStatus[];
  defaults: { timeoutRatio: number; inboundScopeChoices: string[] };
}

/** PUT /api/mcp-control/peers refused the values (400): which field and why. */
export interface PeerLinksRejection {
  ok: false;
  code: string;
  fieldErrors?: Record<string, string>;
}

export interface PeerLinkRow {
  name: string;
  url: string;
  /** A new key; empty keeps the stored one. */
  accessKey: string;
  hasAccessKey: boolean;
  tlsFingerprintSha256: string;
  enabled: boolean;
}

export interface PeerLinksDraft {
  nodeName: string;
  heartbeatSecondsText: string;
  /** Empty: 2.5 times the heartbeat. */
  timeoutSecondsText: string;
  queueTtlSecondsText: string;
  keyQueueTtlSecondsText: string;
  maxQueuedMessagesText: string;
  inboundScopes: string[];
  links: PeerLinkRow[];
}

type NumberField = 'heartbeatSecondsText' | 'timeoutSecondsText' | 'queueTtlSecondsText' | 'keyQueueTtlSecondsText' | 'maxQueuedMessagesText';

export const PEER_TIMEOUT_RATIO = 2.5;

const seconds = (ms: number) => String(ms / 1000);

export function createPeerLinksDraft(view: PeerLinksSettingsView): PeerLinksDraft {
  return {
    nodeName: view.nodeName,
    heartbeatSecondsText: seconds(view.heartbeatMs),
    timeoutSecondsText: view.timeoutMs === null ? '' : seconds(view.timeoutMs),
    queueTtlSecondsText: seconds(view.queueTtlMs),
    keyQueueTtlSecondsText: seconds(view.keyQueueTtlMs),
    maxQueuedMessagesText: String(view.maxQueuedMessages),
    inboundScopes: [...view.inboundScopes],
    links: view.links.map((link) => ({
      name: link.name,
      url: link.url,
      accessKey: '',
      hasAccessKey: link.hasAccessKey,
      tlsFingerprintSha256: link.tlsFingerprintSha256 ?? '',
      enabled: link.enabled,
    })),
  };
}

export function emptyPeerLinkRow(): PeerLinkRow {
  return { name: '', url: '', accessKey: '', hasAccessKey: false, tlsFingerprintSha256: '', enabled: true };
}

/** The timeout in effect, in seconds: the one typed, or 2.5 times the heartbeat. */
export function effectivePeerTimeoutSeconds(draft: Pick<PeerLinksDraft, 'heartbeatSecondsText' | 'timeoutSecondsText'>): number | undefined {
  const typed = parseNumber(draft.timeoutSecondsText);
  if (draft.timeoutSecondsText.trim() !== '') return typed;
  const heartbeat = parseNumber(draft.heartbeatSecondsText);
  return heartbeat === undefined ? undefined : heartbeat * PEER_TIMEOUT_RATIO;
}

export function buildPeerLinksPatch(draft: PeerLinksDraft):
  | { ok: true; patch: Record<string, unknown> & { links: Array<Record<string, unknown>> } }
  | { ok: false; errors: Partial<Record<NumberField, MessageKey>> } {
  const errors: Partial<Record<NumberField, MessageKey>> = {};
  const ms = (field: NumberField): number => {
    const value = parseNumber(draft[field]);
    if (value === undefined || value < 0) {
      errors[field] = 'mcp.peers.error.number';
      return 0;
    }
    return Math.round(value * 1000);
  };
  const heartbeatMs = ms('heartbeatSecondsText');
  const timeoutMs = draft.timeoutSecondsText.trim() === '' ? null : ms('timeoutSecondsText');
  const queueTtlMs = ms('queueTtlSecondsText');
  const keyQueueTtlMs = ms('keyQueueTtlSecondsText');
  const maxQueuedMessages = parseNumber(draft.maxQueuedMessagesText);
  if (maxQueuedMessages === undefined || maxQueuedMessages < 1 || !Number.isInteger(maxQueuedMessages)) {
    errors.maxQueuedMessagesText = 'mcp.peers.error.number';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    patch: {
      nodeName: draft.nodeName.trim(),
      heartbeatMs,
      timeoutMs,
      queueTtlMs,
      keyQueueTtlMs,
      maxQueuedMessages: maxQueuedMessages as number,
      inboundScopes: [...draft.inboundScopes],
      links: draft.links.map((row) => ({
        name: row.name.trim(),
        url: row.url.trim(),
        accessKey: row.accessKey.trim(),
        tlsFingerprintSha256: row.tlsFingerprintSha256.trim(),
        enabled: row.enabled,
      })),
    },
  };
}

export function peerStateLabelKey(state: string): MessageKey {
  switch (state) {
    case 'connected':
      return 'mcp.peers.state.connected';
    case 'connecting':
      return 'mcp.peers.state.connecting';
    case 'disconnected':
      return 'mcp.peers.state.disconnected';
    default:
      return 'common.unknown';
  }
}

function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+(\.\d+)?$/u.test(trimmed)) return undefined;
  return Number(trimmed);
}

const FIELD_LABELS: Record<string, MessageKey> = {
  nodeName: 'mcp.peers.nodeName',
  heartbeatMs: 'mcp.peers.heartbeat',
  timeoutMs: 'mcp.peers.timeout',
  queueTtlMs: 'mcp.peers.queueTtl',
  keyQueueTtlMs: 'mcp.peers.keyQueueTtl',
  maxQueuedMessages: 'mcp.peers.maxQueued',
  inboundScopes: 'mcp.peers.inboundScopes',
  name: 'mcp.peers.link.name',
  url: 'mcp.peers.link.url',
  accessKey: 'mcp.peers.link.accessKey',
  tlsFingerprintSha256: 'mcp.peers.link.fingerprint',
};

/** FR-MCP-020 AC-3: the server's field errors as lines naming the field ("Address (remote 2): ..."). */
export function describePeerFieldErrors(fieldErrors: Record<string, string>): string[] {
  return Object.entries(fieldErrors).map(([field, message]) => {
    const link = /^links\.(\d+)\.(\w+)$/u.exec(field);
    const key = FIELD_LABELS[link ? link[2]! : field];
    if (!key) return `${field}: ${message}`;
    const label = link ? t('mcp.peers.fieldInLink', { label: t(key), index: Number(link[1]) + 1 }) : t(key);
    return `${label}: ${message}`;
  });
}

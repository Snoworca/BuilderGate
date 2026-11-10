// FR-MCP-017 AC-2, FR-MCP-020 (#233): settings of the MCP peer link -- this server's name, the
// remotes it dials, heartbeat, timeout and queue limits, and the scopes given to requests that
// arrive over a link this server dialed.

export interface PeerLinkEntry {
  /** The name this server uses for the remote, as in "azure/worker". */
  name: string;
  /** wss://host:port/mcp/peer (ws:// only to a loopback host). */
  url: string;
  /** The remote's fixed MCP access key, in plain text in memory only. */
  accessKey: string;
  /** SHA-256 of the remote certificate, 64 lower-case hex digits; remembered on first use (FR-MCP-024 AC-3). */
  tlsFingerprintSha256?: string;
  enabled: boolean;
  /** FR-MSG-009: 'room' is a link opened with a room ticket, hidden from contact lists. Absent means contact. */
  kind?: PeerLinkKind;
}

export type PeerLinkKind = 'contact' | 'room';

export interface PeerLinkSettings {
  nodeName: string;
  heartbeatMs: number;
  /** null means 2.5 times heartbeatMs. */
  timeoutMs: number | null;
  queueTtlMs: number;
  keyQueueTtlMs: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  inboundScopes: string[];
  links: PeerLinkEntry[];
}

/** FR-MSG-008 AC-1: letters of any script, digits, '_' and '-'; never whitespace, '::', '@' or '/'. */
export const PEER_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u;
const PEER_NAME_RULE = 'letters, digits, _ and -, 1 to 32, starting with a letter or digit';
export const PEER_TIMEOUT_RATIO = 2.5;
export const PEER_INBOUND_SCOPE_CHOICES = ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste', 'mcp:message.submit'] as const;

export const DEFAULT_PEER_LINK_SETTINGS: Readonly<PeerLinkSettings> = Object.freeze({
  nodeName: 'buildergate',
  heartbeatMs: 15_000,
  timeoutMs: null,
  queueTtlMs: 60_000,
  keyQueueTtlMs: 5_000,
  maxQueuedMessages: 256,
  maxQueuedBytes: 1024 * 1024,
  // FR-MCP-022 AC-10: the master searches every linked server.
  inboundScopes: ['mcp:sessions.list', 'mcp:sessions.search', 'mcp:message.paste'],
  links: [],
});

export function effectivePeerTimeoutMs(settings: Pick<PeerLinkSettings, 'heartbeatMs' | 'timeoutMs'>): number {
  return settings.timeoutMs ?? Math.round(settings.heartbeatMs * PEER_TIMEOUT_RATIO);
}

/** A node name from a host name: what an unset nodeName starts as. */
export function peerNodeNameFrom(hostName: string): string {
  const cleaned = hostName.replace(/[^A-Za-z0-9-]+/gu, '-').replace(/^-+/u, '').slice(0, 32);
  return PEER_NAME_PATTERN.test(cleaned) ? cleaned : DEFAULT_PEER_LINK_SETTINGS.nodeName;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\./u.test(bare);
}

/** FR-MCP-016 AC-1: wss, or ws to a loopback host. */
export function isAllowedPeerUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'wss:' || (url.protocol === 'ws:' && isLoopbackHost(url.hostname));
}

/** The port an MCP listener uses when the address names none (McpControlService default). */
export const PEER_DEFAULT_MCP_PORT = 3333;
const PEER_ADDRESS_RULE = 'an MCP address such as https://host:3333/mcp (ws:// and http:// only to localhost)';
const PEER_PLAIN_HTTP_RULE = 'the remote MCP uses plain HTTP; turn on HTTPS in its MCP settings';

/**
 * FR-MCP-024 AC-1/AC-2: turns what a person pastes (the MCP address, host:port, a bare host or a
 * link address) into the link address wss://host:port/mcp/peer. http and ws stay plain only for a
 * loopback host.
 */
export function normalizePeerAddress(input: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `wss://${trimmed}`;
  if (!trimmed || !URL.canParse(withScheme)) return { ok: false, reason: PEER_ADDRESS_RULE };
  const url = new URL(withScheme);
  if (!url.hostname) return { ok: false, reason: PEER_ADDRESS_RULE };
  let scheme: 'wss' | 'ws';
  if (url.protocol === 'https:' || url.protocol === 'wss:') {
    scheme = 'wss';
  } else if (url.protocol === 'http:' || url.protocol === 'ws:') {
    if (!isLoopbackHost(url.hostname)) return { ok: false, reason: PEER_PLAIN_HTTP_RULE };
    scheme = 'ws';
  } else {
    return { ok: false, reason: PEER_ADDRESS_RULE };
  }
  const bare = url.pathname.replace(/\/+$/u, '');
  const pathname = bare === '' || bare === '/mcp' ? '/mcp/peer' : bare;
  // URL drops a port equal to the scheme default (:443), so read the written port from the text.
  // A port written out is kept; a link address (ws/wss) without one keeps its scheme default, as
  // links saved before FR-MCP-024 did; an MCP address or a bare host without one gets the MCP port.
  const writtenPort = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d+)/iu.exec(withScheme)?.[1];
  const isLinkAddress = trimmed === withScheme && (url.protocol === 'wss:' || url.protocol === 'ws:');
  const port = writtenPort ?? (isLinkAddress ? '' : String(PEER_DEFAULT_MCP_PORT));
  return { ok: true, url: `${scheme}://${url.hostname}${port ? `:${port}` : ''}${pathname}` };
}

export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.replace(/:/gu, '').toLowerCase();
  return /^[0-9a-f]{64}$/u.test(hex) ? hex : undefined;
}

type Result = { ok: true; settings: PeerLinkSettings } | { ok: false; fieldErrors: Record<string, string> };

/**
 * FR-MCP-020 AC-1..AC-3: merges a patch onto the current settings. Fields left out keep their
 * value; a link given with an empty access key keeps the stored key of the link of the same name.
 */
export function validatePeerLinkSettings(patch: Record<string, unknown>, current: PeerLinkSettings): Result {
  const errors: Record<string, string> = {};
  const nodeName = has(patch, 'nodeName') ? patch.nodeName : current.nodeName;
  if (typeof nodeName !== 'string' || !PEER_NAME_PATTERN.test(nodeName)) {
    errors.nodeName = PEER_NAME_RULE;
  }
  const heartbeatMs = numberField(patch, 'heartbeatMs', current.heartbeatMs, 1_000, 300_000, errors);
  const timeoutMs = has(patch, 'timeoutMs') ? patch.timeoutMs : current.timeoutMs;
  if (timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= heartbeatMs || timeoutMs > 3_600_000)) {
    errors.timeoutMs = 'empty, or a whole number of ms larger than heartbeatMs';
  }
  const queueTtlMs = numberField(patch, 'queueTtlMs', current.queueTtlMs, 1_000, 3_600_000, errors);
  const keyQueueTtlMs = numberField(patch, 'keyQueueTtlMs', current.keyQueueTtlMs, 0, 3_600_000, errors);
  const maxQueuedMessages = numberField(patch, 'maxQueuedMessages', current.maxQueuedMessages, 1, 10_000, errors);
  const maxQueuedBytes = numberField(patch, 'maxQueuedBytes', current.maxQueuedBytes, 1_024, 64 * 1024 * 1024, errors);
  const inboundScopes = has(patch, 'inboundScopes') ? patch.inboundScopes : current.inboundScopes;
  if (!Array.isArray(inboundScopes)
    || !inboundScopes.every((scope) => (PEER_INBOUND_SCOPE_CHOICES as readonly unknown[]).includes(scope))) {
    errors.inboundScopes = `a list of ${PEER_INBOUND_SCOPE_CHOICES.join(', ')}`;
  }
  const links = has(patch, 'links') ? patch.links : current.links;
  const validLinks: PeerLinkEntry[] = [];
  if (!Array.isArray(links)) {
    errors.links = 'a list';
  } else {
    const seen = new Set<string>();
    links.forEach((raw, index) => {
      const entry = validateLink(raw, index, current, seen, errors, typeof nodeName === 'string' ? nodeName : current.nodeName);
      if (entry) validLinks.push(entry);
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    settings: {
      nodeName: nodeName as string,
      heartbeatMs,
      timeoutMs: timeoutMs as number | null,
      queueTtlMs,
      keyQueueTtlMs,
      maxQueuedMessages,
      maxQueuedBytes,
      inboundScopes: [...new Set(inboundScopes as string[])],
      links: validLinks,
    },
  };
}

function validateLink(
  raw: unknown,
  index: number,
  current: PeerLinkSettings,
  seen: Set<string>,
  errors: Record<string, string>,
  nodeName: string,
): PeerLinkEntry | undefined {
  const field = (name: string) => `links.${index}.${name}`;
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const name = record.name;
  let ok = true;
  if (typeof name !== 'string' || !PEER_NAME_PATTERN.test(name)) {
    errors[field('name')] = PEER_NAME_RULE;
    ok = false;
  } else if (seen.has(name.toLowerCase())) {
    errors[field('name')] = 'used twice';
    ok = false;
  } else if (name.toLowerCase() === nodeName.toLowerCase()) {
    // FR-MCP-022: "<name>/<session>" must say which server; this server's name means this server.
    errors[field('name')] = 'the name of this server';
    ok = false;
  } else {
    seen.add(name.toLowerCase());
  }
  // FR-MCP-024 AC-1/AC-2: the MCP address is stored as the link address it stands for.
  const address = typeof record.url === 'string' ? normalizePeerAddress(record.url) : { ok: false as const, reason: PEER_ADDRESS_RULE };
  if (!address.ok) {
    errors[field('url')] = address.reason;
    ok = false;
  }
  const url = address.ok ? address.url : '';
  const previous = current.links.find((link) => link.name === name);
  const given = typeof record.accessKey === 'string' ? record.accessKey.trim() : '';
  const accessKey = given || (previous?.accessKey ?? '');
  if (!accessKey) {
    errors[field('accessKey')] = 'required';
    ok = false;
  }
  // FR-MCP-024 AC-5: left out, the remembered certificate stays while the address does; null or ''
  // forgets it ("trust the new certificate").
  let tlsFingerprintSha256: string | undefined;
  if (typeof record.tlsFingerprintSha256 === 'string' && record.tlsFingerprintSha256.trim() !== '') {
    tlsFingerprintSha256 = normalizeFingerprint(record.tlsFingerprintSha256.trim());
    if (!tlsFingerprintSha256) {
      errors[field('tlsFingerprintSha256')] = '64 hex digits, colons allowed';
      ok = false;
    }
  } else if (record.tlsFingerprintSha256 === undefined && previous?.url === url) {
    tlsFingerprintSha256 = previous.tlsFingerprintSha256;
  }
  // Review H3: a save that leaves kind out (the MCP settings panel) keeps the link's kind.
  const kind = record.kind ?? current.links.find((link) => link.name === name)?.kind;
  if (kind !== undefined && kind !== 'contact' && kind !== 'room') {
    errors[field('kind')] = 'contact or room';
    ok = false;
  }
  if (!ok) return undefined;
  return {
    name: name as string,
    url,
    accessKey,
    ...(tlsFingerprintSha256 ? { tlsFingerprintSha256 } : {}),
    enabled: record.enabled !== false,
    ...(kind === 'room' ? { kind } : {}),
  };
}

function numberField(
  patch: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  errors: Record<string, string>,
): number {
  const value = has(patch, key) ? patch[key] : fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors[key] = `a whole number from ${min} to ${max}`;
    return fallback;
  }
  return value;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

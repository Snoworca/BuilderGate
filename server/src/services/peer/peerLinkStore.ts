// FR-MCP-020 (#233): where the peer link settings live (server/data/mcp-peer-links.json, access
// keys encrypted with this machine's key) and the control behind GET/PUT /api/mcp-control/peers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { publishStoreAtomically } from '../../utils/atomicStoreWrite.js';
import {
  DEFAULT_PEER_LINK_SETTINGS,
  PEER_INBOUND_SCOPE_CHOICES,
  PEER_TIMEOUT_RATIO,
  peerNodeNameFrom,
  validatePeerLinkSettings,
  type PeerLinkEntry,
  type PeerLinkSettings,
} from './peerLinkSettings.js';

export const DEFAULT_PEER_LINK_DATA_PATH = './data/mcp-peer-links.json';

export interface PeerKeyCipher {
  encrypt(plaintext: string): string;
  decrypt(encrypted: string): string;
}

export interface PeerLinkFileStore {
  load(): Promise<PeerLinkSettings>;
  save(settings: PeerLinkSettings): Promise<void>;
}

export function createPeerLinkFileStore(options: {
  dataPath?: string;
  crypto: PeerKeyCipher;
  hostName: string;
  warn?: (event: Record<string, unknown>) => void;
}): PeerLinkFileStore {
  const dataPath = path.resolve(options.dataPath ?? DEFAULT_PEER_LINK_DATA_PATH);
  const warn = options.warn ?? ((event) => console.warn('[PeerLinkStore]', JSON.stringify(event)));
  const fallback: PeerLinkSettings = { ...DEFAULT_PEER_LINK_SETTINGS, nodeName: peerNodeNameFrom(options.hostName) };

  const decryptKey = (name: string, value: unknown): string => {
    if (typeof value !== 'string' || value === '') return '';
    try {
      return options.crypto.decrypt(value);
    } catch (error) {
      // A file copied from another machine (or WSL vs Windows) cannot be read here: keep the link
      // and ask for the key again rather than drop the whole file.
      warn({ code: 'PEER_KEY_DECRYPT_FAILED', link: name, message: error instanceof Error ? error.message : String(error) });
      return '';
    }
  };

  return {
    load: async () => {
      const raw = await readJson(dataPath, warn);
      if (!raw) return { ...fallback };
      const links = Array.isArray(raw.links) ? raw.links.map((entry: Record<string, unknown>) => ({
        ...entry,
        accessKey: decryptKey(String(entry.name), entry.accessKeyEncrypted),
      })) : [];
      // Validation needs keys; a link whose key could not be read is checked with a placeholder
      // and then given back without one.
      const placeholder = links.map((entry: Record<string, unknown>) => ({ ...entry, accessKey: entry.accessKey || '-' }));
      const checked = validatePeerLinkSettings({ ...raw, links: placeholder }, fallback);
      if (!checked.ok) {
        warn({ code: 'PEER_SETTINGS_INVALID', path: dataPath, fieldErrors: checked.fieldErrors });
        return { ...fallback };
      }
      return {
        ...checked.settings,
        links: checked.settings.links.map((entry, index) => ({ ...entry, accessKey: String(links[index]?.accessKey ?? '') })),
      };
    },
    save: async (settings) => {
      const { links, ...rest } = settings;
      const body = {
        version: 1,
        ...rest,
        links: links.map(({ accessKey, ...entry }) => ({ ...entry, accessKeyEncrypted: accessKey ? options.crypto.encrypt(accessKey) : '' })),
        updatedAt: new Date().toISOString(),
      };
      await publishStoreAtomically(dataPath, JSON.stringify(body, null, 2), { writeBackup: false, ensureDirectory: true });
    },
  };
}

async function readJson(dataPath: string, warn: (event: Record<string, unknown>) => void): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(dataPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn({ code: 'PEER_SETTINGS_LOAD_FAILED', path: dataPath });
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    warn({ code: 'PEER_SETTINGS_PARSE_FAILED', path: dataPath });
    return undefined;
  }
}

/** The settings as the UI sees them: keys replaced by hasAccessKey (FR-MCP-020 AC-2). */
export function peerSettingsView(settings: PeerLinkSettings): Record<string, unknown> {
  return {
    ...settings,
    links: settings.links.map(({ accessKey, ...entry }) => ({ ...entry, hasAccessKey: accessKey !== '' })),
  };
}

export interface PeerLinkControl {
  get(): Record<string, unknown>;
  /** The current settings with their keys, for the messenger (never sent to the browser). */
  settings(): PeerLinkSettings;
  update(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * FR-MCP-024 AC-3: saves the certificate an unpinned link met first at `url`; a pinned link, or
   * one whose address changed meanwhile (review M2), is left alone.
   */
  learnFingerprint(name: string, url: string, fingerprint: string): Promise<Record<string, unknown>>;
  /** FR-MCP-024 AC-4: "trust the new certificate" -- forgets the remembered one, so the link reconnects. */
  forgetFingerprint(name: string): Promise<Record<string, unknown>>;
}

export function createPeerLinkControl(deps: {
  store: PeerLinkFileStore;
  initial: PeerLinkSettings;
  apply: (settings: PeerLinkSettings) => void;
  status: () => unknown[];
}): PeerLinkControl {
  let current = deps.initial;
  let saving: Promise<unknown> = Promise.resolve();
  const get = () => ({
    ok: true,
    settings: peerSettingsView(current),
    peers: deps.status(),
    defaults: {
      ...peerSettingsView(DEFAULT_PEER_LINK_SETTINGS),
      timeoutRatio: PEER_TIMEOUT_RATIO,
      inboundScopeChoices: [...PEER_INBOUND_SCOPE_CHOICES],
    },
  });
  // Saves run one after another, so each works on the settings the one before it left.
  const serially = (step: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const run = saving.then(step);
    saving = run.then(() => undefined, () => undefined);
    return run;
  };
  const commit = async (next: PeerLinkSettings) => {
    await deps.store.save(next);
    current = next;
    deps.apply(current);
    return get();
  };
  const withLink = (name: string, change: (link: PeerLinkEntry) => PeerLinkEntry): PeerLinkSettings => ({
    ...current,
    links: current.links.map((link) => (link.name === name ? change(link) : link)),
  });
  return {
    get,
    settings: () => current,
    update: (patch) => serially(async () => {
      const checked = validatePeerLinkSettings(patch, current);
      if (!checked.ok) return { ok: false, code: 'VALIDATION_ERROR', fieldErrors: checked.fieldErrors };
      return commit(checked.settings);
    }),
    learnFingerprint: (name, url, fingerprint) => serially(async () => {
      const link = current.links.find((entry) => entry.name === name);
      if (!link || link.url !== url || link.tlsFingerprintSha256 !== undefined) return get();
      return commit(withLink(name, (entry) => ({ ...entry, tlsFingerprintSha256: fingerprint })));
    }),
    forgetFingerprint: (name) => serially(async () => {
      if (!current.links.some((entry) => entry.name === name)) return { ok: false, code: 'PEER_LINK_NOT_FOUND' };
      return commit(withLink(name, ({ tlsFingerprintSha256: _forgotten, ...entry }) => entry));
    }),
  };
}

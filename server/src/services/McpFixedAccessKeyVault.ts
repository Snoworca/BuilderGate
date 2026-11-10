// FR-MCP-024 AC-6 (supersedes SEC-MCP-002 AC-10 "hash only"): the fixed MCP access key ("MCP key").
// Requests are still checked against the hash; the key itself is kept encrypted with this machine's
// key so a signed-in user can see it again, the way peer link keys are kept (FR-MCP-020 AC-2).
import {
  createMcpFixedAccessKey,
  verifyMcpFixedAccessKey,
} from './McpSecurityContract.js';

export interface McpFixedAccessKeyCipher {
  encrypt(plaintext: string): string;
  decrypt(encrypted: string): string;
}

/** The two fields this key adds to the persisted MCP control config. */
export interface McpFixedAccessKeyFields {
  fixedAccessKeyHash?: string;
  fixedAccessKeyEncrypted?: string;
}

export type McpFixedAccessKeyReveal =
  | { ok: true; accessKey: string }
  | { ok: false; code: 'MCP_FIXED_ACCESS_KEY_NOT_CONFIGURED' | 'MCP_FIXED_ACCESS_KEY_NOT_REVEALABLE' };

export type McpFixedAccessKeyRotation =
  | { ok: true; accessKey: string; fields: Required<McpFixedAccessKeyFields> }
  | { ok: false; code: string };

export interface McpFixedAccessKeyVault {
  configured(): boolean;
  verify(token: string): boolean;
  reveal(): McpFixedAccessKeyReveal;
  /** Makes a new key, saves it through persist, and only then replaces the old one. */
  rotate(): Promise<McpFixedAccessKeyRotation>;
}

export function createMcpFixedAccessKeyVault(deps: {
  cipher: McpFixedAccessKeyCipher;
  initial: McpFixedAccessKeyFields;
  persist: (fields: Required<McpFixedAccessKeyFields>) => Promise<{ ok?: unknown; code?: unknown }>;
}): McpFixedAccessKeyVault {
  let fields: McpFixedAccessKeyFields = { ...deps.initial };

  const reveal = (): McpFixedAccessKeyReveal => {
    if (!fields.fixedAccessKeyHash) return { ok: false, code: 'MCP_FIXED_ACCESS_KEY_NOT_CONFIGURED' };
    const accessKey = decrypt(fields.fixedAccessKeyEncrypted);
    // A key from an older version (hash only), or one encrypted on another machine, cannot be shown;
    // the decrypted value must also still be the key the hash belongs to.
    if (!accessKey || !verifyMcpFixedAccessKey(accessKey, fields.fixedAccessKeyHash)) {
      return { ok: false, code: 'MCP_FIXED_ACCESS_KEY_NOT_REVEALABLE' };
    }
    return { ok: true, accessKey };
  };

  const decrypt = (encrypted: string | undefined): string | undefined => {
    if (!encrypted) return undefined;
    try {
      return deps.cipher.decrypt(encrypted);
    } catch {
      return undefined;
    }
  };

  return {
    configured: () => Boolean(fields.fixedAccessKeyHash),
    verify: (token) => Boolean(fields.fixedAccessKeyHash) && verifyMcpFixedAccessKey(token, fields.fixedAccessKeyHash!),
    reveal,
    rotate: async () => {
      const generated = createMcpFixedAccessKey();
      const accessKey = typeof generated.accessKey === 'string' ? generated.accessKey : '';
      const keyHash = typeof generated.keyHash === 'string' ? generated.keyHash : '';
      if (!accessKey || !keyHash) return { ok: false, code: 'MCP_FIXED_ACCESS_KEY_ROTATION_FAILED' };
      const next = { fixedAccessKeyHash: keyHash, fixedAccessKeyEncrypted: deps.cipher.encrypt(accessKey) };
      const persisted = await deps.persist(next);
      if (persisted.ok === false) {
        return { ok: false, code: typeof persisted.code === 'string' ? persisted.code : 'MCP_CONTROL_CONFIG_PERSIST_FAILED' };
      }
      fields = next;
      return { ok: true, accessKey, fields: next };
    },
  };
}

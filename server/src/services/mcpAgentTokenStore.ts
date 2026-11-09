// SEC-MCP-002: registry of the session-bound actor tokens this server minted, so a session close
// can revoke them. Raw tokens live in memory only.
import { mintMcpCapabilityToken } from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;

export interface McpAgentTokenStore {
  mint: (request: unknown) => StringRecord;
  revoke: (request: unknown) => { ok: true; revoked: number };
  isRevoked: (credential: StringRecord) => boolean;
}

function asRecord(value: unknown): StringRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function createMcpAgentTokenStore(): McpAgentTokenStore {
  const tokens = new Map<string, { sessionKey: string; revoked: boolean; createdAt: string }>();
  return {
    mint: (request) => {
      const record = asRecord(request);
      const sessionKey = asString(record.sessionKey) ?? '';
      const scopes = Array.isArray(record.scopes) ? record.scopes.map(String) : [];
      // No lifetime unless one is asked for: the token ends with its session (revoke / not live).
      const requestedExpiresInSeconds = record.expiresInSeconds === undefined ? undefined : Number(record.expiresInSeconds);
      const tokenRecord = asRecord(mintMcpCapabilityToken({
        audience: asString(record.audience) ?? 'buildergate-mcp',
        sessionKey,
        scopes,
        expiresInSeconds: requestedExpiresInSeconds !== undefined && Number.isFinite(requestedExpiresInSeconds)
          ? requestedExpiresInSeconds
          : undefined,
      }));
      const token = asString(tokenRecord.token);
      if (token) {
        tokens.set(token, { sessionKey, revoked: false, createdAt: new Date().toISOString() });
      }
      return tokenRecord;
    },
    revoke: (request) => {
      const record = asRecord(request);
      const token = asString(record.token);
      const sessionKey = asString(record.sessionKey);
      let revoked = 0;
      const byToken = token ? tokens.get(token) : undefined;
      if (byToken) {
        byToken.revoked = true;
        revoked += 1;
      }
      if (sessionKey) {
        for (const entry of tokens.values()) {
          if (entry.sessionKey === sessionKey && !entry.revoked) {
            entry.revoked = true;
            revoked += 1;
          }
        }
      }
      return { ok: true, revoked };
    },
    isRevoked: (credential) => {
      const token = asString(credential.token);
      return token ? tokens.get(token)?.revoked === true : false;
    },
  };
}

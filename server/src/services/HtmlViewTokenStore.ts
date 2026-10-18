// SEC-MDE-002 AC-4, AC-5 (#141): HTML view tokens. The page in the sandboxed frame loads its own
// resources by relative URL and carries no Authorization header, so the token in the URL stands for
// one session folder of one user. Unlike a download token it is spent many times: it lives until
// 30 minutes after its last use or until the tab that opened it revokes it. Each token keeps the
// last 500 requests made through it for the resource panel.
import crypto from 'node:crypto';

export type HtmlViewResult = 'loaded' | 'not-found' | 'blocked';

export interface HtmlViewRequestRecord {
  /** The requested path relative to the session folder, '/' separated. */
  path: string;
  result: HtmlViewResult;
  /** ISO time. */
  at: string;
}

export interface HtmlViewToken {
  sessionId: string;
  userId: string;
  /** The session folder's real path when the token was issued; every request resolves under it. */
  root: string;
}

interface Entry extends HtmlViewToken {
  lastUsedAt: number;
  requests: HtmlViewRequestRecord[];
}

export const HTML_VIEW_IDLE_MS = 30 * 60_000;
export const HTML_VIEW_REQUEST_LOG_LIMIT = 500;

export class HtmlViewTokenStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly capacity: number;

  constructor(options: { now?: () => number; idleMs?: number; capacity?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? HTML_VIEW_IDLE_MS;
    this.capacity = options.capacity ?? 256;
  }

  issue(target: HtmlViewToken): string {
    this.sweep();
    // Bounded: the least recently used token goes first.
    while (this.entries.size >= this.capacity) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [token, entry] of this.entries) {
        if (entry.lastUsedAt < oldestAt) {
          oldest = token;
          oldestAt = entry.lastUsedAt;
        }
      }
      if (oldest === null) break;
      this.entries.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.entries.set(token, { ...target, lastUsedAt: this.now(), requests: [] });
    return token;
  }

  /** The token's target, its idle clock restarted; null when unknown or expired. */
  use(token: string): HtmlViewToken | null {
    const entry = this.live(token);
    if (entry === null) return null;
    entry.lastUsedAt = this.now();
    return { sessionId: entry.sessionId, userId: entry.userId, root: entry.root };
  }

  /** The token's target without counting as a use, only for its own session and user. */
  peek(token: string, sessionId: string | null, userId: string): HtmlViewToken | null {
    const entry = this.live(token);
    if (entry === null || entry.userId !== userId || (sessionId !== null && entry.sessionId !== sessionId)) return null;
    return { sessionId: entry.sessionId, userId: entry.userId, root: entry.root };
  }

  /** Revokes the token when it belongs to userId. */
  revoke(token: string, userId: string): boolean {
    const entry = this.live(token);
    if (entry === null || entry.userId !== userId) return false;
    this.entries.delete(token);
    return true;
  }

  record(token: string, path: string, result: HtmlViewResult): void {
    const entry = this.entries.get(token);
    if (entry === undefined) return;
    entry.requests.push({ path, result, at: new Date(this.now()).toISOString() });
    if (entry.requests.length > HTML_VIEW_REQUEST_LOG_LIMIT) entry.requests.splice(0, entry.requests.length - HTML_VIEW_REQUEST_LOG_LIMIT);
  }

  requests(token: string): HtmlViewRequestRecord[] {
    return (this.entries.get(token)?.requests ?? []).map((r) => ({ ...r }));
  }

  private live(token: string): Entry | null {
    const entry = this.entries.get(token);
    if (entry === undefined) return null;
    if (this.now() - entry.lastUsedAt > this.idleMs) {
      this.entries.delete(token);
      return null;
    }
    return entry;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.idleMs) this.entries.delete(token);
    }
  }
}

// FR-FEX-021 AC-3: single-use, short-lived download tokens. A browser download is a plain link,
// which carries no Authorization header, so the authenticated token route hands out a token that
// stands for one resolved file for a short time, and the download route spends it.
import crypto from 'node:crypto';

export interface DownloadTarget {
  sessionId: string;
  /** Absolute path the file API resolved and checked when the token was issued. */
  path: string;
  name: string;
}

interface Entry extends DownloadTarget {
  expiresAt: number;
}

export class DownloadTokenStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(options: { ttlMs?: number; now?: () => number; capacity?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? 256;
  }

  issue(target: DownloadTarget): string {
    this.sweep();
    // Bounded: the oldest outstanding token goes first.
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.entries.set(token, { ...target, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** The target, once: a used or expired token answers null. */
  consume(token: string): DownloadTarget | null {
    const entry = this.entries.get(token);
    if (entry === undefined) return null;
    this.entries.delete(token);
    if (entry.expiresAt <= this.now()) return null;
    return { sessionId: entry.sessionId, path: entry.path, name: entry.name };
  }

  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}

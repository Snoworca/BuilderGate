// REL-BGSTAB-037: when the browser renews its login token. The token is renewed once it is ten
// minutes old (or half its life, for short sessions), so the session slides with use; the check
// runs every minute and whenever the page comes back (visible, focus, online), which is what
// keeps a sleeping laptop or a frozen tab from missing its only renewal.

export const AUTH_REFRESH_MAX_AGE_MS = 10 * 60 * 1000;
export const AUTH_REFRESH_CHECK_INTERVAL_MS = 60 * 1000;

export interface AuthRefreshInput {
  now: number;
  /** Absolute expiry of the stored token, or null when there is none. */
  expiresAt: number | null;
  /** Lifetime the server gave the stored token, or null when it was not recorded. */
  durationMs: number | null;
}

export function shouldRefreshAuthToken({ now, expiresAt, durationMs }: AuthRefreshInput): boolean {
  if (expiresAt === null || expiresAt <= now) return false;
  if (durationMs === null || durationMs <= 0) return true;
  const age = durationMs - (expiresAt - now);
  return age >= Math.min(AUTH_REFRESH_MAX_AGE_MS, durationMs / 2);
}

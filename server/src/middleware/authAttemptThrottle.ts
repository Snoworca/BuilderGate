import type { NextFunction, Request, Response } from 'express';

/**
 * #61: slow down online password and TOTP guessing.
 *
 * `POST /api/auth/login` and `/api/auth/verify` had neither a rate limit nor a lockout, and
 * this product is meant to be reached remotely -- login is the gate. Without an attempt limit
 * the only defence against online guessing is password strength.
 *
 * DECISIONS, with the reasoning, because the issue asked for them rather than for code:
 *
 * DELAY, NOT LOCKOUT. A lockout is a denial-of-service lever: anyone who can reach the login
 * page can lock the operator out of their own machine by failing on purpose. A progressive
 * delay costs an attacker their throughput -- the thing online guessing depends on -- while a
 * legitimate user who mistypes once waits a moment and carries on.
 *
 * KEYED ON THE SOCKET ADDRESS, NOT X-Forwarded-For. A proxy header is attacker-controlled
 * unless the deployment is known to sit behind a trusted proxy, and this one does not know
 * that. Keying on a spoofable value would let an attacker reset their own counter per request,
 * which is worse than no throttle because it would look like protection.
 *
 * IN MEMORY, RESET ON RESTART. Stated rather than hidden: an attacker who can restart the
 * server has already won, so persistence buys nothing against this threat. It does mean a
 * crash-loop clears counters, which is a real limitation and is why the delay is capped low
 * enough to stay useful rather than relied on as the only control.
 *
 * NO CONFIG SURFACE. #32 removed five `bruteForce.*` keys that nothing enforced, and the issue
 * is right that an unenforced security setting is worse than none -- an operator reading it
 * believes they are protected. Re-introducing the surface re-introduces that risk the moment a
 * later refactor drops the wiring, so the numbers live here next to the code that uses them.
 */
const WINDOW_MS = 15 * 60 * 1000;
const FREE_ATTEMPTS = 5;
const STEP_MS = 500;
const MAX_DELAY_MS = 10_000;
/** Bounded so a spray across many source addresses cannot grow this without limit. */
const MAX_TRACKED = 10_000;

interface AttemptRecord { failures: number; firstFailureAt: number; }

const attempts = new Map<string, AttemptRecord>();

function keyFor(req: Request): string {
  // req.socket.remoteAddress is what the kernel saw. req.ip honours trust-proxy settings and
  // can therefore be attacker-supplied; see the header note above.
  return req.socket.remoteAddress ?? 'unknown';
}

function prune(now: number): void {
  for (const [key, record] of attempts) {
    if (now - record.firstFailureAt > WINDOW_MS) attempts.delete(key);
  }
  if (attempts.size <= MAX_TRACKED) return;
  // Oldest first; Map preserves insertion order.
  const excess = attempts.size - MAX_TRACKED;
  let removed = 0;
  for (const key of attempts.keys()) {
    attempts.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

export function currentAuthDelayMs(key: string, now = Date.now()): number {
  const record = attempts.get(key);
  if (!record) return 0;
  if (now - record.firstFailureAt > WINDOW_MS) return 0;
  const over = record.failures - FREE_ATTEMPTS;
  if (over <= 0) return 0;
  return Math.min(over * STEP_MS, MAX_DELAY_MS);
}

export function recordAuthFailure(key: string, now = Date.now()): void {
  const record = attempts.get(key);
  if (!record || now - record.firstFailureAt > WINDOW_MS) {
    attempts.set(key, { failures: 1, firstFailureAt: now });
  } else {
    record.failures += 1;
  }
  prune(now);
}

export function clearAuthFailures(key: string): void {
  attempts.delete(key);
}

export function resetAuthThrottleForTests(): void {
  attempts.clear();
}

export function createAuthAttemptThrottle(
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
) {
  return async function authAttemptThrottle(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const delay = currentAuthDelayMs(keyFor(req));
    if (delay > 0) await sleep(delay);
    next();
  };
}

export const authAttemptThrottleKey = keyFor;

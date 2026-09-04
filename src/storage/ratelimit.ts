import type { Redis } from "ioredis";

/**
 * Fixed-window per-user rate limiting.
 *
 * The window is the hour bucket the request falls in, so the counter for a
 * given user and scope resets on the hour rather than sliding continuously.
 * That is simpler than a sliding log and cheap: one INCR plus, on the first
 * hit in a window, one PEXPIRE.
 */
const WINDOW_MS = 60 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  limit: number;
  /** Epoch ms when the current window ends and the counter resets. */
  resetAt: number;
}

const key = (scope: string, userId: string, window: number) =>
  `rl:${scope}:${userId}:${window}`;

/**
 * A limit of 0 or less disables the check entirely, which is how an operator
 * turns a given guard off without special-casing "unset" elsewhere.
 */
export async function checkRateLimit(
  redis: Redis,
  scope: string,
  userId: string,
  limit: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const window = Math.floor(now / WINDOW_MS);
  const resetAt = (window + 1) * WINDOW_MS;

  if (limit <= 0) return { allowed: true, remaining: Infinity, limit, resetAt };

  const count = await redis.incr(key(scope, userId, window));
  if (count === 1) {
    await redis.pexpire(key(scope, userId, window), WINDOW_MS);
  }

  if (count > limit) return { allowed: false, remaining: 0, limit, resetAt };
  return { allowed: true, remaining: limit - count, limit, resetAt };
}

/** Minutes until `resetAt`, rounded up, for a friendly "try again in" message. */
export function minutesUntil(resetAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((resetAt - now) / 60_000));
}

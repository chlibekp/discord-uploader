import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import type { AuthUser } from "./types.js";

export const AUTH_SESSION_TTL_SECONDS = 30 * 86_400;
/** Only rewrite the expiry once a day has been used, so reads stay read-only. */
export const REFRESH_BELOW_SECONDS = 29 * 86_400;

/**
 * Sessions are keyed by a digest of the cookie value, so a Redis dump or a
 * `KEYS auth:*` never yields a usable cookie.
 */
export function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const key = (d: string) => `auth:${d}`;
const userKey = (userId: string) => `auth:user:${userId}`;

export async function createAuthSession(
  redis: Redis,
  user: AuthUser,
  now = Date.now(),
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const d = digest(token);
  await redis
    .multi()
    .hset(key(d), {
      userId: user.id,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      createdAt: String(now),
    })
    .expire(key(d), AUTH_SESSION_TTL_SECONDS)
    .sadd(userKey(user.id), d)
    .expire(userKey(user.id), AUTH_SESSION_TTL_SECONDS)
    .exec();
  return token;
}

export async function readAuthSession(
  redis: Redis,
  token: string,
): Promise<{ user: AuthUser; refreshed: boolean } | null> {
  if (!token) return null;
  const d = digest(token);
  // HGETALL + TTL in one round trip: hgetall returns {} for a missing key,
  // so there is no separate existence check to get wrong.
  const results = await redis.pipeline().hgetall(key(d)).ttl(key(d)).exec();
  const raw = (results?.[0]?.[1] ?? {}) as Record<string, string>;
  const ttl = (results?.[1]?.[1] ?? -2) as number;
  const userId = raw.userId;
  if (!userId) return null;

  const user: AuthUser = {
    id: userId,
    username: raw.username ?? "",
    globalName: raw.globalName ?? "",
    avatar: raw.avatar ?? "",
  };

  if (ttl >= 0 && ttl < REFRESH_BELOW_SECONDS) {
    await redis
      .multi()
      .expire(key(d), AUTH_SESSION_TTL_SECONDS)
      .expire(userKey(user.id), AUTH_SESSION_TTL_SECONDS)
      .exec();
    return { user, refreshed: true };
  }
  return { user, refreshed: false };
}

export async function deleteAuthSession(
  redis: Redis,
  token: string,
): Promise<void> {
  if (!token) return;
  const d = digest(token);
  const userId = await redis.hget(key(d), "userId");
  const tx = redis.multi().del(key(d));
  if (userId) tx.srem(userKey(userId), d);
  await tx.exec();
}

/**
 * "Sign out everywhere". Returns how many live sessions were ended.
 *
 * Reads the member digests first, then deletes exactly those session keys
 * and SREMs exactly those digests. A login that finishes between the read
 * and the SREM adds its own digest to the set concurrently; targeting only
 * the digests seen in the snapshot (rather than DEL-ing the whole set)
 * leaves that new session tracked instead of silently dropping it.
 */
export async function deleteAllAuthSessions(
  redis: Redis,
  userId: string,
): Promise<number> {
  const digests = await redis.smembers(userKey(userId));
  if (digests.length === 0) return 0;
  const keys = digests.map(key);
  const results = await redis
    .multi()
    .del(...keys)
    .srem(userKey(userId), ...digests)
    .exec();
  return (results?.[0]?.[1] as number) ?? 0;
}

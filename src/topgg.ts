import { createHmac, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";

const API_BASE = "https://top.gg/api/v1";

/** Present while a user's vote is live; expires with the vote itself. */
export const VOTE_KEY = (userId: string) => `vote:${userId}`;

/**
 * Discord gives an interaction 3 seconds. The vote check runs inside that
 * budget, so a slow Top.gg must not be allowed to eat all of it.
 */
const CHECK_TIMEOUT_MS = 1500;

export function voteUrl(config: Config): string {
  return `https://top.gg/bot/${config.discordAppId}/vote`;
}

/** Cache a vote until Top.gg says it expires. A vote already past expiry is ignored. */
export async function rememberVote(
  redis: Redis,
  userId: string,
  expiresAt: string,
  now = Date.now(),
): Promise<boolean> {
  const ttl = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  await redis.set(VOTE_KEY(userId), "1", "PX", ttl);
  return true;
}

/**
 * Whether the user has a live vote. The webhook usually caches the vote the
 * moment it is cast; the API lookup covers votes the webhook missed.
 *
 * If Top.gg cannot be reached the user is let through: an outage on their side
 * should not take /upload down with it.
 */
export async function hasVoted(
  redis: Redis,
  config: Config,
  userId: string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  if (await redis.exists(VOTE_KEY(userId))) return true;

  let res: Response;
  try {
    res = await fetchFn(
      `${API_BASE}/projects/@me/votes/${encodeURIComponent(userId)}?source=discord`,
      {
        headers: { Authorization: `Bearer ${config.topggToken}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.error("Top.gg vote check failed:", (err as Error).message);
    return true;
  }

  if (res.status === 404) return false;
  if (!res.ok) {
    console.error(`Top.gg vote check responded ${res.status}`);
    return true;
  }

  try {
    const vote = (await res.json()) as { expires_at?: string };
    return await rememberVote(redis, userId, vote.expires_at ?? "");
  } catch (err) {
    console.error("Top.gg vote check returned bad data:", err);
    return true;
  }
}

/**
 * Check a v1 webhook's `x-topgg-signature` header (`t=<unix>,v1=<hex>`), an
 * HMAC-SHA256 of `${t}.${rawBody}` keyed with the webhook secret.
 *
 * There is no freshness window on `t`: a replayed vote can only re-cache that
 * vote until its own `expires_at`, which grants nothing it did not already.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const parts = new Map(
    header.split(",").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    }),
  );
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

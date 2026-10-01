import type { Redis } from "ioredis";
import { ACTIVE_USERS_KEY, utcDay } from "./storage/usage.js";

const TRACK_URL = "https://api.stats.hegy.xyz/track";
const TRACK_PROJECT = "imageuploader";
const TRACK_API_KEY = "BGvgn3xX1SXeJl6SGSRgUkKzfZ";

/** Set once a UTC day's count has been sent, so restarts do not resend it. */
export const PUSHED_DAY_KEY = (day: string) => `stats:pushed:${day}`;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sends the all-time user count to the external stats tracker at most once per
 * UTC day. The day is claimed before sending and released on failure, so the
 * next hourly check retries instead of skipping the day.
 */
export async function pushDailyUserCount(
  redis: Redis,
  fetchFn: typeof fetch,
  now = Date.now(),
): Promise<boolean> {
  const key = PUSHED_DAY_KEY(utcDay(now));
  const claimed = await redis.set(key, "1", "EX", 2 * 86_400, "NX");
  if (claimed !== "OK") return false;
  try {
    const users = await redis.scard(ACTIVE_USERS_KEY);
    const res = await fetchFn(TRACK_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TRACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: TRACK_PROJECT, users }),
    });
    if (!res.ok) throw new Error(`stats tracker responded ${res.status}`);
    console.log(`Pushed daily user count: ${users}`);
    return true;
  } catch (err) {
    await redis.del(key).catch(() => {});
    console.error("Daily user count push failed:", (err as Error).message);
    return false;
  }
}

/** Checks on boot and then hourly; the Redis claim keeps it to one push a day. */
export function startDailyUserCountPush(
  redis: Redis,
  fetchFn: typeof fetch,
): NodeJS.Timeout {
  void pushDailyUserCount(redis, fetchFn);
  const timer = setInterval(
    () => void pushDailyUserCount(redis, fetchFn),
    CHECK_INTERVAL_MS,
  );
  timer.unref();
  return timer;
}

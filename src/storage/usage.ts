import type { Redis } from "ioredis";
import { unwrapResult } from "./redis-result.js";
import { LRU_KEY, getRecord } from "./store.js";

/** Lifetime count of slash commands the bot has executed. */
export const COMMAND_TOTAL_KEY = "stats:commands:total";
/** Per-command counters, so the breakdown needs no extra keys. */
export const COMMAND_BY_NAME_KEY = "stats:commands:by-name";
/**
 * Every user id that has ever run a command. A set rather than a counter so a
 * returning user is not double-counted; SCARD then gives an exact figure.
 */
export const ACTIVE_USERS_KEY = "stats:users";

/** One hash per user per UTC day: uploads, bytes, and cmd:{name} counters. */
export const USER_DAY_KEY = (userId: string, day: string) =>
  `usage:${userId}:d:${day}`;
/** All-time per-command counts for one user. */
export const USER_CMDS_KEY = (userId: string) => `usage:${userId}:cmds`;
export const USAGE_SINCE_KEY = "usage:since";
export const USAGE_SEEDED_KEY = "usage:seeded:v1";
/** Longer than the widest range (90 days) so a range read never finds a hole. */
export const DAY_TTL_SECONDS = 100 * 86_400;
const DAY_MS = 86_400_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface UsageStats {
  /** Total command executions across every user. */
  commands: number;
  /** Users who have run at least one command. */
  activeUsers: number;
  /** Executions per command name, highest first. */
  byCommand: Record<string, number>;
}

/**
 * Counted once per accepted command, before the command does its work, so the
 * figure covers commands that later fail on their own terms.
 */
export async function recordCommandUse(
  redis: Redis,
  command: string,
  userId?: string,
  now = Date.now(),
): Promise<void> {
  const tx = redis
    .multi()
    .incr(COMMAND_TOTAL_KEY)
    .hincrby(COMMAND_BY_NAME_KEY, command, 1);
  if (userId) {
    const day = USER_DAY_KEY(userId, utcDay(now));
    tx.sadd(ACTIVE_USERS_KEY, userId)
      .hincrby(day, `cmd:${command}`, 1)
      .expire(day, DAY_TTL_SECONDS)
      .hincrby(USER_CMDS_KEY(userId), command, 1);
  }
  await tx.exec();
}

export async function getUsageStats(redis: Redis): Promise<UsageStats> {
  const [total, activeUsers, byName] = await Promise.all([
    redis.get(COMMAND_TOTAL_KEY),
    redis.scard(ACTIVE_USERS_KEY),
    redis.hgetall(COMMAND_BY_NAME_KEY),
  ]);

  const byCommand: Record<string, number> = {};
  for (const [name, count] of Object.entries(byName ?? {}).sort(
    (a, b) => Number(b[1]) - Number(a[1]),
  )) {
    byCommand[name] = Number(count) || 0;
  }

  return {
    commands: Number(total) || 0,
    activeUsers: activeUsers || 0,
    byCommand,
  };
}

export async function recordUpload(
  redis: Redis,
  userId: string,
  bytes: number,
  now = Date.now(),
): Promise<void> {
  const day = USER_DAY_KEY(userId, utcDay(now));
  await redis
    .multi()
    .hincrby(day, "uploads", 1)
    .hincrby(day, "bytes", bytes)
    .expire(day, DAY_TTL_SECONDS)
    .exec();
}

export async function markUsageSince(
  redis: Redis,
  now = Date.now(),
): Promise<void> {
  await redis.setnx(USAGE_SINCE_KEY, String(now));
}

/**
 * One-time backfill of uploads/bytes from the files still stored, so the
 * activity chart is not empty on the day this ships. Command history cannot be
 * recovered and is not attempted.
 */
export async function seedUsageFromFiles(
  redis: Redis,
  now = Date.now(),
): Promise<number | null> {
  const won = await redis.set(USAGE_SEEDED_KEY, "1", "NX");
  if (won !== "OK") return null;
  let seeded = 0;
  for (const id of await redis.zrange(LRU_KEY, 0, -1)) {
    const record = await getRecord(redis, id);
    if (!record?.userId || now - record.createdAt > DAY_TTL_SECONDS * 1000)
      continue;
    await recordUpload(redis, record.userId, record.size, record.createdAt);
    seeded += 1;
  }
  return seeded;
}

export interface DailyPoint {
  date: string;
  uploads: number;
  bytes: number;
}

export interface UserUsage {
  series: DailyPoint[];
  previous: { uploads: number; bytes: number };
  commandsInRange: Record<string, number>;
  commandsAllTime: Record<string, number>;
  trackingSince: number;
}

const byCountDesc = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

/**
 * Reads `days` of history plus the equal-length period before it (for the
 * previous-period comparison), the user's all-time command counts, and when
 * tracking began — all in one pipeline. Every queued command's result is
 * unwrapped explicitly: ioredis resolves a pipeline `exec()` with a per-command
 * `[err, result]` tuple rather than rejecting on a broken connection, so
 * treating a missing/errored entry as "no data" would silently report zero
 * usage instead of surfacing the failure.
 */
export async function getUserUsage(
  redis: Redis,
  userId: string,
  days: number,
  now = Date.now(),
): Promise<UserUsage> {
  // Oldest first: [today - (2*days - 1) … today]. The first half is the previous period.
  const dates = Array.from({ length: days * 2 }, (_, i) =>
    utcDay(now - (days * 2 - 1 - i) * DAY_MS),
  );
  const pipe = redis.pipeline();
  for (const d of dates) pipe.hgetall(USER_DAY_KEY(userId, d));
  pipe.hgetall(USER_CMDS_KEY(userId));
  pipe.get(USAGE_SINCE_KEY);
  const results = await pipe.exec();
  if (!results) throw new Error("Redis pipeline returned no results");

  const rows = dates.map((date, i) => ({
    date,
    raw: unwrapResult<Record<string, string>>(results[i]),
  }));
  const previous = { uploads: 0, bytes: 0 };
  const series: DailyPoint[] = [];
  const commandsInRange: Record<string, number> = {};

  rows.forEach(({ date, raw }, i) => {
    const point = {
      date,
      uploads: Number(raw.uploads ?? 0),
      bytes: Number(raw.bytes ?? 0),
    };
    if (i < days) {
      previous.uploads += point.uploads;
      previous.bytes += point.bytes;
      return;
    }
    series.push(point);
    for (const [field, value] of Object.entries(raw)) {
      if (!field.startsWith("cmd:")) continue;
      const name = field.slice(4);
      commandsInRange[name] = (commandsInRange[name] ?? 0) + Number(value);
    }
  });

  const allTimeRaw = unwrapResult<Record<string, string>>(
    results[dates.length],
  );
  const commandsAllTime = Object.fromEntries(
    Object.entries(allTimeRaw).map(([k, v]) => [k, Number(v)]),
  );
  const since = Number(
    unwrapResult<string | null>(results[dates.length + 1]) ?? 0,
  );

  return {
    series,
    previous,
    commandsInRange: byCountDesc(commandsInRange),
    commandsAllTime: byCountDesc(commandsAllTime),
    trackingSince: since || now,
  };
}

import type { Redis } from "ioredis";

/** Lifetime count of slash commands the bot has executed. */
export const COMMAND_TOTAL_KEY = "stats:commands:total";
/** Per-command counters, so the breakdown needs no extra keys. */
export const COMMAND_BY_NAME_KEY = "stats:commands:by-name";
/**
 * Every user id that has ever run a command. A set rather than a counter so a
 * returning user is not double-counted; SCARD then gives an exact figure.
 */
export const ACTIVE_USERS_KEY = "stats:users";

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
): Promise<void> {
  const tx = redis
    .multi()
    .incr(COMMAND_TOTAL_KEY)
    .hincrby(COMMAND_BY_NAME_KEY, command, 1);
  if (userId) tx.sadd(ACTIVE_USERS_KEY, userId);
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

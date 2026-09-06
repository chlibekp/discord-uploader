import type { Redis } from "ioredis";
import {
  LRU_KEY,
  USER_BYTES_KEY,
  USER_KEY,
  getRecord,
  totalBytes,
} from "./store.js";
import { ACTIVE_USERS_KEY } from "./usage.js";
import type { FileRecord } from "../types.js";

/** One row of the admin user list. */
export interface AdminUser {
  userId: string;
  /** Live files this user currently has stored. */
  files: number;
  /** Bytes those files occupy. */
  bytes: number;
  /** Timestamp of the newest upload, or 0 when the user has never uploaded. */
  lastUpload: number;
}

/** How many of the most recent uploads the storage panel inspects. */
const RECENT_FILE_SAMPLE = 500;

/**
 * Every user id the bot knows about.
 *
 * The usage set only holds people who have run a command since usage tracking
 * shipped, so the per-user file indexes are scanned as well and the two are
 * merged. SCAN rather than KEYS: this runs against the live instance on an
 * admin's whim, and KEYS blocks the server for the whole sweep.
 */
export async function listKnownUserIds(redis: Redis): Promise<string[]> {
  const ids = new Set(await redis.smembers(ACTIVE_USERS_KEY));

  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      "user:*:files",
      "COUNT",
      100,
    );
    cursor = next;
    for (const key of keys) {
      const userId = key.slice("user:".length, -":files".length);
      if (userId) ids.add(userId);
    }
  } while (cursor !== "0");

  return [...ids];
}

/** Per-user storage rows, largest consumer first. */
export async function listAdminUsers(redis: Redis): Promise<AdminUser[]> {
  const ids = await listKnownUserIds(redis);

  const rows = await Promise.all(
    ids.map(async (userId): Promise<AdminUser> => {
      const [files, bytes, newest] = await Promise.all([
        redis.zcard(USER_KEY(userId)),
        redis.get(USER_BYTES_KEY(userId)),
        redis.zrevrange(USER_KEY(userId), 0, 0, "WITHSCORES"),
      ]);
      return {
        userId,
        files: files || 0,
        bytes: Number(bytes ?? 0) || 0,
        lastUpload: Number(newest?.[1] ?? 0) || 0,
      };
    }),
  );

  return rows.sort((a, b) => b.bytes - a.bytes || b.lastUpload - a.lastUpload);
}

export interface AdminStorage {
  /** Bytes across every user, from the running total counter. */
  totalBytes: number;
  /** Live files tracked in the LRU index. */
  totalFiles: number;
  /** Users holding at least one file. */
  usersWithFiles: number;
  /** The biggest files among the most recent `RECENT_FILE_SAMPLE` uploads. */
  largestFiles: FileRecord[];
  /** The heaviest users, largest first. */
  topUsers: AdminUser[];
}

export async function collectAdminStorage(
  redis: Redis,
  users: AdminUser[],
): Promise<AdminStorage> {
  const [total, totalFiles, recentIds] = await Promise.all([
    totalBytes(redis),
    redis.zcard(LRU_KEY),
    redis.zrevrange(LRU_KEY, 0, RECENT_FILE_SAMPLE - 1),
  ]);

  const records = (
    await Promise.all(recentIds.map((id) => getRecord(redis, id)))
  ).filter((r): r is FileRecord => r !== null);

  return {
    totalBytes: total,
    totalFiles,
    usersWithFiles: users.filter((u) => u.files > 0).length,
    largestFiles: records.sort((a, b) => b.size - a.size).slice(0, 5),
    topUsers: users.filter((u) => u.bytes > 0).slice(0, 5),
  };
}

import type { Redis } from "ioredis";
import { rm, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { FileRecord } from "../types.js";

export const FILE_KEY = (id: string) => `file:${id}`;
export const LRU_KEY = "files:lru";
/** Per-user index, so /gallery can list one person's uploads without a scan. */
export const USER_KEY = (userId: string) => `user:${userId}:files`;
export const TOTAL_KEY = "total:bytes";

/**
 * One directory per file. Eviction then deletes a directory whose name is a
 * generated id, so no user-controlled string ever reaches a filesystem call.
 */
export function fileDir(config: Config, id: string): string {
  return path.join(config.dataDir, id);
}

export function filePath(config: Config, record: Pick<FileRecord, "id" | "name">): string {
  return path.join(fileDir(config, record.id), record.name);
}

export async function ensureDataDir(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
}

/**
 * Fail at boot rather than on the first upload.
 *
 * A mounted volume arrives owned by root, so a container running as another user
 * can read the directory but not write to it. mkdir on an existing directory
 * succeeds regardless, which would otherwise hide the problem until a user
 * already had an upload link in hand.
 */
export async function verifyDataDirWritable(config: Config): Promise<void> {
  const probe = path.join(config.dataDir, ".write-probe");
  try {
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  } catch (err) {
    throw new Error(
      `Data directory ${config.dataDir} is not writable: ${(err as Error).message}`,
    );
  }
}

export async function saveRecord(redis: Redis, record: FileRecord): Promise<void> {
  await redis
    .multi()
    .hset(FILE_KEY(record.id), {
      name: record.name,
      mime: record.mime,
      kind: record.kind,
      size: String(record.size),
      width: String(record.width),
      height: String(record.height),
      createdAt: String(record.createdAt),
      userId: record.userId,
      channelId: record.channelId,
    })
    .zadd(LRU_KEY, record.createdAt, record.id)
    .zadd(USER_KEY(record.userId), record.createdAt, record.id)
    .incrby(TOTAL_KEY, record.size)
    .exec();
}

export async function getRecord(redis: Redis, id: string): Promise<FileRecord | null> {
  const raw = await redis.hgetall(FILE_KEY(id));
  if (!raw || !raw.name || !raw.mime) return null;
  return {
    id,
    name: raw.name,
    mime: raw.mime,
    kind: raw.kind === "video" ? "video" : "image",
    size: Number(raw.size ?? 0),
    width: Number(raw.width ?? 0),
    height: Number(raw.height ?? 0),
    createdAt: Number(raw.createdAt ?? 0),
    userId: raw.userId ?? "",
    channelId: raw.channelId ?? "",
  };
}

/** Best-effort LRU bump. A Redis hiccup must never break file delivery. */
export function touchRecord(redis: Redis, id: string): void {
  redis.zadd(LRU_KEY, Date.now(), id).catch((err: unknown) => {
    console.error(`Failed to update LRU score for ${id}:`, err);
  });
}

export async function deleteRecord(redis: Redis, config: Config, id: string): Promise<void> {
  const record = await getRecord(redis, id);
  await rm(fileDir(config, id), { recursive: true, force: true });

  const tx = redis.multi().del(FILE_KEY(id)).zrem(LRU_KEY, id);
  // Without the record we cannot know which user index holds this id; the boot
  // reconciliation rebuilds those from scratch and clears any leftovers.
  if (record) tx.zrem(USER_KEY(record.userId), id);
  await tx.incrby(TOTAL_KEY, record ? -record.size : 0).exec();
}

/**
 * Most recent uploads by one user, newest first.
 *
 * Capped rather than paged: a gallery link lives for minutes, and a few hundred
 * tiles is already more than anyone scrolls.
 */
export async function listUserFiles(
  redis: Redis,
  userId: string,
  limit = 200,
): Promise<FileRecord[]> {
  const ids = await redis.zrevrange(USER_KEY(userId), 0, limit - 1);
  const records = await Promise.all(ids.map((id) => getRecord(redis, id)));
  return records.filter((record): record is FileRecord => record !== null);
}

export async function totalBytes(redis: Redis): Promise<number> {
  const raw = await redis.get(TOTAL_KEY);
  return Number(raw ?? 0);
}

/** Directory names present on disk, used by boot reconciliation. */
export async function listStoredIds(config: Config): Promise<string[]> {
  try {
    const entries = await readdir(config.dataDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function dirSize(config: Config, id: string): Promise<number> {
  try {
    const entries = await readdir(fileDir(config, id));
    let total = 0;
    for (const entry of entries) {
      total += (await stat(path.join(fileDir(config, id), entry))).size;
    }
    return total;
  } catch {
    return 0;
  }
}

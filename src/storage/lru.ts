import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import {
  LRU_KEY,
  TOTAL_KEY,
  USER_KEY,
  deleteRecord,
  dirSize,
  getRecord,
  listStoredIds,
  totalBytes,
} from "./store.js";

/**
 * A file younger than this is never evicted. Without the guard, an upload larger
 * than the remaining headroom would immediately delete itself, and the user
 * would get a link that 404s.
 */
export const PROTECT_WINDOW_MS = 60_000;

/**
 * Delete least-recently-accessed files until total usage fits the cap.
 *
 * Runs after each successful upload. Returns the ids removed.
 */
export async function sweep(redis: Redis, config: Config, now = Date.now()): Promise<string[]> {
  const evicted: string[] = [];

  while ((await totalBytes(redis)) > config.maxTotalBytes) {
    const [oldest] = await redis.zrange(LRU_KEY, 0, 0);
    if (!oldest) {
      console.error("Over the storage cap but no evictable files remain");
      break;
    }

    const record = await getRecord(redis, oldest);
    if (record && now - record.createdAt < PROTECT_WINDOW_MS) {
      console.warn(`Over the storage cap; oldest file ${oldest} is too new to evict`);
      break;
    }

    await deleteRecord(redis, config, oldest);
    evicted.push(oldest);
    console.log(`Evicted ${oldest} to stay under the storage cap`);
  }

  return evicted;
}

/**
 * Bring Redis and the volume back into agreement at boot.
 *
 * Either side can be left stale by a crash mid-upload or a redeploy, and the
 * byte counter is only trustworthy if it is recomputed from what actually
 * exists.
 */
export async function reconcile(redis: Redis, config: Config): Promise<void> {
  const onDisk = new Set(await listStoredIds(config));
  const known = await redis.zrange(LRU_KEY, 0, -1);

  for (const id of known) {
    if (!onDisk.has(id)) {
      console.warn(`Dropping record ${id}: no directory on disk`);
      await deleteRecord(redis, config, id);
    }
  }

  let total = 0;
  const stillKnown = new Set(await redis.zrange(LRU_KEY, 0, -1));

  for (const id of onDisk) {
    if (!stillKnown.has(id)) {
      console.warn(`Removing orphan directory ${id}: no record in Redis`);
      await deleteRecord(redis, config, id);
      continue;
    }
    total += await dirSize(config, id);
  }

  await redis.set(TOTAL_KEY, String(total));
  await rebuildUserIndex(redis, [...stillKnown]);
  console.log(`Reconciled storage: ${stillKnown.size} files, ${total} bytes`);
}

/**
 * Rebuild the per-user indexes from the surviving file records.
 *
 * They are derived data, so recomputing costs little and covers both files
 * stored before the index existed and entries left behind by a delete that ran
 * without a record to read the owner from.
 */
async function rebuildUserIndex(redis: Redis, ids: string[]): Promise<void> {
  const stale = await redis.keys(USER_KEY("*"));
  if (stale.length > 0) await redis.del(...stale);

  let indexed = 0;
  for (const id of ids) {
    const record = await getRecord(redis, id);
    if (!record?.userId) continue;
    await redis.zadd(USER_KEY(record.userId), record.createdAt, id);
    indexed += 1;
  }
  console.log(`Rebuilt per-user index for ${indexed} files`);
}

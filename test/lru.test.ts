import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { PROTECT_WINDOW_MS, reconcile, sweep } from "../src/storage/lru.js";
import { LRU_KEY, TOTAL_KEY, USER_KEY, fileDir, saveRecord, totalBytes } from "../src/storage/store.js";
import { rmSync } from "node:fs";
import { testConfig } from "./helpers.js";
import type { Config } from "../src/config.js";
import type { FileRecord } from "../src/types.js";

let config: Config;
let redis: Redis;

beforeEach(async () => {
  config = testConfig({ maxTotalBytes: 1000 });
  redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares its keyspace between instances.
  await redis.flushall();
});

afterEach(() => {
  rmSync(config.dataDir, { recursive: true, force: true });
});

async function addFile(id: string, size: number, createdAt: number): Promise<FileRecord> {
  const record: FileRecord = {
    id,
    name: `${id}.png`,
    mime: "image/png",
    kind: "image",
    size,
    width: 10,
    height: 10,
    createdAt,
    userId: "u1",
    channelId: "c1",
  };
  await mkdir(fileDir(config, id), { recursive: true });
  await writeFile(path.join(fileDir(config, id), record.name), Buffer.alloc(size));
  await saveRecord(redis, record);
  await redis.zadd(LRU_KEY, createdAt, id);
  return record;
}

describe("sweep", () => {
  const old = Date.now() - 10 * PROTECT_WINDOW_MS;

  it("does nothing while under the cap", async () => {
    await addFile("a", 400, old);
    expect(await sweep(redis, config)).toEqual([]);
    expect(existsSync(fileDir(config, "a"))).toBe(true);
  });

  it("evicts the least recently accessed file first", async () => {
    await addFile("a", 400, old);
    await addFile("b", 400, old + 1000);
    await addFile("c", 400, old + 2000);

    // "b" is touched, so "a" becomes the least recently used.
    await redis.zadd(LRU_KEY, Date.now(), "b");

    expect(await sweep(redis, config)).toEqual(["a"]);
    expect(existsSync(fileDir(config, "a"))).toBe(false);
    expect(existsSync(fileDir(config, "b"))).toBe(true);
    expect(await totalBytes(redis)).toBe(800);
  });

  it("keeps evicting until under the cap", async () => {
    await addFile("a", 400, old);
    await addFile("b", 400, old + 1);
    await addFile("c", 400, old + 2);
    await addFile("d", 400, old + 3);

    expect(await sweep(redis, config)).toEqual(["a", "b"]);
    expect(await totalBytes(redis)).toBe(800);
  });

  it("never evicts a file inside the protection window", async () => {
    // Without the guard, a fresh upload larger than the cap would delete itself
    // and hand the user a link that immediately 404s.
    await addFile("fresh", 2000, Date.now());
    expect(await sweep(redis, config)).toEqual([]);
    expect(existsSync(fileDir(config, "fresh"))).toBe(true);
  });

  it("stops when nothing is left to evict", async () => {
    await redis.set(TOTAL_KEY, "5000");
    expect(await sweep(redis, config)).toEqual([]);
  });

  it("removes both the Redis record and the directory", async () => {
    await addFile("a", 1200, old);
    await sweep(redis, config);
    expect(await redis.hgetall("file:a")).toEqual({});
    expect(await redis.zrange(LRU_KEY, 0, -1)).toEqual([]);
    expect(existsSync(fileDir(config, "a"))).toBe(false);
  });
});

describe("reconcile", () => {
  it("recomputes the byte counter from disk", async () => {
    await addFile("a", 300, Date.now());
    await redis.set(TOTAL_KEY, "999999");
    await reconcile(redis, config);
    expect(await totalBytes(redis)).toBe(300);
  });

  it("drops records whose directory is gone", async () => {
    await addFile("a", 300, Date.now());
    rmSync(fileDir(config, "a"), { recursive: true, force: true });
    await reconcile(redis, config);
    expect(await redis.zrange(LRU_KEY, 0, -1)).toEqual([]);
    expect(await totalBytes(redis)).toBe(0);
  });

  it("rebuilds the per-user index, so files stored before it existed are listed", async () => {
    await addFile("a", 100, Date.now());
    await redis.del(USER_KEY("u1"));

    await reconcile(redis, config);

    expect(await redis.zrange(USER_KEY("u1"), 0, -1)).toEqual(["a"]);
  });

  it("clears index entries for files that no longer exist", async () => {
    await addFile("a", 100, Date.now());
    await redis.zadd(USER_KEY("u1"), Date.now(), "ghost");

    await reconcile(redis, config);

    expect(await redis.zrange(USER_KEY("u1"), 0, -1)).toEqual(["a"]);
  });

  it("removes orphan directories with no record", async () => {
    await mkdir(fileDir(config, "orphan"), { recursive: true });
    await writeFile(path.join(fileDir(config, "orphan"), "x.png"), Buffer.alloc(50));
    await reconcile(redis, config);
    expect(existsSync(fileDir(config, "orphan"))).toBe(false);
    expect(await totalBytes(redis)).toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { reconcile } from "../src/storage/lru.js";
import { fileDir, saveRecord } from "../src/storage/store.js";

let h: Harness;
afterEach(() => h?.cleanup());

function orphan(id: string): string {
  const dir = fileDir(h.deps.config, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "x.png"), "x");
  return dir;
}

describe("reconcile guard", () => {
  it("keeps every directory when Redis holds no file records at all", async () => {
    h = await makeHarness();
    const a = orphan("orphanaaaaaaaaaaaaaaaa");
    const b = orphan("orphanbbbbbbbbbbbbbbbb");

    await reconcile(h.deps.redis, h.deps.config);

    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("still removes an orphan when other records exist", async () => {
    h = await makeHarness();
    const kept = orphan("keptkeptkeptkeptkeptkk");
    await saveRecord(h.deps.redis, {
      id: "keptkeptkeptkeptkeptkk",
      name: "x.png",
      mime: "image/png",
      kind: "image",
      size: 1,
      width: 1,
      height: 1,
      createdAt: Date.now(),
      expiresAt: 0,
      userId: "u1",
      channelId: "c1",
    });
    const stray = orphan("straystraystraystrayss");

    await reconcile(h.deps.redis, h.deps.config);

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(stray)).toBe(false);
  });
});

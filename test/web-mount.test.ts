import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { fileDir, saveRecord } from "../src/storage/store.js";

let h: Harness;
afterEach(() => h?.cleanup());

describe("Astro page responses", () => {
  it("declare UTF-8 on HTML so non-ASCII names survive scraping", async () => {
    h = await makeHarness();
    const id = "videovideovideovideovi";
    const name = "café-clip.mp4";
    const dir = fileDir(h.deps.config, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), "x");
    await saveRecord(h.deps.redis, {
      id,
      name,
      mime: "video/mp4",
      kind: "video",
      size: 1,
      width: 1280,
      height: 720,
      createdAt: Date.now(),
      expiresAt: 0,
      userId: "user-42",
      channelId: "channel-99",
    });

    const res = await h.app.fetch(new Request(`https://uploader.test/v/${id}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await res.text()).toContain("<title>café-clip.mp4</title>");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHarness, type Harness } from "./helpers.js";
import { createSession } from "../src/storage/sessions.js";
import { fileDir, saveRecord } from "../src/storage/store.js";
import type { FileRecord } from "../src/types.js";

let h: Harness;
afterEach(() => h?.cleanup());

const EVIL = `a"><img src=x onerror=alert(1)>.png`;

async function seed(record: Partial<FileRecord>): Promise<FileRecord> {
  const full: FileRecord = {
    id: "evilevilevilevilevilev",
    name: EVIL,
    mime: "image/png",
    kind: "image",
    size: 3,
    width: 1,
    height: 1,
    createdAt: Date.UTC(2026, 0, 1),
    expiresAt: 0,
    userId: "u1",
    channelId: "c1",
    ...record,
  };
  // path.join treats a literal "/" inside a hostile filename (e.g. "</script>")
  // as a path separator, so the parent directory of the *full* path — not
  // just fileDir(id) — must exist before the write.
  const target = path.join(fileDir(h.deps.config, full.id), full.name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "abc");
  await saveRecord(h.deps.redis, full);
  return full;
}

describe("page escaping", () => {
  it("escapes a hostile filename on the gallery page", async () => {
    h = await makeHarness();
    await seed({});
    const s = await createSession(h.deps.redis, {
      kind: "gallery",
      userId: "u1",
      channelId: "c1",
      guildId: "",
      interactionToken: "t",
      ttlMs: 0,
    });
    const res = await h.app.fetch(
      new Request(`https://uploader.test/g/${s.sid}`),
    );
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a hostile filename on the watch page", async () => {
    h = await makeHarness();
    await seed({
      kind: "video",
      mime: "video/mp4",
      name: `v"><script>x</script>.mp4`,
    });
    const res = await h.app.fetch(
      new Request("https://uploader.test/v/evilevilevilevilevilev"),
    );
    const html = await res.text();
    expect(html).not.toContain("<script>x</script>");
  });
});

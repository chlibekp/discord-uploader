import { describe, expect, it } from "vitest";
import { makeHarness } from "./helpers.js";
import { recordCommandUse } from "../src/storage/usage.js";
import { saveRecord } from "../src/storage/store.js";
import type { FileRecord } from "../src/types.js";

function record(id: string, size: number): FileRecord {
  return {
    id,
    name: `${id}.png`,
    mime: "image/png",
    kind: "image",
    size,
    width: 1,
    height: 1,
    createdAt: Date.now(),
    expiresAt: 0,
    userId: "user-1",
    channelId: "channel-1",
  };
}

describe("GET /metrics", () => {
  it("exposes usage, storage and process metrics in exposition format", async () => {
    const h = await makeHarness();
    try {
      await recordCommandUse(h.deps.redis, "upload", "user-1");
      await recordCommandUse(h.deps.redis, "upload", "user-2");
      await recordCommandUse(h.deps.redis, "gallery", "user-1");
      await saveRecord(h.deps.redis, record("file-1", 1000));
      await saveRecord(h.deps.redis, record("file-2", 2000));

      const res = await h.app.fetch(
        new Request("https://uploader.test/metrics"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");

      const body = await res.text();
      expect(body).toContain("# TYPE discord_uploader_commands_total counter");
      expect(body).toContain("discord_uploader_commands_total 3");
      expect(body).toContain(
        'discord_uploader_command_invocations_total{command="upload"} 2',
      );
      expect(body).toContain(
        'discord_uploader_command_invocations_total{command="gallery"} 1',
      );
      expect(body).toContain("discord_uploader_active_users 2");
      expect(body).toContain("discord_uploader_stored_bytes 3000");
      expect(body).toContain("discord_uploader_stored_files 2");
      expect(body).toMatch(
        /discord_uploader_process_resident_memory_bytes \d+/,
      );
      expect(body).toMatch(/discord_uploader_process_uptime_seconds \d+/);
      expect(body.endsWith("\n")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("serves zeroes on a fresh instance", async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.fetch(
        new Request("https://uploader.test/metrics"),
      );
      const body = await res.text();
      expect(body).toContain("discord_uploader_commands_total 0");
      expect(body).toContain("discord_uploader_stored_bytes 0");
      expect(body).toContain("discord_uploader_stored_files 0");
    } finally {
      h.cleanup();
    }
  });
});

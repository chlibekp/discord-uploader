import { describe, expect, it } from "vitest";
import {
  interactionRequest,
  makeHarness,
  uploadCommand,
  type Harness,
} from "./helpers.js";
import { saveRecord } from "../src/storage/store.js";
import { recordCommandUse } from "../src/storage/usage.js";
import { registerAdminCommand } from "../src/discord/register.js";
import { USERS_PER_PAGE } from "../src/discord/admin.js";
import type { FileRecord } from "../src/types.js";

const ADMIN = "979103930309046323";

function adminHarness(): Promise<Harness> {
  return makeHarness({ adminUserIds: [ADMIN], adminGuildId: "guild-7" });
}

function runAdmin(h: Harness, userId: string): Promise<Response> {
  return h.app.fetch(
    interactionRequest(
      uploadCommand({
        data: { name: "admin", type: 1 },
        member: { user: { id: userId } },
      }),
    ),
  );
}

function clickPanel(
  h: Harness,
  userId: string,
  customId: string,
): Promise<Response> {
  return h.app.fetch(
    interactionRequest({
      type: 3,
      id: "interaction-2",
      token: "interaction-token-abc",
      channel_id: "channel-99",
      guild_id: "guild-7",
      data: { custom_id: customId, component_type: 2 },
      member: { user: { id: userId } },
    }),
  );
}

function record(id: string, userId: string, size: number): FileRecord {
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
    userId,
    channelId: "channel-99",
  };
}

describe("/admin", () => {
  it("shows the user list to an admin", async () => {
    const h = await adminHarness();
    try {
      await saveRecord(h.deps.redis, record("file-a", "user-1", 4096));
      await saveRecord(h.deps.redis, record("file-b", "user-2", 1024));
      await recordCommandUse(h.deps.redis, "help", "user-3");

      const body = (await (await runAdmin(h, ADMIN)).json()) as any;
      const embed = body.data.embeds[0];

      expect(embed.title).toBe("🛡 Admin — Users");
      // Two uploaders, the user who only ran a command, and the admin whose
      // own /admin invocation is counted like any other command.
      expect(embed.description).toContain("**4** known users");
      // Heaviest first.
      expect(embed.description.indexOf("user-1")).toBeLessThan(
        embed.description.indexOf("user-2"),
      );
      expect(embed.description).toContain("4.0 KB");
      expect(body.data.components[0].components).toHaveLength(4);
    } finally {
      h.cleanup();
    }
  });

  it("refuses anyone who is not an admin", async () => {
    const h = await adminHarness();
    try {
      const body = (await (await runAdmin(h, "user-42")).json()) as any;
      expect(body.data.content).toBe("That command is not available to you.");
      expect(body.data.embeds).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("refuses a non-admin who presses a panel button", async () => {
    const h = await adminHarness();
    try {
      const body = (await (
        await clickPanel(h, "user-42", "admin:storage:0")
      ).json()) as any;
      expect(body.data.content).toBe("That command is not available to you.");
    } finally {
      h.cleanup();
    }
  });

  it("switches panels in place", async () => {
    const h = await adminHarness();
    try {
      await recordCommandUse(h.deps.redis, "upload", "user-1");
      await recordCommandUse(h.deps.redis, "upload", "user-2");

      const storage = (await (
        await clickPanel(h, ADMIN, "admin:storage:0")
      ).json()) as any;
      expect(storage.type).toBe(7);
      expect(storage.data.embeds[0].title).toBe("🛡 Admin — Storage");

      const commands = (await (
        await clickPanel(h, ADMIN, "admin:commands:0")
      ).json()) as any;
      expect(commands.data.embeds[0].description).toContain(
        "`/upload` — **2**",
      );
    } finally {
      h.cleanup();
    }
  });

  it("pages the user list and clamps a page that is out of range", async () => {
    const h = await adminHarness();
    try {
      for (let i = 0; i < USERS_PER_PAGE + 3; i++) {
        await recordCommandUse(h.deps.redis, "help", `user-${i}`);
      }

      const second = (await (
        await clickPanel(h, ADMIN, "admin:users:1")
      ).json()) as any;
      expect(second.data.embeds[0].description).toContain("page **2/2**");

      const clamped = (await (
        await clickPanel(h, ADMIN, "admin:users:99")
      ).json()) as any;
      expect(clamped.data.embeds[0].description).toContain("page **2/2**");
    } finally {
      h.cleanup();
    }
  });

  it("ignores an unknown admin panel", async () => {
    const h = await adminHarness();
    try {
      const body = (await (
        await clickPanel(h, ADMIN, "admin:bogus:0")
      ).json()) as any;
      expect(body.data.content).toBe("That button no longer does anything.");
    } finally {
      h.cleanup();
    }
  });
});

describe("registerAdminCommand", () => {
  it("registers the command to the configured guild", async () => {
    const h = await adminHarness();
    try {
      const ok = await registerAdminCommand(h.deps.config, h.deps.fetch);
      expect(ok).toBe(true);
      const call = h.calls.at(-1)!;
      expect(call.url).toContain("/guilds/guild-7/commands");
      expect(call.body).toEqual([
        { name: "admin", description: "Operator dashboard", type: 1 },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it("does nothing without an admin guild", async () => {
    const h = await makeHarness({ adminGuildId: "" });
    try {
      expect(await registerAdminCommand(h.deps.config, h.deps.fetch)).toBe(
        false,
      );
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

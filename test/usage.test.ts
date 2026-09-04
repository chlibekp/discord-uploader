import { describe, expect, it } from "vitest";
import {
  interactionRequest,
  makeHarness,
  uploadCommand,
  type Harness,
} from "./helpers.js";
import { getUsageStats } from "../src/storage/usage.js";

async function runCommand(
  h: Harness,
  name: string,
  userId: string,
): Promise<Response> {
  return h.app.fetch(
    interactionRequest(
      uploadCommand({
        data: { name, type: 1 },
        member: { user: { id: userId } },
      }),
    ),
  );
}

describe("usage counters", () => {
  it("counts every command and de-duplicates users", async () => {
    const h = await makeHarness();
    try {
      await runCommand(h, "help", "user-1");
      await runCommand(h, "support", "user-1");
      await runCommand(h, "help", "user-2");

      const usage = await getUsageStats(h.deps.redis);
      expect(usage.commands).toBe(3);
      expect(usage.activeUsers).toBe(2);
      expect(usage.byCommand).toEqual({ help: 2, support: 1 });
    } finally {
      h.cleanup();
    }
  });

  it("does not count pings or unsupported interactions", async () => {
    const h = await makeHarness();
    try {
      await h.app.fetch(interactionRequest({ type: 1 }));
      await h.app.fetch(
        interactionRequest(uploadCommand({ data: { name: "nope", type: 1 } })),
      );

      const usage = await getUsageStats(h.deps.redis);
      expect(usage.commands).toBe(0);
      expect(usage.activeUsers).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("shows the counters in the /info embed", async () => {
    const h = await makeHarness();
    try {
      await runCommand(h, "help", "user-1");
      const res = await runCommand(h, "info", "user-2");
      const body = (await res.json()) as any;
      const fields = body.data.embeds[0].fields as {
        name: string;
        value: string;
      }[];

      expect(fields.find((f) => f.name === "Commands run")?.value).toBe("2");
      expect(fields.find((f) => f.name === "Active users")?.value).toBe("2");
    } finally {
      h.cleanup();
    }
  });
});

describe("GET /api/stats", () => {
  it("exposes the aggregate counters publicly", async () => {
    const h = await makeHarness();
    try {
      await runCommand(h, "help", "user-1");
      await runCommand(h, "help", "user-2");

      const res = await h.app.fetch(
        new Request("https://uploader.test/api/stats"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const body = (await res.json()) as any;
      expect(body.commands).toBe(2);
      expect(body.activeUsers).toBe(2);
      expect(body.byCommand).toEqual({ help: 2 });
      expect(typeof body.generatedAt).toBe("string");
    } finally {
      h.cleanup();
    }
  });

  it("reports zeroes on a cold store", async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.fetch(
        new Request("https://uploader.test/api/stats"),
      );
      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        commands: 0,
        activeUsers: 0,
        byCommand: {},
      });
    } finally {
      h.cleanup();
    }
  });
});

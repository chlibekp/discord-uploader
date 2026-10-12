import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { VOTE_KEY } from "../src/topgg.js";
import {
  interactionRequest,
  makeHarness,
  uploadCommand,
  type Harness,
} from "./helpers.js";

let h: Harness;

afterEach(() => {
  h?.cleanup();
});

const SECRET = "whs_test_secret";
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

function voteJson(expiresAt: string): Response {
  return new Response(
    JSON.stringify({
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      weight: 1,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function topggCalls(): string[] {
  return h.calls
    .map((c) => c.url)
    .filter((u) => u.startsWith("https://top.gg/"));
}

async function runUpload(overrides: Record<string, unknown> = {}) {
  const res = await h.app.fetch(interactionRequest(uploadCommand(overrides)));
  return res.json();
}

function webhookRequest(
  payload: unknown,
  opts: { secret?: string; header?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const t = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return new Request("https://uploader.test/topgg/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-topgg-signature": opts.header ?? `t=${t},v1=${sig}`,
    },
    body,
  });
}

function voteEvent(userId: string, expiresAt = inAnHour()) {
  return {
    type: "vote.create",
    data: {
      id: "808499215864008704",
      weight: 1,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      project: {
        id: "1",
        type: "bot",
        platform: "discord",
        platform_id: "1234567890",
      },
      user: { id: "3", platform_id: userId, name: "voter", avatar_url: "" },
    },
  };
}

describe("/upload vote lock", () => {
  it("is off when no Top.gg token is configured", async () => {
    h = await makeHarness();
    const body = await runUpload();
    expect(body.data.components[0].components[0].label).toBe(
      "Open upload page",
    );
    expect(topggCalls()).toEqual([]);
  });

  it("asks a user who has not voted to vote, without minting a session", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    h.respond.push((url) =>
      url.includes("top.gg/api")
        ? new Response(null, { status: 404 })
        : undefined,
    );
    const body = await runUpload();
    const button = body.data.components[0].components[0];
    expect(body.data.flags).toBe(64);
    expect(button.label).toBe("Vote on top.gg");
    expect(button.url).toBe("https://top.gg/bot/1234567890/vote");
    expect(await h.deps.redis.keys("sess:*")).toEqual([]);
    expect(topggCalls()).toEqual([
      "https://top.gg/api/v1/projects/@me/votes/user-42?source=discord",
    ]);
  });

  it("lets a voter through and caches the vote until it expires", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    h.respond.push((url) =>
      url.includes("top.gg/api") ? voteJson(inAnHour()) : undefined,
    );

    expect((await runUpload()).data.components[0].components[0].label).toBe(
      "Open upload page",
    );
    const ttl = await h.deps.redis.pttl(VOTE_KEY("user-42"));
    expect(ttl).toBeGreaterThan(3_500_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);

    await runUpload();
    expect(topggCalls()).toHaveLength(1);
  });

  it("treats an already expired vote as no vote", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    h.respond.push((url) =>
      url.includes("top.gg/api")
        ? voteJson(new Date(Date.now() - 1000).toISOString())
        : undefined,
    );
    expect((await runUpload()).data.components[0].components[0].label).toBe(
      "Vote on top.gg",
    );
  });

  it("lets the user through when Top.gg is erroring", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    h.respond.push((url) =>
      url.includes("top.gg/api")
        ? new Response(null, { status: 503 })
        : undefined,
    );
    expect((await runUpload()).data.components[0].components[0].label).toBe(
      "Open upload page",
    );
  });

  it("does not lock admins", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    const body = await runUpload({
      member: { user: { id: "979103930309046323" } },
    });
    expect(body.data.components[0].components[0].label).toBe(
      "Open upload page",
    );
    expect(topggCalls()).toEqual([]);
  });

  it("does not lock /gallery", async () => {
    h = await makeHarness({ topggToken: "tg-token" });
    const body = await runUpload({ data: { name: "gallery", type: 1 } });
    expect(body.data.components[0].components[0].label).toBe("Open gallery");
    expect(topggCalls()).toEqual([]);
  });
});

describe("POST /topgg/webhook", () => {
  it("404s when no webhook secret is configured", async () => {
    h = await makeHarness();
    const res = await h.app.fetch(webhookRequest(voteEvent("user-42")));
    expect(res.status).toBe(404);
  });

  it("records a signed vote, which then unlocks /upload without an API call", async () => {
    h = await makeHarness({
      topggToken: "tg-token",
      topggWebhookSecret: SECRET,
    });
    const res = await h.app.fetch(webhookRequest(voteEvent("user-42")));
    expect(res.status).toBe(204);
    expect(await h.deps.redis.exists(VOTE_KEY("user-42"))).toBe(1);

    expect((await runUpload()).data.components[0].components[0].label).toBe(
      "Open upload page",
    );
    expect(topggCalls()).toEqual([]);
  });

  it("rejects a vote signed with the wrong secret", async () => {
    h = await makeHarness({ topggWebhookSecret: SECRET });
    const res = await h.app.fetch(
      webhookRequest(voteEvent("user-42"), { secret: "whs_other" }),
    );
    expect(res.status).toBe(401);
    expect(await h.deps.redis.exists(VOTE_KEY("user-42"))).toBe(0);
  });

  it("rejects a missing or malformed signature header", async () => {
    h = await makeHarness({ topggWebhookSecret: SECRET });
    for (const header of ["", "garbage", "t=1,v1=zz", "t=1,v1=abcd"]) {
      const res = await h.app.fetch(
        webhookRequest(voteEvent("user-42"), { header }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("acknowledges a test event without recording anything", async () => {
    h = await makeHarness({ topggWebhookSecret: SECRET });
    const res = await h.app.fetch(
      webhookRequest({
        type: "webhook.test",
        data: {
          user: { id: "3", platform_id: "user-42" },
          project: { id: "1" },
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(await h.deps.redis.exists(VOTE_KEY("user-42"))).toBe(0);
  });
});

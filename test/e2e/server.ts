import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { rm, mkdir } from "node:fs/promises";
import { makeHarness } from "../helpers.js";
import { createSession } from "../../src/storage/sessions.js";
import { createAuthSession } from "../../src/auth/sessions.js";
import { seedFixtures, E2E_USER } from "./fixtures.js";

const PORT = 4173;
const h = await makeHarness({
  publicUrl: `http://localhost:${PORT}`,
  maxFileBytes: 50 * 1024 * 1024,
  maxUserBytes: 2 * 1024 * 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024 * 1024,
});

async function reset(): Promise<void> {
  await h.deps.redis.flushall();
  await rm(h.deps.config.dataDir, { recursive: true, force: true });
  await mkdir(h.deps.config.dataDir, { recursive: true });
  await seedFixtures(h.deps);
}
await reset();

const root = new Hono();
root.post("/__e2e/reset", async (c) => {
  await reset();
  return c.json({ ok: true });
});
root.post("/__e2e/session", async (c) => {
  const kind = c.req.query("kind") === "gallery" ? "gallery" : "upload";
  const session = await createSession(h.deps.redis, {
    kind,
    userId: c.req.query("user") ?? E2E_USER,
    channelId: "200000000000000001",
    guildId: "",
    interactionToken: "e2e-token",
    ttlMs: 0,
  });
  return c.json({ sid: session.sid });
});
root.post("/__e2e/login", async (c) => {
  const id = c.req.query("user") ?? E2E_USER;
  const token = await createAuthSession(h.deps.redis, {
    id,
    username: "e2e",
    globalName: "E2E",
    avatar: "",
  });
  return c.json({ token });
});
root.route("/", h.app);

serve({ fetch: root.fetch, port: PORT }, () =>
  console.log(`e2e server on :${PORT}`),
);

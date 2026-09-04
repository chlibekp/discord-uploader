import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { getUsageStats } from "../storage/usage.js";

/**
 * Public usage counters. Only aggregates are exposed — no user ids, no file
 * data — so the endpoint needs no auth and is safe to read from anywhere.
 */
export function statsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/api/stats", async (c) => {
    const usage = await getUsageStats(deps.redis);
    c.header("Access-Control-Allow-Origin", "*");
    // Counters move constantly; a short cache keeps a hot embed cheap without
    // making the numbers look stale.
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      commands: usage.commands,
      activeUsers: usage.activeUsers,
      byCommand: usage.byCommand,
      generatedAt: new Date().toISOString(),
    });
  });

  return app;
}

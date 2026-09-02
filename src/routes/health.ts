import { Hono } from "hono";
import { access, constants } from "node:fs/promises";
import type { AppDeps } from "../app.js";

/** Railway's healthcheck target. Fails if either dependency is unusable. */
export function healthRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    try {
      await deps.redis.ping();
      await access(deps.config.dataDir, constants.W_OK);
      return c.json({ ok: true });
    } catch (err) {
      console.error("Health check failed:", err);
      return c.json({ ok: false, error: (err as Error).message }, 503);
    }
  });

  return app;
}

import { Hono } from "hono";
import type { Redis } from "ioredis";
import { loadUser, requirePageUser, sameOrigin } from "./auth/middleware.js";
import type { AuthEnv } from "./auth/types.js";
import type { Config } from "./config.js";
import { assetRoutes } from "./routes/assets.js";
import { authRoutes } from "./routes/auth.js";
import { fileRoutes } from "./routes/files.js";
import { galleryRoutes } from "./routes/gallery.js";
import { healthRoutes } from "./routes/health.js";
import { interactionsRoutes } from "./routes/interactions.js";
import { meRoutes } from "./routes/me.js";
import { metricsRoutes } from "./routes/metrics.js";
import { statsRoutes } from "./routes/stats.js";
import { uploadRoutes } from "./routes/upload.js";
import { webRoutes, type WebRenderer } from "./web/mount.js";

export interface AppDeps {
  config: Config;
  redis: Redis;
  /** Injected so tests can observe Discord calls without network access. */
  fetch: typeof fetch;
  /** The built Astro entry. Unset means every page route answers 404. */
  web?: WebRenderer;
}

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // Only these paths look at the session cookie, so image and file requests
  // never cost a Redis read.
  for (const path of [
    "/auth/*",
    "/api/me",
    "/api/me/*",
    "/dashboard",
    "/dashboard/*",
    "/login",
  ]) {
    app.use(path, loadUser(deps));
  }
  app.use("/auth/*", sameOrigin(deps.config));
  app.use("/api/me/*", sameOrigin(deps.config));
  app.use("/dashboard", requirePageUser);
  app.use("/dashboard/*", requirePageUser);

  app.route("/", assetRoutes());
  app.route("/", healthRoutes(deps));
  app.route("/", authRoutes(deps));
  app.route("/", meRoutes(deps));
  app.route("/", interactionsRoutes(deps));
  app.route("/", statsRoutes(deps));
  app.route("/", metricsRoutes(deps));
  app.route("/", uploadRoutes(deps));
  app.route("/", galleryRoutes(deps));
  app.route("/", fileRoutes(deps));

  app.get("/", (c) => c.text("discord-uploader: run /upload in Discord."));
  // Must stay the last route: it hands everything unmatched to Astro.
  app.route("/", webRoutes(deps));

  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

import { Hono } from "hono";
import type { Redis } from "ioredis";
import type { Config } from "./config.js";
import { fileRoutes } from "./routes/files.js";
import { galleryRoutes } from "./routes/gallery.js";
import { healthRoutes } from "./routes/health.js";
import { interactionsRoutes } from "./routes/interactions.js";
import { uploadRoutes } from "./routes/upload.js";

export interface AppDeps {
  config: Config;
  redis: Redis;
  /** Injected so tests can observe Discord calls without network access. */
  fetch: typeof fetch;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.route("/", healthRoutes(deps));
  app.route("/", interactionsRoutes(deps));
  app.route("/", uploadRoutes(deps));
  app.route("/", galleryRoutes(deps));
  app.route("/", fileRoutes(deps));

  app.get("/", (c) => c.text("discord-uploader: run /upload in Discord."));

  app.onError((err, c) => {
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

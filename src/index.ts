import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { registerCommands } from "./discord/register.js";
import { reconcile } from "./storage/lru.js";
import { ensureDataDir } from "./storage/store.js";

async function main() {
  const config = loadConfig();

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (err: Error) => console.error("Redis error:", err.message));
  await redis.ping();

  await ensureDataDir(config);
  await reconcile(redis, config);

  // Registration failures are logged, not fatal: already-registered commands
  // keep working, and a transient Discord outage should not stop the service.
  await registerCommands(config);

  const app = createApp({ config, redis, fetch });

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Listening on :${info.port}, public URL ${config.publicUrl}`);
  });

  const shutdown = async () => {
    console.log("Shutting down");
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(`Configuration error: ${err.message}`);
  else console.error("Startup failed:", err);
  process.exit(1);
});

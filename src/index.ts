import { serve } from "@hono/node-server";
import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { registerCommands } from "./discord/register.js";
import { reconcile } from "./storage/lru.js";
import { ensureDataDir, verifyDataDirWritable } from "./storage/store.js";

/**
 * Each boot step is announced before it runs. A crash here means the platform
 * reports "connection refused" with no other clue, so the last line in the log
 * has to identify which dependency failed.
 */
async function main() {
  console.log("Loading configuration");
  const config = loadConfig();
  console.log(
    `Config OK: port=${config.port} dataDir=${config.dataDir} publicUrl=${config.publicUrl}`,
  );

  console.log(`Connecting to Redis at ${redacted(config.redisUrl)}`);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", (err: Error) => console.error("Redis error:", err.message));
  await redis.ping();
  console.log("Redis OK");

  console.log(`Preparing data directory ${config.dataDir}`);
  await ensureDataDir(config);
  await verifyDataDirWritable(config);
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

/** Keep credentials out of the logs while still showing which host was used. */
function redacted(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || "6379"}`;
  } catch {
    return "<unparseable REDIS_URL>";
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(`Configuration error: ${err.message}`);
  else console.error("Startup failed:", err);
  process.exit(1);
});

import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { requireApiUser } from "../auth/middleware.js";
import type { AuthEnv, AuthUser } from "../auth/types.js";
import {
  getMyUsage,
  limitsFor,
  listMyFiles,
  parseRange,
  toApiFile,
} from "../me/data.js";
import {
  declaredTooLarge,
  ingestUpload,
  UploadError,
} from "../storage/ingest.js";
import { checkRateLimit, minutesUntil } from "../storage/ratelimit.js";
import { deleteRecord, getRecord } from "../storage/store.js";
import { ttlValueToMs } from "../ttl.js";

/** Ids per bulk-delete request; generous for a dashboard "select all", far under any URL/body limit. */
const MAX_BULK = 100;

export function meRoutes(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Registered before requireApiUser so the header lands on its 401 too:
  // Hono composes same-path middleware in registration order, outermost first.
  app.use("/api/me", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/api/me/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/api/me", requireApiUser);
  app.use("/api/me/*", requireApiUser);

  // requireApiUser already 401ed a null user, so this is just the non-null cast.
  const me = (c: { get(k: "user"): AuthUser | null }): AuthUser =>
    c.get("user")!;

  app.get("/api/me", (c) =>
    c.json({ user: me(c), limits: limitsFor(deps.config) }),
  );

  app.get("/api/me/files", async (c) =>
    c.json({ files: await listMyFiles(deps, me(c).id) }),
  );

  app.post("/api/me/files", async (c) => {
    const user = me(c);
    if (declaredTooLarge(c, deps.config))
      return c.json({ error: "File exceeds the size limit" }, 413);

    // Same hourly bucket as uploads through a Discord link.
    const limit = await checkRateLimit(
      deps.redis,
      "upload",
      user.id,
      deps.config.rateLimitUploadsPerHour,
    );
    if (!limit.allowed) {
      return c.json(
        {
          error: `You're uploading too quickly. Try again in ${minutesUntil(limit.resetAt)} minute(s).`,
          retryAfterSeconds: Math.ceil((limit.resetAt - Date.now()) / 1000),
        },
        429,
      );
    }

    try {
      const record = await ingestUpload(c, deps, {
        userId: user.id,
        channelId: "",
        ttlMs: (fields) => ttlValueToMs(fields.ttl),
      });
      return c.json({ file: toApiFile(deps.config, record) }, 201);
    } catch (err) {
      if (err instanceof UploadError)
        return c.json({ error: err.message }, err.status as 400);
      console.error("Dashboard upload failed:", err);
      return c.json({ error: "Upload failed" }, 500);
    }
  });

  app.delete("/api/me/files/:id", async (c) => {
    const id = c.req.param("id");
    const record = await getRecord(deps.redis, id);
    // Someone else's file answers exactly like a missing one.
    if (!record || record.userId !== me(c).id)
      return c.json({ error: "File not found" }, 404);
    await deleteRecord(deps.redis, deps.config, id);
    return c.body(null, 204);
  });

  app.post("/api/me/files/delete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      ids?: unknown;
    } | null;
    const ids = body?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_BULK ||
      !ids.every((i) => typeof i === "string")
    ) {
      return c.json({ error: `Send 1–${MAX_BULK} file ids` }, 400);
    }
    const userId = me(c).id;
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const id of new Set(ids as string[])) {
      const record = await getRecord(deps.redis, id);
      if (!record || record.userId !== userId) {
        missing.push(id);
        continue;
      }
      await deleteRecord(deps.redis, deps.config, id);
      deleted.push(id);
    }
    return c.json({ deleted, missing });
  });

  app.get("/api/me/usage", async (c) =>
    c.json(await getMyUsage(deps, me(c).id, parseRange(c.req.query("range")))),
  );

  return app;
}

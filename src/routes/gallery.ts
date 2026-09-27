import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { readActionToken } from "../storage/sessions.js";
import { deleteRecord, getRecord } from "../storage/store.js";

export function galleryRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  /**
   * Delete one of your own uploads.
   *
   * Ownership is decided by the token's user, never by anything the client
   * sends about the file. A file belonging to someone else answers 404 rather
   * than 403, so the endpoint cannot be used to probe which ids exist.
   */
  app.delete("/api/files/:id", async (c) => {
    const userId = await readActionToken(
      deps.redis,
      c.req.header("X-Action-Token") ?? "",
    );
    if (!userId)
      return c.json(
        { error: "This page has expired. Run /gallery again." },
        401,
      );

    const id = c.req.param("id");
    const record = await getRecord(deps.redis, id);
    if (!record || record.userId !== userId)
      return c.json({ error: "File not found" }, 404);

    await deleteRecord(deps.redis, deps.config, id);
    console.log(`Deleted ${id} at the owner's request`);
    return c.body(null, 204);
  });

  return app;
}

import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { AppDeps } from "../app.js";
import { parseRange } from "../http/range.js";
import { filePath, getRecord, touchRecord } from "../storage/store.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

export function fileRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "HEAD"], "/f/:id/:name", async (c) => {
    const id = c.req.param("id");
    const record = await getRecord(deps.redis, id);

    // The path always comes from the stored record. `:name` is only compared
    // against it, so a crafted path segment can never reach the filesystem.
    if (!record || record.name !== decodeURIComponent(c.req.param("name"))) {
      return c.text("Not found", 404);
    }

    const target = filePath(deps.config, record);
    let size: number;
    try {
      size = (await stat(target)).size;
    } catch {
      console.error(`Record ${id} exists but its file is missing on disk`);
      return c.text("Not found", 404);
    }

    touchRecord(deps.redis, id);

    const headers: Record<string, string> = {
      "Content-Type": record.mime,
      "Content-Disposition": `inline; filename="${record.name}"`,
      "Cache-Control": IMMUTABLE,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };

    const range = parseRange(c.req.header("range"), size);

    if (range.type === "unsatisfiable") {
      return c.body(null, 416, {
        ...headers,
        "Content-Range": `bytes */${size}`,
      });
    }

    if (range.type === "ok") {
      const length = range.end - range.start + 1;
      const partial = {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(length),
      };
      if (c.req.method === "HEAD") return c.body(null, 206, partial);
      return c.body(
        toWeb(createReadStream(target, { start: range.start, end: range.end })),
        206,
        partial,
      );
    }

    const full = { ...headers, "Content-Length": String(size) };
    if (c.req.method === "HEAD") return c.body(null, 200, full);
    return c.body(toWeb(createReadStream(target)), 200, full);
  });

  return app;
}

function toWeb(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

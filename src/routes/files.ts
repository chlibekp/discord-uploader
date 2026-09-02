import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { AppDeps } from "../app.js";
import { fileUrl } from "../discord/followup.js";
import { parseRange } from "../http/range.js";
import { brandBar, shell } from "../pages.js";
import { filePath, getRecord, touchRecord } from "../storage/store.js";
import type { FileRecord } from "../types.js";

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
      return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
    }

    if (range.type === "ok") {
      const length = range.end - range.start + 1;
      const partial = {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(length),
      };
      if (c.req.method === "HEAD") return c.body(null, 206, partial);
      return c.body(toWeb(createReadStream(target, { start: range.start, end: range.end })), 206, partial);
    }

    const full = { ...headers, "Content-Length": String(size) };
    if (c.req.method === "HEAD") return c.body(null, 200, full);
    return c.body(toWeb(createReadStream(target)), 200, full);
  });

  /**
   * The page a video upload links to. Discord fetches it, reads the OG player
   * tags, and renders the video inline in the channel.
   */
  app.get("/v/:id", async (c) => {
    const id = c.req.param("id");
    const record = await getRecord(deps.redis, id);
    if (!record) return c.text("Not found", 404);

    if (record.kind === "image") return c.redirect(fileUrl(deps.config, record), 302);

    return c.html(watchPage(fileUrl(deps.config, record), record), 200, {
      "Cache-Control": "public, max-age=3600",
    });
  });

  return app;
}

function toWeb(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

function watchPage(url: string, record: FileRecord): string {
  const title = escapeHtml(record.name);
  const head = `<meta property="og:type" content="video.other">
<meta property="og:title" content="${title}">
<meta property="og:url" content="${escapeHtml(url)}">
<meta property="og:video" content="${escapeHtml(url)}">
<meta property="og:video:secure_url" content="${escapeHtml(url)}">
<meta property="og:video:type" content="${escapeHtml(record.mime)}">
<meta property="og:video:width" content="${record.width}">
<meta property="og:video:height" content="${record.height}">
<meta name="twitter:card" content="player">
<meta name="twitter:player:stream" content="${escapeHtml(url)}">
<meta name="twitter:player:stream:content_type" content="${escapeHtml(record.mime)}">
<meta name="twitter:player:width" content="${record.width}">
<meta name="twitter:player:height" content="${record.height}">`;

  return shell(
    title,
    brandBar(title, `${record.width}\u00d7${record.height}`),
    `<main class="stage">
<video controls playsinline preload="metadata" src="${escapeHtml(url)}"></video>
</main>`,
    head,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

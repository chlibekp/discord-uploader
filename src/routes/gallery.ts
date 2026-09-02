import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { UPLOAD_PAGE_CSP, assets } from "../assets.js";
import { fileUrl, watchUrl } from "../discord/followup.js";
import { claimSession } from "../storage/sessions.js";
import { listUserFiles } from "../storage/store.js";
import type { Config } from "../config.js";
import type { FileRecord } from "../types.js";

export function galleryRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/assets/gallery.js", (c) =>
    c.body(assets.galleryJs, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    }),
  );

  /**
   * The gallery is rendered in full on this one request and the session is spent
   * doing it, so there is nothing left to re-fetch and a reload correctly finds
   * a dead link.
   */
  app.get("/g/:gid", async (c) => {
    const claim = await claimSession(deps.redis, c.req.param("gid"));

    // A session opened by /upload must not be spendable here, or the wrong page
    // would consume it.
    if (claim.status !== "ok" || claim.session.kind !== "gallery") {
      return c.html(expiredPage(), 404, { "Content-Security-Policy": UPLOAD_PAGE_CSP });
    }

    // Scoped to the invoker, so a leaked link still exposes only their own files.
    const files = await listUserFiles(deps.redis, claim.session.userId);

    const html = assets.galleryHtml
      .replace("{{SUMMARY}}", escapeHtml(summarise(files)))
      .replace("{{TILES}}", files.length > 0 ? grid(deps.config, files) : emptyState());

    return c.html(html, 200, {
      "Content-Security-Policy": UPLOAD_PAGE_CSP,
      "Cache-Control": "no-store",
    });
  });

  return app;
}

function summarise(files: FileRecord[]): string {
  if (files.length === 0) return "Nothing here yet.";
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const noun = files.length === 1 ? "file" : "files";
  return `${files.length} ${noun}, ${formatBytes(bytes)}. Newest first.`;
}

function grid(config: Config, files: FileRecord[]): string {
  return `<div class="grid">${files.map((file) => tile(config, file)).join("")}</div>`;
}

function tile(config: Config, file: FileRecord): string {
  const direct = fileUrl(config, file);
  const share = file.kind === "video" ? watchUrl(config, file) : direct;
  const preview =
    file.kind === "video"
      ? `<video preload="metadata" muted playsinline src="${escapeHtml(direct)}#t=0.1"></video>`
      : `<img loading="lazy" decoding="async" src="${escapeHtml(direct)}" alt="${escapeHtml(file.name)}">`;

  return `<figure class="tile">
${preview}
<figcaption class="tile-name">${escapeHtml(file.name)}</figcaption>
<div class="tile-meta"><span>${formatBytes(file.size)}</span><span>${formatDate(file.createdAt)}</span></div>
<div class="tile-actions">
<a class="button small" href="${escapeHtml(share)}" target="_blank" rel="noopener">Open</a>
<button class="button small" type="button" data-copy="${escapeHtml(share)}">Copy link</button>
</div>
</figure>`;
}

function emptyState(): string {
  return `<div class="empty">
<p>You have not uploaded anything yet.</p>
<p class="muted">Run <code>/upload</code> in Discord to add your first file.</p>
</div>`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

function expiredPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired</title><link rel="stylesheet" href="/assets/upload.css"></head>
<body class="centered"><main class="card">
<h1>Link expired</h1>
<p>This gallery link has already been opened or has run out of time.</p>
<p>Run <code>/gallery</code> in Discord again to get a new one.</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

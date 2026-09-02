import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { UPLOAD_PAGE_CSP, assets } from "../assets.js";
import { fileUrl, watchUrl } from "../discord/followup.js";
import { expiredShell } from "../pages.js";
import { claimSession } from "../storage/sessions.js";
import { listUserFiles } from "../storage/store.js";
import type { Config } from "../config.js";
import type { FileRecord } from "../types.js";

export function galleryRoutes(deps: AppDeps): Hono {
  const app = new Hono();

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

    const bytes = files.reduce((total, file) => total + file.size, 0);
    const html = assets.galleryHtml
      .replace("{{SUMMARY}}", files.length > 0 ? `${formatBytes(bytes)}, newest first` : "Nothing stored yet")
      .replace("{{COUNT}}", files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "")
      .replace("{{TILES}}", files.length > 0 ? sheet(deps.config, files) : emptyState());

    return c.html(html, 200, {
      "Content-Security-Policy": UPLOAD_PAGE_CSP,
      "Cache-Control": "no-store",
    });
  });

  return app;
}

function sheet(config: Config, files: FileRecord[]): string {
  return `<main class="sheet">${files.map((file) => tile(config, file)).join("")}</main>`;
}

function tile(config: Config, file: FileRecord): string {
  const direct = fileUrl(config, file);
  // Videos link to the page that carries the player tags; images are their own
  // shareable URL.
  const share = file.kind === "video" ? watchUrl(config, file) : direct;
  const name = escapeHtml(file.name);

  const preview =
    file.kind === "video"
      ? `<video preload="metadata" muted playsinline src="${escapeHtml(direct)}#t=0.1"></video>
<span class="badge">VIDEO</span>`
      : `<img loading="lazy" decoding="async" src="${escapeHtml(direct)}" alt="${name}">`;

  return `<figure class="tile">
<a class="shot" href="${escapeHtml(share)}" target="_blank" rel="noopener">${preview}</a>
<div class="tile-body">
<figcaption class="tile-name" title="${name}">${name}</figcaption>
<div class="tile-meta"><span>${formatBytes(file.size)}</span><span>${formatDate(file.createdAt)}</span></div>
<div class="tile-actions">
<a class="button small" href="${escapeHtml(share)}" target="_blank" rel="noopener">Open</a>
<button class="button small" type="button" data-copy="${escapeHtml(share)}">Copy</button>
</div>
</div>
</figure>`;
}

function emptyState(): string {
  return `<main class="empty">
<img src="/assets/mascot.png" alt="" width="128" height="128">
<h2>No files yet</h2>
<p class="muted">Run <code>/upload</code> in Discord and whatever you send lands here.</p>
</main>`;
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
  return expiredShell(
    "This gallery link has already been opened or has run out of time.",
    "gallery",
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

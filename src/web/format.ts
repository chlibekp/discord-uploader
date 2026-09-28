export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Per-file lifetime, shown next to size and upload date on each tile. */
export function expiryLabel(expiresAt: number, now = Date.now()): string {
  if (!expiresAt) return "kept until full";
  const days = Math.ceil((expiresAt - now) / 86_400_000);
  if (days <= 0) return "expiring now";
  if (days === 1) return "deletes in 1 day";
  return `deletes in ${days} days`;
}

/**
 * Astro's own attribute serializer only escapes `&` and `"` (all an HTML
 * attribute value strictly needs), leaving `<`/`>` literal. A hostile
 * filename dropped into `data-name`, `title`, or an OG `content` attribute
 * would then still contain a raw `<script>`/`<img onerror>` substring in the
 * response body. Pre-escaping with this — and rendering the result via
 * `set:html` so Astro does not re-encode the `&` this introduces — matches
 * the blanket escaping the legacy Hono pages always applied.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

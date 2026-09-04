import type { InfraReport } from "../infra.js";

/** Discord blurple. Matches EMBED_COLOR in followup.ts. */
export const BLURPLE = 5793266;

const FOOTER = { text: "ImageUploader • imageuploader.xyz" };

export interface Embed {
  title?: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  color: number;
  footer: { text: string };
  timestamp: string;
}

/**
 * Every command embed shares the blurple colour, the ImageUploader footer and a
 * timestamp, so the whole bot reads as one surface.
 */
export function brandedEmbed(
  partial: Omit<Embed, "color" | "footer" | "timestamp">,
): Embed {
  return {
    ...partial,
    color: BLURPLE,
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
}

const BAR_CELLS = 20;

/** Whole percents, except that a non-zero fraction of one reads as "<1%". */
export function formatPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  const rounded = Math.round(pct);
  // Never let rounding read as a full quota when there is still room left.
  if (rounded >= 100 && pct < 100) return "99%";
  return `${rounded}%`;
}

/**
 * A 20-cell bar for the /stats usage figure. At or above the quota it fills
 * completely and flags the overage rather than overflowing. Any storage at all
 * shows at least one filled cell, so a user with files never sees an empty bar.
 */
export function progressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.round((clamped / 100) * BAR_CELLS);
  if (filled === 0 && pct > 0) filled = 1;
  const bar = "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
  const suffix = pct >= 100 ? " ⚠ over quota" : "";
  return `${bar} ${formatPct(pct)}${suffix}`;
}

export function buildInfraEmbed(r: InfraReport): Embed {
  return brandedEmbed({
    title: "🛠 ImageUploader — Infrastructure",
    fields: [
      { name: "Region", value: r.region },
      { name: "Host", value: r.host },
      { name: "Runtime", value: r.runtime },
      { name: "CPU", value: r.cpu },
      { name: "Memory", value: r.memory },
      { name: "Disk", value: r.disk },
      { name: "Uptime", value: r.uptime },
      { name: "Installs", value: r.installs },
    ],
  });
}

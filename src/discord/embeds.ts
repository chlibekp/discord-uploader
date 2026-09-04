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
export function brandedEmbed(partial: Omit<Embed, "color" | "footer" | "timestamp">): Embed {
  return {
    ...partial,
    color: BLURPLE,
    footer: FOOTER,
    timestamp: new Date().toISOString(),
  };
}

/**
 * A 10-cell bar for the /stats usage figure. At or above the quota it fills
 * completely and flags the overage rather than overflowing.
 */
export function progressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return pct >= 100 ? `${bar} ${Math.round(pct)}% ⚠ over quota` : `${bar} ${Math.round(pct)}%`;
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

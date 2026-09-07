import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { LRU_KEY, totalBytes } from "../storage/store.js";
import { getUsageStats } from "../storage/usage.js";

/** Prometheus text exposition format version. */
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Escape a label value per the exposition format spec. */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge";
  samples: { labels?: Record<string, string>; value: number }[];
}

function render(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      const labels = sample.labels
        ? `{${Object.entries(sample.labels)
            .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
            .join(",")}}`
        : "";
      lines.push(`${metric.name}${labels} ${sample.value}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Prometheus scrape target. Exposes the same aggregates as /api/stats plus a
 * few process gauges — no user ids, no file data — so it needs no auth. Reads
 * are cheap Redis primitives only; the admin SCAN is deliberately avoided.
 */
export function metricsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/metrics", async (c) => {
    const [usage, stored, storedFiles] = await Promise.all([
      getUsageStats(deps.redis),
      totalBytes(deps.redis),
      deps.redis.zcard(LRU_KEY),
    ]);

    const metrics: Metric[] = [
      {
        name: "discord_uploader_commands_total",
        help: "Slash commands executed across every user.",
        type: "counter",
        samples: [{ value: usage.commands }],
      },
      {
        name: "discord_uploader_command_invocations_total",
        help: "Slash commands executed, by command name.",
        type: "counter",
        samples: Object.entries(usage.byCommand).map(([command, value]) => ({
          labels: { command },
          value,
        })),
      },
      {
        name: "discord_uploader_active_users",
        help: "Users who have run at least one command.",
        type: "gauge",
        samples: [{ value: usage.activeUsers }],
      },
      {
        name: "discord_uploader_stored_bytes",
        help: "Bytes occupied by all live files.",
        type: "gauge",
        samples: [{ value: stored }],
      },
      {
        name: "discord_uploader_stored_files",
        help: "Live files tracked in the LRU index.",
        type: "gauge",
        samples: [{ value: storedFiles }],
      },
      {
        name: "discord_uploader_process_resident_memory_bytes",
        help: "Resident set size of the bot process.",
        type: "gauge",
        samples: [{ value: process.memoryUsage().rss }],
      },
      {
        name: "discord_uploader_process_uptime_seconds",
        help: "Seconds since the bot process started.",
        type: "gauge",
        samples: [{ value: Math.floor(process.uptime()) }],
      },
    ];

    c.header("Content-Type", CONTENT_TYPE);
    c.header("Cache-Control", "no-store");
    return c.body(render(metrics));
  });

  return app;
}

import { useMemo } from "react";
import type { ApiUsage } from "@server/me/types";
import { Sparkline } from "../components/dither-kit";
import { formatBytes } from "../lib/format";

/**
 * Takes the summary as a prop rather than reading `summaryStore`, so FilesView
 * can hand it the server-rendered copy until hydration is done.
 */
export default function StorageStrip({ summary }: { summary: ApiUsage }) {
  const { used, quota, images, videos } = summary.storage;
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const up = summary.rateLimits.uploads;
  const series = useMemo(
    () => summary.series.map((p) => p.uploads),
    [summary.series],
  );
  const week = series.reduce((n, v) => n + v, 0);
  return (
    <section className="strip panel" aria-label="Storage">
      <div className="strip-in">
        <span className="pixel strip-label">Storage</span>
        <div
          className={`meter${pct >= 90 ? " warn" : ""}`}
          role="meter"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={quota}
          aria-valuenow={used}
          aria-valuetext={`${formatBytes(used)} of ${formatBytes(quota)}`}
        >
          {/* Sub-1% use still shows one step, as /stats does. */}
          <div
            className="meter-fill"
            style={{ width: `${used > 0 ? Math.max(pct, 2) : 0}%` }}
          />
        </div>
        <span className="strip-num">
          {formatBytes(used)} / {formatBytes(quota)}
        </span>
        <span className="muted">
          img {formatBytes(images.bytes)} · vid {formatBytes(videos.bytes)}
        </span>
        <span className="muted">
          {up.remaining === null
            ? "No hourly upload limit"
            : `${up.remaining}/${up.limit} uploads left this hour`}
        </span>
        <div
          className="strip-trend"
          role="img"
          aria-label={`${week} ${week === 1 ? "upload" : "uploads"} in the last 7 days`}
        >
          <div className="strip-spark">
            <Sparkline data={series} color="cyan" />
          </div>
          <span className="muted">7d</span>
        </div>
      </div>
    </section>
  );
}

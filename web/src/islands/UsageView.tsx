import { MotionConfig } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ApiRate, ApiUsage, UsageRange } from "@server/me/types";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  type ChartConfig,
  DitherGradient,
  Grid,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "../components/dither-kit";
import { getJson } from "../lib/api";
import {
  formatBytes,
  formatClock,
  formatDay,
  formatDelta,
} from "../lib/format";
import { filesStore, useNow } from "../lib/state";

type Metric = "uploads" | "bytes";
type Scope = "range" | "allTime";

const RANGES = [
  ["7d", "7D"],
  ["30d", "30D"],
  ["90d", "90D"],
] as const;
const DAYS: Record<UsageRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
const BYTE_UNITS = [
  ["B", 1],
  ["KB", 1024],
  ["MB", 1024 ** 2],
  ["GB", 1024 ** 3],
] as const;
/** Room for "1.5 MB" beside the plot, kept for both metrics so it never jumps. */
const MARGINS = { left: 48 };

/** The largest binary unit `max` reaches, so byte ticks land on round numbers. */
function byteUnit(max: number): readonly [string, number] {
  let i = 0;
  while (i < BYTE_UNITS.length - 1 && max >= BYTE_UNITS[i + 1]![1]) i += 1;
  return BYTE_UNITS[i]!;
}

/** Tick count that keeps a small count axis on whole numbers (d3 picks the step). */
const countTicks = (max: number) => Math.max(1, Math.min(4, max));

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Read after mount, so the hydrating render matches the server's (false). */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** A radiogroup with one tab stop; arrow keys move and select, as ARIA asks. */
function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const j = (i + step + options.length) % options.length;
    refs.current[j]?.focus();
    onChange(options[j]![0]);
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text], i) => (
        <button
          key={v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={v === value ? 0 : -1}
          onClick={() => v !== value && onChange(v)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  busy,
  children,
}: {
  label: string;
  value: string;
  /** Dims a range-dependent tile while the next range loads. */
  busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`panel${busy ? " stale" : ""}`}>
      <div className="stat-in">
        <span className="pixel stat-label">{label}</span>
        <span className="stat-value">{value}</span>
        {children}
      </div>
    </div>
  );
}

function Meter({
  value,
  max,
  label,
  text,
}: {
  value: number;
  max: number;
  label: string;
  text: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      className={`meter${pct >= 90 ? " warn" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={text}
    >
      {/* Sub-1% use still shows one step, as the storage strip does. */}
      <div
        className="meter-fill"
        style={{ width: `${value > 0 ? Math.max(pct, 2) : 0}%` }}
      />
    </div>
  );
}

function LimitRow({ name, rate }: { name: string; rate: ApiRate }) {
  if (rate.remaining === null) {
    return (
      <>
        <span>{name}</span>
        <span className="muted">No limit</span>
        <span />
      </>
    );
  }
  const text = `${rate.used} of ${rate.limit}`;
  return (
    <>
      <span>{name}</span>
      <Meter
        value={rate.used}
        max={rate.limit}
        label={`${name} this hour`}
        text={text}
      />
      <span className="strip-num" aria-hidden="true">
        {rate.used}/{rate.limit}
      </span>
    </>
  );
}

/** Dither wash in place of a chart while the next range loads. */
function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <DitherGradient from="indigo" direction="up" opacity={0.35} />
    </div>
  );
}

/** Wraps a chart so screen readers get one sentence instead of a canvas. */
function ChartFigure({
  summary,
  children,
}: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className="chart-fig" role="img" aria-label={summary}>
      {children}
    </div>
  );
}

/**
 * Ticks on its own so the charts above do not re-render every second (the kit
 * replays its entrance whenever `data` changes identity).
 */
function ResetCountdown({
  at,
  renderedAt,
  mounted,
  onElapsed,
}: {
  at: number;
  renderedAt: number;
  mounted: boolean;
  onElapsed: () => void;
}) {
  const now = useNow();
  // The server's clock until hydrated, so both renders print the same text.
  const left = at - (mounted ? now : renderedAt);
  const fired = useRef(0);
  useEffect(() => {
    if (!mounted || left > 0 || fired.current === at) return;
    fired.current = at;
    onElapsed();
  }, [mounted, left, at, onElapsed]);
  return <span className="muted">resets in {formatClock(left)}</span>;
}

export default function UsageView({
  initial,
  renderedAt,
}: {
  initial: ApiUsage;
  /** Server clock at render: the countdown prints this until hydrated. */
  renderedAt: number;
}) {
  const [usage, setUsage] = useState(initial);
  /** The checked range. Leads `usage.range` while the next range loads. */
  const [range, setRange] = useState<UsageRange>(initial.range);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{
    range: UsageRange;
    message: string;
  } | null>(null);
  const [metric, setMetric] = useState<Metric>("uploads");
  const [scope, setScope] = useState<Scope>("range");
  const [mounted, setMounted] = useState(false);
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  // Room for about four "27 Sep" labels on a phone-width plot.
  const narrow = useMedia("(max-width: 640px)");

  // Only the newest request may land, so a quick 7D→30D→90D ends on 90D.
  const seq = useRef(0);
  const userLoad = useRef(false);

  async function load(next: UsageRange, quiet = false): Promise<void> {
    // A user-picked range is already on its way with fresh numbers.
    if (quiet && userLoad.current) return;
    const id = ++seq.current;
    if (!quiet) {
      userLoad.current = true;
      setRange(next);
      setLoading(true);
      setError(null);
    }
    try {
      const fresh = await getJson<ApiUsage>(`/api/me/usage?range=${next}`);
      if (id !== seq.current) return;
      setUsage(fresh);
      setRange(fresh.range);
      const url = new URL(location.href);
      url.searchParams.set("range", fresh.range);
      history.replaceState(history.state, "", url);
    } catch (err) {
      if (id !== seq.current || quiet) return;
      setError({ range: next, message: (err as Error).message });
      // Keep the checked range honest about the numbers on screen.
      setRange(usage.range);
    } finally {
      if (id === seq.current) {
        userLoad.current = false;
        setLoading(false);
      }
    }
  }
  const latest = useRef({ load, range: usage.range });
  latest.current = { load, range: usage.range };
  /** Refetch the range on screen without a skeleton (reset, tray upload). */
  const refreshQuietly = useCallback(
    () => void latest.current.load(latest.current.range, true),
    [],
  );

  useEffect(() => setMounted(true), []);

  // An upload from the tray on this tab lands in filesStore; refresh quietly.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = filesStore.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(refreshQuietly, 400);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [refreshQuietly]);

  const { storage, totals, series, commands, rateLimits } = usage;
  const days = DAYS[usage.range];
  const limited =
    rateLimits.uploads.remaining !== null ||
    rateLimits.sessions.remaining !== null;

  // Keyed on content: a quiet refresh with the same numbers keeps each chart's
  // `data` identity, so it does not replay its entrance.
  const seriesKey = JSON.stringify(series);
  const commandsKey = JSON.stringify(commands);
  const maxBytes = useMemo(
    () => series.reduce((m, p) => Math.max(m, p.bytes), 0),
    [series],
  );
  const maxUploads = useMemo(
    () => series.reduce((m, p) => Math.max(m, p.uploads), 0),
    [series],
  );
  const [unit, unitSize] = byteUnit(maxBytes);
  const rows = useMemo(
    () =>
      series.map((p) => ({
        label: formatDay(p.date),
        uploads: p.uploads,
        // Plotted in one unit so d3's round ticks read as round sizes.
        bytes: p.bytes / unitSize,
      })),
    [seriesKey, unitSize],
  );
  const busiest = useMemo(
    () =>
      series.reduce<(typeof series)[number] | null>(
        (best, p) => (!best || p[metric] > best[metric] ? p : best),
        null,
      ),
    [series, metric],
  );

  const commandRows = useMemo(
    () =>
      Object.entries(scope === "range" ? commands.range : commands.allTime)
        .sort((a, b) => b[1] - a[1])
        .map(([command, count]) => ({ command: `/${command}`, count })),
    [commandsKey, scope],
  );
  const maxCommand = commandRows[0]?.count ?? 0;

  const mixTotal = storage.images.bytes + storage.videos.bytes;
  const share = (bytes: number) =>
    mixTotal > 0 ? Math.round((bytes / mixTotal) * 100) : 0;
  const imageBytes = storage.images.bytes;
  const videoBytes = storage.videos.bytes;
  const mix = useMemo(
    () => [
      { kind: "images", bytes: imageBytes },
      { kind: "videos", bytes: videoBytes },
    ],
    [imageBytes, videoBytes],
  );
  const mixConfig = useMemo<ChartConfig>(
    () => ({
      images: { label: `Images ${share(imageBytes)}%`, color: "cyan" },
      videos: { label: `Videos ${share(videoBytes)}%`, color: "gold" },
    }),
    [imageBytes, videoBytes],
  );

  const storagePct =
    storage.quota > 0 ? (storage.used / storage.quota) * 100 : 0;
  const uploadsDelta = formatDelta(totals.uploads, totals.prevUploads);
  const bytesDelta = formatDelta(totals.bytes, totals.prevBytes, formatBytes);
  const since = formatDay(
    new Date(usage.trackingSince).toISOString().slice(0, 10),
  );
  const period = `last ${days} days`;
  const metricName = metric === "uploads" ? "Uploads" : "Data in";

  const activitySummary =
    totals.uploads === 0
      ? `No uploads in the ${period}.`
      : `${metricName} per day, ${period}. Busiest: ${busiest ? formatDay(busiest.date) : ""}, ${
          metric === "uploads"
            ? plural(busiest?.uploads ?? 0, "upload")
            : formatBytes(busiest?.bytes ?? 0)
        }.`;
  const commandsSummary = `Command runs, ${
    scope === "range" ? period : "all time"
  }: ${commandRows.map((r) => `${r.command} ${r.count}`).join(", ")}.`;
  const mixSummary = `Images ${formatBytes(imageBytes)} (${share(imageBytes)}%), videos ${formatBytes(videoBytes)} (${share(videoBytes)}%).`;

  return (
    <MotionConfig reducedMotion="user">
      <main className="usage" aria-busy={loading}>
        <div className="usage-head">
          <Seg
            label="Range"
            value={range}
            options={RANGES}
            onChange={(r) => void load(r)}
          />
          <span className="muted">Commands tracked since {since}</span>
        </div>

        {error && (
          <div className="usage-error" role="alert">
            <p className="status error">
              Couldn't load {error.range.toUpperCase()}: {error.message}
            </p>
            <button
              type="button"
              className="button small"
              onClick={() => void load(error.range)}
            >
              Retry
            </button>
          </div>
        )}

        <div className="stats-grid">
          <Stat label="Storage" value={formatBytes(storage.used)}>
            <Meter
              value={storage.used}
              max={storage.quota}
              label="Storage used"
              text={`${formatBytes(storage.used)} of ${formatBytes(storage.quota)}`}
            />
            <span className="muted">
              of {formatBytes(storage.quota)} ·{" "}
              {storagePct > 0 && storagePct < 1 ? "<1" : Math.round(storagePct)}
              %
            </span>
          </Stat>
          <Stat
            label="Files"
            value={String(storage.images.count + storage.videos.count)}
          >
            <span className="muted">
              img {storage.images.count} · vid {storage.videos.count}
            </span>
          </Stat>
          <Stat label="Uploads" value={String(totals.uploads)} busy={loading}>
            <span className="muted">
              {period}
              <br />
              <span className={`delta-${uploadsDelta.dir}`}>
                {uploadsDelta.text}
              </span>
            </span>
          </Stat>
          <Stat
            label="Data in"
            value={formatBytes(totals.bytes)}
            busy={loading}
          >
            <span className="muted">
              {period}
              <br />
              <span className={`delta-${bytesDelta.dir}`}>
                {bytesDelta.text}
              </span>
            </span>
          </Stat>
        </div>

        <section className="panel" aria-labelledby="activity-h">
          <div className="chart-in">
            <header className="chart-head">
              <h2 id="activity-h">Activity</h2>
              <Seg
                label="Activity metric"
                value={metric}
                options={[
                  ["uploads", "Uploads"],
                  ["bytes", "Bytes"],
                ]}
                onChange={setMetric}
              />
            </header>
            <div className="chart-box">
              {loading ? (
                <Skeleton />
              ) : totals.uploads === 0 ? (
                <p className="chart-empty">
                  No uploads in the {period}. Drop a file anywhere to start.
                </p>
              ) : (
                <ChartFigure summary={activitySummary}>
                  <AreaChart
                    key={usage.range}
                    data={rows}
                    config={{
                      [metric]: { label: metricName, color: "cyan" },
                    }}
                    margins={MARGINS}
                    animate={!reduced}
                    bloom={reduced ? "off" : "low"}
                  >
                    <Grid
                      tickCount={
                        metric === "uploads" ? countTicks(maxUploads) : 4
                      }
                    />
                    <XAxis
                      dataKey="label"
                      maxTicks={narrow ? 4 : usage.range === "7d" ? 7 : 6}
                    />
                    <YAxis
                      tickCount={
                        metric === "uploads" ? countTicks(maxUploads) : 4
                      }
                      tickFormatter={
                        metric === "bytes"
                          ? (n) => (n === 0 ? "0" : `${n} ${unit}`)
                          : (n) => String(n)
                      }
                    />
                    <Area dataKey={metric} variant="gradient" />
                    <Tooltip
                      labelKey="label"
                      valueFormatter={
                        metric === "bytes"
                          ? (v) => formatBytes(Math.round(v * unitSize))
                          : (v) => String(v)
                      }
                    />
                  </AreaChart>
                </ChartFigure>
              )}
            </div>
          </div>
        </section>

        <div className="chart-row">
          <section className="panel" aria-labelledby="commands-h">
            <div className="chart-in">
              <header className="chart-head">
                <h2 id="commands-h">Commands</h2>
                <Seg
                  label="Command period"
                  value={scope}
                  options={[
                    ["range", usage.range.toUpperCase()],
                    ["allTime", "All"],
                  ]}
                  onChange={setScope}
                />
              </header>
              <div className="chart-box">
                {loading ? (
                  <Skeleton />
                ) : commandRows.length === 0 ? (
                  <p className="chart-empty">
                    {scope === "range"
                      ? `No commands in the ${period}.`
                      : "No commands yet. Try /upload in Discord."}
                  </p>
                ) : (
                  <ChartFigure summary={commandsSummary}>
                    <BarChart
                      key={`${usage.range}-${scope}`}
                      data={commandRows}
                      config={{ count: { label: "Runs", color: "indigo" } }}
                      animate={!reduced}
                      bloom={reduced ? "off" : "low"}
                    >
                      <Grid tickCount={countTicks(maxCommand)} />
                      <XAxis dataKey="command" />
                      <YAxis tickCount={countTicks(maxCommand)} />
                      <Bar dataKey="count" />
                      <Tooltip labelKey="command" />
                    </BarChart>
                  </ChartFigure>
                )}
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="mix-h">
            <div className="chart-in">
              <header className="chart-head">
                <h2 id="mix-h">Storage mix</h2>
              </header>
              <div className="chart-box">
                {mixTotal === 0 ? (
                  <p className="chart-empty">Nothing stored yet.</p>
                ) : (
                  <ChartFigure summary={mixSummary}>
                    <PieChart
                      data={mix}
                      dataKey="bytes"
                      nameKey="kind"
                      innerRadius={0.55}
                      config={mixConfig}
                      animate={!reduced}
                      bloom={reduced ? "off" : "low"}
                    >
                      <Pie />
                      <Legend />
                      <Tooltip valueFormatter={(v) => formatBytes(v)} />
                    </PieChart>
                  </ChartFigure>
                )}
              </div>
            </div>
          </section>
        </div>

        <section className="panel" aria-labelledby="limits-h">
          <div className="chart-in">
            <header className="chart-head">
              <h2 id="limits-h">Limits this hour</h2>
              {limited && (
                <ResetCountdown
                  at={rateLimits.uploads.resetAt}
                  renderedAt={renderedAt}
                  mounted={mounted}
                  onElapsed={refreshQuietly}
                />
              )}
            </header>
            <div className="limits-in">
              <LimitRow name="Uploads" rate={rateLimits.uploads} />
              <LimitRow name="Links opened" rate={rateLimits.sessions} />
            </div>
          </div>
        </section>
      </main>
    </MotionConfig>
  );
}

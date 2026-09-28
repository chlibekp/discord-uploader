export { formatBytes, formatDate } from "@server/web/format";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-09-27" → "27 Sep". Parsed as UTC so the label matches the server's bucket. */
export function formatDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDelta(
  cur: number,
  prev: number,
  fmt: (n: number) => string = String,
): { text: string; dir: "up" | "down" | "flat" } {
  if (cur === prev) return { text: "same as prev", dir: "flat" };
  const up = cur > prev;
  return {
    text: `${up ? "▲" : "▼"} ${fmt(Math.abs(cur - prev))} vs prev`,
    dir: up ? "up" : "down",
  };
}

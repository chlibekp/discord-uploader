import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

const CGROUP = "/sys/fs/cgroup";

async function readNum(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (raw === "" || raw === "max") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Total CPU time consumed by this cgroup, in microseconds. */
async function cgroupCpuUsageUsec(): Promise<number | null> {
  try {
    const stat = await readFile(`${CGROUP}/cpu.stat`, "utf8");
    const m = stat.match(/^usage_usec (\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** vCPU allowance from the cgroup v2 cpu.max quota, or null if unlimited. */
async function cgroupCpuLimit(): Promise<number | null> {
  try {
    const raw = (await readFile(`${CGROUP}/cpu.max`, "utf8")).trim();
    const [quota, period] = raw.split(/\s+/);
    if (quota === "max") return null;
    const q = Number(quota);
    const p = Number(period) || 100_000;
    return q > 0 && p > 0 ? q / p : null;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface InfraReport {
  region: string;
  host: string;
  runtime: string;
  cpu: string;
  memory: string;
  disk: string;
  uptime: string;
  installs: string;
}

/**
 * Discord's approximated install count for this application, refreshed daily on
 * their side. Best-effort: a failed request or missing token yields null and the
 * line is omitted from the report.
 */
async function collectInstalls(botToken: string | undefined): Promise<string | null> {
  if (!botToken) return null;
  try {
    const res = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!res.ok) return null;
    const app = (await res.json()) as {
      approximate_guild_count?: number;
      approximate_user_install_count?: number;
    };
    const guilds = app.approximate_guild_count ?? 0;
    const users = app.approximate_user_install_count ?? 0;
    return `~${guilds} server${guilds === 1 ? "" : "s"}, ~${users} individual user${
      users === 1 ? "" : "s"
    } (updated daily)`;
  } catch {
    return null;
  }
}

/**
 * Best-effort snapshot of the container the bot runs in. Every probe is
 * individually guarded: a missing cgroup file (e.g. on macOS in dev) falls back
 * to host-level numbers from `os` rather than failing the command.
 */
export async function collectInfra(
  dataDir: string,
  botToken?: string,
): Promise<InfraReport> {
  const env = process.env;
  const region =
    env.RAILWAY_REPLICA_REGION ||
    env.RAILWAY_REGION ||
    env.FLY_REGION ||
    env.REGION ||
    "unknown";

  const hostCpus = os.cpus().length;

  // CPU: sample the cgroup usage counter across a short window to get a live
  // utilisation figure, then express it against the quota (or host core count).
  const limit = await cgroupCpuLimit();
  const totalCpus = limit ?? hostCpus;
  const u1 = await cgroupCpuUsageUsec();
  let cpuLine: string;
  if (u1 !== null) {
    await new Promise((r) => setTimeout(r, 200));
    const u2 = await cgroupCpuUsageUsec();
    const busyCpus = u2 !== null ? (u2 - u1) / 200_000 : 0;
    const pct = totalCpus > 0 ? (busyCpus / totalCpus) * 100 : 0;
    cpuLine = `${busyCpus.toFixed(2)} / ${totalCpus} vCPU in use (${pct.toFixed(0)}%), load ${os
      .loadavg()
      .map((n) => n.toFixed(2))
      .join(" ")}`;
  } else {
    const load1 = os.loadavg()[0] ?? 0;
    const pct = hostCpus > 0 ? (load1 / hostCpus) * 100 : 0;
    cpuLine = `${load1.toFixed(2)} / ${hostCpus} vCPU load avg (${pct.toFixed(0)}%)`;
  }

  // Memory: prefer the cgroup's own accounting, fall back to host totals.
  const memCurrent = await readNum(`${CGROUP}/memory.current`);
  const memMax = await readNum(`${CGROUP}/memory.max`);
  let memLine: string;
  if (memCurrent !== null) {
    const limitBytes = memMax ?? os.totalmem();
    const pct = limitBytes > 0 ? (memCurrent / limitBytes) * 100 : 0;
    memLine = `${fmtBytes(memCurrent)} / ${fmtBytes(limitBytes)} (${pct.toFixed(0)}%)`;
  } else {
    const used = os.totalmem() - os.freemem();
    const pct = (used / os.totalmem()) * 100;
    memLine = `${fmtBytes(used)} / ${fmtBytes(os.totalmem())} (${pct.toFixed(0)}%)`;
  }
  const rss = process.memoryUsage().rss;
  memLine += `, process RSS ${fmtBytes(rss)}`;

  // Disk usage on the volume that holds uploads.
  let diskLine = "unavailable";
  try {
    const fs = await statfs(dataDir);
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const used = total - free;
    const pct = total > 0 ? (used / total) * 100 : 0;
    diskLine = `${fmtBytes(used)} / ${fmtBytes(total)} used (${pct.toFixed(0)}%), ${fmtBytes(
      free,
    )} free`;
  } catch {
    /* keep "unavailable" */
  }

  const installs = await collectInstalls(botToken);

  return {
    region,
    host: `${os.type()} ${os.release()} ${os.arch()}, ${hostCpus} host cores`,
    runtime: `Node ${process.version}, pid ${process.pid}`,
    cpu: cpuLine,
    memory: memLine,
    disk: `${dataDir}: ${diskLine}`,
    uptime: `process ${fmtDuration(process.uptime())}, host ${fmtDuration(os.uptime())}`,
    installs: installs ?? "unavailable",
  };
}

export function formatInfra(r: InfraReport): string {
  return [
    "**Infrastructure**",
    `**Region:** ${r.region}`,
    `**Host:** ${r.host}`,
    `**Runtime:** ${r.runtime}`,
    `**CPU:** ${r.cpu}`,
    `**Memory:** ${r.memory}`,
    `**Disk:** ${r.disk}`,
    `**Uptime:** ${r.uptime}`,
    `**Installs:** ${r.installs}`,
  ].join("\n");
}

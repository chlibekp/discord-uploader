import type { Config } from "../config.js";
import type { InfraReport } from "../infra.js";
import type { AdminStorage, AdminUser } from "../storage/admin.js";
import type { UsageStats } from "../storage/usage.js";
import { brandedEmbed, formatBytes, formatPct, type Embed } from "./embeds.js";

export const ADMIN_PANELS = ["users", "storage", "commands", "system"] as const;
export type AdminPanel = (typeof ADMIN_PANELS)[number];

/** Rows per page of the user list. Ten keeps the embed well inside its limits. */
export const USERS_PER_PAGE = 10;

const PANEL_LABELS: Record<AdminPanel, string> = {
  users: "👥 Users",
  storage: "💾 Storage",
  commands: "⌨️ Commands",
  system: "🛠 System",
};

export function isAdminPanel(value: string): value is AdminPanel {
  return (ADMIN_PANELS as readonly string[]).includes(value);
}

export function isAdmin(config: Config, userId: string | undefined): boolean {
  return !!userId && config.adminUserIds.includes(userId);
}

/** Discord renders this as a locale-aware relative time ("3 days ago"). */
function relative(ms: number): string {
  return ms > 0 ? `<t:${Math.floor(ms / 1000)}:R>` : "never";
}

export interface AdminData {
  users: AdminUser[];
  storage: AdminStorage;
  usage: UsageStats;
  infra?: InfraReport | undefined;
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / USERS_PER_PAGE));
}

/** Clamp a requested page into range, so a stale button can never overshoot. */
export function clampPage(page: number, total: number): number {
  return Math.min(Math.max(0, page), pageCount(total) - 1);
}

export function buildAdminEmbed(
  panel: AdminPanel,
  page: number,
  data: AdminData,
  config: Config,
): Embed {
  if (panel === "users") return usersEmbed(page, data.users);
  if (panel === "storage") return storageEmbed(data.storage, config);
  if (panel === "commands") return commandsEmbed(data.usage);
  return systemEmbed(data.infra);
}

function usersEmbed(page: number, users: AdminUser[]): Embed {
  const pages = pageCount(users.length);
  const start = page * USERS_PER_PAGE;
  const slice = users.slice(start, start + USERS_PER_PAGE);

  const lines = slice.map((u, i) => {
    // The mention resolves to a name for anyone the client knows, and the raw
    // id stays visible so an unknown account is still identifiable.
    return (
      `**${start + i + 1}.** <@${u.userId}> \`${u.userId}\`\n` +
      ` ${u.files} file${u.files === 1 ? "" : "s"} · ` +
      `${formatBytes(u.bytes)} · last upload ${relative(u.lastUpload)}`
    );
  });

  return brandedEmbed({
    title: "🛡 Admin — Users",
    description:
      users.length === 0
        ? "No users have used the bot yet."
        : `**${users.length}** known user${users.length === 1 ? "" : "s"}, ` +
          `heaviest first — page **${page + 1}/${pages}**.\n\n` +
          lines.join("\n"),
  });
}

function storageEmbed(storage: AdminStorage, config: Config): Embed {
  const quota = config.maxTotalBytes;
  const pct = quota > 0 ? (storage.totalBytes / quota) * 100 : 0;

  const topUsers = storage.topUsers.length
    ? storage.topUsers
        .map((u) => `<@${u.userId}> — ${formatBytes(u.bytes)} (${u.files})`)
        .join("\n")
    : "none";

  const largest = storage.largestFiles.length
    ? storage.largestFiles
        .map((f) => `\`${f.id}\` ${formatBytes(f.size)} · <@${f.userId}>`)
        .join("\n")
    : "none";

  return brandedEmbed({
    title: "🛡 Admin — Storage",
    description:
      `**${formatBytes(storage.totalBytes)}** of **${formatBytes(quota)}** ` +
      `(${formatPct(pct)}) across **${storage.totalFiles}** file` +
      `${storage.totalFiles === 1 ? "" : "s"}.`,
    fields: [
      {
        name: "Users holding files",
        value: String(storage.usersWithFiles),
        inline: true,
      },
      {
        name: "Per-user quota",
        value: formatBytes(config.maxUserBytes),
        inline: true,
      },
      { name: "Top users", value: topUsers },
      { name: "Largest files (recent 500)", value: largest },
    ],
  });
}

function commandsEmbed(usage: UsageStats): Embed {
  const entries = Object.entries(usage.byCommand);
  const breakdown = entries.length
    ? entries
        .map(([name, count]) => {
          const share = usage.commands > 0 ? (count / usage.commands) * 100 : 0;
          return `\`/${name}\` — **${count.toLocaleString("en-US")}** (${formatPct(share)})`;
        })
        .join("\n")
    : "No commands recorded yet.";

  return brandedEmbed({
    title: "🛡 Admin — Commands",
    description:
      `**${usage.commands.toLocaleString("en-US")}** command` +
      `${usage.commands === 1 ? "" : "s"} run by ` +
      `**${usage.activeUsers.toLocaleString("en-US")}** user` +
      `${usage.activeUsers === 1 ? "" : "s"}.\n\n${breakdown}`,
  });
}

function systemEmbed(infra: InfraReport | undefined): Embed {
  if (!infra) {
    return brandedEmbed({
      title: "🛡 Admin — System",
      description: "System details are unavailable right now.",
    });
  }
  return brandedEmbed({
    title: "🛡 Admin — System",
    fields: [
      { name: "Region", value: infra.region },
      { name: "Host", value: infra.host },
      { name: "Runtime", value: infra.runtime },
      { name: "CPU", value: infra.cpu },
      { name: "Memory", value: infra.memory },
      { name: "Disk", value: infra.disk },
      { name: "Uptime", value: infra.uptime },
      { name: "Installs", value: infra.installs },
    ],
  });
}

/**
 * Panel switches on the first row, user-list paging on the second. The active
 * panel's button is disabled rather than hidden, so the row never reflows.
 */
export function buildAdminComponents(
  panel: AdminPanel,
  page: number,
  userCount: number,
): unknown[] {
  const rows: unknown[] = [
    {
      type: 1,
      components: ADMIN_PANELS.map((p) => ({
        type: 2,
        style: p === panel ? 1 : 2,
        label: PANEL_LABELS[p],
        custom_id: `admin:${p}:0`,
        disabled: p === panel,
      })),
    },
  ];

  if (panel === "users") {
    const pages = pageCount(userCount);
    rows.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "◀ Prev",
          custom_id: `admin:users:${page - 1}`,
          disabled: page <= 0,
        },
        {
          type: 2,
          style: 2,
          label: `Page ${page + 1}/${pages}`,
          custom_id: "admin:noop:0",
          disabled: true,
        },
        {
          type: 2,
          style: 2,
          label: "Next ▶",
          custom_id: `admin:users:${page + 1}`,
          disabled: page >= pages - 1,
        },
      ],
    });
  }

  return rows;
}

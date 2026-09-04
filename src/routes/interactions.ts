import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { verifyInteractionSignature } from "../discord/verify.js";
import { createSession } from "../storage/sessions.js";
import { collectInfra } from "../infra.js";
import {
  brandedEmbed,
  buildInfraEmbed,
  formatPct,
  progressBar,
} from "../discord/embeds.js";
import { ttlValueToMs, describeTtl } from "../ttl.js";
import { deleteInteractionMessage } from "../discord/followup.js";
import {
  deleteRecord,
  expireDue,
  getRecord,
  listUserFiles,
  userBytes,
} from "../storage/store.js";
import { checkRateLimit, minutesUntil } from "../storage/ratelimit.js";
import { getUsageStats, recordCommandUse } from "../storage/usage.js";

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_UPDATE_MESSAGE = 6;
const EPHEMERAL = 64;

const SUPPORT_URL = "https://imageuploader.xyz/support";

export function interactionsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/interactions", async (c) => {
    // Signature is checked against the exact bytes Discord signed, before the
    // body is parsed and before anything else touches the request.
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const valid = verifyInteractionSignature({
      publicKey: deps.config.discordPublicKey,
      signature: c.req.header("X-Signature-Ed25519"),
      timestamp: c.req.header("X-Signature-Timestamp"),
      rawBody,
    });
    if (!valid) {
      // Discord validates an endpoint by sending both a correctly signed PING
      // and a deliberately corrupted one, so a 401 here is expected traffic.
      // The key fingerprint is logged because a mismatch against the portal is
      // the usual reason a genuine PING gets rejected.
      console.warn(
        "Rejected interaction signature " +
          `(sig=${c.req.header("X-Signature-Ed25519") ? "present" : "missing"}, ` +
          `ts=${c.req.header("X-Signature-Timestamp") ? "present" : "missing"}, ` +
          `bytes=${rawBody.length}, ` +
          `publicKey=${deps.config.discordPublicKey.slice(0, 8)}…${deps.config.discordPublicKey.slice(-4)})`,
      );
      return c.body(null, 401);
    }

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return c.json({ error: "Malformed JSON" }, 400);
    }

    if (body.type === PING) return c.json({ type: PONG });

    if (body.type === MESSAGE_COMPONENT) {
      return c.json(await handleComponent(deps, body));
    }

    const command: string | undefined = body.data?.name;
    if (
      body.type !== APPLICATION_COMMAND ||
      (command !== "upload" &&
        command !== "gallery" &&
        command !== "help" &&
        command !== "info" &&
        command !== "stats" &&
        command !== "support")
    ) {
      return c.json({ error: "Unsupported interaction" }, 400);
    }

    const userId: string | undefined = body.member?.user?.id ?? body.user?.id;
    const channelId: string | undefined = body.channel_id;

    // Counted for every accepted command, including the ones that reply without
    // touching storage. A broken counter must not cost the user their command,
    // so a failure here is logged and swallowed.
    try {
      await recordCommandUse(deps.redis, command, userId);
    } catch (err) {
      console.error(`Failed to record usage for /${command}:`, err);
    }

    if (command === "help") {
      return c.json(
        embedReply(
          brandedEmbed({
            title: "📤 ImageUploader — Commands",
            description: [
              "`/upload` — Upload an image or video (optional `ttl` to auto-delete)",
              "`/gallery` — Browse everything you have uploaded",
              "`/stats` — Show how much you have stored",
              "`/info` — Show infrastructure, resource usage, installs, and bot usage",
              "`/support` — Get a link to the support page",
              "`/help` — Show this help message",
            ].join("\n"),
          }),
        ),
      );
    }

    if (command === "support") {
      return c.json(
        embedReply(
          brandedEmbed({
            title: "🆘 ImageUploader — Support",
            description: `Need a hand? Visit the [support page](${SUPPORT_URL}).`,
          }),
          [
            {
              type: 1,
              components: [
                {
                  type: 2,
                  style: 5,
                  label: "Open support page",
                  url: SUPPORT_URL,
                },
              ],
            },
          ],
        ),
      );
    }

    if (command === "info") {
      const [report, usage] = await Promise.all([
        collectInfra(deps.config.dataDir, deps.config.discordBotToken),
        getUsageStats(deps.redis),
      ]);
      return c.json(embedReply(buildInfraEmbed(report, usage)));
    }

    if (!userId || !channelId) {
      return c.json(
        ephemeral("Could not determine who or where you are. Try again."),
      );
    }

    if (command === "stats") {
      await expireDue(deps.redis, deps.config);
      const files = await listUserFiles(deps.redis, userId, 1000);
      const used = await userBytes(deps.redis, userId);
      const quota = deps.config.maxUserBytes;
      const pct = quota > 0 ? (used / quota) * 100 : 0;
      if (files.length === 0) {
        return c.json(
          embedReply(
            brandedEmbed({
              title: "📊 ImageUploader — Your storage",
              description:
                `You have nothing stored yet. Quota: **${formatBytes(quota)}**.\n` +
                "```\n" +
                progressBar(0) +
                "\n```",
            }),
          ),
        );
      }
      const times = files.map((f) => f.createdAt).sort((a, b) => a - b);
      const soonest = files
        .filter((f) => f.expiresAt > 0)
        .map((f) => f.expiresAt)
        .sort((a, b) => a - b)[0];
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      return c.json(
        embedReply(
          brandedEmbed({
            title: "📊 ImageUploader — Your storage",
            description:
              `You've used **${formatBytes(used)}** of **${formatBytes(quota)}** ` +
              `(${formatPct(pct)}) across **${files.length}** file${files.length === 1 ? "" : "s"}.\n` +
              "```\n" +
              progressBar(pct) +
              "\n```",
            fields: [
              { name: "Files", value: String(files.length), inline: true },
              {
                name: "Used",
                value: `${formatBytes(used)} / ${formatBytes(quota)}`,
                inline: true,
              },
              { name: "Oldest", value: day(times[0]!), inline: true },
              {
                name: "Newest",
                value: day(times[times.length - 1]!),
                inline: true,
              },
              {
                name: "Next auto-delete",
                value: soonest ? day(soonest) : "none scheduled",
                inline: true,
              },
            ],
          }),
        ),
      );
    }

    // Minting a session is the abuse surface here: each one is a fresh
    // ephemeral link, so this is checked before creating one rather than
    // after, and the reply looks exactly like the normal command reply.
    const limit = await checkRateLimit(
      deps.redis,
      "session",
      userId,
      deps.config.rateLimitSessionsPerHour,
    );
    if (!limit.allowed) {
      return c.json(
        ephemeral(
          `You're opening links too quickly. Try again in ${minutesUntil(limit.resetAt)} minute(s).`,
        ),
      );
    }

    const ttlMs =
      command === "upload"
        ? ttlValueToMs(
            (
              body.data?.options as
                { name: string; value: string }[] | undefined
            )?.find((o) => o.name === "ttl")?.value,
          )
        : 0;

    let session;
    try {
      session = await createSession(deps.redis, {
        kind: command === "gallery" ? "gallery" : "upload",
        userId,
        channelId,
        guildId: body.guild_id ?? "",
        interactionToken: body.token,
        ttlMs,
      });
    } catch (err) {
      console.error(`Failed to create ${command} session:`, err);
      return c.json({ error: "Session store unavailable" }, 503);
    }

    const minutes = Math.floor(
      (session.expiresAt - session.createdAt) / 60_000,
    );
    const gallery = session.kind === "gallery";
    const url = `${deps.config.publicUrl}/${gallery ? "g" : "u"}/${session.sid}`;

    return c.json(
      embedReply(
        brandedEmbed({
          title: gallery
            ? "🖼 ImageUploader — Gallery"
            : "📥 ImageUploader — Upload",
          description: gallery
            ? `Your uploads are behind the link below. ` +
              `It opens once and expires in **${minutes} minutes**.`
            : `Open the link below to upload an image or video. ` +
              `The link works once and expires in **${minutes} minutes**. ` +
              `Uploaded file ${describeTtl(session.ttlMs)}.`,
        }),
        [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 5,
                label: gallery ? "Open gallery" : "Open upload page",
                url,
              },
            ],
          },
        ],
      ),
    );
  });

  return app;
}

function ephemeral(content: string) {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: EPHEMERAL, content },
  };
}

function embedReply(embed: unknown, components?: unknown[]) {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL,
      embeds: [embed],
      ...(components ? { components } : {}),
    },
  };
}

/**
 * The Delete button on a posted upload. Only the original uploader may spend it;
 * anyone else gets a private notice and the message is left untouched. On
 * success the file is removed and the whole channel message is deleted.
 */
async function handleComponent(deps: AppDeps, body: any) {
  const [action, id] = String(body.data?.custom_id ?? "").split(":");
  if (action !== "del" || !id) {
    return ephemeral("That button no longer does anything.");
  }

  const userId: string | undefined = body.member?.user?.id ?? body.user?.id;
  const record = await getRecord(deps.redis, id);

  if (record && (!userId || record.userId !== userId)) {
    return ephemeral("Only the person who uploaded this can delete it.");
  }

  // A component interaction must be acknowledged within 3 seconds. Deleting the
  // file and calling Discord back to remove the message both take longer than
  // that budget allows, so they run after the ack rather than before it.
  void finishButtonDelete(deps, body.token, id, record !== null).catch(
    (err) => {
      console.error(`Delete-button cleanup failed for ${id}:`, err);
    },
  );

  return { type: DEFERRED_UPDATE_MESSAGE };
}

async function finishButtonDelete(
  deps: AppDeps,
  interactionToken: string,
  id: string,
  hadRecord: boolean,
): Promise<void> {
  if (hadRecord) {
    await deleteRecord(deps.redis, deps.config, id);
    console.log(`Deleted ${id} via the message button`);
  }
  await deleteInteractionMessage(deps.config, interactionToken, deps.fetch);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

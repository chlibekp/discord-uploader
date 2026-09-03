import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { verifyInteractionSignature } from "../discord/verify.js";
import { createSession } from "../storage/sessions.js";
import { collectInfra, formatInfra } from "../infra.js";
import { ttlValueToMs, describeTtl } from "../ttl.js";
import { expireDue, listUserFiles, userBytes } from "../storage/store.js";

const PING = 1;
const APPLICATION_COMMAND = 2;

const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const EPHEMERAL = 64;

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

    const command: string | undefined = body.data?.name;
    if (
      body.type !== APPLICATION_COMMAND ||
      (command !== "upload" &&
        command !== "gallery" &&
        command !== "help" &&
        command !== "info" &&
        command !== "stats")
    ) {
      return c.json({ error: "Unsupported interaction" }, 400);
    }

    if (command === "help") {
      return c.json({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: EPHEMERAL,
          content:
            "Available commands:\n/upload - Upload an image or video (optional ttl to auto-delete)\n/gallery - Browse everything you have uploaded\n/stats - Show how much you have stored\n/info - Show infrastructure and resource usage\n/help - Show this help message",
        },
      });
    }

    if (command === "info") {
      const report = await collectInfra(deps.config.dataDir);
      return c.json({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL, content: formatInfra(report) },
      });
    }

    const userId: string | undefined = body.member?.user?.id ?? body.user?.id;
    const channelId: string | undefined = body.channel_id;
    if (!userId || !channelId) {
      return c.json(ephemeral("Could not determine who or where you are. Try again."));
    }

    if (command === "stats") {
      await expireDue(deps.redis, deps.config);
      const files = await listUserFiles(deps.redis, userId, 1000);
      const used = await userBytes(deps.redis, userId);
      const quota = deps.config.maxUserBytes;
      if (files.length === 0) {
        return c.json(ephemeral(`You have nothing stored. Quota: ${formatBytes(quota)}.`));
      }
      const times = files.map((f) => f.createdAt).sort((a, b) => a - b);
      const soonest = files
        .filter((f) => f.expiresAt > 0)
        .map((f) => f.expiresAt)
        .sort((a, b) => a - b)[0];
      return c.json(
        ephemeral(
          [
            `**Your storage**`,
            `**Files:** ${files.length}`,
            `**Used:** ${formatBytes(used)} / ${formatBytes(quota)} (${Math.round((used / quota) * 100)}%)`,
            `**Oldest:** ${new Date(times[0]!).toISOString().slice(0, 10)}`,
            `**Newest:** ${new Date(times[times.length - 1]!).toISOString().slice(0, 10)}`,
            soonest
              ? `**Next auto-delete:** ${new Date(soonest).toISOString().slice(0, 10)}`
              : `**Next auto-delete:** none scheduled`,
          ].join("\n"),
        ),
      );
    }

    const ttlMs =
      command === "upload"
        ? ttlValueToMs(
            (body.data?.options as { name: string; value: string }[] | undefined)?.find(
              (o) => o.name === "ttl",
            )?.value,
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

    const minutes = Math.floor((session.expiresAt - session.createdAt) / 60_000);
    const gallery = session.kind === "gallery";
    const url = `${deps.config.publicUrl}/${gallery ? "g" : "u"}/${session.sid}`;

    return c.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: EPHEMERAL,
        content: gallery
          ? `Your uploads are behind the link below. ` +
            `It opens once and expires in ${minutes} minutes.`
          : `Open the link below to upload an image or video. ` +
            `The link works once and expires in ${minutes} minutes. ` +
            `Uploaded file ${describeTtl(session.ttlMs)}.`,
        components: [
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
      },
    });
  });

  return app;
}

function ephemeral(content: string) {
  return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL, content } };
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

import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { verifyInteractionSignature } from "../discord/verify.js";
import { createSession } from "../storage/sessions.js";

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
    if (body.type !== APPLICATION_COMMAND || (command !== "upload" && command !== "gallery")) {
      return c.json({ error: "Unsupported interaction" }, 400);
    }

    const userId: string | undefined = body.member?.user?.id ?? body.user?.id;
    const channelId: string | undefined = body.channel_id;
    if (!userId || !channelId) {
      return c.json(ephemeral("Could not determine who or where you are. Try again."));
    }

    let session;
    try {
      session = await createSession(deps.redis, {
        kind: command === "gallery" ? "gallery" : "upload",
        userId,
        channelId,
        guildId: body.guild_id ?? "",
        interactionToken: body.token,
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
            `The link works once and expires in ${minutes} minutes.`,
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

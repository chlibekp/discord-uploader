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
    if (!valid) return c.body(null, 401);

    let body: any;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return c.json({ error: "Malformed JSON" }, 400);
    }

    if (body.type === PING) return c.json({ type: PONG });

    if (body.type !== APPLICATION_COMMAND || body.data?.name !== "upload") {
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
        userId,
        channelId,
        guildId: body.guild_id ?? "",
        interactionToken: body.token,
      });
    } catch (err) {
      console.error("Failed to create upload session:", err);
      return c.json({ error: "Session store unavailable" }, 503);
    }

    const url = `${deps.config.publicUrl}/u/${session.sid}`;
    const minutes = Math.floor((session.expiresAt - session.createdAt) / 60_000);

    return c.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: EPHEMERAL,
        content:
          `Open the link below to upload an image or video. ` +
          `The link works once and expires in ${minutes} minutes.`,
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 5, label: "Open upload page", url }],
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

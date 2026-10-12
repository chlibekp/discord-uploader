import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { rememberVote, verifyWebhookSignature } from "../topgg.js";

/**
 * Top.gg posts here when someone votes. Caching the vote means the next
 * /upload sees it without calling Top.gg. Any non-2xx is retried by Top.gg,
 * so only a bad signature gets one; payloads we do not use are acknowledged.
 */
export function topggRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/topgg/webhook", async (c) => {
    const secret = deps.config.topggWebhookSecret;
    if (!secret) return c.body(null, 404);

    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (
      !verifyWebhookSignature(
        rawBody,
        c.req.header("x-topgg-signature"),
        secret,
      )
    ) {
      console.warn("Rejected Top.gg webhook signature");
      return c.body(null, 401);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return c.body(null, 204);
    }

    const userId: unknown = event?.data?.user?.platform_id;
    if (event?.type === "vote.create" && typeof userId === "string") {
      if (await rememberVote(deps.redis, userId, event.data.expires_at ?? "")) {
        console.log(`Recorded Top.gg vote from ${userId}`);
      }
    }
    return c.body(null, 204);
  });

  return app;
}

import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import {
  buildFollowupPayload,
  fileUrl,
  postFollowup,
  watchUrl,
} from "../discord/followup.js";
import {
  declaredTooLarge,
  ingestUpload,
  UploadError,
} from "../storage/ingest.js";
import { checkRateLimit, minutesUntil } from "../storage/ratelimit.js";
import {
  claimSession,
  deleteSession,
  getSession,
} from "../storage/sessions.js";
import type { FileRecord, UploadSession } from "../types.js";

/** An interaction token is usable for 15 minutes from the command. */
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

export function uploadRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/u/:sid/file", async (c) => {
    const sid = c.req.param("sid");
    if (declaredTooLarge(c, deps.config)) {
      return c.json({ error: "File exceeds the size limit" }, 413);
    }

    // Peeked rather than claimed, so a rate-limited request leaves the
    // single-use link intact for the caller to retry once the window turns
    // over instead of burning it here.
    const peeked = await getSession(deps.redis, sid);
    if (peeked && peeked.kind === "upload") {
      const limit = await checkRateLimit(
        deps.redis,
        "upload",
        peeked.userId,
        deps.config.rateLimitUploadsPerHour,
      );
      if (!limit.allowed) {
        return c.json(
          {
            error: `You're uploading too quickly. Try again in ${minutesUntil(limit.resetAt)} minute(s).`,
            retryAfterSeconds: Math.ceil((limit.resetAt - Date.now()) / 1000),
          },
          429,
        );
      }
    }

    const claim = await claimSession(deps.redis, sid);
    if (claim.status === "missing") {
      return c.json({ error: "This upload link has expired" }, 404);
    }
    if (claim.status === "claimed") {
      return c.json({ error: "This upload link has already been used" }, 409);
    }
    // A gallery session must not be spendable as an upload slot.
    if (claim.session.kind !== "upload") {
      return c.json({ error: "This upload link has expired" }, 404);
    }

    const session = claim.session;
    let record: FileRecord;
    try {
      record = await ingestUpload(c, deps, {
        userId: session.userId,
        channelId: session.channelId,
        ttlMs: () => session.ttlMs,
      });
    } catch (err) {
      if (err instanceof UploadError)
        return c.json({ error: err.message }, err.status as 400);
      console.error("Upload failed:", err);
      return c.json({ error: "Upload failed" }, 500);
    }

    const posted = await maybePost(deps, session, record);
    await deleteSession(deps.redis, sid);

    return c.json({
      posted,
      url:
        record.kind === "video"
          ? watchUrl(deps.config, record)
          : fileUrl(deps.config, record),
      fileUrl: fileUrl(deps.config, record),
      kind: record.kind,
    });
  });

  return app;
}

/**
 * Post the result back to the channel, unless the interaction token has already
 * expired. The file is kept either way; the page shows the link when this
 * returns false.
 */
async function maybePost(
  deps: AppDeps,
  session: UploadSession,
  record: FileRecord,
): Promise<boolean> {
  if (Date.now() - session.createdAt >= TOKEN_LIFETIME_MS) {
    console.warn(
      `Interaction token for session ${session.sid} expired before upload finished`,
    );
    return false;
  }
  const payload = buildFollowupPayload(deps.config, record);
  return postFollowup(
    deps.config,
    session.interactionToken,
    payload,
    deps.fetch,
  );
}

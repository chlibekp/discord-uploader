import { Hono } from "hono";
import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppDeps } from "../app.js";
import { UPLOAD_PAGE_CSP, assets } from "../assets.js";
import { expiredShell } from "../pages.js";
import {
  buildFollowupPayload,
  fileUrl,
  postFollowup,
  watchUrl,
} from "../discord/followup.js";
import { requestNodeStream } from "../http/body.js";
import { sweep } from "../storage/lru.js";
import { checkRateLimit, minutesUntil } from "../storage/ratelimit.js";
import {
  claimSession,
  deleteSession,
  getSession,
  newId,
} from "../storage/sessions.js";
import { SNIFF_BYTES, slugifyBasename, sniff } from "../storage/sniff.js";
import {
  deleteRecord,
  expireDue,
  fileDir,
  listUserIdsOldestFirst,
  saveRecord,
  userBytes,
} from "../storage/store.js";
import type { FileRecord, SniffResult, UploadSession } from "../types.js";

/** An interaction token is usable for 15 minutes from the command. */
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function uploadRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/u/:sid", async (c) => {
    const session = await getSession(deps.redis, c.req.param("sid"));
    if (!session || session.kind !== "upload") {
      return c.html(expiredPage(), 404, {
        "Content-Security-Policy": UPLOAD_PAGE_CSP,
      });
    }

    const html = assets.uploadHtml
      .replaceAll("{{SID}}", session.sid)
      .replaceAll("{{EXPIRES_AT}}", String(session.expiresAt))
      .replaceAll("{{MAX_FILE_BYTES}}", String(deps.config.maxFileBytes));

    return c.html(html, 200, {
      "Content-Security-Policy": UPLOAD_PAGE_CSP,
      "Cache-Control": "no-store",
    });
  });

  app.post("/u/:sid/file", async (c) => {
    const sid = c.req.param("sid");

    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > deps.config.maxFileBytes + 64 * 1024) {
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
    const id = newId();
    const dir = fileDir(deps.config, id);

    let received: Awaited<ReturnType<typeof receiveUpload>>;
    try {
      received = await receiveUpload(c, deps, dir);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (err instanceof UploadError)
        return c.json({ error: err.message }, err.status as 400);
      console.error("Upload failed:", err);
      return c.json({ error: "Upload failed" }, 500);
    }

    // A file larger than the whole per-user quota can never fit, and evicting
    // the uploader's other files would not change that.
    if (received.size > deps.config.maxUserBytes) {
      await rm(dir, { recursive: true, force: true });
      return c.json({ error: "File exceeds your personal storage quota" }, 413);
    }

    const now = Date.now();
    const record: FileRecord = {
      id,
      name: received.name,
      mime: received.type.mime,
      kind: received.type.kind,
      size: received.size,
      width: received.width,
      height: received.height,
      createdAt: now,
      expiresAt: session.ttlMs > 0 ? now + session.ttlMs : 0,
      userId: session.userId,
      channelId: session.channelId,
    };

    // Drop anything already expired, then make room within the uploader's own
    // quota by removing their least-recent files first. Other users are never
    // touched, so one person cannot evict everyone else.
    await expireDue(deps.redis, deps.config, now);
    await enforceUserQuota(deps, session.userId, record.size);

    await saveRecord(deps.redis, record);
    await sweep(deps.redis, deps.config);

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

/**
 * Evict the uploader's own oldest files until the incoming file fits under
 * their quota. `incomingSize` is already known to be <= the quota, so the loop
 * always terminates once enough of their files are gone.
 */
async function enforceUserQuota(
  deps: AppDeps,
  userId: string,
  incomingSize: number,
): Promise<void> {
  let used = await userBytes(deps.redis, userId);
  if (used + incomingSize <= deps.config.maxUserBytes) return;

  for (const id of await listUserIdsOldestFirst(deps.redis, userId)) {
    await deleteRecord(deps.redis, deps.config, id);
    console.log(`Evicted ${id} to stay under ${userId}'s storage quota`);
    used = await userBytes(deps.redis, userId);
    if (used + incomingSize <= deps.config.maxUserBytes) return;
  }
}

interface ReceivedUpload {
  name: string;
  size: number;
  width: number;
  height: number;
  type: SniffResult;
}

/**
 * Stream the multipart body to disk.
 *
 * The byte counter is authoritative rather than Content-Length, and the type
 * comes from the leading bytes rather than the client's filename, so neither a
 * lying header nor a lying extension can get past this.
 */
async function receiveUpload(
  c: Parameters<typeof requestNodeStream>[0],
  deps: AppDeps,
  dir: string,
): Promise<ReceivedUpload> {
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("multipart/form-data")) {
    throw new UploadError(400, "Expected a multipart/form-data body");
  }

  await mkdir(dir, { recursive: true });
  const partPath = path.join(dir, ".part");

  const fields: Record<string, string> = {};
  let result: ReceivedUpload | null = null;

  const bb = busboy({
    headers: { "content-type": contentType },
    limits: { files: 1, fields: 8, fieldSize: 64 },
  });

  const done = new Promise<void>((resolve, reject) => {
    let filePromise: Promise<void> = Promise.resolve();

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (_name, file, info) => {
      filePromise = (async () => {
        let size = 0;
        let head = Buffer.alloc(0);
        let type: SniffResult | null = null;

        const inspect = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (size > deps.config.maxFileBytes) {
              cb(new UploadError(413, "File exceeds the size limit"));
              return;
            }
            if (!type) {
              head = Buffer.concat([head, chunk]);
              if (head.length >= SNIFF_BYTES) {
                type = sniff(head);
                if (!type) {
                  cb(
                    new UploadError(415, "Only images and videos are accepted"),
                  );
                  return;
                }
              }
            }
            cb(null, chunk);
          },
        });

        await pipeline(file, inspect, createWriteStream(partPath));

        // Files shorter than the sniff window are typed once the stream ends.
        type ??= sniff(head);
        if (!type)
          throw new UploadError(415, "Only images and videos are accepted");

        const name = `${slugifyBasename(info.filename ?? "file")}.${type.ext}`;
        await rename(partPath, path.join(dir, name));

        result = {
          name,
          size,
          type,
          width: dimension(fields.width, type.kind === "video" ? 1280 : 0),
          height: dimension(fields.height, type.kind === "video" ? 720 : 0),
        };
      })();
    });

    bb.on("error", reject);
    bb.on("close", () => {
      filePromise.then(resolve, reject);
    });
  });

  const source = requestNodeStream(c);
  source.pipe(bb);

  try {
    await done;
  } catch (err) {
    source.destroy();
    throw err;
  }

  if (!result) throw new UploadError(400, "No file was included in the upload");
  return result;
}

/** Client-reported dimensions are advisory; anything unusable falls back. */
function dimension(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) return fallback;
  return Math.round(value);
}

function expiredPage(): string {
  return expiredShell(
    "This upload link has already been used or has run out of time.",
    "upload",
  );
}

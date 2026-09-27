import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Context } from "hono";
import type { AppDeps } from "../app.js";
import type { Config } from "../config.js";
import { requestNodeStream } from "../http/body.js";
import { sweep } from "./lru.js";
import { newId } from "./sessions.js";
import { SNIFF_BYTES, slugifyBasename, sniff } from "./sniff.js";
import {
  deleteRecord,
  expireDue,
  fileDir,
  listUserIdsOldestFirst,
  saveRecord,
  userBytes,
} from "./store.js";
import { recordUpload } from "./usage.js";
import type { FileRecord, SniffResult } from "../types.js";

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Evict the uploader's own oldest files until the incoming file fits under
 * their quota. `incomingSize` is already known to be <= the quota, so the loop
 * always terminates once enough of their files are gone.
 */
export async function enforceUserQuota(
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
  fields: Record<string, string>;
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
          fields,
        };
      })();
      // Settle `done` the instant the file pipeline fails, rather than
      // waiting on busboy's own `close`. Once `pipeline`'s error destroys the
      // FileStream busboy handed us mid-part, busboy can be left with a
      // pending internal write callback and never reach `close` on its own —
      // waiting for it would hang the request forever and leave this
      // rejection unhandled.
      filePromise.catch(reject);
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
    // Busboy's own parser can be left stuck (see above), so tear it down
    // explicitly instead of waiting on it. The rest of the body is drained
    // rather than the source destroyed, so a real HTTP connection isn't cut
    // off mid-request and the error response can actually be delivered.
    source.unpipe(bb);
    bb.destroy();
    source.resume();
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

export interface IngestOwner {
  userId: string;
  channelId: string;
  /** Decides the lifetime once the multipart fields (which precede the file) are known. */
  ttlMs: (fields: Record<string, string>) => number;
}

/** Cheap early refusal before reading a byte; the streamed counter is still authoritative. */
export function declaredTooLarge(c: Context, config: Config): boolean {
  const declared = Number(c.req.header("content-length") ?? 0);
  return declared > config.maxFileBytes + 64 * 1024;
}

export async function ingestUpload(
  c: Context,
  deps: AppDeps,
  owner: IngestOwner,
): Promise<FileRecord> {
  const id = newId();
  const dir = fileDir(deps.config, id);

  let received: ReceivedUpload;
  try {
    received = await receiveUpload(c, deps, dir);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  // A file larger than the whole per-user quota can never fit, and evicting
  // the uploader's other files would not change that.
  if (received.size > deps.config.maxUserBytes) {
    await rm(dir, { recursive: true, force: true });
    throw new UploadError(413, "File exceeds your personal storage quota");
  }

  const now = Date.now();
  const ttlMs = owner.ttlMs(received.fields);
  const record: FileRecord = {
    id,
    name: received.name,
    mime: received.type.mime,
    kind: received.type.kind,
    size: received.size,
    width: received.width,
    height: received.height,
    createdAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    userId: owner.userId,
    channelId: owner.channelId,
  };

  // Drop anything already expired, then make room within the uploader's own
  // quota by removing their least-recent files first. Other users are never touched.
  await expireDue(deps.redis, deps.config, now);
  await enforceUserQuota(deps, owner.userId, record.size);
  await saveRecord(deps.redis, record);
  try {
    await recordUpload(deps.redis, owner.userId, record.size, now);
  } catch (err) {
    console.error(`Failed to record upload usage for ${owner.userId}:`, err);
  }
  await sweep(deps.redis, deps.config);
  return record;
}

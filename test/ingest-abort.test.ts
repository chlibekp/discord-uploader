/**
 * Regression coverage for a real-server stream-abort hang.
 *
 * Every other upload test drives the app through `app.fetch(request)`
 * directly, which never populates `c.env`, so `requestNodeStream` always
 * falls back to `Readable.fromWeb(body)`. Behind a real `@hono/node-server`
 * `serve()`, `c.env.incoming` is the raw `IncomingMessage`, and a multipart
 * body whose closing boundary arrives in a later TCP read than the bytes that
 * trigger a mid-stream 413/415 left busboy's own `close` event unreachable:
 * `pipeline()` destroyed the FileStream busboy hands the consumer, but busboy
 * itself was left with a pending internal write callback and never finished,
 * so `receiveUpload`'s `done` promise hung forever, the rejected `filePromise`
 * went unhandled (crashing the process under Node's default
 * `unhandledRejection` behaviour), and the partial upload directory was never
 * cleaned up.
 *
 * These tests reproduce that exact timing over a real socket and assert the
 * fix in src/storage/ingest.ts: the response still arrives, nothing is left
 * on disk, and no rejection goes unhandled.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAuthSession } from "../src/auth/sessions.js";
import { createSession } from "../src/storage/sessions.js";
import { fixtures, makeHarness, multipart, type Harness } from "./helpers.js";

const ORIGIN = "https://uploader.test";

let h: Harness;
let server: Server;
let baseUrl: string;
let unhandled: unknown[] = [];

function onUnhandledRejection(err: unknown) {
  unhandled.push(err);
}

beforeEach(async () => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandledRejection);
});

afterEach(async () => {
  process.off("unhandledRejection", onUnhandledRejection);
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  h?.cleanup();
});

async function start(overrides: Parameters<typeof makeHarness>[0] = {}) {
  h = await makeHarness(overrides);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: h.app.fetch, port: 0 }, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
}

interface ChunkedResult {
  status: number;
  body: string;
}

/**
 * Post a body over a real socket in separate `write()` calls with a pause
 * between them, so the tail of the multipart part (here, the closing
 * boundary) is still in flight — or not yet written at all — when the
 * server-side stream errors on an earlier chunk. Content-Length is left
 * unset, so Node sends it chunked, matching a client that never declared a
 * length at all.
 */
function postChunked(
  path: string,
  contentType: string,
  chunks: Buffer[],
  headers: Record<string, string> = {},
  delayMs = 20,
): Promise<ChunkedResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method: "POST", headers: { "Content-Type": contentType, ...headers } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (d: Buffer) => parts.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    (async () => {
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
        const ok = req.write(chunks[i]);
        if (!ok) await new Promise((r) => req.once("drain", r));
      }
      req.end();
    })().catch(reject);
  });
}

/** Splits an encoded multipart body into [preamble+headers+lead-in, rest]. */
function splitAfterContentBytes(
  body: Buffer,
  contentBytesInFirstChunk: number,
): [Buffer, Buffer] {
  const headerEnd = body.indexOf("\r\n\r\n") + 4;
  const cut = headerEnd + contentBytesInFirstChunk;
  return [body.subarray(0, cut), body.subarray(cut)];
}

async function uploadSid(userId = "user-1"): Promise<string> {
  const session = await createSession(h.deps.redis, {
    kind: "upload",
    userId,
    channelId: "channel-1",
    guildId: "guild-1",
    interactionToken: "token-1",
    ttlMs: 0,
  });
  return session.sid;
}

async function meCookie(userId = "111"): Promise<string> {
  const token = await createAuthSession(h.deps.redis, {
    id: userId,
    username: "u" + userId,
    globalName: "",
    avatar: "",
  });
  return `__Host-session=${token}`;
}

async function settle() {
  // Give Node's unhandledRejection detection (which fires at the end of a
  // microtask checkpoint) a chance to run before we assert on `unhandled`.
  await new Promise((r) => setTimeout(r, 20));
}

describe("mid-stream upload abort over a real socket", () => {
  it("POST /u/:sid/file: 415 for an oversized non-media file split across chunks", async () => {
    await start();
    const sid = await uploadSid();
    const content = Buffer.alloc(100_000, 0x41); // matches no known signature
    const { body, contentType } = multipart(
      {},
      { field: "file", filename: "a.bin", contentType: "image/png", content },
    );
    const [chunk1, chunk2] = splitAfterContentBytes(body, 100);

    const res = await postChunked(`/u/${sid}/file`, contentType, [
      chunk1,
      chunk2,
    ]);

    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error).toMatch(/images and videos/);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 5000);

  it("POST /u/:sid/file: mid-stream 413 with Content-Length omitted", async () => {
    await start({ maxFileBytes: 50_000 });
    const sid = await uploadSid();
    const content = fixtures.png(150_000);
    const { body, contentType } = multipart(
      {},
      { field: "file", filename: "a.png", contentType: "image/png", content },
    );
    const [chunk1, chunk2] = splitAfterContentBytes(body, 60_000);

    const res = await postChunked(`/u/${sid}/file`, contentType, [
      chunk1,
      chunk2,
    ]);

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toMatch(/exceeds the size limit/);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 5000);

  it("POST /api/me/files: 415 for an oversized non-media file split across chunks", async () => {
    await start();
    const cookie = await meCookie();
    const content = Buffer.alloc(100_000, 0x41);
    const { body, contentType } = multipart(
      {},
      { field: "file", filename: "a.bin", contentType: "image/png", content },
    );
    const [chunk1, chunk2] = splitAfterContentBytes(body, 100);

    const res = await postChunked(
      "/api/me/files",
      contentType,
      [chunk1, chunk2],
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(res.status).toBe(415);
    expect(JSON.parse(res.body).error).toMatch(/images and videos/);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 5000);

  it("POST /api/me/files: mid-stream 413 with Content-Length omitted", async () => {
    await start({ maxFileBytes: 50_000 });
    const cookie = await meCookie();
    const content = fixtures.png(150_000);
    const { body, contentType } = multipart(
      {},
      { field: "file", filename: "a.png", contentType: "image/png", content },
    );
    const [chunk1, chunk2] = splitAfterContentBytes(body, 60_000);

    const res = await postChunked(
      "/api/me/files",
      contentType,
      [chunk1, chunk2],
      { Cookie: cookie, Origin: ORIGIN },
    );

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toMatch(/exceeds the size limit/);
    expect(readdirSync(h.deps.config.dataDir)).toHaveLength(0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 5000);
});

/**
 * Write the first part of a body over a real socket, wait until the server
 * has started writing it to disk, then destroy the request — what a browser
 * does when the dashboard tray's Cancel aborts the XHR mid-upload.
 */
function postThenAbort(
  path: string,
  contentType: string,
  firstChunk: Buffer,
  headers: Record<string, string> = {},
): { aborted: Promise<void> } {
  const req = http.request(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
  });
  // The socket error from our own destroy() is expected.
  req.on("error", () => {});
  req.write(firstChunk);
  const aborted = (async () => {
    await waitFor(() => partBytes() > 0);
    req.destroy();
  })();
  return { aborted };
}

/** Bytes written so far to any upload's `.part` file under dataDir. */
function partBytes(): number {
  let total = 0;
  for (const id of readdirSync(h.deps.config.dataDir)) {
    const part = path.join(h.deps.config.dataDir, id, ".part");
    if (existsSync(part)) total += statSync(part).size;
  }
  return total;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("client disconnects mid-body over a real socket", () => {
  it("POST /u/:sid/file: the handler settles and the partial file is removed", async () => {
    await start({ maxFileBytes: 8 * 1024 * 1024 });
    const sid = await uploadSid();
    const { body, contentType } = multipart(
      {},
      {
        field: "file",
        filename: "a.png",
        contentType: "image/png",
        content: fixtures.png(5 * 1024 * 1024),
      },
    );
    const [first] = splitAfterContentBytes(body, 1024 * 1024);

    const { aborted } = postThenAbort(`/u/${sid}/file`, contentType, first);
    await aborted;

    await waitFor(() => readdirSync(h.deps.config.dataDir).length === 0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 10_000);

  it("POST /api/me/files: the handler settles and the partial file is removed", async () => {
    await start({ maxFileBytes: 8 * 1024 * 1024 });
    const cookie = await meCookie();
    const { body, contentType } = multipart(
      {},
      {
        field: "file",
        filename: "a.png",
        contentType: "image/png",
        content: fixtures.png(5 * 1024 * 1024),
      },
    );
    const [first] = splitAfterContentBytes(body, 1024 * 1024);

    const { aborted } = postThenAbort("/api/me/files", contentType, first, {
      Cookie: cookie,
      Origin: ORIGIN,
    });
    await aborted;

    await waitFor(() => readdirSync(h.deps.config.dataDir).length === 0);
    await settle();
    expect(unhandled).toEqual([]);
  }, 10_000);
});

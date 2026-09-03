import { generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { Config } from "../src/config.js";
import type { AppDeps } from "../src/app.js";
import { createApp } from "../src/app.js";

export const keys = generateKeyPairSync("ed25519");

/** The raw 32-byte key is the last 32 bytes of the SPKI DER document. */
export const publicKeyHex = keys.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

export function sign(timestamp: string, body: string): string {
  return cryptoSign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), keys.privateKey)
    .toString("hex");
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    discordAppId: "1234567890",
    discordPublicKey: publicKeyHex,
    discordBotToken: "test-token",
    publicUrl: "https://uploader.test",
    redisUrl: "redis://localhost:6379",
    dataDir: mkdtempSync(path.join(tmpdir(), "uploader-")),
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 10 * 1024 * 1024,
    maxUserBytes: 8 * 1024 * 1024,
    port: 3000,
    ...overrides,
  };
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  calls: { url: string; body: any }[];
  cleanup: () => void;
}

/**
 * ioredis-mock keeps one keyspace per connection, so instances share data.
 * Flushing here gives each harness a clean store.
 */
export async function makeHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const config = testConfig(overrides);
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  const calls: { url: string; body: any }[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const deps: AppDeps = { config, redis, fetch: fetchImpl };

  return {
    app: createApp(deps),
    deps,
    calls,
    cleanup: () => rmSync(config.dataDir, { recursive: true, force: true }),
  };
}

export function interactionRequest(payload: unknown, opts: { valid?: boolean } = {}): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = opts.valid === false ? "00".repeat(64) : sign(timestamp, body);

  return new Request("https://uploader.test/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

export function uploadCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: 2,
    id: "interaction-1",
    token: "interaction-token-abc",
    channel_id: "channel-99",
    guild_id: "guild-7",
    data: { name: "upload", type: 1 },
    member: { user: { id: "user-42" } },
    ...overrides,
  };
}

/** Build a multipart/form-data body without depending on the runtime's FormData. */
export function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; content: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----test${randomBytes(8).toString("hex")}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
        `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function pad(head: Buffer, size = 512): Buffer {
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x21)]);
}

export const fixtures = {
  png: (size = 512) => pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size),
  jpeg: (size = 512) => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), size),
  gif: (size = 512) => pad(Buffer.from("GIF89a"), size),
  webp: (size = 512) =>
    pad(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), size),
  avif: (size = 512) => pad(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")]), size),
  mp4: (size = 512) => pad(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]), size),
  mov: (size = 512) => pad(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypqt  ")]), size),
  webm: (size = 512) =>
    pad(
      Buffer.concat([
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        Buffer.from([0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
        Buffer.from("webm"),
      ]),
      size,
    ),
  html: (size = 512) => pad(Buffer.from("<!doctype html><script>alert(1)</script>"), size),
  svg: (size = 512) => pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), size),
  zip: (size = 512) => pad(Buffer.from([0x50, 0x4b, 0x03, 0x04]), size),
};

import type { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { SessionKind, UploadSession } from "../types.js";

/**
 * One minute inside the 15-minute life of an interaction token, so a session
 * that is still claimable always has a token we can still post with.
 */
export const SESSION_TTL_SECONDS = 840;

export type ClaimResult =
  | { status: "ok"; session: UploadSession }
  | { status: "missing" }
  | { status: "claimed" };

/** A session opened by one command must not be spendable on the other's route. */
export function isKind(session: UploadSession, kind: SessionKind): boolean {
  return session.kind === kind;
}

const key = (sid: string) => `sess:${sid}`;

export function newId(): string {
  return randomBytes(16).toString("base64url");
}

export async function createSession(
  redis: Redis,
  input: Omit<UploadSession, "sid" | "createdAt" | "expiresAt">,
): Promise<UploadSession> {
  const createdAt = Date.now();
  const session: UploadSession = {
    sid: newId(),
    ...input,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_SECONDS * 1000,
  };

  await redis
    .multi()
    .hset(key(session.sid), {
      kind: session.kind,
      userId: session.userId,
      channelId: session.channelId,
      guildId: session.guildId,
      interactionToken: session.interactionToken,
      ttlMs: String(session.ttlMs),
      createdAt: String(session.createdAt),
      expiresAt: String(session.expiresAt),
    })
    .expire(key(session.sid), SESSION_TTL_SECONDS)
    .exec();

  return session;
}

function hydrate(
  sid: string,
  raw: Record<string, string>,
): UploadSession | null {
  if (!raw.interactionToken || !raw.channelId || !raw.userId) return null;
  return {
    sid,
    kind: raw.kind === "gallery" ? "gallery" : "upload",
    userId: raw.userId,
    channelId: raw.channelId,
    guildId: raw.guildId ?? "",
    interactionToken: raw.interactionToken,
    ttlMs: Number(raw.ttlMs ?? 0),
    createdAt: Number(raw.createdAt ?? 0),
    expiresAt: Number(raw.expiresAt ?? 0),
  };
}

/** Read-only lookup, used to decide whether to render the upload page. */
export async function getSession(
  redis: Redis,
  sid: string,
): Promise<UploadSession | null> {
  const raw = await redis.hgetall(key(sid));
  if (!raw || Object.keys(raw).length === 0) return null;
  if (raw.claimed === "1") return null;
  return hydrate(sid, raw);
}

/**
 * Take exclusive ownership of a session.
 *
 * HSETNX is the atomic step: exactly one caller can create the `claimed` field,
 * so two simultaneous uploads cannot both proceed. HSETNX on an expired key
 * would resurrect it without a TTL, which is why a resurrected key (one with no
 * interactionToken) is deleted and reported missing.
 */
export async function claimSession(
  redis: Redis,
  sid: string,
): Promise<ClaimResult> {
  if ((await redis.exists(key(sid))) === 0) return { status: "missing" };

  const won = await redis.hsetnx(key(sid), "claimed", "1");
  if (won === 0) return { status: "claimed" };

  const raw = await redis.hgetall(key(sid));
  const session = hydrate(sid, raw ?? {});
  if (!session) {
    await redis.del(key(sid));
    return { status: "missing" };
  }
  return { status: "ok", session };
}

export async function deleteSession(redis: Redis, sid: string): Promise<void> {
  await redis.del(key(sid));
}

/**
 * The gallery session is spent rendering the page, so anything the page does
 * afterwards needs its own credential. An action token names one user and
 * nothing else; every request it authorises is still checked against the owner
 * of the file being touched.
 */
export const ACTION_TOKEN_TTL_SECONDS = 900;

const actionKey = (token: string) => `act:${token}`;

export async function createActionToken(
  redis: Redis,
  userId: string,
): Promise<string> {
  const token = newId();
  await redis.set(actionKey(token), userId, "EX", ACTION_TOKEN_TTL_SECONDS);
  return token;
}

export async function readActionToken(
  redis: Redis,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  return redis.get(actionKey(token));
}

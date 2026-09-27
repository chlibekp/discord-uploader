import type { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { AuthUser } from "./types.js";

export const STATE_TTL_SECONDS = 600;
const DEFAULT_NEXT = "/dashboard";
const API = "https://discord.com/api/v10";

export class OAuthError extends Error {}

/**
 * Only same-origin paths survive. Browsers treat "\" like "/", so "/\evil.com"
 * is as dangerous as "//evil.com"; percent-encoded slashes are decoded first.
 */
export function safeNext(raw: string | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return DEFAULT_NEXT;
  }
  if (!decoded.startsWith("/")) return DEFAULT_NEXT;
  if (decoded.startsWith("//") || decoded.includes("\\")) return DEFAULT_NEXT;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(decoded)) return DEFAULT_NEXT;
  return raw;
}

const stateKey = (state: string) => `oauth:state:${state}`;

export async function createOAuthState(
  redis: Redis,
  next: string,
): Promise<string> {
  const state = randomBytes(16).toString("base64url");
  await redis.set(stateKey(state), next, "EX", STATE_TTL_SECONDS);
  return state;
}

/** Atomic read-and-delete, so each state works exactly once. */
export async function consumeOAuthState(
  redis: Redis,
  state: string,
): Promise<string | null> {
  if (!state) return null;
  const results = await redis
    .multi()
    .get(stateKey(state))
    .del(stateKey(state))
    .exec();
  const value = results?.[0]?.[1] as string | null | undefined;
  return value ?? null;
}

export function redirectUri(config: Config): string {
  return `${config.publicUrl}/auth/callback`;
}

export function authorizeUrl(config: Config, state: string): string {
  const q = new URLSearchParams({
    client_id: config.discordAppId,
    response_type: "code",
    scope: "identify",
    redirect_uri: redirectUri(config),
    state,
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

/**
 * Trade the code for a token, read the identity, and drop the token: the
 * dashboard never calls Discord on the user's behalf.
 */
export async function exchangeCode(
  config: Config,
  fetchImpl: typeof fetch,
  code: string,
): Promise<AuthUser> {
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.discordAppId,
        client_secret: config.discordClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(config),
      }),
    });
  } catch (err) {
    throw new OAuthError(`Token request failed: ${(err as Error).message}`);
  }
  if (!tokenRes.ok)
    throw new OAuthError(`Token exchange returned ${tokenRes.status}`);

  let token: { access_token?: string; token_type?: string };
  try {
    token = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
    };
  } catch (err) {
    throw new OAuthError(
      `Token response was not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!token.access_token)
    throw new OAuthError("Token response had no access_token");

  let meRes: Response;
  try {
    meRes = await fetchImpl(`${API}/users/@me`, {
      headers: {
        Authorization: `${token.token_type ?? "Bearer"} ${token.access_token}`,
      },
    });
  } catch (err) {
    throw new OAuthError(`/users/@me failed: ${(err as Error).message}`);
  }
  if (!meRes.ok) throw new OAuthError(`/users/@me returned ${meRes.status}`);

  let me: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
  };
  try {
    me = (await meRes.json()) as typeof me;
  } catch (err) {
    throw new OAuthError(
      `/users/@me response was not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!me.id) throw new OAuthError("/users/@me had no id");
  return {
    id: me.id,
    username: me.username ?? "",
    globalName: me.global_name ?? "",
    avatar: me.avatar ?? "",
  };
}

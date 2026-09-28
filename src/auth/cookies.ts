import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AUTH_SESSION_TTL_SECONDS } from "./sessions.js";
import { STATE_TTL_SECONDS } from "./oauth.js";

export const SESSION_COOKIE = "session";
export const STATE_COOKIE = "oauth_state";

const BASE = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  prefix: "host",
} as const;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    ...BASE,
    maxAge: AUTH_SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, BASE);
}

export function readSessionCookie(c: Context): string {
  return getCookie(c, SESSION_COOKIE, "host") ?? "";
}

export function setStateCookie(c: Context, state: string): void {
  setCookie(c, STATE_COOKIE, state, { ...BASE, maxAge: STATE_TTL_SECONDS });
}

/** Reads the state cookie and schedules its removal from the response. */
export function takeStateCookie(c: Context): string {
  const value = getCookie(c, STATE_COOKIE, "host") ?? "";
  deleteCookie(c, STATE_COOKIE, BASE);
  return value;
}

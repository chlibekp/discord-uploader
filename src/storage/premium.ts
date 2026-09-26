import type { Redis } from "ioredis";
import type { Config } from "../config.js";
import { isActiveStatus } from "../billing/stripe.js";
import { newId } from "./sessions.js";

/**
 * Premium state, one hash per Discord user, mirrored from Stripe by the
 * webhook. Stripe stays the source of truth: every write here comes from a
 * freshly fetched subscription, never from what a browser or event claimed.
 */
export interface PremiumRecord {
  status: string;
  customerId: string;
  subscriptionId: string;
  /** Epoch ms the current billing period ends; 0 when unknown. */
  currentPeriodEnd: number;
  /** True once the user has cancelled; Premium lasts until the period ends. */
  cancelAtPeriodEnd: boolean;
}

const premiumKey = (userId: string) => `premium:${userId}`;
const customerKey = (customerId: string) => `stripe:customer:${customerId}`;
const linkKey = (token: string) => `premlink:${token}`;

/** Long enough to read the pricing and come back; unrelated to Discord's token. */
export const PREMIUM_LINK_TTL_SECONDS = 3600;

export async function getPremium(
  redis: Redis,
  userId: string,
): Promise<PremiumRecord | null> {
  const raw = await redis.hgetall(premiumKey(userId));
  if (!raw || !raw.status) return null;
  return {
    status: raw.status,
    customerId: raw.customerId ?? "",
    subscriptionId: raw.subscriptionId ?? "",
    currentPeriodEnd: Number(raw.currentPeriodEnd ?? 0),
    cancelAtPeriodEnd: raw.cancelAtPeriodEnd === "1",
  };
}

export async function isPremium(
  redis: Redis,
  userId: string,
): Promise<boolean> {
  const record = await getPremium(redis, userId);
  return record !== null && isActiveStatus(record.status);
}

/** The per-file ceiling that applies to one user right now. */
export async function fileLimitFor(
  redis: Redis,
  config: Config,
  userId: string,
): Promise<{ premium: boolean; maxBytes: number }> {
  const premium = await isPremium(redis, userId);
  return {
    premium,
    maxBytes: premium ? config.premiumMaxFileBytes : config.maxFileBytes,
  };
}

/**
 * Record the latest state of one subscription.
 *
 * A user can end up with two subscriptions (say, two checkout tabs). When one
 * of them ends while a different one is still live, that must not revoke
 * Premium, so an inactive update for a subscription other than the stored
 * active one is ignored.
 */
export async function applySubscription(
  redis: Redis,
  userId: string,
  record: PremiumRecord,
): Promise<boolean> {
  const current = await getPremium(redis, userId);
  if (
    current &&
    current.subscriptionId !== record.subscriptionId &&
    isActiveStatus(current.status) &&
    !isActiveStatus(record.status)
  ) {
    return false;
  }

  await redis
    .multi()
    .hset(premiumKey(userId), {
      status: record.status,
      customerId: record.customerId,
      subscriptionId: record.subscriptionId,
      currentPeriodEnd: String(record.currentPeriodEnd),
      cancelAtPeriodEnd: record.cancelAtPeriodEnd ? "1" : "0",
      updatedAt: String(Date.now()),
    })
    .set(customerKey(record.customerId), userId)
    .exec();
  return true;
}

export async function linkCustomer(
  redis: Redis,
  customerId: string,
  userId: string,
): Promise<void> {
  await redis.set(customerKey(customerId), userId);
}

export async function userForCustomer(
  redis: Redis,
  customerId: string,
): Promise<string | null> {
  return redis.get(customerKey(customerId));
}

/**
 * The /premium button points at our own URL rather than straight at Stripe, so
 * the command can reply instantly and a Checkout session is only created if the
 * link is actually opened.
 */
export async function createPremiumLink(
  redis: Redis,
  userId: string,
): Promise<string> {
  const token = newId();
  await redis.set(linkKey(token), userId, "EX", PREMIUM_LINK_TTL_SECONDS);
  return token;
}

export async function readPremiumLink(
  redis: Redis,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  return redis.get(linkKey(token));
}

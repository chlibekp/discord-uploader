import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";

/**
 * A thin Stripe client over `fetch`. The service needs four calls, so the SDK
 * would be mostly dead weight, and going through the injected `fetch` keeps
 * every request observable in tests without network access.
 */

const API = "https://api.stripe.com/v1";

/** What the /premium copy promises. A custom STRIPE_PRICE_ID must match it. */
export const PREMIUM_PRICE_LABEL = "€1/month";
const PREMIUM_CURRENCY = "eur";
const PREMIUM_UNIT_AMOUNT = 100;
const PREMIUM_PRODUCT_NAME = "ImageUploader Premium";

/**
 * Subscription states that still grant Premium. `past_due` is included so a
 * failed renewal does not cut someone off while Stripe is retrying the card;
 * if every retry fails, Stripe moves it to `canceled` or `unpaid`.
 */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function stripeEnabled(config: Config): boolean {
  return Boolean(config.stripeSecretKey && config.stripeWebhookSecret);
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = { [key: string]: string | number | boolean | Params | Params[] };

/** Stripe takes nested form fields: `a[b][0][c]=v`. */
export function encodeForm(params: Params): string {
  const out = new URLSearchParams();
  const walk = (value: Params[string], prefix: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${prefix}[${i}]`));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${prefix}[${k}]`);
    } else {
      out.append(prefix, String(value));
    }
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.toString();
}

async function stripeRequest<T>(
  config: Config,
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  path: string,
  params?: Params,
): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.stripeSecretKey}`,
      ...(params
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(params ? { body: encodeForm(params) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message ?? text;
    } catch {
      /* keep the raw body */
    }
    throw new StripeError(res.status, `Stripe ${method} ${path}: ${message}`);
  }
  return JSON.parse(text) as T;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Start a €1/month subscription checkout for one Discord user.
 *
 * The user id rides along as `client_reference_id` and as subscription
 * metadata, so every later subscription event can be mapped back to them
 * without trusting anything the browser sends.
 */
export function createCheckoutSession(
  config: Config,
  fetchImpl: typeof fetch,
  input: { userId: string; customerId?: string | undefined },
): Promise<CheckoutSession> {
  const lineItem: Params = config.stripePriceId
    ? { price: config.stripePriceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: PREMIUM_CURRENCY,
          unit_amount: PREMIUM_UNIT_AMOUNT,
          recurring: { interval: "month" },
          product_data: { name: PREMIUM_PRODUCT_NAME },
        },
      };

  return stripeRequest<CheckoutSession>(
    config,
    fetchImpl,
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      client_reference_id: input.userId,
      line_items: [lineItem],
      metadata: { userId: input.userId },
      subscription_data: { metadata: { userId: input.userId } },
      success_url: `${config.publicUrl}/premium/success`,
      cancel_url: `${config.publicUrl}/premium/cancel`,
      ...(input.customerId ? { customer: input.customerId } : {}),
    },
  );
}

/** Stripe's hosted page for cancelling or changing the card on file. */
export function createPortalSession(
  config: Config,
  fetchImpl: typeof fetch,
  customerId: string,
): Promise<{ url: string }> {
  return stripeRequest<{ url: string }>(
    config,
    fetchImpl,
    "POST",
    "/billing_portal/sessions",
    { customer: customerId, return_url: `${config.publicUrl}/premium/success` },
  );
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end?: boolean;
  /** Top-level before API version 2025-03-31, per item after it. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
  metadata?: Record<string, string>;
}

export function retrieveSubscription(
  config: Config,
  fetchImpl: typeof fetch,
  id: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    config,
    fetchImpl,
    "GET",
    `/subscriptions/${encodeURIComponent(id)}`,
  );
}

export function periodEndMs(sub: StripeSubscription): number {
  const seconds =
    sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0;
  return seconds * 1000;
}

/** Stripe's default replay window for signed webhooks. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verify a `Stripe-Signature` header: an HMAC-SHA256 of `${t}.${rawBody}`
 * keyed with the endpoint's signing secret. Several `v1` entries may be present
 * while a secret is being rolled, and any one matching is enough.
 */
export function verifyStripeSignature(args: {
  header: string | null | undefined;
  rawBody: Buffer;
  secret: string;
  now?: number;
}): boolean {
  const { header, rawBody, secret, now = Date.now() } = args;
  if (!header || !secret) return false;

  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t" && v) timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
}

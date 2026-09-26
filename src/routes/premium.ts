import { Hono } from "hono";
import type { AppDeps } from "../app.js";
import { UPLOAD_PAGE_CSP } from "../assets.js";
import {
  createCheckoutSession,
  createPortalSession,
  isActiveStatus,
  periodEndMs,
  retrieveSubscription,
  stripeEnabled,
  verifyStripeSignature,
} from "../billing/stripe.js";
import { brandBar, shell } from "../pages.js";
import {
  applySubscription,
  getPremium,
  linkCustomer,
  readPremiumLink,
  userForCustomer,
} from "../storage/premium.js";

const PAGE_HEADERS = {
  "Content-Security-Policy": UPLOAD_PAGE_CSP,
  "Cache-Control": "no-store",
};

export function premiumRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  /**
   * The /premium button lands here. A live subscriber is sent to the billing
   * portal to manage or cancel it; anyone else gets a fresh Checkout session.
   * The link is not spent, so backing out of Checkout and retrying works.
   */
  app.get("/p/:token", async (c) => {
    const userId = await readPremiumLink(deps.redis, c.req.param("token"));
    if (!userId) {
      return c.html(
        notice(
          "Link expired",
          "This Premium link has run out of time.",
          "Run <code>/premium</code> in Discord for a fresh one.",
        ),
        404,
        PAGE_HEADERS,
      );
    }
    if (!stripeEnabled(deps.config)) {
      return c.html(
        notice(
          "Premium unavailable",
          "Premium is not available right now.",
          "Please try again later.",
        ),
        503,
        PAGE_HEADERS,
      );
    }

    const current = await getPremium(deps.redis, userId);
    try {
      if (current && isActiveStatus(current.status) && current.customerId) {
        const portal = await createPortalSession(
          deps.config,
          deps.fetch,
          current.customerId,
        );
        return c.redirect(portal.url, 303);
      }
      const checkout = await createCheckoutSession(deps.config, deps.fetch, {
        userId,
        customerId: current?.customerId || undefined,
      });
      return c.redirect(checkout.url, 303);
    } catch (err) {
      console.error(`Stripe redirect failed for ${userId}:`, err);
      return c.html(
        notice(
          "Something went wrong",
          "We couldn't reach the payment provider.",
          "Please try again in a minute.",
        ),
        502,
        PAGE_HEADERS,
      );
    }
  });

  app.get("/premium/success", (c) =>
    c.html(
      notice(
        "Premium",
        "Thanks! Your subscription is being set up.",
        "It takes effect within a few seconds. Run <code>/premium</code> in Discord to check its status.",
      ),
      200,
      PAGE_HEADERS,
    ),
  );

  app.get("/premium/cancel", (c) =>
    c.html(
      notice(
        "Premium",
        "Checkout was cancelled and nothing was charged.",
        "Run <code>/premium</code> in Discord whenever you want to try again.",
      ),
      200,
      PAGE_HEADERS,
    ),
  );

  /**
   * Stripe's webhook. The event payload is only used to find which
   * subscription changed; its current state is then fetched from Stripe, so
   * out-of-order or replayed deliveries always converge on the latest truth.
   * Any failure answers 500, which makes Stripe retry the delivery.
   */
  app.post("/stripe/webhook", async (c) => {
    if (!stripeEnabled(deps.config)) return c.body(null, 404);

    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const valid = verifyStripeSignature({
      header: c.req.header("Stripe-Signature"),
      rawBody,
      secret: deps.config.stripeWebhookSecret,
    });
    if (!valid) {
      console.warn("Rejected Stripe webhook signature");
      return c.json({ error: "Invalid signature" }, 400);
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return c.json({ error: "Malformed JSON" }, 400);
    }

    try {
      await handleEvent(deps, event);
    } catch (err) {
      console.error(`Stripe event ${event?.id} (${event?.type}) failed:`, err);
      return c.json({ error: "Processing failed" }, 500);
    }
    return c.json({ received: true });
  });

  return app;
}

async function handleEvent(deps: AppDeps, event: any): Promise<void> {
  const object = event?.data?.object ?? {};

  if (event?.type === "checkout.session.completed") {
    if (object.mode !== "subscription" || !object.subscription) return;
    const userId: string | undefined =
      object.client_reference_id ?? object.metadata?.userId;
    if (userId && typeof object.customer === "string") {
      await linkCustomer(deps.redis, object.customer, userId);
    }
    await syncSubscription(deps, String(object.subscription), userId);
    return;
  }

  if (
    typeof event?.type === "string" &&
    event.type.startsWith("customer.subscription.") &&
    typeof object.id === "string"
  ) {
    await syncSubscription(deps, object.id);
  }
}

async function syncSubscription(
  deps: AppDeps,
  subscriptionId: string,
  hintUserId?: string,
): Promise<void> {
  const sub = await retrieveSubscription(
    deps.config,
    deps.fetch,
    subscriptionId,
  );
  const userId =
    sub.metadata?.userId ||
    hintUserId ||
    (await userForCustomer(deps.redis, sub.customer));
  if (!userId) {
    console.warn(`Stripe subscription ${sub.id} has no Discord user attached`);
    return;
  }

  const applied = await applySubscription(deps.redis, userId, {
    status: sub.status,
    customerId: sub.customer,
    subscriptionId: sub.id,
    currentPeriodEnd: periodEndMs(sub),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
  if (applied) {
    console.log(`Premium for ${userId} is now ${sub.status} (${sub.id})`);
  }
}

function notice(title: string, headline: string, detail: string): string {
  return shell(
    title,
    brandBar("Premium", "ImageUploader"),
    `<main class="centered"><div class="card panel"><div class="card-in">
<header><h1>${headline}</h1></header>
<p class="muted">${detail}</p>
</div></div></main>`,
  );
}

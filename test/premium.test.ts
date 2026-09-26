import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeForm, verifyStripeSignature } from "../src/billing/stripe.js";
import { applySubscription, getPremium } from "../src/storage/premium.js";
import {
  fixtures,
  interactionRequest,
  makeHarness,
  multipart,
  uploadCommand,
  type Harness,
} from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  h = await makeHarness({
    maxFileBytes: 1024,
    premiumMaxFileBytes: 8192,
  });
});

afterEach(() => {
  h.cleanup();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function signedWebhook(
  event: unknown,
  secret = "whsec_test",
  timestamp = Math.floor(Date.now() / 1000),
): Request {
  const body = JSON.stringify(event);
  const sig = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("https://uploader.test/stripe/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${timestamp},v1=${sig}`,
    },
    body,
  });
}

/** Stripe answers GET /v1/subscriptions/:id with whatever `subs` holds. */
function stubSubscriptions(subs: Record<string, object>) {
  h.onFetch((url) => {
    const match = url.match(/\/v1\/subscriptions\/([^/?]+)$/);
    if (match && subs[match[1]!]) return json(subs[match[1]!]);
    return undefined;
  });
}

async function command(name: string, userId = "user-42") {
  const res = await h.app.fetch(
    interactionRequest(
      uploadCommand({
        data: { name, type: 1 },
        member: { user: { id: userId } },
      }),
    ),
  );
  return res.json();
}

async function makePremium(userId = "user-42") {
  await applySubscription(h.deps.redis, userId, {
    status: "active",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    currentPeriodEnd: Date.UTC(2026, 9, 26),
    cancelAtPeriodEnd: false,
  });
}

async function uploadSid(): Promise<string> {
  const body = await (
    await h.app.fetch(interactionRequest(uploadCommand()))
  ).json();
  return body.data.components[0].components[0].url.split("/u/")[1];
}

function postPng(sid: string, size: number, declare = false): Request {
  const part = multipart(
    {},
    {
      field: "file",
      filename: "big.png",
      contentType: "image/png",
      content: fixtures.png(size),
    },
  );
  return new Request(`https://uploader.test/u/${sid}/file`, {
    method: "POST",
    headers: {
      "Content-Type": part.contentType,
      ...(declare ? { "Content-Length": String(part.body.length) } : {}),
    },
    body: part.body,
  });
}

describe("verifyStripeSignature", () => {
  const rawBody = Buffer.from('{"id":"evt_1"}');
  const now = 1_700_000_000_000;
  const t = String(now / 1000);
  const sig = (secret: string) =>
    createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");

  it("accepts a correctly signed payload", () => {
    expect(
      verifyStripeSignature({
        header: `t=${t},v1=${sig("whsec_a")}`,
        rawBody,
        secret: "whsec_a",
        now,
      }),
    ).toBe(true);
  });

  it("accepts any matching v1 while a secret is being rolled", () => {
    expect(
      verifyStripeSignature({
        header: `t=${t},v1=${sig("whsec_old")},v1=${sig("whsec_a")}`,
        rawBody,
        secret: "whsec_a",
        now,
      }),
    ).toBe(true);
  });

  it("rejects the wrong secret, a stale timestamp, or a missing header", () => {
    const header = `t=${t},v1=${sig("whsec_a")}`;
    expect(
      verifyStripeSignature({ header, rawBody, secret: "whsec_b", now }),
    ).toBe(false);
    expect(
      verifyStripeSignature({
        header,
        rawBody,
        secret: "whsec_a",
        now: now + 10 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      verifyStripeSignature({ header: undefined, rawBody, secret: "x", now }),
    ).toBe(false);
    expect(
      verifyStripeSignature({
        header: `t=${t},v1=zz`,
        rawBody,
        secret: "whsec_a",
        now,
      }),
    ).toBe(false);
  });
});

describe("encodeForm", () => {
  it("flattens nested objects and arrays the way Stripe expects", () => {
    const params = new URLSearchParams(
      encodeForm({
        mode: "subscription",
        line_items: [{ quantity: 1, price_data: { unit_amount: 100 } }],
      }),
    );
    expect(params.get("mode")).toBe("subscription");
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("100");
  });
});

describe("/premium", () => {
  it("offers a €1/month upgrade to a free user", async () => {
    const body = await command("premium");
    expect(body.data.flags).toBe(64);
    expect(body.data.embeds[0].description).toContain("€1/month");
    const button = body.data.components[0].components[0];
    expect(button.label).toContain("€1/month");
    expect(button.url).toMatch(/^https:\/\/uploader\.test\/p\/[\w-]{22}$/);
  });

  it("shows an active subscription with a manage button", async () => {
    await makePremium();
    const body = await command("premium");
    expect(body.data.embeds[0].description).toContain("Premium is active");
    expect(body.data.embeds[0].description).toContain("renews on");
    expect(body.data.components[0].components[0].label).toBe(
      "Manage subscription",
    );
  });

  it("offers no checkout link when Stripe is not configured", async () => {
    h.cleanup();
    h = await makeHarness({ stripeSecretKey: "", stripeWebhookSecret: "" });
    const body = await command("premium");
    expect(body.data.embeds[0].description).toContain("isn't available");
    expect(body.data.components).toBeUndefined();
  });

  it("is listed in /help", async () => {
    const body = await command("help");
    expect(body.data.embeds[0].description).toContain("/premium");
  });
});

describe("GET /p/:token", () => {
  async function premiumLink(userId = "user-42"): Promise<string> {
    const body = await command("premium", userId);
    return body.data.components[0].components[0].url;
  }

  it("redirects a free user to a €1/month subscription checkout", async () => {
    h.onFetch((url) =>
      url.endsWith("/v1/checkout/sessions")
        ? json({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" })
        : undefined,
    );

    const res = await h.app.fetch(new Request(await premiumLink()));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(
      "https://checkout.stripe.com/c/cs_1",
    );

    const call = h.calls.find((c) => c.url.endsWith("/checkout/sessions"))!;
    expect(call.body).toMatchObject({
      mode: "subscription",
      client_reference_id: "user-42",
      "subscription_data[metadata][userId]": "user-42",
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": "100",
      "line_items[0][price_data][recurring][interval]": "month",
      success_url: "https://uploader.test/premium/success",
    });
  });

  it("uses a configured price id instead of the inline price", async () => {
    h.deps.config.stripePriceId = "price_123";
    h.onFetch(() => json({ id: "cs_1", url: "https://checkout.stripe.com/x" }));
    await h.app.fetch(new Request(await premiumLink()));
    const call = h.calls.find((c) => c.url.endsWith("/checkout/sessions"))!;
    expect(call.body["line_items[0][price]"]).toBe("price_123");
    expect(call.body["line_items[0][price_data][currency]"]).toBeUndefined();
  });

  it("sends a subscriber to the billing portal instead", async () => {
    await makePremium();
    h.onFetch((url) =>
      url.endsWith("/v1/billing_portal/sessions")
        ? json({ url: "https://billing.stripe.com/p/1" })
        : undefined,
    );
    const res = await h.app.fetch(new Request(await premiumLink()));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://billing.stripe.com/p/1");
    const call = h.calls.find((c) =>
      c.url.endsWith("/billing_portal/sessions"),
    );
    expect(call?.body.customer).toBe("cus_1");
  });

  it("shows an error page when Stripe fails", async () => {
    h.onFetch(() => json({ error: { message: "nope" } }, 500));
    const res = await h.app.fetch(new Request(await premiumLink()));
    expect(res.status).toBe(502);
  });

  it("404s for an unknown link", async () => {
    const res = await h.app.fetch(new Request("https://uploader.test/p/nope"));
    expect(res.status).toBe(404);
  });
});

describe("POST /stripe/webhook", () => {
  const activeSub = {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: 1_800_000_000 }] },
    metadata: { userId: "user-42" },
  };

  it("rejects an unsigned or mis-signed event", async () => {
    const res = await h.app.fetch(
      signedWebhook({ id: "evt", type: "x" }, "whsec_wrong"),
    );
    expect(res.status).toBe(400);
  });

  it("activates Premium when checkout completes", async () => {
    stubSubscriptions({ sub_1: activeSub });
    const res = await h.app.fetch(
      signedWebhook({
        id: "evt_1",
        type: "checkout.session.completed",
        data: {
          object: {
            mode: "subscription",
            subscription: "sub_1",
            customer: "cus_1",
            client_reference_id: "user-42",
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await getPremium(h.deps.redis, "user-42")).toEqual({
      status: "active",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      currentPeriodEnd: 1_800_000_000_000,
      cancelAtPeriodEnd: false,
    });
  });

  it("revokes Premium when the subscription is deleted", async () => {
    await makePremium();
    stubSubscriptions({ sub_1: { ...activeSub, status: "canceled" } });
    await h.app.fetch(
      signedWebhook({
        id: "evt_2",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_1" } },
      }),
    );
    expect((await getPremium(h.deps.redis, "user-42"))?.status).toBe(
      "canceled",
    );
  });

  it("maps a subscription without metadata back through its customer", async () => {
    await makePremium();
    stubSubscriptions({
      sub_1: { ...activeSub, metadata: {}, cancel_at_period_end: true },
    });
    await h.app.fetch(
      signedWebhook({
        id: "evt_3",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_1" } },
      }),
    );
    expect((await getPremium(h.deps.redis, "user-42"))?.cancelAtPeriodEnd).toBe(
      true,
    );
  });

  it("does not let an old subscription ending revoke a live one", async () => {
    await makePremium();
    stubSubscriptions({
      sub_old: { ...activeSub, id: "sub_old", status: "canceled" },
    });
    await h.app.fetch(
      signedWebhook({
        id: "evt_4",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_old" } },
      }),
    );
    const record = await getPremium(h.deps.redis, "user-42");
    expect(record?.status).toBe("active");
    expect(record?.subscriptionId).toBe("sub_1");
  });

  it("asks Stripe to retry when the subscription cannot be fetched", async () => {
    h.onFetch(() => json({ error: { message: "down" } }, 503));
    const res = await h.app.fetch(
      signedWebhook({
        id: "evt_5",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_1" } },
      }),
    );
    expect(res.status).toBe(500);
  });

  it("acknowledges events it does not care about", async () => {
    const res = await h.app.fetch(
      signedWebhook({
        id: "evt_6",
        type: "invoice.paid",
        data: { object: {} },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("upload size by plan", () => {
  it("caps a free user at the free limit and points at /premium", async () => {
    const res = await h.app.fetch(postPng(await uploadSid(), 4096));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("/premium");
  });

  it("lets a Premium user upload past the free limit", async () => {
    await makePremium();
    const res = await h.app.fetch(postPng(await uploadSid(), 4096));
    expect(res.status).toBe(200);
  });

  it("still caps a Premium user at the Premium limit", async () => {
    await makePremium();
    const res = await h.app.fetch(postPng(await uploadSid(), 16_384));
    expect(res.status).toBe(413);
    expect((await res.json()).error).not.toContain("/premium");
  });

  it("keeps the link usable when the declared size is over the limit", async () => {
    const sid = await uploadSid();
    const oversized = await h.app.fetch(postPng(sid, 70 * 1024, true));
    expect(oversized.status).toBe(413);
    expect((await h.app.fetch(postPng(sid, 512))).status).toBe(200);
  });

  it("tells the upload page each user's own limit", async () => {
    const freeHtml = await (
      await h.app.fetch(
        new Request(`https://uploader.test/u/${await uploadSid()}`),
      )
    ).text();
    expect(freeHtml).toContain('data-max-bytes="1024"');
    expect(freeHtml).toMatch(/data-upgrade-hint="[^"]*\/premium/);

    await makePremium();
    const paidHtml = await (
      await h.app.fetch(
        new Request(`https://uploader.test/u/${await uploadSid()}`),
      )
    ).text();
    expect(paidHtml).toContain('data-max-bytes="8192"');
    expect(paidHtml).toContain('data-upgrade-hint=""');
  });

  it("shows the plan in /stats", async () => {
    const free = await command("stats");
    expect(free.data.embeds[0].description).toContain("Free");
    await makePremium();
    await h.app.fetch(postPng(await uploadSid(), 512));
    const paid = await command("stats");
    const plan = paid.data.embeds[0].fields.find(
      (f: { name: string }) => f.name === "Plan",
    );
    expect(plan.value).toContain("Premium");
  });
});

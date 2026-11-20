import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { expect, it, vi } from "vitest";
import { CloudComputerStripe, decodeStripeEvent, verifyStripeSignature } from "./stripe.js";

const key = "sk_test_fake_secret_never_log";
const webhookSecret = "whsec_test_only";
const timestamp = 1_800_000_000;
const raw = Buffer.from(
  '{"id":"evt_1","type":"invoice.paid","data":{"object":{"parent":{"subscription_details":{"subscription":"sub_1"}}}}}',
);
const digest = createHmac("sha256", webhookSecret)
  .update(`${timestamp}.`)
  .update(raw)
  .digest("hex");

it.each([
  {
    name: "valid",
    header: `t=${timestamp},v1=${digest}`,
    secret: webhookSecret,
    now: timestamp,
    valid: true,
  },
  {
    name: "wrong secret",
    header: `t=${timestamp},v1=${digest}`,
    secret: "other",
    now: timestamp,
    valid: false,
  },
  {
    name: "stale",
    header: `t=${timestamp},v1=${digest}`,
    secret: webhookSecret,
    now: timestamp + 301,
    valid: false,
  },
  {
    name: "future",
    header: `t=${timestamp},v1=${digest}`,
    secret: webhookSecret,
    now: timestamp - 301,
    valid: false,
  },
  {
    name: "rotation",
    header: `t=${timestamp},v1=${"0".repeat(64)},v1=${digest}`,
    secret: webhookSecret,
    now: timestamp,
    valid: true,
  },
])("handles a $name Stripe signature", ({ header, secret, now, valid }) => {
  expect(verifyStripeSignature(raw, header, secret, now * 1000)).toBe(valid);
  expect(
    verifyStripeSignature(Buffer.concat([raw, Buffer.from(" ")]), header, secret, now * 1000),
  ).toBe(false);
});

it("reads the invoice subscription from the current Stripe shape", () => {
  expect(decodeStripeEvent(raw)).toEqual({
    id: "evt_1",
    type: "invoice.paid",
    operation: "billing",
    subscriptionId: "sub_1",
  });
});

it("sends form-encoded Checkout and Billing Portal requests and redacts Stripe failures", async () => {
  const accountId = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-000000000001");
  const requestId = "00000000-0000-4000-8000-000000000001";
  const requests: {
    path: string | undefined;
    method: string | undefined;
    authorization: string | undefined;
    contentType: string | undefined;
    idempotency: unknown;
    fields: Record<string, string>;
  }[] = [];
  const stderr = vi.spyOn(console, "error");
  const stdout = vi.spyOn(console, "log");
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      idempotency: req.headers["idempotency-key"],
      fields: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())),
    });
    res.setHeader("content-type", "application/json");
    if (requests.length === 3) {
      res.writeHead(401).end(JSON.stringify({ error: { message: key } }));
    } else if (requests.length === 4) {
      res.end(JSON.stringify({ url: key }));
    } else {
      res.end(
        JSON.stringify({ id: "cs_test_checkout", url: "https://billing.stripe.test/session" }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake Stripe address");
    const stripe = new CloudComputerStripe({
      key,
      baseUrl: new URL(`http://127.0.0.1:${address.port}/v1/`),
      returnUrl: new URL("https://account.example.test"),
    });
    await stripe.checkout({
      accountId,
      requestId,
      priceId: "price_1",
    });
    await stripe.portal("cus_1");
    for (const operation of [
      () => stripe.portal("cus_1"),
      () =>
        stripe.checkout({
          accountId,
          requestId,
          priceId: "price_1",
        }),
    ]) {
      const error = await operation().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(key);
      expect(JSON.stringify(error)).not.toContain(key);
    }
    expect(requests[0]).toMatchObject({
      path: "/v1/checkout/sessions",
      method: "POST",
      contentType: expect.stringContaining("application/x-www-form-urlencoded"),
      authorization: `Bearer ${key}`,
      idempotency: `cloud-computer:${accountId}:${requestId}`,
      fields: {
        mode: "subscription",
        "allowed_payment_method_types[0]": "card",
        payment_method_collection: "always",
        "line_items[0][price]": "price_1",
        "line_items[0][quantity]": "1",
        client_reference_id: accountId,
        "metadata[account_id]": accountId,
        "metadata[request_id]": requestId,
        "subscription_data[metadata][account_id]": accountId,
        "subscription_data[metadata][request_id]": requestId,
        success_url: "https://account.example.test/?cloud-computer=checkout-completed",
        cancel_url: "https://account.example.test/",
      },
    });
    expect(requests[0]?.fields).not.toHaveProperty("payment_method_types[0]");
    expect(requests[0]?.fields).not.toHaveProperty("expires_at");
    expect(requests[1]).toMatchObject({
      path: "/v1/billing_portal/sessions",
      method: "POST",
      fields: { customer: "cus_1", return_url: "https://account.example.test/" },
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

it("validates the configured recurring offer and issues an immediate Stripe cancellation", async () => {
  const provider = vi.spyOn(globalThis, "fetch");
  const actual = {
    id: "price_1",
    active: true,
    currency: "usd",
    unit_amount: 2900,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
  try {
    provider.mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/prices/price_1") return Response.json(actual);
      expect(url.pathname).toBe("/v1/subscriptions/sub_1");
      expect(url.searchParams.get("invoice_now")).toBe("false");
      expect(url.searchParams.get("prorate")).toBe("false");
      expect(options?.method).toBe("DELETE");
      return Response.json({ id: "sub_1", status: "canceled" });
    });
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    const wanted = {
      name: "Cloud Computer",
      amountMinor: 2900,
      currency: "usd",
      interval: "month" as const,
    };
    await expect(stripe.validateOffer("price_1", wanted)).resolves.toBeUndefined();
    for (const patch of [{ amountMinor: 1 }, { currency: "cad" }, { interval: "year" as const }])
      await expect(stripe.validateOffer("price_1", { ...wanted, ...patch })).rejects.toThrow(
        "does not match",
      );
    await expect(stripe.cancel("sub_1")).resolves.toBeUndefined();
  } finally {
    provider.mockRestore();
  }
});

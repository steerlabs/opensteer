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
      expiresAt: new Date(timestamp * 1000),
    });
    await stripe.portal("cus_1");
    for (const operation of [
      () => stripe.portal("cus_1"),
      () =>
        stripe.checkout({
          accountId,
          requestId,
          priceId: "price_1",
          expiresAt: new Date(timestamp * 1000),
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
        "payment_method_types[0]": "card",
        payment_method_collection: "always",
        "line_items[0][price]": "price_1",
        "line_items[0][quantity]": "1",
        client_reference_id: accountId,
        "metadata[account_id]": accountId,
        "metadata[request_id]": requestId,
        "subscription_data[metadata][account_id]": accountId,
        "subscription_data[metadata][request_id]": requestId,
        expires_at: String(timestamp),
        success_url: "https://account.example.test/?cloud-computer=checkout-completed",
        cancel_url: "https://account.example.test/",
      },
    });
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

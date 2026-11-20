import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import {
  ControlPlaneAccountIdSchema,
  OrganizationIdSchema,
} from "@opensteer/control-plane-protocol";
import { expect, it, vi } from "vitest";
import {
  CloudComputerStripe,
  StripePaidCheckoutSchema,
  decodeStripeEvent,
  subscriptionRenewal,
  verifyStripeSignature,
} from "./stripe.js";

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
  const server = createServer((req, res) => {
    void (async () => {
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
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
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
        success_url: "https://account.example.test/?checkout=00000000-0000-4000-8000-000000000001",
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

it("returns a Checkout and Billing Portal to the address the call names", async () => {
  const fields: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      fields.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ id: "cs_test_checkout", url: "https://billing.stripe.test/session" }),
      );
    })().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
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
    const pages = new URL("https://opensteer.example.test/cloud-computer");
    await stripe.checkout({
      accountId: ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-000000000001"),
      requestId: "00000000-0000-4000-8000-000000000001",
      priceId: "price_1",
      returnUrl: pages,
    });
    await stripe.portal("cus_1", pages);
    expect(fields[0]).toMatchObject({
      success_url:
        "https://opensteer.example.test/cloud-computer?checkout=00000000-0000-4000-8000-000000000001",
      cancel_url: "https://opensteer.example.test/cloud-computer",
    });
    expect(fields[1]).toMatchObject({
      return_url: "https://opensteer.example.test/cloud-computer",
    });
  } finally {
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

it("submits organization Checkout and uses pending updates only for increases", async () => {
  const accountId = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-000000000001");
  const id = OrganizationIdSchema.parse("org_00000000-0000-4000-8000-000000000001");
  const requestId = "00000000-0000-4000-8000-000000000001";
  const calls: { path: string; headers: Headers; fields: Record<string, string> }[] = [];
  const idempotency = new Map<string, string>();
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(options?.headers);
    const stableKey = headers.get("idempotency-key")!;
    const body = String(options?.body);
    const previous = idempotency.get(stableKey);
    if (previous !== undefined && previous !== body)
      return Response.json({ error: { type: "idempotency_error" } }, { status: 400 });
    idempotency.set(stableKey, body);
    calls.push({
      path,
      headers: new Headers(options?.headers),
      fields: Object.fromEntries(new URLSearchParams(String(options?.body))),
    });
    return path === "/v1/checkout/sessions"
      ? Response.json({ id: "cs_seats", url: "https://checkout.example.test/seats" })
      : Response.json({
          id: "sub_seats",
          customer: "cus_seats",
          status: "active",
          latest_invoice: null,
          metadata: {},
          items: { has_more: false, data: [] },
        });
  });
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    await stripe.checkout({
      accountId,
      requestId,
      priceId: "price_seats",
      organization: { id, quantity: 4 },
    });
    const increase = {
      item: "si_seats",
      subscription: "sub_seats",
      organization: id,
      requestId,
      quantity: 6,
      increase: true,
    };
    await stripe.updateSeatQuantity(increase);
    await stripe.updateSeatQuantity(increase);
    await expect(stripe.updateSeatQuantity({ ...increase, quantity: 3 })).rejects.toThrow(
      "Stripe billing is temporarily unavailable",
    );
    await stripe.updateSeatQuantity({
      ...increase,
      requestId: "00000000-0000-4000-8000-000000000002",
      quantity: 3,
      increase: false,
    });
    expect(calls[0]).toMatchObject({
      path: "/v1/checkout/sessions",
      fields: {
        "line_items[0][quantity]": "4",
        "line_items[0][price]": "price_seats",
        "metadata[organization_id]": id,
        "subscription_data[metadata][organization_id]": id,
      },
    });
    expect(calls[0]?.headers.get("idempotency-key")).toBe(`organization:${id}:${requestId}`);
    expect(calls[1]).toMatchObject({
      path: "/v1/subscriptions/sub_seats",
      fields: {
        "items[0][id]": "si_seats",
        "items[0][quantity]": "6",
        "expand[0]": "latest_invoice",
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
      },
    });
    expect(calls[2]?.fields).toEqual(calls[1]?.fields);
    expect(calls[3]?.fields).toEqual({
      "items[0][id]": "si_seats",
      "items[0][quantity]": "3",
      "expand[0]": "latest_invoice",
      proration_behavior: "none",
    });
  } finally {
    provider.mockRestore();
  }
});

it("reads renewal from the subscription item and omits scheduled cancellation", async () => {
  const periodEnd = 1_800_000_000;
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      id: "sub_renews",
      customer: "cus_renews",
      status: "active",
      latest_invoice: { status: "paid", attempt_count: 1 },
      metadata: {},
      current_period_end: periodEnd - 30,
      items: {
        has_more: false,
        data: [
          {
            id: "si_renews",
            quantity: 1,
            price: { id: "price_1", currency: "usd" },
            current_period_end: periodEnd,
          },
        ],
      },
    }),
  );
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    const subscription = await stripe.subscription("sub_renews");
    expect(subscriptionRenewal(subscription, "active")).toEqual(new Date(periodEnd * 1000));
    expect(subscriptionRenewal(subscription, "past_due")).toBeNull();
    expect(
      subscriptionRenewal({ ...subscription, cancel_at_period_end: true }, "active"),
    ).toBeNull();
    expect(subscriptionRenewal({ ...subscription, cancel_at: periodEnd - 1 }, "active")).toBeNull();
    expect(
      subscriptionRenewal({ ...subscription, items: { has_more: false, data: [] } }, "active"),
    ).toBeNull();
  } finally {
    provider.mockRestore();
  }
});

it("uses an attempt's fixed Checkout expiry and rereads a Session when expiry loses the race", async () => {
  const id = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-000000000001");
  const requestId = "00000000-0000-4000-8000-000000000001";
  const payment = {
    id: "cs_test_attempt",
    status: "complete",
    url: null,
    mode: "subscription",
    client_reference_id: id,
    metadata: { account_id: id, request_id: requestId },
    payment_status: "paid",
    invoice: "in_attempt",
    currency: "usd",
    subscription: "sub_attempt",
    customer: "cus_attempt",
  };
  const calls: Array<{
    path: string;
    method: string | undefined;
    form: URLSearchParams;
    headers: Headers;
  }> = [];
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      method: init?.method,
      form: new URLSearchParams(String(init?.body ?? "")),
      headers: new Headers(init?.headers),
    });
    if (path.endsWith("/expire")) return Response.json({}, { status: 400 });
    return path.endsWith("/cs_test_attempt")
      ? Response.json(payment)
      : Response.json({ id: "cs_test_attempt", url: "https://checkout.example.test/session" });
  });
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    const attempt = {
      accountId: id,
      requestId,
      priceId: "price_1",
      expiresAt: new Date(timestamp * 1000),
    };
    await stripe.checkout(attempt);
    await stripe.checkout(attempt);
    expect(calls[0]?.form.get("expires_at")).toBe(String(timestamp));
    expect(calls[0]?.headers.get("idempotency-key")).toBe(`cloud-computer:${id}:${requestId}`);
    expect(calls[1]).toEqual(calls[0]);
    expect(await stripe.expireCheckout("cs_test_attempt")).toMatchObject({
      status: "complete",
      payment: { invoice: "in_attempt" },
    });
    expect(calls.slice(2).map(({ path, method }) => [path, method])).toEqual([
      ["/v1/checkout/sessions/cs_test_attempt/expire", "POST"],
      ["/v1/checkout/sessions/cs_test_attempt", "GET"],
    ]);
  } finally {
    provider.mockRestore();
  }
});

it("refunds the Checkout invoice payment and waits for Stripe's confirmed refund", async () => {
  const refund = {
    id: "re_attempt",
    amount: 2900,
    status: "pending",
    metadata: { opensteer_invoice_payment: "inpay_attempt" },
  };
  let existing: object[] = [];
  const sent = vi.fn();
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/invoice_payments") {
      expect(url.searchParams.get("invoice")).toBe("in_attempt");
      return Response.json({
        has_more: false,
        data: [
          {
            id: "inpay_attempt",
            status: "paid",
            amount_paid: 2900,
            payment: { type: "payment_intent", payment_intent: "pi_attempt" },
          },
        ],
      });
    }
    expect(url.pathname).toBe("/v1/refunds");
    if (init?.method === "GET") {
      expect(url.searchParams.get("payment_intent")).toBe("pi_attempt");
      return Response.json({ has_more: false, data: existing });
    }
    sent(
      Object.fromEntries(new URLSearchParams(String(init?.body))),
      new Headers(init?.headers).get("idempotency-key"),
    );
    existing = [refund];
    return Response.json(refund);
  });
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    const checkout = StripePaidCheckoutSchema.parse({
      id: "cs_attempt",
      mode: "subscription",
      customer: "cus_attempt",
      subscription: "sub_attempt",
      currency: "usd",
      payment_status: "paid",
      invoice: "in_attempt",
      client_reference_id: "acct_00000000-0000-4000-8000-000000000001",
      metadata: {
        account_id: "acct_00000000-0000-4000-8000-000000000001",
        request_id: "00000000-0000-4000-8000-000000000001",
      },
    });
    await expect(stripe.refundCheckout(checkout)).resolves.toBe(false);
    await expect(stripe.refundCheckout(checkout)).resolves.toBe(false);
    existing = [{ ...refund, status: "succeeded" }];
    await expect(stripe.refundCheckout(checkout)).resolves.toBe(true);
    expect(sent).toHaveBeenCalledExactlyOnceWith(
      {
        payment_intent: "pi_attempt",
        amount: "2900",
        "metadata[opensteer_invoice_payment]": "inpay_attempt",
      },
      "cloud-computer-refund:inpay_attempt:first",
    );
  } finally {
    provider.mockRestore();
  }
});

it("opens only the validated dedicated portal configuration with the call's return URL", async () => {
  const features = {
    customer_update: { enabled: false },
    invoice_history: { enabled: false },
    subscription_update: { enabled: false },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true },
  };
  const configuration = { id: "bpc_cloud", active: true, is_default: false, features };
  const portal = vi.fn();
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/billing_portal/configurations/bpc_cloud")
      return Response.json(configuration);
    expect(url.pathname).toBe("/v1/billing_portal/sessions");
    portal(Object.fromEntries(new URLSearchParams(String(init?.body))));
    return Response.json({ url: "https://billing.example.test" });
  });
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    await expect(stripe.validatePortal("bpc_cloud")).resolves.toBeUndefined();
    await stripe.portal(
      "cus_attempt",
      new URL("https://pages.example.test/cloud-computer"),
      "bpc_cloud",
    );
    expect(portal).toHaveBeenCalledExactlyOnceWith({
      customer: "cus_attempt",
      configuration: "bpc_cloud",
      return_url: "https://pages.example.test/cloud-computer",
    });
    await expect(stripe.validatePortal("bpc_cloud", "organization")).rejects.toThrow(
      "unsupported changes",
    );
    features.invoice_history.enabled = true;
    features.subscription_cancel.enabled = false;
    await expect(stripe.validatePortal("bpc_cloud", "organization")).resolves.toBeUndefined();
    features.subscription_update.enabled = true;
    await expect(stripe.validatePortal("bpc_cloud", "organization")).rejects.toThrow(
      "unsupported changes",
    );
    features.invoice_history.enabled = false;
    features.subscription_cancel.enabled = true;
    features.subscription_update.enabled = false;
    configuration.is_default = true;
    await expect(stripe.validatePortal("bpc_cloud")).rejects.toThrow("unsupported changes");
    configuration.is_default = false;
    features.subscription_update.enabled = true;
    await expect(stripe.validatePortal("bpc_cloud")).rejects.toThrow("unsupported changes");
  } finally {
    provider.mockRestore();
  }
});

it("finds an ambiguous Checkout beyond the first twenty pages", async () => {
  const accountId = ControlPlaneAccountIdSchema.parse("acct_00000000-0000-4000-8000-000000000001");
  const requestId = "00000000-0000-4000-8000-000000000001";
  let page = 0;
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("created[lte]")).toBe(String(timestamp + 3600));
    if (page) expect(url.searchParams.get("starting_after")).toBe(`cs_page_${page}`);
    page++;
    return Response.json({
      has_more: page < 21,
      data: [
        {
          id: `cs_page_${page}`,
          status: "open",
          url: "https://checkout.example.test/session",
          metadata: page === 21 ? { account_id: accountId, request_id: requestId } : {},
        },
      ],
    });
  });
  try {
    const stripe = new CloudComputerStripe({
      key,
      returnUrl: new URL("https://account.example.test"),
    });
    await expect(
      stripe.findCheckout({
        accountId,
        requestId,
        sessionId: null,
        createdAt: new Date(timestamp * 1000),
        expiresAt: new Date((timestamp + 3600) * 1000),
      }),
    ).resolves.toMatchObject({ id: "cs_page_21", status: "open" });
    expect(page).toBe(21);
  } finally {
    provider.mockRestore();
  }
});

import { createHmac, timingSafeEqual } from "node:crypto";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import type {
  ControlPlaneAccountId,
  CloudComputerPlanSchema,
} from "@opensteer/control-plane-protocol";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import type { BillingStatus } from "./tables.js";

export const stripeApiVersion = "2026-11-18.endive";
const stripeToken = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`, "u"));
const customerId = stripeToken("cus");
const subscriptionId = stripeToken("sub");
const sessionId = stripeToken("cs");
const metadata = z.object({ account_id: ControlPlaneAccountIdSchema, request_id: z.uuid() });
const objectId = z.object({ id: subscriptionId });
const invoiceSubscription = z.object({
  subscription: subscriptionId.nullish(),
  parent: z
    .object({
      subscription_details: z.object({ subscription: subscriptionId }).nullish(),
    })
    .nullish(),
});
const checkout = z.object({
  id: sessionId,
  mode: z.literal("subscription"),
  client_reference_id: ControlPlaneAccountIdSchema,
  metadata,
});
export const StripePaidCheckoutSchema = checkout.extend({
  customer: customerId,
  subscription: subscriptionId,
  currency: z.string(),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
});
const eventSchema = z.object({
  id: stripeToken("evt"),
  type: z.string().min(1).max(120),
  data: z.object({ object: z.unknown() }),
});

export type StripeEvent = { id: string; type: string } & (
  | { operation: "completed"; checkout: z.infer<typeof StripePaidCheckoutSchema> }
  | { operation: "expired"; checkout: z.infer<typeof checkout> }
  | { operation: "billing"; subscriptionId: string }
  | { operation: "ignore" }
);

export function verifyStripeSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header || header.length > 4096) return false;
  const values = header.split(",").map((value) => value.trim());
  const timestamps = values.filter((value) => /^t=\d{1,12}$/u.test(value));
  const timestamp = timestamps[0]?.slice(2);
  if (!timestamp || timestamps.length !== 1 || Math.abs(now / 1000 - Number(timestamp)) > 300)
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  return values.some(
    (value) =>
      /^v1=[a-f0-9]{64}$/u.test(value) &&
      timingSafeEqual(Buffer.from(value.slice(3), "hex"), expected),
  );
}

export function decodeStripeEvent(raw: Buffer): StripeEvent {
  try {
    const { id, type, data } = eventSchema.parse(JSON.parse(raw.toString("utf8")));
    const base = { id, type };
    switch (type) {
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.completed": {
        const result = StripePaidCheckoutSchema.safeParse(data.object);
        if (!result.success || result.data.payment_status !== "paid")
          return { ...base, operation: "ignore" };
        return { ...base, operation: "completed", checkout: result.data };
      }
      case "checkout.session.expired": {
        const result = checkout.safeParse(data.object);
        return result.success
          ? { ...base, operation: "expired", checkout: result.data }
          : { ...base, operation: "ignore" };
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return { ...base, operation: "billing", subscriptionId: objectId.parse(data.object).id };
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = invoiceSubscription.parse(data.object);
        const subscription =
          invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
        if (!subscription) return { ...base, operation: "ignore" };
        return { ...base, operation: "billing", subscriptionId: subscription };
      }
      default:
        return { ...base, operation: "ignore" };
    }
  } catch {
    throw new ControlPlaneError("bad_request", "Invalid Stripe event");
  }
}

const hostedSession = z.object({ url: z.url({ protocol: /^https$/u }) });
const createdSession = hostedSession.extend({ id: sessionId });
const checkoutRecord = z
  .object({
    id: sessionId,
    status: z.enum(["open", "complete", "expired"]),
    url: z.url({ protocol: /^https$/u }).nullable(),
    metadata: z.record(z.string(), z.string()).nullable(),
  })
  .passthrough();
const checkoutPage = z.object({ has_more: z.boolean(), data: z.array(checkoutRecord) });
const price = z.object({
  id: stripeToken("price"),
  active: z.boolean(),
  currency: z.string(),
  unit_amount: z.number().int().nullable(),
  recurring: z
    .object({
      interval: z.string(),
      interval_count: z.number().int(),
      usage_type: z.literal("licensed"),
    })
    .nullable(),
});
const stripeSubscription = z.object({
  pause_collection: z.object({ behavior: z.string() }).nullish(),
  id: subscriptionId,
  customer: customerId,
  status: z.enum([
    "active",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "past_due",
    "paused",
    "trialing",
    "unpaid",
  ]),
  latest_invoice: z
    .object({
      status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
      attempt_count: z.number().int().nonnegative(),
    })
    .nullable(),
  metadata: z.record(z.string(), z.string()),
  items: z.object({
    has_more: z.boolean(),
    data: z.array(
      z.object({
        price: z.object({ id: stripeToken("price"), currency: z.string() }),
        quantity: z.number().int(),
      }),
    ),
  }),
});

export interface CheckoutInput {
  readonly accountId: ControlPlaneAccountId;
  readonly requestId: string;
  readonly priceId: string;
}

interface StripeOptions {
  readonly key: string;
  readonly returnUrl: URL;
  readonly baseUrl?: URL;
}

export class CloudComputerStripe {
  readonly #options: StripeOptions;

  constructor(options: StripeOptions) {
    this.#options = options;
  }

  checkout(input: CheckoutInput) {
    const success = new URL(this.#options.returnUrl);
    success.searchParams.set("cloud-computer", "checkout-completed");
    return this.#request(
      "checkout/sessions",
      createdSession,
      {
        mode: "subscription",
        "allowed_payment_method_types[0]": "card",
        payment_method_collection: "always",
        "line_items[0][price]": input.priceId,
        "line_items[0][quantity]": "1",
        client_reference_id: input.accountId,
        "metadata[account_id]": input.accountId,
        "metadata[request_id]": input.requestId,
        "subscription_data[metadata][account_id]": input.accountId,
        "subscription_data[metadata][request_id]": input.requestId,
        success_url: success.toString(),
        cancel_url: this.#options.returnUrl.toString(),
      },
      `cloud-computer:${input.accountId}:${input.requestId}`,
    );
  }

  portal(customer: string) {
    return this.#request("billing_portal/sessions", hostedSession, {
      customer: customerId.parse(customer),
      return_url: this.#options.returnUrl.toString(),
    });
  }

  subscription(id: string) {
    return this.#request(
      `subscriptions/${subscriptionId.parse(id)}?expand%5B%5D=latest_invoice`,
      stripeSubscription,
    );
  }

  async validateOffer(
    id: string,
    offer: z.infer<typeof CloudComputerPlanSchema> & { interval: string },
  ): Promise<void> {
    const actual = await this.#request(`prices/${stripeToken("price").parse(id)}`, price);
    if (
      actual.id !== id ||
      !actual.active ||
      actual.currency !== offer.currency ||
      actual.unit_amount !== offer.amountMinor ||
      actual.recurring?.interval !== offer.interval ||
      actual.recurring.interval_count !== 1
    ) {
      throw new ControlPlaneError(
        "unavailable",
        "The configured Stripe price does not match the Cloud Computer offer",
      );
    }
  }

  async findCheckout(
    input: Pick<CheckoutInput, "accountId" | "requestId"> & {
      sessionId: string | null;
      createdAt: Date;
    },
  ) {
    const matches = (record: z.infer<typeof checkoutRecord>) =>
      record.metadata?.account_id === input.accountId &&
      record.metadata.request_id === input.requestId;
    let record: z.infer<typeof checkoutRecord> | undefined;
    if (input.sessionId) {
      record = await this.#request(
        `checkout/sessions/${sessionId.parse(input.sessionId)}`,
        checkoutRecord,
      );
      if (!matches(record))
        throw new ControlPlaneError("unavailable", "Stripe returned another Checkout Session");
    } else {
      const query = new URLSearchParams({
        "created[gte]": String(Math.floor(input.createdAt.getTime() / 1000)),
        limit: "100",
      });
      for (let page = 0; ; page++) {
        if (page === 20)
          throw new ControlPlaneError(
            "unavailable",
            "Stripe Checkout lookup could not be completed",
          );
        const result = await this.#request(`checkout/sessions?${query}`, checkoutPage);
        for (const candidate of result.data.filter(matches)) {
          if (record)
            throw new ControlPlaneError(
              "unavailable",
              "More than one Stripe Checkout Session matched",
            );
          record = candidate;
        }
        if (!result.has_more) break;
        const last = result.data.at(-1);
        if (!last)
          throw new ControlPlaneError("unavailable", "Stripe Checkout pagination was incomplete");
        query.set("starting_after", last.id);
      }
    }
    if (!record) return undefined;
    const paid = StripePaidCheckoutSchema.safeParse(record);
    return {
      id: record.id,
      status: record.status,
      url: record.url,
      payment: paid.success && paid.data.payment_status === "paid" ? paid.data : undefined,
    };
  }

  async cancel(id: string): Promise<void> {
    const canceled = z.object({ id: subscriptionId, status: z.literal("canceled") });
    const result = await this.#request(
      `subscriptions/${subscriptionId.parse(id)}?invoice_now=false&prorate=false`,
      canceled,
      undefined,
      undefined,
      "DELETE",
    );
    if (result.id !== id)
      throw new ControlPlaneError("unavailable", "Stripe returned another subscription");
  }

  async #request<T>(
    path: string,
    schema: z.ZodType<T>,
    form?: Record<string, string>,
    idempotencyKey?: string,
    method = form ? "POST" : "GET",
  ): Promise<T> {
    const signal = AbortSignal.timeout(10_000);
    try {
      const response = await fetch(
        new URL(path, this.#options.baseUrl ?? "https://api.stripe.com/v1/"),
        {
          method,
          headers: {
            authorization: `Bearer ${this.#options.key}`,
            "stripe-version": stripeApiVersion,
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          ...(form ? { body: new URLSearchParams(form) } : {}),
          redirect: "error",
          signal,
        },
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new ControlPlaneError("unavailable", "Stripe did not accept the billing request");
      }
      const bytes = await readBoundedResponse(response, { maximumBytes: 512 * 1024, signal });
      return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new ControlPlaneError("unavailable", "Stripe billing is temporarily unavailable");
    }
  }
}

export type StripeSubscription = Awaited<ReturnType<CloudComputerStripe["subscription"]>>;
export type StripeBilling = Pick<
  CloudComputerStripe,
  "checkout" | "portal" | "subscription" | "cancel" | "findCheckout" | "validateOffer"
>;

export function billingStatus(subscription: StripeSubscription): BillingStatus {
  switch (subscription.status) {
    case "active":
      if (subscription.pause_collection) return "inactive";
      if (subscription.latest_invoice?.status === "paid") return "active";
      return subscription.latest_invoice?.status === "open" &&
        subscription.latest_invoice.attempt_count > 0
        ? "payment_failed"
        : "inactive";
    case "past_due":
    case "unpaid":
    case "canceled":
      return subscription.status;
    case "incomplete_expired":
      return "canceled";
    default:
      return "inactive";
  }
}

export function matchesPrice(
  subscription: StripeSubscription,
  priceId: string,
  currency: string,
): boolean {
  const item = subscription.items.data[0];
  return (
    !subscription.items.has_more &&
    subscription.items.data.length === 1 &&
    item?.quantity === 1 &&
    item.price.id === priceId &&
    item.price.currency === currency
  );
}

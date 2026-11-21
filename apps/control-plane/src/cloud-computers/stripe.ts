import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  OrganizationIdSchema,
} from "@opensteer/control-plane-protocol";
import type {
  ControlPlaneAccountId,
  CloudComputerPlanSchema,
  OrganizationId,
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
const metadata = z.object({
  account_id: ControlPlaneAccountIdSchema,
  request_id: z.uuid(),
  organization_id: OrganizationIdSchema.optional(),
});
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
  invoice: stripeToken("in").nullish(),
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
        if (!result.success) {
          const status = z
            .object({ payment_status: z.string().optional(), mode: z.string().optional() })
            .parse(data.object);
          if (
            status.payment_status === "paid" &&
            status.mode !== "payment" &&
            status.mode !== "setup"
          )
            throw new ControlPlaneError(
              "unavailable",
              "Could not interpret a paid Stripe Checkout Session",
            );
          return { ...base, operation: "ignore" };
        }
        if (result.data.payment_status !== "paid") return { ...base, operation: "ignore" };
        return { ...base, operation: "completed", checkout: result.data };
      }
      case "checkout.session.expired": {
        const result = checkout.safeParse(data.object);
        return result.success
          ? { ...base, operation: "expired", checkout: result.data }
          : { ...base, operation: "ignore" };
      }
      case "customer.subscription.pending_update_applied":
      case "customer.subscription.pending_update_expired":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return { ...base, operation: "billing", subscriptionId: objectId.parse(data.object).id };
      case "invoice.paid":
      case "invoice.finalization_failed":
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
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError("bad_request", "Invalid Stripe event");
  }
}

type StripePaidCheckout = z.infer<typeof StripePaidCheckoutSchema>;
const invoicePayments = z.object({
  has_more: z.boolean(),
  data: z.array(
    z.object({
      id: stripeToken("inpay"),
      status: z.string(),
      amount_paid: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .transform((amount) => amount ?? 0),
      payment: z.object({
        type: z.string(),
        payment_intent: stripeToken("pi").nullish(),
        charge: stripeToken("ch").nullish(),
      }),
    }),
  ),
});
const refundRecord = z.object({
  id: stripeToken("re"),
  amount: z.number().int().positive(),
  status: z.enum(["pending", "requires_action", "succeeded", "failed", "canceled"]),
  metadata: z.record(z.string(), z.string()),
});
const refundList = z.object({ has_more: z.boolean(), data: z.array(refundRecord) });
const paidInvoiceList = z.object({
  has_more: z.boolean(),
  data: z.array(
    z.object({
      id: stripeToken("in"),
      amount_paid: z.number().int().nonnegative(),
      status_transitions: z.object({ paid_at: z.number().int().positive().nullish() }).nullish(),
    }),
  ),
});
const customerRecord = z.object({ id: z.string(), deleted: z.boolean().optional() });
const hostedSession = z.object({ url: z.url({ protocol: /^https$/u }) });
const createdSession = hostedSession.extend({ id: sessionId });
const checkoutRecord = z
  .object({
    id: sessionId,
    status: z.enum(["open", "complete", "expired"]),
    url: z.url({ protocol: /^https$/u }).nullable(),
    metadata: z.record(z.string(), z.string()).nullable(),
    payment_status: z.enum(["paid", "unpaid", "no_payment_required"]).optional(),
  })
  .passthrough();
function checkoutResult(record: z.infer<typeof checkoutRecord>) {
  const paid = StripePaidCheckoutSchema.safeParse(record);
  if (record.payment_status === "paid" && !paid.success)
    throw new ControlPlaneError(
      "unavailable",
      "Could not interpret a paid Stripe Checkout Session",
    );
  return {
    id: record.id,
    status: record.status,
    url: record.url,
    payment: paid.success && paid.data.payment_status === "paid" ? paid.data : undefined,
    ...(record.subscription != null
      ? { subscription: subscriptionId.parse(record.subscription) }
      : {}),
  };
}
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
const stripeTimestamp = z.number().int().positive().max(253_402_300_799);
const billingInvoice = z.object({
  id: stripeToken("in").optional(),
  status: z.enum(["draft", "open", "paid", "uncollectible", "void"]),
  attempt_count: z.number().int().nonnegative(),
  billing_reason: z.string().nullish(),
  last_finalization_error: z.object({}).nullish(),
  hosted_invoice_url: z.url({ protocol: /^https$/u }).nullish(),
});
const stripeSubscription = z.object({
  cancel_at: stripeTimestamp.nullish(),
  cancel_at_period_end: z.boolean().optional(),
  pending_update: z
    .object({
      expires_at: z.number().int().positive(),
      subscription_items: z
        .array(
          z.object({
            id: stripeToken("si").optional(),
            quantity: z.number().int().optional(),
          }),
        )
        .nullish(),
    })
    .nullish(),
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
  latest_invoice: billingInvoice.nullable(),
  metadata: z.record(z.string(), z.string()),
  items: z.object({
    has_more: z.boolean(),
    data: z.array(
      z.object({
        id: stripeToken("si").optional(),
        current_period_end: stripeTimestamp.optional(),
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
  readonly organization?: { id: OrganizationId; quantity: number };
  /** Where Stripe sends the person back; the client's return address when absent. */
  readonly returnUrl?: URL;
  readonly expiresAt?: Date;
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
    const returnUrl = input.returnUrl ?? this.#options.returnUrl;
    const success = new URL(returnUrl);
    success.searchParams.set("checkout", input.requestId);
    return this.#request(
      "checkout/sessions",
      createdSession,
      {
        mode: "subscription",
        "allowed_payment_method_types[0]": "card",
        payment_method_collection: "always",
        ...(input.expiresAt
          ? { expires_at: String(Math.floor(input.expiresAt.getTime() / 1000)) }
          : {}),
        "line_items[0][price]": input.priceId,
        "line_items[0][quantity]": String(input.organization?.quantity ?? 1),
        ...(input.organization
          ? {
              "metadata[organization_id]": input.organization.id,
              "subscription_data[metadata][organization_id]": input.organization.id,
            }
          : {}),
        client_reference_id: input.accountId,
        "metadata[account_id]": input.accountId,
        "metadata[request_id]": input.requestId,
        "subscription_data[metadata][account_id]": input.accountId,
        "subscription_data[metadata][request_id]": input.requestId,
        success_url: success.toString(),
        cancel_url: returnUrl.toString(),
      },
      input.organization
        ? `organization:${input.organization.id}:${input.requestId}`
        : `cloud-computer:${input.accountId}:${input.requestId}`,
    );
  }

  portal(customer: string, returnUrl: URL = this.#options.returnUrl, configuration?: string) {
    return this.#request("billing_portal/sessions", hostedSession, {
      customer: customerId.parse(customer),
      return_url: returnUrl.toString(),
      ...(configuration ? { configuration: stripeToken("bpc").parse(configuration) } : {}),
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

  async findCheckout(input: {
    accountId: ControlPlaneAccountId | null;
    requestId: string;
    organizationId?: OrganizationId;
    sessionId: string | null;
    createdAt: Date;
    expiresAt?: Date;
  }) {
    const matches = (record: z.infer<typeof checkoutRecord>) =>
      record.metadata?.request_id === input.requestId &&
      record.metadata.organization_id === input.organizationId &&
      (input.accountId
        ? record.metadata.account_id === input.accountId
        : input.organizationId !== undefined);
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
        ...(input.expiresAt
          ? { "created[lte]": String(Math.floor(input.expiresAt.getTime() / 1000)) }
          : {}),
        limit: "100",
      });
      for (;;) {
        const result = await this.#request(`checkout/sessions?${query}`, checkoutPage);
        record = result.data.find(matches);
        if (record || !result.has_more) break;
        const last = result.data.at(-1);
        if (!last || query.get("starting_after") === last.id)
          throw new ControlPlaneError("unavailable", "Stripe Checkout pagination was incomplete");
        query.set("starting_after", last.id);
      }
    }
    if (!record) return undefined;
    return checkoutResult(record);
  }

  async expireCheckout(id: string) {
    try {
      const record = await this.#request(
        `checkout/sessions/${sessionId.parse(id)}/expire`,
        checkoutRecord,
        {},
      );
      if (record.id !== id || record.status !== "expired")
        throw new ControlPlaneError("unavailable", "Stripe did not confirm Checkout expiry");
      return checkoutResult(record);
    } catch (error) {
      const record = await this.#request(
        `checkout/sessions/${sessionId.parse(id)}`,
        checkoutRecord,
      );
      if (record.id !== id || record.status === "open") throw error;
      return checkoutResult(record);
    }
  }

  async validatePortal(id: string, kind: "personal" | "organization" = "personal"): Promise<void> {
    const expected = {
      personal: { canCancel: true, invoiceHistory: false },
      organization: { canCancel: false, invoiceHistory: true },
    }[kind];
    const enabled = z.object({ enabled: z.boolean() });
    const config = await this.#request(
      `billing_portal/configurations/${stripeToken("bpc").parse(id)}`,
      z.object({
        id: stripeToken("bpc"),
        active: z.boolean(),
        is_default: z.boolean(),
        features: z.object({
          customer_update: enabled,
          invoice_history: enabled,
          subscription_update: enabled,
          payment_method_update: enabled,
          subscription_cancel: enabled,
        }),
      }),
    );
    if (
      config.id !== id ||
      !config.active ||
      config.is_default ||
      !config.features.payment_method_update.enabled ||
      config.features.subscription_cancel.enabled !== expected.canCancel ||
      config.features.customer_update.enabled ||
      config.features.invoice_history.enabled !== expected.invoiceHistory ||
      config.features.subscription_update.enabled
    ) {
      throw new ControlPlaneError(
        "unavailable",
        kind === "organization"
          ? "Organization billing portal allows unsupported changes"
          : "Cloud Computer billing portal allows unsupported changes",
        {
          reason: "cloud-computer-billing-problem",
        },
      );
    }
  }

  async refundCheckout(checkout: StripePaidCheckout): Promise<boolean> {
    const invoice =
      checkout.invoice ??
      (
        await this.#request(
          `checkout/sessions/${sessionId.parse(checkout.id)}`,
          StripePaidCheckoutSchema,
        )
      ).invoice;
    if (!invoice) throw new ControlPlaneError("unavailable", "Paid Stripe Checkout has no invoice");
    return this.#refundInvoice(invoice);
  }

  /**
   * Refunds in full every payment of this subscription that Stripe took at or after `since`,
   * whatever invoice it paid. True once each such payment is refunded; false while one waits.
   */
  async refundSubscriptionPaymentsSince(subscription: string, since: Date): Promise<boolean> {
    const query = new URLSearchParams({
      subscription: subscriptionId.parse(subscription),
      status: "paid",
      limit: "100",
    });
    const invoices = await this.#request(`invoices?${query}`, paidInvoiceList);
    if (invoices.has_more)
      throw new ControlPlaneError("unavailable", "Stripe invoices could not be established");
    const after = Math.floor(since.getTime() / 1000);
    let settled = true;
    for (const invoice of invoices.data) {
      const paidAt = invoice.status_transitions?.paid_at ?? null;
      if (invoice.amount_paid === 0 || paidAt === null || paidAt < after) continue;
      settled = (await this.#refundInvoice(invoice.id)) && settled;
    }
    return settled;
  }

  /**
   * Deletes a customer, with its saved payment methods. Stripe keeps its own records of past
   * payments. A customer already deleted is done.
   */
  async deleteCustomer(id: string): Promise<void> {
    const customer = customerId.parse(id);
    const current = await this.#request(`customers/${customer}`, customerRecord);
    if (current.deleted === true) return;
    const deleted = await this.#request(
      `customers/${customer}`,
      customerRecord,
      undefined,
      undefined,
      "DELETE",
    );
    if (deleted.id !== customer || deleted.deleted !== true)
      throw new ControlPlaneError("unavailable", "Stripe did not delete the customer");
  }

  async #refundInvoice(invoice: string): Promise<boolean> {
    const query = new URLSearchParams({ invoice, limit: "100" });
    const payments = await this.#request(`invoice_payments?${query}`, invoicePayments);
    const paid = payments.data.filter((item) => item.status === "paid" && item.amount_paid > 0);
    if (payments.has_more || !paid.length)
      throw new ControlPlaneError(
        "unavailable",
        "Stripe Checkout payments could not be established",
      );

    let settled = true;
    for (const item of paid) {
      const source =
        item.payment.type === "payment_intent" && item.payment.payment_intent
          ? { payment_intent: item.payment.payment_intent }
          : item.payment.type === "charge" && item.payment.charge
            ? { charge: item.payment.charge }
            : undefined;
      if (!source)
        throw new ControlPlaneError(
          "unavailable",
          "Stripe Checkout payment is not refundable by the Account",
        );
      const previous = await this.#request(
        `refunds?${new URLSearchParams({ ...source, limit: "100" })}`,
        refundList,
      );
      if (previous.has_more)
        throw new ControlPlaneError(
          "unavailable",
          "Stripe Checkout refunds could not be established",
        );
      const matching = previous.data.filter(
        (refund) => refund.metadata.opensteer_invoice_payment === item.id,
      );
      if (
        matching.some(
          (refund) => refund.status === "succeeded" && refund.amount === item.amount_paid,
        )
      )
        continue;
      if (
        matching.some(
          (refund) => refund.status === "pending" || refund.status === "requires_action",
        )
      ) {
        settled = false;
        continue;
      }
      const refund = await this.#request(
        "refunds",
        refundRecord,
        {
          ...source,
          amount: String(item.amount_paid),
          "metadata[opensteer_invoice_payment]": item.id,
        },
        `cloud-computer-refund:${item.id}:${matching[0]?.id ?? "first"}`,
      );
      settled = refund.status === "succeeded" && refund.amount === item.amount_paid && settled;
    }
    return settled;
  }

  async updateSeatQuantity(input: {
    item: string;
    subscription: string;
    organization: OrganizationId;
    requestId: string;
    quantity: number;
    increase: boolean;
  }): Promise<StripeSubscription> {
    const subscription = subscriptionId.parse(input.subscription);
    const result = await this.#request(
      `subscriptions/${subscription}`,
      stripeSubscription,
      {
        "items[0][id]": stripeToken("si").parse(input.item),
        "items[0][quantity]": String(input.quantity),
        "expand[0]": "latest_invoice",
        ...(input.increase
          ? { proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" }
          : { proration_behavior: "none" }),
      },
      `organization-seats:${input.organization}:${input.requestId}`,
    );
    if (result.id !== subscription)
      throw new ControlPlaneError("unavailable", "Stripe returned another subscription");
    return result;
  }

  async invoice(id: string) {
    const result = await this.#request(`invoices/${stripeToken("in").parse(id)}`, billingInvoice);
    if (result.id !== id)
      throw new ControlPlaneError("unavailable", "Stripe returned another invoice");
    return result;
  }

  async voidInvoice(id: string) {
    await this.#request(
      `invoices/${stripeToken("in").parse(id)}/void`,
      z.object({
        id: z.literal(id),
        status: z.literal("void"),
      }),
      {},
    );
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
      throw new ControlPlaneError("unavailable", "Stripe billing is temporarily unavailable", {
        reason: "cloud-computer-billing-problem",
      });
    }
  }
}

export type StripeSubscription = Awaited<ReturnType<CloudComputerStripe["subscription"]>>;
export type StripeBilling = Pick<
  CloudComputerStripe,
  | "checkout"
  | "portal"
  | "subscription"
  | "cancel"
  | "findCheckout"
  | "validateOffer"
  | "expireCheckout"
  | "refundCheckout"
  | "refundSubscriptionPaymentsSince"
  | "deleteCustomer"
  | "validatePortal"
>;

export function billingStatus(subscription: StripeSubscription): BillingStatus {
  switch (subscription.status) {
    case "active":
      return subscription.pause_collection ? "inactive" : "active";
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

export function subscriptionRenewal(
  subscription: StripeSubscription,
  billing: BillingStatus,
): Date | null {
  const end = subscription.items.data[0]?.current_period_end;
  if (
    billing !== "active" ||
    end === undefined ||
    subscription.cancel_at_period_end ||
    (subscription.cancel_at != null && subscription.cancel_at <= end)
  )
    return null;
  return new Date(end * 1000);
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

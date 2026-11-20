import type { z } from "zod";
import { cancelAndRefundCheckout } from "../cloud-computers/checkout-compensation.js";
import {
  freeBackupTargets,
  replenishSeatBackups,
  reserveSeatBackups,
  settleSeatBackups,
  trimSeatBackups,
} from "../cloud-computers/backup-capacity.js";
import { deletionView } from "../cloud-computers/deletion-view.js";
import { otherAdmin, workSignInAuthority } from "./identity.js";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
  CloudComputerIdSchema,
  ManagedHomeClaimReceiptSchema,
  OrganizationIdSchema,
  OrganizationInvitationIdSchema,
  OrganizationSeatQuantitySchema,
  WorkAssignmentIdSchema,
  WorkPolicySchema,
  canonicalWorkAuditRecord,
  defaultWorkPolicy,
  workAuditGenesisHash,
  workAuditSigningBytes,
  type ControlPlaneAccountId,
  type OrganizationId,
  type OrganizationInvitationId,
  type OrganizationRole,
  type WorkAssignmentId,
  type WorkAssignmentView,
  type WorkAuditPush,
  type WorkPolicy,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, normalizeIdentityEmail, type DeploymentId } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  billingStatus,
  type CloudComputerStripe,
  type StripePaidCheckoutSchema,
  type StripeEvent,
  type StripeSubscription,
} from "../cloud-computers/stripe.js";
import type { CloudComputerStore } from "../cloud-computers/store.js";
import type { OrganizationOffer } from "./config.js";
import type {
  OrganizationCheckoutTable,
  OrganizationTable,
  WorkAssignmentTable,
} from "./tables.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;
type Tx = Transaction<ControlPlaneDatabaseSchema>;
type Organization = Selectable<OrganizationTable>;
type Checkout = Selectable<OrganizationCheckoutTable>;
type Assignment = Selectable<WorkAssignmentTable>;
type Billing = Pick<
  CloudComputerStripe,
  | "checkout"
  | "findCheckout"
  | "subscription"
  | "cancel"
  | "validateOffer"
  | "updateSeatQuantity"
  | "portal"
  | "expireCheckout"
  | "refundCheckout"
  | "validatePortal"
  | "invoice"
  | "voidInvoice"
>;
type CreateComputer = CloudComputerStore["createWorkComputer"];
const flushWindowMs = 3_000;
const seatDispatchWindowMs = 23 * 60 * 60_000;
const billingFreshnessMs = 5 * 60_000;

export function organizationSeats(
  org: Pick<Organization, "paidSeats" | "pendingSeats" | "billingStatus">,
  assigned: number,
) {
  const capacity =
    org.billingStatus === "active" ? Math.min(org.paidSeats, org.pendingSeats ?? org.paidSeats) : 0;
  return {
    paid: org.paidSeats,
    assigned,
    free: Math.max(0, capacity - assigned),
    pending: org.pendingSeats,
  };
}

async function otherAdminMember(db: DB, id: OrganizationId, account: ControlPlaneAccountId) {
  return db
    .selectFrom("organizationMembers")
    .select("role")
    .where("organizationId", "=", id)
    .where("accountId", "=", account)
    .where("role", "=", "admin")
    .executeTakeFirst();
}

function deny() {
  return new ControlPlaneError("forbidden", "Organization access is not allowed");
}

export class OrganizationStore {
  readonly #db: DB;
  readonly #stripe: Billing;
  readonly #offer: OrganizationOffer | undefined;
  readonly #now: () => Date;
  readonly #returnUrl: URL | undefined;
  #offerValid = false;
  #workSignIns = Promise.resolve();

  constructor(
    db: DB,
    options: {
      stripe: Billing;
      offer?: OrganizationOffer | undefined;
      now?: () => Date;
      /** Where Stripe's checkout and billing pages send an admin back. */
      returnUrl?: URL;
    },
  ) {
    this.#db = db;
    this.#stripe = options.stripe;
    this.#offer = options.offer;
    this.#now = options.now ?? (() => new Date());
    this.#returnUrl = options.returnUrl;
  }

  /** The per-seat offer, once Stripe confirmed it; absent while organizations can't be sold. */
  get offer(): OrganizationOffer | undefined {
    return this.#offerValid ? this.#offer : undefined;
  }

  async billingPortal(id: OrganizationId, account: ControlPlaneAccountId) {
    const org = await this.#db.transaction().execute((tx) => this.#admin(tx, id, account));
    const offer = this.#offer;
    if (!offer) throw new ControlPlaneError("unavailable", "Organization billing is unavailable");
    await this.#stripe.validatePortal(offer.portalConfigurationId, "organization");
    return this.#stripe.portal(org.stripeCustomerId, this.#returnUrl, offer.portalConfigurationId);
  }

  async checkOffer() {
    if (!this.#offer) return;
    this.#offerValid = false;
    await this.#stripe.validateOffer(this.#offer.priceId, this.#offer);
    await this.#stripe.validatePortal(this.#offer.portalConfigurationId, "organization");
    this.#offerValid = true;
  }

  async checkoutCompleted(account: ControlPlaneAccountId, requestId: string): Promise<boolean> {
    const completed = await this.#db
      .selectFrom("organizationCheckouts")
      .select("requestId")
      .where("founderAccountId", "=", account)
      .where("requestId", "=", requestId)
      .where("status", "=", "completed")
      .executeTakeFirst();
    return Boolean(completed);
  }

  async restoreBilling(id: OrganizationId, account: ControlPlaneAccountId, requestId: string) {
    const { name, paidSeats } = await this.#db
      .transaction()
      .execute((tx) => this.#admin(tx, id, account));
    return this.checkout(account, {
      organizationId: id,
      requestId,
      name,
      seats: Math.max(1, paidSeats),
    });
  }

  async checkout(
    account: ControlPlaneAccountId,
    input: { requestId: string; name: string; seats: number; organizationId?: OrganizationId },
  ) {
    const offer = this.#offer;
    if (!offer || !this.#offerValid)
      throw new ControlPlaneError("unavailable", "Organization checkout is unavailable");
    const attempt = await this.#db.transaction().execute(async (tx) => {
      const founder = await tx
        .selectFrom("users")
        .select(["id", "deletionFencedUntil"])
        .where("id", "=", account)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const now = this.#now();
      if (!founder || (founder.deletionFencedUntil && founder.deletionFencedUntil > now))
        throw deny();
      const existing = await tx
        .selectFrom("organizationCheckouts")
        .selectAll()
        .where("founderAccountId", "=", account)
        .where("requestId", "=", input.requestId)
        .executeTakeFirst();
      if (existing) {
        if (input.organizationId) await this.#admin(tx, input.organizationId, account);
        if (
          existing.name !== input.name ||
          existing.seats !== input.seats ||
          (existing.previousSubscriptionId ? existing.organizationId : undefined) !==
            input.organizationId
        ) {
          throw new ControlPlaneError(
            "conflict",
            "This checkout request already has a different organization or seat count",
          );
        }
        return existing;
      }
      const renewal = input.organizationId
        ? await this.#admin(tx, input.organizationId, account)
        : undefined;
      if (
        renewal &&
        (renewal.name !== input.name || renewal.closingAt || renewal.billingStatus !== "canceled")
      )
        throw new ControlPlaneError(
          "conflict",
          "This organization cannot start a new subscription",
        );
      const assigned = renewal ? await this.#count(tx, renewal.id) : 0;
      if (input.seats < assigned)
        throw new ControlPlaneError("conflict", "Offboard assignments before reducing seats");
      const organizationId = renewal?.id ?? OrganizationIdSchema.parse(`org_${randomUUID()}`);
      const open = await tx
        .selectFrom("organizationCheckouts")
        .select("requestId")
        .where("organizationId", "=", organizationId)
        .where("status", "=", "open")
        .executeTakeFirst();
      if (open) throw new ControlPlaneError("conflict", "An organization checkout is already open");
      const reserved = await freeBackupTargets(tx)
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("reservedOrganizationId", "=", organizationId)
        .where("organizationReservationRequestId", "is", null)
        .executeTakeFirstOrThrow();
      const attempt = await tx
        .insertInto("organizationCheckouts")
        .values({
          organizationId,
          previousSubscriptionId: renewal?.stripeSubscriptionId ?? null,
          returnUrl: this.#returnUrl?.toString() ?? null,
          founderAccountId: account,
          requestId: input.requestId,
          name: input.name,
          seats: input.seats,
          stripePriceId: offer.priceId,
          currency: offer.currency,
          status: "open",
          sessionId: null,
          url: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
          sentAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await reserveSeatBackups(
        tx,
        organizationId,
        input.requestId,
        input.seats - assigned - Number(reserved.count),
      );
      return attempt;
    });
    if (
      attempt.closeRequestedAt ||
      attempt.status !== "open" ||
      (!attempt.url && attempt.expiresAt.getTime() - this.#now().getTime() < 31 * 60_000)
    ) {
      throw new ControlPlaneError("conflict", "This organization checkout expired");
    }
    if (attempt.url) return { url: attempt.url };
    const session = await this.#stripe.checkout({
      accountId: account,
      requestId: attempt.requestId,
      priceId: attempt.stripePriceId,
      expiresAt: attempt.expiresAt,
      organization: { id: attempt.organizationId, quantity: attempt.seats },
      ...(attempt.returnUrl ? { returnUrl: new URL(attempt.returnUrl) } : {}),
    });
    const saved = await this.#db
      .updateTable("organizationCheckouts")
      .where("organizationId", "=", attempt.organizationId)
      .where("requestId", "=", attempt.requestId)
      .where("closeRequestedAt", "is", null)
      .where("status", "=", "open")
      .where((eb) => eb.or([eb("sessionId", "is", null), eb("sessionId", "=", session.id)]))
      .set({ sessionId: session.id, url: session.url })
      .executeTakeFirst();
    if (saved.numUpdatedRows !== 1n)
      throw new ControlPlaneError("conflict", "Organization checkout is no longer available");
    return { url: session.url };
  }

  async applyEvent(tx: Tx, event: StripeEvent): Promise<boolean> {
    if (event.operation === "billing") {
      const org = await tx
        .selectFrom("organizations")
        .selectAll()
        .where("stripeSubscriptionId", "=", event.subscriptionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!org) return false;
      await this.#syncSubscription(tx, org, false);
      return true;
    }
    if (event.operation !== "completed" && event.operation !== "expired") return false;
    const checkout = event.checkout;
    const id = checkout.metadata.organization_id;
    if (!id) return false;
    const admin = await tx
      .selectFrom("users")
      .select(["id", "deletionFencedUntil"])
      .where("id", "=", checkout.metadata.account_id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const existing = await tx
      .selectFrom("organizations")
      .selectAll()
      .where("id", "=", id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const attempt = await tx
      .selectFrom("organizationCheckouts")
      .selectAll()
      .where("organizationId", "=", id)
      .where("requestId", "=", checkout.metadata.request_id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !attempt ||
      checkout.metadata.account_id !== checkout.client_reference_id ||
      attempt.requestId !== checkout.metadata.request_id ||
      (attempt.founderAccountId !== null &&
        attempt.founderAccountId !== checkout.client_reference_id) ||
      (attempt.sessionId !== null && attempt.sessionId !== checkout.id)
    ) {
      throw new ControlPlaneError(
        "unavailable",
        "Stripe Checkout does not match the organization purchase",
      );
    }
    if (attempt.status === "completed" || attempt.status === "refunded") return true;
    const save = tx
      .updateTable("organizationCheckouts")
      .where("organizationId", "=", id)
      .where("requestId", "=", attempt.requestId);
    if (event.operation === "expired") {
      if (attempt.paidAt) return true;
      await save.set({ status: "expired", sessionId: checkout.id }).executeTakeFirst();
      await settleSeatBackups(tx, id, attempt.requestId, false);
      return true;
    }
    const payment = event.checkout;
    if (payment.payment_status !== "paid") return true;
    if (
      !admin ||
      !attempt.founderAccountId ||
      (admin.deletionFencedUntil && admin.deletionFencedUntil > this.#now()) ||
      attempt.status === "expired" ||
      attempt.closeRequestedAt ||
      (attempt.previousSubscriptionId !== null &&
        (!existing ||
          existing.closingAt ||
          existing.stripeSubscriptionId !== attempt.previousSubscriptionId ||
          existing.billingStatus !== "canceled" ||
          !(await otherAdminMember(tx, id, admin.id))))
    ) {
      await this.#compensateCheckout(tx, attempt, payment);
      return true;
    }
    const subscription = await this.#stripe.subscription(payment.subscription);
    const item = seatItem(subscription, attempt.stripePriceId, attempt.currency);
    if (
      !item ||
      item.quantity !== attempt.seats ||
      payment.currency !== attempt.currency ||
      subscription.id !== payment.subscription ||
      subscription.customer !== payment.customer ||
      subscription.metadata.organization_id !== id ||
      subscription.metadata.request_id !== attempt.requestId ||
      subscription.metadata.account_id !== checkout.client_reference_id
    ) {
      throw new ControlPlaneError(
        "unavailable",
        "Stripe subscription does not match the organization purchase",
      );
    }
    const billing = billingStatus(subscription);
    if (attempt.previousSubscriptionId && existing) {
      await tx
        .updateTable("organizations")
        .where("id", "=", id)
        .set({
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          stripePriceId: attempt.stripePriceId,
          billingCurrency: attempt.currency,
          billingStatus: billing,
          billingRefreshedAt: this.#now(),
          paidSeats: item.quantity,
        })
        .executeTakeFirstOrThrow();
    } else {
      await tx
        .insertInto("organizations")
        .values({
          id,
          name: attempt.name,
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          stripePriceId: attempt.stripePriceId,
          billingCurrency: attempt.currency,
          billingStatus: billing,
          paidSeats: item.quantity,
          billingRefreshedAt: this.#now(),
          pendingSeats: null,
          pendingSeatRequestId: null,
          pendingSeatSince: null,
          policy: JSON.stringify(defaultWorkPolicy),
          createdAt: this.#now(),
        })
        .executeTakeFirst();
      await tx
        .insertInto("organizationMembers")
        .values({
          organizationId: id,
          accountId: admin.id,
          role: "admin",
          createdAt: this.#now(),
        })
        .executeTakeFirst();
    }
    await save.set({ status: "completed", sessionId: checkout.id }).executeTakeFirst();
    if (attempt.previousSubscriptionId && existing) {
      const next = await lockOrg(tx, id);
      await this.#syncSubscription(tx, next, false);
    }
    await settleSeatBackups(tx, id, attempt.requestId, true);
    return true;
  }

  async #compensateCheckout(
    tx: Tx,
    attempt: Checkout,
    payment: z.infer<typeof StripePaidCheckoutSchema>,
  ) {
    const save = tx
      .updateTable("organizationCheckouts")
      .where("organizationId", "=", attempt.organizationId)
      .where("requestId", "=", attempt.requestId);
    await save
      .set({
        sessionId: payment.id,
        paidAt: attempt.paidAt ?? this.#now(),
        closeRequestedAt: attempt.closeRequestedAt ?? this.#now(),
        url: null,
        status: "open",
      })
      .executeTakeFirstOrThrow();
    let settled = false;
    try {
      settled = await cancelAndRefundCheckout(this.#stripe, payment);
    } catch {
      console.error("Organization Checkout cancellation or refund is pending");
    }
    if (settled) {
      await save.set({ status: "refunded" }).executeTakeFirstOrThrow();
      await settleSeatBackups(tx, attempt.organizationId, attempt.requestId, false);
    }
    return settled;
  }

  async resolveAccountCheckouts(account: ControlPlaneAccountId) {
    await this.#db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", account)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const open = await tx
        .selectFrom("organizationCheckouts")
        .select(["organizationId", "requestId"])
        .where("founderAccountId", "=", account)
        .where("status", "=", "open")
        .where("closeRequestedAt", "is", null)
        .orderBy("organizationId")
        .orderBy("requestId")
        .forNoKeyUpdate()
        .execute();
      for (const row of open) {
        await tx
          .updateTable("organizationCheckouts")
          .where("organizationId", "=", row.organizationId)
          .where("requestId", "=", row.requestId)
          .set({ closeRequestedAt: this.#now(), url: null })
          .executeTakeFirstOrThrow();
      }
    });
    const rows = await this.#db
      .selectFrom("organizationCheckouts")
      .selectAll()
      .where("founderAccountId", "=", account)
      .where("status", "=", "open")
      .orderBy("organizationId")
      .execute();
    for (const row of rows) await this.#recoverCheckout(row, true);
    const pending = await this.#db
      .selectFrom("organizationCheckouts")
      .select("organizationId")
      .where("founderAccountId", "=", account)
      .where("status", "=", "open")
      .executeTakeFirst();
    if (pending)
      throw new ControlPlaneError("unavailable", "Organization Checkout is still being resolved");
  }

  async #recoverCheckout(attempt: Checkout, close: boolean) {
    await this.#db.transaction().execute(async (tx) => {
      const owner = attempt.founderAccountId
        ? await tx
            .selectFrom("users")
            .select("deletionFencedUntil")
            .where("id", "=", attempt.founderAccountId)
            .forNoKeyUpdate()
            .executeTakeFirst()
        : undefined;
      await tx
        .selectFrom("organizations")
        .select("id")
        .where("id", "=", attempt.organizationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const row = await tx
        .selectFrom("organizationCheckouts")
        .selectAll()
        .where("organizationId", "=", attempt.organizationId)
        .where("requestId", "=", attempt.requestId)
        .where("status", "=", "open")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) return;
      const closing =
        close ||
        Boolean(row.closeRequestedAt) ||
        !owner ||
        Boolean(owner.deletionFencedUntil && owner.deletionFencedUntil > this.#now());
      let session = await this.#stripe.findCheckout({
        accountId: row.founderAccountId,
        requestId: row.requestId,
        createdAt: row.createdAt,
        sessionId: row.sessionId,
        organizationId: row.organizationId,
        expiresAt: row.expiresAt,
      });
      if (closing && session?.status === "open")
        session = await this.#stripe.expireCheckout(session.id);
      if (session?.payment) {
        if (closing) await this.#compensateCheckout(tx, row, session.payment);
        else
          await this.applyEvent(tx, {
            id: `reconcile_${session.id}`,
            type: "checkout.session.completed",
            operation: "completed",
            checkout: session.payment,
          });
        return;
      }
      if (session?.status === "complete" && session.subscription && !row.paidAt) {
        await this.#stripe.cancel(session.subscription);
      }
      if (
        !row.paidAt &&
        (session?.status === "expired" ||
          session?.status === "complete" ||
          (!session && (!row.sentAt || row.expiresAt <= this.#now())))
      ) {
        await tx
          .updateTable("organizationCheckouts")
          .where("organizationId", "=", row.organizationId)
          .where("requestId", "=", row.requestId)
          .set({ status: "expired", url: null })
          .executeTakeFirstOrThrow();
        await settleSeatBackups(tx, row.organizationId, row.requestId, false);
      } else if (session?.status === "open") {
        await tx
          .updateTable("organizationCheckouts")
          .where("organizationId", "=", row.organizationId)
          .where("requestId", "=", row.requestId)
          .set({ sessionId: session.id, url: closing ? null : session.url })
          .executeTakeFirstOrThrow();
      }
    });
  }

  async #syncSubscription(tx: Tx, org: Organization, sendUpdate: boolean) {
    let subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
    function verified(value: StripeSubscription) {
      if (value.id !== org.stripeSubscriptionId || value.customer !== org.stripeCustomerId)
        throw new ControlPlaneError(
          "unavailable",
          "Stripe returned another organization subscription",
        );
      return seatItem(value, org.stripePriceId, org.billingCurrency);
    }
    let item = verified(subscription);
    const now = this.#now();
    if (org.closingAt && !org.closedAt && billingStatus(subscription) !== "canceled") {
      await this.#stripe.cancel(subscription.id);
      subscription = await this.#stripe.subscription(subscription.id);
      item = verified(subscription);
    }

    const change = org.pendingSeatRequestId
      ? await tx
          .selectFrom("organizationSeatChanges")
          .selectAll()
          .where("organizationId", "=", org.id)
          .where("requestId", "=", org.pendingSeatRequestId)
          .forNoKeyUpdate()
          .executeTakeFirst()
      : undefined;
    let outcome: "applied" | "expired" | "abandoned" | undefined;
    let invoiceId = change?.invoiceId ?? null;
    let invoiceUrl = change?.invoiceUrl ?? null;
    let expiresAt = change?.expiresAt ?? null;
    let invoice: StripeSubscription["latest_invoice"] = null;
    if (change) {
      const inWindow = now.getTime() - change.createdAt.getTime() < seatDispatchWindowMs;
      let updated: StripeSubscription | undefined;
      // Replaying an accepted request returns its own expanded invoice, even if the first reply was lost.
      if (
        sendUpdate &&
        !change.abandonRequestedAt &&
        inWindow &&
        (!invoiceId || !change.increase) &&
        item?.id === change.itemId &&
        subscription.id === change.subscriptionId &&
        billingStatus(subscription) === "active" &&
        (change.increase || item.quantity !== change.quantity)
      ) {
        updated = await this.#stripe.updateSeatQuantity({
          item: change.itemId,
          subscription: change.subscriptionId,
          organization: org.id,
          requestId: change.requestId,
          quantity: change.quantity,
          increase: change.increase,
        });
        verified(updated);
        subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
        item = verified(subscription);
      }
      const candidate =
        updated?.latest_invoice ??
        (subscription.pending_update ? subscription.latest_invoice : null);
      if (
        change.increase &&
        !invoiceId &&
        candidate?.id &&
        candidate.id !== change.previousInvoiceId &&
        candidate.billing_reason === "subscription_update"
      ) {
        invoiceId = candidate.id;
        expiresAt =
          (updated?.pending_update ?? subscription.pending_update)
            ? new Date((updated?.pending_update ?? subscription.pending_update)!.expires_at * 1000)
            : null;
      }
      if (invoiceId) {
        invoice =
          subscription.latest_invoice?.id === invoiceId
            ? subscription.latest_invoice
            : await this.#stripe.invoice(invoiceId);
        invoiceUrl = invoice.status === "open" ? (invoice.hosted_invoice_url ?? null) : null;
      }
      if (change.abandonRequestedAt && invoice?.status === "open" && invoiceId) {
        await this.#stripe.voidInvoice(invoiceId);
        subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
        item = verified(subscription);
        invoice = await this.#stripe.invoice(invoiceId);
        invoiceUrl = null;
      }
      if (
        item?.id === change.itemId &&
        item.quantity === change.quantity &&
        !subscription.pending_update &&
        (!change.increase || invoice?.status === "paid")
      )
        outcome = "applied";
      else if (!subscription.pending_update && invoice?.status === "void")
        outcome = change.abandonRequestedAt ? "abandoned" : "expired";
      else if (
        !subscription.pending_update &&
        !invoiceId &&
        item?.quantity !== change.quantity &&
        (!inWindow || billingStatus(subscription) === "canceled")
      )
        outcome = change.abandonRequestedAt ? "abandoned" : "expired";

      await tx
        .updateTable("organizationSeatChanges")
        .where("organizationId", "=", org.id)
        .where("requestId", "=", change.requestId)
        .set({ invoiceId, invoiceUrl, expiresAt, ...(outcome ? { status: outcome } : {}) })
        .executeTakeFirstOrThrow();
    }
    const count = await this.#count(tx, org.id);
    const paidSeats =
      outcome === "applied" && item
        ? item.quantity
        : Math.min(org.paidSeats, item?.quantity ?? org.paidSeats);
    const stripeStatus = billingStatus(subscription);
    const effective =
      stripeStatus !== "active"
        ? stripeStatus
        : !item ||
            paidSeats < count ||
            (subscription.latest_invoice?.status === "draft" &&
              subscription.latest_invoice.last_finalization_error &&
              subscription.latest_invoice.id !== invoiceId)
          ? "inactive"
          : "active";
    const closedAt =
      org.closingAt && effective === "canceled" ? (org.closedAt ?? now) : org.closedAt;
    await tx
      .updateTable("organizations")
      .where("id", "=", org.id)
      .set({
        billingStatus: effective,
        billingRefreshedAt: now,
        paidSeats,
        closedAt,
        ...(outcome
          ? { pendingSeats: null, pendingSeatRequestId: null, pendingSeatSince: null }
          : {}),
      })
      .executeTakeFirstOrThrow();

    const work = await tx
      .selectFrom("workAssignments")
      .select("cloudComputerId")
      .where("organizationId", "=", org.id)
      .where("state", "=", "active")
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    const state = effective === "active" ? "active" : "suspended";
    if (work.length) {
      const computers = await tx
        .selectFrom("cloudComputers")
        .select("id")
        .where(
          "id",
          "in",
          work.map(({ cloudComputerId }) => cloudComputerId),
        )
        .where("state", "!=", "deleted")
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      for (const { id } of computers) {
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .where("state", "!=", state)
          .set({
            state,
            phase: "provisioning",
            billingStatus: effective,
            lastError: null,
            readinessStartedAt: now,
            updatedAt: now,
          })
          .executeTakeFirst();
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .where("billingStatus", "!=", effective)
          .set({ billingStatus: effective, updatedAt: now })
          .executeTakeFirst();
      }
    }
    if (outcome && change)
      await settleSeatBackups(tx, org.id, change.requestId, outcome === "applied");
    if (closedAt || outcome === "applied")
      await trimSeatBackups(tx, org.id, closedAt ? 0 : paidSeats - count);
    else if (effective === "active" && !org.closingAt)
      await replenishSeatBackups(tx, org.id, organizationSeats(org, count).free);
  }

  async reconcile(onError: (error: unknown) => void) {
    const attempt = async (job: () => Promise<unknown>) => {
      try {
        await job();
      } catch (error) {
        onError(error);
      }
    };
    const orgs = await this.#db.selectFrom("organizations").select("id").execute();
    await attempt(() => this.checkOffer());
    const pending = await this.#db
      .selectFrom("organizationCheckouts")
      .selectAll()
      .where("status", "=", "open")
      .execute();
    for (const row of pending) await attempt(() => this.#recoverCheckout(row, false));
    for (const { id } of orgs) {
      await attempt(() =>
        this.#db
          .transaction()
          .execute(async (tx) => this.#syncSubscription(tx, await lockOrg(tx, id), true)),
      );
    }
  }

  async changeSeats(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    input: { requestId: string; seats: number },
  ) {
    const sync = await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      const old = await tx
        .selectFrom("organizationSeatChanges")
        .select(["quantity", "status"])
        .where("organizationId", "=", id)
        .where("requestId", "=", input.requestId)
        .executeTakeFirst();
      if (old) {
        if (old.quantity !== input.seats)
          throw new ControlPlaneError(
            "conflict",
            "This seat request already has a different quantity",
          );
        return old.status === "pending";
      }
      if (org.closingAt || org.closedAt || org.billingStatus !== "active")
        throw new ControlPlaneError("conflict", "Organization billing needs attention");
      if (input.seats < (await this.#count(tx, id)))
        throw new ControlPlaneError("conflict", "Offboard assignments before reducing seats");
      if (org.pendingSeats !== null)
        throw new ControlPlaneError("conflict", "A seat change is already pending");
      const subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
      const item = seatItem(subscription, org.stripePriceId, org.billingCurrency);
      if (
        !item?.id ||
        item.quantity !== org.paidSeats ||
        subscription.pending_update ||
        subscription.id !== org.stripeSubscriptionId ||
        subscription.customer !== org.stripeCustomerId ||
        billingStatus(subscription) !== "active"
      )
        throw new ControlPlaneError("conflict", "Organization billing needs attention");
      const now = this.#now();
      await tx
        .insertInto("organizationSeatChanges")
        .values({
          organizationId: id,
          requestId: input.requestId,
          subscriptionId: subscription.id,
          previousInvoiceId: subscription.latest_invoice?.id ?? null,
          itemId: item.id,
          quantity: input.seats,
          increase: input.seats > org.paidSeats,
          createdAt: now,
          status: org.paidSeats === input.seats ? "applied" : "pending",
        })
        .executeTakeFirstOrThrow();
      if (org.paidSeats === input.seats) return false;
      await tx
        .updateTable("organizations")
        .where("id", "=", id)
        .set({
          pendingSeats: input.seats,
          pendingSeatRequestId: input.requestId,
          pendingSeatSince: now,
        })
        .executeTakeFirstOrThrow();
      await reserveSeatBackups(tx, id, input.requestId, input.seats - org.paidSeats);
      return true;
    });
    if (sync)
      await this.#db
        .transaction()
        .execute(async (tx) =>
          this.#syncSubscription(tx, await this.#admin(tx, id, account), true),
        );
    return this.admin(id, account);
  }

  async abandonSeatChange(id: OrganizationId, account: ControlPlaneAccountId, requestId: string) {
    await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      if (org.pendingSeatRequestId !== requestId)
        throw new ControlPlaneError("conflict", "This seat change is no longer pending");
      await tx
        .updateTable("organizationSeatChanges")
        .where("organizationId", "=", id)
        .where("requestId", "=", requestId)
        .where("status", "=", "pending")
        .set({ abandonRequestedAt: this.#now() })
        .executeTakeFirstOrThrow();
    });
    await this.#db
      .transaction()
      .execute(async (tx) => this.#syncSubscription(tx, await this.#admin(tx, id, account), false));
  }

  async close(id: OrganizationId, account: ControlPlaneAccountId) {
    await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      if (await this.#count(tx, id))
        throw new ControlPlaneError(
          "conflict",
          "Offboard every work Home before closing the organization",
        );
      const open = await tx
        .selectFrom("organizationCheckouts")
        .select("requestId")
        .where("organizationId", "=", id)
        .where("status", "=", "open")
        .executeTakeFirst();
      if (org.pendingSeats !== null || open)
        throw new ControlPlaneError(
          "conflict",
          "Resolve the pending billing change before closing the organization",
        );
      if (!org.closingAt)
        await tx
          .updateTable("organizations")
          .where("id", "=", id)
          .set({ closingAt: this.#now() })
          .executeTakeFirstOrThrow();
    });
    await this.#db
      .transaction()
      .execute(async (tx) => this.#syncSubscription(tx, await this.#admin(tx, id, account), false));
  }

  async invite(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    input: { email: string; role: OrganizationRole },
  ) {
    return this.#db.transaction().execute(async (tx) => {
      await this.#admin(tx, id, account);
      const email = normalizeIdentityEmail(input.email);
      const member = await tx
        .selectFrom("organizationMembers")
        .innerJoin("users", "users.id", "organizationMembers.accountId")
        .where("organizationMembers.organizationId", "=", id)
        .where("users.email", "=", email)
        .select("users.id")
        .executeTakeFirst();
      if (member) throw new ControlPlaneError("conflict", "This Account is already a member");
      const existing = await tx
        .selectFrom("organizationInvitations")
        .where("organizationId", "=", id)
        .where("email", "=", email)
        .where("acceptedAt", "is", null)
        .selectAll()
        .executeTakeFirst();
      if (existing) {
        if (existing.role !== input.role)
          throw new ControlPlaneError("conflict", "An invitation with a different role is pending");
        return invitationView(existing);
      }
      const invite = await tx
        .insertInto("organizationInvitations")
        .values({
          id: OrganizationInvitationIdSchema.parse(`oi_${randomUUID()}`),
          organizationId: id,
          email,
          role: input.role,
          createdAt: this.#now(),
          acceptedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return invitationView(invite);
    });
  }

  async accept(id: OrganizationInvitationId, account: ControlPlaneAccountId) {
    await this.#db.transaction().execute(async (tx) => {
      const user = await tx
        .selectFrom("users")
        .select(["email", "emailVerified", "deletionFencedUntil"])
        .where("id", "=", account)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const invite = await tx
        .selectFrom("organizationInvitations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (
        !user?.emailVerified ||
        (user.deletionFencedUntil && user.deletionFencedUntil > this.#now()) ||
        !invite ||
        normalizeIdentityEmail(user.email) !== invite.email
      )
        throw deny();
      await lockOrg(tx, invite.organizationId);
      const row = await tx
        .selectFrom("organizationInvitations")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      if (row.acceptedAt)
        throw new ControlPlaneError("conflict", "This invitation was already accepted");
      await tx
        .insertInto("organizationMembers")
        .values({
          organizationId: row.organizationId,
          accountId: account,
          role: row.role,
          createdAt: this.#now(),
        })
        .onConflict((c) => c.columns(["organizationId", "accountId"]).doNothing())
        .executeTakeFirst();
      await tx
        .updateTable("organizationInvitations")
        .where("id", "=", id)
        .set({ acceptedAt: this.#now() })
        .executeTakeFirst();
    });
    return this.mine(account);
  }

  async changeMember(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    member: ControlPlaneAccountId,
    role: OrganizationRole | null,
  ) {
    await this.#db.transaction().execute(async (tx) => {
      await this.#admin(tx, id, account);
      const target = await tx
        .selectFrom("organizationMembers")
        .select("role")
        .where("organizationId", "=", id)
        .where("accountId", "=", member)
        .executeTakeFirst();
      if (!target) throw new ControlPlaneError("not_found", "Organization member was not found");
      if (target.role === "admin" && role !== "admin") {
        const admins = await otherAdmin(tx, id, member, this.#now());
        if (!admins)
          throw new ControlPlaneError("conflict", "The last organization admin must stay an admin");
      }
      if (role) {
        await tx
          .updateTable("organizationMembers")
          .where("organizationId", "=", id)
          .where("accountId", "=", member)
          .set({ role })
          .executeTakeFirst();
      } else {
        const live = await tx
          .selectFrom("workAssignments")
          .select("id")
          .where("organizationId", "=", id)
          .where("assigneeAccountId", "=", member)
          .where("state", "!=", "ended")
          .executeTakeFirst();
        if (live)
          throw new ControlPlaneError(
            "conflict",
            "Offboard the member’s assignment before removing them",
          );
        await tx
          .deleteFrom("organizationMembers")
          .where("organizationId", "=", id)
          .where("accountId", "=", member)
          .executeTakeFirst();
      }
    });
  }

  async assign(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    input: { requestId: string; accountId: ControlPlaneAccountId },
    create: CreateComputer,
  ) {
    const assignment = await this.#db.transaction().execute(async (tx) => {
      await this.#member(tx, id, account, true);
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", input.accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const org = await this.#admin(tx, id, account);
      const replay = await tx
        .selectFrom("workAssignments")
        .selectAll()
        .where("organizationId", "=", id)
        .where("requestId", "=", input.requestId)
        .executeTakeFirst();
      if (replay) {
        if (replay.assigneeAccountId !== input.accountId)
          throw new ControlPlaneError("conflict", "This request already has a different assignee");
        return replay;
      }
      const member = await tx
        .selectFrom("organizationMembers")
        .innerJoin("users", "users.id", "organizationMembers.accountId")
        .select("organizationMembers.accountId")
        .where("organizationId", "=", id)
        .where("accountId", "=", input.accountId)
        .where((eb) =>
          eb.or([
            eb("users.deletionFencedUntil", "is", null),
            eb("users.deletionFencedUntil", "<=", this.#now()),
          ]),
        )
        .executeTakeFirst();
      if (!member) throw new ControlPlaneError("not_found", "Organization member was not found");
      const existing = await tx
        .selectFrom("workAssignments")
        .select("id")
        .where("organizationId", "=", id)
        .where("assigneeAccountId", "=", input.accountId)
        .where("state", "!=", "ended")
        .executeTakeFirst();
      if (existing)
        throw new ControlPlaneError("conflict", "This member already has a work assignment");
      if (
        org.closingAt ||
        org.closedAt ||
        !org.billingRefreshedAt ||
        this.#now().getTime() - org.billingRefreshedAt.getTime() > billingFreshnessMs
      )
        throw new ControlPlaneError(
          "unavailable",
          "Organization billing needs a fresh confirmation",
        );
      if (!organizationSeats(org, await this.#count(tx, id)).free)
        throw new ControlPlaneError("conflict", "No paid organization seat is available");
      const assignment = await tx
        .insertInto("workAssignments")
        .values({
          id: WorkAssignmentIdSchema.parse(`was_${randomUUID()}`),
          organizationId: id,
          cloudComputerId: CloudComputerIdSchema.parse(`cc_${randomUUID()}`),
          assigneeAccountId: input.accountId,
          requestId: input.requestId,
          state: "active",
          createdAt: this.#now(),
          signInCutAt: null,
          retainUntil: null,
          suspendedAt: null,
          endedAt: null,
          flushUntil: null,
          auditReceivedAt: null,
          auditGapReceived: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await create(tx, assignment.cloudComputerId, assignment.id);
      return assignment;
    });
    return (await this.#view(this.#db, id, assignment.id)).view;
  }

  async beginOffboard(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    assignmentId: WorkAssignmentId,
    retentionSeconds: number,
  ) {
    return this.#db.transaction().execute(async (tx) => {
      await this.#admin(tx, id, account);
      const assignment = await lockAssignment(tx, id, assignmentId);
      if (assignment.state !== "active") return { started: false } as const;
      const now = this.#now();
      await tx
        .updateTable("workAssignments")
        .where("id", "=", assignmentId)
        .set({
          state: "offboarding",
          signInCutAt: now,
          flushUntil: new Date(now.getTime() + flushWindowMs),
          retentionSeconds,
        })
        .executeTakeFirst();
      const home = await tx
        .selectFrom("cloudComputers")
        .select([
          "oidcClientId",
          "hostname",
          "deploymentId",
          "bootstrapReceiptAt",
          "phase",
          "state",
        ])
        .where("id", "=", assignment.cloudComputerId)
        .executeTakeFirstOrThrow();
      if (home.oidcClientId)
        await tx
          .updateTable("oauthClients")
          .where("clientId", "=", home.oidcClientId)
          .set({ disabled: true, updatedAt: now })
          .executeTakeFirst();
      if (
        home.state === "active" &&
        home.phase === "ready" &&
        home.bootstrapReceiptAt &&
        home.deploymentId
      )
        return {
          started: true,
          home: {
            origin: `https://${home.hostname}`,
            deploymentId: DeploymentIdSchema.parse(home.deploymentId),
          },
        } as const;
      return { started: true, home: null } as const;
    });
  }

  async offboardingStatus(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    assignmentId: WorkAssignmentId,
  ) {
    await this.#member(this.#db, id, account, true);
    return (await this.#view(this.#db, id, assignmentId)).view;
  }

  async finishOffboard(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    assignmentId: WorkAssignmentId,
    confirmed = false,
  ) {
    await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      await tx
        .updateTable("workAssignments")
        .where("organizationId", "=", id)
        .where("id", "=", assignmentId)
        .where("state", "=", "offboarding")
        .set({ flushUntil: null, finalAudit: confirmed ? "confirmed" : "unconfirmed" })
        .executeTakeFirst();
      await this.#advance(tx, org.id, assignmentId);
    });
    return (await this.#view(this.#db, id, assignmentId)).view;
  }

  async reconcileOffboarding(onError: (error: unknown) => void) {
    const due = await this.#db
      .selectFrom("workAssignments")
      .select(["organizationId", "id"])
      .where("state", "!=", "ended")
      .where((eb) => eb.or([eb("state", "=", "offboarding"), eb("assigneeAccountId", "is", null)]))
      .orderBy(sql`offboarding_checked_at asc nulls first`)
      .orderBy("id")
      .limit(16)
      .execute();
    for (const { organizationId, id } of due) {
      try {
        await this.#db.transaction().execute(async (tx) => {
          await lockOrg(tx, organizationId);
          await this.#advance(tx, organizationId, id);
        });
      } catch (error) {
        onError(error);
      }
    }
  }

  async #advance(tx: Tx, organizationId: OrganizationId, id: WorkAssignmentId) {
    const org = await tx
      .selectFrom("organizations")
      .selectAll()
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow();
    const assignment = await lockAssignment(tx, organizationId, id);
    if (
      assignment.state === "ended" ||
      (assignment.state === "active" && assignment.assigneeAccountId)
    )
      return;
    const home = await tx
      .selectFrom("cloudComputers")
      .select(["state", "phase", "tombstonedAt", "reportedAt"])
      .where("id", "=", assignment.cloudComputerId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const now = this.#now();
    const update = tx.updateTable("workAssignments").where("id", "=", id);
    if (home.tombstonedAt) {
      await update
        .set({
          state: "ended",
          endedAt: home.tombstonedAt,
          offboardingCheckedAt: now,
        })
        .executeTakeFirstOrThrow();
      if (org.billingStatus === "active" && !org.closingAt)
        await replenishSeatBackups(
          tx,
          org.id,
          organizationSeats(org, await this.#count(tx, org.id)).free,
        );
      return;
    }

    const suspended = home.state === "suspended" && home.phase === "suspended";
    const suspendedAt =
      assignment.suspendedAt ??
      new Date(
        Math.max(
          home.reportedAt?.getTime() ?? now.getTime(),
          assignment.signInCutAt?.getTime() ?? now.getTime(),
        ),
      );
    const retainUntil = suspended
      ? (assignment.retainUntil ??
        new Date(suspendedAt.getTime() + 1000 * assignment.retentionSeconds))
      : null;
    await update
      .set({
        offboardingCheckedAt: now,
        ...(assignment.state === "active" ? { state: "offboarding", signInCutAt: now } : {}),
        ...(!assignment.finalAudit && (!assignment.flushUntil || assignment.flushUntil <= now)
          ? { finalAudit: "unconfirmed" }
          : {}),
        ...(suspended ? { suspendedAt, retainUntil } : {}),
      })
      .executeTakeFirstOrThrow();
    if (assignment.flushUntil && assignment.flushUntil > now) return;

    const edit = tx.updateTable("cloudComputers").where("id", "=", assignment.cloudComputerId);
    if (home.state === "active") {
      await edit
        .set({ state: "suspended", phase: "provisioning", updatedAt: now })
        .executeTakeFirstOrThrow();
    } else if (retainUntil && retainUntil <= now) {
      await edit
        .set({
          state: "deleted",
          phase: "deleting",
          deletionRequestedAt: now,
          deletedAt: now,
          updatedAt: now,
          bootstrapDigest: null,
          sealedBootstrapToken: null,
          bootstrapExpiresAt: null,
          setupCodeDigest: null,
          sealedSetupCode: null,
          sealedOidcClientSecret: null,
          sealedHostCredential: null,
        })
        .executeTakeFirstOrThrow();
    }
  }

  async setPolicy(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    input: { expectedRevision: number; policy: WorkPolicy },
  ) {
    return this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      if (org.policyRevision !== input.expectedRevision)
        throw new ControlPlaneError("conflict", "Organization policy changed");
      const revision = org.policyRevision + 1;
      await tx
        .updateTable("organizations")
        .where("id", "=", id)
        .set({ policy: JSON.stringify(input.policy), policyRevision: revision })
        .executeTakeFirst();
      return { policy: input.policy, revision };
    });
  }

  async issueWorkSignIn<T>(
    clientId: string,
    sessionAccount: (() => Promise<string | undefined>) | undefined,
    issue: () => Promise<T>,
  ): Promise<T> {
    if (!(await workSignInAuthority(this.#db, clientId))) return issue();
    const previous = this.#workSignIns;
    // Only one route per replica may hold an assignment lock while Better Auth uses its pool.
    let release!: () => void;
    this.#workSignIns = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const account = await sessionAccount?.();
      return await this.#db.transaction().execute(async (tx) => {
        const assignment = await workSignInAuthority(tx, clientId, true);
        if (
          !assignment ||
          assignment.state !== "active" ||
          !assignment.assigneeAccountId ||
          (account && account !== assignment.assigneeAccountId)
        )
          throw new ControlPlaneError("forbidden", "Sign-in to this work Home is not allowed");
        return issue();
      });
    } finally {
      release();
    }
  }

  async hostPolicy(id: WorkAssignmentId, deploymentId: DeploymentId) {
    const { assignment, org } = await this.#host(this.#db, id, deploymentId);
    return {
      assignmentId: id,
      deploymentId,
      policy: WorkPolicySchema.parse(org.policy),
      revision: org.policyRevision,
      state: assignment.state,
    };
  }

  async applied(id: WorkAssignmentId, deploymentId: DeploymentId, revision: number) {
    return this.#db.transaction().execute(async (tx) => {
      const { assignment, org } = await this.#host(tx, id, deploymentId, true);
      if (revision > org.policyRevision)
        throw new ControlPlaneError("bad_request", "Work policy revision has not been issued");
      const appliedRevision = Math.max(assignment.appliedRevision, revision);
      await tx
        .updateTable("workAssignments")
        .where("id", "=", id)
        .set({ appliedRevision })
        .executeTakeFirst();
      return { appliedRevision };
    });
  }

  async auditPush(id: WorkAssignmentId, deploymentId: DeploymentId, batch: WorkAuditPush) {
    if (batch.assignmentId !== id) throw deny();
    return this.#db.transaction().execute(async (tx) => {
      const { assignment, home } = await this.#host(tx, id, deploymentId, true);
      const receipt = ManagedHomeClaimReceiptSchema.safeParse(home.bootstrapReceipt);
      if (
        !receipt.success ||
        receipt.data.document.work?.assignmentId !== id ||
        hostKeyFingerprint(receipt.data.publicKey.spki) !== home.hostKeyFingerprint ||
        !verify(
          null,
          workAuditSigningBytes(batch),
          createPublicKey({
            key: Buffer.from(receipt.data.publicKey.spki, "base64url"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(batch.signature, "base64url"),
        )
      )
        throw deny();
      const expected = assignment.auditSequence + 1;
      const last = batch.fromSequence + batch.records.length - 1;
      if (batch.fromSequence > expected) {
        await tx
          .updateTable("workAssignments")
          .where("id", "=", id)
          .set({
            auditGapExpected: assignment.auditGapExpected ?? expected,
            auditGapReceived: assignment.auditGapReceived ?? batch.fromSequence,
            auditGapThrough: Math.max(assignment.auditGapThrough ?? 0, last),
          })
          .executeTakeFirst();
        return { accepted: false, lastSequence: assignment.auditSequence };
      }
      const previous =
        batch.fromSequence === expected
          ? assignment.auditHeadHash
          : batch.fromSequence === 1
            ? workAuditGenesisHash
            : (
                await tx
                  .selectFrom("workAuditRecords")
                  .select("hash")
                  .where("assignmentId", "=", id)
                  .where("sequence", "=", batch.fromSequence - 1)
                  .executeTakeFirst()
              )?.hash;
      if (!previous) throw new ControlPlaneError("conflict", "Audit history does not match");
      let hash = previous;
      const now = this.#now();
      const rows = batch.records.map((record) => {
        const canonicalRecord = canonicalWorkAuditRecord(record);
        hash = createHash("sha256")
          .update(Buffer.from(hash, "hex"))
          .update(canonicalRecord, "utf8")
          .digest("hex");
        return {
          assignmentId: id,
          sequence: record.sequence,
          canonicalRecord,
          hash,
          receivedAt: now,
        };
      });
      if (hash !== batch.headHash)
        throw new ControlPlaneError("bad_request", "Audit hash chain does not match");
      if (batch.fromSequence < expected) {
        const existing = await tx
          .selectFrom("workAuditBatches")
          .selectAll()
          .where("assignmentId", "=", id)
          .where("fromSequence", "=", batch.fromSequence)
          .executeTakeFirst();
        if (
          !existing ||
          existing.lastSequence !== last ||
          existing.headHash !== hash ||
          existing.signature !== batch.signature
        ) {
          throw new ControlPlaneError("conflict", "Audit replay differs from the recorded batch");
        }
        return { accepted: true, lastSequence: assignment.auditSequence };
      }
      await tx.insertInto("workAuditRecords").values(rows).executeTakeFirst();
      await tx
        .insertInto("workAuditBatches")
        .values({
          assignmentId: id,
          fromSequence: batch.fromSequence,
          lastSequence: last,
          headHash: hash,
          signature: batch.signature,
        })
        .executeTakeFirst();
      await tx
        .updateTable("workAssignments")
        .where("id", "=", id)
        .set({
          auditSequence: last,
          auditHeadHash: hash,
          auditReceivedAt: now,
          ...((assignment.auditGapThrough ?? 0) <= last
            ? { auditGapReceived: null, auditGapExpected: null, auditGapThrough: null }
            : {}),
        })
        .executeTakeFirst();
      return { accepted: true, lastSequence: last };
    });
  }

  async auditExport(
    id: OrganizationId,
    account: ControlPlaneAccountId,
    assignmentId: WorkAssignmentId,
    after: number,
  ) {
    await this.#member(this.#db, id, account, true);
    const assignment = await this.#db
      .selectFrom("workAssignments")
      .selectAll()
      .where("id", "=", assignmentId)
      .where("organizationId", "=", id)
      .executeTakeFirst();
    if (!assignment) throw deny();
    const db = this.#db;
    const status = auditStatus(assignment);
    async function* lines() {
      let cursor = after;
      while (cursor < status.lastSequence) {
        const page = await db
          .selectFrom("workAuditRecords")
          .select(["sequence", "canonicalRecord"])
          .where("assignmentId", "=", assignmentId)
          .where("sequence", ">", cursor)
          .where("sequence", "<=", status.lastSequence)
          .orderBy("sequence")
          .limit(256)
          .execute();
        if (!page.length) throw new Error("Work audit history is incomplete");
        for (const row of page) yield row.canonicalRecord + "\n";
        cursor = page.at(-1)!.sequence;
      }
    }
    return { status, lines: lines() };
  }

  async mine(account: ControlPlaneAccountId) {
    const organizations = await this.#db
      .selectFrom("organizationMembers")
      .innerJoin("organizations", "organizations.id", "organizationMembers.organizationId")
      .where("organizationMembers.accountId", "=", account)
      .select(["organizations.id", "organizations.name", "organizationMembers.role"])
      .orderBy("organizations.name")
      .execute();
    const user = await this.#db
      .selectFrom("users")
      .where("id", "=", account)
      .select(["emailVerified", "email"])
      .executeTakeFirst();
    const invites = user?.emailVerified
      ? await this.#db
          .selectFrom("organizationInvitations")
          .innerJoin("organizations", "organizations.id", "organizationInvitations.organizationId")
          .where("organizationInvitations.email", "=", normalizeIdentityEmail(user.email))
          .where("organizationInvitations.acceptedAt", "is", null)
          .select([
            "organizationInvitations.id",
            "organizationInvitations.email",
            "organizationInvitations.role",
            "organizationInvitations.createdAt",
            "organizations.id as organizationId",
            "organizations.name as organizationName",
          ])
          .execute()
      : [];
    return {
      organizations,
      invitations: invites.map((row) => ({
        ...invitationView(row),
        organization: { id: row.organizationId, name: row.organizationName },
      })),
    };
  }

  async memberHome(id: OrganizationId, account: ControlPlaneAccountId) {
    await this.#member(this.#db, id, account, false);
    const org = await this.#db
      .selectFrom("organizations")
      .select("policy")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const assignment = await this.#db
      .selectFrom("workAssignments")
      .select("id")
      .where("organizationId", "=", id)
      .where("assigneeAccountId", "=", account)
      .where("state", "!=", "ended")
      .executeTakeFirst();
    if (!assignment) return null;
    const { view, deploymentId } = await this.#view(this.#db, id, assignment.id);
    const { assignee: _assignee, audit: _audit, ...visible } = view;
    return { assignment: { ...visible, deploymentId }, policy: WorkPolicySchema.parse(org.policy) };
  }

  async admin(id: OrganizationId, account: ControlPlaneAccountId) {
    return this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      const [members, invites, assignments] = await Promise.all([
        tx
          .selectFrom("organizationMembers")
          .innerJoin("users", "users.id", "organizationMembers.accountId")
          .where("organizationId", "=", id)
          .select([
            "organizationMembers.accountId",
            "organizationMembers.role",
            "users.displayName",
            "users.email",
          ])
          .orderBy("users.displayName")
          .execute(),
        tx
          .selectFrom("organizationInvitations")
          .selectAll()
          .where("organizationId", "=", id)
          .where("acceptedAt", "is", null)
          .orderBy("createdAt")
          .execute(),
        tx
          .selectFrom("workAssignments")
          .select("id")
          .where("organizationId", "=", id)
          .orderBy("createdAt", "desc")
          .execute(),
      ]);
      const change = org.pendingSeatRequestId
        ? await tx
            .selectFrom("organizationSeatChanges")
            .select(["requestId", "invoiceUrl", "expiresAt"])
            .where("organizationId", "=", id)
            .where("requestId", "=", org.pendingSeatRequestId)
            .executeTakeFirst()
        : undefined;
      const seats = organizationSeats(org, await this.#count(tx, id));
      const available = await freeBackupTargets(tx)
        .where("organizationReservationRequestId", "is", null)
        .where("reservedOrganizationId", "=", id)
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      return {
        id,
        name: org.name,
        billingStatus: org.billingStatus,
        closingAt: org.closingAt?.toISOString() ?? null,
        closedAt: org.closedAt?.toISOString() ?? null,
        pendingSeatChange: change
          ? {
              requestId: change.requestId,
              invoiceUrl: change.invoiceUrl,
              expiresAt: change.expiresAt?.toISOString() ?? null,
            }
          : null,
        seats: { ...seats, free: Math.min(seats.free, Number(available.count)) },
        members,
        invitations: invites.map(invitationView),
        assignments: await Promise.all(
          assignments.map(
            async ({ id: assignment }) => (await this.#view(tx, id, assignment)).view,
          ),
        ),
        policy: WorkPolicySchema.parse(org.policy),
        policyRevision: org.policyRevision,
      };
    });
  }

  async #view(
    db: DB,
    id: OrganizationId,
    assignmentId: WorkAssignmentId,
  ): Promise<{ view: WorkAssignmentView; deploymentId: DeploymentId | null }> {
    const row = await db
      .selectFrom("workAssignments")
      .selectAll()
      .where("organizationId", "=", id)
      .where("id", "=", assignmentId)
      .executeTakeFirst();
    if (!row) throw deny();
    const org = await db
      .selectFrom("organizations")
      .select(["name", "policyRevision"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const home = await db
      .selectFrom("cloudComputers")
      .select([
        "state",
        "phase",
        "hostname",
        "deploymentId",
        "hostKeyFingerprint",
        "bootstrapReceiptAt",
        "tombstonedAt",
        "deletionRequestedAt",
        "deletedAt",
        "vmDestroyedAt",
        "backupsUnreadableAt",
        "backupObjectsRemovedAt",
        "claimError",
        "lastError",
        "bootstrapExpiresAt",
      ])
      .where("id", "=", row.cloudComputerId)
      .executeTakeFirstOrThrow();
    const user = row.assigneeAccountId
      ? await db
          .selectFrom("users")
          .where("id", "=", row.assigneeAccountId)
          .select(["id as accountId", "displayName", "email"])
          .executeTakeFirst()
      : undefined;
    const deleted = home.tombstonedAt !== null;
    const suspended =
      Boolean(row.suspendedAt) || (home.state === "suspended" && home.phase === "suspended");
    const bootExpired = home.bootstrapExpiresAt && home.bootstrapExpiresAt <= this.#now();
    const attention =
      home.claimError ??
      (home.phase === "failed"
        ? (home.lastError ?? "The Cloud Computer failed to start.")
        : null) ??
      (bootExpired ? "The Cloud Computer’s boot credential expired." : null);
    const ready =
      row.state === "active" &&
      home.state === "active" &&
      home.phase === "ready" &&
      Boolean(home.bootstrapReceiptAt);
    const deletion = deletionView(home);
    const view: WorkAssignmentView = {
      ...(deletion ? { deletion } : {}),
      organizationId: id,
      organizationName: org.name,
      assignmentId,
      assignee: user ?? null,
      computerId: row.cloudComputerId,
      state: row.state,
      homeStatus: deleted
        ? "deleted"
        : suspended
          ? "suspended"
          : ready
            ? "ready"
            : attention
              ? "needs_attention"
              : "preparing",
      reason:
        deleted || ready
          ? null
          : suspended
            ? row.state === "offboarding"
              ? "Your organization ended this assignment."
              : "Your organization’s billing needs attention."
            : attention,
      address: ready ? `https://${home.hostname}` : null,
      policyRevision: org.policyRevision,
      appliedRevision: row.appliedRevision,
      policyStatus: row.appliedRevision === org.policyRevision ? "Applied" : "Pending on Home",
      signInCut: row.signInCutAt !== null,
      suspended,
      deleted,
      retainUntil: row.retainUntil?.toISOString() ?? null,
      audit: auditStatus(row),
    };
    return {
      view,
      deploymentId:
        home.deploymentId && home.hostKeyFingerprint
          ? DeploymentIdSchema.parse(home.deploymentId)
          : null,
    };
  }

  async #count(db: DB, id: OrganizationId) {
    const count = await db
      .selectFrom("workAssignments")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organizationId", "=", id)
      .where("state", "!=", "ended")
      .executeTakeFirstOrThrow();
    return Number(count.count);
  }

  async #member(db: DB, id: OrganizationId, account: ControlPlaneAccountId, admin: boolean) {
    const member = await db
      .selectFrom("organizationMembers")
      .select("role")
      .where("organizationId", "=", id)
      .where("accountId", "=", account)
      .executeTakeFirst();
    if (!member || (admin && member.role !== "admin")) throw deny();
  }

  async #admin(tx: Tx, id: OrganizationId, account: ControlPlaneAccountId) {
    await this.#member(tx, id, account, true);
    const org = await lockOrg(tx, id);
    await this.#member(tx, id, account, true);
    return org;
  }

  async #host(db: DB, id: WorkAssignmentId, deploymentId: DeploymentId, lock = false) {
    let request = db.selectFrom("workAssignments").selectAll().where("id", "=", id);
    if (lock) request = request.forNoKeyUpdate();
    const assignment = await request.executeTakeFirst();
    if (!assignment || assignment.state === "ended") throw deny();
    const home = await db
      .selectFrom("cloudComputers")
      .select(["deploymentId", "bootstrapReceiptAt", "bootstrapReceipt", "hostKeyFingerprint"])
      .where("id", "=", assignment.cloudComputerId)
      .where("workAssignmentId", "=", id)
      .executeTakeFirst();
    if (!home?.bootstrapReceiptAt || home.deploymentId !== deploymentId) throw deny();
    const org = await db
      .selectFrom("organizations")
      .selectAll()
      .where("id", "=", assignment.organizationId)
      .executeTakeFirstOrThrow();
    return { assignment, home, org };
  }
}

async function lockOrg(tx: Tx, id: OrganizationId) {
  const org = await tx
    .selectFrom("organizations")
    .selectAll()
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!org) throw deny();
  return org;
}
async function lockAssignment(tx: Tx, id: OrganizationId, assignment: WorkAssignmentId) {
  const row = await tx
    .selectFrom("workAssignments")
    .selectAll()
    .where("organizationId", "=", id)
    .where("id", "=", assignment)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row) throw deny();
  return row;
}

function seatItem(subscription: StripeSubscription, priceId: string, currency: string) {
  const item = subscription.items.data[0];
  return !subscription.items.has_more &&
    subscription.items.data.length === 1 &&
    item?.price.id === priceId &&
    item.price.currency === currency &&
    OrganizationSeatQuantitySchema.safeParse(item.quantity).success
    ? item
    : undefined;
}
function invitationView(row: {
  id: OrganizationInvitationId;
  email: string;
  role: OrganizationRole;
  createdAt: Date;
}) {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt.toISOString() };
}
function auditStatus(row: Assignment) {
  return {
    lastSequence: row.auditSequence,
    lastReceivedAt: row.auditReceivedAt?.toISOString() ?? null,
    finalFlush: row.finalAudit,
    gap:
      row.auditGapReceived === null || row.auditGapExpected === null || row.auditGapThrough === null
        ? null
        : {
            expected: row.auditGapExpected,
            received: row.auditGapReceived,
            through: row.auditGapThrough,
          },
  };
}

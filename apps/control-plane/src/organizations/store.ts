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
import type { Kysely, Selectable, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  billingStatus,
  type CloudComputerStripe,
  type StripeEvent,
  type StripeSubscription,
} from "../cloud-computers/stripe.js";
import type { CloudComputerStore } from "../cloud-computers/store.js";
import type { OrganizationOffer } from "./config.js";
import type { OrganizationTable, WorkAssignmentTable } from "./tables.js";

type DB = Kysely<ControlPlaneDatabaseSchema>;
type Tx = Transaction<ControlPlaneDatabaseSchema>;
type Organization = Selectable<OrganizationTable>;
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
>;
type CreateComputer = CloudComputerStore["createWorkComputer"];
const flushWindowMs = 3_000;
const checkoutLifetimeMs = 24 * 60 * 60_000;

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
    return this.#returnUrl
      ? this.#stripe.portal(org.stripeCustomerId, this.#returnUrl)
      : this.#stripe.portal(org.stripeCustomerId);
  }

  async checkOffer() {
    if (!this.#offer) return;
    this.#offerValid = false;
    await this.#stripe.validateOffer(this.#offer.priceId, this.#offer);
    this.#offerValid = true;
  }

  async checkout(
    account: ControlPlaneAccountId,
    input: { requestId: string; name: string; seats: number },
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
      if (!founder || (founder.deletionFencedUntil && founder.deletionFencedUntil > this.#now()))
        throw deny();
      const existing = await tx
        .selectFrom("organizationCheckouts")
        .selectAll()
        .where("founderAccountId", "=", account)
        .where("requestId", "=", input.requestId)
        .executeTakeFirst();
      if (existing) {
        if (existing.name !== input.name || existing.seats !== input.seats) {
          throw new ControlPlaneError(
            "conflict",
            "This checkout request already has a different name or seat count",
          );
        }
        return existing;
      }
      return tx
        .insertInto("organizationCheckouts")
        .values({
          organizationId: OrganizationIdSchema.parse(`org_${randomUUID()}`),
          founderAccountId: account,
          requestId: input.requestId,
          name: input.name,
          seats: input.seats,
          stripePriceId: offer.priceId,
          currency: offer.currency,
          status: "open",
          sessionId: null,
          url: null,
          createdAt: this.#now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (
      attempt.status === "expired" ||
      (!attempt.url && this.#now().getTime() - attempt.createdAt.getTime() >= checkoutLifetimeMs)
    ) {
      throw new ControlPlaneError("conflict", "This organization checkout expired");
    }
    if (attempt.url) return { url: attempt.url };
    const session = await this.#stripe.checkout({
      accountId: account,
      requestId: attempt.requestId,
      priceId: attempt.stripePriceId,
      organization: { id: attempt.organizationId, quantity: attempt.seats },
      ...(this.#returnUrl ? { returnUrl: this.#returnUrl } : {}),
    });
    const saved = await this.#db
      .updateTable("organizationCheckouts")
      .where("organizationId", "=", attempt.organizationId)
      .where("status", "!=", "expired")
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
    const attempt = await tx
      .selectFrom("organizationCheckouts")
      .selectAll()
      .where("organizationId", "=", id)
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
    if (attempt.status === "completed") return true;
    const save = tx.updateTable("organizationCheckouts").where("organizationId", "=", id);
    if (event.operation === "expired") {
      await save.set({ status: "expired", sessionId: checkout.id }).executeTakeFirst();
      return true;
    }
    if (admin?.deletionFencedUntil && admin.deletionFencedUntil > this.#now()) {
      throw new ControlPlaneError(
        "unavailable",
        "Organization creation is waiting for Account deletion",
      );
    }
    const payment = event.checkout;
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
    if (!admin || !attempt.founderAccountId) {
      if (billingStatus(subscription) !== "canceled") await this.#stripe.cancel(subscription.id);
      await save.set({ status: "expired", sessionId: checkout.id }).executeTakeFirst();
      return true;
    }
    const billing = billingStatus(subscription);
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
        paidSeats: billing === "active" ? item.quantity : 0,
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
    await save.set({ status: "completed", sessionId: checkout.id }).executeTakeFirst();
    return true;
  }

  async #syncSubscription(tx: Tx, org: Organization, sendUpdate: boolean) {
    let subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
    const verifiedItem = (value: StripeSubscription) => {
      if (value.id !== org.stripeSubscriptionId || value.customer !== org.stripeCustomerId) {
        throw new ControlPlaneError(
          "unavailable",
          "Stripe returned another organization subscription",
        );
      }
      return seatItem(value, org.stripePriceId, org.billingCurrency);
    };
    let item = verifiedItem(subscription);
    if (
      sendUpdate &&
      item?.id &&
      org.pendingSeatRequestId &&
      org.pendingSeats &&
      org.pendingSeatSince &&
      this.#now().getTime() - org.pendingSeatSince.getTime() < checkoutLifetimeMs &&
      item.quantity !== org.pendingSeats &&
      !subscription.pending_update &&
      billingStatus(subscription) === "active"
    ) {
      await this.#stripe.updateSeatQuantity({
        item: item.id,
        organization: org.id,
        requestId: org.pendingSeatRequestId,
        quantity: org.pendingSeats,
        increase: org.pendingSeats > item.quantity,
      });
      subscription = await this.#stripe.subscription(org.stripeSubscriptionId);
      item = verifiedItem(subscription);
    }
    const stripeStatus = billingStatus(subscription);
    const count = await this.#count(tx, org.id);
    // An unpaid pending increase does not take away already paid seats on an otherwise active subscription.
    const pendingIncrease =
      subscription.status === "active" &&
      !subscription.pause_collection &&
      Boolean(
        subscription.pending_update && org.pendingSeats && org.pendingSeats > org.paidSeats,
      ) &&
      org.billingStatus === "active" &&
      item?.quantity === org.paidSeats;
    const effective =
      !item || item.quantity < count ? "inactive" : pendingIncrease ? "active" : stripeStatus;
    const seats = effective === "active" && item ? item.quantity : 0;
    const settled =
      (effective === "active" && item?.quantity === org.pendingSeats) ||
      stripeStatus === "canceled" ||
      (org.pendingSeatSince !== null &&
        this.#now().getTime() - org.pendingSeatSince.getTime() >= checkoutLifetimeMs &&
        !subscription.pending_update);
    await tx
      .updateTable("organizations")
      .where("id", "=", org.id)
      .set({
        billingStatus: effective,
        paidSeats: seats,
        ...(settled
          ? { pendingSeats: null, pendingSeatRequestId: null, pendingSeatSince: null }
          : {}),
      })
      .executeTakeFirst();
    const work = tx
      .selectFrom("workAssignments")
      .select("cloudComputerId")
      .where("organizationId", "=", org.id)
      .where("state", "=", "active");
    const state = effective === "active" ? "active" : "suspended";
    await tx
      .updateTable("cloudComputers")
      .where("id", "in", work)
      .where("state", "!=", state)
      .where("state", "!=", "deleted")
      .set({
        state,
        phase: "provisioning",
        billingStatus: effective,
        lastError: null,
        readinessStartedAt: this.#now(),
        updatedAt: this.#now(),
      })
      .executeTakeFirst();
    await tx
      .updateTable("cloudComputers")
      .where("id", "in", work)
      .where("billingStatus", "!=", effective)
      .set({ billingStatus: effective, updatedAt: this.#now() })
      .executeTakeFirst();
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
    for (const { id } of orgs) {
      await attempt(() =>
        this.#db.transaction().execute(async (tx) => this.#advance(tx, await lockOrg(tx, id))),
      );
    }
    await attempt(() => this.checkOffer());
    const pending = await this.#db
      .selectFrom("organizationCheckouts")
      .selectAll()
      .where("status", "=", "open")
      .execute();
    for (const row of pending)
      await attempt(async () => {
        if (
          !row.founderAccountId &&
          !row.sessionId &&
          this.#now().getTime() - row.createdAt.getTime() < checkoutLifetimeMs
        )
          return;
        const session = await this.#stripe.findCheckout({
          accountId: row.founderAccountId,
          requestId: row.requestId,
          createdAt: row.createdAt,
          sessionId: row.sessionId,
          organizationId: row.organizationId,
        });
        if (session?.payment) {
          const checkout = session.payment;
          await this.#db.transaction().execute((tx) =>
            this.applyEvent(tx, {
              id: `reconcile_${session.id}`,
              type: "checkout.session.completed",
              operation: "completed",
              checkout,
            }),
          );
        } else if (
          session?.status === "expired" ||
          (!session && this.#now().getTime() - row.createdAt.getTime() >= checkoutLifetimeMs)
        ) {
          await this.#db
            .updateTable("organizationCheckouts")
            .where("organizationId", "=", row.organizationId)
            .where("status", "=", "open")
            .set({ status: "expired" })
            .executeTakeFirst();
        }
      });
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
    await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      if (input.seats < (await this.#count(tx, id)))
        throw new ControlPlaneError("conflict", "Offboard assignments before reducing seats");
      if (
        org.pendingSeats !== null &&
        (org.pendingSeatRequestId !== input.requestId || org.pendingSeats !== input.seats)
      ) {
        throw new ControlPlaneError("conflict", "A seat change is already pending");
      }
      if (org.pendingSeats !== null || org.paidSeats === input.seats) return;
      if (org.billingStatus !== "active")
        throw new ControlPlaneError("conflict", "Organization billing needs attention");
      await tx
        .updateTable("organizations")
        .where("id", "=", id)
        .set({
          pendingSeats: input.seats,
          pendingSeatRequestId: input.requestId,
          pendingSeatSince: this.#now(),
        })
        .executeTakeFirst();
    });
    await this.#db
      .transaction()
      .execute(async (tx) => this.#syncSubscription(tx, await this.#admin(tx, id, account), true));
    return this.admin(id, account);
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
          retainUntil: new Date(now.getTime() + retentionSeconds * 1000),
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
  ) {
    await this.#db.transaction().execute(async (tx) => {
      const org = await this.#admin(tx, id, account);
      await tx
        .updateTable("workAssignments")
        .where("organizationId", "=", id)
        .where("id", "=", assignmentId)
        .where("state", "=", "offboarding")
        .set({ flushUntil: null })
        .executeTakeFirst();
      await this.#advance(tx, org, assignmentId);
    });
    return (await this.#view(this.#db, id, assignmentId)).view;
  }

  async #advance(tx: Tx, org: Organization, only?: WorkAssignmentId) {
    let rows = tx
      .selectFrom("workAssignments")
      .selectAll()
      .where("organizationId", "=", org.id)
      .where("state", "!=", "ended")
      .where((eb) => eb.or([eb("state", "=", "offboarding"), eb("assigneeAccountId", "is", null)]));
    if (only) rows = rows.where("id", "=", only);
    for (const assignment of await rows.orderBy("id").forNoKeyUpdate().execute()) {
      const home = await tx
        .selectFrom("cloudComputers")
        .select(["state", "phase", "tombstonedAt"])
        .where("id", "=", assignment.cloudComputerId)
        .executeTakeFirstOrThrow();
      const now = this.#now();
      if (assignment.state === "active" && !assignment.assigneeAccountId) {
        await tx
          .updateTable("workAssignments")
          .where("id", "=", assignment.id)
          .set({
            state: "offboarding",
            signInCutAt: now,
            retainUntil: now,
          })
          .executeTakeFirst();
      }
      if (home.state === "suspended" && home.phase === "suspended" && !assignment.suspendedAt) {
        await tx
          .updateTable("workAssignments")
          .where("id", "=", assignment.id)
          .set({ suspendedAt: now })
          .executeTakeFirst();
      }
      if (home.tombstonedAt) {
        await tx
          .updateTable("workAssignments")
          .where("id", "=", assignment.id)
          .set({ state: "ended", endedAt: home.tombstonedAt })
          .executeTakeFirst();
      } else if (!assignment.flushUntil || assignment.flushUntil <= now) {
        if (home.state === "active") {
          await tx
            .updateTable("cloudComputers")
            .where("id", "=", assignment.cloudComputerId)
            .where("state", "=", "active")
            .set({ state: "suspended", phase: "provisioning", updatedAt: now })
            .executeTakeFirst();
        } else if (
          home.state === "suspended" &&
          home.phase === "suspended" &&
          (!assignment.retainUntil || assignment.retainUntil <= now)
        ) {
          await tx
            .updateTable("cloudComputers")
            .where("id", "=", assignment.cloudComputerId)
            .where("state", "=", "suspended")
            .set({
              state: "deleted",
              phase: "deleting",
              deletedAt: now,
              updatedAt: now,
              bootstrapDigest: null,
              sealedBootstrapToken: null,
              bootstrapExpiresAt: null,
              setupCodeDigest: null,
              sealedSetupCode: null,
              sealedBackupPassword: null,
              sealedOidcClientSecret: null,
              sealedHostCredential: null,
            })
            .executeTakeFirst();
        }
      }
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

  async requireSignIn(clientId: string, sessionAccount: () => Promise<string | undefined>) {
    const assignment = await workSignInAuthority(this.#db, clientId);
    if (!assignment) return;
    const account = await sessionAccount();
    if (
      assignment.state !== "active" ||
      !assignment.assigneeAccountId ||
      (account && account !== assignment.assigneeAccountId)
    ) {
      throw new ControlPlaneError("forbidden", "Sign-in to this work Home is not allowed");
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
          .set({ auditGapReceived: Math.max(assignment.auditGapReceived ?? 0, last) })
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
          auditGapReceived:
            assignment.auditGapReceived && assignment.auditGapReceived > last
              ? assignment.auditGapReceived
              : null,
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
      return {
        id,
        name: org.name,
        billingStatus: org.billingStatus,
        seats: organizationSeats(org, await this.#count(tx, id)),
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
    const view: WorkAssignmentView = {
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
    gap:
      row.auditGapReceived === null
        ? null
        : { expected: row.auditSequence + 1, received: row.auditGapReceived },
  };
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  hostOidcCallbackPath,
  type ManagedHomeClaimReceipt,
  CloudComputerBootReleaseSchema,
  CloudComputerBootResponseSchema,
  CloudComputerDesiredSchema,
  CloudComputerEgressSchema,
  CloudComputerEgressAddressSchema,
  type CloudComputerPreparationStep,
  CloudComputerIdSchema,
  CloudComputerSnapshotSchema,
  ControlPlaneAccountIdSchema,
  type CloudComputerBootCompleteRequest,
  type CloudComputerCheck,
  type CloudComputerBootRequest,
  type CloudComputerBootResponse,
  type CloudComputerDesired,
  type CloudComputerId,
  type CloudComputerReport,
  type CloudComputerView,
  type WorkAssignmentId,
  type WorkHomeMarker,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import { z } from "zod";
import { DeploymentIdSchema, HostKeyFingerprintSchema } from "@opensteer/core";
import type { HostDiscoveryEnvelope } from "@opensteer/deployment-authority";
import { sql, type Kysely, type Selectable, type Transaction, type Updateable } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import type { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { ControlPlaneError } from "../server/errors.js";
import {
  createHostCredential,
  createOAuthClientSecret,
  hashCredential,
} from "../auth/credentials.js";
import { cloudComputerRegion, type CloudComputerConfig } from "./config.js";
import {
  billingStatus,
  matchesPrice,
  StripePaidCheckoutSchema,
  subscriptionRenewal,
  type StripeBilling,
  type StripeEvent,
} from "./stripe.js";
import type { BillingStatus, CloudComputerTable } from "./tables.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;
type Computer = Selectable<CloudComputerTable>;
interface OrganizationBilling {
  applyEvent(tx: TransactionDb, event: StripeEvent): Promise<boolean>;
  reconcile(onError: () => void): Promise<void>;
}

type Mutation =
  | "suspend"
  | "resume"
  | "delete"
  | "operator-suspend"
  | "operator-unsuspend"
  | "reissue"
  | "replace";
const bootstrapLifetimeMs = 20 * 60_000;
const checkoutLifetimeMs = 24 * 60 * 60_000;
const unknownCheckoutGraceMs = 60_000;
const emptyDigest = "0".repeat(64);
const claimLeaseMs = 2 * 60_000;

/** One ready Home the Account is about to claim, as it was when the attempt began. */
export interface CloudComputerClaimJob {
  readonly id: CloudComputerId;
  readonly generation: number;
  readonly accountId: ControlPlaneAccountId;
  readonly hostname: string;
  readonly deploymentId: string;
  readonly hostKeyFingerprint: string;
  readonly attempt: number;
  readonly readinessStartedAt: Date;
}

/** Raised when the row moved on (deleted, reissued, claimed) while an attempt ran. */
export class CloudComputerClaimSupersededError extends Error {}

interface StoreOptions {
  readonly config: CloudComputerConfig;
  readonly accountOrigin: URL;
  readonly cipher: HostedTeamSetupTokenCipher;
  readonly stripe: StripeBilling;
  readonly now?: () => Date;
  readonly organizations?: OrganizationBilling;
  /** Where Stripe's checkout and billing pages send the person back. */
  readonly returnUrl?: URL;
}

export class CloudComputerStore {
  readonly #db: Database;
  readonly #options: StoreOptions;
  readonly #now: () => Date;
  #offerValid = false;

  constructor(database: Database, options: StoreOptions) {
    this.#db = database;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get plan() {
    return { ...this.#options.config.plan, interval: this.#options.config.interval };
  }

  async checkOffer(): Promise<void> {
    try {
      await this.#options.stripe.validateOffer(this.#options.config.stripePriceId, this.plan);
      this.#offerValid = true;
    } catch (error) {
      this.#offerValid = false;
      throw error;
    }
  }

  async checkout(accountId: ControlPlaneAccountId, requestId: string) {
    if (!this.#offerValid)
      throw new ControlPlaneError(
        "unavailable",
        "Cloud Computer checkout is not available right now",
        { reason: "cloud-computer-sales-not-open" },
      );
    const previous = await this.#db
      .selectFrom("cloudComputerCheckouts")
      .selectAll()
      .where("accountId", "=", accountId)
      .where("status", "=", "open")
      .executeTakeFirst();
    if (previous && (previous.requestId !== requestId || previous.lastStripeAttemptAt)) {
      await this.#recoverCheckout(accountId, previous.requestId, previous.requestId !== requestId);
    }
    const outcome = await this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
      if (!(await lockOwner(tx, accountId, now))) throw missing();
      const attempts = tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId);
      const replay = await attempts.where("requestId", "=", requestId).executeTakeFirst();
      if (replay?.status === "expired")
        throw new ControlPlaneError("conflict", "This checkout expired", {
          reason: "cloud-computer-checkout-expired",
        });
      if (replay?.url) return { url: replay.url };
      if (replay?.status === "completed")
        throw new ControlPlaneError("conflict", "This checkout is complete", {
          reason: "cloud-computer-checkout-complete",
        });
      const existing = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("tombstonedAt", "is", null)
        .executeTakeFirst();
      if (existing && (existing.billingStatus !== "canceled" || existing.deletionRequestedAt))
        throw new ControlPlaneError(
          "conflict",
          "This Account already has a Cloud Computer subscription",
          { reason: "cloud-computer-already-exists" },
        );
      if (!replay) {
        const open = await attempts.where("status", "=", "open").executeTakeFirst();
        if (open)
          throw new ControlPlaneError(
            "conflict",
            "This Account already has a checkout in progress",
            { reason: "cloud-computer-checkout-in-progress" },
          );
        if (!existing) {
          const target = await tx
            .selectFrom("cloudComputerBackupTargets")
            .select("id")
            .where("computerId", "is", null)
            .where("checkoutKey", "is", null)
            .where("needsRotation", "=", false)
            .orderBy("id")
            .forUpdate()
            .skipLocked()
            .executeTakeFirst();
          if (!target)
            throw new ControlPlaneError(
              "unavailable",
              "Cloud Computer checkout is not available right now",
              { reason: "cloud-computer-no-capacity" },
            );
          await tx
            .updateTable("cloudComputerBackupTargets")
            .set({ checkoutKey: checkoutKey(accountId, requestId) })
            .where("id", "=", target.id)
            .executeTakeFirst();
        }
        await tx
          .insertInto("cloudComputerCheckouts")
          .values({
            accountId,
            requestId,
            stripePriceId: this.#options.config.stripePriceId,
            currency: this.plan.currency,
            status: "open",
            stripeSessionId: null,
            url: null,
            createdAt: now,
            lastStripeAttemptAt: now,
            targetComputerId: existing?.id ?? null,
            expiresAt: new Date(now.getTime() + checkoutLifetimeMs),
          })
          .executeTakeFirst();
      } else {
        if (replay.expiresAt <= now)
          throw new ControlPlaneError("conflict", "This checkout expired", {
            reason: "cloud-computer-checkout-expired",
          });
        await tx
          .updateTable("cloudComputerCheckouts")
          .where("accountId", "=", accountId)
          .where("requestId", "=", requestId)
          .set({ lastStripeAttemptAt: now })
          .executeTakeFirst();
      }
      return { priceId: replay?.stripePriceId ?? this.#options.config.stripePriceId };
    });
    if ("url" in outcome) return { url: outcome.url! };

    // The reservation commits before Stripe, so a lost response is discoverable even after a crash.
    const session = await this.#options.stripe.checkout({
      accountId,
      requestId,
      priceId: outcome.priceId,
      ...(this.#options.returnUrl ? { returnUrl: this.#options.returnUrl } : {}),
    });
    const result = await this.#db
      .updateTable("cloudComputerCheckouts")
      .where("accountId", "=", accountId)
      .where("requestId", "=", requestId)
      .where("status", "!=", "expired")
      .where((eb) =>
        eb.or([eb("stripeSessionId", "is", null), eb("stripeSessionId", "=", session.id)]),
      )
      .set({ stripeSessionId: session.id, url: session.url })
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new ControlPlaneError("conflict", "Checkout is no longer available", {
        reason: "cloud-computer-checkout-unavailable",
      });
    return { url: session.url };
  }

  async #recoverCheckout(
    accountId: ControlPlaneAccountId,
    requestId: string,
    releaseUnknown: boolean,
  ) {
    const recovered = await this.#db.transaction().execute(async (tx) => {
      if (!(await lockOwner(tx, accountId, this.#now()))) return;
      const row = await tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId)
        .where("status", "=", "open")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) return;
      const session = await this.#options.stripe.findCheckout({
        accountId,
        requestId,
        sessionId: row.stripeSessionId,
        createdAt: row.createdAt,
      });
      if (session?.payment) return session.payment;
      const write = tx
        .updateTable("cloudComputerCheckouts")
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId);
      if (
        session?.status === "expired" ||
        (!session &&
          releaseUnknown &&
          this.#now().getTime() - (row.lastStripeAttemptAt ?? row.createdAt).getTime() >=
            unknownCheckoutGraceMs)
      ) {
        await write.set({ status: "expired" }).executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
      } else if (session) {
        await write.set({ stripeSessionId: session.id, url: session.url }).executeTakeFirst();
      }
      return undefined;
    });
    if (recovered) {
      await this.applyStripeEvent({
        id: `reconcile_${recovered.id}`,
        type: "checkout.session.completed",
        operation: "completed",
        checkout: recovered,
      });
    }
  }

  async billingPortal(accountId: ControlPlaneAccountId) {
    const billing = await this.#db
      .selectFrom("cloudComputers")
      .select("stripeCustomerId")
      .where("accountId", "=", accountId)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    if (!billing) throw missing();
    const { returnUrl, stripe } = this.#options;
    return returnUrl
      ? stripe.portal(billing.stripeCustomerId, returnUrl)
      : stripe.portal(billing.stripeCustomerId);
  }

  async applyStripeEvent(event: StripeEvent): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      const recorded = await tx
        .insertInto("cloudComputerStripeEvents")
        .values({ id: event.id, type: event.type, receivedAt: this.#now() })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!recorded) {
        const deferred = await tx
          .selectFrom("cloudComputerStripeEvents")
          .select("deferredCheckout")
          .where("id", "=", event.id)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!deferred?.deferredCheckout || event.operation !== "completed") return;
        await tx
          .updateTable("cloudComputerStripeEvents")
          .where("id", "=", event.id)
          .set({ deferredCheckout: null })
          .executeTakeFirst();
      }
      if (event.operation === "ignore") return;
      if (await this.#options.organizations?.applyEvent(tx, event)) return;
      if (
        (event.operation === "completed" || event.operation === "expired") &&
        event.checkout.metadata.organization_id
      )
        throw new ControlPlaneError("unavailable", "Organization billing is unavailable");
      if (event.operation === "billing") {
        await this.#refreshSubscription(tx, event.subscriptionId);
        return;
      }

      const { checkout } = event;
      const { account_id: accountId, request_id: requestId } = checkout.metadata;
      const paid = event.operation === "completed" ? event.checkout : undefined;
      const defer = () =>
        tx
          .updateTable("cloudComputerStripeEvents")
          .where("id", "=", event.id)
          .set({ deferredCheckout: paid ? JSON.stringify(paid) : null })
          .executeTakeFirst();
      if (accountId !== checkout.client_reference_id) {
        if (paid) await defer();
        return;
      }
      if (!(await lockOwner(tx, accountId, this.#now()))) {
        if (paid) await defer();
        else {
          const owner = await tx
            .selectFrom("users")
            .select("id")
            .where("id", "=", accountId)
            .executeTakeFirst();
          if (!owner) await releaseCheckoutTarget(tx, accountId, requestId);
        }
        return;
      }
      const attempt = await tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !attempt ||
        (attempt.stripeSessionId !== null && attempt.stripeSessionId !== checkout.id) ||
        (attempt.status !== "open" && attempt.status !== "expired")
      ) {
        if (paid && attempt?.stripeSessionId !== checkout.id) await defer();
        return;
      }
      const writeAttempt = tx
        .updateTable("cloudComputerCheckouts")
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId);
      if (event.operation === "expired") {
        await writeAttempt
          .set({ status: "expired", stripeSessionId: checkout.id })
          .executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
        return;
      }
      const payment = event.checkout;
      const subscription = await this.#options.stripe.subscription(payment.subscription);
      if (
        subscription.id !== payment.subscription ||
        subscription.customer !== payment.customer ||
        subscription.metadata["account_id"] !== accountId ||
        subscription.metadata["request_id"] !== requestId ||
        !matchesPrice(subscription, attempt.stripePriceId, attempt.currency) ||
        payment.currency !== attempt.currency
      ) {
        throw new ControlPlaneError(
          "unavailable",
          "Stripe checkout does not match the Cloud Computer price",
        );
      }

      const existing = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("tombstonedAt", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        attempt.targetComputerId &&
        (existing?.id !== attempt.targetComputerId ||
          existing.deletionRequestedAt ||
          existing.state === "deleted")
      ) {
        if (billingStatus(subscription) !== "canceled")
          await this.#options.stripe.cancel(payment.subscription);
        await writeAttempt
          .set({ status: "completed", stripeSessionId: checkout.id, url: null })
          .executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
        return;
      }
      if (existing) {
        if (existing.stripeSubscriptionId === payment.subscription) return;
        if (existing.billingStatus !== "canceled" || existing.deletionRequestedAt) {
          await defer();
          return;
        }
        const billing = billingStatus(subscription);
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", existing.id)
          .set({
            stripeCheckoutId: checkout.id,
            stripeCustomerId: payment.customer,
            stripeSubscriptionId: payment.subscription,
            stripePriceId: attempt.stripePriceId,
            billingCurrency: attempt.currency,
            billingStatus: billing,
            renewsAt: subscriptionRenewal(subscription, billing),
            ...transition(existing, desiredState(existing, billing), this.#now()),
            updatedAt: this.#now(),
          })
          .executeTakeFirst();
        await writeAttempt
          .set({ status: "completed", stripeSessionId: checkout.id })
          .executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
        return;
      }
      const id = CloudComputerIdSchema.parse(`cc_${randomUUID()}`);
      const billing = billingStatus(subscription);
      const reserved = await tx
        .selectFrom("cloudComputerBackupTargets")
        .select("id")
        .where("checkoutKey", "=", checkoutKey(accountId, requestId))
        .executeTakeFirst();
      // An ambiguously created session can complete after its original reservation was released.
      const target =
        reserved ??
        (await tx
          .selectFrom("cloudComputerBackupTargets")
          .select("id")
          .where("computerId", "is", null)
          .where("checkoutKey", "is", null)
          .where("needsRotation", "=", false)
          .orderBy("id")
          .executeTakeFirst());
      if (!target) {
        await defer();
        return;
      }
      await this.#createComputer(tx, {
        id,
        accountId,
        billing,
        renewsAt: subscriptionRenewal(subscription, billing),
        stripeCheckoutId: checkout.id,
        stripeCustomerId: payment.customer,
        stripeSubscriptionId: payment.subscription,
        stripePriceId: attempt.stripePriceId,
        billingCurrency: attempt.currency,
      });
      const assigned = await tx
        .updateTable("cloudComputerBackupTargets")
        .where("id", "=", target.id)
        .where("computerId", "is", null)
        .where("needsRotation", "=", false)
        .where((eb) =>
          eb.or([
            eb("checkoutKey", "is", null),
            eb("checkoutKey", "=", checkoutKey(accountId, requestId)),
          ]),
        )
        .set({ computerId: id, checkoutKey: null })
        .executeTakeFirst();
      if (assigned.numUpdatedRows !== 1n)
        throw new ControlPlaneError("unavailable", "The backup target was reserved concurrently");
      await writeAttempt
        .set({ status: "completed", stripeSessionId: checkout.id })
        .executeTakeFirst();
    });
  }

  async createWorkComputer(tx: TransactionDb, id: CloudComputerId, assignmentId: WorkAssignmentId) {
    // Legacy personal billing columns stay populated for additive rollout. Work billing never reads them.
    const reference = `work:${assignmentId}`;
    await this.#createComputer(tx, {
      id,
      accountId: null,
      workAssignmentId: assignmentId,
      billing: "active",
      stripeCheckoutId: reference,
      stripeSubscriptionId: reference,
      stripeCustomerId: reference,
      stripePriceId: reference,
      billingCurrency: "",
    });
    const free = await tx
      .selectFrom("cloudComputerBackupTargets")
      .select("id")
      .where("computerId", "is", null)
      .where("checkoutKey", "is", null)
      .where("needsRotation", "=", false)
      .orderBy("id")
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!free)
      throw new ControlPlaneError("unavailable", "A Cloud Computer is not available right now");
    await tx
      .updateTable("cloudComputerBackupTargets")
      .where("id", "=", free.id)
      .set({ computerId: id })
      .executeTakeFirst();
  }

  async #createComputer(
    tx: TransactionDb,
    paid: {
      id: CloudComputerId;
      accountId: ControlPlaneAccountId | null;
      workAssignmentId?: WorkAssignmentId;
      billing: BillingStatus;
      renewsAt?: Date | null;
      stripeCheckoutId: string;
      stripeSubscriptionId: string;
      stripeCustomerId: string;
      stripePriceId: string;
      billingCurrency: string;
    },
  ) {
    const now = this.#now();
    const { config, cipher } = this.#options;
    const setupCode = newSecret();
    await tx
      .insertInto("cloudComputers")
      .values({
        id: paid.id,
        accountId: paid.accountId,
        stripeCheckoutId: paid.stripeCheckoutId,
        stripeCustomerId: paid.stripeCustomerId,
        stripeSubscriptionId: paid.stripeSubscriptionId,
        stripePriceId: paid.stripePriceId,
        billingCurrency: paid.billingCurrency,
        workAssignmentId: paid.workAssignmentId ?? null,
        generation: 1,
        state: paid.billing === "active" ? "active" : "suspended",
        hostname: `${paid.id.replace("_", "-")}.${config.domain}`,
        region: config.region,
        serverType: config.serverType,
        release: JSON.stringify(config.release),
        setupCodeDigest: digestSecret(setupCode),
        sealedSetupCode: cipher.seal(paid.id, 1, setupCode),
        sealedBackupPassword: cipher.seal(`backup:${paid.id}`, 1, newSecret()),
        bootstrapDigest: null,
        sealedBootstrapToken: null,
        bootstrapExpiresAt: null,
        bootstrapReceipt: null,
        bootstrapReceiptAt: null,
        bootCompletedAt: null,
        completedBootDigest: null,
        previousProviderServerId: null,
        restoreSnapshot: null,
        deletionRequestedAt: null,
        ipv6Enabled: config.ipv6Enabled,
        readinessStartedAt: now,
        phase: "provisioning",
        providerServerId: null,
        ipv4: null,
        ipv6: null,
        deploymentId: null,
        hostKeyFingerprint: null,
        lastError: null,
        operatorSuspension: null,
        billingStatus: paid.billing,
        renewsAt: paid.renewsAt ?? null,
        createdAt: now,
        updatedAt: now,
        reportedAt: null,
        deletedAt: null,
        tombstonedAt: null,
      })
      .executeTakeFirst();
  }

  async #refreshSubscription(tx: TransactionDb, id: string) {
    const row = await tx
      .selectFrom("cloudComputers")
      .selectAll()
      .where("stripeSubscriptionId", "=", id)
      .where("workAssignmentId", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row || row.tombstonedAt) return;
    const subscription = await this.#options.stripe.subscription(id);
    if (subscription.id !== id || subscription.customer !== row.stripeCustomerId) {
      throw new ControlPlaneError("unavailable", "Stripe returned a different subscription");
    }
    const billing = billingStatus(subscription);
    if (row.deletionRequestedAt) {
      if (billing !== "canceled") await this.#options.stripe.cancel(id);
      const now = this.#now();
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", row.id)
        .set({
          ...transition(row, "deleted", now),
          ...clearBootToken,
          billingStatus: "canceled",
          renewsAt: null,
          deletedAt: now,
          sealedSetupCode: null,
          setupCodeDigest: null,
          sealedBackupPassword: null,
          updatedAt: now,
        })
        .executeTakeFirst();
      return;
    }
    const status =
      billing === "active" && !matchesPrice(subscription, row.stripePriceId, row.billingCurrency)
        ? "inactive"
        : billing;
    const renewsAt = subscriptionRenewal(subscription, status);
    if (status === row.billingStatus && renewsAt?.getTime() === row.renewsAt?.getTime()) return;
    await tx
      .updateTable("cloudComputers")
      .where("id", "=", row.id)
      .set({
        billingStatus: status,
        renewsAt,
        ...transition(row, desiredState(row, status), this.#now()),
        updatedAt: this.#now(),
      })
      .executeTakeFirst();
  }

  async reconcileBilling(onError: () => void) {
    const run = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch {
        onError();
      }
    };
    await run(() => this.checkOffer());
    await this.#db.connection().execute(async (connection) => {
      const acquired = await sql<{ locked: boolean }>`select pg_try_advisory_lock(
        hashtextextended('cloud-computer-billing-reconcile',0)) as locked`.execute(connection);
      if (!acquired.rows[0]?.locked) return;
      try {
        await this.#billingPass(run, onError);
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended('cloud-computer-billing-reconcile',0))`.execute(
          connection,
        );
      }
    });
  }

  async #billingPass(run: (action: () => Promise<unknown>) => Promise<void>, onError: () => void) {
    const checkouts = await this.#db
      .selectFrom("cloudComputerCheckouts")
      .select(["accountId", "requestId"])
      .where("status", "=", "open")
      .execute();
    for (const attempt of checkouts)
      await run(() => this.#recoverCheckout(attempt.accountId, attempt.requestId, true));
    const deferred = await this.#db
      .selectFrom("cloudComputerStripeEvents")
      .select(["id", "type", sql<string>`deferred_checkout::text`.as("checkoutJson")])
      .where("deferredCheckout", "is not", null)
      .execute();
    for (const event of deferred)
      await run(async () => {
        const payload: unknown = JSON.parse(event.checkoutJson);
        if (event.type === "account.checkout.orphaned") {
          await this.#recoverOrphanedCheckout(event.id, orphanedCheckoutSchema.parse(payload));
          return;
        }
        const checkout = StripePaidCheckoutSchema.parse(payload);
        const account = await this.#db
          .selectFrom("users")
          .select("id")
          .where("id", "=", checkout.metadata.account_id)
          .executeTakeFirst();
        if (account) {
          await this.applyStripeEvent({
            id: event.id,
            type: event.type,
            operation: "completed",
            checkout,
          });
        } else {
          const subscription = await this.#options.stripe.subscription(checkout.subscription);
          if (billingStatus(subscription) !== "canceled")
            await this.#options.stripe.cancel(checkout.subscription);
          await this.#db
            .updateTable("cloudComputerStripeEvents")
            .where("id", "=", event.id)
            .set({ deferredCheckout: null })
            .executeTakeFirst();
          await this.#db
            .updateTable("cloudComputerBackupTargets")
            .where(
              "checkoutKey",
              "=",
              checkoutKey(checkout.metadata.account_id, checkout.metadata.request_id),
            )
            .set({ checkoutKey: null })
            .executeTakeFirst();
        }
      });
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .select("stripeSubscriptionId")
      .where("tombstonedAt", "is", null)
      .where("workAssignmentId", "is", null)
      .where("state", "!=", "deleted")
      .execute();
    for (const row of rows)
      await run(() =>
        this.#db
          .transaction()
          .execute((tx) => this.#refreshSubscription(tx, row.stripeSubscriptionId)),
      );
    await run(async () => this.#options.organizations?.reconcile(onError));
  }

  async #recoverOrphanedCheckout(id: string, attempt: z.infer<typeof orphanedCheckoutSchema>) {
    const session = await this.#options.stripe.findCheckout({
      ...attempt,
      createdAt: new Date(attempt.createdAt),
    });
    if (session?.payment) {
      const subscription = await this.#options.stripe.subscription(session.payment.subscription);
      if (billingStatus(subscription) !== "canceled")
        await this.#options.stripe.cancel(subscription.id);
    } else if (
      session?.status !== "expired" &&
      (session ||
        this.#now().getTime() - Date.parse(attempt.lastAttemptAt) < unknownCheckoutGraceMs)
    ) {
      return;
    }
    await this.#db.transaction().execute(async (tx) => {
      await tx
        .updateTable("cloudComputerStripeEvents")
        .where("id", "=", id)
        .set({ deferredCheckout: null })
        .executeTakeFirst();
      await releaseCheckoutTarget(tx, attempt.accountId, attempt.requestId);
    });
  }

  async lease(holder: string, acquire: boolean): Promise<boolean> {
    const now = this.#now();
    const expires = new Date(now.getTime() + 10 * 60_000);
    const result = acquire
      ? await sql`
          insert into cloud_computer_provisioner_lease (singleton, holder, expires_at)
          values (true, ${holder}::uuid, ${expires})
          on conflict (singleton) do update set holder = excluded.holder, expires_at = excluded.expires_at
          where cloud_computer_provisioner_lease.expires_at <= ${now}
             or cloud_computer_provisioner_lease.holder = excluded.holder
          returning holder
        `.execute(this.#db)
      : await sql`
          update cloud_computer_provisioner_lease set expires_at = ${expires}
          where singleton and holder = ${holder}::uuid and expires_at > ${now} returning holder
        `.execute(this.#db);
    return result.rows.length === 1;
  }

  async check(id: CloudComputerId, check: CloudComputerCheck): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (check.operation === "orphan") return !row || row.tombstonedAt !== null;
      if (
        !row ||
        row.revision !== check.revision ||
        row.tombstonedAt !== null ||
        (row.deletionRequestedAt && row.state === "active")
      )
        return false;
      if (check.operation === "create") {
        if (!needsVm(row) || !row.bootstrapDigest) return false;
        await tx
          .updateTable("cloudComputers")
          .set({ createAttempted: true })
          .where("id", "=", id)
          .executeTakeFirst();
      }
      return true;
    });
  }

  async bootComplete(id: CloudComputerId, input: CloudComputerBootCompleteRequest): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const replay = equalSecretDigests(
        bootDigest(row ?? { id, generation: 0 }, input.bootstrapToken),
        row?.completedBootDigest ?? emptyDigest,
      );
      if (
        row?.bootCompletedAt &&
        replay &&
        row.hostname === input.hostname &&
        row.state === "active" &&
        row.deploymentId === input.identity.deploymentId &&
        row.hostKeyFingerprint === input.identity.hostKeyFingerprint
      )
        return;
      if (!validBoot(row, id, input, this.#now())) throw invalidBoot();
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", id)
        .set({
          ...clearBootToken,
          completedBootDigest: row.bootstrapDigest,
          bootCompletedAt: this.#now(),
          deploymentId: input.identity.deploymentId,
          hostKeyFingerprint: input.identity.hostKeyFingerprint,
        })
        .executeTakeFirst();
    });
  }

  async desired(): Promise<CloudComputerDesired[]> {
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("tombstonedAt", "is", null)
      .orderBy("createdAt")
      .limit(10_000)
      .execute();
    return Promise.all(
      rows.map(async (snapshot) => {
        let row = snapshot;
        if (needsVm(row) && !row.bootstrapDigest) {
          row = await this.#db.transaction().execute(async (tx) => {
            const current = await lockedComputer(tx, snapshot.id);
            if (!needsVm(current) || current.bootstrapDigest) return current;
            const token = newSecret();
            return tx
              .updateTable("cloudComputers")
              .where("id", "=", current.id)
              .set({
                bootstrapDigest: bootDigest(current, token),
                sealedBootstrapToken: this.#options.cipher.seal(
                  `boot:${current.id}`,
                  current.generation,
                  token,
                ),
                bootstrapExpiresAt: null,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
          });
        }
        const token =
          needsVm(row) &&
          row.sealedBootstrapToken &&
          (!row.bootstrapExpiresAt || row.bootstrapExpiresAt > this.#now())
            ? this.#options.cipher.open(`boot:${row.id}`, row.generation, row.sealedBootstrapToken)
            : undefined;
        return CloudComputerDesiredSchema.parse({
          id: row.id,
          generation: row.generation,
          revision: row.revision,
          providerServerId: row.providerServerId ? Number(row.providerServerId) : undefined,
          previousProviderServerId: row.previousProviderServerId
            ? Number(row.previousProviderServerId)
            : undefined,
          ipv6Enabled: row.ipv6Enabled,
          restoreSnapshot: row.restoreSnapshot ?? undefined,
          bootCompleted: row.bootCompletedAt !== null,
          state: row.state,
          hostname: row.hostname,
          region: row.region,
          serverType: row.serverType,
          release: row.release,
          readinessStartedAt: row.readinessStartedAt.toISOString(),
          ...(row.deploymentId
            ? {
                observedIdentity: {
                  deploymentId: row.deploymentId,
                  hostKeyFingerprint: row.hostKeyFingerprint,
                },
              }
            : {}),
          ...(token ? { bootstrapToken: token } : {}),
        });
      }),
    );
  }

  async report(report: CloudComputerReport) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", report.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.revision !== report.revision ||
        row.generation !== report.generation ||
        row.tombstonedAt !== null ||
        !phaseMatchesState(row.state, report.phase) ||
        (report.phase === "ready" && (!row.bootCompletedAt || !report.observedIdentity))
      ) {
        return { recorded: false, kick: false };
      }
      const identity = report.observedIdentity;
      if (
        row.deploymentId &&
        identity &&
        (identity.deploymentId !== row.deploymentId ||
          identity.hostKeyFingerprint !== row.hostKeyFingerprint)
      ) {
        throw new ControlPlaneError("conflict", "Cloud Computer Home identity changed");
      }
      const now = this.#now();
      const ready = report.phase === "ready";
      const deleted = report.phase === "deleted";
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", row.id)
        .set({
          phase: report.phase,
          ipv4: report.ipv4,
          ipv6: report.ipv6,
          // Retain the last server observation through transient provider failures.
          providerServerId: deleted
            ? null
            : (report.providerServerId?.toString() ?? row.providerServerId),
          lastError: report.lastError,
          reportedAt: now,
          updatedAt: now,
          ...(ready ? { everReady: true } : {}),
          ...(deleted ? clearBootToken : {}),
          ...(row.bootstrapDigest && !row.bootstrapExpiresAt && report.providerServerId
            ? {
                bootstrapExpiresAt: new Date(now.getTime() + bootstrapLifetimeMs),
                readinessStartedAt: now,
              }
            : {}),
          ...((report.phase === "booting" || report.phase === "failed") && row.phase === "ready"
            ? { readinessStartedAt: now }
            : {}),
          ...(deleted ? { tombstonedAt: now, deploymentId: null, hostKeyFingerprint: null } : {}),
        })
        .executeTakeFirst();
      if (deleted) {
        await forgetHome(tx, row, true);
        await tx
          .updateTable("cloudComputerEgressEndpoints")
          .set({ computerId: null, needsRotation: true })
          .where("computerId", "=", row.id)
          .executeTakeFirst();
        await tx
          .updateTable("cloudComputerBackupTargets")
          .set({ computerId: null, needsRotation: true })
          .where("computerId", "=", row.id)
          .executeTakeFirst();
      }
      return { recorded: true, kick: ready && row.bootstrapReceiptAt === null };
    });
  }

  async boot(
    id: CloudComputerId,
    input: CloudComputerBootRequest,
  ): Promise<CloudComputerBootResponse> {
    return this.#db.transaction().execute(async (tx) => {
      const work = await tx
        .selectFrom("cloudComputers")
        .innerJoin("workAssignments", "workAssignments.id", "cloudComputers.workAssignmentId")
        .select("workAssignments.assigneeAccountId")
        .where("cloudComputers.id", "=", id)
        .executeTakeFirst();
      if (work?.assigneeAccountId)
        await tx
          .selectFrom("users")
          .select("id")
          .where("id", "=", work.assigneeAccountId)
          .forKeyShare()
          .executeTakeFirst();
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !validBoot(row, id, input, this.#now()) ||
        !row.setupCodeDigest ||
        !row.sealedBackupPassword
      )
        throw invalidBoot();

      const endpoints = tx.selectFrom("cloudComputerEgressEndpoints").selectAll();
      let endpoint = await endpoints.where("computerId", "=", id).executeTakeFirst();
      if (!endpoint) {
        endpoint = await endpoints
          .where("computerId", "is", null)
          .where("needsRotation", "=", false)
          .orderBy("id")
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (endpoint) {
          await tx
            .updateTable("cloudComputerEgressEndpoints")
            .set({ computerId: id })
            .where("id", "=", endpoint.id)
            .executeTakeFirst();
        }
      }
      await tx
        .updateTable("cloudComputers")
        .set({ egressUnavailable: !endpoint })
        .where("id", "=", id)
        .executeTakeFirst();

      const managedHome = await this.#managedHome(tx, row);
      const marker = await workMarker(tx, row.workAssignmentId);
      const { cipher } = this.#options;
      const backup = await tx
        .selectFrom("cloudComputerBackupTargets")
        .selectAll()
        .where("computerId", "=", id)
        .executeTakeFirst();
      if (!backup)
        throw new ControlPlaneError("unavailable", "A backup target has not been assigned");
      const accessKeyId = cipher.open(
        `backup-access:${backup.id}`,
        1,
        backup.sealedCredentials.split(":")[0]!,
      );
      const secretAccessKey = cipher.open(
        `backup-secret:${backup.id}`,
        1,
        backup.sealedCredentials.split(":")[1]!,
      );
      const { endpoint: backupEndpoint, bucket, prefix } = backup;
      return {
        managedHome,
        ...(marker ? { work: marker } : {}),
        ipv6Enabled: row.ipv6Enabled,
        ...(row.restoreSnapshot ? { restoreSnapshot: row.restoreSnapshot } : {}),
        hostname: row.hostname,
        accountOrigin: this.#options.accountOrigin.origin,
        setupCodeDigest: row.setupCodeDigest,
        release: CloudComputerBootReleaseSchema.parse({
          version: row.release.version,
          images: row.release.images,
        }),
        ...(endpoint
          ? {
              egress: {
                url: endpoint.url,
                username: endpoint.username,
                password: cipher.open(`egress:${endpoint.id}`, 1, endpoint.sealedPassword),
              },
            }
          : {}),
        backup: {
          endpoint: backupEndpoint,
          bucket,
          prefix,
          accessKeyId,
          secretAccessKey,
          repository: `s3:${backupEndpoint}/${bucket}/${prefix}`,
          password: cipher.open(`backup:${id}`, 1, row.sealedBackupPassword),
        },
      };
    });
  }

  async setupCodeForReadyHome(
    id: CloudComputerId,
    generation: number,
  ): Promise<string | undefined> {
    const row = await this.#db
      .selectFrom("cloudComputers")
      .select(["sealedSetupCode", "generation"])
      .where("id", "=", id)
      .where("generation", "=", generation)
      .where("state", "=", "active")
      .where("phase", "=", "ready")
      .where("bootstrapReceiptAt", "is", null)
      .executeTakeFirst();
    return row?.sealedSetupCode
      ? this.#options.cipher.open(id, row.generation, row.sealedSetupCode)
      : undefined;
  }

  /**
   * The managed Home's OIDC client and link credential, minted once per
   * generation inside the boot exchange so every retry hands out the same ones.
   */
  async #managedHome(tx: TransactionDb, row: Computer) {
    const { cipher } = this.#options;
    const owner = await computerOwner(tx, row, true);
    if (!owner)
      throw new ControlPlaneError(
        "unauthorized",
        "Invalid or expired Cloud Computer bootstrap token",
      );
    const clientId = row.oidcClientId ?? `occ_${row.id.slice("cc_".length)}`;
    let secret = row.sealedOidcClientSecret
      ? cipher.open(`oidc:${row.id}`, row.generation, row.sealedOidcClientSecret)
      : undefined;
    if (!secret || !row.sealedHostCredential) {
      secret = createOAuthClientSecret();
      const now = this.#now();
      const registration = {
        clientSecret: hashCredential(secret),
        redirectUris: JSON.stringify([
          new URL(hostOidcCallbackPath, `https://${row.hostname}`).toString(),
        ]),
        userId: owner,
        updatedAt: now,
      };
      const updated = await tx
        .updateTable("oauthClients")
        .set(registration)
        .where("clientId", "=", clientId)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n)
        await tx
          .insertInto("oauthClients")
          .values({
            ...registration,
            id: `oac_${randomUUID()}`,
            clientId,
            disabled: false,
            skipConsent: true,
            enableEndSession: false,
            subjectType: "public",
            scopes: JSON.stringify(["openid", "profile", "email"]),
            createdAt: now,
            name: "Opensteer Cloud Computer",
            uri: `https://${row.hostname}`,
            icon: null,
            contacts: null,
            tos: null,
            policy: null,
            softwareId: "opensteer-host",
            softwareVersion: null,
            softwareStatement: null,
            postLogoutRedirectUris: null,
            tokenEndpointAuthMethod: "client_secret_basic",
            grantTypes: JSON.stringify(["authorization_code"]),
            responseTypes: JSON.stringify(["code"]),
            applicationType: "web",
            requirePkce: true,
            referenceId: `cloud-computer:${row.id}`,
            metadata: { managedBy: "opensteer-control-plane", cloudComputerId: row.id },
          })
          .executeTakeFirstOrThrow();
      await tx
        .updateTable("cloudComputers")
        .set({
          oidcClientId: clientId,
          sealedOidcClientSecret: cipher.seal(`oidc:${row.id}`, row.generation, secret),
          sealedHostCredential: cipher.seal(
            `host-credential:${row.id}`,
            row.generation,
            createHostCredential(),
          ),
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
    }
    return {
      cloudComputerId: row.id,
      generation: row.generation,
      oidc: { clientId, clientSecret: secret },
    };
  }

  /** Leases the next ready Home whose claim is due; none when nothing is. */
  async claimDue(): Promise<CloudComputerClaimJob | undefined> {
    return this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("state", "=", "active")
        .where("phase", "=", "ready")
        .where("bootstrapReceiptAt", "is", null)
        .where("claimError", "is", null)
        .where("tombstonedAt", "is", null)
        .where("deploymentId", "is not", null)
        .where((eb) =>
          eb.or([
            eb("accountId", "is not", null),
            eb(
              "workAssignmentId",
              "in",
              eb
                .selectFrom("workAssignments")
                .select("workAssignments.id")
                .where("state", "=", "active")
                .where("assigneeAccountId", "is not", null),
            ),
          ]),
        )
        .where((eb) => eb.or([eb("claimNextAt", "is", null), eb("claimNextAt", "<=", now)]))
        .orderBy("readinessStartedAt")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return undefined;
      const owner = await computerOwner(tx, row, true);
      if (!owner) return undefined;
      await tx
        .updateTable("cloudComputers")
        .set({
          claimAttempt: row.claimAttempt + 1,
          claimNextAt: new Date(now.getTime() + claimLeaseMs),
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        generation: row.generation,
        accountId: owner,
        hostname: row.hostname,
        deploymentId: row.deploymentId!,
        hostKeyFingerprint: row.hostKeyFingerprint!,
        attempt: row.claimAttempt + 1,
        readinessStartedAt: row.readinessStartedAt,
      };
    });
  }

  /** What the claim carries: the sealed setup code and link credential, and who the owner is. */
  async claimMaterial(job: CloudComputerClaimJob) {
    const computer = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("id", "=", job.id)
      .where("generation", "=", job.generation)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!computer || (await computerOwner(this.#db, computer, true)) !== job.accountId)
      throw new CloudComputerClaimSupersededError();
    const owner = await this.#db
      .selectFrom("users")
      .select(["displayName", "email", "emailVerified"])
      .where("id", "=", job.accountId)
      .executeTakeFirst();
    const work = await workMarker(this.#db, computer.workAssignmentId);
    const setupCode = await this.setupCodeForReadyHome(job.id, job.generation);
    if (!computer.sealedHostCredential || !owner || !setupCode)
      throw new CloudComputerClaimSupersededError();
    return {
      setupCode,
      hostCredential: this.#options.cipher.open(
        `host-credential:${job.id}`,
        job.generation,
        computer.sealedHostCredential,
      ),
      linkGeneration: managedHomeLinkGeneration(job),
      owner,
      ...(work ? { work } : {}),
    };
  }

  async deferClaim(job: CloudComputerClaimJob, at: Date): Promise<void> {
    await this.#claimRow(job).set({ claimNextAt: at }).executeTakeFirst();
  }

  async failClaim(job: CloudComputerClaimJob, reason: string): Promise<void> {
    await this.#claimRow(job)
      .set({ claimError: reason.slice(0, 1000), claimNextAt: null, updatedAt: this.#now() })
      .executeTakeFirst();
  }

  #claimRow(job: CloudComputerClaimJob) {
    return this.#db
      .updateTable("cloudComputers")
      .where("id", "=", job.id)
      .where("generation", "=", job.generation)
      .where("bootstrapReceiptAt", "is", null);
  }

  /**
   * Records the Home's signed receipt and lists the Home in its owner's
   * directory, in one transaction. Idempotent: a receipt already recorded is
   * left as it is.
   */
  async recordClaim(
    job: CloudComputerClaimJob,
    receipt: ManagedHomeClaimReceipt,
    authorityEnvelope: HostDiscoveryEnvelope,
  ): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("users")
        .select("id")
        .where("id", "=", job.accountId)
        .forKeyShare()
        .executeTakeFirst();
      const row = await lockedComputer(tx, job.id);
      if (
        row.generation !== job.generation ||
        row.deploymentId !== job.deploymentId ||
        (await computerOwner(tx, row, true)) !== job.accountId ||
        row.tombstonedAt !== null ||
        !row.sealedHostCredential
      )
        throw new CloudComputerClaimSupersededError();
      if (row.bootstrapReceiptAt) return;
      const now = this.#now();
      const deploymentId = DeploymentIdSchema.parse(job.deploymentId);
      const listed = await tx
        .selectFrom("deployments")
        .select(["ownerAccountId"])
        .where("id", "=", deploymentId)
        .forUpdate()
        .executeTakeFirst();
      if (listed && listed.ownerAccountId !== job.accountId)
        throw new ControlPlaneError("conflict", "This Home is already listed for another Account");
      if (!listed) {
        await tx
          .insertInto("deployments")
          .values({
            activeHostInstanceId: receipt.document.authority.hostInstanceId,
            accountLink: {
              generation: receipt.document.linkGeneration,
              issuer: receipt.document.account.issuer,
              subject: receipt.document.account.subject,
            },
            authorityEnvelope,
            canonicalOrigin: receipt.document.authority.canonicalOrigin,
            createdAt: now,
            directoryGeneration: 1,
            hostKeyFingerprint: HostKeyFingerprintSchema.parse(job.hostKeyFingerprint),
            reachability: "canonical",
            id: deploymentId,
            lifecycle: "active",
            name: "Cloud Computer",
            oidcClientId: row.oidcClientId,
            ownerAccountId: job.accountId,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("deploymentCredentials")
          .values({
            createdAt: now,
            deploymentId,
            rotatedAt: now,
            tokenHash: hashCredential(
              this.#options.cipher.open(
                `host-credential:${row.id}`,
                row.generation,
                row.sealedHostCredential,
              ),
            ),
          })
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("deploymentConnect")
          .values({
            accessRoute: null,
            deploymentId,
            generation: 0,
            observedAt: null,
            origin: null,
            state: "disabled",
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("deploymentDirectoryEntries")
          .values({
            accountId: job.accountId,
            deploymentId,
            generation: 1,
            observedAt: now,
            present: true,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
      await tx
        .updateTable("cloudComputers")
        .set({
          bootstrapReceipt: JSON.stringify(receipt),
          bootstrapReceiptAt: now,
          claimNextAt: null,
          updatedAt: now,
        })
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
    });
  }

  async list(accountId?: ControlPlaneAccountId): Promise<CloudComputerView[]> {
    let query = this.#db.selectFrom("cloudComputers").selectAll().orderBy("createdAt", "desc");
    if (accountId) query = query.where("accountId", "=", accountId);
    const rows = await query.execute();
    return this.#views(rows);
  }

  async show(id: CloudComputerId, accountId?: ControlPlaneAccountId): Promise<CloudComputerView> {
    let query = this.#db.selectFrom("cloudComputers").selectAll().where("id", "=", id);
    if (accountId)
      query = query.where((eb) =>
        eb.or([
          eb("accountId", "=", accountId),
          eb(
            "workAssignmentId",
            "in",
            eb
              .selectFrom("workAssignments")
              .select("workAssignments.id")
              .where("assigneeAccountId", "=", accountId),
          ),
        ]),
      );
    const row = await query.executeTakeFirst();
    if (!row) throw missing();
    return (await this.#views([row]))[0]!;
  }

  async #views(rows: readonly Computer[]) {
    if (rows.length === 0) return [];
    const endpoints = await this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .select(["computerId", "publicAddress"])
      .where(
        "computerId",
        "in",
        rows.map(({ id }) => id),
      )
      .execute();
    const assigned = new Map(endpoints.map((endpoint) => [endpoint.computerId, endpoint]));
    const now = this.#now();
    return rows.map((row) => view(row, assigned.get(row.id), this.#options.config, now));
  }

  async mutate(
    id: CloudComputerId,
    action: Mutation,
    accountId?: ControlPlaneAccountId,
    reason?: string,
  ) {
    const subscription = await this.#db.transaction().execute(async (tx) => {
      const row = await lockedComputer(tx, id);
      if (row.workAssignmentId) {
        if (accountId && (await computerOwner(tx, row, false)) !== accountId) throw missing();
        throw new ControlPlaneError(
          "forbidden",
          "This Cloud Computer is managed by its organization",
          { reason: "cloud-computer-work-managed" },
        );
      }
      if (accountId && row.accountId !== accountId) throw missing();
      if (row.state === "deleted") {
        if (action === "delete") return undefined;
        throw new ControlPlaneError("conflict", "This Cloud Computer is deleted", {
          reason: "cloud-computer-deleted",
        });
      }

      const now = this.#now();
      let changes: Updateable<CloudComputerTable>;
      if (action === "delete") {
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({ deletionRequestedAt: row.deletionRequestedAt ?? now, updatedAt: now })
          .executeTakeFirst();
        return row.stripeSubscriptionId;
      } else if (action === "reissue" && (row.everReady || row.bootCompletedAt)) {
        throw new ControlPlaneError(
          "conflict",
          "A working Home can only be replaced from a named backup snapshot",
        );
      } else if (action === "reissue" && !row.providerServerId && !row.createAttempted) {
        if (row.state !== "active")
          throw new ControlPlaneError("conflict", "Resume before reissuing bootstrap");
        changes = {
          ...clearBootToken,
          phase: "provisioning",
          lastError: null,
          readinessStartedAt: now,
        };
      } else if (action === "reissue" || action === "replace") {
        if (row.state !== "active")
          throw new ControlPlaneError("conflict", "Resume the Cloud Computer before rebuilding");
        const snapshot =
          action === "replace" ? CloudComputerSnapshotSchema.safeParse(reason) : undefined;
        if (snapshot && (!snapshot.success || !row.everReady)) {
          throw new ControlPlaneError(
            "bad_request",
            "Replacing a ready Home requires a valid backup snapshot ID",
          );
        }
        const generation = row.generation + 1;
        const setupCode = newSecret();
        changes = {
          ...clearBootToken,
          generation,
          bootCompletedAt: null,
          completedBootDigest: null,
          createAttempted: false,
          previousProviderServerId: row.providerServerId ?? row.previousProviderServerId,
          restoreSnapshot: snapshot?.success ? snapshot.data : null,
          phase: "provisioning",
          readinessStartedAt: now,
          reportedAt: null,
          setupCodeDigest: digestSecret(setupCode),
          sealedSetupCode: this.#options.cipher.seal(id, generation, setupCode),
          providerServerId: null,
          ipv4: null,
          ipv6: null,
          deploymentId: null,
          hostKeyFingerprint: null,
          lastError: null,
          bootstrapReceipt: null,
          bootstrapReceiptAt: null,
          egressUnavailable: false,
          sealedOidcClientSecret: null,
          sealedHostCredential: null,
          claimAttempt: 0,
          claimNextAt: null,
          claimError: null,
        };
        // The next generation is a new Home; the Account forgets the one it replaces.
        await forgetHome(tx, row, false);
      } else {
        const ownerSuspended = action === "suspend" || (action !== "resume" && row.ownerSuspended);
        const operatorSuspension =
          action === "operator-suspend"
            ? (reason ?? "Paused by Opensteer.")
            : action === "operator-unsuspend"
              ? null
              : row.operatorSuspension;
        changes = {
          ownerSuspended,
          operatorSuspension,
          ...transition(
            row,
            desiredState({ ...row, operatorSuspension, ownerSuspended }, row.billingStatus),
            now,
          ),
        };
      }
      await tx
        .updateTable("cloudComputers")
        .set({ ...changes, updatedAt: now })
        .where("id", "=", id)
        .executeTakeFirst();
      return undefined;
    });
    if (subscription) {
      try {
        await this.#db.transaction().execute((tx) => this.#refreshSubscription(tx, subscription));
      } catch {
        // Keep the durable request for the next billing pass.
      }
    }
    return this.show(id, accountId);
  }

  async addEgressEndpoint(endpoint: {
    url: string;
    username: string;
    password: string;
    publicAddress?: string;
  }): Promise<string> {
    const parsed = CloudComputerEgressSchema.extend({
      publicAddress: CloudComputerEgressAddressSchema.optional(),
    }).safeParse(endpoint);
    if (!parsed.success)
      throw new ControlPlaneError("bad_request", "Invalid browser egress endpoint");
    const id = randomUUID();
    const row = await this.#db
      .insertInto("cloudComputerEgressEndpoints")
      .values({
        id,
        url: new URL(parsed.data.url).origin,
        username: parsed.data.username,
        publicAddress: parsed.data.publicAddress ?? null,
        computerId: null,
        sealedPassword: this.#options.cipher.seal(`egress:${id}`, 1, parsed.data.password),
        needsRotation: false,
      })
      .onConflict((conflict) => conflict.column("url").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) throw new ControlPlaneError("conflict", "Browser egress endpoint already exists");
    return row.id;
  }

  async setEgressAddress(id: string, address: string | null): Promise<void> {
    const parsed = CloudComputerEgressAddressSchema.nullable().safeParse(address);
    if (!parsed.success) {
      throw new ControlPlaneError("bad_request", "Invalid browser egress address");
    }
    const updated = await this.#db
      .updateTable("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .set({ publicAddress: parsed.data })
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new ControlPlaneError("not_found", "Browser egress endpoint was not found");
    }
  }

  async removeEgressEndpoint(id: string): Promise<void> {
    const result = await this.#db
      .deleteFrom("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .where("needsRotation", "=", false)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n) {
      throw new ControlPlaneError(
        "conflict",
        "Browser egress endpoint is assigned or does not exist",
      );
    }
  }

  async rotateEgressEndpoint(id: string, credentials: { username: string; password: string }) {
    const parsed = CloudComputerEgressSchema.pick({ username: true, password: true }).safeParse(
      credentials,
    );
    if (!parsed.success)
      throw new ControlPlaneError("bad_request", "Invalid browser egress credentials");
    const row = await this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      !row ||
      row.computerId ||
      !row.needsRotation ||
      this.#options.cipher.open(`egress:${id}`, 1, row.sealedPassword) === parsed.data.password
    ) {
      throw new ControlPlaneError(
        "conflict",
        "This endpoint requires a new password and must be awaiting rotation",
      );
    }
    await this.#db
      .updateTable("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("needsRotation", "=", true)
      .where("sealedPassword", "=", row.sealedPassword)
      .set({
        username: parsed.data.username,
        sealedPassword: this.#options.cipher.seal(`egress:${id}`, 1, parsed.data.password),
        needsRotation: false,
      })
      .executeTakeFirst();
  }

  async addBackupTarget(input: unknown) {
    const target = backupTargetSchema.safeParse(input);
    if (!target.success) throw new ControlPlaneError("bad_request", "Invalid backup target");
    const { accessKeyId, secretAccessKey, ...location } = target.data;
    const id = randomUUID();
    return this.#db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('cloud-computer-backup-pool',0))`.execute(
        tx,
      );
      const existing = await tx
        .selectFrom("cloudComputerBackupTargets")
        .select("prefix")
        .where("endpoint", "=", location.endpoint)
        .where("bucket", "=", location.bucket)
        .execute();
      if (
        existing.some(
          ({ prefix }) =>
            prefix === location.prefix ||
            prefix.startsWith(location.prefix + "/") ||
            location.prefix.startsWith(prefix + "/"),
        )
      ) {
        throw new ControlPlaneError("conflict", "This backup prefix overlaps another target");
      }
      const inserted = await tx
        .insertInto("cloudComputerBackupTargets")
        .values({
          id,
          ...location,
          principalFingerprint: digestSecret(accessKeyId),
          sealedCredentials: this.#sealBackup(id, accessKeyId, secretAccessKey),
          computerId: null,
          checkoutKey: null,
        })
        .onConflict((conflict) => conflict.column("principalFingerprint").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted)
        throw new ControlPlaneError("conflict", "This storage principal is already registered");
      return inserted.id;
    });
  }

  async rotateBackupTarget(id: string, input: unknown) {
    const credentials = backupTargetSchema
      .pick({ accessKeyId: true, secretAccessKey: true })
      .safeParse(input);
    if (!credentials.success)
      throw new ControlPlaneError("bad_request", "Invalid backup credentials");
    const { accessKeyId, secretAccessKey } = credentials.data;
    const fingerprint = digestSecret(accessKeyId);
    const result = await this.#db
      .updateTable("cloudComputerBackupTargets")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .where("checkoutKey", "is", null)
      .where("needsRotation", "=", true)
      .where("principalFingerprint", "!=", fingerprint)
      .set({
        principalFingerprint: fingerprint,
        sealedCredentials: this.#sealBackup(id, accessKeyId, secretAccessKey),
        needsRotation: false,
      })
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new ControlPlaneError(
        "conflict",
        "This backup target needs a new storage principal and must be awaiting rotation",
      );
  }

  #sealBackup(id: string, accessKey: string, secretKey: string) {
    const { cipher } = this.#options;
    return (
      cipher.seal(`backup-access:${id}`, 1, accessKey) +
      ":" +
      cipher.seal(`backup-secret:${id}`, 1, secretKey)
    );
  }

  async listBackupTargets() {
    return this.#db
      .selectFrom("cloudComputerBackupTargets")
      .select(["id", "endpoint", "bucket", "prefix", "computerId", "needsRotation"])
      .orderBy("id")
      .execute();
  }

  async removeBackupTarget(id: string) {
    const result = await this.#db
      .deleteFrom("cloudComputerBackupTargets")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .where("checkoutKey", "is", null)
      .where("needsRotation", "=", false)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n)
      throw new ControlPlaneError(
        "conflict",
        "Backup target is reserved, assigned or does not exist",
      );
  }

  async listEgressEndpoints() {
    return this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .select(["id", "computerId", "needsRotation", "publicAddress"])
      .orderBy("id")
      .execute();
  }
}

const orphanedCheckoutSchema = z.object({
  accountId: ControlPlaneAccountIdSchema,
  requestId: z.uuid(),
  sessionId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  lastAttemptAt: z.iso.datetime({ offset: true }),
});

const backupTargetSchema = z.strictObject({
  ...CloudComputerBootResponseSchema.shape.backup.pick({
    endpoint: true,
    bucket: true,
    prefix: true,
    accessKeyId: true,
    secretAccessKey: true,
  }).shape,
  accessKeyId: CloudComputerBootResponseSchema.shape.backup.shape.accessKeyId.max(255),
  secretAccessKey: CloudComputerBootResponseSchema.shape.backup.shape.secretAccessKey.max(255),
});

function checkoutKey(account: ControlPlaneAccountId, request: string) {
  return `${account}/${request}`;
}

async function releaseCheckoutTarget(
  tx: TransactionDb,
  account: ControlPlaneAccountId,
  request: string,
) {
  await tx
    .updateTable("cloudComputerBackupTargets")
    .where("checkoutKey", "=", checkoutKey(account, request))
    .set({ checkoutKey: null })
    .executeTakeFirst();
}

const clearBootToken = {
  bootstrapDigest: null,
  sealedBootstrapToken: null,
  bootstrapExpiresAt: null,
};

/** The Account link's generation for one claim: the same on every retry. */
export function managedHomeLinkGeneration(job: Pick<CloudComputerClaimJob, "id" | "generation">) {
  return createHash("sha256")
    .update(`opensteer-managed-home-link\0${job.id}\0${job.generation}`)
    .digest("base64url");
}

/** The Account's listing and OIDC client for a Home that no longer exists. */
async function forgetHome(tx: TransactionDb, row: Computer, client: boolean) {
  const owner = await computerOwner(tx, row, false);
  if (row.deploymentId && owner)
    await tx
      .deleteFrom("deployments")
      .where("id", "=", DeploymentIdSchema.parse(row.deploymentId))
      .where("ownerAccountId", "=", owner)
      .where("oidcClientId", "=", row.oidcClientId)
      .executeTakeFirst();
  if (client && row.oidcClientId) {
    await tx
      .updateTable("cloudComputers")
      .set({ oidcClientId: null })
      .where("id", "=", row.id)
      .executeTakeFirst();
    await tx.deleteFrom("oauthClients").where("clientId", "=", row.oidcClientId).executeTakeFirst();
  }
}

async function computerOwner(db: Database, row: Computer, active: boolean) {
  if (!row.workAssignmentId) return row.accountId;
  const assignment = await db
    .selectFrom("workAssignments")
    .select(["state", "assigneeAccountId"])
    .where("id", "=", row.workAssignmentId)
    .executeTakeFirst();
  return assignment && (!active || assignment.state === "active")
    ? assignment.assigneeAccountId
    : null;
}

async function workMarker(
  db: Database,
  id: WorkAssignmentId | null,
): Promise<WorkHomeMarker | undefined> {
  if (!id) return;
  return db
    .selectFrom("workAssignments")
    .innerJoin("organizations", "organizations.id", "workAssignments.organizationId")
    .where("workAssignments.id", "=", id)
    .select([
      "organizations.id as organizationId",
      "organizations.name as organizationName",
      "workAssignments.id as assignmentId",
    ])
    .executeTakeFirst();
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function bootDigest(row: Pick<Computer, "id" | "generation">, token: string) {
  return digestSecret(`${row.id}\0${row.generation}\0${token}`);
}

function validBoot(
  row: Computer | undefined,
  id: CloudComputerId,
  input: CloudComputerBootRequest,
  now: Date,
): row is Computer {
  const valid = equalSecretDigests(
    bootDigest(row ?? { id, generation: 0 }, input.bootstrapToken),
    row?.bootstrapDigest ?? emptyDigest,
  );
  return Boolean(
    row &&
    valid &&
    row.hostname === input.hostname &&
    row.state === "active" &&
    !row.deletionRequestedAt &&
    row.bootstrapExpiresAt &&
    row.bootstrapExpiresAt > now &&
    !row.bootCompletedAt,
  );
}

function invalidBoot() {
  return new ControlPlaneError("unauthorized", "Invalid or expired Cloud Computer bootstrap token");
}

function needsVm(row: Computer) {
  return (
    row.state === "active" &&
    !row.deletionRequestedAt &&
    !row.providerServerId &&
    !row.bootCompletedAt &&
    !row.deploymentId
  );
}

async function lockOwner(tx: TransactionDb, accountId: ControlPlaneAccountId, now: Date) {
  const owner = await tx
    .selectFrom("users")
    .select(["id", "deletionFencedUntil"])
    .where("id", "=", accountId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  return (
    owner !== undefined && (owner.deletionFencedUntil === null || owner.deletionFencedUntil <= now)
  );
}

async function lockedComputer(tx: TransactionDb, id: CloudComputerId) {
  const row = await tx
    .selectFrom("cloudComputers")
    .selectAll()
    .where("id", "=", id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row) throw missing();
  return row;
}

function phaseMatchesState(
  state: CloudComputerDesired["state"],
  phase: CloudComputerReport["phase"],
) {
  if (phase === "failed" || phase === "provisioning")
    return state !== "deleted" || phase === "failed";
  if (state === "deleted") return phase === "deleted" || phase === "deleting";
  if (state === "suspended") return phase === "suspended";
  return phase === "booting" || phase === "ready";
}

function desiredState(
  row: Pick<Computer, "state" | "ownerSuspended" | "operatorSuspension">,
  billing: BillingStatus,
): Computer["state"] {
  if (row.state === "deleted") return "deleted";
  return row.ownerSuspended || row.operatorSuspension || billing !== "active"
    ? "suspended"
    : "active";
}

function transition(
  row: Computer,
  next: Computer["state"],
  now: Date,
): Updateable<CloudComputerTable> {
  if (row.state === next) return {};
  return {
    state: next,
    phase: next === "deleted" ? "deleting" : "provisioning",
    lastError: null,
    ...(next === "active"
      ? {
          readinessStartedAt: new Date(
            Math.max(now.getTime(), row.readinessStartedAt.getTime() + 1),
          ),
        }
      : {}),
  };
}

function preparationSteps(row: Computer): CloudComputerPreparationStep[] {
  const machineSeen = row.providerServerId !== null || row.phase === "ready";
  const opensteerReady = row.phase === "ready";
  return [
    { id: "payment", state: "done" },
    { id: "machine", state: machineSeen ? "done" : "current" },
    { id: "opensteer", state: opensteerReady ? "done" : machineSeen ? "current" : "pending" },
    {
      id: "claim",
      state: row.bootstrapReceiptAt ? "done" : opensteerReady ? "current" : "pending",
    },
  ];
}

function view(
  row: Computer,
  assigned: { publicAddress: string | null } | undefined,
  config: CloudComputerConfig,
  now: Date,
): CloudComputerView {
  const egress = assigned ? "assigned" : row.egressUnavailable ? "unavailable" : "pending";
  const region = cloudComputerRegion(row.region, config);
  const base = {
    id: row.id,
    egress,
    ...(row.deploymentId && row.hostKeyFingerprint
      ? { deploymentId: DeploymentIdSchema.parse(row.deploymentId) }
      : {}),
    ...(region ? { region } : {}),
    ...(assigned?.publicAddress ? { egressAddress: assigned.publicAddress } : {}),
    ...(row.state !== "deleted" && !row.deletionRequestedAt && row.renewsAt && row.renewsAt > now
      ? { renewsAt: row.renewsAt.toISOString() }
      : {}),
  } as const;
  if (row.state === "deleted") return { ...base, status: "deleted" };
  if (row.deletionRequestedAt)
    return {
      ...base,
      status: "needs_attention",
      reason: "Deletion is waiting for Stripe cancellation.",
      reasonCode: "cloud-computer-deletion-pending",
    };
  if (row.state === "suspended") {
    if (row.operatorSuspension)
      return {
        ...base,
        status: "suspended",
        reason: row.operatorSuspension,
        reasonCode: "cloud-computer-operator-suspended",
      };
    if (row.ownerSuspended)
      return {
        ...base,
        status: "suspended",
        reason: "You paused this Cloud Computer.",
        reasonCode: "cloud-computer-owner-suspended",
      };
    if (row.workAssignmentId && row.billingStatus === "active")
      return {
        ...base,
        status: "suspended",
        reason: "Your organization paused this Cloud Computer.",
        reasonCode: "cloud-computer-work-managed",
      };
    return {
      ...base,
      status: "suspended",
      reason:
        row.billingStatus === "canceled"
          ? "Your subscription ended."
          : "Your subscription needs attention.",
      reasonCode: "cloud-computer-billing-problem",
    };
  }
  // Ready means claimed for its Account.
  if (row.phase === "ready" && row.bootstrapReceiptAt)
    return { ...base, status: "ready", address: `https://${row.hostname}` };
  if (row.claimError)
    return {
      ...base,
      status: "needs_attention",
      reason: row.claimError,
      reasonCode: "cloud-computer-claim-failed",
    };
  if (row.bootstrapExpiresAt && row.bootstrapExpiresAt <= now) {
    return {
      ...base,
      status: "needs_attention",
      reason: "The Cloud Computer’s boot credential expired.",
      reasonCode: "cloud-computer-bootstrap-expired",
    };
  }
  if (row.phase === "failed")
    return {
      ...base,
      status: "needs_attention",
      reason: row.lastError ?? "The Cloud Computer could not start.",
      reasonCode: "cloud-computer-provisioning-failed",
    };
  return { ...base, status: "preparing", steps: preparationSteps(row) };
}

function missing() {
  return new ControlPlaneError("not_found", "Cloud Computer was not found", {
    reason: "cloud-computer-not-found",
  });
}

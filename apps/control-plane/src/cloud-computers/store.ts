import { cancelAndRefundCheckout } from "./checkout-compensation.js";
import {
  CloudComputerCancelledLate,
  CloudComputerDeletionUnsettled,
  type CloudComputerDeletionStep,
} from "./billing-error.js";
import { freeBackupTargets } from "./backup-capacity.js";
import { cloudComputerSetupFailure } from "../server/events.js";
import {
  problemTable,
  type CloudComputerSetupFailure,
  type HomeHealthReport,
  type ProblemCode,
} from "@opensteer/protocol/problems";
import { deletionView } from "./deletion-view.js";
import { SecretManagerBackupKeyVault, type BackupKeyVault } from "./backup-vault.js";
import { purgeBackupObjects, type BackupPurgeStep } from "./backup-purge.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  hostOidcCallbackPath,
  cloudComputerSetupIssue,
  cloudWords,
  type ManagedHomeClaimReceipt,
  CloudComputerBootReleaseSchema,
  CloudComputerBootResponseSchema,
  CloudComputerDesiredSchema,
  CloudComputerManagedHomeSchema,
  CloudComputerEgressAddressSchema,
  type CloudComputerPreparationStep,
  CloudComputerIdSchema,
  CloudComputerSnapshotSchema,
  type BrowserPoolHostBootCompleteRequest,
  type BrowserPoolHostBootRequest,
  type BrowserPoolHostCheck,
  type BrowserPoolHostId,
  type BrowserPoolHostReplaceUnreadyRequest,
  type BrowserPoolHostReport,
  type BrowserPoolSlotBumpTermRequest,
  type BrowserPoolSlotCheck,
  type BrowserPoolSlotId,
  type BrowserPoolSlotReport,
  type CloudComputerBackupReport,
  type CloudComputerBootCompleteRequest,
  type CloudComputerCheck,
  type CloudComputerBootRequest,
  type CloudComputerBootResponse,
  type CloudComputerDesired,
  type CloudComputerId,
  type CloudComputerReport,
  type CloudComputerView,
  type ManagedBrowserPoolRegistrationRequest,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { BrowserPoolStore } from "./pool-store.js";
import {
  egressEndpointInvalidReason,
  normalizeEgressEndpoint,
  validateEgressCredential,
  validateEgressUpstreamUrl,
} from "./egress-validation.js";
import { digestSecret, equalSecretDigests } from "@opensteer/shared/secretDigest";
import { z } from "zod";
import { DeploymentIdSchema, HostKeyFingerprintSchema, type DeploymentId } from "@opensteer/core";
import type { HostDiscoveryEnvelope } from "@opensteer/deployment-authority";
import {
  sql,
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  type Transaction,
  type Updateable,
} from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import type { CloudComputerSecretCipher } from "./secret-cipher.js";
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
import type {
  BillingStatus,
  CloudComputerEgressEndpointTable,
  CloudComputerTable,
} from "./tables.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;
type Computer = Selectable<CloudComputerTable>;
type Mutation =
  | "suspend"
  | "resume"
  | "delete"
  | "operator-suspend"
  | "operator-unsuspend"
  | "reissue"
  | "replace";
const bootstrapLifetimeMs = 20 * 60_000;
const checkoutLifetimeMs = 2 * 60 * 60_000;
const checkoutCreationWindowMs = 31 * 60_000;
const paidFulfillmentDeadlineMs = 15 * 60_000;
/** A deleted Cloud Computer still unsettled with Stripe this long after its request is reported. */
const unsettledDeletionMs = 60 * 60_000;
const emptyDigest = "0".repeat(64);
const claimLeaseMs = 2 * 60_000;
const providerWriteGraceMs = 3 * 60_000;
const dispatchedWriteGraceMs = 15 * 60_000;
/** A ready Cloud Computer with no backup reported for this long is overdue (it backs up daily). */
const backupOverdueMs = 36 * 60 * 60_000;
/** A pool with fewer free entries than this is about to stop checkout or browsing. */
const lowPoolEntries = 2;
/** How long a computer that was ready before must be down now before it counts as an outage. */
const minimumOutageMs = 2 * 60_000;
/** A ready Cloud Computer reports every 15 minutes; an hour without one is missing. */
const reportMissingMs = 60 * 60_000;

/** One thing the watch found wrong; each is logged as its own stable event. */
export type CloudComputerFinding =
  | {
      readonly event: "account.cloud_computer.not_ready";
      readonly computerId: CloudComputerId;
      readonly phase: "provisioning" | "booting" | "claiming" | "failed";
      readonly minutes: number;
      readonly code?: CloudComputerSetupFailure;
    }
  | {
      readonly event: "account.cloud_computer.report_missing";
      readonly computerId: CloudComputerId;
      readonly minutes: number;
    }
  | {
      readonly event: "account.cloud_computer.backup_overdue";
      readonly computerId: CloudComputerId;
      readonly minutes: number;
    }
  | {
      readonly event: "account.pool.low";
      readonly pool: "backup" | "egress";
      readonly free: number;
    };

/** One ready Home the Account is about to claim, as it was when the attempt began. */
export interface CloudComputerClaimJob {
  readonly id: CloudComputerId;
  readonly generation: number;
  readonly accountId: ControlPlaneAccountId;
  readonly hostname: string;
  readonly deploymentId: string;
  readonly hostKeyFingerprint: string;
  readonly attempt: number;
  /** The desired-state revision the attempt was leased at; any change supersedes it. */
  readonly revision: number;
  readonly readinessStartedAt: Date;
}

/** Raised when the row moved on (deleted, reissued, claimed) while an attempt ran. */
export class CloudComputerClaimSupersededError extends Error {}

interface StoreOptions {
  readonly config: CloudComputerConfig;
  readonly accountOrigin: URL;
  readonly cipher: CloudComputerSecretCipher;
  readonly stripe: StripeBilling;
  readonly now?: () => Date;
  readonly backupKeyVault?: BackupKeyVault;
  readonly purgeBackupStep?: BackupPurgeStep;
  readonly onBillingAttention?: (message: string) => void;
  /** Where Stripe's checkout and billing pages send the person back. */
  readonly returnUrl?: URL;
}

export class CloudComputerStore {
  readonly #db: Database;
  readonly #options: StoreOptions;
  readonly #now: () => Date;
  readonly #pool: BrowserPoolStore;
  #offerValid = false;

  constructor(database: Database, options: StoreOptions) {
    this.#db = database;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#pool = new BrowserPoolStore({
      db: database,
      config: options.config,
      cipher: options.cipher,
      now: this.#now,
      assignEgress: (tx, computerId) => this.#assignEgress(tx, computerId),
      egressCredentials: (endpoint) => this.#egressCredentials(endpoint),
    });
  }

  get plan() {
    return { ...this.#options.config.plan, interval: this.#options.config.interval };
  }

  /** The plan a checkout would sell now, or null while Stripe hasn't confirmed the offer. */
  get offer() {
    return this.#offerValid ? this.plan : null;
  }

  pendingReplacementOwnerAccess(clientId: string) {
    return this.#db
      .selectFrom("cloudComputers")
      .select(["id", "generation", "accountId"])
      .where("oidcClientId", "=", clientId)
      .where("state", "=", "active")
      .where("phase", "=", "ready")
      .where("restoreSnapshot", "is not", null)
      .where("bootCompletedAt", "is not", null)
      .where("bootstrapReceiptAt", "is not", null)
      .where("deletionRequestedAt", "is", null)
      .where("ownerAccessAt", "is", null)
      .executeTakeFirst();
  }

  async recordReplacementOwnerAccess(
    clientId: string,
    target: Pick<Computer, "id" | "generation" | "accountId">,
  ) {
    if (!target.accountId) return;
    await this.#db
      .updateTable("cloudComputers")
      .where("id", "=", target.id)
      .where("generation", "=", target.generation)
      .where("oidcClientId", "=", clientId)
      .where("accountId", "=", target.accountId)
      .where("state", "=", "active")
      .where("phase", "=", "ready")
      .where("restoreSnapshot", "is not", null)
      .where("bootCompletedAt", "is not", null)
      .where("bootstrapReceiptAt", "is not", null)
      .where("deletionRequestedAt", "is", null)
      .where("ownerAccessAt", "is", null)
      .set({ ownerAccessAt: this.#now() })
      .executeTakeFirst();
  }

  #vault(project = this.#options.config.backupKeyProject): BackupKeyVault {
    if (this.#options.backupKeyVault) return this.#options.backupKeyVault;
    if (!project)
      throw new ControlPlaneError(
        "unavailable",
        "Cloud Computer backup key storage is unavailable",
      );
    return new SecretManagerBackupKeyVault(project);
  }

  async checkOffer(): Promise<void> {
    this.#vault();
    try {
      await this.#options.stripe.validateOffer(this.#options.config.stripePriceId, this.plan);
      await this.#options.stripe.validatePortal(this.#options.config.stripePortalConfigurationId);
      this.#offerValid = true;
    } catch (error) {
      this.#offerValid = false;
      throw error;
    }
  }

  async checkoutCompleted(accountId: ControlPlaneAccountId, requestId: string): Promise<boolean> {
    const completed = await this.#db
      .selectFrom("cloudComputerCheckouts")
      .select("requestId")
      .where("accountId", "=", accountId)
      .where("requestId", "=", requestId)
      .where("status", "=", "completed")
      .executeTakeFirst();
    return Boolean(completed);
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
      await this.#recoverCheckout(accountId, previous.requestId);
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
      const existing = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("tombstonedAt", "is", null)
        .executeTakeFirst();
      if (replay?.status === "completed" && replay.url && !existing?.deletionRequestedAt)
        return { url: replay.url };
      if (replay?.status === "completed" || replay?.status === "refunded" || replay?.paidAt)
        throw new ControlPlaneError("conflict", "This checkout is complete", {
          reason: "cloud-computer-checkout-complete",
        });
      if (replay?.url && !existing?.deletionRequestedAt) return { url: replay.url };
      const expiresAt = replay?.expiresAt ?? new Date(now.getTime() + checkoutLifetimeMs);
      if (expiresAt.getTime() - now.getTime() < checkoutCreationWindowMs)
        throw new ControlPlaneError("conflict", "Checkout is awaiting confirmation from Stripe", {
          reason: "cloud-computer-checkout-in-progress",
        });
      if (existing && (existing.billingStatus !== "canceled" || existing.deletionRequestedAt))
        throw new ControlPlaneError("conflict", "You already have a Cloud Computer subscription.", {
          reason: "cloud-computer-already-exists",
        });
      if (!replay) {
        const open = await attempts.where("status", "=", "open").executeTakeFirst();
        if (open)
          throw new ControlPlaneError("conflict", "You already have a checkout in progress.", {
            reason: "cloud-computer-checkout-in-progress",
          });
        if (!existing) {
          const target = await tx
            .selectFrom("cloudComputerBackupTargets")
            .select("id")
            .where("computerId", "is", null)
            .where("checkoutKey", "is", null)
            .where("needsRotation", "=", false)
            .orderBy("id")
            .forNoKeyUpdate()
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
            expiresAt,
            returnUrl: this.#options.returnUrl?.toString() ?? null,
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
      return {
        priceId: replay?.stripePriceId ?? this.#options.config.stripePriceId,
        expiresAt,
        returnUrl: replay ? replay.returnUrl : (this.#options.returnUrl?.toString() ?? null),
      };
    });
    if ("url" in outcome) return { url: outcome.url! };

    // The reservation commits before Stripe, so a lost response is discoverable even after a crash.
    const session = await this.#options.stripe.checkout({
      accountId,
      requestId,
      priceId: outcome.priceId,
      expiresAt: outcome.expiresAt,
      ...(outcome.returnUrl ? { returnUrl: new URL(outcome.returnUrl) } : {}),
    });
    const result = await this.#db
      .updateTable("cloudComputerCheckouts")
      .where("accountId", "=", accountId)
      .where("requestId", "=", requestId)
      .where("status", "=", "open")
      .where("paidAt", "is", null)
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

  #billingAttention(message: string) {
    (this.#options.onBillingAttention ?? console.error)(message);
  }

  async #recoverCheckout(accountId: ControlPlaneAccountId, requestId: string) {
    const recovered = await this.#db.transaction().execute(async (tx) => {
      const owner = await tx
        .selectFrom("users")
        .select("deletionFencedUntil")
        .where("id", "=", accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const row = await tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId)
        .where("status", "=", "open")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) return;
      const deleting = await tx
        .selectFrom("cloudComputers")
        .select("id")
        .where("accountId", "=", accountId)
        .where("deletionRequestedAt", "is not", null)
        .where("tombstonedAt", "is", null)
        .executeTakeFirst();
      const close = !owner || Boolean(deleting);
      let session = await this.#options.stripe.findCheckout({
        accountId,
        requestId,
        sessionId: row.stripeSessionId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
      const write = tx
        .updateTable("cloudComputerCheckouts")
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId);
      if (
        !session &&
        !row.stripeSessionId &&
        !row.paidAt &&
        row.expiresAt.getTime() - this.#now().getTime() >= checkoutCreationWindowMs &&
        (close ||
          this.#now().getTime() - (row.lastStripeAttemptAt ?? row.createdAt).getTime() >= 60_000)
      ) {
        const created = await this.#options.stripe.checkout({
          accountId,
          requestId,
          priceId: row.stripePriceId,
          expiresAt: row.expiresAt,
          ...(row.returnUrl ? { returnUrl: new URL(row.returnUrl) } : {}),
        });
        session = { ...created, status: "open", payment: undefined };
      }
      if (!session) {
        if (row.expiresAt <= this.#now())
          this.#billingAttention(
            "Stripe Checkout is unresolved after its expiry. Its capacity reservation is held.",
          );
        return;
      }
      if (close && session.status === "open")
        session = await this.#options.stripe.expireCheckout(session.id);
      if (session.status === "complete" && !session.payment && !row.paidAt) {
        if (!session.subscription)
          throw new ControlPlaneError(
            "unavailable",
            "Unpaid Stripe Checkout has no subscription to cancel",
          );
        const subscription = await this.#options.stripe.subscription(session.subscription);
        if (subscription.id !== session.subscription)
          throw new ControlPlaneError("unavailable", "Stripe returned another subscription");
        if (billingStatus(subscription) !== "canceled")
          await this.#options.stripe.cancel(session.subscription);
        const confirmed = await this.#options.stripe.findCheckout({
          accountId,
          requestId,
          sessionId: session.id,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        });
        if (!confirmed || confirmed.status !== "complete")
          throw new ControlPlaneError("unavailable", "Stripe did not confirm the unpaid Checkout");
        session = confirmed;
      }
      if (session.payment) {
        await write
          .set({ stripeSessionId: session.id, paidAt: row.paidAt ?? this.#now() })
          .executeTakeFirst();
        return session.payment;
      }
      if (session.status === "expired" || (session.status === "complete" && !row.paidAt)) {
        await write
          .set({ status: "expired", stripeSessionId: session.id, url: null })
          .executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
      } else {
        await write
          .set({ stripeSessionId: session.id, url: close || row.paidAt ? null : session.url })
          .executeTakeFirst();
      }
      return undefined;
    });
    if (recovered)
      await this.applyStripeEvent({
        id: `reconcile_${recovered.id}`,
        type: "checkout.session.completed",
        operation: "completed",
        checkout: recovered,
      });
  }

  async billingPortal(accountId: ControlPlaneAccountId) {
    const billing = await this.#db
      .selectFrom("cloudComputers")
      .select("stripeCustomerId")
      .where("accountId", "=", accountId)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    if (!billing) throw missing();
    const { config, returnUrl, stripe } = this.#options;
    await stripe.validatePortal(config.stripePortalConfigurationId);
    return stripe.portal(billing.stripeCustomerId, returnUrl, config.stripePortalConfigurationId);
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
        if (paid) await this.#cancelAndRefund(paid, defer);
        return;
      }
      const owner = await tx
        .selectFrom("users")
        .select("deletionFencedUntil")
        .where("id", "=", accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const attempt = await tx
        .selectFrom("cloudComputerCheckouts")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!attempt || (attempt.stripeSessionId && attempt.stripeSessionId !== checkout.id)) {
        if (paid) {
          this.#billingAttention(
            "Paid Stripe Checkout could not be matched to its Account attempt.",
          );
          await this.#cancelAndRefund(paid, defer);
        }
        return;
      }
      if (attempt.status === "completed" || attempt.status === "refunded") return;
      const writeAttempt = tx
        .updateTable("cloudComputerCheckouts")
        .where("accountId", "=", accountId)
        .where("requestId", "=", requestId);
      if (event.operation === "expired") {
        if (attempt.paidAt) return;
        await writeAttempt
          .set({ status: "expired", stripeSessionId: checkout.id, url: null })
          .executeTakeFirst();
        await releaseCheckoutTarget(tx, accountId, requestId);
        return;
      }
      const payment = event.checkout;
      const paidAt = attempt.paidAt ?? this.#now();
      await writeAttempt.set({ paidAt, stripeSessionId: checkout.id }).executeTakeFirst();
      const refund = async () => {
        if (await this.#cancelAndRefund(payment, defer)) {
          await writeAttempt.set({ status: "refunded", url: null }).executeTakeFirst();
          await releaseCheckoutTarget(tx, accountId, requestId);
        }
      };
      if (!owner || attempt.status === "expired") {
        await refund();
        return;
      }
      const expired = this.#now().getTime() - paidAt.getTime() >= paidFulfillmentDeadlineMs;
      if (owner.deletionFencedUntil && owner.deletionFencedUntil > this.#now()) {
        if (expired) await refund();
        else await defer();
        return;
      }
      const subscription = await this.#options.stripe
        .subscription(payment.subscription)
        .catch(() => undefined);
      if (!subscription) {
        await defer();
        if (expired)
          this.#billingAttention(
            "Paid Cloud Computer fulfillment timed out. Stripe cancellation and refund are pending.",
          );
        return;
      }
      if (
        subscription.id !== payment.subscription ||
        subscription.customer !== payment.customer ||
        subscription.metadata["account_id"] !== accountId ||
        subscription.metadata["request_id"] !== requestId
      ) {
        this.#billingAttention("Paid Stripe Checkout did not match its subscription.");
        await defer();
        return;
      }
      if (
        !matchesPrice(subscription, attempt.stripePriceId, attempt.currency) ||
        payment.currency !== attempt.currency
      ) {
        await refund();
        return;
      }

      const existing = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("accountId", "=", accountId)
        .where("tombstonedAt", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (expired && existing?.stripeSubscriptionId !== payment.subscription) {
        await refund();
        return;
      }
      if (
        existing?.deletionRequestedAt ||
        (attempt.targetComputerId && existing?.id !== attempt.targetComputerId)
      ) {
        await refund();
        return;
      }
      if (existing) {
        if (existing.stripeSubscriptionId === payment.subscription) return;
        if (existing.billingStatus !== "canceled") {
          if (expired) await refund();
          else await defer();
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
        if (expired) await refund();
        else await defer();
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

  async #cancelAndRefund(
    payment: z.infer<typeof StripePaidCheckoutSchema>,
    defer: () => Promise<unknown>,
  ) {
    this.#billingAttention(
      "Paid Cloud Computer Checkout could not be fulfilled. Cancelling and refunding it.",
    );
    try {
      if (await cancelAndRefundCheckout(this.#options.stripe, payment)) return true;
    } catch {
      this.#billingAttention("Cloud Computer Checkout cancellation or refund is pending.");
    }
    await defer();
    return false;
  }

  async #createComputer(
    tx: TransactionDb,
    paid: {
      id: CloudComputerId;
      accountId: ControlPlaneAccountId;
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
        backupKeyProject: config.backupKeyProject ?? null,
        generation: 1,
        state: paid.billing === "active" ? "active" : "suspended",
        hostname: `${paid.id.replace("_", "-")}.${config.domain}`,
        region: config.region,
        serverType: config.serverType,
        release: JSON.stringify(config.release),
        setupCodeDigest: digestSecret(setupCode),
        sealedSetupCode: cipher.seal(paid.id, 1, setupCode),
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
        browserMode: config.browserPool ? "pool" : "local",
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
    if (config.browserPool) {
      await this.#pool.createSlotForComputer(tx, paid.id, now);
    }
  }

  /**
   * Brings a Cloud Computer's billing up to date with Stripe. A row whose deletion is requested
   * has its subscription cancelled whatever else is open: a checkout keeps its own path.
   */
  async #refreshSubscription(tx: TransactionDb, id: string) {
    const row = await tx
      .selectFrom("cloudComputers")
      .selectAll()
      .where("stripeSubscriptionId", "=", id)
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
          updatedAt: now,
        })
        .executeTakeFirst();
      if (row.browserMode === "pool") {
        await this.#pool.markComputerDeleted(tx, row.id, now);
      }
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

  async reconcileBilling(
    onError: (error: unknown) => void,
    watch?: {
      /** Each finding of the watch, logged as its stable event; see `watch`. */
      readonly onFinding: (finding: CloudComputerFinding) => void;
      readonly notReadyAfterMs: number;
    },
  ) {
    const run = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        onError(error);
      }
    };
    return this.#db.connection().execute(async (connection) => {
      const acquired = await sql<{ locked: boolean }>`select pg_try_advisory_lock(
        hashtextextended('cloud-computer-billing-reconcile',0)) as locked`.execute(connection);
      if (!acquired.rows[0]?.locked) return false;
      try {
        await run(() => this.checkOffer());
        await this.#billingPass(run, onError);
        // Under the same lock, so one replica reports each finding once a pass.
        if (watch)
          await run(async () => {
            for (const finding of await this.watch(watch.notReadyAfterMs)) watch.onFinding(finding);
          });
        return true;
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended('cloud-computer-billing-reconcile',0))`.execute(
          connection,
        );
      }
    });
  }

  /**
   * What is wrong for paying people now, read from the rows the account already keeps: a
   * person who paid and has no working Cloud Computer (its setup failed, its claim failed, or
   * it is not claimed `notReadyAfterMs` after its readiness began), a ready computer that has
   * reported no backup for 36 hours, and a pool with fewer than two free entries.
   */
  async watch(notReadyAfterMs: number): Promise<CloudComputerFinding[]> {
    const now = this.#now().getTime();
    const findings: CloudComputerFinding[] = [];
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .leftJoin("cloudComputerHealth", "cloudComputerHealth.computerId", "cloudComputers.id")
      .select([
        "id",
        "phase",
        "lastError",
        "claimError",
        "readinessStartedAt",
        "bootstrapReceiptAt",
        "bootCompletedAt",
        "lastBackupAt",
        "readyAt",
        "downAt",
        "cloudComputerHealth.receivedAt as healthReceivedAt",
      ])
      .where("state", "=", "active")
      .where("billingStatus", "=", "active")
      .where("accountId", "is not", null)
      .where("deletionRequestedAt", "is", null)
      .where("tombstonedAt", "is", null)
      .orderBy("id")
      .execute();
    const minutesSince = (at: Date) => Math.max(0, Math.floor((now - at.getTime()) / 60_000));
    for (const row of rows) {
      const claim = operatorClaimError(row.claimError);
      const code = cloudComputerSetupFailure(row.lastError, claim);
      const claimed = row.bootstrapReceiptAt !== null;
      // Working means ready and claimed for its buyer. Anything else past the limit, claimed
      // before or not (after a Resume, a reboot, a VM that never came back), is a person who
      // pays and has no working computer: readiness restarts its clock on each of those.
      const working = row.phase === "ready" && claimed;
      // A computer that has been ready before and is down now pages only once this outage itself
      // has lasted a while too: one restart (an update, a provider write not confirmed on one
      // pass) inside a clock kept from earlier is not a person with no working computer (U1).
      // An outage no report announced (a Resume, a replacement, a reissue) began with its clock.
      const outageBegan = row.downAt ?? row.readinessStartedAt;
      const outageLasted =
        row.phase === "ready" ||
        row.readyAt === null ||
        now - outageBegan.getTime() >= minimumOutageMs;
      if (
        row.phase === "failed" ||
        claim !== null ||
        (!working && outageLasted && now - row.readinessStartedAt.getTime() >= notReadyAfterMs)
      ) {
        findings.push({
          event: "account.cloud_computer.not_ready",
          computerId: row.id,
          phase:
            row.phase === "failed" || claim
              ? "failed"
              : row.phase === "ready"
                ? "claiming"
                : row.phase === "booting"
                  ? "booting"
                  : "provisioning",
          minutes: minutesSince(row.readinessStartedAt),
          ...(code ? { code } : {}),
        });
        continue;
      }
      const reported = row.healthReceivedAt ?? row.bootstrapReceiptAt;
      if (row.phase === "ready" && reported && now - reported.getTime() >= reportMissingMs)
        findings.push({
          event: "account.cloud_computer.report_missing",
          computerId: row.id,
          minutes: minutesSince(reported),
        });
      const backedUp = row.lastBackupAt ?? row.bootCompletedAt;
      if (
        row.phase === "ready" &&
        claimed &&
        backedUp &&
        now - backedUp.getTime() >= backupOverdueMs
      )
        findings.push({
          event: "account.cloud_computer.backup_overdue",
          computerId: row.id,
          minutes: minutesSince(backedUp),
        });
    }
    const [backup, egress] = await Promise.all([
      freeBackupTargets(this.#db)
        .select((eb) => eb.fn.countAll<string>().as("free"))
        .executeTakeFirstOrThrow(),
      this.#db
        .selectFrom("cloudComputerEgressEndpoints")
        .select((eb) => eb.fn.countAll<string>().as("free"))
        .where("computerId", "is", null)
        .where("needsRotation", "=", false)
        .where("retired", "=", false)
        .executeTakeFirstOrThrow(),
    ]);
    for (const [pool, { free }] of [
      ["backup", backup],
      ["egress", egress],
    ] as const)
      if (Number(free) < lowPoolEntries)
        findings.push({ event: "account.pool.low", pool, free: Number(free) });
    return findings;
  }

  async #billingPass(
    run: (action: () => Promise<unknown>) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    const checkouts = await this.#db
      .selectFrom("cloudComputerCheckouts")
      .select(["accountId", "requestId"])
      .where("status", "=", "open")
      .execute();
    for (const attempt of checkouts)
      await run(() => this.#recoverCheckout(attempt.accountId, attempt.requestId));
    const deferred = await this.#deferredCheckouts();
    for (const event of deferred)
      await run(async () => {
        await this.applyStripeEvent({
          id: event.id,
          type: event.type,
          operation: "completed",
          checkout: StripePaidCheckoutSchema.parse(JSON.parse(event.checkoutJson)),
        });
      });
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .select("stripeSubscriptionId")
      .where("tombstonedAt", "is", null)
      .where("state", "!=", "deleted")
      .where("deletionRequestedAt", "is", null)
      .execute();
    for (const row of rows)
      await run(() =>
        this.#db
          .transaction()
          .execute((tx) => this.#refreshSubscription(tx, row.stripeSubscriptionId)),
      );
    // Deleted, not yet settled with Stripe.
    const deleted = await this.#db
      .selectFrom("cloudComputers")
      .select("id")
      .where("deletionRequestedAt", "is not", null)
      .where("billingSettledAt", "is", null)
      .orderBy("id")
      .execute();
    for (const row of deleted)
      await run(() => this.#settleDeletion(CloudComputerIdSchema.parse(row.id), onError));
  }

  /**
   * Settles with Stripe a Cloud Computer whose deletion was requested, however it was asked
   * (deleting it, or deleting the Account): its subscription cancelled, then the Stripe customer
   * it belongs to deleted with its saved payment details unless another subscription there is
   * not cancelled. A fixed few Stripe calls, retried each pass. A cancellation confirmed later
   * than the first attempt is reported with how long it took, so a person can look for a renewal
   * charged in that time; a row unsettled an hour after its request is reported with the step.
   */
  async #settleDeletion(id: CloudComputerId, onError: (error: unknown) => void) {
    const read = () =>
      this.#db
        .selectFrom("cloudComputers")
        .select([
          "state",
          "deletionRequestedAt",
          "deletedAt",
          "billingSettledAt",
          "cancelFailedAt",
          "stripeSubscriptionId",
        ])
        .where("id", "=", id)
        .executeTakeFirst();
    const row = await read();
    if (!row?.deletionRequestedAt || row.billingSettledAt) return;
    const since = row.deletionRequestedAt;
    let step: CloudComputerDeletionStep = "cancel";
    let failure: unknown;
    try {
      if (row.state !== "deleted") {
        await this.#db
          .transaction()
          .execute((tx) => this.#refreshSubscription(tx, row.stripeSubscriptionId))
          .catch(async (error: unknown) => {
            await this.#cancelFailed(id);
            throw error;
          });
        if ((await read())?.state !== "deleted")
          throw new ControlPlaneError("unavailable", "The subscription is not cancelled yet");
      }
      const { stripe } = this.#options;
      const subscription = await stripe.subscription(row.stripeSubscriptionId);
      if (subscription.id !== row.stripeSubscriptionId)
        throw new ControlPlaneError("unavailable", "Stripe returned another subscription");
      if (billingStatus(subscription) !== "canceled") await stripe.cancel(subscription.id);
      step = "customer";
      await stripe.deleteIdleCustomer(subscription.customer);
      step = "record";
      const settled = await this.#db
        .updateTable("cloudComputers")
        .where("id", "=", id)
        .where("billingSettledAt", "is", null)
        .set({ billingSettledAt: this.#now() })
        .returning(["deletedAt", "cancelFailedAt"])
        .executeTakeFirst();
      // Not cancelled at the first attempt: a renewal may have been charged meanwhile.
      if (settled?.cancelFailedAt)
        onError(
          new CloudComputerCancelledLate(
            id,
            (settled.deletedAt ?? this.#now()).getTime() - since.getTime(),
          ),
        );
      return;
    } catch (error) {
      failure = error;
    }
    if (this.#now().getTime() - since.getTime() >= unsettledDeletionMs)
      onError(new CloudComputerDeletionUnsettled(id, step, { cause: failure }));
    else throw failure;
  }

  /** Remembers that cancelling a deleted Cloud Computer's subscription failed at least once. */
  async #cancelFailed(id: CloudComputerId) {
    await this.#db
      .updateTable("cloudComputers")
      .where("id", "=", id)
      .where("cancelFailedAt", "is", null)
      .where("deletionRequestedAt", "is not", null)
      .set({ cancelFailedAt: this.#now() })
      .executeTakeFirst()
      .catch(() => undefined);
  }

  #deferredCheckouts() {
    // Read Stripe's stored JSON as text to preserve its snake-case wire keys.
    return this.#db
      .selectFrom("cloudComputerStripeEvents")
      .select(["id", "type", "receivedAt", sql<string>`deferred_checkout::text`.as("checkoutJson")])
      .where("deferredCheckout", "is not", null)
      .orderBy("receivedAt")
      .execute();
  }

  async unresolvedCheckouts() {
    const [paidAttempts, events] = await Promise.all([
      this.#db
        .selectFrom("cloudComputerCheckouts")
        .select(["accountId", "requestId", "stripeSessionId", "paidAt", "targetComputerId"])
        .where("status", "=", "open")
        .where("paidAt", "is not", null)
        .orderBy("paidAt")
        .execute(),
      this.#deferredCheckouts(),
    ]);
    return {
      paidAttempts,
      deferredEvents: events.map(({ id, receivedAt, checkoutJson }) => {
        const parsed = StripePaidCheckoutSchema.safeParse(JSON.parse(checkoutJson));
        if (!parsed.success) return { eventId: id, receivedAt, invalidPayment: true };
        const { id: sessionId, subscription, metadata } = parsed.data;
        return {
          eventId: id,
          receivedAt,
          stripeSessionId: sessionId,
          stripeSubscriptionId: subscription,
          accountId: metadata.account_id,
          requestId: metadata.request_id,
        };
      }),
    };
  }

  async provisionerLease() {
    const result = await sql<{ holder: string; expiresAt: Date }>`
      select holder, expires_at as "expiresAt" from cloud_computer_provisioner_lease where singleton
    `.execute(this.#db);
    const lease = result.rows[0];
    return lease ? { ...lease, expired: lease.expiresAt <= this.#now() } : null;
  }

  async releaseProvisionerLease(holder: string) {
    const result = await sql`
      delete from cloud_computer_provisioner_lease
      where singleton and holder = ${holder}::uuid and expires_at <= ${this.#now()}
      returning holder
    `.execute(this.#db);
    if (result.rows.length !== 1)
      throw new ControlPlaneError("conflict", "The holder does not have an expired lease");
  }

  async lease(holder: string, acquire: boolean, poolConfigured?: boolean): Promise<boolean> {
    const now = this.#now();
    const expires = new Date(now.getTime() + 10 * 60_000);
    const poolFlag = poolConfigured ?? null;
    const result = acquire
      ? await sql`
          insert into cloud_computer_provisioner_lease (singleton, holder, expires_at, pool_configured)
          values (true, ${holder}::uuid, ${expires}, ${poolFlag})
          on conflict (singleton) do update set
            holder = excluded.holder,
            expires_at = excluded.expires_at,
            pool_configured = case
              when ${poolFlag}::boolean is not null then ${poolFlag}::boolean
              when cloud_computer_provisioner_lease.holder = excluded.holder then cloud_computer_provisioner_lease.pool_configured
              else null
            end
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
      if (check.operation === "finish-provider-write") {
        if (!row || row.tombstonedAt) return false;
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify(
              row.pendingProviderWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirst();
        return true;
      }
      if (
        !row ||
        row.revision !== check.revision ||
        row.tombstonedAt !== null ||
        (row.deletionRequestedAt && row.state === "active")
      )
        return false;
      if (
        check.operation === "recover-provider-write" ||
        check.operation === "send-provider-write"
      ) {
        const write = row.pendingProviderWrites.find(({ token }) => token === check.token);
        if (!write) return check.operation === "recover-provider-write";
        const expired =
          !!write.recoverAfter && Date.parse(write.recoverAfter) <= this.#now().getTime();
        if (check.operation === "send-provider-write") {
          if (row.state !== "active" || expired) return false;
          if (!write.dispatched) {
            await tx
              .updateTable("cloudComputers")
              .where("id", "=", id)
              .set({
                pendingProviderWrites: JSON.stringify(
                  row.pendingProviderWrites.map((entry) =>
                    entry.token === write.token
                      ? {
                          ...entry,
                          dispatched: true,
                          recoverAfter: new Date(
                            this.#now().getTime() + dispatchedWriteGraceMs,
                          ).toISOString(),
                        }
                      : entry,
                  ),
                ),
              })
              .executeTakeFirstOrThrow();
          }
          return true;
        }
        if (!expired) return false;
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify(
              row.pendingProviderWrites.filter(({ token }) => token !== check.token),
            ),
          })
          .executeTakeFirstOrThrow();
        return true;
      }
      if (check.operation === "create") return needsVm(row) && Boolean(row.bootstrapDigest);
      if (check.operation === "begin-provider-write") {
        const { write } = check;
        if (
          row.state !== "active" ||
          write.generation !== row.generation ||
          row.pendingProviderWrites.some(({ kind }) => kind === write.kind) ||
          (write.kind === "create" && (!needsVm(row) || !row.bootstrapDigest)) ||
          (write.kind === "power-on" &&
            (write.serverRef
              ? write.serverRef !== row.providerServerRef
              : String(write.serverId) !== row.providerServerId))
        )
          return false;
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({
            pendingProviderWrites: JSON.stringify([
              ...row.pendingProviderWrites,
              {
                ...write,
                dispatched: false,
                recoverAfter: new Date(this.#now().getTime() + providerWriteGraceMs).toISOString(),
              },
            ]),
            ...(write.kind === "create" ? { createAttempted: true } : {}),
          })
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

  async desired(after?: CloudComputerId, limit = 100, provider?: "google") {
    let query = this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("tombstonedAt", "is", null)
      .orderBy("id")
      .limit(limit + 1);
    if (after) query = query.where("id", ">", after);
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const computers = await Promise.all(
      page.map(async (snapshot) => {
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
          ...(provider === "google"
            ? {
                providerServerRef: row.providerServerRef ?? undefined,
                previousProviderServerRef: row.previousProviderServerRef ?? undefined,
                bootstrapReceiptRecorded: row.bootstrapReceiptAt !== null,
              }
            : {}),
          ipv6Enabled: row.ipv6Enabled,
          restoreSnapshot: row.restoreSnapshot ?? undefined,
          bootCompleted: row.bootCompletedAt !== null,
          ...(row.dnsQuarantined ? { dnsQuarantined: true } : {}),
          replacementVerified:
            !row.restoreSnapshot ||
            Boolean(row.bootCompletedAt && row.bootstrapReceiptAt && row.ownerAccessAt),
          ...(row.pendingProviderWrites.length
            ? {
                pendingProviderWrites:
                  provider === "google"
                    ? row.pendingProviderWrites
                    : row.pendingProviderWrites.map((write) => {
                        const legacy = { ...write };
                        delete legacy.serverRef;
                        return legacy;
                      }),
              }
            : {}),
          state: row.state,
          hostname: row.hostname,
          region: row.region,
          serverType: provider === "google" && row.serverType === "default" ? null : row.serverType,
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
    return { computers, ...(rows.length > limit ? { next: page.at(-1)!.id } : {}) };
  }

  async report(report: CloudComputerReport) {
    const result = await this.#db.transaction().execute(async (tx) => {
      const forgotten =
        report.phase === "deleted" ? await lockHomeReferences(tx, report.id) : undefined;
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", report.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !row ||
        (forgotten && !sameHomeReferences(forgotten, row)) ||
        row.revision !== report.revision ||
        row.generation !== report.generation ||
        row.tombstonedAt !== null ||
        !phaseMatchesState(row.state, report.phase) ||
        ((report.phase === "deleted" || report.phase === "suspended") &&
          row.pendingProviderWrites.length !== 0) ||
        (report.phase === "ready" && (!row.bootCompletedAt || !report.observedIdentity))
      ) {
        return { recorded: false, kick: false, newlyFailed: false };
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
          phase: deleted ? "deleting" : report.phase,
          ipv4: report.ipv4,
          ipv6: report.ipv6,
          // Retain the last server observation through transient provider failures.
          providerServerId: deleted
            ? null
            : (report.providerServerId?.toString() ?? row.providerServerId),
          providerServerRef: deleted ? null : (report.providerServerRef ?? row.providerServerRef),
          lastError: report.lastError,
          reportedAt: now,
          updatedAt: now,
          ...(ready ? { everReady: true, generationReady: true, dnsQuarantined: false } : {}),
          ...(ready && row.phase !== "ready" ? { readyAt: now } : {}),
          // When the current outage began: kept while it stays down, cleared once it is ready.
          downAt: ready ? null : (row.downAt ?? now),
          ...(report.lastError ===
          "The Cloud Computer reported a different Home identity for this generation."
            ? { dnsQuarantined: true }
            : {}),
          ...(deleted ? clearBootToken : {}),
          ...(row.bootstrapDigest &&
          !row.bootstrapExpiresAt &&
          (report.providerServerId || report.providerServerRef)
            ? {
                bootstrapExpiresAt: new Date(now.getTime() + bootstrapLifetimeMs),
                readinessStartedAt: now,
              }
            : {}),
          // Down again after being ready: a fresh clock only when it had stayed ready for the
          // whole limit. One that keeps going down sooner keeps the clock of its first outage,
          // so it pages once that outage passes the limit even while it flaps (U2).
          ...((report.phase === "booting" || report.phase === "failed") &&
          row.phase === "ready" &&
          (!row.readyAt ||
            now.getTime() - row.readyAt.getTime() >=
              this.#options.config.notReadyAfterMinutes * 60_000)
            ? { readinessStartedAt: now }
            : {}),
          ...(deleted
            ? {
                vmDestroyedAt: row.vmDestroyedAt ?? now,
                deploymentId: null,
                hostKeyFingerprint: null,
              }
            : {}),
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
          .set({ computerId: null, purgeComputerId: row.id, needsRotation: true })
          .where("computerId", "=", row.id)
          .executeTakeFirst();
      }
      return {
        recorded: true,
        kick: ready && row.bootstrapReceiptAt === null,
        // Said once, as the setup turns failed; the watch keeps saying it while it stays so.
        newlyFailed: report.phase === "failed" && row.phase !== "failed",
      };
    });
    if (result.recorded && report.phase === "deleted") {
      await this.#eraseBackupKey(report.id).catch(() =>
        this.#billingAttention("Cloud Computer backup key destruction is pending."),
      );
    }
    return result;
  }

  async #eraseBackupKey(id: CloudComputerId) {
    await this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .select([
          "vmDestroyedAt",
          "backupsUnreadableAt",
          "backupKeyProject",
          "browserMode",
          "browserSlotErasedAt",
        ])
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row?.vmDestroyedAt || row.backupsUnreadableAt) return;
      await this.#vault(row.backupKeyProject ?? undefined).destroy(id);
      const now = this.#now();
      const settled = row.browserMode !== "pool" || row.browserSlotErasedAt !== null;
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", id)
        .set({
          backupKeyVersion: null,
          backupsUnreadableAt: now,
          updatedAt: now,
          ...(settled ? { phase: "deleted", tombstonedAt: now } : {}),
        })
        .executeTakeFirstOrThrow();
    });
  }

  async reconcileBackupErasure(onError: () => void) {
    const due = await this.#db
      .selectFrom("cloudComputers")
      .select("id")
      .where("vmDestroyedAt", "is not", null)
      .where("backupObjectsRemovedAt", "is", null)
      .orderBy(sql`backup_cleanup_attempted_at asc nulls first`)
      .orderBy("id")
      .limit(8)
      .execute();
    for (const { id } of due) {
      await this.#db
        .updateTable("cloudComputers")
        .where("id", "=", id)
        .set({ backupCleanupAttemptedAt: this.#now() })
        .executeTakeFirst();
      try {
        await this.#eraseBackupKey(id);
        await this.#purgeOneBackupPage(id);
      } catch {
        onError();
      }
    }
  }

  async #purgeOneBackupPage(id: CloudComputerId) {
    await this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .select("id")
        .where("id", "=", id)
        .where("backupsUnreadableAt", "is not", null)
        .where("backupObjectsRemovedAt", "is", null)
        .forNoKeyUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return;

      const target = await tx
        .selectFrom("cloudComputerBackupTargets")
        .selectAll()
        .where("purgeComputerId", "=", id)
        .orderBy("id")
        .limit(1)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (target) {
        const { endpoint, bucket, prefix, region } = target;
        const { cipher } = this.#options;
        const [accessKey, secret] = target.sealedCredentials.split(":");
        const purge = this.#options.purgeBackupStep ?? purgeBackupObjects;
        if (
          !(await purge({
            endpoint,
            bucket,
            prefix,
            region,
            accessKeyId: cipher.open(`backup-access:${target.id}`, 1, accessKey!),
            secretAccessKey: cipher.open(`backup-secret:${target.id}`, 1, secret!),
          }))
        )
          return;
        await tx
          .updateTable("cloudComputerBackupTargets")
          .where("id", "=", target.id)
          .set({ purgeComputerId: null, sealedCredentials: "" })
          .executeTakeFirstOrThrow();
      }
      const remaining = await tx
        .selectFrom("cloudComputerBackupTargets")
        .select("id")
        .where("purgeComputerId", "=", id)
        .executeTakeFirst();
      if (!remaining) {
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({ backupObjectsRemovedAt: this.#now() })
          .executeTakeFirstOrThrow();
      }
    });
  }

  async boot(
    id: CloudComputerId,
    input: CloudComputerBootRequest,
  ): Promise<CloudComputerBootResponse> {
    return this.#db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`cloud-computer-boot:${id}`},0))`.execute(
        tx,
      );
      // Locks in the declared order (owner, then OAuth client, then the Cloud
      // Computer), as Account deletion takes them: the client written below is
      // the owner's, and taking the computer first would wait on them reversed.
      const locked = await tx
        .selectFrom("cloudComputers")
        .select("accountId")
        .where("id", "=", id)
        .executeTakeFirst();
      if (locked?.accountId)
        await tx
          .selectFrom("users")
          .select("id")
          .where("id", "=", locked.accountId)
          .forKeyShare()
          .executeTakeFirst();
      await tx
        .selectFrom("oauthClients")
        .select("id")
        .where("clientId", "=", `occ_${id.slice("cc_".length)}`)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const snapshot = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!validBoot(snapshot, id, input, this.#now()) || !snapshot.setupCodeDigest)
        throw invalidBoot();
      const owner = snapshot.accountId;
      if (!owner || owner !== locked?.accountId) throw invalidBoot();
      const { managedHome, credentials } = await this.#prepareManagedHome(tx, snapshot, owner);
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !validBoot(row, id, input, this.#now()) ||
        !row.setupCodeDigest ||
        row.revision !== snapshot.revision ||
        row.oidcClientId !== snapshot.oidcClientId
      )
        throw invalidBoot();
      if (credentials) {
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set(credentials)
          .executeTakeFirstOrThrow();
      }
      const pooled = row.browserMode === "pool";
      const endpoint = pooled ? undefined : await this.#assignEgress(tx, id);
      const egress = endpoint ? this.#egressCredentials(endpoint) : undefined;
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
      const vault = this.#vault(row.backupKeyProject ?? undefined);
      const password = row.backupKeyVersion
        ? await vault.read(id, row.backupKeyVersion)
        : newSecret();
      if (!row.backupKeyVersion) {
        const backupKeyVersion = await vault.issue(id, password);
        await tx
          .updateTable("cloudComputers")
          .where("id", "=", id)
          .set({ backupKeyVersion })
          .executeTakeFirstOrThrow();
      }
      const { endpoint: backupEndpoint, bucket, prefix } = backup;
      return {
        managedHome,
        ipv6Enabled: row.ipv6Enabled,
        ...(row.restoreSnapshot ? { restoreSnapshot: row.restoreSnapshot } : {}),
        hostname: row.hostname,
        accountOrigin: this.#options.accountOrigin.origin,
        setupCodeDigest: row.setupCodeDigest,
        release: CloudComputerBootReleaseSchema.parse({
          version: row.release.version,
          images: row.release.images,
        }),
        ...(this.#options.config.releaseManifestUrl
          ? { releaseManifestUrl: this.#options.config.releaseManifestUrl }
          : {}),
        ...(pooled ? { browserPool: true } : {}),
        ...(egress ? { egress } : {}),
        backup: {
          endpoint: backupEndpoint,
          bucket,
          prefix,
          accessKeyId,
          secretAccessKey,
          repository: `s3:${backupEndpoint}/${bucket}/${prefix}`,
          password,
        },
      };
    });
  }

  #egressCredentials(endpoint: Selectable<CloudComputerEgressEndpointTable>) {
    const password = this.#options.cipher.open(`egress:${endpoint.id}`, 1, endpoint.sealedPassword);
    const normalized = normalizeEgressEndpoint({
      url: endpoint.url,
      username: endpoint.username,
      password,
    });
    return normalized.ok ? normalized.value : undefined;
  }

  async #assignEgress(tx: TransactionDb, id: CloudComputerId) {
    const endpoints = tx.selectFrom("cloudComputerEgressEndpoints").selectAll();
    const assigned = await endpoints.where("computerId", "=", id).executeTakeFirst();
    let endpoint: Selectable<CloudComputerEgressEndpointTable> | undefined;
    if (assigned) {
      // Y6: never serve an already-assigned row that fails the strict egress rule.
      endpoint = this.#egressCredentials(assigned) ? assigned : undefined;
    } else {
      // Y6: scan free rows in id order with skipLocked and skip any legacy invalid row without assigning it.
      let afterId: string | undefined;
      while (!endpoint) {
        let query = endpoints
          .where("computerId", "is", null)
          .where("needsRotation", "=", false)
          .orderBy("id")
          .forNoKeyUpdate()
          .skipLocked()
          .limit(1);
        if (afterId !== undefined) query = query.where("id", ">", afterId);
        const candidate = await query.executeTakeFirst();
        if (!candidate) break;
        afterId = candidate.id;
        if (this.#egressCredentials(candidate)) {
          await tx
            .updateTable("cloudComputerEgressEndpoints")
            .set({ computerId: id })
            .where("id", "=", candidate.id)
            .executeTakeFirst();
          endpoint = candidate;
        }
      }
    }
    await tx
      .updateTable("cloudComputers")
      .set({ egressUnavailable: !endpoint })
      .where("id", "=", id)
      .where("egressUnavailable", "!=", !endpoint)
      .executeTakeFirst();
    return endpoint;
  }

  async assignEgress(id: CloudComputerId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) throw missing();
      if (
        row.state !== "active" ||
        row.deletionRequestedAt ||
        !row.bootCompletedAt ||
        !row.accountId
      )
        throw new ControlPlaneError("conflict", "The Cloud Computer must be active and booted");
      const endpoint = await this.#assignEgress(tx, id);
      if (!endpoint)
        throw new ControlPlaneError("unavailable", "No browser egress endpoint is available");
      return { endpointId: endpoint.id, publicAddress: endpoint.publicAddress };
    });
  }

  async #requireBootedHome(
    tx: TransactionDb,
    id: CloudComputerId,
    authorization: string | undefined,
    lock: "share" | "update",
  ) {
    const basic = /^Basic ([A-Za-z0-9+/]{1,256}={0,2})$/iu.exec(authorization ?? "");
    const [clientId, clientSecret, extra] = basic
      ? Buffer.from(basic[1]!, "base64").toString("utf8").split(":")
      : [];
    const credentials =
      extra === undefined
        ? CloudComputerManagedHomeSchema.shape.oidc.safeParse({ clientId, clientSecret })
        : undefined;
    const unauthorized = () => new ControlPlaneError("unauthorized", "Invalid Home credentials");
    if (!credentials?.success) throw unauthorized();
    const query = tx.selectFrom("cloudComputers").selectAll().where("id", "=", id);
    const row = await (
      lock === "update" ? query.forNoKeyUpdate() : query.forShare()
    ).executeTakeFirst();
    const expected = row?.sealedOidcClientSecret
      ? digestSecret(
          this.#options.cipher.open(`oidc:${id}`, row.generation, row.sealedOidcClientSecret),
        )
      : emptyDigest;
    const valid = equalSecretDigests(digestSecret(credentials.data.clientSecret), expected);
    if (
      !valid ||
      !row?.bootCompletedAt ||
      row.deletionRequestedAt ||
      row.state !== "active" ||
      row.oidcClientId !== credentials.data.clientId ||
      !row.accountId
    )
      throw unauthorized();
    return row;
  }

  async egressForHome(id: CloudComputerId, authorization: string | undefined) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await this.#requireBootedHome(tx, id, authorization, "share");
      // T9: A pooled Cloud Computer's egress password is held only by its pool host.
      if (row.browserMode === "pool") return {};
      const endpoint = await tx
        .selectFrom("cloudComputerEgressEndpoints")
        .selectAll()
        .where("computerId", "=", id)
        .executeTakeFirst();
      const egress = endpoint ? this.#egressCredentials(endpoint) : undefined;
      return egress ? { egress } : {};
    });
  }

  async reportBackupForHome(
    id: CloudComputerId,
    authorization: string | undefined,
    report: CloudComputerBackupReport,
  ) {
    await this.#db.transaction().execute(async (tx) => {
      const row = await this.#requireBootedHome(tx, id, authorization, "update");
      const completedAt = new Date(report.completedAt);
      if (row.lastBackupAt && completedAt <= row.lastBackupAt) return;
      await tx
        .updateTable("cloudComputers")
        .set({ lastBackupAt: completedAt, lastBackupSnapshotId: report.snapshotId })
        .where("id", "=", id)
        .executeTakeFirst();
    });
  }

  /**
   * Keeps a Cloud Computer's latest health report, sent with the credentials its backup report
   * uses, in place of the one before. Returns the codes in it that need someone now.
   */
  async reportHealthForHome(
    id: CloudComputerId,
    authorization: string | undefined,
    report: HomeHealthReport,
  ): Promise<ProblemCode[]> {
    await this.#db.transaction().execute(async (tx) => {
      await this.#requireBootedHome(tx, id, authorization, "share");
      const receivedAt = this.#now();
      await tx
        .insertInto("cloudComputerHealth")
        .values({ computerId: id, receivedAt, report: JSON.stringify(report) })
        .onConflict((conflict) =>
          conflict.column("computerId").doUpdateSet({ receivedAt, report: JSON.stringify(report) }),
        )
        .execute();
    });
    return [
      ...new Set(
        report.problems
          .filter(({ code }) => problemTable[code].severity === "needs-you")
          .map(({ code }) => code),
      ),
    ];
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
  async #prepareManagedHome(tx: TransactionDb, row: Computer, owner: ControlPlaneAccountId) {
    const { cipher } = this.#options;
    let credentials:
      | Pick<Computer, "oidcClientId" | "sealedOidcClientSecret" | "sealedHostCredential">
      | undefined;
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
      credentials = {
        oidcClientId: clientId,
        sealedOidcClientSecret: cipher.seal(`oidc:${row.id}`, row.generation, secret),
        sealedHostCredential: cipher.seal(
          `host-credential:${row.id}`,
          row.generation,
          createHostCredential(),
        ),
      };
    }
    return {
      credentials,
      managedHome: {
        cloudComputerId: row.id,
        generation: row.generation,
        oidc: { clientId, clientSecret: secret },
      },
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
        .where("deletionRequestedAt", "is", null)
        .where("deploymentId", "is not", null)
        .where("accountId", "is not", null)
        .where((eb) => eb.or([eb("claimNextAt", "is", null), eb("claimNextAt", "<=", now)]))
        .orderBy("readinessStartedAt")
        .limit(1)
        .forNoKeyUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return undefined;
      const owner = row.accountId;
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
        revision: row.revision,
        readinessStartedAt: row.readinessStartedAt,
      };
    });
  }

  /** What the claim carries: the sealed setup code and link credential, and who the owner is. */
  async claimMaterial(job: CloudComputerClaimJob) {
    const computer = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where((eb) => claimFence(eb, job))
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!computer || computer.accountId !== job.accountId)
      throw new CloudComputerClaimSupersededError();
    const owner = await this.#db
      .selectFrom("users")
      .select(["displayName", "email", "emailVerified"])
      .where("id", "=", job.accountId)
      .executeTakeFirst();
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
      .where((eb) => claimFence(eb, job))
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
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", job.id)
        .executeTakeFirst();
      if (
        !row ||
        row.generation !== job.generation ||
        row.claimAttempt !== job.attempt ||
        row.revision !== job.revision ||
        row.state !== "active" ||
        row.deletionRequestedAt !== null ||
        row.hostKeyFingerprint !== job.hostKeyFingerprint ||
        row.deploymentId !== job.deploymentId ||
        row.accountId !== job.accountId ||
        row.tombstonedAt !== null ||
        !row.sealedHostCredential
      )
        throw new CloudComputerClaimSupersededError();
      if (row.bootstrapReceiptAt) return;
      const now = this.#now();
      const deploymentId = DeploymentIdSchema.parse(job.deploymentId);
      const listed = await tx
        .selectFrom("deployments")
        .select(["canonicalOrigin", "hostKeyFingerprint", "ownerAccountId"])
        .where("id", "=", deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (listed && listed.ownerAccountId !== job.accountId)
        throw new ControlPlaneError("conflict", "This Home is already listed for another Account");
      // The owner's own listing is accepted only as this very Home with this very credential.
      if (listed) {
        const credential = await tx
          .selectFrom("deploymentCredentials")
          .select("tokenHash")
          .where("deploymentId", "=", deploymentId)
          .executeTakeFirst();
        if (
          listed.hostKeyFingerprint !== job.hostKeyFingerprint ||
          listed.canonicalOrigin !== receipt.document.authority.canonicalOrigin ||
          credential?.tokenHash !==
            hashCredential(
              this.#options.cipher.open(
                `host-credential:${row.id}`,
                row.generation,
                row.sealedHostCredential,
              ),
            )
        )
          throw new ControlPlaneError("conflict", "This Home is already listed as another Home");
      }
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
      const pinned = await lockedComputer(tx, job.id);
      if (
        pinned.generation !== job.generation ||
        pinned.claimAttempt !== job.attempt ||
        pinned.revision !== job.revision ||
        pinned.state !== "active" ||
        pinned.deletionRequestedAt ||
        pinned.tombstonedAt ||
        pinned.deploymentId !== job.deploymentId ||
        pinned.hostKeyFingerprint !== job.hostKeyFingerprint ||
        pinned.sealedHostCredential !== row.sealedHostCredential
      )
        throw new CloudComputerClaimSupersededError();
      if (pinned.bootstrapReceiptAt) return;
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

  async listForAccount(accountId: ControlPlaneAccountId): Promise<CloudComputerView[]> {
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("accountId", "=", accountId)
      .orderBy("createdAt", "desc")
      .execute();
    return this.#views(rows);
  }

  async show(id: CloudComputerId, accountId?: ControlPlaneAccountId): Promise<CloudComputerView> {
    let query = this.#db.selectFrom("cloudComputers").selectAll().where("id", "=", id);
    if (accountId) query = query.where("accountId", "=", accountId);
    const row = await query.executeTakeFirst();
    if (!row) throw missing();
    return (await this.#views([row]))[0]!;
  }

  async operatorList() {
    const rows = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .orderBy("createdAt", "desc")
      .execute();
    return Promise.all(rows.map((row) => this.#operatorView(row)));
  }

  async operatorShow(id: CloudComputerId) {
    const row = await this.#db
      .selectFrom("cloudComputers")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw missing();
    return this.#operatorView(row);
  }

  async #operatorView(row: Computer) {
    return {
      id: row.id,
      accountId: row.accountId,
      state: row.state,
      phase: row.phase,
      generation: row.generation,
      revision: row.revision,
      hostname: row.hostname,
      providerServerId: row.providerServerId,
      previousProviderServerId: row.previousProviderServerId,
      ...(row.providerServerRef ? { providerServerRef: row.providerServerRef } : {}),
      ...(row.previousProviderServerRef
        ? { previousProviderServerRef: row.previousProviderServerRef }
        : {}),
      ipv4: row.ipv4,
      ipv6: row.ipv6,
      deploymentId: row.deploymentId,
      hostKeyFingerprint: row.hostKeyFingerprint,
      bootstrapExpiresAt: row.bootstrapExpiresAt,
      bootCompletedAt: row.bootCompletedAt,
      readinessStartedAt: row.readinessStartedAt,
      generationReady: row.generationReady,
      everReady: row.everReady,
      deletionRequestedAt: row.deletionRequestedAt,
      deletion: deletionView(row),
      tombstonedAt: row.tombstonedAt,
      billingStatus: row.billingStatus,
      egressUnavailable: row.egressUnavailable,
      claim: {
        attempt: row.claimAttempt,
        nextAt: row.claimNextAt,
        receiptAt: row.bootstrapReceiptAt,
        error: operatorClaimError(row.claimError),
      },
      lastError: row.lastError,
      updatedAt: row.updatedAt,
      health:
        (await this.#db
          .selectFrom("cloudComputerHealth")
          .select(["receivedAt", "report"])
          .where("computerId", "=", row.id)
          .executeTakeFirst()) ?? null,
    };
  }

  async retryClaim(id: CloudComputerId) {
    return this.#db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom("cloudComputers")
        .selectAll()
        .where("id", "=", id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) throw missing();
      if (
        row.state !== "active" ||
        row.phase !== "ready" ||
        !row.deploymentId ||
        !row.claimError ||
        row.bootstrapReceiptAt ||
        row.deletionRequestedAt ||
        row.tombstonedAt ||
        !row.accountId
      )
        throw new ControlPlaneError("conflict", "The Cloud Computer has no eligible failed claim");
      const now = this.#now();
      await tx
        .updateTable("cloudComputers")
        .where("id", "=", id)
        .set({
          claimError: null,
          claimNextAt: null,
          claimAttempt: row.claimAttempt + 1,
          readinessStartedAt: now,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    });
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
    return Promise.all(
      rows.map(async (row) => {
        return view(row, assigned.get(row.id), this.#options.config, now);
      }),
    );
  }

  async mutate(
    id: CloudComputerId,
    action: Mutation,
    accountId?: ControlPlaneAccountId,
    reason?: string,
  ) {
    const subscription = await this.#db.transaction().execute(async (tx) => {
      if (action === "delete") {
        const target = await tx
          .selectFrom("cloudComputers")
          .select("accountId")
          .where("id", "=", id)
          .executeTakeFirst();
        if (target?.accountId)
          await tx
            .selectFrom("users")
            .select("id")
            .where("id", "=", target.accountId)
            .forNoKeyUpdate()
            .executeTakeFirst();
      }
      const forgotten =
        action === "reissue" || action === "replace" ? await lockHomeReferences(tx, id) : undefined;
      const row = await lockedComputer(tx, id);
      if (forgotten && !sameHomeReferences(forgotten, row))
        throw new ControlPlaneError("conflict", "This Cloud Computer changed; try again");
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
      } else if (
        action === "reissue" &&
        (row.ownerAccessAt || (row.generationReady && !row.restoreSnapshot))
      ) {
        throw new ControlPlaneError(
          "conflict",
          "A working Home can only be replaced from a named backup snapshot",
        );
      } else if (
        action === "reissue" &&
        !row.providerServerId &&
        !row.providerServerRef &&
        !row.createAttempted &&
        !row.bootCompletedAt &&
        !row.sealedHostCredential
      ) {
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
        if (action === "replace" && row.restoreSnapshot && !row.ownerAccessAt)
          throw new ControlPlaneError(
            "conflict",
            "Use bootstrap reissue to recover this unverified replacement",
          );
        const credentialsIssued = Boolean(row.sealedHostCredential);
        let staged: { targetId: string; password: string } | undefined;
        if (action === "reissue" && credentialsIssued && row.restoreSnapshot) {
          const parsed = reissueRestoreSchema.safeParse(reason);
          if (!parsed.success)
            throw new ControlPlaneError(
              "conflict",
              "Supply a fresh backup target containing the named snapshot and a new repository password",
            );
          staged = parsed.data;
          const previousPassword =
            row.backupKeyVersion &&
            (await this.#vault(row.backupKeyProject ?? undefined).read(id, row.backupKeyVersion));
          if (staged.password === previousPassword)
            throw new ControlPlaneError(
              "conflict",
              "The staged backup must use a new repository password",
            );
        }
        const generation = row.generation + 1;
        const setupCode = newSecret();
        changes = {
          ...clearBootToken,
          generation,
          generationReady: false,
          dnsQuarantined: false,
          bootCompletedAt: null,
          completedBootDigest: null,
          createAttempted: false,
          previousProviderServerId: row.providerServerId ?? row.previousProviderServerId,
          previousProviderServerRef: row.providerServerRef ?? row.previousProviderServerRef,
          restoreSnapshot: snapshot?.success ? snapshot.data : row.restoreSnapshot,
          ownerAccessAt: null,
          phase: "provisioning",
          readinessStartedAt: now,
          reportedAt: null,
          setupCodeDigest: digestSecret(setupCode),
          sealedSetupCode: this.#options.cipher.seal(id, generation, setupCode),
          providerServerId: null,
          providerServerRef: null,
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
        await forgetHome(tx, row, action === "reissue");
        if (action === "reissue" && credentialsIssued) {
          await tx
            .updateTable("cloudComputerEgressEndpoints")
            .where("computerId", "=", id)
            .set({ computerId: null, needsRotation: true })
            .executeTakeFirst();
          let available = freeBackupTargets(tx).select("id");
          if (staged) available = available.where("id", "=", staged.targetId);
          const candidate = await available.orderBy("id").limit(1).executeTakeFirst();
          const locked = candidate
            ? await tx
                .selectFrom("cloudComputerBackupTargets")
                .select(["id", "computerId", "checkoutKey", "needsRotation", "purgeComputerId"])
                .where((eb) => eb.or([eb("computerId", "=", id), eb("id", "=", candidate.id)]))
                .orderBy("id")
                .forNoKeyUpdate()
                .skipLocked()
                .execute()
            : [];
          const retiring = locked.find((target) => target.computerId === id);
          const replacement = locked.find(
            (target) =>
              target.id === candidate?.id &&
              !target.computerId &&
              !target.checkoutKey &&
              !target.needsRotation &&
              !target.purgeComputerId,
          );
          if (!retiring || !replacement)
            throw new ControlPlaneError(
              "unavailable",
              "A fresh backup target is required to reissue bootstrap",
            );
          await tx
            .updateTable("cloudComputerBackupTargets")
            .where("id", "=", retiring.id)
            .set({ computerId: null, purgeComputerId: id, needsRotation: true })
            .executeTakeFirstOrThrow();
          await tx
            .updateTable("cloudComputerBackupTargets")
            .where("id", "=", replacement.id)
            .set({ computerId: id })
            .executeTakeFirst();
          changes.backupKeyVersion = staged
            ? await this.#vault(row.backupKeyProject ?? undefined).issue(id, staged.password)
            : null;
        }
      } else {
        const ownerSuspended = action === "suspend" || (action !== "resume" && row.ownerSuspended);
        const operatorSuspension =
          action === "operator-suspend"
            ? (reason ?? "Suspended by Opensteer.")
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
        const target = await this.#db
          .selectFrom("cloudComputers")
          .select("accountId")
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        const attempts = await this.#db
          .selectFrom("cloudComputerCheckouts")
          .select(["accountId", "requestId"])
          .where("status", "=", "open")
          .where((eb) =>
            eb.or([
              eb("targetComputerId", "=", id),
              ...(target.accountId ? [eb("accountId", "=", target.accountId)] : []),
            ]),
          )
          .execute();
        // Cancelled first, whatever happens to a checkout: each keeps its own path.
        await this.#db
          .transaction()
          .execute((tx) => this.#refreshSubscription(tx, subscription))
          .catch(() => this.#cancelFailed(id));
        for (const attempt of attempts)
          await this.#recoverCheckout(attempt.accountId, attempt.requestId);
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
    const validatedUrl = validateEgressUpstreamUrl(endpoint.url);
    if (!validatedUrl.ok) throw new ControlPlaneError("bad_request", validatedUrl.reason);
    const validatedUsername = validateEgressCredential(endpoint.username, "username");
    if (!validatedUsername.ok) throw new ControlPlaneError("bad_request", validatedUsername.reason);
    const validatedPassword = validateEgressCredential(endpoint.password, "password");
    if (!validatedPassword.ok) throw new ControlPlaneError("bad_request", validatedPassword.reason);
    const parsedAddress = CloudComputerEgressAddressSchema.optional().safeParse(
      endpoint.publicAddress,
    );
    if (!parsedAddress.success)
      throw new ControlPlaneError("bad_request", "Invalid browser egress address");
    const url = validatedUrl.value;
    const username = validatedUsername.value;
    const password = validatedPassword.value;
    const publicAddress = parsedAddress.data;
    const cipher = this.#options.cipher;
    return this.#db.transaction().execute(async (tx) => {
      const id = randomUUID();
      const row = await tx
        .insertInto("cloudComputerEgressEndpoints")
        .values({
          id,
          url,
          username,
          publicAddress: publicAddress ?? null,
          computerId: null,
          sealedPassword: cipher.seal(`egress:${id}`, 1, password),
          needsRotation: false,
        })
        .onConflict((conflict) => conflict.column("url").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (row) return row.id;
      const retired = await tx
        .selectFrom("cloudComputerEgressEndpoints")
        .select(["id", "sealedPassword"])
        .where("url", "=", url)
        .where("retired", "=", true)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!retired)
        throw new ControlPlaneError("conflict", "Browser egress endpoint already exists");
      const context = `egress:${retired.id}`;
      if (cipher.open(context, 1, retired.sealedPassword) === password)
        throw new ControlPlaneError(
          "conflict",
          "A retired egress endpoint requires a new password",
        );
      await tx
        .updateTable("cloudComputerEgressEndpoints")
        .where("id", "=", retired.id)
        .set({
          username,
          publicAddress: publicAddress ?? null,
          sealedPassword: cipher.seal(context, 1, password),
          needsRotation: false,
          retired: false,
        })
        .executeTakeFirstOrThrow();
      return retired.id;
    });
  }

  async setEgressAddress(id: string, address: string | null): Promise<void> {
    const parsed = CloudComputerEgressAddressSchema.nullable().safeParse(address);
    if (!parsed.success) {
      throw new ControlPlaneError("bad_request", "Invalid browser egress address");
    }
    const updated = await this.#db
      .updateTable("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("retired", "=", false)
      .set({ publicAddress: parsed.data })
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new ControlPlaneError("not_found", "Browser egress endpoint was not found");
    }
  }

  async removeEgressEndpoint(id: string): Promise<void> {
    const result = await this.#db
      .updateTable("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .where("retired", "=", false)
      .set({ needsRotation: true, retired: true, publicAddress: null })
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new ControlPlaneError(
        "conflict",
        "Browser egress endpoint is assigned or does not exist",
      );
    }
  }

  async rotateEgressEndpoint(id: string, credentials: { username: string; password: string }) {
    const validatedUsername = validateEgressCredential(credentials.username, "username");
    if (!validatedUsername.ok) throw new ControlPlaneError("bad_request", validatedUsername.reason);
    const validatedPassword = validateEgressCredential(credentials.password, "password");
    if (!validatedPassword.ok) throw new ControlPlaneError("bad_request", validatedPassword.reason);
    const row = await this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      !row ||
      row.computerId ||
      !row.needsRotation ||
      row.retired ||
      this.#options.cipher.open(`egress:${id}`, 1, row.sealedPassword) === validatedPassword.value
    ) {
      throw new ControlPlaneError(
        "conflict",
        "This endpoint requires a new password and must be awaiting rotation",
      );
    }
    const result = await this.#db
      .updateTable("cloudComputerEgressEndpoints")
      .where("id", "=", id)
      .where("needsRotation", "=", true)
      .where("retired", "=", false)
      .where("sealedPassword", "=", row.sealedPassword)
      .set({
        username: validatedUsername.value,
        sealedPassword: this.#options.cipher.seal(`egress:${id}`, 1, validatedPassword.value),
        needsRotation: false,
      })
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n)
      throw new ControlPlaneError("conflict", "The browser egress endpoint changed");
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
      await reserveBackupNamespace(tx, location, digestSecret(accessKeyId));
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
    const parsed = backupTargetSchema
      .pick({ prefix: true, accessKeyId: true, secretAccessKey: true })
      .safeParse(input);
    if (!parsed.success)
      throw new ControlPlaneError(
        "bad_request",
        "A new backup prefix and credentials are required",
      );
    const { prefix, accessKeyId, secretAccessKey } = parsed.data;
    const fingerprint = digestSecret(accessKeyId);
    await this.#db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('cloud-computer-backup-pool',0))`.execute(
        tx,
      );
      const target = await tx
        .selectFrom("cloudComputerBackupTargets")
        .select(["endpoint", "bucket"])
        .where("id", "=", id)
        .where("computerId", "is", null)
        .where("checkoutKey", "is", null)
        .where("purgeComputerId", "is", null)
        .where("needsRotation", "=", true)
        .where("principalFingerprint", "!=", fingerprint)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!target)
        throw new ControlPlaneError(
          "conflict",
          "This backup target needs a new storage principal and must be awaiting rotation",
        );
      await reserveBackupNamespace(tx, { ...target, prefix }, fingerprint);
      await tx
        .updateTable("cloudComputerBackupTargets")
        .where("id", "=", id)
        .set({
          prefix,
          principalFingerprint: fingerprint,
          sealedCredentials: this.#sealBackup(id, accessKeyId, secretAccessKey),
          needsRotation: false,
        })
        .executeTakeFirst();
    });
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
    const rows = await this.#db
      .selectFrom("cloudComputerBackupTargets as target")
      .leftJoin("cloudComputerCheckouts as attempt", (join) =>
        join
          .onRef(
            "target.checkoutKey",
            "=",
            sql<string>`attempt.account_id || '/' || attempt.request_id`,
          )
          .on("attempt.status", "=", "open"),
      )
      .select([
        "target.id",
        "target.endpoint",
        "target.bucket",
        "target.prefix",
        "target.computerId",
        "target.needsRotation",
        "target.checkoutKey",
        "target.purgeComputerId",
        "attempt.accountId",
        "attempt.requestId",
        "attempt.stripeSessionId",
        "attempt.expiresAt",
        "attempt.paidAt",
      ])
      .orderBy("target.id")
      .execute();
    return rows.map(
      ({ checkoutKey, accountId, requestId, stripeSessionId, expiresAt, paidAt, ...target }) => ({
        ...target,
        reserved: checkoutKey !== null,
        reservation: accountId
          ? { accountId, requestId, stripeSessionId, expiresAt, paidAt }
          : null,
      }),
    );
  }

  async removeBackupTarget(id: string) {
    const result = await this.#db
      .deleteFrom("cloudComputerBackupTargets")
      .where("id", "=", id)
      .where("computerId", "is", null)
      .where("checkoutKey", "is", null)
      .where("purgeComputerId", "is", null)
      .executeTakeFirst();
    if (result.numDeletedRows !== 1n)
      throw new ControlPlaneError(
        "conflict",
        "Backup target is reserved, assigned or does not exist",
      );
  }

  async listEgressEndpoints() {
    const rows = await this.#db
      .selectFrom("cloudComputerEgressEndpoints")
      .select([
        "id",
        "url",
        "username",
        "sealedPassword",
        "computerId",
        "needsRotation",
        "publicAddress",
      ])
      .where("retired", "=", false)
      .orderBy("id")
      .execute();
    return rows.map(({ sealedPassword, ...row }) => {
      const password = this.#options.cipher.open(`egress:${row.id}`, 1, sealedPassword);
      const invalidReason = egressEndpointInvalidReason({
        url: row.url,
        username: row.username,
        password,
      });
      return {
        ...row,
        ...(invalidReason ? { invalidReason } : {}),
      };
    });
  }

  desiredPoolHosts(after?: BrowserPoolHostId, limit?: number, probe?: boolean) {
    return this.#pool.desiredHosts(after, limit, probe);
  }

  checkPoolHost(id: BrowserPoolHostId, check: BrowserPoolHostCheck) {
    return this.#pool.checkPoolHost(id, check);
  }

  reportPoolHost(report: BrowserPoolHostReport) {
    return this.#pool.reportPoolHost(report);
  }

  replaceUnenrolledPoolHost(id: BrowserPoolHostId, input: BrowserPoolHostReplaceUnreadyRequest) {
    return this.#pool.replaceUnenrolledHost(id, input);
  }

  bootPoolHost(id: BrowserPoolHostId, input: BrowserPoolHostBootRequest) {
    return this.#pool.bootPoolHost(id, input);
  }

  bootCompletePoolHost(id: BrowserPoolHostId, input: BrowserPoolHostBootCompleteRequest) {
    return this.#pool.bootCompletePoolHost(id, input);
  }

  egressForPoolHost(
    hostId: string,
    body: unknown,
    checkVerifiedSlotRateLimit?: (hostId: BrowserPoolHostId, slotId: BrowserPoolSlotId) => boolean,
  ) {
    return this.#pool.egressForPoolHost(hostId, body, checkVerifiedSlotRateLimit);
  }

  desiredPoolSlots(after?: BrowserPoolSlotId, limit?: number) {
    return this.#pool.desiredSlots(after, limit);
  }

  checkPoolSlot(slotId: BrowserPoolSlotId, check: BrowserPoolSlotCheck) {
    return this.#pool.checkPoolSlot(slotId, check);
  }

  bumpPoolSlotTerm(slotId: BrowserPoolSlotId, input: BrowserPoolSlotBumpTermRequest) {
    return this.#pool.bumpPoolSlotTerm(slotId, input);
  }

  reportPoolSlot(report: BrowserPoolSlotReport) {
    return this.#pool.reportPoolSlot(report);
  }

  registerHomeBrowserPoolKeys(
    deploymentId: DeploymentId,
    input: ManagedBrowserPoolRegistrationRequest,
  ) {
    return this.#pool.registerHomeBrowserPoolKeys(deploymentId, input);
  }

  browserPoolTargetForHome(deploymentId: DeploymentId) {
    return this.#pool.browserPoolTargetForHome(deploymentId);
  }

  operatorListPoolHosts() {
    return this.#pool.operatorListHosts();
  }

  operatorShowPoolHost(id: BrowserPoolHostId) {
    return this.#pool.operatorShowHost(id);
  }

  operatorDrainPoolHost(id: BrowserPoolHostId) {
    return this.#pool.operatorDrainHost(id);
  }

  operatorReplacePoolHost(id: BrowserPoolHostId) {
    return this.#pool.operatorReplaceHost(id);
  }

  operatorDeletePoolHost(id: BrowserPoolHostId) {
    return this.#pool.operatorDeleteHost(id);
  }

  operatorListPoolSlots() {
    return this.#pool.operatorListSlots();
  }

  operatorShowPoolSlot(slotId: BrowserPoolSlotId) {
    return this.#pool.operatorShowSlot(slotId);
  }

  operatorRetryPoolSlot(slotId: BrowserPoolSlotId) {
    return this.#pool.operatorRetrySlot(slotId);
  }
}

function operatorClaimError(reason: string | null) {
  if (!reason) return null;
  if (reason === "Your Cloud Computer took too long to set up. Contact support.") return "timeout";
  if (reason === "Your Cloud Computer couldn’t be set up for your Account. Contact support.")
    return "setup-failed";
  return "claim-failed";
}

const reissueRestoreSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid backup target JSON" });
      return z.NEVER;
    }
  })
  .pipe(
    z.strictObject({
      targetId: z.uuid(),
      password: CloudComputerBootResponseSchema.shape.backup.shape.password,
    }),
  );

const backupTargetSchema = z.strictObject({
  ...CloudComputerBootResponseSchema.shape.backup.pick({
    endpoint: true,
    bucket: true,
    prefix: true,
    accessKeyId: true,
    secretAccessKey: true,
  }).shape,
  region: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/u)
    .optional(),
  accessKeyId: CloudComputerBootResponseSchema.shape.backup.shape.accessKeyId.max(255),
  secretAccessKey: CloudComputerBootResponseSchema.shape.backup.shape.secretAccessKey.max(255),
});

function checkoutKey(account: ControlPlaneAccountId, request: string) {
  return `${account}/${request}`;
}

async function reserveBackupNamespace(
  tx: TransactionDb,
  namespace: { endpoint: string; bucket: string; prefix: string },
  principalFingerprint: string,
) {
  const existing = await tx
    .selectFrom("cloudComputerBackupNamespaces")
    .select("prefix")
    .where("endpoint", "=", namespace.endpoint)
    .where("bucket", "=", namespace.bucket)
    .execute();
  if (
    existing.some(
      ({ prefix }) =>
        prefix === namespace.prefix ||
        prefix.startsWith(namespace.prefix + "/") ||
        namespace.prefix.startsWith(prefix + "/"),
    )
  ) {
    throw new ControlPlaneError(
      "conflict",
      "This backup prefix overlaps a current or retired target",
    );
  }
  const reserved = await tx
    .insertInto("cloudComputerBackupNamespaces")
    .values({ ...namespace, principalFingerprint })
    .onConflict((conflict) => conflict.column("principalFingerprint").doNothing())
    .returning("prefix")
    .executeTakeFirst();
  if (!reserved)
    throw new ControlPlaneError("conflict", "This storage principal is already registered");
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

async function lockHomeReferences(tx: TransactionDb, id: CloudComputerId) {
  const row = await tx
    .selectFrom("cloudComputers")
    .select(["deploymentId", "oidcClientId"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (row?.deploymentId) {
    await tx
      .selectFrom("deployments")
      .select("id")
      .where("id", "=", DeploymentIdSchema.parse(row.deploymentId))
      // FOR UPDATE: lock the deployment before forgetHome deletes it.
      .forUpdate()
      .executeTakeFirst();
  }
  if (row?.oidcClientId) {
    await tx
      .selectFrom("oauthClients")
      .select("id")
      .where("clientId", "=", row.oidcClientId)
      // FOR UPDATE: lock the OAuth client before forgetHome deletes it.
      .forUpdate()
      .executeTakeFirst();
  }
  return row;
}

function sameHomeReferences(
  before: Pick<Computer, "deploymentId" | "oidcClientId">,
  after: Pick<Computer, "deploymentId" | "oidcClientId">,
) {
  return before.deploymentId === after.deploymentId && before.oidcClientId === after.oidcClientId;
}

/** The Account's listing and OIDC client for a Home that no longer exists. */
async function forgetHome(tx: TransactionDb, row: Computer, client: boolean) {
  const owner = row.accountId;
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
    !row.providerServerRef &&
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
  const machineSeen =
    row.providerServerId !== null || row.providerServerRef !== null || row.phase === "ready";
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
  const deletion = deletionView(row);
  const base = {
    id: row.id,
    ...(deletion ? { deletion } : {}),
    egress,
    ...(row.deploymentId && row.hostKeyFingerprint
      ? { deploymentId: DeploymentIdSchema.parse(row.deploymentId) }
      : {}),
    ...(region ? { region } : {}),
    ...(row.lastBackupAt ? { lastBackupAt: row.lastBackupAt.toISOString() } : {}),
    ...(assigned?.publicAddress ? { egressAddress: assigned.publicAddress } : {}),
    ...(row.state !== "deleted" && !row.deletionRequestedAt && row.renewsAt && row.renewsAt > now
      ? { renewsAt: row.renewsAt.toISOString() }
      : {}),
  } as const;
  if (row.tombstonedAt) return { ...base, status: "deleted" };
  if (row.state === "deleted" || row.deletionRequestedAt)
    return {
      ...base,
      status: "needs_attention",
      reason:
        row.state === "deleted"
          ? "Cloud Computer deletion is in progress."
          : "Deletion is waiting for Stripe cancellation.",
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
        reason: cloudWords("cloud.reason.owner-suspended"),
        reasonCode: "cloud-computer-owner-suspended",
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
      reason: cloudComputerSetupIssue(row.claimError),
      reasonCode: "cloud-computer-claim-failed",
    };
  if (row.bootstrapExpiresAt && row.bootstrapExpiresAt <= now) {
    return {
      ...base,
      status: "needs_attention",
      reason: cloudWords("cloud.reason.bootstrap-expired"),
      reasonCode: "cloud-computer-bootstrap-expired",
    };
  }
  if (row.phase === "failed")
    return {
      ...base,
      status: "needs_attention",
      reason: cloudComputerSetupIssue(row.lastError),
      reasonCode: "cloud-computer-provisioning-failed",
    };
  return { ...base, status: "preparing", steps: preparationSteps(row) };
}

function missing() {
  return new ControlPlaneError("not_found", "Cloud Computer was not found", {
    reason: "cloud-computer-not-found",
  });
}

/** The row exactly as a claim attempt leased it: a later attempt, edit, delete or re-pin wins. */
function claimFence(
  eb: ExpressionBuilder<ControlPlaneDatabaseSchema, "cloudComputers">,
  job: CloudComputerClaimJob,
) {
  return eb.and([
    eb("id", "=", job.id),
    eb("generation", "=", job.generation),
    eb("claimAttempt", "=", job.attempt),
    eb("revision", "=", job.revision),
    eb("deploymentId", "=", job.deploymentId),
    eb("hostKeyFingerprint", "=", job.hostKeyFingerprint),
    eb("deletionRequestedAt", "is", null),
    eb("tombstonedAt", "is", null),
  ]);
}
